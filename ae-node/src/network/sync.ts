import { DatabaseSync } from 'node:sqlite';
import { getLatestBlock, getBlock, blockStore } from '../core/block.js';
import { serializeBlock } from './messages.js';
import { SqliteTransactionStore } from '../core/stores/SqliteTransactionStore.js';
import {
  validateIncomingBlock,
  type IncomingBlockPayload,
} from './block-validator.js';
import type { WebSocket } from 'ws';
import type { PeerManager } from './peer.js';
import type { IConsensusEngine } from '../core/consensus/IConsensusEngine.js';
import type { IValidatorSet } from '../core/consensus/IValidatorSet.js';

/**
 * Is this validation failure a transient ordering race rather than misbehaviour?
 *
 * Two honest nodes on a live chain constantly disagree by a block or two: the
 * height is checked before validation runs, and the chain can advance in
 * between. The peer that answers a moment late is not dishonest, and banning
 * them permanently partitions the network — the ban list is memory-only with no
 * expiry, so it outlives the race by hours.
 *
 * Kept as a narrow allowlist matched on the validator's own message text. Only
 * height and parent-linkage failures qualify; anything cryptographic (hash,
 * signature, certificate, merkle root) falls through and still bans, because
 * those cannot happen by accident.
 */
export function isOrderingFailure(error?: string): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes('height gap') ||
    e.includes('previous hash mismatch') ||
    e.includes('previous block') ||
    e.includes('already') ||
    e.includes('parent')
  );
}

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

  // ── Stall watchdog ──────────────────────────────────────────────────
  // A get_blocks request that never gets answered (dropped message, a peer
  // that went away mid-batch) would otherwise leave isSyncing=true forever,
  // and since startSync() early-returns while syncing the follower wedges
  // until it reconnects. The watchdog re-requests the outstanding batch a few
  // times, then gives up and frees isSyncing so the next periodic startSync
  // can retry — possibly against a different, healthier peer.
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchRetries = 0;
  private readonly batchTimeoutMs: number;
  private readonly maxBatchRetries: number;

  constructor(
    db: DatabaseSync,
    peerManager: PeerManager,
    consensus: IConsensusEngine,
    validatorSet?: IValidatorSet,
    options?: { batchTimeoutMs?: number; maxBatchRetries?: number },
  ) {
    this.db = db;
    this.peerManager = peerManager;
    this.consensus = consensus;
    this.validatorSet = validatorSet;
    this.batchTimeoutMs = options?.batchTimeoutMs ?? 8000;
    this.maxBatchRetries = options?.maxBatchRetries ?? 3;
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
    this.batchRetries = 0;

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
    // Arm the watchdog for THIS request. If no batch advances us past
    // fromHeight before it fires, we re-request (or give up).
    this.armBatchTimeout(fromHeight);
  }

  private armBatchTimeout(expectedFromHeight: number): void {
    this.clearBatchTimeout();
    this.batchTimer = setTimeout(() => this.onBatchTimeout(expectedFromHeight), this.batchTimeoutMs);
    // The watchdog must never keep a node's event loop alive on its own.
    this.batchTimer.unref?.();
  }

  private clearBatchTimeout(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private onBatchTimeout(expectedFromHeight: number): void {
    if (!this.state.isSyncing) return;
    // If the next needed height moved, a reply already landed and re-armed;
    // this is a stale timer, ignore it.
    if (this.state.currentHeight + 1 !== expectedFromHeight) return;

    if (this.batchRetries < this.maxBatchRetries) {
      this.batchRetries++;
      this.requestNextBatch(); // re-request the same, unanswered batch
    } else {
      // Give up on this peer. Freeing isSyncing lets the next periodic
      // startSync pick a fresh best peer and try again.
      this.finishSync();
    }
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

        // A reply landed for the outstanding request — cancel the watchdog.
        this.clearBatchTimeout();

        const blocks = data as Array<IncomingBlockPayload>;
        if (!Array.isArray(blocks) || blocks.length === 0) {
          this.finishSync();
          return;
        }

        for (const blockData of blocks) {
          // A retried request can bring back blocks we already applied on a
          // previous (late) reply. Skip them: validating a stale block against
          // our now-advanced head would fail and wrongly ban an honest peer
          // that simply answered our retry.
          // Compare against the LIVE chain head, not the height captured when
          // this sync began. Gossip keeps committing while a batch is in
          // flight — a healthy two-node chain can advance seven blocks in under
          // a second — so `this.state.currentHeight` goes stale inside this very
          // loop. A block we already hold then slips past this guard, fails
          // validation with "Height gap: expected N+1, got N", and the peer is
          // banned for answering a question we had already answered ourselves.
          const liveHead = getLatestBlock(this.db)?.number ?? this.state.currentHeight;
          if (blockData.number <= liveHead) continue;

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
            // Only ban for failures that mean the peer is actually dishonest.
            //
            // A height or ordering mismatch means the two of us are momentarily
            // out of step. That is routine on a live chain and says nothing
            // about their honesty. Banning on it partitions the network over a
            // transient race, and the ban outlives its cause because the list
            // is memory-only with no expiry — the peer is healthy again seconds
            // later but stays locked out until somebody restarts the node.
            //
            // Cryptographic failures are different: a bad hash, signature or
            // certificate cannot happen by accident.
            if (isOrderingFailure(result.error)) {
              this.finishSync();
              return;
            }
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

        // Progress made — reset the retry budget for the next batch.
        this.batchRetries = 0;

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
          // recipientIsHuman and receiverSignature are part of the SIGNED
          // payload (core/transaction.ts:440-463) and, for in-person txs, are
          // what the countersignature check needs. Omitting them here made a
          // syncing node default them to false/null (runner.ts sync path uses
          // `?? false` / `?? null`), so the replayed tx no longer matched its
          // own signature or reproduced the merkle root, and the node wedged on
          // the first block carrying such a tx. The live-gossip path
          // (txRowToWire) already ships both.
          recipientIsHuman: t.recipientIsHuman,
          receiverSignature: t.receiverSignature,
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
        // bigint stake → string for JSON serialization, mirroring
        // BftBlockProducer's live-gossip path. The receiver's
        // validateIncomingBlock parses stake back to bigint via
        // SnapshotValidatorSet. Without this, JSON.stringify throws
        // "Do not know how to serialize a BigInt" the moment a sync reply
        // includes any block N >= 2 (every one of which carries a snapshot),
        // which silently broke catch-up sync for a restarted validator.
        const parentValidatorSnapshotRaw =
          i >= 2 ? (bStore.findValidatorSnapshot(i - 1) ?? undefined) : undefined;
        const parentValidatorSnapshot = parentValidatorSnapshotRaw
          ? parentValidatorSnapshotRaw.map((v) => ({
              ...v,
              stake: v.stake.toString() as unknown as bigint,
            }))
          : undefined;
        blocks.push({
          ...serialized,
          txIds,
          transactions,
          parentCertificate,
          parentValidatorSnapshot,
        });
      }

      // ws is the raw WebSocket passed through from peer.ts
      this.peerManager.sendToWs(ws as WebSocket, 'blocks', blocks);
    });

    // ── Live gossip: a freshly produced block arrives outside of sync.
    //    The producer's broadcastBlock() ships txIds in the payload, so
    //    we get the strong merkle re-derivation here.
    this.peerManager.on(
      'block:received',
      (data: unknown, senderId: string, senderPublicKey: string) => {
        if (this.state.isSyncing) return; // ignore gossip during sync

        const blockData = data as IncomingBlockPayload;

        // Learn the sender's height from the block it just gossiped, so
        // catch-up sync can detect a peer that advanced after our one-time
        // handshake height went stale. Do this even when we ignore the block
        // below for being ahead — that's exactly the case that needs it.
        this.peerManager.recordPeerHeight(senderId, senderPublicKey, blockData.number);

        // Height triage BEFORE validation. A gossip block ahead of our head
        // does NOT mean the sender misbehaved — it means WE are behind
        // (missed blocks during a restart or partition). Banning here would
        // isolate a recovering node from the very peers it needs to catch up
        // from, which is exactly the bug that made restart-resync impossible.
        // Let the periodic catch-up sync pull the gap instead. Only a block
        // at exactly our next height is a live-apply candidate; older or
        // duplicate blocks are ignored.
        const localHeight = getLatestBlock(this.db)?.number ?? 0;
        if (blockData.number > localHeight + 1) return; // behind — sync will catch up
        if (blockData.number <= localHeight) return; // old or duplicate

        const result = validateIncomingBlock(
          this.db,
          this.consensus,
          blockData,
          senderId,
          senderPublicKey,
          { bftValidatorSet: this.validatorSet },
        );
        if (!result.valid) {
          // A next-height block that fails on signature, hash or cert is
          // genuinely bad and IS a ban. An ordering failure is not: the two
          // height guards above are checked before validation, so the chain can
          // still advance underneath us in between, and punishing that race
          // permanently partitions two honest nodes.
          if (isOrderingFailure(result.error)) return;
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
    this.clearBatchTimeout();
    this.state.isSyncing = false;
    this.state.syncPeer = null;
  }
}
