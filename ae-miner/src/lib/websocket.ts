import { signPayload } from './crypto';
import { loadMinerWallet } from './keys';

type EventHandler = (data: unknown) => void;

class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private minerId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  connect(minerId: string) {
    this.minerId = minerId;
    const buildTimeUrl = import.meta.env.VITE_WS_URL as string | undefined;
    let url: string;
    if (buildTimeUrl) {
      url = buildTimeUrl;
    } else if (window.location.protocol === 'file:') {
      url = 'ws://localhost:3000/ws';
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url = `${protocol}//${window.location.host}/ws`;
    }

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
        // Sign the subscribe so the server knows we hold the miner's key.
        // Without this, anyone who guesses an account ID could read this
        // miner's verification queue, jury summons, and bounty notifications.
        const wallet = loadMinerWallet();
        if (!wallet?.privateKey || wallet.accountId !== minerId) {
          this.ws?.close();
          return;
        }
        const role = 'miner';
        const ts = Math.floor(Date.now() / 1000);
        const signature = signPayload({ action: 'subscribe', accountId: minerId, role }, ts, wallet.privateKey);
        this.ws?.send(JSON.stringify({ type: 'subscribe', accountId: minerId, role, timestamp: ts, signature }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const handlers = this.handlers.get(msg.type);
          if (handlers) {
            for (const handler of handlers) handler(msg.data);
          }
        } catch { /* ignore parse errors */ }
      };

      this.ws.onclose = () => {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
          if (this.minerId) this.connect(this.minerId);
        }, this.reconnectDelay);
      };
    } catch { /* ignore connection errors */ }
  }

  on(event: string, handler: EventHandler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.minerId = null;
  }
}

export const wsClient = new WSClient();
