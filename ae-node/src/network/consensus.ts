// AuthorityConsensus — the Phase 1 consensus engine.
//
// Exactly one node (the "authority") is allowed to produce blocks. Every
// other node is a follower that copies the authority's chain. Conflict
// resolution always favors the authority. Every block is instantly final
// the moment the authority signs it.
//
// This is the Phase 1 / Phase 2 consensus. Phase 3 will introduce
// BFTConsensus (multi-validator, 2/3+ quorum). Both implement
// IConsensusEngine, so swapping at the runtime level requires no changes
// in the runner, sync, or API layers.

import type { IConsensusEngine } from '../core/consensus/IConsensusEngine.js';

export class AuthorityConsensus implements IConsensusEngine {
  private authorityNodeId: string;
  private localNodeId: string;
  private latestHeight: number;
  /**
   * The hex Ed25519 public key of the authority's node-identity. When set,
   * validateBlockProducer requires the publicKey on an incoming block's
   * transport envelope to match — preventing nodeId-string spoofing. When
   * undefined (legacy / test setups that boot without configuring it),
   * validation falls back to the nodeId-only check.
   */
  private authorityPublicKey: string | undefined;

  constructor(
    authorityNodeId: string,
    localNodeId: string,
    latestHeight: number = 0,
    authorityPublicKey?: string,
  ) {
    this.authorityNodeId = authorityNodeId;
    this.localNodeId = localNodeId;
    this.latestHeight = latestHeight;
    this.authorityPublicKey = authorityPublicKey;
  }

  canProduceBlock(): boolean {
    return this.localNodeId === this.authorityNodeId;
  }

  validateBlockProducer(blockProducerId: string, producerPublicKey?: string): boolean {
    if (blockProducerId !== this.authorityNodeId) return false;
    // If we know the authority's publicKey, the caller MUST supply a matching one.
    if (this.authorityPublicKey !== undefined) {
      if (!producerPublicKey) return false;
      if (producerPublicKey !== this.authorityPublicKey) return false;
    }
    return true;
  }

  /**
   * Late-bind the authority's publicKey. Called by AENode once it knows its
   * own keypair (when this node IS the authority) or by the runner when
   * follower configuration provides the expected key.
   */
  setAuthorityPublicKey(publicKey: string): void {
    this.authorityPublicKey = publicKey;
  }

  getAuthorityPublicKey(): string | undefined {
    return this.authorityPublicKey;
  }

  resolveConflict(heightA: number, heightB: number): 'A' | 'B' {
    // Authority chain always wins; if same height, pick A (authority).
    return heightA >= heightB ? 'A' : 'B';
  }

  finalizedHeight(): number {
    // Authority signs every block; finality is instant.
    return this.latestHeight;
  }

  validatorSet(): string[] {
    return [this.authorityNodeId];
  }

  quorumSize(): number {
    return 1;
  }

  getAuthorityId(): string {
    return this.authorityNodeId;
  }

  isAuthority(): boolean {
    return this.canProduceBlock();
  }

  /** Called by the runner each time a new block is committed locally. */
  notifyHeightAdvanced(newHeight: number): void {
    if (newHeight > this.latestHeight) this.latestHeight = newHeight;
  }
}
