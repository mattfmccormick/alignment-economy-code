// P2P transport seam.
//
// This file codifies the contract between the peering layer (handshake,
// gossip, sync, consensus traffic) and the wire underneath it. Today the wire
// is a raw `ws` WebSocket: `peer.ts` dials with `new WebSocket('ws://host:port')`
// and `node.ts` accepts inbound sockets via a `WebSocketServer`. That assumes a
// directly-reachable address, so two machines behind home routers can't peer.
//
// NAT traversal / a relay / a tunnel (WebRTC, a hosted relay, Tailscale, etc.)
// is the #1 deployment blocker, and this is exactly where it slots in: a
// deployment team implements `IPeerTransport` + `IPeerConnection` over their
// chosen wire and routes `PeerManager.connectToPeer` and `AENode`'s inbound
// path through it. Everything ABOVE this seam — the signed handshake in
// `messages.ts`, peer scoring/bans, block/vote gossip, and catch-up sync — is
// wire-agnostic and does not change.
//
// The surface below is deliberately the ENTIRE set of operations the peering
// code performs on a connection (verified against `peer.ts`: send, close,
// readyState, and the open/message/close/error events). Nothing reaches past
// it into `ws` internals, which is what makes the swap clean. The current
// `ws.WebSocket` already satisfies `IPeerConnection` structurally.

/**
 * A live, message-oriented link to a single peer. Messages are the signed
 * JSON envelopes produced by `createMessage` (serialized to a string on the
 * wire); ordering within a connection is assumed, as with TCP/WebSocket.
 */
export interface IPeerConnection {
  /** Send one serialized network message. */
  send(data: string): void;

  /**
   * Close the connection. Codes 4000-4004 carry handshake-rejection reasons
   * (see `validateHandshake`); lower codes are transport-level closes.
   */
  close(code?: number, reason?: string): void;

  /** Ready state, using the same constants as `ws` (OPEN === 1). */
  readonly readyState: number;

  /**
   * Subscribe to a connection lifecycle event:
   *  - 'open'    outbound dial completed (send the handshake here)
   *  - 'message' a frame arrived (the payload is passed to the listener)
   *  - 'close'   the link ended (code + reason may follow)
   *  - 'error'   a transport error (ECONNREFUSED, ENOTFOUND, …)
   */
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

/** OPEN readyState constant, matching `ws.WebSocket.OPEN`. */
export const CONNECTION_OPEN = 1;

/**
 * Establishes peer links over some wire. A NAT-traversal / relay
 * implementation provides this; the peering layer depends only on the two
 * interfaces here, never on `ws` directly.
 */
export interface IPeerTransport {
  /** Begin listening for inbound connections on `port`. */
  listen(port: number): Promise<void>;

  /**
   * Open an outbound connection to a reachable address. The returned
   * connection is not yet handshaken — the caller sends the handshake on the
   * 'open' event, exactly as `PeerManager.connectToPeer` does today.
   */
  dial(host: string, port: number): IPeerConnection;

  /**
   * Register the handler for inbound connections. Today this is fed by
   * `node.ts`'s `WebSocketServer` 'connection' event, which hands each socket
   * to `PeerManager.handleIncomingConnection`.
   */
  onConnection(handler: (conn: IPeerConnection, remoteAddress: string) => void): void;

  /** Stop listening and drop all inbound/outbound connections. */
  close(): Promise<void>;
}
