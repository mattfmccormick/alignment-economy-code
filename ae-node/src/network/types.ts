export interface PeerInfo {
  /** Friendly nodeId string the peer claims (UI label). */
  id: string;
  /** Hex Ed25519 public key. The cryptographic identity — this is what we
   *  ban-list, what verifies signed messages, and what survives node restarts. */
  publicKey: string;
  host: string;
  port: number;
  lastSeen: number;
  status: 'connecting' | 'connected' | 'disconnected';
  blockHeight: number;
  version: string;
}

export interface Handshake {
  nodeId: string;
  /** Hex Ed25519 public key claimed by the connecting node. */
  publicKey: string;
  version: string;
  blockHeight: number;
  /**
   * Human-readable network identifier (e.g. "ae-mainnet-1"). The genesisHash
   * mismatch already catches network-incompatible peers cryptographically —
   * this field exists so the rejection log line can say "you're on testnet,
   * I'm on mainnet" instead of "0xabc != 0xdef". Folded into the canonical
   * signed bytes so it can't be tampered with mid-transit.
   */
  networkId: string;
  genesisHash: string;
  /** Unix seconds when this handshake was minted. Replay window = 5 minutes. */
  timestamp: number;
  /** Random hex nonce. Combined with timestamp prevents replay within the window. */
  nonce: string;
  /** Ed25519 signature over the canonical handshake payload. */
  signature: string;
}

export type MessageType =
  | 'handshake'
  | 'handshake_ack'
  | 'get_peers'
  | 'peers'
  | 'new_block'
  | 'new_transaction'
  | 'get_blocks'
  | 'blocks'
  | 'ping'
  | 'pong'
  // ── Phase-3 BFT consensus messages (Session 21+) ─────────────────
  // Each message's payload carries its own inner signature (signed by
  // the proposer / validator's Ed25519 key); the transport envelope's
  // signature (Session 8) authenticates the sender at the gossip
  // layer. Both signatures use distinct canonical-bytes domains so
  // they can't be cross-confused.
  | 'proposal'
  | 'prevote'
  | 'precommit';

export interface NetworkMessage {
  type: MessageType;
  data: unknown;
  senderId: string;
  /** Hex Ed25519 public key of the signer. Allows verification without prior peer state. */
  publicKey: string;
  timestamp: number;
  /** Ed25519 signature over the canonical message payload. */
  signature: string;
}

// IConsensusEngine moved to src/core/consensus/IConsensusEngine.ts.
// Re-exported for compatibility with any external code that imports from here.
export type { IConsensusEngine } from '../core/consensus/IConsensusEngine.js';
