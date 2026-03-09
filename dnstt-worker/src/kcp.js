/**
 * KCP Protocol - Minimal implementation for dnstt
 *
 * KCP is a reliability protocol on top of unreliable datagrams.
 * This is a simplified implementation focused on what dnstt needs.
 *
 * KCP Header format (24 bytes):
 * - conv: 4 bytes (conversation ID)
 * - cmd: 1 byte (command type)
 * - frg: 1 byte (fragment count)
 * - wnd: 2 bytes (window size)
 * - ts: 4 bytes (timestamp)
 * - sn: 4 bytes (sequence number)
 * - una: 4 bytes (unacknowledged)
 * - len: 4 bytes (data length)
 */

export const KCP_CMD_PUSH = 81;   // cmd: push data
export const KCP_CMD_ACK = 82;    // cmd: ack
export const KCP_CMD_WASK = 83;   // cmd: window probe (ask)
export const KCP_CMD_WINS = 84;   // cmd: window size (tell)

const KCP_OVERHEAD = 24;
const KCP_RTO_DEF = 200;
const KCP_RTO_MIN = 100;
const KCP_WND_SND = 32;
const KCP_WND_RCV = 128;

/**
 * KCP Segment
 */
class Segment {
  constructor() {
    this.conv = 0;
    this.cmd = 0;
    this.frg = 0;
    this.wnd = 0;
    this.ts = 0;
    this.sn = 0;
    this.una = 0;
    this.data = new Uint8Array(0);
  }

  static decode(buf) {
    if (buf.length < KCP_OVERHEAD) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const seg = new Segment();
    seg.conv = view.getUint32(0, true);
    seg.cmd = buf[4];
    seg.frg = buf[5];
    seg.wnd = view.getUint16(6, true);
    seg.ts = view.getUint32(8, true);
    seg.sn = view.getUint32(12, true);
    seg.una = view.getUint32(16, true);
    const dataLen = view.getUint32(20, true);
    if (buf.length < KCP_OVERHEAD + dataLen) return null;
    seg.data = buf.subarray(KCP_OVERHEAD, KCP_OVERHEAD + dataLen);
    return seg;
  }

  encode() {
    const buf = new Uint8Array(KCP_OVERHEAD + this.data.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, this.conv, true);
    buf[4] = this.cmd;
    buf[5] = this.frg;
    view.setUint16(6, this.wnd, true);
    view.setUint32(8, this.ts, true);
    view.setUint32(12, this.sn, true);
    view.setUint32(16, this.una, true);
    view.setUint32(20, this.data.length, true);
    buf.set(this.data, KCP_OVERHEAD);
    return buf;
  }

  static totalLength(buf) {
    if (buf.length < KCP_OVERHEAD) return -1;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dataLen = view.getUint32(20, true);
    return KCP_OVERHEAD + dataLen;
  }
}

/**
 * Parse multiple KCP segments from a single buffer
 */
export function parseSegments(buf) {
  const segments = [];
  let offset = 0;
  while (offset < buf.length) {
    const remaining = buf.subarray(offset);
    const totalLen = Segment.totalLength(remaining);
    if (totalLen < 0 || offset + totalLen > buf.length) break;
    const seg = Segment.decode(remaining.subarray(0, totalLen));
    if (!seg) break;
    segments.push(seg);
    offset += totalLen;
  }
  return segments;
}

/**
 * Simplified KCP session for the server side
 * Handles basic reliability: ACK generation, data reception, data sending
 */
export class KCPSession {
  constructor(conv) {
    this.conv = conv;
    this.sndUna = 0;
    this.sndNxt = 0;
    this.rcvNxt = 0;
    this.rcvWnd = KCP_WND_RCV;
    this.sndWnd = KCP_WND_SND;
    this.rto = KCP_RTO_DEF;
    this.current = 0;

    // Receive buffer - ordered segments
    this.rcvBuf = [];
    // Data ready to be read by the application
    this.rcvQueue = [];
    // Send queue
    this.sndQueue = [];
    // Send buffer (segments awaiting ACK)
    this.sndBuf = [];
    // ACKs to send
    this.ackList = [];
    // Output buffer
    this.outputQueue = [];
  }

  /**
   * Process incoming KCP data and return ACK packets
   */
  input(data) {
    const segments = parseSegments(data);

    for (const seg of segments) {
      if (seg.conv !== this.conv && this.conv !== 0) continue;

      // If conv was 0, adopt the conv from the first segment
      if (this.conv === 0) this.conv = seg.conv;

      switch (seg.cmd) {
        case KCP_CMD_PUSH:
          if (seg.sn >= this.rcvNxt + this.rcvWnd) break;
          // Record ACK
          this.ackList.push({ sn: seg.sn, ts: seg.ts });
          if (seg.sn >= this.rcvNxt) {
            // Insert into receive buffer (ordered)
            this.insertRcvBuf(seg);
          }
          // Move ready segments to rcvQueue
          this.moveToRcvQueue();
          break;

        case KCP_CMD_ACK:
          // Remove acknowledged segments from send buffer
          this.sndBuf = this.sndBuf.filter(s => s.sn !== seg.sn);
          break;

        case KCP_CMD_WASK:
          // Respond with window size
          break;

        case KCP_CMD_WINS:
          // Update remote window size
          break;
      }

      // Update una
      if (this.sndBuf.length > 0) {
        this.sndUna = this.sndBuf[0].sn;
      } else {
        this.sndUna = this.sndNxt;
      }
    }
  }

  insertRcvBuf(seg) {
    // Check for duplicates
    for (const existing of this.rcvBuf) {
      if (existing.sn === seg.sn) return;
    }
    this.rcvBuf.push(seg);
    this.rcvBuf.sort((a, b) => a.sn - b.sn);
  }

  moveToRcvQueue() {
    while (this.rcvBuf.length > 0 && this.rcvBuf[0].sn === this.rcvNxt) {
      const seg = this.rcvBuf.shift();
      this.rcvQueue.push(seg.data);
      this.rcvNxt++;
    }
  }

  /**
   * Read available data from the receive queue
   */
  recv() {
    if (this.rcvQueue.length === 0) return null;

    // Reassemble fragments
    const fragments = [];
    let peekSize = 0;

    // Find a complete message (frg counts down to 0)
    for (const data of this.rcvQueue) {
      fragments.push(data);
      peekSize += data.length;
    }

    // Return all available data
    if (fragments.length === 0) return null;

    const result = new Uint8Array(peekSize);
    let offset = 0;
    for (const frag of fragments) {
      result.set(frag, offset);
      offset += frag.length;
    }
    this.rcvQueue = [];
    return result;
  }

  /**
   * Queue data for sending
   */
  send(data) {
    if (data.length === 0) return;

    // Split into segments if needed (MTU-based)
    const mss = 1400 - KCP_OVERHEAD; // conservative MSS
    let offset = 0;
    const fragments = [];
    while (offset < data.length) {
      const size = Math.min(mss, data.length - offset);
      fragments.push(data.subarray(offset, offset + size));
      offset += size;
    }

    for (let i = 0; i < fragments.length; i++) {
      const seg = new Segment();
      seg.conv = this.conv;
      seg.cmd = KCP_CMD_PUSH;
      seg.frg = fragments.length - 1 - i;
      seg.data = new Uint8Array(fragments[i]);
      seg.sn = this.sndNxt++;
      this.sndQueue.push(seg);
    }
  }

  /**
   * Flush: generate output packets (ACKs + data)
   */
  flush() {
    const output = [];
    const now = (Date.now() & 0xffffffff) >>> 0;

    // Flush ACKs
    for (const ack of this.ackList) {
      const seg = new Segment();
      seg.conv = this.conv;
      seg.cmd = KCP_CMD_ACK;
      seg.sn = ack.sn;
      seg.ts = ack.ts;
      seg.una = this.rcvNxt;
      seg.wnd = this.rcvWnd;
      output.push(seg.encode());
    }
    this.ackList = [];

    // Flush send queue
    while (this.sndQueue.length > 0) {
      const seg = this.sndQueue.shift();
      seg.ts = now;
      seg.wnd = this.rcvWnd;
      seg.una = this.rcvNxt;
      output.push(seg.encode());
      this.sndBuf.push(seg);
    }

    return output;
  }
}

export { KCP_OVERHEAD, Segment };
