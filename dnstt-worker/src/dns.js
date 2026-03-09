/**
 * DNS wire format encoder/decoder - ported from dnstt Go implementation
 * Package dns deals with encoding and decoding DNS wire format.
 */

// Constants
export const RRTypeTXT = 16;
export const RRTypeOPT = 41;
export const ClassIN = 1;
export const RcodeNoError = 0;
export const RcodeFormatError = 1;
export const RcodeNameError = 3;
export const RcodeNotImplemented = 4;
export const ExtendedRcodeBadVers = 16;

const COMPRESSION_POINTER_LIMIT = 10;

/**
 * DNS Name - represented as array of Uint8Array labels
 */
export class Name {
  constructor(labels = []) {
    this.labels = labels;
  }

  static fromLabels(labels) {
    for (const label of labels) {
      if (label.length === 0) throw new Error('name contains a zero-length label');
      if (label.length > 63) throw new Error('name contains a label longer than 63 octets');
    }
    const name = new Name(labels);
    // Check total encoded length
    let totalLen = 1; // trailing zero
    for (const label of labels) {
      totalLen += 1 + label.length;
    }
    if (totalLen > 255) throw new Error('name is longer than 255 octets');
    return name;
  }

  static parse(s) {
    if (s.endsWith('.')) s = s.slice(0, -1);
    if (s.length === 0) return new Name([]);
    const parts = s.split('.');
    const labels = parts.map(p => new TextEncoder().encode(p));
    return Name.fromLabels(labels);
  }

  toString() {
    if (this.labels.length === 0) return '.';
    return this.labels.map(label => {
      let s = '';
      for (const b of label) {
        if (b === 0x2d || // '-'
          (0x30 <= b && b <= 0x39) || // 0-9
          (0x41 <= b && b <= 0x5a) || // A-Z
          (0x61 <= b && b <= 0x7a)) { // a-z
          s += String.fromCharCode(b);
        } else {
          s += `\\x${b.toString(16).padStart(2, '0')}`;
        }
      }
      return s;
    }).join('.');
  }

  /**
   * TrimSuffix returns a Name with the given suffix removed.
   * Returns [prefix, true] if suffix was present, [null, false] otherwise.
   */
  trimSuffix(suffix) {
    if (this.labels.length < suffix.labels.length) return [null, false];
    const split = this.labels.length - suffix.labels.length;
    const fore = this.labels.slice(0, split);
    const aft = this.labels.slice(split);
    for (let i = 0; i < aft.length; i++) {
      const a = new TextDecoder().decode(aft[i]).toLowerCase();
      const b = new TextDecoder().decode(suffix.labels[i]).toLowerCase();
      if (a !== b) return [null, false];
    }
    return [fore, true];
  }

  get length() {
    return this.labels.length;
  }
}

/**
 * DNS Message
 */
export class Message {
  constructor() {
    this.id = 0;
    this.flags = 0;
    this.question = [];
    this.answer = [];
    this.authority = [];
    this.additional = [];
  }

  opcode() {
    return (this.flags >> 11) & 0xf;
  }

  rcode() {
    return this.flags & 0x000f;
  }
}

/**
 * DNS Question
 */
export class Question {
  constructor(name, type, cls) {
    this.name = name;
    this.type = type;
    this.class = cls;
  }
}

/**
 * DNS Resource Record
 */
export class RR {
  constructor(name, type, cls, ttl, data) {
    this.name = name || new Name();
    this.type = type || 0;
    this.class = cls || 0;
    this.ttl = ttl || 0;
    this.data = data || new Uint8Array(0);
  }
}

/**
 * Binary reader for parsing DNS wire format
 */
class DNSReader {
  constructor(buffer) {
    this.buffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    this.offset = 0;
  }

  remaining() {
    return this.buffer.length - this.offset;
  }

  readUint8() {
    if (this.offset >= this.buffer.length) throw new Error('unexpected EOF');
    return this.buffer[this.offset++];
  }

  readUint16() {
    if (this.offset + 2 > this.buffer.length) throw new Error('unexpected EOF');
    const val = this.view.getUint16(this.offset);
    this.offset += 2;
    return val;
  }

  readUint32() {
    if (this.offset + 4 > this.buffer.length) throw new Error('unexpected EOF');
    const val = this.view.getUint32(this.offset);
    this.offset += 4;
    return val;
  }

  readBytes(n) {
    if (this.offset + n > this.buffer.length) throw new Error('unexpected EOF');
    const bytes = this.buffer.slice(this.offset, this.offset + n);
    this.offset += n;
    return bytes;
  }

  seek(pos) {
    if (pos < 0 || pos > this.buffer.length) throw new Error('seek out of bounds');
    this.offset = pos;
  }

  tell() {
    return this.offset;
  }

  readName() {
    const labels = [];
    let numPointers = 0;
    let seekTo = -1;

    while (true) {
      const labelType = this.readUint8();
      const typeFlag = labelType & 0xc0;

      if (typeFlag === 0x00) {
        // Ordinary label
        const length = labelType & 0x3f;
        if (length === 0) break; // End of name
        labels.push(this.readBytes(length));
      } else if (typeFlag === 0xc0) {
        // Compression pointer
        const upper = labelType & 0x3f;
        const lower = this.readUint8();
        const pointerOffset = (upper << 8) | lower;

        if (numPointers === 0) {
          seekTo = this.tell();
        }
        numPointers++;
        if (numPointers > COMPRESSION_POINTER_LIMIT) {
          throw new Error('too many compression pointers');
        }
        this.seek(pointerOffset);
      } else {
        throw new Error('reserved label type');
      }
    }

    if (numPointers > 0) {
      this.seek(seekTo);
    }

    return Name.fromLabels(labels);
  }

  readQuestion() {
    const name = this.readName();
    const type = this.readUint16();
    const cls = this.readUint16();
    return new Question(name, type, cls);
  }

  readRR() {
    const name = this.readName();
    const type = this.readUint16();
    const cls = this.readUint16();
    const ttl = this.readUint32();
    const rdLength = this.readUint16();
    const data = this.readBytes(rdLength);
    return new RR(name, type, cls, ttl, data);
  }
}

/**
 * Parse a DNS message from wire format
 */
export function messageFromWireFormat(buf) {
  const r = new DNSReader(buf);
  const msg = new Message();

  // Header
  msg.id = r.readUint16();
  msg.flags = r.readUint16();
  const qdCount = r.readUint16();
  const anCount = r.readUint16();
  const nsCount = r.readUint16();
  const arCount = r.readUint16();

  // Questions
  for (let i = 0; i < qdCount; i++) {
    msg.question.push(r.readQuestion());
  }

  // Answer
  for (let i = 0; i < anCount; i++) {
    msg.answer.push(r.readRR());
  }

  // Authority
  for (let i = 0; i < nsCount; i++) {
    msg.authority.push(r.readRR());
  }

  // Additional
  for (let i = 0; i < arCount; i++) {
    msg.additional.push(r.readRR());
  }

  if (r.remaining() > 0) {
    throw new Error('trailing bytes after message');
  }

  return msg;
}

/**
 * DNS Message builder for wire format
 */
class MessageBuilder {
  constructor() {
    this.parts = [];
    this.length = 0;
    this.nameCache = new Map();
  }

  writeUint8(val) {
    this.parts.push(new Uint8Array([val & 0xff]));
    this.length += 1;
  }

  writeUint16(val) {
    const buf = new Uint8Array(2);
    const view = new DataView(buf.buffer);
    view.setUint16(0, val);
    this.parts.push(buf);
    this.length += 2;
  }

  writeUint32(val) {
    const buf = new Uint8Array(4);
    const view = new DataView(buf.buffer);
    view.setUint32(0, val);
    this.parts.push(buf);
    this.length += 4;
  }

  writeBytes(data) {
    const copy = new Uint8Array(data);
    this.parts.push(copy);
    this.length += copy.length;
  }

  writeName(name) {
    for (let i = 0; i < name.labels.length; i++) {
      const suffixKey = name.labels.slice(i).map(l =>
        new TextDecoder().decode(l).toLowerCase()
      ).join('.');

      if (this.nameCache.has(suffixKey)) {
        const ptr = this.nameCache.get(suffixKey);
        if ((ptr & 0x3fff) === ptr) {
          this.writeUint16(0xc000 | ptr);
          return;
        }
      }

      this.nameCache.set(suffixKey, this.length);
      const label = name.labels[i];
      if (label.length === 0 || label.length > 63) {
        throw new Error(`invalid label length: ${label.length}`);
      }
      this.writeUint8(label.length);
      this.writeBytes(label);
    }
    this.writeUint8(0); // terminating null label
  }

  writeQuestion(q) {
    this.writeName(q.name);
    this.writeUint16(q.type);
    this.writeUint16(q.class);
  }

  writeRR(rr) {
    this.writeName(rr.name);
    this.writeUint16(rr.type);
    this.writeUint16(rr.class);
    this.writeUint32(rr.ttl);
    const rdLength = rr.data.length;
    if (rdLength > 0xffff) throw new Error('RR data too long');
    this.writeUint16(rdLength);
    this.writeBytes(rr.data);
  }

  writeMessage(msg) {
    this.writeUint16(msg.id);
    this.writeUint16(msg.flags);
    this.writeUint16(msg.question.length);
    this.writeUint16(msg.answer.length);
    this.writeUint16(msg.authority.length);
    this.writeUint16(msg.additional.length);

    for (const q of msg.question) {
      this.writeQuestion(q);
    }
    for (const rr of msg.answer) {
      this.writeRR(rr);
    }
    for (const rr of msg.authority) {
      this.writeRR(rr);
    }
    for (const rr of msg.additional) {
      this.writeRR(rr);
    }
  }

  build() {
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
}

/**
 * Encode a Message to wire format
 */
export function messageToWireFormat(msg) {
  const builder = new MessageBuilder();
  builder.writeMessage(msg);
  return builder.build();
}

/**
 * Decode TXT RDATA - concatenate all character-strings
 */
export function decodeRDataTXT(p) {
  const parts = [];
  let offset = 0;
  while (offset < p.length) {
    const n = p[offset];
    offset++;
    if (offset + n > p.length) throw new Error('unexpected EOF in TXT RDATA');
    parts.push(p.slice(offset, offset + n));
    offset += n;
  }
  // Concatenate all parts
  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

/**
 * Encode data as TXT RDATA - split into 255-byte character-strings
 */
export function encodeRDataTXT(p) {
  const parts = [];
  let offset = 0;
  while (p.length - offset > 255) {
    const chunk = new Uint8Array(256);
    chunk[0] = 255;
    chunk.set(p.slice(offset, offset + 255), 1);
    parts.push(chunk);
    offset += 255;
  }
  // Final chunk (may be empty, but must be present)
  const remaining = p.length - offset;
  const chunk = new Uint8Array(1 + remaining);
  chunk[0] = remaining;
  if (remaining > 0) {
    chunk.set(p.slice(offset), 1);
  }
  parts.push(chunk);

  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}
