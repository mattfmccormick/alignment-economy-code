import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { randomBytes } from 'node:crypto';
import { createMessage, parseMessage, buildHandshake, verifyHandshake } from './messages.js';
import type { PeerInfo, Handshake, NetworkMessage } from './types.js';
import type { NodeIdentity } from './node-identity.js';

const HANDSHAKE_REPLAY_WINDOW_SEC = 300; // 5 minutes

/**
 * Stable dedup key for a Proposal payload arriving over the wire.
 * (kind, height, round, proposer) uniquely identifies a proposer's slot.
 * Two proposals with the same key but different signed contents is
 * provable proposer-equivocation — slashable, but detected at the BFT
 * layer (RoundController), not here. peer.ts only needs the key for
 * gossip-loop suppression.
 */
function proposalDedupKey(data: unknown): string {
  const p = data as Partial<{
    height: number;
    round: number;
    proposerAccountId: string;
    blockHash: string;
  }>;
  // Include blockHash so two distinct proposals from the same proposer
  // (the equivocation case) both reach BFT layer rather than being
  // deduped here as a single entry.
  return `proposal:${p.height ?? '?'}:${p.round ?? '?'}:${p.proposerAccountId ?? '?'}:${p.blockHash ?? '?'}`;
}

/**
 * Dedup key for a Vote payload (prevote or precommit).
 * (kind, height, round, validator, blockHash) — including blockHash so
 * a double-voting validator's two distinct votes don't collapse into
 * one entry at the gossip layer.
 */
function voteDedupKey(data: unknown): string {
  const v = data as Partial<{
    kind: string;
    height: number;
    round: number;
    validatorAccountId: string;
    blockHash: string | null;
  }>;
  return `${v.kind ?? '?'}:${v.height ?? '?'}:${v.round ?? '?'}:${v.validatorAccountId ?? '?'}:${v.blockHash ?? '<nil>'}`;
}

export class PeerManager extends EventEmitter {
  private peers = new Map<string, { info: PeerInfo; ws: WebSocket }>();
  // Dedup sets for gossip relay. Each entry remembers a message we've
  // already received + relayed once, so we don't loop the network.
  // LRU eviction at the cap keeps memory bounded over long uptime.
  private seenBlocks = new Set<string>();
  private seenTx = new Set<string>();
  private seenProposals = new Set<string>();
  private seenVotes = new Set<string>();
  private maxPeers: number;
  private nodeId: string;
  private version: string;
  private blockHeight: number;
  private genesisHash: string;
  private networkId: string;
  private identity: NodeIdentity;
  /** Banned peer publicKeys (hex). Survives node restarts only if persisted by the caller. */
  private bannedKeys = new Set<string>();

  constructor(
    identity: NodeIdentity,
    nodeId: string,
    genesisHash: string,
    /**
     * Human-readable network identifier matching this node's genesis spec.
     * Defaults to 'ae-test' for unit tests that don't care about networkId
     * mismatch. Production callers (the runner) MUST pass the real value
     * from the loaded GenesisSpec or peers will reject each other with the
     * "you're on testnet" message.
     */
    networkId: string = 'ae-test',
    maxPeers: number = 20,
  ) {
    super();
    this.identity = identity;
    this.nodeId = nodeId;
    this.version = '0.1.0';
    this.blockHeight = 0;
    this.genesisHash = genesisHash;
    this.networkId = networkId;
    this.maxPeers = maxPeers;
  }

  setBlockHeight(height: number): void {
    this.blockHeight = height;
  }

  getBlockHeight(): number {
    return this.blockHeight;
  }

  /** Ban a peer by their long-lived public key. The friendly nodeId is spoofable; the public key is not. */
  banPeer(publicKey: string, reason?: string): void {
    this.bannedKeys.add(publicKey);
    // Disconnect any open connection from this key.
    for (const [id, peer] of this.peers) {
      if (peer.info.publicKey === publicKey) {
        peer.ws.close(4002, reason ?? 'banned');
        peer.info.status = 'disconnected';
        this.peers.delete(id);
      }
    }
    this.emit('peer:banned', { publicKey, reason });
  }

  isBanned(publicKey: string): boolean {
    return this.bannedKeys.has(publicKey);
  }

  /** Test/admin helper: clear the ban list. */
  clearBanList(): void {
    this.bannedKeys.clear();
  }

  getBannedKeys(): string[] {
    return Array.from(this.bannedKeys);
  }

  connectToPeer(host: string, port: number): void {
    const url = `ws://${host}:${port}`;

    try {
      const ws = new WebSocket(url);

      ws.on('open', () => {
        const handshake = buildHandshake(this.identity, {
          nodeId: this.nodeId,
          version: this.version,
          blockHeight: this.blockHeight,
          networkId: this.networkId,
          genesisHash: this.genesisHash,
          nonce: randomBytes(16).toString('hex'),
        });
        ws.send(createMessage('handshake', handshake, this.nodeId, this.identity));
      });

      ws.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg) this.handleMessage(msg, ws, host, port);
      });

      ws.on('close', () => {
        for (const [id, peer] of this.peers) {
          if (peer.info.host === host && peer.info.port === port) {
            peer.info.status = 'disconnected';
            this.emit('peer:disconnected', peer.info);
            this.peers.delete(id);
            break;
          }
        }
      });

      ws.on('error', () => {
        // Connection failed; close handler will run.
      });
    } catch {
      // ignore connection errors
    }
  }

  handleIncomingConnection(ws: WebSocket, remoteAddress: string): void {
    ws.on('message', (data) => {
      const msg = parseMessage(data.toString());
      if (msg) this.handleMessage(msg, ws, remoteAddress, 0);
    });

    ws.on('close', () => {
      for (const [id, peer] of this.peers) {
        if (peer.ws === ws) {
          peer.info.status = 'disconnected';
          this.emit('peer:disconnected', peer.info);
          this.peers.delete(id);
          break;
        }
      }
    });
  }

  private handleMessage(msg: NetworkMessage, ws: WebSocket, host: string, port: number): void {
    // parseMessage already verified the embedded signature; reject banned senders here.
    if (this.bannedKeys.has(msg.publicKey)) {
      ws.close(4002, 'banned');
      return;
    }

    switch (msg.type) {
      case 'handshake': {
        const hs = msg.data as Handshake;
        if (!this.validateHandshake(hs, msg.publicKey, ws)) return;

        this.addPeer(hs, host, port, ws);

        const ackHs = buildHandshake(this.identity, {
          nodeId: this.nodeId,
          version: this.version,
          blockHeight: this.blockHeight,
          networkId: this.networkId,
          genesisHash: this.genesisHash,
          nonce: randomBytes(16).toString('hex'),
        });
        ws.send(createMessage('handshake_ack', ackHs, this.nodeId, this.identity));
        this.emit('peer:connected', this.peers.get(hs.nodeId)?.info);
        break;
      }
      case 'handshake_ack': {
        const hs = msg.data as Handshake;
        if (!this.validateHandshake(hs, msg.publicKey, ws)) return;
        this.addPeer(hs, host, port, ws);
        this.emit('peer:connected', this.peers.get(hs.nodeId)?.info);
        break;
      }
      case 'get_peers': {
        const peerList = this.getPeerList();
        ws.send(createMessage('peers', peerList, this.nodeId, this.identity));
        break;
      }
      case 'peers': {
        const peerList = msg.data as Array<{ host: string; port: number; nodeId: string }>;
        this.emit('peers:discovered', peerList);
        break;
      }
      case 'new_block': {
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        const blockHash = (msg.data as any).hash;
        if (!this.markSeenAndAccept(this.seenBlocks, blockHash, 1000)) return;
        // The third arg (publicKey) lets validators bind producer identity to
        // the cryptographic key, not just the spoofable senderId string.
        this.emit('block:received', msg.data, msg.senderId, msg.publicKey);
        // Gossip relay: re-wrap the payload in a fresh envelope (signed by
        // us) and forward to peers other than the immediate sender. Inner
        // signatures (block hash, parent cert) survive unchanged.
        this.relayGossip('new_block', msg.data, msg.senderId);
        break;
      }
      case 'new_transaction': {
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        const txId = (msg.data as any).id;
        if (!this.markSeenAndAccept(this.seenTx, txId, 5000)) return;
        this.emit('transaction:received', msg.data, msg.senderId);
        this.relayGossip('new_transaction', msg.data, msg.senderId);
        break;
      }
      case 'get_blocks': {
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        // Request/response — never gossip-relayed.
        this.emit('blocks:requested', msg.data, ws);
        break;
      }
      case 'blocks': {
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        // Response to a get_blocks — point-to-point, never relayed.
        this.emit('blocks:received', msg.data, msg.senderId, msg.publicKey);
        break;
      }
      case 'proposal': {
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        // The proposal payload is itself an inner-signed Proposal object;
        // BFT-layer code (RoundController) re-verifies the inner signature.
        // peer.ts only authenticates the gossip-layer sender.
        const propId = proposalDedupKey(msg.data);
        if (!this.markSeenAndAccept(this.seenProposals, propId, 1000)) return;
        this.emit('proposal:received', msg.data, msg.senderId, msg.publicKey);
        this.relayGossip('proposal', msg.data, msg.senderId);
        break;
      }
      case 'prevote': {
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        const id = voteDedupKey(msg.data);
        if (!this.markSeenAndAccept(this.seenVotes, id, 5000)) return;
        this.emit('prevote:received', msg.data, msg.senderId, msg.publicKey);
        this.relayGossip('prevote', msg.data, msg.senderId);
        break;
      }
      case 'precommit': {
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        const id = voteDedupKey(msg.data);
        if (!this.markSeenAndAccept(this.seenVotes, id, 5000)) return;
        this.emit('precommit:received', msg.data, msg.senderId, msg.publicKey);
        this.relayGossip('precommit', msg.data, msg.senderId);
        break;
      }
      case 'ping': {
        ws.send(createMessage('pong', null, this.nodeId, this.identity));
        break;
      }
      case 'pong': {
        const peer = this.peers.get(msg.senderId);
        if (peer && peer.info.publicKey === msg.publicKey) {
          peer.info.lastSeen = Math.floor(Date.now() / 1000);
        }
        break;
      }
    }
  }

  /**
   * Defense-in-depth checks for an incoming handshake:
   *   - signature verifies against embedded publicKey
   *   - timestamp is within the replay window
   *   - genesis hash matches ours
   *   - publicKey on the wrapping NetworkMessage matches the publicKey claimed in the Handshake
   *     (prevents a man-in-the-middle from rewrapping someone else's handshake)
   *   - publicKey is not banned
   *   - peer isn't us
   */
  private validateHandshake(hs: Handshake, envelopePublicKey: string, ws: WebSocket): boolean {
    if (!hs || typeof hs !== 'object') {
      ws.close(4000, 'malformed handshake');
      return false;
    }
    if (hs.publicKey !== envelopePublicKey) {
      ws.close(4001, 'handshake publicKey mismatch');
      return false;
    }
    if (hs.publicKey === this.identity.publicKey) {
      ws.close(4003, 'self-connection');
      return false;
    }
    if (this.bannedKeys.has(hs.publicKey)) {
      ws.close(4002, 'banned');
      return false;
    }
    if (!verifyHandshake(hs, { replayWindowSec: HANDSHAKE_REPLAY_WINDOW_SEC })) {
      ws.close(4001, 'invalid handshake signature or stale timestamp');
      return false;
    }
    // networkId mismatch check is checked BEFORE genesisHash because the
    // human-readable error message ("you're on testnet, I'm on mainnet") is
    // far more useful than "genesis hash 0xabc != 0xdef" when an operator
    // has misconfigured. Both must match — a mismatched networkId would
    // also produce a mismatched genesisHash, but the friendly error first.
    if (hs.networkId !== this.networkId) {
      ws.close(
        4001,
        `network mismatch: peer is on "${hs.networkId}", we are on "${this.networkId}"`,
      );
      return false;
    }
    if (hs.genesisHash !== this.genesisHash) {
      ws.close(4001, 'genesis hash mismatch');
      return false;
    }
    return true;
  }

  /**
   * For non-handshake messages, confirm the sender's publicKey matches a peer
   * we've already shaken hands with on this WebSocket. This prevents a peer
   * from impersonating someone else after the handshake.
   */
  private isAuthenticatedSender(publicKey: string, ws: WebSocket): boolean {
    for (const peer of this.peers.values()) {
      if (peer.ws === ws) {
        return peer.info.publicKey === publicKey;
      }
    }
    return false;
  }

  private addPeer(hs: Handshake, host: string, port: number, ws: WebSocket): void {
    if (hs.publicKey === this.identity.publicKey) return; // don't add self

    // If a different connection already claims this nodeId with a different
    // publicKey, prefer the existing one (first-claim wins for a given nodeId
    // string within a session). The publicKey is the durable identity.
    const existing = this.peers.get(hs.nodeId);
    if (existing && existing.info.publicKey !== hs.publicKey) {
      ws.close(4004, 'nodeId already claimed by different key');
      return;
    }

    if (this.peers.size >= this.maxPeers && !this.peers.has(hs.nodeId)) return;

    this.peers.set(hs.nodeId, {
      info: {
        id: hs.nodeId,
        publicKey: hs.publicKey,
        host,
        port,
        lastSeen: Math.floor(Date.now() / 1000),
        status: 'connected',
        blockHeight: hs.blockHeight,
        version: hs.version,
      },
      ws,
    });
  }

  broadcast(type: NetworkMessage['type'], data: unknown, excludeId?: string): void {
    const msg = createMessage(type, data, this.nodeId, this.identity);
    for (const [id, peer] of this.peers) {
      if (id === excludeId) continue;
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(msg);
      }
    }
  }

  /**
   * Dedup helper used by every gossip-relay-eligible message handler.
   * Returns true if the message is new (caller should process + relay),
   * false if we've already seen + relayed it.
   */
  private markSeenAndAccept(
    set: Set<string>,
    key: string | undefined,
    cap: number,
  ): boolean {
    if (typeof key !== 'string' || key.length === 0) return true; // no key = can't dedup, just process
    if (set.has(key)) return false;
    set.add(key);
    if (set.size > cap) {
      const first = set.values().next().value;
      if (first) set.delete(first);
    }
    return true;
  }

  /**
   * Re-broadcast an incoming gossip payload to every peer EXCEPT the
   * one that just sent it. The new envelope is signed under our own
   * key (so the immediate hop is authenticated by US); the inner
   * payload (block hash, vote signature, etc.) keeps its original
   * sender's signature so verifiers downstream can still authenticate
   * the original signer.
   *
   * This is what lets messages traverse a star topology (each node
   * connected to a few seeds) instead of requiring full mesh.
   */
  private relayGossip(
    type: NetworkMessage['type'],
    data: unknown,
    senderId: string,
  ): void {
    this.broadcast(type, data, senderId);
  }

  sendTo(nodeId: string, type: NetworkMessage['type'], data: unknown): void {
    const peer = this.peers.get(nodeId);
    if (peer && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(createMessage(type, data, this.nodeId, this.identity));
    }
  }

  sendToWs(ws: WebSocket, type: NetworkMessage['type'], data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(createMessage(type, data, this.nodeId, this.identity));
    }
  }

  getPeerList(): Array<{ host: string; port: number; nodeId: string; publicKey: string }> {
    return Array.from(this.peers.values())
      .filter((p) => p.info.status === 'connected')
      .map((p) => ({
        host: p.info.host,
        port: p.info.port,
        nodeId: p.info.id,
        publicKey: p.info.publicKey,
      }));
  }

  getConnectedPeers(): PeerInfo[] {
    return Array.from(this.peers.values())
      .filter((p) => p.info.status === 'connected')
      .map((p) => p.info);
  }

  getPeerCount(): number {
    return this.getConnectedPeers().length;
  }

  requestPeers(): void {
    this.broadcast('get_peers', null);
  }

  getNodeId(): string {
    return this.nodeId;
  }

  getPublicKey(): string {
    return this.identity.publicKey;
  }

  disconnectAll(): void {
    for (const [, peer] of this.peers) {
      peer.ws.close();
    }
    this.peers.clear();
  }
}
