import { signPayload } from './crypto';
import { loadWallet } from './keys';

type EventHandler = (data: any) => void;

class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private accountId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  connect(accountId: string) {
    this.accountId = accountId;
    // In Vite dev, talk to the dev server which proxies /ws to localhost:3000.
    // In production / Electron (file:// origin), window.location.host is empty,
    // so honor the build-time VITE_WS_URL pointing at the real backend.
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
        // Sign the subscribe so the server knows the connecting client really
        // holds this account's key. Without this, anyone who guesses an ID
        // could read someone else's live balance and case events.
        const wallet = loadWallet();
        if (!wallet?.privateKey || wallet.accountId !== accountId) {
          this.ws?.close();
          return;
        }
        const role = 'participant';
        const ts = Math.floor(Date.now() / 1000);
        const signature = signPayload({ action: 'subscribe', accountId, role }, ts, wallet.privateKey);
        this.ws?.send(JSON.stringify({ type: 'subscribe', accountId, role, timestamp: ts, signature }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const handlers = this.handlers.get(msg.type);
          if (handlers) {
            for (const handler of handlers) handler(msg.data);
          }
        } catch { /* ignore */ }
      };

      this.ws.onclose = () => {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
          if (this.accountId) this.connect(this.accountId);
        }, this.reconnectDelay);
      };
    } catch { /* ignore */ }
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
    this.accountId = null;
  }
}

export const wsClient = new WSClient();
