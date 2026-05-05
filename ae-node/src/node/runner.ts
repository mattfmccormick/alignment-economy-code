import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initializeSchema } from '../db/schema.js';
import { seedParams } from '../config/params.js';
import { createGenesisBlock, getLatestBlock, createBlock } from '../core/block.js';
import { loadGenesisSpec, applyGenesisSpec, genesisSpecHash } from './genesis-config.js';
import {
  runExpireAndRebase,
  runMintAndAdvance,
  resumeCycle,
  getCycleState,
  catchUpCycles,
  getNextCycleAt,
  setNextCycleAt,
} from '../core/day-cycle.js';
import { createApp, startServer } from '../api/server.js';
import { AENode } from '../network/node.js';
import { loadOrCreateNodeIdentity, type NodeIdentity } from '../network/node-identity.js';
import { payloadToBlock, type IncomingBlockPayload, type WireTransaction } from '../network/block-validator.js';
import { blockStore } from '../core/block.js';
import { transactionStore, replayTransaction } from '../core/transaction.js';
import { commitBlockSideEffects } from '../mining/rewards.js';
import { AuthorityConsensus } from '../network/consensus.js';
import { runTransaction } from '../db/connection.js';
import { SqliteValidatorSet } from '../core/consensus/SqliteValidatorSet.js';
import { BftBlockProducer } from '../core/consensus/BftBlockProducer.js';
import {
  drainValidatorChanges,
  removeAppliedValidatorChanges,
  applyValidatorChange,
} from '../core/consensus/validator-change.js';
import type { IValidatorSet } from '../core/consensus/IValidatorSet.js';
import { eventBus } from '../api/websocket.js';
import { logger, setLogLevel } from './logger.js';
import type { AENodeConfig } from './config.js';
import type { TransactionRow } from '../core/stores/ITransactionStore.js';

function txRowToWire(tx: TransactionRow): WireTransaction {
  return {
    id: tx.id,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    fee: tx.fee,
    netAmount: tx.netAmount,
    pointType: tx.pointType,
    isInPerson: tx.isInPerson,
    receiverSignature: tx.receiverSignature,
    memo: tx.memo,
    signature: tx.signature,
    timestamp: tx.timestamp,
  };
}

export class AENodeRunner {
  private config: AENodeConfig;
  private db!: DatabaseSync;
  private p2pNode!: AENode;
  private nodeIdentity!: NodeIdentity;
  private dayCycleTimers: ReturnType<typeof setTimeout>[] = [];
  private blockTimer: ReturnType<typeof setInterval> | null = null;
  private apiServer: ReturnType<typeof startServer> | null = null;
  /** BFT validator-set view, constructed once in startP2P when in BFT mode. */
  private bftValidatorSet: IValidatorSet | null = null;
  /** BFT block producer, only present when consensusMode === 'bft'. */
  private bftBlockProducer: BftBlockProducer | null = null;
  /**
   * Human-readable network identifier captured from the loaded GenesisSpec.
   * Threaded into the P2P handshake so peers can refuse to talk across
   * networks. Defaults to 'ae-legacy-dev' on the legacy random-timestamp
   * genesis path (single-node Authority dev only — never a real network).
   */
  private networkId: string = 'ae-legacy-dev';

  constructor(config: AENodeConfig) {
    this.config = config;
    setLogLevel(config.logLevel);
  }

  /** Full node startup sequence */
  start(): void {
    logger.info('node', '========================================');
    logger.info('node', 'Alignment Economy Node starting...');
    logger.info('node', `Node ID: ${this.config.nodeId}`);
    logger.info('node', `Authority: ${this.config.authorityNodeId}`);
    logger.info('node', '========================================');

    // 1. Initialize database
    this.initDatabase();

    // 2. Load (or generate on first boot) the long-lived P2P node identity
    this.loadNodeIdentity();

    // 3. Resume any interrupted cycle
    this.resumeIfNeeded();

    // 4. Start API server
    this.startApiServer();

    // 5. Start P2P network
    this.startP2P();

    // 6. Start block production (authority only)
    this.startBlockProduction();

    // 7. Start day cycle timer
    this.startDayCycleTimer();

    // 8. Register signal handlers
    this.registerSignalHandlers();

    logger.info('node', 'Node fully started');
  }

  private initDatabase(): void {
    const dir = dirname(this.config.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      logger.info('db', `Created data directory: ${dir}`);
    }

    this.db = new DatabaseSync(this.config.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    initializeSchema(this.db);
    seedParams(this.db);

    // Ensure genesis block exists. Three paths:
    //   1. Genesis already in DB → no-op (any prior boot already applied
    //      whatever spec or random-timestamp genesis was used).
    //   2. genesisConfigPath set → load + apply the shared spec. This is
    //      the multi-operator path: every node loads the SAME spec and
    //      ends up with byte-identical genesis state. Without it, two
    //      nodes would generate different genesis hashes and reject each
    //      other at handshake on genesisHash mismatch.
    //   3. No spec → fall back to the legacy random-timestamp path.
    //      Fine for single-node Authority development; broken for any
    //      multi-operator deployment.
    if (!getLatestBlock(this.db)) {
      if (this.config.genesisConfigPath) {
        const spec = loadGenesisSpec(this.config.genesisConfigPath);
        this.networkId = spec.networkId;
        const genesis = applyGenesisSpec(this.db, spec);
        logger.info(
          'db',
          `Applied genesis spec from ${this.config.genesisConfigPath}: ` +
            `network=${spec.networkId}, ` +
            `${spec.accounts.length} accounts, ` +
            `${spec.accounts.filter((a) => a.validator).length} validators, ` +
            `genesisHash=${genesis.hash.slice(0, 16)}…, ` +
            `specHash=${genesisSpecHash(spec).slice(0, 16)}…`,
        );
      } else {
        createGenesisBlock(this.db);
        logger.info('db', 'Created genesis block (legacy random-timestamp path; multi-operator networks should set genesisConfigPath)');
      }
    } else if (this.config.genesisConfigPath) {
      // DB already has a genesis block, but a spec is configured. Load the
      // spec so we know our networkId for the P2P handshake. (applyGenesisSpec
      // is a no-op when the genesis block already exists.)
      const spec = loadGenesisSpec(this.config.genesisConfigPath);
      this.networkId = spec.networkId;
    }

    const latest = getLatestBlock(this.db)!;
    logger.info('db', `Database initialized at block ${latest.number}`);
  }

  private loadNodeIdentity(): void {
    const keyPath =
      this.config.nodeKeyPath ?? join(dirname(this.config.dbPath), 'node-key.json');
    this.nodeIdentity = loadOrCreateNodeIdentity(keyPath);
    logger.info(
      'p2p',
      `Node identity loaded. publicKey=${this.nodeIdentity.publicKey.slice(0, 16)}…`,
    );
  }

  private resumeIfNeeded(): void {
    const state = getCycleState(this.db);
    if (state.cyclePhase !== 'idle') {
      logger.warn('cycle', `Resuming interrupted cycle from phase: ${state.cyclePhase}`);
      resumeCycle(this.db);
      logger.info('cycle', 'Cycle resumed successfully');
    }
  }

  private startApiServer(): void {
    // BFT mode: provide a tx broadcaster so API-submitted txs gossip out
    // and every validator sees them. The lookup is deferred (closes over
    // `this`) because startApiServer runs BEFORE startP2P; this.p2pNode
    // doesn't exist yet at API-construction time.
    const txBroadcaster =
      this.config.consensusMode === 'bft'
        ? (tx: Parameters<NonNullable<Parameters<typeof startServer>[2]>['txBroadcaster'] & {}>[0]) => {
            // p2pNode is set by the time the API actually services a request
            this.p2pNode?.peerManager.broadcast(
              'new_transaction',
              tx as unknown as Record<string, unknown>,
            );
          }
        : undefined;

    this.apiServer = startServer(this.db, this.config.apiPort, { txBroadcaster });
    logger.info('api', `API server listening on ${this.config.apiHost}:${this.config.apiPort}`);
  }

  private startP2P(): void {
    const genesisBlock = getLatestBlock(this.db);
    const genesisHash = genesisBlock?.hash ?? 'genesis';

    // Construct the BFT validator-set view once if we're in BFT mode.
    // AENode + BftBlockProducer share the same instance.
    if (this.config.consensusMode === 'bft') {
      this.bftValidatorSet = new SqliteValidatorSet(this.db);
    }

    this.p2pNode = new AENode(this.db, {
      nodeId: this.config.nodeId,
      genesisHash,
      networkId: this.networkId,
      p2pPort: this.config.p2pPort,
      authorityNodeId: this.config.authorityNodeId,
      seedNodes: this.config.seedNodes,
      maxPeers: this.config.maxPeers,
      identity: this.nodeIdentity,
      consensusMode: this.config.consensusMode,
      bftValidatorSet: this.bftValidatorSet ?? undefined,
      bftLocalAccountId: this.config.bftLocalAccountId,
    });

    // Bind the authority's publicKey on the consensus engine so
    // validateBlockProducer enforces cryptographic identity, not just the
    // spoofable nodeId string.
    //   - If THIS node is the authority, the authority's key is our own.
    //   - Otherwise, we use the configured authorityPublicKey (followers
    //     should always supply this in production).
    if (this.p2pNode.consensus instanceof AuthorityConsensus) {
      if (this.p2pNode.consensus.isAuthority()) {
        this.p2pNode.consensus.setAuthorityPublicKey(this.nodeIdentity.publicKey);
      } else if (this.config.authorityPublicKey) {
        this.p2pNode.consensus.setAuthorityPublicKey(this.config.authorityPublicKey);
      } else {
        logger.warn(
          'p2p',
          'Follower has no authorityPublicKey configured. Block validation will fall back to nodeId-only check (spoofable). Set AE_AUTHORITY_PUBLIC_KEY before production use.',
        );
      }
    }

    // Block-apply handler.
    //
    // Authority mode: validateIncomingBlock has already run; we replay txs +
    // insert the block header atomically. Same handler fires for both live
    // gossip ('block:received') and catch-up sync ('blocks:received').
    //
    // BFT mode: live gossip is owned by BftBlockProducer (stash + onCommit).
    // We install only the SYNC-path handler here so a validator that fell
    // behind can still catch up to the chain head when they connect to
    // peers. Persisting on live gossip would commit blocks BEFORE consensus
    // finalized them — silent fork risk; that's why setBlockApplyHandler
    // (which sets BOTH paths) is wrong here.
    if (this.config.consensusMode === 'bft') {
      this.p2pNode.chainSync.setSyncBlockApplyHandler((blockData) => {
        try {
          const payload = blockData as unknown as IncomingBlockPayload;
          const block = payloadToBlock(payload);
          const txs = payload.transactions ?? [];
          // Block N ships parentCertificate = cert for block N-1, and
          // parentValidatorSnapshot = the set that signed it. Persist
          // both so this node can serve them onward in its own sync
          // replies — the cert + snapshot pair is what makes
          // historical-cert verification work after slashing.
          const parentCert = payload.parentCertificate;
          const parentSnapshot = payload.parentValidatorSnapshot;
          // Session 51: validatorChanges that rode this block. The
          // sync source ships them as part of the block payload (via
          // serializeBlock spreading the persisted Block fields).
          // Apply them post-snapshot so the snapshot we save for THIS
          // block reflects the pre-change set — matching what
          // BftBlockProducer.onCommit does on the live path.
          const validatorChanges = payload.validatorChanges ?? [];
          runTransaction(this.db, () => {
            for (const wireTx of txs) {
              replayTransaction(
                this.db,
                {
                  id: wireTx.id,
                  from: wireTx.from,
                  to: wireTx.to,
                  amount: BigInt(wireTx.amount),
                  fee: BigInt(wireTx.fee),
                  netAmount: BigInt(wireTx.netAmount),
                  pointType: wireTx.pointType,
                  isInPerson: wireTx.isInPerson,
                  memo: wireTx.memo,
                  signature: wireTx.signature,
                  receiverSignature: wireTx.receiverSignature ?? null,
                  timestamp: wireTx.timestamp,
                },
                block.number,
              );
            }
            const store = blockStore(this.db);
            // Block insert persists block.validatorChanges via
            // SqliteBlockStore so this node can serve the changes
            // onward when it later acts as a sync source.
            store.insert(block, /* isGenesis */ false);
            if (parentCert) {
              // The cert is for the PARENT block (height = block.number - 1).
              store.saveCommitCertificate(block.number - 1, parentCert);
            }
            if (parentSnapshot && parentSnapshot.length > 0) {
              store.saveValidatorSnapshot(
                block.number - 1,
                parentSnapshot.map((v) => ({
                  ...v,
                  stake: typeof v.stake === 'string' ? BigInt(v.stake) : v.stake,
                })),
              );
            }
            // Snapshot the validator set as it stands right now —
            // BEFORE applying this block's changes. This becomes the
            // snapshot for cert(N), which was signed by validators
            // voting at the start of height N (= end of N-1, before
            // block N's mutations). Without this, a future joiner
            // verifying cert(N) against the wrong-era snapshot would
            // see signatures from validators "not in the active set."
            if (this.bftValidatorSet) {
              store.saveValidatorSnapshot(block.number, this.bftValidatorSet.listAll());
            }
            // Apply validator changes to mutate the set for block
            // N+1 onward. Same code path as BftBlockProducer.onCommit;
            // every honest node arrives at the same set after applying
            // because the inputs (chain state + signed change) are
            // identical.
            for (const change of validatorChanges) {
              applyValidatorChange(this.db, change, block.timestamp);
            }

            // Distribute fees per WP economics. Idempotent — matches the
            // distribution the original proposer ran on its side.
            commitBlockSideEffects(this.db, block.number, block.hash);
          });
          this.p2pNode.consensus.notifyHeightAdvanced?.(block.number);
          logger.info(
            'blocks',
            `Synced historical block ${block.number} (${txs.length} txs replayed, ${validatorChanges.length} validator changes applied)`,
          );
          return true;
        } catch (err) {
          logger.error('blocks', 'Failed to apply synced block', err);
          return false;
        }
      });
    } else {
      this.p2pNode.chainSync.setBlockApplyHandler((blockData) => {
      try {
        const payload = blockData as unknown as IncomingBlockPayload;
        const block = payloadToBlock(payload);
        const txs = payload.transactions ?? [];

        runTransaction(this.db, () => {
          for (const wireTx of txs) {
            replayTransaction(
              this.db,
              {
                id: wireTx.id,
                from: wireTx.from,
                to: wireTx.to,
                amount: BigInt(wireTx.amount),
                fee: BigInt(wireTx.fee),
                netAmount: BigInt(wireTx.netAmount),
                pointType: wireTx.pointType,
                isInPerson: wireTx.isInPerson,
                memo: wireTx.memo,
                signature: wireTx.signature,
                receiverSignature: wireTx.receiverSignature ?? null,
                timestamp: wireTx.timestamp,
              },
              block.number,
            );
          }
          blockStore(this.db).insert(block, /* isGenesis */ false);
          commitBlockSideEffects(this.db, block.number, block.hash);
        });

        this.p2pNode.consensus.notifyHeightAdvanced?.(block.number);
        logger.info(
          'blocks',
          `Applied block ${block.number} from authority (${txs.length} txs replayed)`,
        );
        return true;
      } catch (err) {
        logger.error('blocks', 'Failed to apply validated block', err);
        return false;
      }
    });
    }

    // Wire P2P events to API WebSocket eventBus
    this.p2pNode.peerManager.on('block:received', (data: unknown) => {
      eventBus.emit('block:new', data);
    });

    this.p2pNode.start();
    logger.info('p2p', `P2P node listening on port ${this.config.p2pPort}`);
  }

  private startBlockProduction(): void {
    // BFT mode: spawn a BftBlockProducer instead of the interval timer.
    // It only emits block-production behavior when this node is selected
    // as the round proposer; otherwise it just tracks rounds.
    if (this.config.consensusMode === 'bft') {
      this.startBftBlockProducer();
      return;
    }

    if (!this.p2pNode.consensus.isAuthority()) {
      logger.info('blocks', 'Not authority node, skipping block production');
      return;
    }

    logger.info('blocks', `Authority node, producing blocks every ${this.config.blockIntervalMs}ms`);

    this.blockTimer = setInterval(() => {
      try {
        // Pending = (a) txs that hit our API and have block_number=NULL,
        //          (b) gossiped txs sitting in our mempool (peer-of-peer
        //              relay flow; not used in single-authority mode).
        // For a single-authority deployment (a) is the only relevant source.
        const unblocked = transactionStore(this.db).findUnblockedTransactions();
        if (unblocked.length === 0) return; // no transactions to include

        const state = getCycleState(this.db);
        const txIds = unblocked.map((tx) => tx.id);
        const block = createBlock(this.db, state.currentDay, txIds);

        // Drain anything from mempool that we just included (back-compat).
        this.p2pNode.mempool.removeMany(txIds);

        // Ship full tx data so followers can replay and reproduce state.
        const wireTxs = unblocked.map(txRowToWire);
        this.p2pNode.broadcastBlock(
          block as unknown as Record<string, unknown>,
          txIds,
          wireTxs,
        );

        // Tell the consensus engine the chain advanced so finalizedHeight()
        // and other observability methods stay current.
        this.p2pNode.consensus.notifyHeightAdvanced?.(block.number);

        // Notify API clients
        eventBus.emit('block:new', block);

        logger.info('blocks', `Produced block ${block.number} with ${txIds.length} transactions`);
      } catch (err) {
        logger.error('blocks', 'Block production failed', err);
      }
    }, this.config.blockIntervalMs);
  }

  /**
   * Spawn a BftBlockProducer that drives propose/prevote/precommit rounds.
   * Runs on every BFT validator regardless of whether they're the current
   * proposer — only the elected proposer for each round actually builds
   * a block; everyone else votes.
   */
  private startBftBlockProducer(): void {
    if (!this.bftValidatorSet) {
      throw new Error('BFT mode set but bftValidatorSet not initialized; check startP2P order');
    }
    if (!this.config.bftLocalAccountId) {
      throw new Error("consensusMode='bft' requires bftLocalAccountId");
    }
    if (this.config.nodeId !== this.config.bftLocalAccountId) {
      // The wire-envelope senderId is config.nodeId; consensus.validateBlockProducer
      // looks up the validator by that string. If they don't match, every
      // gossiped block fails validation and the sender gets banned.
      throw new Error(
        `consensusMode='bft' requires nodeId === bftLocalAccountId (got nodeId='${this.config.nodeId}', bftLocalAccountId='${this.config.bftLocalAccountId}')`,
      );
    }

    const state = getCycleState(this.db);
    this.bftBlockProducer = new BftBlockProducer({
      db: this.db,
      peerManager: this.p2pNode.peerManager,
      validatorSet: this.bftValidatorSet,
      localValidator: {
        accountId: this.config.bftLocalAccountId,
        publicKey: this.nodeIdentity.publicKey,
        secretKey: this.nodeIdentity.secretKey,
      },
      day: state.currentDay,
      // Session 49: drain the local pending-changes queue into each
      // candidate block. Other operators don't have entries in our
      // queue, but they still receive + apply the changes via the
      // block payload — every node sees the same set after commit.
      pendingValidatorChanges: () => drainValidatorChanges(this.db),
      // After commit, remove the drained entries so they don't ride
      // the next block too. Idempotent on missing entries (e.g., when
      // a non-proposer node receives a block whose changes weren't
      // in their local queue).
      onValidatorChangesApplied: (changes) => {
        const removed = removeAppliedValidatorChanges(this.db, changes);
        if (removed > 0) {
          logger.info(
            'validators',
            `Drained ${removed} validator change(s) from pending queue`,
          );
        }
      },
      onBlockCommitted: (block) => {
        // Notify API clients + tell the consensus engine the chain
        // advanced so observability stays current. notifyHeightAdvanced
        // / notifyFinalized are intentionally idempotent.
        this.p2pNode.consensus.notifyHeightAdvanced?.(block.number);
        eventBus.emit('block:new', block);
        logger.info(
          'blocks',
          `BFT committed block ${block.number} (${block.transactionCount} txs)`,
        );
      },
      // Session 54: hold off on round 0 until peers have time to
      // connect. Without this, the validator that boots first races
      // through round 0 alone and stays permanently out of sync with
      // peers who connected after. 3000ms is generous enough for
      // local + LAN deployments; production WAN may want longer.
      startupDelayMs: this.config.bftStartupDelayMs ?? 3000,
    });
    this.bftBlockProducer.start();
    logger.info('blocks', 'BFT consensus loop started');
  }

  private startDayCycleTimer(): void {
    if (!this.p2pNode.consensus.isAuthority()) {
      logger.info('cycle', 'Not authority, day cycle managed by authority node');
      return;
    }

    // 1) Catch up any cycles whose 08:59 UTC trigger time has already passed
    //    (e.g., the node was off for a few days). This runs them as fast as
    //    possible until we're current. Each catch-up cycle uses the unified
    //    runDayCycle() (no live-time blackout split), since the schedule
    //    they should have run on is already in the past.
    const catchup = catchUpCycles(this.db);
    if (catchup.ranCount > 0) {
      logger.warn('cycle', `Caught up ${catchup.ranCount} missed day cycles`);
      eventBus.emit('network:day-change', { day: getCycleState(this.db).currentDay });
    }

    // 2) Schedule the next on-time cycle at the live UTC trigger.
    this.scheduleNextExpireAndRebase();

    const nextAt = getNextCycleAt(this.db);
    logger.info(
      'cycle',
      `Day cycle anchored to 08:59 UTC daily. Next runs at ${nextAt ? new Date(nextAt * 1000).toISOString() : 'unknown'}`,
    );
  }

  /** Schedule the 08:59 UTC expire+rebase. After it fires, schedule the 09:00 UTC mint+advance. */
  private scheduleNextExpireAndRebase(): void {
    const nextAt = getNextCycleAt(this.db);
    if (nextAt === null) return;
    const delayMs = Math.max(0, nextAt * 1000 - Date.now());

    const t = setTimeout(() => {
      try {
        logger.info('cycle', 'Running expire + rebase (08:59 UTC)...');
        const rebaseEvent = runExpireAndRebase(this.db);
        if (rebaseEvent) {
          eventBus.emit('rebase:complete', rebaseEvent);
          logger.info(
            'cycle',
            `Rebase complete: ${rebaseEvent.participantCount} participants, multiplier ${rebaseEvent.rebaseMultiplier.toFixed(6)}`,
          );
        }
      } catch (err) {
        logger.error('cycle', 'Expire+rebase failed', err);
      }
      this.scheduleMintAndAdvance();
    }, delayMs);
    this.dayCycleTimers.push(t);
  }

  /** Mint+advance fires 60 seconds after expire+rebase (the white paper's 09:00 UTC step). */
  private scheduleMintAndAdvance(): void {
    const t = setTimeout(() => {
      try {
        logger.info('cycle', 'Running mint + advance (09:00 UTC)...');
        runMintAndAdvance(this.db);
        const day = getCycleState(this.db).currentDay;
        eventBus.emit('network:day-change', { day });
        logger.info('cycle', `Day cycle complete. Now on day ${day}`);
      } catch (err) {
        logger.error('cycle', 'Mint+advance failed', err);
      }
      // Bump next_cycle_at by 24h and chain.
      const cur = getNextCycleAt(this.db);
      if (cur !== null) setNextCycleAt(this.db, cur + 86400);
      this.scheduleNextExpireAndRebase();
    }, 60_000);
    this.dayCycleTimers.push(t);
  }

  private registerSignalHandlers(): void {
    const shutdown = () => {
      logger.info('node', 'Shutting down...');
      this.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  stop(): void {
    for (const t of this.dayCycleTimers) clearTimeout(t);
    this.dayCycleTimers = [];
    if (this.blockTimer) {
      clearInterval(this.blockTimer);
      this.blockTimer = null;
    }
    if (this.bftBlockProducer) {
      this.bftBlockProducer.stop();
      this.bftBlockProducer = null;
    }
    if (this.p2pNode) {
      this.p2pNode.stop();
    }
    if (this.apiServer) {
      this.apiServer.server.close();
    }
    if (this.db) {
      this.db.close();
    }
    logger.info('node', 'Shutdown complete');
  }

  getDb(): DatabaseSync {
    return this.db;
  }

  getP2PNode(): AENode {
    return this.p2pNode;
  }

  /** Test/observability hook: returns the BFT block producer (only in BFT mode). */
  getBftBlockProducer(): BftBlockProducer | null {
    return this.bftBlockProducer;
  }

  /** Actual API server port (relevant when configured with port 0). */
  getApiPort(): number {
    if (!this.apiServer) return -1;
    const addr = this.apiServer.server.address();
    if (typeof addr === 'object' && addr !== null) {
      return (addr as { port: number }).port;
    }
    return -1;
  }

  /** Actual P2P port (relevant when configured with port 0). */
  getP2PPort(): number {
    return this.p2pNode?.getP2PPort() ?? -1;
  }

  /**
   * Resolves once both API and P2P servers are listening on their
   * (possibly-ephemeral) ports. Tests use this between sequential
   * runner starts so the next runner can use the previous one's port
   * as a seed node.
   */
  async waitForReady(): Promise<void> {
    if (!this.p2pNode || !this.apiServer) {
      throw new Error('Runner not started');
    }
    await this.p2pNode.waitForP2PListening();
    if (!this.apiServer.server.listening) {
      await new Promise<void>((resolve) => {
        this.apiServer!.server.once('listening', () => resolve());
      });
    }
  }
}
