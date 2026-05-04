import { DatabaseSync } from 'node:sqlite';
import { getLatestBlock, getBlock, blockStore } from '../core/block.js';
import { serializeBlock } from './messages.js';
import { SqliteTransactionStore } from '../core/stores/SqliteTransactionStore.js';
import {
  validateIncomingBlock,
  type IncomingBlockPayload,
} from './block-validator.js';
import type { PeerManager } from './peer.js';
import type { IConsensusEngine } from '../core/consensus/IConsensusEngine.js';
import type { IValidatorSet } from '../core/consensus/IValidatorSet.js';

const BATCH_SIZE = 100;

export interface SyncState {
  isSyncing: boolean;
  targetHeight: number;
  currentHeight: number;
  syncPeer: string | null;
}

export class ChainSync {
  private db: DatabaseSync;
  private peerManager: PeerManager;
  private consensus: IConsensusEngine;
  /**
   * Validator set used for BFT cert checks on incoming blocks. When
   * undefined, ChainSync runs in AuthorityConsensus mode and skips cert
   * verification (parent cert is silently ignored). When set,
   * validateIncomingBlock REQUIRES every block N >= 2 to ship a valid
   * parentCertificate.
   */
  private validatorSet: IValidatorSet | undefined;
  private state: SyncState = {
    isSyncing: false,
    targetHeight: 0,
    currentHeight: 0,
    syncPeer: null,
  };
  /**
   * Live-gossip apply handler — fires on 'block:received' (a freshly-
   * proposed block arriving outside of a sync). In Authority mode this
   * is the same handler as the sync path. In BFT mode this stays null
   * because BftBlockProducer subscribes to 'block:received' directly
   * and handles the block via its stash + onCommit pipeline; persisting
   * here would commit gossip blocks BEFORE consensus had finalized them.
   */
  private onLiveBlockApply: ((block: Record<string, unknown>) => boolean) | null = null;

  /**
   * Sync apply handler — fires on 'blocks:received' (historical blocks
   * arriving in response to a get_blocks request during catch-up sync).
   * In BOTH Authority and BFT modes this should persist: the blocks
   * have already been committed on the chain we're syncing from.
   */
  private onSyncBlockApply: ((block: Record<string, unknown>) => boolean) | null = null;

  constructor(
    db: DatabaseSync,
    peerManager: PeerManager,
    consensus: IConsensusEngine,
    validatorSet?: IValidatorSet,
  ) {
    this.db = db;
    this.peerManager = peerManager;
    this.consensus = consensus;
    this.validatorSet = validatorSet;
    this.setupListeners();
  }

  /**
   * Register a callback that applies a received block to the local chain.
   * Returns true if the block was applied, false if it should be rejected.
   *
   * Sets BOTH the live-gossip and sync handlers — this is the
   * back-compat one-handler-fits-both signature used by Authority-mode
   * code and existing tests. BFT-mode callers should use
   * setSyncBlockApplyHandler instead so live gossip stays out of the
   * persistence path (BftBlockProducer handles those via its stash).
   *
   * NOTE: validateIncomingBlock has ALREADY run before this is called,
   * so the handler can trust the block is structurally and
   * authoritatively valid.
   */
  setBlockApplyHandler(handler: (block: Record<string, unknown>) => boolean): void {
    this.onLiveBlockApply = handler;
    this.onSyncBlockApply = handler;
  }

  /**
   * Set ONLY the sync-path handler. Use this in BFT mode: catch-up
   * sync persists historical blocks here, while live gossip is owned
   * by BftBlockProducer (which subscribes to 'block:received' directly).
   */
  setSyncBlockApplyHandler(handler: (block: Record<string, unknown>) => boolean): void {
    this.onSyncBlockApply = handler;
  }

  /**
   * Set ONLY the live-gossip handler. Rarely useful directly; provided
   * for symmetry.
   */
  setLiveBlockApplyHandler(handler: (block: Record<string, unknown>) => boolean): void {
    this.onLiveBlockApply = handler;
  }

  getState(): SyncState {
    return { ...this.state };
  }

  /** Check connected peers and start syncing from the one with the highest block height */
  startSync(): void {
    if (this.state.isSyncing) return;

    const peers = this.peerManager.getConnectedPeers();
    if (peers.length === 0) return;

    const localHeight = getLatestBlock(this.db)?.number ?? 0;

    // Find peer with highest block height
    let bestPeer = peers[0];
    for (const p of peers) {
      if (p.blockHeight > bestPeer.blockHeight) bestPeer = p;
    }

    if (bestPeer.blockHeight <= localHeight) return; // already caught up

    this.state = {
      isSyncing: true,
      targetHeight: bestPeer.blockHeight,
      currentHeight: localHeight,
      syncPeer: bestPeer.id,
    };

    this.requestNextBatch();
  }

  private requestNextBatch(): void {
    if (!this.state.syncPeer) return;

    const fromHeight = this.state.currentHeight + 1;
    const toHeight = Math.min(fromHeight + BATCH_SIZE - 1, this.state.targetHeight);

    this.peerManager.sendTo(this.state.syncPeer, 'get_blocks', {
      fromHeight,
      toHeight,
    });
  }

  private setupListeners(): void {
    // ── Catch-up sync: a batch of historical blocks arrives in response
    //    to our get_blocks request. Validate each one against our local
    //    chain before applying. As of Session 10, sync replies ship the
    //    full txIds for each historical block (fetched from the
    //    tx-to-block linkage), so the merkle re-derivation runs the same
    //    way it does for live gossip.
    this.peerManager.on(
      'blocks:received',
      (data: unknown, senderId: string, senderPublicKey: string) => {
        if (!this.state.isSyncing) return;
        if (senderId !== this.state.syncPeer) return;

        const blocks = data as Array<IncomingBlockPayload>;
        if (!Array.isArray(blocks) || blocks.length === 0) {
          this.finishSync();
          return;
        }

        for (const blockData of blocks) {
          const result = validateIncomingBlock(
            this.db,
            this.consensus,
            blockData,
            senderId,
            senderPublicKey,
            {
              bftValidatorSet: this.validatorSet,
              // Catch-up sync ships historical certs whose precommits are
              // older than the per-vote replay window — skip the timestamp
              // check on the inner votes, the outer checks (height, hash,
              // quorum, signatures) still all run.
              skipCertTimestampWindow: true,
              // Same reasoning for the block-timestamp drift check
              // (Session 44): historical blocks have legitimately old
              // timestamps. Live gossip below leaves this enforced.
              skipBlockTimestampWindow: true,
            },
          );
          if (!result.valid) {
            // Bad block from sync peer — abort and ban them. Their key
            // signed something invalid; we shouldn't trust them again.
            this.peerManager.banPeer(senderPublicKey, `bad sync block: ${result.error ?? 'unknown'}`);
            this.finishSync();
            return;
          }

          if (this.onSyncBlockApply) {
            const ok = this.onSyncBlockApply(blockData as unknown as Record<string, unknown>);
            if (!ok) {
              this.finishSync();
              return;
            }
          }
          this.state.currentHeight = blockData.number;
        }

        // Update peer manager's block height
        this.peerManager.setBlockHeight(this.state.currentHeight);

        if (this.state.currentHeight >= this.state.targetHeight) {
          this.finishSync();
        } else {
          this.requestNextBatch();
        }
      },
    );

    // Handle block requests from other peers. Each historical block ships
    // with both its txIds (for merkleRoot re-derivation), its full
    // transaction data (for follower replay), AND its parentCertificate
    // (the cert for block N-1, fetched from local storage). The cert
    // lets a fresh BFT validator verify each block's parent without
    // ever having seen the consensus round that produced it.
    this.peerManager.on('blocks:requested', (data: unknown, ws: unknown) => {
      const req = data as { fromHeight: number; toHeight: number };
      const blocks: Array<Record<string, unknown>> = [];
      const txStore = new SqliteTransactionStore(this.db);
      const bStore = blockStore(this.db);

      const from = Math.max(0, req.fromHeight);
      const to = Math.min(req.toHeight, from + BATCH_SIZE - 1);

      for (let i = from; i <= to; i++) {
        const block = getBlock(this.db, i);
        if (!block) break; // no more blocks
        const serialized = serializeBlock(block as unknown as Record<string, unknown>);
        const txRows = txStore.findTransactionsByBlock(i);
        const txIds = txRows.map((t) => t.id);
        const transactions = txRows.map((t) => ({
          id: t.id,
          from: t.from,
          to: t.to,
          amount: t.amount,
          fee: t.fee,
          netAmount: t.netAmount,
          pointType: t.pointType,
          isInPerson: t.isInPerson,
          memo: t.memo,
          signature: t.signature,
          timestamp: t.timestamp,
        }));
        // Block N's parentCertificate proves block N-1 was finalized.
        // Block 1's parent is genesis (no cert) — left undefined so
        // validateIncomingBlock skips the parent-cert check.
        const parentCertificate =
          i >= 2 ? (bStore.findCommitCertificate(i - 1) ?? undefined) : undefined;
        // The validator-set snapshot from block N-1 — what signed the
        // cert. Without this, slashed validators' old signatures fail
        // to verify because their entries are inactive in the current set.
        const parentValidatorSnapshot =
          i >= 2 ? (bStore.findValidatorSnapshot(i - 1) ?? undefined) : undefined;
        blocks.push({
          ...serialized,
          txIds,
          transactions,
          parentCertificate,
          parentValidatorSnapshot,
        });
      }

      // ws is the raw WebSocket passed through from peer.ts
      this.peerManager.sendToWs(ws as any, 'blocks', blocks);
    });

    // ── Live gossip: a freshly produced block arrives outside of sync.
    //    The producer's broadcastBlock() ships txIds in the payload, so
    //    we get the strong merkle re-derivation here.
    this.peerManager.on(
      'block:received',
      (data: unknown, senderId: string, senderPublicKey: string) => {
        if (this.state.isSyncing) return; // ignore gossip during sync

        const blockData = data as IncomingBlockPayload;
        const result = validateIncomingBlock(
          this.db,
          this.consensus,
          blockData,
          senderId,
          senderPublicKey,
          { bftValidatorSet: this.validatorSet },
        );
        if (!result.valid) {
          // Live gossip from a non-authority or with mangled bytes. Ban.
          this.peerManager.banPeer(
            senderPublicKey,
            `bad gossip block: ${result.error ?? 'unknown'}`,
          );
          return;
        }

        if (this.onLiveBlockApply) {
          const ok = this.onLiveBlockApply(blockData as unknown as Record<string, unknown>);
          if (ok) {
            this.peerManager.setBlockHeight(blockData.number);
          }
        }
      },
    );
  }

  private finishSync(): void {
    this.state.isSyncing = false;
    this.state.syncPeer = null;
  }
}
