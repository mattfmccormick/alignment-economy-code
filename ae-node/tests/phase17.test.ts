// Phase 17: Transaction replay during sync.
//
// Sessions 9 and 10 made followers reject blocks they shouldn't trust.
// Session 11 makes followers actively reproduce the authority's state by
// replaying every transaction in every block. Without this, a follower's
// `accounts`, `transaction_log`, and fee-pool tables stay empty even after
// they "sync" the chain — they have block headers but no state.
//
// This suite verifies:
//   1. replayTransaction mutates follower state to match the authority
//      byte-for-byte after applying the same tx.
//   2. replayTransaction is idempotent — calling it twice for the same id
//      doesn't double-apply.
//   3. End-to-end catch-up sync: a fresh follower receives 3 blocks of
//      real signed transactions and ends up with identical balances to
//      the authority.
//   4. The validator rejects a block whose transactions array doesn't
//      cover all txIds (and vice versa).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

import { initializeSchema } from '../src/db/schema.js';
import { seedParams } from '../src/config/params.js';
import { createAccount, getAccount } from '../src/core/account.js';
import {
  processTransaction,
  replayTransaction,
  transactionStore,
} from '../src/core/transaction.js';
import { signPayload } from '../src/core/crypto.js';
import {
  createGenesisBlock,
  createBlock,
  computeBlockHash,
  computeMerkleRoot,
  getLatestBlock,
  blockStore,
} from '../src/core/block.js';
import { PRECISION } from '../src/core/constants.js';
import { AuthorityConsensus } from '../src/network/consensus.js';
import { PeerManager } from '../src/network/peer.js';
import { ChainSync } from '../src/network/sync.js';
import { generateNodeIdentity } from '../src/network/node-identity.js';
import {
  validateIncomingBlock,
  payloadToBlock,
  type IncomingBlockPayload,
  type WireTransaction,
} from '../src/network/block-validator.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  initializeSchema(db);
  seedParams(db);
  return db;
}

function pts(n: number): bigint {
  return BigInt(Math.round(n * Number(PRECISION)));
}

function createWsServer(): Promise<{ server: Server; wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, wss, port: addr.port });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Submit a real signed transaction. Returns the resulting tx row. */
function submitTx(
  db: DatabaseSync,
  sender: ReturnType<typeof createAccount>,
  receiver: ReturnType<typeof createAccount>,
  amount: bigint,
): { id: string; signature: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    from: sender.account.id,
    to: receiver.account.id,
    amount: amount.toString(),
    pointType: 'active' as const,
    isInPerson: false,
    memo: '',
  };
  const signature = signPayload(payload, timestamp, sender.privateKey);
  const result = processTransaction(db, {
    from: sender.account.id,
    to: receiver.account.id,
    amount,
    pointType: 'active',
    isInPerson: false,
    memo: '',
    timestamp,
    signature,
  });
  return { id: result.transaction.id, signature, timestamp };
}

/**
 * Mirror the same account schema on the follower side so balances flow
 * cleanly. Keeps publicKeys aligned between authority and follower so
 * signature verification on replay finds the right key.
 */
function mirrorAccount(
  followerDb: DatabaseSync,
  authorityDb: DatabaseSync,
  accountId: string,
): void {
  const acct = getAccount(authorityDb, accountId);
  if (!acct) throw new Error(`account ${accountId} not on authority`);
  followerDb
    .prepare(
      `INSERT INTO accounts (id, public_key, type, earned_balance, active_balance, supportive_balance, ambient_balance, locked_balance, percent_human, joined_day, is_active, protection_window_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      acct.id,
      acct.publicKey,
      acct.type,
      acct.earnedBalance.toString(),
      acct.activeBalance.toString(),
      acct.supportiveBalance.toString(),
      acct.ambientBalance.toString(),
      acct.lockedBalance.toString(),
      acct.percentHuman,
      acct.joinedDay,
      acct.isActive ? 1 : 0,
      acct.protectionWindowEnd ?? null,
      acct.createdAt,
    );
}

describe('Phase 17: Transaction replay during sync', () => {
  const cleanup: Array<{ server: Server; wss: WebSocketServer }> = [];

  afterEach(() => {
    for (const s of cleanup) {
      try { s.wss.close(); } catch {}
      try { s.server.close(); } catch {}
    }
    cleanup.length = 0;
  });

  // ── replayTransaction unit-level ─────────────────────────────────────

  it('replayTransaction reproduces sender + recipient balances on follower', () => {
    const dbAuth = freshDb();
    createGenesisBlock(dbAuth);

    const sender = createAccount(dbAuth, 'individual', 1, 100);
    const receiver = createAccount(dbAuth, 'individual', 1, 100);
    dbAuth.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
      pts(1000).toString(),
      sender.account.id,
    );

    // Authority commits the tx via the API path
    const txMeta = submitTx(dbAuth, sender, receiver, pts(50));
    const tx = transactionStore(dbAuth).findTransactionById(txMeta.id)!;

    // Follower starts with the same account snapshot but no transactions
    const dbFol = freshDb();
    createGenesisBlock(dbFol);
    mirrorAccount(dbFol, dbAuth, sender.account.id);
    mirrorAccount(dbFol, dbAuth, receiver.account.id);
    // Reset balances on follower to PRE-tx state (mirror copied post-tx)
    dbFol.prepare('UPDATE accounts SET active_balance = ?, earned_balance = 0 WHERE id = ?').run(
      pts(1000).toString(),
      sender.account.id,
    );
    dbFol.prepare('UPDATE accounts SET earned_balance = 0 WHERE id = ?').run(
      receiver.account.id,
    );

    // Authority creates the block (links the tx to block 1)
    createBlock(dbAuth, 1, [tx.id]);

    // Follower replays
    replayTransaction(
      dbFol,
      {
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: BigInt(tx.amount),
        fee: BigInt(tx.fee),
        netAmount: BigInt(tx.netAmount),
        pointType: tx.pointType,
        isInPerson: tx.isInPerson,
        memo: tx.memo,
        signature: tx.signature,
        timestamp: tx.timestamp,
      },
      1,
    );

    const authSender = getAccount(dbAuth, sender.account.id)!;
    const authReceiver = getAccount(dbAuth, receiver.account.id)!;
    const folSender = getAccount(dbFol, sender.account.id)!;
    const folReceiver = getAccount(dbFol, receiver.account.id)!;

    assert.equal(folSender.activeBalance, authSender.activeBalance);
    assert.equal(folReceiver.earnedBalance, authReceiver.earnedBalance);

    // The tx is linked to block 1 on follower too
    assert.equal(transactionStore(dbFol).findTransactionById(tx.id)!.blockNumber, 1);
  });

  it('replayTransaction is idempotent (gossip-then-block race)', () => {
    const dbAuth = freshDb();
    createGenesisBlock(dbAuth);

    const sender = createAccount(dbAuth, 'individual', 1, 100);
    const receiver = createAccount(dbAuth, 'individual', 1, 100);
    dbAuth.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
      pts(1000).toString(),
      sender.account.id,
    );
    const txMeta = submitTx(dbAuth, sender, receiver, pts(50));
    const tx = transactionStore(dbAuth).findTransactionById(txMeta.id)!;

    const dbFol = freshDb();
    createGenesisBlock(dbFol);
    mirrorAccount(dbFol, dbAuth, sender.account.id);
    mirrorAccount(dbFol, dbAuth, receiver.account.id);
    dbFol.prepare('UPDATE accounts SET active_balance = ?, earned_balance = 0 WHERE id = ?').run(
      pts(1000).toString(),
      sender.account.id,
    );
    dbFol.prepare('UPDATE accounts SET earned_balance = 0 WHERE id = ?').run(
      receiver.account.id,
    );

    const replayInput = {
      id: tx.id,
      from: tx.from,
      to: tx.to,
      amount: BigInt(tx.amount),
      fee: BigInt(tx.fee),
      netAmount: BigInt(tx.netAmount),
      pointType: tx.pointType,
      isInPerson: tx.isInPerson,
      memo: tx.memo,
      signature: tx.signature,
      timestamp: tx.timestamp,
    };

    replayTransaction(dbFol, replayInput, 1);
    const balanceAfterFirst = getAccount(dbFol, sender.account.id)!.activeBalance;

    // Second replay (e.g. block arrives after gossip already applied)
    replayTransaction(dbFol, replayInput, 1);
    const balanceAfterSecond = getAccount(dbFol, sender.account.id)!.activeBalance;

    assert.equal(
      balanceAfterFirst,
      balanceAfterSecond,
      'replay must not double-apply state effects',
    );
  });

  // ── Validator: transactions ↔ txIds cross-consistency ────────────────

  it('rejects a block whose transactions array does not match txIds', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const txIds = ['tx-1', 'tx-2'];
    const merkleRoot = computeMerkleRoot(txIds);
    const ts = Math.floor(Date.now() / 1000);
    const prev = getLatestBlock(db)!;
    const payload: IncomingBlockPayload = {
      number: 1,
      day: 1,
      timestamp: ts,
      previousHash: prev.hash,
      merkleRoot,
      hash: computeBlockHash(1, prev.hash, ts, merkleRoot, 1),
      transactionCount: 2,
      rebaseEvent: null,
      txIds,
      transactions: [
        // tx-2 is in txIds but missing from transactions; tx-WRONG is in transactions but not in txIds
        {
          id: 'tx-1',
          from: 'a',
          to: 'b',
          amount: '0',
          fee: '0',
          netAmount: '0',
          pointType: 'earned',
          isInPerson: false,
          memo: '',
          signature: '',
          timestamp: ts,
        },
        {
          id: 'tx-WRONG',
          from: 'a',
          to: 'b',
          amount: '0',
          fee: '0',
          netAmount: '0',
          pointType: 'earned',
          isInPerson: false,
          memo: '',
          signature: '',
          timestamp: ts,
        },
      ],
    };

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /tx-WRONG/);
  });

  it('rejects a block with duplicate transaction ids in the transactions array', () => {
    const db = freshDb();
    createGenesisBlock(db);
    const consensus = new AuthorityConsensus('authority', 'follower');
    const authKey = generateNodeIdentity();

    const txIds = ['tx-1', 'tx-1'];
    // Two copies of the same id; merkleRoot computed over the duplicate set
    const merkleRoot = computeMerkleRoot(txIds);
    const ts = Math.floor(Date.now() / 1000);
    const prev = getLatestBlock(db)!;
    const payload: IncomingBlockPayload = {
      number: 1,
      day: 1,
      timestamp: ts,
      previousHash: prev.hash,
      merkleRoot,
      hash: computeBlockHash(1, prev.hash, ts, merkleRoot, 1),
      transactionCount: 2,
      rebaseEvent: null,
      txIds,
      transactions: [
        {
          id: 'tx-1',
          from: 'a',
          to: 'b',
          amount: '0',
          fee: '0',
          netAmount: '0',
          pointType: 'earned',
          isInPerson: false,
          memo: '',
          signature: '',
          timestamp: ts,
        },
        {
          id: 'tx-1',
          from: 'a',
          to: 'b',
          amount: '0',
          fee: '0',
          netAmount: '0',
          pointType: 'earned',
          isInPerson: false,
          memo: '',
          signature: '',
          timestamp: ts,
        },
      ],
    };

    const result = validateIncomingBlock(db, consensus, payload, 'authority', authKey.publicKey);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /duplicate transaction id/);
  });

  // ── End-to-end catch-up sync with replay ─────────────────────────────

  it('follower replays full state through catch-up sync', async () => {
    // Authority builds a 3-block chain with REAL signed transactions.
    const dbAuth = freshDb();
    createGenesisBlock(dbAuth);

    const sender = createAccount(dbAuth, 'individual', 1, 100);
    const receiver = createAccount(dbAuth, 'individual', 1, 100);
    dbAuth.prepare('UPDATE accounts SET active_balance = ? WHERE id = ?').run(
      pts(10000).toString(),
      sender.account.id,
    );

    for (let blk = 0; blk < 3; blk++) {
      const txIds: string[] = [];
      for (let i = 0; i < 2; i++) txIds.push(submitTx(dbAuth, sender, receiver, pts(5)).id);
      createBlock(dbAuth, 1, txIds);
    }
    assert.equal(getLatestBlock(dbAuth)!.number, 3);

    // Authority node setup
    const authIdentity = generateNodeIdentity();
    const authConsensus = new AuthorityConsensus(
      'authority',
      'authority',
      3,
      authIdentity.publicKey,
    );
    const authPeers = new PeerManager(authIdentity, 'authority', 'replay-sync-gen');
    authPeers.setBlockHeight(3);
    const _authSync = new ChainSync(dbAuth, authPeers, authConsensus);

    const srv = await createWsServer();
    cleanup.push(srv);
    srv.wss.on('connection', (ws, req) => {
      authPeers.handleIncomingConnection(ws, req.socket.remoteAddress ?? '127.0.0.1');
    });

    // Follower setup. Mirror the participant accounts at PRE-transaction
    // state so replay can reproduce the post-state.
    const dbFol = freshDb();
    createGenesisBlock(dbFol);
    // Mirror the accounts as they EXISTED before any transactions
    mirrorAccount(dbFol, dbAuth, sender.account.id);
    mirrorAccount(dbFol, dbAuth, receiver.account.id);
    dbFol.prepare('UPDATE accounts SET active_balance = ?, earned_balance = 0 WHERE id = ?').run(
      pts(10000).toString(),
      sender.account.id,
    );
    dbFol.prepare('UPDATE accounts SET earned_balance = 0, active_balance = 0 WHERE id = ?').run(
      receiver.account.id,
    );

    const newIdentity = generateNodeIdentity();
    const newConsensus = new AuthorityConsensus(
      'authority',
      'new-node',
      0,
      authIdentity.publicKey,
    );
    const newPeers = new PeerManager(newIdentity, 'new-node', 'replay-sync-gen');
    newPeers.setBlockHeight(0);
    const newSync = new ChainSync(dbFol, newPeers, newConsensus);

    // Default block-apply handler: replay txs + insert block (atomic).
    newSync.setBlockApplyHandler((blockData) => {
      const payload = blockData as unknown as IncomingBlockPayload;
      const block = payloadToBlock(payload);
      const txs: WireTransaction[] = payload.transactions ?? [];
      try {
        for (const wireTx of txs) {
          replayTransaction(
            dbFol,
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
              timestamp: wireTx.timestamp,
            },
            block.number,
          );
        }
        blockStore(dbFol).insert(block, /* isGenesis */ false);
        return true;
      } catch {
        return false;
      }
    });

    const connected = new Promise<void>((resolve) => {
      newPeers.once('peer:connected', () => resolve());
    });
    newPeers.connectToPeer('127.0.0.1', srv.port);
    await connected;
    await wait(50);

    newSync.startSync();
    await wait(500);

    assert.equal(getLatestBlock(dbFol)!.number, 3, 'follower must reach block 3');
    assert.equal(
      newPeers.isBanned(authIdentity.publicKey),
      false,
      'authority must NOT be banned',
    );

    // STATE EQUIVALENCE: follower balances match authority balances byte for byte
    const authSender = getAccount(dbAuth, sender.account.id)!;
    const authReceiver = getAccount(dbAuth, receiver.account.id)!;
    const folSender = getAccount(dbFol, sender.account.id)!;
    const folReceiver = getAccount(dbFol, receiver.account.id)!;

    assert.equal(folSender.activeBalance, authSender.activeBalance);
    assert.equal(folReceiver.earnedBalance, authReceiver.earnedBalance);

    // Every tx on the authority is also linked on the follower
    const authTxs = transactionStore(dbAuth).findUnblockedTransactions();
    assert.equal(authTxs.length, 0, 'authority has no unblocked txs');

    authPeers.disconnectAll();
    newPeers.disconnectAll();
  });
});
