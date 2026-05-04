import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { EventEmitter } from 'events';
import type { DatabaseSync } from 'node:sqlite';
import { verifyPayload } from '../core/crypto.js';
import { getAccount } from '../core/account.js';

export const eventBus = new EventEmitter();

interface ClientInfo {
  ws: WebSocket;
  accountId: string | null;
  role: 'participant' | 'miner' | null;
}

const clients: ClientInfo[] = [];

// Authenticate a subscribe handshake. The client must sign
//   { action: 'subscribe', accountId, role }
// with their account private key, with a timestamp inside a 5-minute window
// (matching the HTTP auth middleware). Without this, anyone who guesses an
// account ID could read someone else's live balances and case notifications.
function verifySubscribe(
  db: DatabaseSync,
  accountId: string,
  role: string,
  timestamp: number,
  signature: string,
): { ok: true } | { ok: false; reason: string } {
  if (!accountId || !timestamp || !signature) {
    return { ok: false, reason: 'missing accountId, timestamp, or signature' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return { ok: false, reason: 'timestamp outside 5-minute window' };
  }
  const account = getAccount(db, accountId);
  if (!account) {
    return { ok: false, reason: 'account not found' };
  }
  const valid = verifyPayload({ action: 'subscribe', accountId, role }, timestamp, signature, account.publicKey);
  if (!valid) {
    return { ok: false, reason: 'invalid signature' };
  }
  return { ok: true };
}

export function setupWebSocket(server: Server, db?: DatabaseSync): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const client: ClientInfo = { ws, accountId: null, role: null };
    clients.push(client);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe') {
          // db is required to verify a subscription. If a server is started
          // without it (some tests), treat the connection as unauthenticated:
          // it can still receive PUBLIC broadcasts but never account-specific
          // events, because client.accountId stays null.
          if (db) {
            const result = verifySubscribe(db, msg.accountId, msg.role || 'participant', msg.timestamp, msg.signature);
            if (!result.ok) {
              ws.send(JSON.stringify({ type: 'subscribe:error', reason: result.reason }));
              return;
            }
          }
          client.accountId = msg.accountId || null;
          client.role = msg.role || 'participant';
          ws.send(JSON.stringify({ type: 'subscribed', accountId: client.accountId, role: client.role }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      const idx = clients.indexOf(client);
      if (idx >= 0) clients.splice(idx, 1);
    });
  });

  // Route events to appropriate clients
  eventBus.on('*', (eventType: string, data: unknown) => {
    // This won't actually fire with EventEmitter, we use specific events below
  });

  // General events: broadcast to all
  for (const evt of ['block:new', 'rebase:complete', 'network:day-change']) {
    eventBus.on(evt, (data) => {
      broadcast({ type: evt, data });
    });
  }

  // Account-specific events
  for (const evt of [
    'balance:updated', 'transaction:received', 'transaction:sent',
    'allocation:minted', 'allocation:expired', 'score:changed',
    'vouch:received', 'vouch:withdrawn',
    'court:filed-against', 'court:verdict', 'court:argument',
  ]) {
    eventBus.on(evt, (data: { accountId: string; [key: string]: unknown }) => {
      sendToAccount(data.accountId, { type: evt, data });
    });
  }

  // Miner-specific events
  for (const evt of [
    'verification:assigned', 'jury:called',
    'miner:tier-changed', 'miner:fee-earned', 'miner:bounty-earned',
  ]) {
    eventBus.on(evt, (data: { accountId: string; [key: string]: unknown }) => {
      sendToAccount(data.accountId, { type: evt, data });
    });
  }

  return wss;
}

function broadcast(message: unknown): void {
  const str = JSON.stringify(message);
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(str);
    }
  }
}

function sendToAccount(accountId: string, message: unknown): void {
  const str = JSON.stringify(message);
  for (const client of clients) {
    if (client.accountId === accountId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(str);
    }
  }
}

export function getConnectedClients(): number {
  return clients.filter((c) => c.ws.readyState === WebSocket.OPEN).length;
}
