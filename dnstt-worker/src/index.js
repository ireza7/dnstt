/**
 * dnstt Cloudflare Worker - DNS Tunnel Server over DoH
 *
 * This is a port of dnstt-server to run as a Cloudflare Worker.
 * It acts as a DoH (DNS over HTTPS) server that:
 * 1. Receives DNS queries via HTTP (RFC 8484)
 * 2. Extracts tunnel data encoded in DNS query names
 * 3. Manages tunnel sessions (KCP/Noise)
 * 4. Forwards tunnel streams to an upstream server
 * 5. Returns tunnel data in DNS TXT responses
 *
 * Architecture:
 * - Client sends DoH queries to this Worker
 * - Worker decodes the DNS query, extracts base32-encoded tunnel data
 * - Data is processed through the tunnel stack (KCP → Noise → smux → TCP)
 * - Upstream connections are made via fetch() to the configured upstream
 *
 * Configuration (via environment variables or wrangler.toml):
 * - DNSTT_DOMAIN: The DNS domain for the tunnel (e.g., "t.example.com")
 * - DNSTT_PRIVKEY: Server private key (hex-encoded)
 * - DNSTT_UPSTREAM: Upstream WebSocket/HTTP endpoint
 * - DNSTT_MTU: Maximum UDP payload size (default: 1232)
 */

import {
  Name, Message, Question, RR,
  RRTypeTXT, RRTypeOPT,
  RcodeNoError, RcodeFormatError, RcodeNameError, RcodeNotImplemented,
  ExtendedRcodeBadVers,
  messageFromWireFormat, messageToWireFormat,
  encodeRDataTXT, decodeRDataTXT
} from './dns.js';

import {
  NoiseServer, NoiseSocket,
  decodeKey, encodeKey, pubkeyFromPrivkey
} from './noise.js';

import { ClientID, SessionManager } from './turbotunnel.js';
import { KCPSession, parseSegments } from './kcp.js';

// ============================================================
// Constants
// ============================================================

const RESPONSE_TTL = 60;
const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// Base32 encoding without padding (matching Go's base32.StdEncoding.WithPadding(NoPadding))
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  input = input.replace(/=+$/, '').toUpperCase();
  const lookup = {};
  for (let i = 0; i < BASE32_ALPHABET.length; i++) {
    lookup[BASE32_ALPHABET[i]] = i;
  }

  let bits = 0;
  let value = 0;
  const output = [];

  for (const c of input) {
    const v = lookup[c];
    if (v === undefined) throw new Error(`invalid base32 character: ${c}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

// ============================================================
// Global State (per worker isolate)
// ============================================================

const sessionManager = new SessionManager(IDLE_TIMEOUT_MS);

// Periodic cleanup (every 30 seconds)
let lastCleanup = 0;
function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanup > 30000) {
    lastCleanup = now;
    sessionManager.cleanup();
  }
}

// ============================================================
// DNS Response Builder
// ============================================================

/**
 * Build a DNS response for the given query.
 * Returns { response: Message, payload: Uint8Array|null }
 *
 * This is a port of responseFor() from dnstt-server/main.go
 */
function responseFor(query, domain, maxUDPPayload) {
  const resp = new Message();
  resp.id = query.id;
  resp.flags = 0x8000; // QR = 1, RCODE = no error
  resp.question = query.question;

  // Not a query?
  if (query.flags & 0x8000) {
    return { response: null, payload: null };
  }

  // Check EDNS(0)
  let payloadSize = 0;
  for (const rr of query.additional) {
    if (rr.type !== RRTypeOPT) continue;
    if (resp.additional.length !== 0) {
      resp.flags |= RcodeFormatError;
      return { response: resp, payload: null };
    }
    resp.additional.push(new RR(
      new Name(), RRTypeOPT, 4096, 0, new Uint8Array(0)
    ));

    const version = (rr.ttl >> 16) & 0xff;
    if (version !== 0) {
      resp.flags |= ExtendedRcodeBadVers & 0xf;
      resp.additional[0].ttl = (ExtendedRcodeBadVers >> 4) << 24;
      return { response: resp, payload: null };
    }

    payloadSize = rr.class;
  }

  if (payloadSize < 512) payloadSize = 512;

  // Must have exactly one question
  if (query.question.length !== 1) {
    resp.flags |= RcodeFormatError;
    return { response: resp, payload: null };
  }

  const question = query.question[0];

  // Check if the name ends with our domain
  const [prefix, ok] = question.name.trimSuffix(domain);
  if (!ok) {
    resp.flags |= RcodeNameError;
    return { response: resp, payload: null };
  }
  resp.flags |= 0x0400; // AA = 1

  if (query.opcode() !== 0) {
    resp.flags |= RcodeNotImplemented;
    return { response: resp, payload: null };
  }

  if (question.type !== RRTypeTXT) {
    resp.flags |= RcodeNameError;
    return { response: resp, payload: null };
  }

  // Decode the base32-encoded payload from the DNS name labels
  const encoded = prefix.map(l => new TextDecoder().decode(l)).join('').toUpperCase();
  let payload;
  try {
    payload = base32Decode(encoded);
  } catch (e) {
    resp.flags |= RcodeNameError;
    return { response: resp, payload: null };
  }

  // Check minimum payload size
  if (payloadSize < maxUDPPayload) {
    resp.flags |= RcodeFormatError;
    return { response: resp, payload: null };
  }

  return { response: resp, payload };
}

/**
 * Extract packets from a length-prefixed payload, skipping padding.
 * Port of nextPacket() from dnstt-server/main.go
 */
function extractPackets(payload) {
  const packets = [];
  let offset = 0;

  while (offset < payload.length) {
    const prefix = payload[offset++];
    if (prefix >= 224) {
      // Padding
      const paddingLen = prefix - 224;
      offset += paddingLen;
    } else {
      // Data packet
      if (offset + prefix > payload.length) break;
      packets.push(payload.subarray(offset, offset + prefix));
      offset += prefix;
    }
  }

  return packets;
}

/**
 * Build downstream payload from packets
 * Each packet is preceded by a 2-byte big-endian length prefix
 */
function buildDownstreamPayload(packets) {
  let totalSize = 0;
  for (const pkt of packets) {
    totalSize += 2 + pkt.length;
  }

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let offset = 0;

  for (const pkt of packets) {
    view.setUint16(offset, pkt.length);
    offset += 2;
    result.set(pkt, offset);
    offset += pkt.length;
  }

  return result;
}

/**
 * Compute the maximum encoded payload that fits within the limit
 * Port of computeMaxEncodedPayload() from dnstt-server/main.go
 */
function computeMaxEncodedPayload(limit) {
  // Worst case: maximum-length name (255 bytes) in question section
  // The overhead includes: DNS header (12) + question section + answer section header
  // We use a conservative estimate
  // DNS header: 12 bytes
  // Question: 255 (name) + 4 (type + class) = 259
  // Answer: 2 (pointer) + 10 (type+class+ttl+rdlength) = 12
  // OPT RR: 1 + 10 + 0 = 11
  // Total overhead: ~294
  // Available for TXT RDATA: limit - 294
  // TXT encoding overhead: ceil(n/255) bytes for length prefixes

  const overhead = 294;
  const available = limit - overhead;
  if (available <= 0) return 0;

  // Account for TXT character-string length prefixes
  // For every 255 bytes of data, we need 1 length byte
  const maxData = Math.floor(available * 255 / 256);
  return Math.max(0, maxData);
}

// ============================================================
// Upstream Connection Management
// ============================================================

/**
 * Forward data to upstream and receive response
 * Uses fetch() for HTTP-based upstreams
 */
async function forwardToUpstream(upstreamUrl, data) {
  if (!upstreamUrl) return null;

  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Dnstt-Session': 'tunnel',
      },
      body: data,
    });

    if (!response.ok) {
      console.error(`Upstream returned ${response.status}`);
      return null;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    console.error(`Upstream error: ${e.message}`);
    return null;
  }
}

// ============================================================
// Main Request Handler
// ============================================================

/**
 * Process a DoH request
 */
async function handleDoHRequest(request, env) {
  const maxUDPPayload = parseInt(env.DNSTT_MTU || '1232');
  const domain = Name.parse(env.DNSTT_DOMAIN || 't.example.com');

  let privkey = null;
  if (env.DNSTT_PRIVKEY) {
    privkey = decodeKey(env.DNSTT_PRIVKEY);
  }

  const upstreamUrl = env.DNSTT_UPSTREAM || null;
  const maxEncodedPayload = computeMaxEncodedPayload(maxUDPPayload);

  let queryBuf;

  // RFC 8484: DNS over HTTPS
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type');
    if (contentType !== 'application/dns-message') {
      return new Response('Bad content type', { status: 415 });
    }
    queryBuf = new Uint8Array(await request.arrayBuffer());
  } else if (request.method === 'GET') {
    const url = new URL(request.url);
    const dnsParam = url.searchParams.get('dns');
    if (!dnsParam) {
      return new Response('Missing dns parameter', { status: 400 });
    }
    // Base64url decode
    const base64 = dnsParam.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    queryBuf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      queryBuf[i] = binary.charCodeAt(i);
    }
  } else {
    return new Response('Method not allowed', { status: 405 });
  }

  // Parse DNS query
  let query;
  try {
    query = messageFromWireFormat(queryBuf);
  } catch (e) {
    return new Response('Bad DNS query', { status: 400 });
  }

  // Build response
  const { response: resp, payload } = responseFor(query, domain, maxUDPPayload);

  if (!resp) {
    return new Response('No response', { status: 204 });
  }

  // If there's payload data, process the tunnel
  if (payload && payload.length >= 8 && resp.rcode() === RcodeNoError) {
    // Extract ClientID (first 8 bytes)
    const clientID = ClientID.fromBytes(payload);
    const tunnelData = payload.subarray(8);

    if (clientID) {
      maybeCleanup();

      const session = sessionManager.getOrCreate(clientID);

      // Extract packets from the payload
      const incomingPackets = extractPackets(tunnelData);

      // Process each incoming packet through KCP
      if (!session.kcpState) {
        session.kcpState = new KCPSession(0);
      }

      for (const pkt of incomingPackets) {
        session.kcpState.input(pkt);
      }

      // Read any data that KCP has reassembled
      let kcpData = session.kcpState.recv();
      if (kcpData && kcpData.length > 0) {
        // Process through Noise protocol
        if (!session.handshakeComplete && privkey) {
          try {
            const noiseServer = new NoiseServer(privkey);
            // Read the handshake message from KCP data
            // The handshake message is length-prefixed (2 bytes)
            if (kcpData.length >= 2) {
              const view = new DataView(kcpData.buffer, kcpData.byteOffset, kcpData.byteLength);
              const msgLen = view.getUint16(0);
              if (kcpData.length >= 2 + msgLen) {
                const handshakeMsg = kcpData.subarray(2, 2 + msgLen);
                const { response: noiseResponse, recvCipher, sendCipher } = noiseServer.processHandshake(handshakeMsg);

                // Send back the handshake response via KCP
                const responseBuf = new Uint8Array(2 + noiseResponse.length);
                const respView = new DataView(responseBuf.buffer);
                respView.setUint16(0, noiseResponse.length);
                responseBuf.set(noiseResponse, 2);

                session.kcpState.send(responseBuf);
                session.noiseState = new NoiseSocket(recvCipher, sendCipher);
                session.handshakeComplete = true;

                // Process remaining data after handshake
                const remaining = kcpData.subarray(2 + msgLen);
                if (remaining.length > 0 && session.noiseState) {
                  const decrypted = session.noiseState.decrypt(remaining);
                  for (const msg of decrypted) {
                    // Forward to upstream
                    if (upstreamUrl && msg.length > 0) {
                      const upstreamResp = await forwardToUpstream(upstreamUrl, msg);
                      if (upstreamResp) {
                        const encrypted = session.noiseState.encrypt(upstreamResp);
                        session.kcpState.send(encrypted);
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.error(`Noise handshake error: ${e.message}`);
          }
        } else if (session.handshakeComplete && session.noiseState) {
          // Decrypt through Noise
          try {
            const decrypted = session.noiseState.decrypt(kcpData);
            for (const msg of decrypted) {
              if (upstreamUrl && msg.length > 0) {
                const upstreamResp = await forwardToUpstream(upstreamUrl, msg);
                if (upstreamResp) {
                  const encrypted = session.noiseState.encrypt(upstreamResp);
                  session.kcpState.send(encrypted);
                }
              }
            }
          } catch (e) {
            console.error(`Noise decrypt error: ${e.message}`);
          }
        }
      }

      // Generate KCP output (ACKs + data)
      const kcpOutput = session.kcpState.flush();

      // Build response with downstream data
      if (resp.rcode() === RcodeNoError && query.question.length === 1) {
        const downstreamPayload = buildDownstreamPayload(kcpOutput);
        resp.answer = [new RR(
          query.question[0].name,
          query.question[0].type,
          query.question[0].class,
          RESPONSE_TTL,
          encodeRDataTXT(downstreamPayload)
        )];
      }
    } else {
      // Payload too short for ClientID
      if (resp.rcode() === RcodeNoError) {
        resp.flags |= RcodeNameError;
      }
    }
  } else if (payload && payload.length < 8 && resp.rcode() === RcodeNoError) {
    resp.flags |= RcodeNameError;
  }

  // Serialize the response
  let responseBuf;
  try {
    responseBuf = messageToWireFormat(resp);
  } catch (e) {
    return new Response('Internal error', { status: 500 });
  }

  // Truncate if necessary
  if (responseBuf.length > maxUDPPayload) {
    responseBuf = responseBuf.subarray(0, maxUDPPayload);
    responseBuf[2] |= 0x02; // TC = 1
  }

  return new Response(responseBuf, {
    headers: {
      'Content-Type': 'application/dns-message',
      'Cache-Control': 'no-cache, no-store',
    },
  });
}

// ============================================================
// Worker Entry Point
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        sessions: sessionManager.size,
        pubkey: env.DNSTT_PRIVKEY ? encodeKey(pubkeyFromPrivkey(decodeKey(env.DNSTT_PRIVKEY))) : 'not configured',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Info/setup endpoint
    if (url.pathname === '/info') {
      return new Response(JSON.stringify({
        name: 'dnstt-worker',
        description: 'DNS Tunnel Server over DoH - Cloudflare Worker',
        version: '1.0.0',
        endpoints: {
          '/dns-query': 'DoH endpoint (RFC 8484)',
          '/health': 'Health check',
          '/info': 'This info page',
        },
        configuration: {
          DNSTT_DOMAIN: env.DNSTT_DOMAIN || 'not set',
          DNSTT_MTU: env.DNSTT_MTU || '1232',
          DNSTT_UPSTREAM: env.DNSTT_UPSTREAM ? 'configured' : 'not set',
          DNSTT_PRIVKEY: env.DNSTT_PRIVKEY ? 'configured' : 'not set',
        },
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // DNS-over-HTTPS endpoint
    if (url.pathname === '/dns-query') {
      try {
        return await handleDoHRequest(request, env);
      } catch (e) {
        console.error(`DoH handler error: ${e.message}`);
        return new Response(`Server error: ${e.message}`, { status: 500 });
      }
    }

    // Default: return info about how to use
    return new Response(`dnstt Cloudflare Worker

This is a DNS tunnel server running as a Cloudflare Worker.
For DoH queries, use the /dns-query endpoint.

Endpoints:
  /dns-query  - DNS over HTTPS (RFC 8484)
  /health     - Health check
  /info       - Configuration info

For more information, see: https://www.bamsoftware.com/software/dnstt/
`, {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
