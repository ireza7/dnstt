/**
 * TurboTunnel - session management for DNS tunnel
 * Ported from dnstt Go implementation
 *
 * Adapted for Cloudflare Worker's stateless request/response model.
 * Uses a global Map (within worker isolate) for session persistence.
 */

export const QUEUE_SIZE = 128;

/**
 * ClientID - 8-byte identifier for tunnel sessions
 */
export class ClientID {
  constructor(bytes) {
    if (bytes instanceof Uint8Array && bytes.length === 8) {
      this.bytes = bytes;
    } else {
      this.bytes = new Uint8Array(8);
      crypto.getRandomValues(this.bytes);
    }
  }

  toString() {
    return Array.from(this.bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  equals(other) {
    if (!other || !other.bytes) return false;
    for (let i = 0; i < 8; i++) {
      if (this.bytes[i] !== other.bytes[i]) return false;
    }
    return true;
  }

  static fromBytes(buf) {
    if (buf.length < 8) return null;
    return new ClientID(buf.subarray(0, 8));
  }
}

/**
 * Session represents a single client tunnel session
 * In the Worker context, this holds queued data for the client
 */
export class Session {
  constructor(clientID) {
    this.clientID = clientID;
    this.lastSeen = Date.now();
    this.incomingQueue = []; // Packets from client (upstream bound)
    this.outgoingQueue = []; // Packets to client (downstream bound)
    this.stash = null;       // Single stashed packet
    this.noiseState = null;  // Will hold NoiseSocket after handshake
    this.handshakeComplete = false;
    this.kcpState = null;    // KCP session state
  }

  touch() {
    this.lastSeen = Date.now();
  }

  isExpired(timeoutMs = 120000) {
    return Date.now() - this.lastSeen > timeoutMs;
  }

  /**
   * Queue an incoming packet (from DNS query, going upstream)
   */
  queueIncoming(packet) {
    if (this.incomingQueue.length < QUEUE_SIZE) {
      this.incomingQueue.push(packet);
    }
    // Drop if queue is full
  }

  /**
   * Dequeue an incoming packet
   */
  dequeueIncoming() {
    return this.incomingQueue.shift() || null;
  }

  /**
   * Queue an outgoing packet (for DNS response, going downstream)
   */
  queueOutgoing(packet) {
    if (this.outgoingQueue.length < QUEUE_SIZE) {
      this.outgoingQueue.push(packet);
    }
  }

  /**
   * Get all available outgoing packets up to a size limit
   */
  getOutgoingPackets(maxEncodedPayload) {
    const packets = [];
    let totalSize = 0;

    // Check stash first
    if (this.stash !== null) {
      const pktSize = 2 + this.stash.length;
      if (totalSize + pktSize <= maxEncodedPayload || packets.length === 0) {
        packets.push(this.stash);
        totalSize += pktSize;
        this.stash = null;
      }
    }

    // Then outgoing queue
    while (this.outgoingQueue.length > 0) {
      const pkt = this.outgoingQueue[0];
      const pktSize = 2 + pkt.length;
      if (packets.length > 0 && totalSize + pktSize > maxEncodedPayload) {
        break;
      }
      this.outgoingQueue.shift();
      packets.push(pkt);
      totalSize += pktSize;
    }

    return packets;
  }
}

/**
 * SessionManager manages all active tunnel sessions
 * This is a global singleton within the Worker isolate
 */
export class SessionManager {
  constructor(timeoutMs = 120000) {
    this.sessions = new Map();
    this.timeoutMs = timeoutMs;
  }

  /**
   * Get or create a session for the given ClientID
   */
  getOrCreate(clientID) {
    const key = clientID.toString();
    let session = this.sessions.get(key);
    if (!session) {
      session = new Session(clientID);
      this.sessions.set(key, session);
    }
    session.touch();
    return session;
  }

  /**
   * Get an existing session
   */
  get(clientID) {
    const key = clientID.toString();
    const session = this.sessions.get(key);
    if (session) session.touch();
    return session || null;
  }

  /**
   * Remove expired sessions
   */
  cleanup() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.isExpired(this.timeoutMs)) {
        this.sessions.delete(key);
      }
    }
  }

  /**
   * Get session count
   */
  get size() {
    return this.sessions.size;
  }
}
