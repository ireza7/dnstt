# dnstt-worker

A port of [dnstt](https://www.bamsoftware.com/software/dnstt/) DNS tunnel server to run as a **Cloudflare Worker**, providing a DNS-over-HTTPS (DoH) endpoint for the tunnel.

## Overview

dnstt is a DNS tunnel with support for DoH (DNS over HTTPS) and DoT (DNS over TLS). This project adapts the server-side component to run entirely on Cloudflare Workers, eliminating the need for a dedicated server.

### Architecture

```
.------.               .--------------------.             .----------.
|tunnel|               | Cloudflare Worker  |             |  remote  |
|client| <-- DoH ----> | (dnstt-worker)     | <-- HTTP -> |  upstream|
'------'               '--------------------'             '----------'
   |                                                          |
.------.                                                  .-------.
|local |                                                  | proxy  |
| app  |                                                  | server |
'------'                                                  '-------'
```

### Components

The worker includes JavaScript ports of the core dnstt modules:

- **`src/dns.js`** - DNS wire format encoder/decoder (RFC 1035)
- **`src/noise.js`** - Noise_NK_25519_ChaChaPoly_BLAKE2s protocol
  - Full Curve25519 implementation
  - ChaCha20-Poly1305 AEAD
  - BLAKE2s hash function
  - HKDF key derivation
- **`src/kcp.js`** - KCP reliable transport protocol
- **`src/turbotunnel.js`** - Session management (ClientID, sessions)
- **`src/index.js`** - Main Worker: DoH endpoint (RFC 8484)

## Setup

### Prerequisites

- Node.js >= 18
- Wrangler CLI (`npm install -g wrangler`)
- A Cloudflare account
- A domain name with DNS configured for the tunnel

### Installation

```bash
cd dnstt-worker
npm install
```

### Configuration

Edit `wrangler.toml` or set environment variables:

```toml
[vars]
# DNS domain for the tunnel zone
DNSTT_DOMAIN = "t.example.com"

# Server private key (hex-encoded, 64 hex chars)
DNSTT_PRIVKEY = "your-private-key-hex"

# Upstream HTTP endpoint for tunnel traffic
DNSTT_UPSTREAM = "https://your-upstream-server.com/tunnel"

# Maximum DNS response payload size (default: 1232)
DNSTT_MTU = "1232"
```

For sensitive values like the private key, use Wrangler secrets:

```bash
wrangler secret put DNSTT_PRIVKEY
```

### Generate Keys

You can generate keys using the original dnstt-server:

```bash
cd ../dnstt-server
go build
./dnstt-server -gen-key
# Output:
# privkey 0123456789abcdef...
# pubkey  abcdef0123456789...
```

Or use any Curve25519 keypair generator.

### DNS Zone Setup

Set up DNS records for your domain:

```
A     tns.example.com   -> (Cloudflare Worker handles this)
NS    t.example.com     -> tns.example.com
```

Since the Worker runs on Cloudflare's edge, configure your DNS to route tunnel queries through the Worker's DoH endpoint.

## Development

### Run Locally

```bash
npm run dev
```

This starts a local development server on `http://localhost:8787`.

### Run Tests

```bash
npm test
```

### Deploy to Cloudflare

```bash
npm run deploy
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dns-query` | GET/POST | DoH endpoint (RFC 8484) |
| `/health` | GET | Health check with session count |
| `/info` | GET | Configuration info |
| `/` | GET | Usage information |

### DoH Query Format

**POST** (recommended):
```
POST /dns-query
Content-Type: application/dns-message
Body: <raw DNS query>
```

**GET**:
```
GET /dns-query?dns=<base64url-encoded DNS query>
```

## Client Configuration

Use the standard dnstt-client with the DoH option pointing to your Worker:

```bash
./dnstt-client -doh https://your-worker.workers.dev/dns-query \
  -pubkey-file server.pub \
  t.example.com \
  127.0.0.1:7000
```

## How It Works

1. The dnstt client encodes tunnel data into DNS query names using base32
2. Queries are sent as DoH requests to the Cloudflare Worker
3. The Worker decodes the DNS query and extracts the tunnel payload
4. The payload contains a ClientID and KCP packets
5. KCP provides reliable delivery over the unreliable DNS transport
6. The Noise protocol encrypts the tunnel contents
7. Decrypted data is forwarded to the upstream server via HTTP
8. Response data flows back through the same stack in reverse

## Security

- End-to-end encryption via Noise_NK_25519_ChaChaPoly_BLAKE2s
- Server authentication by public key
- No plaintext tunnel data visible to Cloudflare or any intermediary
- All crypto implemented in pure JavaScript (no external dependencies)

## Limitations

- **Stateless Workers**: Cloudflare Workers are stateless between requests. Session state is maintained within the worker isolate but may be lost during deployments or edge migrations. For production use, consider using Durable Objects for persistent state.
- **Execution Time**: Workers have a CPU time limit (10ms on free plan, 50ms on paid). Complex tunnel operations may exceed this limit.
- **No Raw TCP**: Workers cannot make raw TCP connections. Upstream must be an HTTP/WebSocket endpoint.
- **No UDP**: Workers don't support UDP. This is a DoH-only server.

## License

Public domain (same as original dnstt)

## Credits

Based on [dnstt](https://www.bamsoftware.com/software/dnstt/) by David Fifield.
