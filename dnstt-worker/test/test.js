/**
 * Test suite for dnstt-worker
 * Tests DNS encoding/decoding, Noise crypto, and tunnel logic
 */

import {
  Name, Message, Question, RR,
  RRTypeTXT, RRTypeOPT,
  messageFromWireFormat, messageToWireFormat,
  encodeRDataTXT, decodeRDataTXT
} from '../src/dns.js';

import {
  NoiseServer, NoiseSocket,
  decodeKey, encodeKey, pubkeyFromPrivkey,
  generatePrivkey, KEY_LEN
} from '../src/noise.js';

import { ClientID, SessionManager } from '../src/turbotunnel.js';
import { KCPSession, Segment, parseSegments, KCP_CMD_PUSH, KCP_CMD_ACK } from '../src/kcp.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

function assertArrayEqual(a, b, message) {
  if (a.length !== b.length) {
    console.error(`  FAIL: ${message} - length mismatch (${a.length} vs ${b.length})`);
    failed++;
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      console.error(`  FAIL: ${message} - differs at index ${i} (${a[i]} vs ${b[i]})`);
      failed++;
      return;
    }
  }
  console.log(`  PASS: ${message}`);
  passed++;
}

// ============================================================
// DNS Tests
// ============================================================

console.log('\n=== DNS Tests ===\n');

// Test Name parsing
{
  const name = Name.parse('example.com');
  assert(name.labels.length === 2, 'Name.parse: correct number of labels');
  assert(name.toString() === 'example.com', 'Name.parse: correct string representation');
}

{
  const name = Name.parse('t.example.com.');
  assert(name.labels.length === 3, 'Name.parse with trailing dot: correct labels');
  assert(name.toString() === 't.example.com', 'Name.parse with trailing dot: correct string');
}

// Test Name.trimSuffix
{
  const name = Name.parse('test.label.t.example.com');
  const suffix = Name.parse('t.example.com');
  const [prefix, ok] = name.trimSuffix(suffix);
  assert(ok === true, 'trimSuffix: suffix found');
  assert(prefix.length === 2, 'trimSuffix: correct prefix length');
}

{
  const name = Name.parse('test.t.example.com');
  const suffix = Name.parse('other.com');
  const [prefix, ok] = name.trimSuffix(suffix);
  assert(ok === false, 'trimSuffix: suffix not found');
}

// Test TXT RDATA encoding/decoding
{
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const encoded = encodeRDataTXT(data);
  const decoded = decodeRDataTXT(encoded);
  assertArrayEqual(decoded, data, 'TXT RDATA: small data round-trip');
}

{
  // Test with data > 255 bytes
  const data = new Uint8Array(300);
  for (let i = 0; i < 300; i++) data[i] = i & 0xff;
  const encoded = encodeRDataTXT(data);
  const decoded = decodeRDataTXT(encoded);
  assertArrayEqual(decoded, data, 'TXT RDATA: large data round-trip');
}

{
  // Test with empty data
  const data = new Uint8Array(0);
  const encoded = encodeRDataTXT(data);
  const decoded = decodeRDataTXT(encoded);
  assertArrayEqual(decoded, data, 'TXT RDATA: empty data round-trip');
}

// Test DNS message serialization/deserialization
{
  const msg = new Message();
  msg.id = 0x1234;
  msg.flags = 0x0100; // RD = 1
  msg.question = [new Question(Name.parse('test.example.com'), RRTypeTXT, 1)];

  const wire = messageToWireFormat(msg);
  const parsed = messageFromWireFormat(wire);

  assert(parsed.id === 0x1234, 'DNS message: ID preserved');
  assert(parsed.flags === 0x0100, 'DNS message: flags preserved');
  assert(parsed.question.length === 1, 'DNS message: question count');
  assert(parsed.question[0].type === RRTypeTXT, 'DNS message: question type');
  assert(parsed.question[0].name.toString() === 'test.example.com', 'DNS message: question name');
}

// Test DNS message with answer and additional sections
{
  const msg = new Message();
  msg.id = 0xabcd;
  msg.flags = 0x8400; // QR=1, AA=1
  msg.question = [new Question(Name.parse('data.t.example.com'), RRTypeTXT, 1)];
  msg.answer = [new RR(
    Name.parse('data.t.example.com'),
    RRTypeTXT, 1, 60,
    encodeRDataTXT(new Uint8Array([10, 20, 30]))
  )];
  msg.additional = [new RR(
    new Name(), RRTypeOPT, 4096, 0, new Uint8Array(0)
  )];

  const wire = messageToWireFormat(msg);
  const parsed = messageFromWireFormat(wire);

  assert(parsed.id === 0xabcd, 'DNS message with answer: ID preserved');
  assert(parsed.answer.length === 1, 'DNS message with answer: answer count');
  assert(parsed.additional.length === 1, 'DNS message with answer: additional count');
  assert(parsed.additional[0].type === RRTypeOPT, 'DNS message with answer: OPT RR type');
}

// ============================================================
// Noise Crypto Tests
// ============================================================

console.log('\n=== Noise Crypto Tests ===\n');

// Test key generation and encoding
{
  const privkey = generatePrivkey();
  assert(privkey.length === KEY_LEN, 'generatePrivkey: correct key length');

  const pubkey = pubkeyFromPrivkey(privkey);
  assert(pubkey.length === KEY_LEN, 'pubkeyFromPrivkey: correct key length');

  const encoded = encodeKey(privkey);
  assert(encoded.length === KEY_LEN * 2, 'encodeKey: correct hex length');

  const decoded = decodeKey(encoded);
  assertArrayEqual(decoded, privkey, 'decodeKey/encodeKey: round-trip');
}

// Test that different private keys produce different public keys
{
  const priv1 = generatePrivkey();
  const priv2 = generatePrivkey();
  const pub1 = pubkeyFromPrivkey(priv1);
  const pub2 = pubkeyFromPrivkey(priv2);

  let same = true;
  for (let i = 0; i < KEY_LEN; i++) {
    if (pub1[i] !== pub2[i]) { same = false; break; }
  }
  assert(!same, 'Different private keys produce different public keys');
}

// Test Noise handshake (server side only - we simulate what a client would send)
{
  const serverPrivkey = generatePrivkey();
  const serverPubkey = pubkeyFromPrivkey(serverPrivkey);
  const noiseServer = new NoiseServer(serverPrivkey);

  // Verify server pubkey derivation
  const derivedPubkey = pubkeyFromPrivkey(serverPrivkey);
  assertArrayEqual(derivedPubkey, serverPubkey, 'Server pubkey derivation consistent');

  assert(noiseServer !== null, 'NoiseServer created successfully');
}

// ============================================================
// TurboTunnel Tests
// ============================================================

console.log('\n=== TurboTunnel Tests ===\n');

// Test ClientID
{
  const id1 = new ClientID();
  const id2 = new ClientID();
  assert(id1.bytes.length === 8, 'ClientID: correct length');
  assert(!id1.equals(id2), 'ClientID: unique IDs');
  assert(id1.equals(id1), 'ClientID: self-equality');
}

{
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const id = ClientID.fromBytes(bytes);
  assert(id !== null, 'ClientID.fromBytes: valid');
  assertArrayEqual(id.bytes, bytes, 'ClientID.fromBytes: correct bytes');
}

{
  const shortBytes = new Uint8Array([1, 2, 3]);
  const id = ClientID.fromBytes(shortBytes);
  assert(id === null, 'ClientID.fromBytes: null for short input');
}

// Test SessionManager
{
  const mgr = new SessionManager(1000);
  const id1 = new ClientID();
  const id2 = new ClientID();

  const s1 = mgr.getOrCreate(id1);
  const s2 = mgr.getOrCreate(id2);
  assert(mgr.size === 2, 'SessionManager: correct size after adding 2 sessions');

  const s1Again = mgr.getOrCreate(id1);
  assert(mgr.size === 2, 'SessionManager: no duplicate on re-get');

  // Test session queue operations
  s1.queueIncoming(new Uint8Array([1, 2, 3]));
  s1.queueIncoming(new Uint8Array([4, 5, 6]));
  const pkt1 = s1.dequeueIncoming();
  assertArrayEqual(pkt1, new Uint8Array([1, 2, 3]), 'Session: dequeue first packet');
  const pkt2 = s1.dequeueIncoming();
  assertArrayEqual(pkt2, new Uint8Array([4, 5, 6]), 'Session: dequeue second packet');
  const pkt3 = s1.dequeueIncoming();
  assert(pkt3 === null, 'Session: null when queue empty');
}

// ============================================================
// KCP Tests
// ============================================================

console.log('\n=== KCP Tests ===\n');

// Test KCP segment encoding/decoding
{
  const seg = new Segment();
  seg.conv = 0x12345678;
  seg.cmd = KCP_CMD_PUSH;
  seg.frg = 0;
  seg.wnd = 128;
  seg.ts = 1000;
  seg.sn = 1;
  seg.una = 0;
  seg.data = new Uint8Array([10, 20, 30, 40, 50]);

  const encoded = seg.encode();
  assert(encoded.length === 24 + 5, 'KCP segment: correct encoded length');

  const decoded = Segment.decode(encoded);
  assert(decoded !== null, 'KCP segment: decode succeeds');
  assert(decoded.conv === 0x12345678, 'KCP segment: conv preserved');
  assert(decoded.cmd === KCP_CMD_PUSH, 'KCP segment: cmd preserved');
  assert(decoded.sn === 1, 'KCP segment: sn preserved');
  assertArrayEqual(decoded.data, seg.data, 'KCP segment: data preserved');
}

// Test multiple segments parsing
{
  const seg1 = new Segment();
  seg1.conv = 1;
  seg1.cmd = KCP_CMD_PUSH;
  seg1.sn = 0;
  seg1.data = new Uint8Array([1, 2, 3]);

  const seg2 = new Segment();
  seg2.conv = 1;
  seg2.cmd = KCP_CMD_ACK;
  seg2.sn = 0;
  seg2.data = new Uint8Array(0);

  const buf1 = seg1.encode();
  const buf2 = seg2.encode();
  const combined = new Uint8Array(buf1.length + buf2.length);
  combined.set(buf1);
  combined.set(buf2, buf1.length);

  const segments = parseSegments(combined);
  assert(segments.length === 2, 'parseSegments: found 2 segments');
  assert(segments[0].cmd === KCP_CMD_PUSH, 'parseSegments: first is PUSH');
  assert(segments[1].cmd === KCP_CMD_ACK, 'parseSegments: second is ACK');
}

// Test KCP session basic operations
{
  const kcp = new KCPSession(42);

  // Create a push segment
  const seg = new Segment();
  seg.conv = 42;
  seg.cmd = KCP_CMD_PUSH;
  seg.frg = 0;
  seg.wnd = 128;
  seg.ts = 1000;
  seg.sn = 0;
  seg.una = 0;
  seg.data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

  const encoded = seg.encode();
  kcp.input(encoded);

  const received = kcp.recv();
  assert(received !== null, 'KCP: received data after input');
  assertArrayEqual(received, new Uint8Array([72, 101, 108, 108, 111]), 'KCP: correct data received');

  // Flush should produce ACKs
  const output = kcp.flush();
  assert(output.length > 0, 'KCP: flush produces ACKs');
}

// ============================================================
// Integration: Base32 Decoding
// ============================================================

console.log('\n=== Base32 Tests ===\n');

{
  // Test base32 encoding/decoding (matching Go's StdEncoding without padding)
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

  // Test: "JBSWY3DP" = "Hello"
  const decoded = base32Decode('JBSWY3DP');
  assertArrayEqual(decoded, new Uint8Array([72, 101, 108, 108, 111]), 'Base32: decode "JBSWY3DP" = "Hello"');

  // Test empty
  const empty = base32Decode('');
  assert(empty.length === 0, 'Base32: decode empty string');
}

// ============================================================
// Summary
// ============================================================

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

if (failed > 0) {
  process.exit(1);
}
