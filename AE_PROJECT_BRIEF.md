# AE Platform - Detailed Project Brief

## Organization

The Alignment Economy is structured as a 501(c)(3) nonprofit. Funding comes through grants and direct contributions (including crypto). There is no equity, no token sale, and no ICO. This is a public good, not a startup.

The narrative document is called "The Bridge" (currently at v7). It tells the story of the AE through a character named Francisco who builds the system. The white paper covers the technical and economic mechanics. Both exist and can be referenced but are not part of this codebase.

## The Problem Statement (for landing page / onboarding copy)

Money is broken. The dollar has lost 96% of its purchasing power since 1913. Bitcoin was supposed to fix it, but two fatal paradoxes mean nobody actually spends it:

1. **First-mover advantage:** Early adopters got rich, latecomers pay a premium. Same inequality, different wrapper.
2. **Deflation paradox:** If the currency always goes up in value, rational actors hoard it. A currency nobody spends isn't a currency.

Stablecoins are just faster plumbing for the same broken pipes (electronic fiat).

Now add AI: white collar jobs disappearing, governments responding with more stimulus, more printing, more inflation. The people with assets ride it out. Everyone else gets crushed. It's a doom loop with no exit.

The AE is the exit.

## Five Design Requirements

The AE white paper establishes five requirements any successor system must meet:

1. **No central authority can manipulate supply** (no king diluting coins, no central bank printing)
2. **No first-mover advantage** (joining day one or year ten gives you the same footing)
3. **No deflation trap** (the system must incentivize spending, not hoarding)
4. **Invisible labor must become visible** (caregiving, teaching, community work show up in the ledger)
5. **The measuring stick must measure what actually matters** (durability, presence, human connection, not just extraction and clicks)

## Key Conceptual Frameworks

These ideas run through the project and should inform UI language and design:

- **Higher Mind vs Primitive Mind:** Technology is neutral. It amplifies whichever mind controls it. The Primitive Mind hoards, extracts, manipulates. The Higher Mind builds, creates, connects. The AE is designed by the Higher Mind before the Primitive Mind can capture it.
- **Entropy as the real enemy:** Everything falls apart if no one pays attention. Food rots, bridges rust, knowledge gets lost, relationships break down. The economy should direct human attention toward fighting entropy, not toward fighting each other.
- **The Infinite Game:** The goal isn't to build the last system. The goal is to keep building. Capture lasted thousands of years. Convincing lasted decades. Coordination will last as long as it works, and when it doesn't, someone builds the next bridge.
- **Maslow's Hierarchy:** Old systems only measured the bottom of the pyramid (food, shelter, safety). The AE measures higher needs too (belonging, purpose, self-actualization) by making caregiving, teaching, and community-building economically visible.

## Detailed Point Flow Mechanics

### Active Points (the daily heartbeat)
- 1,440 per person per day (one per minute as a conceptual frame)
- Expire every 24 hours
- Spent freely: buy things, pay for services, send to family, support someone's work
- Cannot be saved, hoarded, or speculated on
- The expiration is the core anti-hoarding mechanism

### Supportive Points (rewarding durability)
- 144 per person per day
- Flow to objects/goods the person is actively using
- Tracked via registration (user registers their durable goods)
- Longer an object stays in active use = more total earnings for its maker
- Incentivizes building things that last, directly countering planned obsolescence

### Ambient Points (replacing taxation)
- 14.4 per person per day
- Flow to physical spaces the person occupies
- A well-maintained park earns more than a neglected one
- A city people move to earns more than one people flee
- Governance gets a direct, real-time signal: make your space worth being in or lose funding
- This replaces income-based taxation with presence-based funding

### Earned Points (making invisible labor visible)
- Created when one person sends points to another
- CAN be saved without limit (this is the store-of-value layer)
- A mother raising children receives Active points like everyone, but when her spouse or community sends points to her, her caregiving appears in the economy for the first time
- The night nurse holding a dying patient's hand at 3 AM, her work finally shows up in the ledger

### The Rebase (preventing inflation and deflation)
- Daily adjustment across all accounts
- Keeps everyone's share of total economy constant as population changes
- Your number might change, your purchasing power doesn't
- Combined with daily allocation, eliminates both Bitcoin paradoxes

## Proof of Human (Mining System)

### How Percent-Human Score Works
- Every account has a score from 0% to 100%
- Higher score = higher daily point allocation (scaled proportionally)
- Score is built through multiple verification methods (layered, not all-or-nothing):
  - Biometric verification
  - Government ID verification
  - Social vouching (other verified humans stake their own points)
- Ten people vouching (putting their points at risk) can bring someone to full participation without a single document
- If someone you vouched for turns out to be fake, you lose your staked points (skin in the game)

### What Miners Do
- Review verification submissions
- Cross-reference biometric data
- Evaluate vouching chains for integrity
- Flag suspicious patterns (one person running many accounts, etc.)
- Get rewarded for accurate verification, penalized for errors

## Court / Dispute Resolution System

### Types of Disputes
- Identity challenges (someone believes an account is fake or duplicate)
- Vouching disputes (a voucher wants to revoke, or a vouchee contests a revocation)
- Point flow disputes (goods or spaces not receiving proper flows)
- Fraud cases (coordinated fake account rings, point manipulation)

### How Courts Work
- Disputes enter a queue
- Randomly assigned panel of verified arbitrators (high percent-human score required)
- Both sides submit evidence
- Panel reviews and rules
- Rulings create precedent (searchable database)
- Appeals process available
- Arbitrators earn points for service, lose reputation for overturned rulings

## UI/UX Direction

- Clean, modern, trustworthy (this is a financial system, it needs to feel solid)
- Not crypto-bro aesthetic. Not fintech-startup aesthetic. Think "public infrastructure for the future"
- Warm but serious. This handles people's livelihoods.
- Dashboard-heavy (people need to see their points, flows, and activity clearly)
- Mobile-first thinking (many potential users won't have desktop access)
- The language should be human and clear, not jargon-heavy

## Build Priority Order

1. **Landing page** (explain the AE, link to The Bridge, call to action to join)
2. **User dashboard** (the core experience: see your points, send/receive, manage goods and spaces)
3. **Onboarding/verification flow** (how someone goes from 0% to verified)
4. **Miner interface** (verification queue and tools)
5. **Court interface** (dispute resolution)
6. **Admin dashboard** (protocol health, rebase visualization, network stats)

Start with mock data everywhere. The goal right now is a visual, interactive prototype that communicates the full vision. Real blockchain/verification integration comes later.
