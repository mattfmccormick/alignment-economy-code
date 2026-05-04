// PeerManager-backed IBftTransport.
//
// The thin adapter that bridges Session 20's BftDriver to Session 8's
// signed-gossip wire layer. Concretely:
//
//   broadcastProposal(p) → peerManager.broadcast('proposal', p)
//   broadcastVote(v)     → peerManager.broadcast('prevote'|'precommit', v)
//   onProposal(handler)  → peerManager.on('proposal:received', ...)
//   onVote(handler)      → peerManager.on('prevote:received'|'precommit:received', ...)
//
// Two layers of authentication:
//   - Transport envelope (Session 8): publicKey + signature on the
//     NetworkMessage wrapper, replay-window enforced. peer.ts rejects
//     the message at the wire if either fails.
//   - Inner signature on the Proposal/Vote payload itself (Session 14
//     for votes, Session 18 for proposals). RoundController re-verifies
//     this when handling the event. Distinct canonical-bytes domain
//     prevents cross-confusion between the two signatures.
//
// Both signatures use the validator's Ed25519 P2P / node-identity key
// in the simple Phase-3-prep design — the dual-signature pattern still
// adds value because the canonical payloads differ, defending against
// any path that would let an attacker take a signed envelope and
// replay it as a different consensus message.

import type { PeerManager } from '../../network/peer.js';
import type { IBftTransport } from './bft-driver.js';
import type { Proposal } from './proposal.js';
import type { Vote } from './votes.js';

export class PeerManagerBftTransport implements IBftTransport {
  constructor(private readonly peerManager: PeerManager) {}

  broadcastProposal(p: Proposal): void {
    this.peerManager.broadcast('proposal', p as unknown as Record<string, unknown>);
  }

  broadcastVote(v: Vote): void {
    // Wire type matches the vote's kind so receivers can route without
    // peeking inside the payload.
    const messageType = v.kind === 'prevote' ? 'prevote' : 'precommit';
    this.peerManager.broadcast(messageType, v as unknown as Record<string, unknown>);
  }

  onProposal(handler: (p: Proposal) => void): void {
    this.peerManager.on('proposal:received', (data: unknown) => {
      handler(data as Proposal);
    });
  }

  onVote(handler: (v: Vote) => void): void {
    // Both prevotes and precommits funnel into the same handler. The
    // BftDriver dispatches based on vote.kind, so we don't need separate
    // routing here.
    this.peerManager.on('prevote:received', (data: unknown) => {
      handler(data as Vote);
    });
    this.peerManager.on('precommit:received', (data: unknown) => {
      handler(data as Vote);
    });
  }
}
