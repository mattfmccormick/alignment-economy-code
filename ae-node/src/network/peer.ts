import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { randomBytes } from 'node:crypto';
import { createMessage, parseMessage, buildHandshake, verifyHandshake } from './messages.js';
import type { PeerInfo, Handshake, NetworkMessage } from './types.js';
import type { NodeIdentity } from './node-identity.js';
import { logger } from '../node/logger.js';

const HANDSHAKE_REPLAY_WINDOW_SEC = 300; // 5 minutes

/**
 * Strip the IPv4-mapped IPv6 prefix Node reports for IPv4 sockets.
 *
 * A dual-stack listener hands back `::ffff:127.0.0.1` rather than `127.0.0.1`.
 * Left as-is it is neither a usable IPv4 literal nor a legal URL host (IPv6
 * literals need brackets), so `ws://::ffff:127.0.0.1:9302` throws Invalid URL.
 * Unwrapping to the plain IPv4 form is both correct and what an operator
 * expects to see in a log line.
 */
export function normalizeHost(host: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mapped) return mapped[1];
  return host;
}

/** Can this address actually be dialed? Guards the port-0 case above all. */
export function isDialable(host: string, port: number): boolean {
  if (!host) return false;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return true;
}

/**
 * Build a WebSocket URL, bracketing bare IPv6 literals. `ws://::1:9000` is
 * invalid; `ws://[::1]:9000` is not.
 */
export function peerUrl(host: string, port: number): string {
  const h = normalizeHost(host);
  const needsBrackets = h.includes(':') && !h.startsWith('[');
  return `ws://${needsBrackets ? `[${h}]` : h}:${port}`;
}

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
  private seenAccounts = new Set<string>();
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

  /**
   * Update a connected peer's advertised block height from a height-bearing
   * message (e.g. a gossiped block). The handshake captures a peer's height
   * exactly once; without this, a peer that advances after we connect looks
   * frozen at its connect-time height, and catch-up sync can never tell it
   * has moved ahead. publicKey-gated and monotonic so a peer can't spoof
   * another's height or roll one backward.
   */
  recordPeerHeight(senderId: string, publicKey: string, height: number): void {
    const peer = this.peers.get(senderId);
    if (peer && peer.info.publicKey === publicKey && height > peer.info.blockHeight) {
      peer.info.blockHeight = height;
      peer.info.lastSeen = Math.floor(Date.now() / 1000);
    }
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
    if (!isDialable(host, port)) {
      // Almost always port 0, which is what an inbound peer's socket reports
      // as its source port. That is an ephemeral client port, not the port the
      // peer listens on, so dialing it can never succeed. Dropping it here
      // stops a dead address from consuming a reconnect slot every interval
      // while real peers go unconnected.
      logger.debug('p2p', `skipping undialable peer address ${host}:${port}`);
      return;
    }

    const url = peerUrl(host, port);

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

      // Track whether the close that follows is from a peer that completed
      // the handshake (peer in this.peers) or from a connection that never
      // got that far. The latter is what we want to surface — it's the only
      // signal an operator gets when seed connections silently fail. close
      // codes 4000-4004 carry the validateHandshake reason; lower codes
      // (1006 abnormal closure) usually mean the dial itself failed.
      ws.on('close', (code, reasonBuf) => {
        let knownPeer = false;
        for (const [id, peer] of this.peers) {
          if (peer.info.host === host && peer.info.port === port) {
            peer.info.status = 'disconnected';
            this.emit('peer:disconnected', peer.info);
            this.peers.delete(id);
            knownPeer = true;
            logger.info('p2p', `peer disconnected ${id.slice(0, 10)}… (${host}:${port}); ${this.peers.size} peer(s) left`);
            break;
          }
        }
        if (!knownPeer) {
          const reason = reasonBuf?.toString() || '(no reason)';
          logger.warn('p2p', `outbound connect to ${host}:${port} closed before handshake (code=${code}, reason=${reason})`);
        }
      });

      ws.on('error', (err) => {
        // The follow-up close handler always fires too. Surface the actual
        // dial error here (ECONNREFUSED, ENOTFOUND, etc.) so operators
        // can tell "wrong port" from "handshake rejected."
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('p2p', `outbound connect error to ${host}:${port}: ${msg}`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('p2p', `outbound connect threw for ${host}:${port}: ${msg}`);
    }
  }

  handleIncomingConnection(ws: WebSocket, remoteAddress: string): void {
    // Port 0 is deliberate and means "we do not know this peer's listen port."
    // The socket's source port is an ephemeral client port, not something any
    // node can dial. isDialable() keeps such entries out of both the dial path
    // and the gossiped peer list; the connection itself works fine either way,
    // since it is already open and bidirectional.
    const host = normalizeHost(remoteAddress);
    ws.on('message', (data) => {
      const msg = parseMessage(data.toString());
      if (msg) this.handleMessage(msg, ws, host, 0);
    });

    ws.on('close', () => {
      for (const [id, peer] of this.peers) {
        if (peer.ws === ws) {
          peer.info.status = 'disconnected';
          this.emit('peer:disconnected', peer.info);
          this.peers.delete(id);
          logger.info('p2p', `peer disconnected ${id.slice(0, 10)}…; ${this.peers.size} peer(s) left`);
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
        const blockHash = (msg.data as { hash: string }).hash;
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
        const txId = (msg.data as { id: string }).id;
        if (!this.markSeenAndAccept(this.seenTx, txId, 5000)) return;
        this.emit('transaction:received', msg.data, msg.senderId);
        this.relayGossip('new_transaction', msg.data, msg.senderId);
        break;
      }
      case 'new_account': {
        // Account registrations must reach every node, because replaying a
        // block throws if the sender or recipient row is missing. Same
        // gossip shape as new_transaction: authenticate, dedupe by id, emit
        // for local application, relay onward. The receiving handler
        // re-derives the id from the public key, so a peer cannot inject a
        // row under an id whose key it does not hold.
        if (!this.isAuthenticatedSender(msg.publicKey, ws)) return;
        const accountId = (msg.data as { id: string }).id;
        if (!this.markSeenAndAccept(this.seenAccounts, accountId, 5000)) return;
        this.emit('account:received', msg.data, msg.senderId);
        this.relayGossip('new_account', msg.data, msg.senderId);
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

    // Close the socket we are about to replace.
    //
    // This map.set silently dropped the previous WebSocket: the entry was
    // overwritten but the old TCP connection stayed ESTABLISHED forever, so
    // every reconnect leaked one. Measured on a real two-machine network — 33
    // live connections between two nodes and still climbing — because discovery
    // redials a peer it cannot tell it is already connected to. An inbound peer
    // is recorded with its ephemeral source port (…:54073), which never matches
    // the configured seed address (…:9000), so maintainConnections' "already
    // connected" check misses every time.
    //
    // Fixing the redial itself needs the handshake to advertise a listen port,
    // which changes the signed bytes. Closing the replaced socket is the half
    // that stops the harm: it caps live connections at one per peer no matter
    // how often we redial.
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4005, 'replaced by newer connection');
      } catch {
        // Already closing or dead. Nothing to do, and it must not stop us
        // registering the new connection.
      }
    }

    const isNew = !this.peers.has(hs.nodeId);
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
    // Log the mesh forming. Before this, whether two nodes had actually
    // connected was invisible, so a network that never peered looked identical
    // to one stuck in consensus.
    if (isNew) {
      logger.info(
        'p2p',
        `peer connected ${hs.nodeId.slice(0, 10)}… (${host}:${port}, height ${hs.blockHeight}); ${this.peers.size} peer(s) total`,
      );
    }
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

  /**
   * Peers we advertise to others during peer exchange.
   *
   * Filtered to dialable addresses. A peer that connected TO us is recorded
   * with port 0 (we know its source port, not its listen port), and gossiping
   * that would hand every other node an address it can only fail to dial —
   * one bad entry propagating across the whole mesh.
   */
  getPeerList(): Array<{ host: string; port: number; nodeId: string; publicKey: string }> {
    return Array.from(this.peers.values())
      .filter((p) => p.info.status === 'connected' && isDialable(p.info.host, p.info.port))
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
