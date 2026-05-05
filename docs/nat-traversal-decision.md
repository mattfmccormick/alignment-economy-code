# NAT traversal: how AE nodes reach each other across home networks

Decision input for picking how the AE peer mesh forms over the public internet. Today the mesh works inside a LAN or a manual VPN (Tailscale, ZeroTier). The moment two friends on different home networks try to peer, neither side can dial the other directly because both are behind home-router NAT. This doc lays out the three candidate approaches, what each costs, and what we recommend.

This is the call to make before standing up the public bootstrap node. The bootstrap is one piece; this doc is the other piece.

## What the actual problem is

A typical home router does **NAT** (Network Address Translation): your laptop has a private LAN IP like `192.168.1.42` and the router has one public IP shared by every device in the house. Outbound connections work fine — the router remembers them and forwards return traffic. **Inbound connections don't:** if someone on the public internet tries to reach `your-public-ip:9000`, the router doesn't know which device on the LAN should receive it, so it drops the packet.

AE nodes need bidirectional peering: every validator listens on a P2P port (default 9000), and every other validator dials in. Behind home NAT, both sides try to dial, neither side accepts, and no connection forms.

LAN works because both nodes are on the same private subnet, no NAT in between. Tailscale works because every Tailscale device gets a routable WireGuard IP — Tailscale itself does the NAT punch on your behalf.

## The three candidate approaches

### Option A: Embed a tunneling client (Tailscale, ZeroTier, Nebula)

The wallet/miner ships with a tunneling client built in. On first launch, each user signs into the tunnel. From the AE node's perspective, every peer has a routable IP and the world looks like a flat LAN.

**Pros**
- Trivial protocol implementation. ae-node already works in this scenario; no peer.ts changes needed.
- Strong NAT traversal track record. Tailscale punches through almost every consumer NAT.
- Falls back to relays automatically when direct UDP punch fails.
- Encrypted by default (WireGuard), so even if our handshake had a bug, peer traffic stays private.

**Cons**
- Adds a third-party dependency in the install path. Users sign into Tailscale (or a self-hosted Headscale). That's a real account creation step we wanted to avoid in onboarding.
- Centralized coordination. Even with self-hosted Headscale, every node needs to register with a coordinator.
- Tailscale's free tier is capped at 100 devices (Tailscale's "Personal" plan). For a public AE testnet of more than a hundred nodes we'd need their paid tier or self-hosted Headscale.
- Conflicts with users who already use Tailscale for unrelated things — shared device limits, surprising routing.
- Bigger installer (Tailscale's Windows client is ~30 MB on top of our 107 MB).

**Cost**
- Engineering: 1-2 days to embed and ship.
- Ongoing: $0 if every user has a free Tailscale account; ~$60/user/year on paid tier; or run our own Headscale server (~$5/mo VPS).

### Option B: WebRTC peer connections + signaling server

Replace the raw WebSocket P2P transport with WebRTC `RTCPeerConnection`. WebRTC has STUN+TURN built in: nodes find their public address via STUN, attempt direct UDP connection, fall back to a TURN relay if NAT prevents direct.

**Pros**
- Zero user-side configuration. No accounts, no extra installs.
- Direct peer-to-peer when NAT allows (most home networks).
- Industry-standard NAT traversal (the same stack every video-call app uses).
- Encrypted by default (DTLS).

**Cons**
- Significant protocol surgery. The current `peer.ts` uses plain `ws` WebSocket. WebRTC's connection lifecycle is different (offer/answer SDP, ICE candidate exchange) and needs a signaling channel. You'd keep a thin WebSocket signaling server (could be the bootstrap node) and use WebRTC for the actual peer-to-peer data channels.
- Requires a TURN server for the ~10-20% of users behind symmetric NATs. Public TURN like Twilio costs per-bandwidth; self-hosted on a VPS is feasible (`coturn` is the standard package) but adds a moving part.
- WebRTC libraries in Node aren't as mature as in browsers. `wrtc` and `node-datachannel` exist; both add native compilation steps that complicate the cross-platform build.
- DTLS handshake adds latency vs. our current plain WebSocket.

**Cost**
- Engineering: 2-3 weeks to migrate the peer transport + add signaling, plus a few days to operate a TURN server.
- Ongoing: $5-10/mo for a coturn VPS. Bandwidth is the variable — if 20% of peers fall back to TURN and the network does meaningful tx volume, TURN bandwidth could become non-trivial. Scale-out story is "deploy more coturn instances behind a load balancer."

### Option C: Hosted relay (centralized fallback)

Run a relay server that every node connects to as a client. All P2P traffic flows through the relay. No direct peer-to-peer.

**Pros**
- Dead simple to ship. Each node opens a single outbound WebSocket to `relay.alignmenteconomy.org:443`. The relay forwards messages between connected clients. Outbound connections always work, so NAT is irrelevant.
- Reuses our existing WebSocket protocol — minimal code changes.
- Cheapest possible v1: one VPS, no TURN, no signing.

**Cons**
- Centralization. The relay sees every BFT message — block proposals, votes, gossip. Operator can drop messages, reorder them, or correlate which validators are talking. Defeats the "no central authority" property the AE is supposed to have.
- Single point of failure. Relay down → entire network down.
- Bandwidth scales linearly with network activity, all on one box (or load balancer).
- Bad story for funders: "decentralized economic protocol that runs through one server."

**Cost**
- Engineering: 1-2 days.
- Ongoing: $5-20/mo VPS, more if the network grows.

## Recommendation: B (WebRTC), with A (Tailscale) as the staged path

For mainnet: **Option B** (WebRTC + STUN + TURN fallback). Direct P2P with the relay only as a fallback for ~20% of users keeps the protocol genuinely peer-to-peer, encrypted, and aligned with the project's "no central coordinator" story. The TURN dependency is real but bounded — coturn is mature, well-documented, and operating one is similar effort to operating the bootstrap node.

For the immediate next milestone: **Option A** (Tailscale embedded) as a stepping stone. Reasons:

1. The current bottleneck isn't "we want to ship a fully decentralized internet network this week" — it's "we want a few testers to actually connect across home networks so they can use the wallet." Tailscale solves that in 1-2 days of work.
2. Embedding Tailscale doesn't lock us in. The peer transport is still WebSocket; the only thing Tailscale does is make every IP routable. Swapping to WebRTC later is the same protocol surgery whether peers are on Tailscale or raw internet.
3. Friends-and-family testing on Tailscale works fine for under 100 users with no payment. By the time we're past 100 testers, we'll have validated the protocol enough to justify the WebRTC migration cost.
4. **Avoid Option C.** The "one relay box" story is hostile to the project's positioning. Even as a v0 it sets the wrong expectation.

## Concrete next steps (recommended path A → B)

**Phase A1 — embed Tailscale (1-2 days):**
- Add a "Connect to AE testnet via Tailscale" panel to the wallet's first-launch picker. New users sign into Tailscale through the embedded auth flow, then the bootstrap node URL becomes their Tailscale-routable IP.
- Document the friend-onboarding flow: "Install wallet → log into Tailscale (provided link) → enter testnet → done."
- Self-host a Headscale instance instead of using Tailscale.com. Same protocol, no Tailscale account required, $5/mo VPS. (Tailscale CLI works against either.)

**Phase A2 — public bootstrap (1 day):**
- Stand up `bootstrap.alignmenteconomy.org` on a VPS. It's just an ae-node validator with a known address.
- Bake that address into the installer's "Join the AE testnet" button.

**Phase B — WebRTC migration (2-3 weeks, after testers are happy):**
- Add an `IPeerTransport` interface with the current WebSocket impl as the first implementation.
- Add a `WebRTCPeerTransport` that handles the RTCPeerConnection lifecycle, with the bootstrap node doubling as the signaling server.
- Stand up a TURN server (`coturn`) for symmetric-NAT fallback.
- Migrate peers gradually: nodes advertise both transports during handshake; the better one wins.

## Out-of-scope but worth noting

- **IPv6.** A growing fraction of consumer ISPs hand out routable IPv6 addresses, no NAT involved. Native IPv6 peer-to-peer would Just Work. Not currently exercised because most users still test from IPv4 networks, but worth keeping the door open by not hard-coding IPv4 anywhere in `peer.ts`.
- **mDNS / local discovery.** For LAN-only deployments (an office, a home) we could add Bonjour/mDNS so nodes find each other without any bootstrap address. Cheap to add. Doesn't help with internet peering but improves the "two laptops in the same house" UX.
- **Bridging existing P2P stacks.** libp2p has a mature NAT traversal layer (their `relay` and `autonat` modules). Adopting libp2p would solve traversal but is far bigger surgery than B and would commit AE to libp2p's wire format. Not recommended unless we want libp2p for unrelated reasons.
