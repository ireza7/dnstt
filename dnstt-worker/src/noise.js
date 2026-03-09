/**
 * Noise_NK_25519_ChaChaPoly_BLAKE2s protocol implementation
 * Ported from dnstt Go implementation
 *
 * This uses the Web Crypto API available in Cloudflare Workers
 * with manual implementations of Curve25519, ChaCha20-Poly1305, and BLAKE2s
 */

const KEY_LEN = 32;

// ============================================================
// BLAKE2s Implementation
// ============================================================
const BLAKE2S_IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

const BLAKE2S_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr32(v, n) {
  return ((v >>> n) | (v << (32 - n))) >>> 0;
}

function blake2sG(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) >>> 0;
  v[d] = rotr32(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) >>> 0;
  v[b] = rotr32(v[b] ^ v[c], 12);
  v[a] = (v[a] + v[b] + y) >>> 0;
  v[d] = rotr32(v[d] ^ v[a], 8);
  v[c] = (v[c] + v[d]) >>> 0;
  v[b] = rotr32(v[b] ^ v[c], 7);
}

function blake2sCompress(h, block, t, f) {
  const v = new Uint32Array(16);
  const m = new Uint32Array(16);

  for (let i = 0; i < 8; i++) v[i] = h[i];
  for (let i = 0; i < 8; i++) v[i + 8] = BLAKE2S_IV[i];

  v[12] ^= t >>> 0;
  v[13] ^= (t / 0x100000000) >>> 0;
  if (f) v[14] ^= 0xffffffff;

  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  for (let i = 0; i < 16; i++) {
    m[i] = view.getUint32(i * 4, true);
  }

  for (let round = 0; round < 10; round++) {
    const s = BLAKE2S_SIGMA[round];
    blake2sG(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    blake2sG(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    blake2sG(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    blake2sG(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    blake2sG(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    blake2sG(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    blake2sG(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    blake2sG(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i++) {
    h[i] ^= v[i] ^ v[i + 8];
  }
}

function blake2s(input, keyBytes = null, outLen = 32) {
  const h = new Uint32Array(BLAKE2S_IV);
  const keyLen = keyBytes ? keyBytes.length : 0;

  // Parameter block
  h[0] ^= 0x01010000 ^ (keyLen << 8) ^ outLen;

  let t = 0;
  let buffer = new Uint8Array(64);
  let bufLen = 0;

  // If keyed, first block is the key padded to 64 bytes
  if (keyLen > 0) {
    buffer.set(keyBytes);
    bufLen = 64;
  }

  // Process input
  for (let i = 0; i < input.length; i++) {
    if (bufLen === 64) {
      t += 64;
      blake2sCompress(h, buffer, t, false);
      bufLen = 0;
      buffer = new Uint8Array(64);
    }
    buffer[bufLen++] = input[i];
  }

  // Final block
  t += bufLen;
  // Pad with zeros (buffer is already zeroed)
  blake2sCompress(h, buffer, t, true);

  // Extract output
  const out = new Uint8Array(outLen);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < outLen / 4; i++) {
    outView.setUint32(i * 4, h[i], true);
  }
  return out;
}

// HMAC-BLAKE2s
function hmacBlake2s(key, data) {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) {
    k = blake2s(k);
  }
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(k);

  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }

  const inner = new Uint8Array(blockSize + data.length);
  inner.set(ipad);
  inner.set(data, blockSize);
  const innerHash = blake2s(inner);

  const outer = new Uint8Array(blockSize + 32);
  outer.set(opad);
  outer.set(innerHash, blockSize);
  return blake2s(outer);
}

// HKDF using BLAKE2s
function hkdf(chainingKey, inputKeyMaterial, numOutputs) {
  const tempKey = hmacBlake2s(chainingKey, inputKeyMaterial);
  const out1 = hmacBlake2s(tempKey, new Uint8Array([1]));
  if (numOutputs === 1) return [out1];

  const concat2 = new Uint8Array(out1.length + 1);
  concat2.set(out1);
  concat2[out1.length] = 2;
  const out2 = hmacBlake2s(tempKey, concat2);
  if (numOutputs === 2) return [out1, out2];

  const concat3 = new Uint8Array(out2.length + 1);
  concat3.set(out2);
  concat3[out2.length] = 3;
  const out3 = hmacBlake2s(tempKey, concat3);
  return [out1, out2, out3];
}

// ============================================================
// Curve25519 Implementation
// ============================================================

// Field element: array of 16 int32 values (each representing ~16 bits)
function gf(init) {
  const r = new Float64Array(16);
  if (init) for (let i = 0; i < init.length; i++) r[i] = init[i];
  return r;
}

const _9 = new Uint8Array(32);
_9[0] = 9;

const _121665 = gf([0xdb41, 1]);

function car25519(o) {
  let c;
  for (let i = 0; i < 16; i++) {
    o[i] += 65536;
    c = Math.floor(o[i] / 65536);
    o[(i + 1) % 16] += c - 1 + 37 * (c - 1) * (i === 15 ? 1 : 0);
    o[i] -= c * 65536;
  }
}

function sel25519(p, q, b) {
  let t;
  const c = ~(b - 1);
  for (let i = 0; i < 16; i++) {
    t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

function pack25519(o, n) {
  let b;
  const m = gf();
  const t = gf();
  for (let i = 0; i < 16; i++) t[i] = n[i];
  car25519(t);
  car25519(t);
  car25519(t);
  for (let j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (let i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (let i = 0; i < 16; i++) {
    o[2 * i] = t[i] & 0xff;
    o[2 * i + 1] = t[i] >> 8;
  }
}

function unpack25519(o, n) {
  for (let i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}

function A(o, a, b) {
  for (let i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

function Z(o, a, b) {
  for (let i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

function M(o, a, b) {
  let i, j, t = new Float64Array(31);
  for (i = 0; i < 31; i++) t[i] = 0;
  for (i = 0; i < 16; i++) {
    for (j = 0; j < 16; j++) {
      t[i + j] += a[i] * b[j];
    }
  }
  for (i = 0; i < 15; i++) {
    t[i] += 38 * t[i + 16];
  }
  for (i = 0; i < 16; i++) o[i] = t[i];
  car25519(o);
  car25519(o);
}

function S(o, a) {
  M(o, a, a);
}

function inv25519(o, a) {
  const c = gf();
  for (let i = 0; i < 16; i++) c[i] = a[i];
  for (let i = 253; i >= 0; i--) {
    S(c, c);
    if (i !== 2 && i !== 4) M(c, c, a);
  }
  for (let i = 0; i < 16; i++) o[i] = c[i];
}

function scalarMult(q, n, p) {
  const z = new Uint8Array(32);
  const x = new Float64Array(80);
  const a = gf(), b = gf(), c = gf(),
    d = gf(), e = gf(), f = gf();

  for (let i = 0; i < 31; i++) z[i] = n[i];
  z[31] = (n[31] & 127) | 64;
  z[0] &= 248;

  unpack25519(x, p);
  for (let i = 0; i < 16; i++) {
    b[i] = x[i];
    d[i] = 0;
    a[i] = 0;
    c[i] = 0;
  }
  a[0] = 1;
  d[0] = 1;

  for (let i = 254; i >= 0; --i) {
    const r = (z[i >>> 3] >>> (i & 7)) & 1;
    sel25519(a, b, r);
    sel25519(c, d, r);
    A(e, a, c);
    Z(a, a, c);
    A(c, b, d);
    Z(b, b, d);
    S(d, e);
    S(f, a);
    M(a, c, a);
    M(c, b, e);
    A(e, a, c);
    Z(a, a, c);
    S(b, a);
    Z(c, d, f);
    M(a, c, _121665);
    A(a, a, d);
    M(c, c, a);
    M(a, d, f);
    M(d, b, x);
    S(b, e);
    sel25519(a, b, r);
    sel25519(c, d, r);
  }

  for (let i = 0; i < 16; i++) {
    x[i + 16] = a[i];
    x[i + 32] = c[i];
    x[i + 48] = b[i];
    x[i + 64] = d[i];
  }

  const x32 = x.subarray(32);
  const x16 = x.subarray(16);
  inv25519(x32, x32);
  M(x16, x16, x32);
  pack25519(q, x16);
}

function x25519(privateKey, publicKey) {
  const out = new Uint8Array(32);
  scalarMult(out, privateKey, publicKey);
  return out;
}

function x25519GenerateKeypair() {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  priv[0] &= 248;
  priv[31] &= 127;
  priv[31] |= 64;
  const pub = x25519(priv, _9);
  return { private: priv, public: pub };
}

function x25519PublicFromPrivate(privkey) {
  return x25519(privkey, _9);
}

// ============================================================
// ChaCha20-Poly1305 Implementation
// ============================================================

function chacha20Quarter(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotr32(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotr32(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotr32(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotr32(state[b] ^ state[c], 7);
}

function chacha20Block(key, counter, nonce) {
  const state = new Uint32Array(16);
  // "expand 32-byte k"
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;

  const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < 8; i++) state[4 + i] = keyView.getUint32(i * 4, true);

  state[12] = counter;

  const nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  for (let i = 0; i < 3; i++) state[13 + i] = nonceView.getUint32(i * 4, true);

  const working = new Uint32Array(state);

  for (let i = 0; i < 10; i++) {
    chacha20Quarter(working, 0, 4, 8, 12);
    chacha20Quarter(working, 1, 5, 9, 13);
    chacha20Quarter(working, 2, 6, 10, 14);
    chacha20Quarter(working, 3, 7, 11, 15);
    chacha20Quarter(working, 0, 5, 10, 15);
    chacha20Quarter(working, 1, 6, 11, 12);
    chacha20Quarter(working, 2, 7, 8, 13);
    chacha20Quarter(working, 3, 4, 9, 14);
  }

  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) {
    outView.setUint32(i * 4, (working[i] + state[i]) >>> 0, true);
  }
  return out;
}

function chacha20Encrypt(key, nonce, data) {
  const out = new Uint8Array(data.length);
  let counter = 1; // Counter starts at 1 for encryption in AEAD

  for (let offset = 0; offset < data.length; offset += 64) {
    const block = chacha20Block(key, counter, nonce);
    const remaining = Math.min(64, data.length - offset);
    for (let i = 0; i < remaining; i++) {
      out[offset + i] = data[offset + i] ^ block[i];
    }
    counter++;
  }
  return out;
}

// Poly1305
function poly1305(key, msg) {
  // r = key[0..15] clamped, s = key[16..31]
  const r = new Uint8Array(16);
  r.set(key.subarray(0, 16));
  r[3] &= 15; r[7] &= 15; r[11] &= 15; r[15] &= 15;
  r[4] &= 252; r[8] &= 252; r[12] &= 252;

  // Use BigInt for the actual Poly1305 computation
  const P = (1n << 130n) - 5n;

  let rBig = 0n;
  for (let i = 15; i >= 0; i--) rBig = (rBig << 8n) | BigInt(r[i]);

  let sBig = 0n;
  for (let i = 15; i >= 0; i--) sBig = (sBig << 8n) | BigInt(key[16 + i]);

  let acc = 0n;

  for (let i = 0; i < msg.length; i += 16) {
    const blockLen = Math.min(16, msg.length - i);
    let n = 0n;
    // Little-endian
    for (let j = blockLen - 1; j >= 0; j--) {
      n = (n << 8n) | BigInt(msg[i + j]);
    }
    n |= (1n << (BigInt(blockLen) * 8n)); // Add high bit
    acc = ((acc + n) * rBig) % P;
  }

  acc = (acc + sBig) & ((1n << 128n) - 1n);

  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return tag;
}

function pad16(len) {
  const rem = len % 16;
  if (rem === 0) return new Uint8Array(0);
  return new Uint8Array(16 - rem);
}

function chacha20Poly1305Seal(key, nonce, plaintext, ad) {
  // Generate Poly1305 key
  const polyKey = chacha20Block(key, 0, nonce).subarray(0, 32);

  // Encrypt
  const ciphertext = chacha20Encrypt(key, nonce, plaintext);

  // Build MAC input
  const adPad = pad16(ad.length);
  const ctPad = pad16(ciphertext.length);
  const lenBuf = new Uint8Array(16);
  const lenView = new DataView(lenBuf.buffer);
  lenView.setUint32(0, ad.length, true);
  lenView.setUint32(8, ciphertext.length, true);

  const macInput = new Uint8Array(ad.length + adPad.length + ciphertext.length + ctPad.length + 16);
  let off = 0;
  macInput.set(ad, off); off += ad.length;
  macInput.set(adPad, off); off += adPad.length;
  macInput.set(ciphertext, off); off += ciphertext.length;
  macInput.set(ctPad, off); off += ctPad.length;
  macInput.set(lenBuf, off);

  const tag = poly1305(polyKey, macInput);

  // Return ciphertext + tag
  const result = new Uint8Array(ciphertext.length + 16);
  result.set(ciphertext);
  result.set(tag, ciphertext.length);
  return result;
}

function chacha20Poly1305Open(key, nonce, sealed, ad) {
  if (sealed.length < 16) throw new Error('ciphertext too short');

  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  // Generate Poly1305 key
  const polyKey = chacha20Block(key, 0, nonce).subarray(0, 32);

  // Verify MAC
  const adPad = pad16(ad.length);
  const ctPad = pad16(ciphertext.length);
  const lenBuf = new Uint8Array(16);
  const lenView = new DataView(lenBuf.buffer);
  lenView.setUint32(0, ad.length, true);
  lenView.setUint32(8, ciphertext.length, true);

  const macInput = new Uint8Array(ad.length + adPad.length + ciphertext.length + ctPad.length + 16);
  let off = 0;
  macInput.set(ad, off); off += ad.length;
  macInput.set(adPad, off); off += adPad.length;
  macInput.set(ciphertext, off); off += ciphertext.length;
  macInput.set(ctPad, off); off += ctPad.length;
  macInput.set(lenBuf, off);

  const computedTag = poly1305(polyKey, macInput);

  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ computedTag[i];
  if (diff !== 0) throw new Error('authentication failed');

  // Decrypt
  return chacha20Encrypt(key, nonce, ciphertext);
}

// ============================================================
// Noise Protocol - CipherState
// ============================================================

class CipherState {
  constructor(key) {
    this.k = key;
    this.n = 0n;
  }

  hasKey() {
    return this.k !== null;
  }

  setNonce(n) {
    this.n = n;
  }

  encryptWithAd(ad, plaintext) {
    if (!this.hasKey()) return plaintext;
    const nonce = new Uint8Array(12);
    const view = new DataView(nonce.buffer);
    view.setUint32(4, Number(this.n & 0xffffffffn), true);
    view.setUint32(8, Number((this.n >> 32n) & 0xffffffffn), true);
    this.n++;
    return chacha20Poly1305Seal(this.k, nonce, plaintext, ad);
  }

  decryptWithAd(ad, ciphertext) {
    if (!this.hasKey()) return ciphertext;
    const nonce = new Uint8Array(12);
    const view = new DataView(nonce.buffer);
    view.setUint32(4, Number(this.n & 0xffffffffn), true);
    view.setUint32(8, Number((this.n >> 32n) & 0xffffffffn), true);
    this.n++;
    return chacha20Poly1305Open(this.k, nonce, ciphertext, ad);
  }
}

// ============================================================
// Noise Protocol - SymmetricState
// ============================================================

class SymmetricState {
  constructor(protocolName) {
    const nameBytes = new TextEncoder().encode(protocolName);
    if (nameBytes.length <= 32) {
      this.h = new Uint8Array(32);
      this.h.set(nameBytes);
    } else {
      this.h = blake2s(nameBytes);
    }
    this.ck = new Uint8Array(this.h);
    this.cs = new CipherState(null);
  }

  mixKey(inputKeyMaterial) {
    const [ck, tempK] = hkdf(this.ck, inputKeyMaterial, 2);
    this.ck = ck;
    this.cs = new CipherState(tempK);
  }

  mixHash(data) {
    const concat = new Uint8Array(this.h.length + data.length);
    concat.set(this.h);
    concat.set(data, this.h.length);
    this.h = blake2s(concat);
  }

  encryptAndHash(plaintext) {
    const ciphertext = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    const plaintext = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split() {
    const [tempK1, tempK2] = hkdf(this.ck, new Uint8Array(0), 2);
    return [new CipherState(tempK1), new CipherState(tempK2)];
  }
}

// ============================================================
// Noise NK Handshake
// ============================================================

/**
 * Server-side NK handshake
 * Pattern:
 *   <- s
 *   ...
 *   -> e, es
 *   <- e, ee
 */
export class NoiseServer {
  constructor(serverPrivkey) {
    this.serverPrivkey = serverPrivkey;
    this.serverPubkey = x25519PublicFromPrivate(serverPrivkey);
  }

  /**
   * Process the client's first handshake message and return:
   * - The server's response message
   * - A pair of CipherStates [recvCipher, sendCipher]
   */
  processHandshake(clientMessage) {
    const protocolName = 'Noise_NK_25519_ChaChaPoly_BLAKE2s';
    const prologue = new TextEncoder().encode('dnstt 2020-04-13');

    const ss = new SymmetricState(protocolName);
    ss.mixHash(prologue);

    // Pre-message: <- s (server public key is known to client)
    ss.mixHash(this.serverPubkey);

    // -> e, es (client sends ephemeral key)
    // Read client ephemeral public key from the message
    const re = clientMessage.subarray(0, 32); // client's ephemeral public key
    const encryptedPayload = clientMessage.subarray(32);

    // e
    ss.mixHash(re);

    // es: DH(re, s)
    const dhResult = x25519(this.serverPrivkey, re);
    ss.mixKey(dhResult);

    // Decrypt payload
    const payload = ss.decryptAndHash(encryptedPayload);

    // <- e, ee (server sends ephemeral key)
    const serverEphemeral = x25519GenerateKeypair();

    // e
    ss.mixHash(serverEphemeral.public);

    // ee: DH(e, re)
    const dhResult2 = x25519(serverEphemeral.private, re);
    ss.mixKey(dhResult2);

    // Encrypt empty payload
    const responsePayload = ss.encryptAndHash(new Uint8Array(0));

    // Build response message
    const response = new Uint8Array(32 + responsePayload.length);
    response.set(serverEphemeral.public);
    response.set(responsePayload, 32);

    // Split
    const [recvCipher, sendCipher] = ss.split();

    return { response, recvCipher, sendCipher, payload };
  }
}

// ============================================================
// Noise Socket - length-prefixed encrypted messages
// ============================================================

export class NoiseSocket {
  constructor(recvCipher, sendCipher) {
    this.recvCipher = recvCipher;
    this.sendCipher = sendCipher;
    this.recvBuffer = new Uint8Array(0);
  }

  /**
   * Encrypt data for sending
   */
  encrypt(plaintext) {
    const chunks = [];
    let offset = 0;
    while (offset < plaintext.length) {
      const chunkSize = Math.min(4096, plaintext.length - offset);
      const chunk = plaintext.subarray(offset, offset + chunkSize);
      const encrypted = this.sendCipher.encryptWithAd(new Uint8Array(0), chunk);
      // Length prefix (2 bytes, big-endian)
      const lenBuf = new Uint8Array(2);
      const lenView = new DataView(lenBuf.buffer);
      lenView.setUint16(0, encrypted.length);
      chunks.push(lenBuf);
      chunks.push(encrypted);
      offset += chunkSize;
    }
    // Concatenate all chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      result.set(c, pos);
      pos += c.length;
    }
    return result;
  }

  /**
   * Feed received data and return decrypted messages
   */
  decrypt(data) {
    // Append to buffer
    const newBuf = new Uint8Array(this.recvBuffer.length + data.length);
    newBuf.set(this.recvBuffer);
    newBuf.set(data, this.recvBuffer.length);
    this.recvBuffer = newBuf;

    const messages = [];
    while (this.recvBuffer.length >= 2) {
      const view = new DataView(this.recvBuffer.buffer, this.recvBuffer.byteOffset, this.recvBuffer.byteLength);
      const msgLen = view.getUint16(0);
      if (this.recvBuffer.length < 2 + msgLen) break;

      const msg = this.recvBuffer.subarray(2, 2 + msgLen);
      const plaintext = this.recvCipher.decryptWithAd(new Uint8Array(0), msg);
      messages.push(plaintext);
      this.recvBuffer = this.recvBuffer.subarray(2 + msgLen);
    }
    return messages;
  }
}

// ============================================================
// Key utilities
// ============================================================

export function generatePrivkey() {
  const pair = x25519GenerateKeypair();
  return pair.private;
}

export function pubkeyFromPrivkey(privkey) {
  return x25519PublicFromPrivate(privkey);
}

export function decodeKey(hexStr) {
  if (hexStr.length !== KEY_LEN * 2) {
    throw new Error(`key length is ${hexStr.length / 2}, expected ${KEY_LEN}`);
  }
  const key = new Uint8Array(KEY_LEN);
  for (let i = 0; i < KEY_LEN; i++) {
    key[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  return key;
}

export function encodeKey(key) {
  return Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
}

export { KEY_LEN };
