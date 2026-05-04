import { DatabaseSync } from 'node:sqlite';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';
import { PeerManager } from './peer.js';
import { Mempool } from './mempool.js';
import { AuthorityConsensus } from './consensus.js';
import type { IConsensusEngine } from '../core/consensus/IConsensusEngine.js';
import { BFTConsensus } from '../core/consensus/BFTConsensus.js';
import type { IValidatorSet } from '../core/consensus/IValidatorSet.js';
import { ChainSync } from './sync.js';
import { PeerDiscovery, type DiscoveryConfig } from './discovery.js';
import { getLatestBlock } from '../core/block.js';
import { serializeBlock } from './messages.js';
import type { NodeIdentity } from './node-identity.js';
import type { WireTransaction } from './block-validator.js';
import { replayTransaction } from '../core/transaction.js';

export interface NodeConfig {
  nodeId: string;
  genesisHash: string;
  /**
   * Human-readable network identifier (e.g. "ae-mainnet-1"). Required.
   * Sourced from the loaded GenesisSpec — peers compare this on handshake
   * and reject mismatches with a friendly error before falling back to the
   * cryptographic genesisHash check.
   */
  networkId: string;
  p2pPort: number;
  authorityNodeId: string;
  seedNodes?: Array<{ host: string; port: number }>;
  maxPeers?: number;
  /** Long-lived Ed25519 keypair that authenticates this node on the P2P network. */
  identity: NodeIdentity;
  /**
   * Which consensus engine to plug in. Default is 'authority' (Phase 1
   * single-authority chain). 'bft' switches in BFTConsensus + threads the
   * validator set through ChainSync so incoming blocks get cert checks.
   */
  consensusMode?: 'authority' | 'bft';
  /** Required when consensusMode === 'bft'. Live view of the validator table. */
  bftValidatorSet?: IValidatorSet;
  /** Required when consensusMode === 'bft'. This node's accountId in the validator set. */
  bftLocalAccountId?: string;
}

export class AENode {
  readonly peerManager: PeerManager;
  readonly mempool: Mempool;
  // Typed as IConsensusEngine so swapping in BFTConsensus later is mechanical.
  // Stored as AuthorityConsensus today because runner.ts uses notifyHeightAdvanced.
  readonly consensus: IConsensusEngine & { notifyHeightAdvanced?: (h: number) => void };
  readonly chainSync: ChainSync;
  readonly discovery: PeerDiscovery;

  private db: DatabaseSync;
  private config: NodeConfig;
  private wss: WebSocketServer | null = null;
  private server: Server | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(db: DatabaseSync, config: NodeConfig) {
    this.db = db;
    this.config = config;

    const latestBlock = getLatestBlock(db);
    const blockHeight = latestBlock?.number ?? 0;

    this.peerManager = new PeerManager(
      config.identity,
      config.nodeId,
      config.genesisHash,
      config.networkId,
      config.maxPeers,
    );
    this.peerManager.setBlockHeight(blockHeight);

    this.mempool = new Mempool();

    // Pick the consensus engine based on the configured mode.
    // - 'authority' (default): Phase 1 single-authority chain. Existing
    //   behavior; AuthorityConsensus still produces every block.
    // - 'bft': Phase 3 multi-validator. BFTConsensus reads validators
    //   from the supplied IValidatorSet and answers canProduceBlock /
    //   validateBlockProducer / quorumSize accordingly. Block production
    //   itself runs through BftDriver, wired by the runner one layer up.
    if (config.consensusMode === 'bft') {
      if (!config.bftValidatorSet || !config.bftLocalAccountId) {
        throw new Error(
          "consensusMode='bft' requires bftValidatorSet and bftLocalAccountId",
        );
      }
      this.consensus = new BFTConsensus({
        validatorSet: config.bftValidatorSet,
        localAccountId: config.bftLocalAccountId,
        localNodePublicKey: config.identity.publicKey,
        initialHeight: blockHeight,
        initialSeed: latestBlock?.hash ?? '',
      });
    } else {
      this.consensus = new AuthorityConsensus(config.authorityNodeId, config.nodeId);
    }

    // ChainSync gets the validator set when in BFT mode so validateIncomingBlock
    // can run cert checks on every incoming block.
    this.chainSync = new ChainSync(
      db,
      this.peerManager,
      this.consensus,
      config.bftValidatorSet,
    );

    const discoveryConfig: Partial<DiscoveryConfig> = {
      seedNodes: config.seedNodes ?? [],
    };
    this.discovery = new PeerDiscovery(this.peerManager, discoveryConfig);

    // Wire transaction-gossip handling at construction time, BEFORE start().
    // start() spins up the WebSocket server; tests that wire their own
    // server externally still need this listener active.
    //
    // Authority mode: drop into the mempool. The next block-production
    // tick on the authority will pull them in. Followers don't apply
    // state until the block arrives via gossip or sync.
    //
    // BFT mode: APPLY locally (replayTransaction with blockNumber=null).
    // Every node ends up with the tx in its unblocked queue, so whichever
    // validator gets elected proposer can include it in a block.
    this.peerManager.on('transaction:received', (txData: unknown) => {
      const tx = txData as Partial<WireTransaction>;
      if (this.config.consensusMode === 'bft') {
        try {
          replayTransaction(this.db, {
            id: String(tx.id ?? ''),
            from: String(tx.from ?? ''),
            to: String(tx.to ?? ''),
            amount: BigInt(tx.amount ?? '0'),
            fee: BigInt(tx.fee ?? '0'),
            netAmount: BigInt(tx.netAmount ?? '0'),
            pointType: (tx.pointType ?? 'earned') as WireTransaction['pointType'],
            isInPerson: Boolean(tx.isInPerson),
            memo: String(tx.memo ?? ''),
            signature: String(tx.signature ?? ''),
            timestamp: Number(tx.timestamp ?? 0),
          });
          this.peerManager.emit('transaction:applied', tx);
        } catch (err) {
          this.peerManager.emit('transaction:apply-failed', tx, err);
        }
      } else {
        this.mempool.add(tx as unknown as Parameters<typeof this.mempool.add>[0]);
      }
    });
  }

  /** Start the P2P WebSocket server and connect to the network */
  start(): void {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws, req) => {
      const remoteAddress = req.socket.remoteAddress ?? 'unknown';
      this.peerManager.handleIncomingConnection(ws, remoteAddress);
    });

    this.server.listen(this.config.p2pPort, () => {
      console.log(`P2P node listening on port ${this.config.p2pPort}`);
    });

    // Start peer discovery
    this.discovery.start();

    // Start chain sync after a brief delay to allow connections
    setTimeout(() => {
      this.chainSync.startSync();
    }, 2000);

    // Periodic ping to keep connections alive
    this.pingInterval = setInterval(() => {
      this.peerManager.broadcast('ping', null);
    }, 30_000);

    // Tx-gossip handling lives in the constructor (above) so tests that
    // wire their own WebSocket server can use it without calling start().
  }

  /**
   * The actual port this node's P2P server is bound to. Useful when
   * configured with port 0 (ephemeral) so other nodes can know where
   * to connect. Returns -1 before the server has started or after stop.
   */
  getP2PPort(): number {
    if (!this.server) return -1;
    const addr = this.server.address();
    if (typeof addr === 'object' && addr !== null) {
      return (addr as { port: number }).port;
    }
    return -1;
  }

  /**
   * Resolves once the P2P server has bound its port and is accepting
   * connections. Tests use this to wait for ephemeral-port allocation
   * before reading getP2PPort().
   */
  waitForP2PListening(): Promise<void> {
    if (!this.server) return Promise.reject(new Error('AENode not started'));
    if (this.server.listening) return Promise.resolve();
    return new Promise((resolve) => {
      this.server!.once('listening', () => resolve());
    });
  }

  /**
   * Broadcast a new block to all peers. The payload includes:
   *   - the serialized block header
   *   - the txIds list (so followers can re-derive merkleRoot)
   *   - the full transactions (so followers can replay state from scratch)
   */
  broadcastBlock(
    block: Record<string, unknown>,
    txIds: string[],
    transactions: WireTransaction[],
  ): void {
    const serialized = serializeBlock(block);
    this.peerManager.broadcast('new_block', { ...serialized, txIds, transactions });
  }

  /** Broadcast a new transaction to all peers */
  broadcastTransaction(tx: Record<string, unknown>): void {
    this.peerManager.broadcast('new_transaction', tx);
  }

  /** Gracefully shut down the node */
  stop(): void {
    this.discovery.stop();

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this.peerManager.disconnectAll();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getStatus(): {
    nodeId: string;
    blockHeight: number;
    peerCount: number;
    mempoolSize: number;
    isAuthority: boolean;
    isSyncing: boolean;
  } {
    return {
      nodeId: this.config.nodeId,
      blockHeight: this.peerManager.getBlockHeight(),
      peerCount: this.peerManager.getPeerCount(),
      mempoolSize: this.mempool.size(),
      isAuthority: this.consensus.isAuthority(),
      isSyncing: this.chainSync.getState().isSyncing,
    };
  }
}
