import type { PeerManager } from './peer.js';
import { isDialable, normalizeHost } from './peer.js';

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
    // Never remember an address we cannot dial. Port 0 arrives here through
    // peer exchange (it is how a peer that connected TO us gets recorded) and
    // would otherwise sit in knownAddresses forever, burning a reconnect
    // attempt every interval while genuinely reachable peers went unconnected.
    if (!isDialable(host, port)) return;
    const normalized = normalizeHost(host);
    const key = `${normalized}:${port}`;
    if (!this.knownAddresses.has(key)) {
      this.knownAddresses.set(key, { host: normalized, port, lastAttempt: 0 });
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
    // Also match on bare host.
    //
    // The host:port check alone never matches an INBOUND peer: we record such a
    // peer with its ephemeral source port (…:54073), because the handshake does
    // not advertise a listen port, while the address we would redial is the
    // configured one (…:9000). A node already connected to us therefore looked
    // unconnected, and we redialled it every interval forever — each dial
    // leaving another live socket behind. 33 connections between two machines
    // before this was caught, still climbing.
    //
    // "One node per host" is an assumption, and it is wrong for several nodes
    // on one machine. Those are dedupd by the exact host:port check above,
    // which does match for outbound connections, so this only changes behaviour
    // for the inbound case it is meant to fix.
    const connectedBareHosts = new Set(connectedPeers.map((p) => p.host));

    const now = Date.now();
    for (const [key, addr] of this.knownAddresses) {
      if (connectedCount >= this.config.minPeers) break;
      if (connectedHosts.has(key)) continue;
      if (connectedBareHosts.has(addr.host)) continue;
      // Don't retry too frequently
      if (now - addr.lastAttempt < this.config.reconnectInterval) continue;

      addr.lastAttempt = now;
      this.peerManager.connectToPeer(addr.host, addr.port);
    }
  }
}
