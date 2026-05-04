import type { PeerManager } from './peer.js';

export interface DiscoveryConfig {
  seedNodes: Array<{ host: string; port: number }>;
  peerExchangeInterval: number; // ms between peer exchange rounds
  reconnectInterval: number;    // ms between reconnect attempts
  minPeers: number;             // try to maintain at least this many
}

const DEFAULT_CONFIG: DiscoveryConfig = {
  seedNodes: [],
  peerExchangeInterval: 60_000,  // 1 min
  reconnectInterval: 30_000,     // 30s
  minPeers: 3,
};

export class PeerDiscovery {
  private peerManager: PeerManager;
  private config: DiscoveryConfig;
  private knownAddresses = new Map<string, { host: string; port: number; lastAttempt: number }>();
  private exchangeTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;

  constructor(peerManager: PeerManager, config: Partial<DiscoveryConfig> = {}) {
    this.peerManager = peerManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.setupListeners();
  }

  /** Connect to seed nodes and start periodic peer exchange */
  start(): void {
    // Connect to seed nodes
    for (const seed of this.config.seedNodes) {
      this.addAddress(seed.host, seed.port);
      this.peerManager.connectToPeer(seed.host, seed.port);
    }

    // Periodic peer exchange
    this.exchangeTimer = setInterval(() => {
      this.peerManager.requestPeers();
    }, this.config.peerExchangeInterval);

    // Periodic reconnect to maintain minimum peers
    this.reconnectTimer = setInterval(() => {
      this.maintainConnections();
    }, this.config.reconnectInterval);
  }

  stop(): void {
    if (this.exchangeTimer) {
      clearInterval(this.exchangeTimer);
      this.exchangeTimer = null;
    }
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  addAddress(host: string, port: number): void {
    const key = `${host}:${port}`;
    if (!this.knownAddresses.has(key)) {
      this.knownAddresses.set(key, { host, port, lastAttempt: 0 });
    }
  }

  getKnownAddresses(): Array<{ host: string; port: number }> {
    return Array.from(this.knownAddresses.values()).map(({ host, port }) => ({ host, port }));
  }

  private setupListeners(): void {
    // When we receive a peer list from another node, add new addresses
    this.peerManager.on('peers:discovered', (peerList: Array<{ host: string; port: number; nodeId: string }>) => {
      for (const peer of peerList) {
        if (peer.nodeId === this.peerManager.getNodeId()) continue; // skip self
        this.addAddress(peer.host, peer.port);
      }
      // Try connecting to new peers if below minimum
      this.maintainConnections();
    });
  }

  private maintainConnections(): void {
    const connectedCount = this.peerManager.getPeerCount();
    if (connectedCount >= this.config.minPeers) return;

    const connectedPeers = this.peerManager.getConnectedPeers();
    const connectedHosts = new Set(connectedPeers.map((p) => `${p.host}:${p.port}`));

    const now = Date.now();
    for (const [key, addr] of this.knownAddresses) {
      if (connectedCount >= this.config.minPeers) break;
      if (connectedHosts.has(key)) continue;
      // Don't retry too frequently
      if (now - addr.lastAttempt < this.config.reconnectInterval) continue;

      addr.lastAttempt = now;
      this.peerManager.connectToPeer(addr.host, addr.port);
    }
  }
}
