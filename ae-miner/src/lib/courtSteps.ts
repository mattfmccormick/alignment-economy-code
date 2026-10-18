// The court process as six steps, in two phases, seen from the miner's seats:
// the challenger who filed the case and the juror who decides it. The wallet
// has the same six steps from the defendant's seat (ae-app/src/lib/courtSteps.ts).
//
// The numbers here mirror ae-node's court defaults (src/config/defaults.ts):
// 1,440-point filing floor and withdrawal payout, 30-day refile cooldown,
// 7-day response, jury and voting windows, 7-day appeal window, 5% juror
// stake, 90% juror floor, 30-day no-show suspension, 20% bounty, 50% of a
// lost challenger stake to the defendant, 180-day protection window.

export type CourtStepId = 'filed' | 'respond' | 'jury' | 'vote' | 'verdict' | 'final';
export type CourtSeat = 'challenger' | 'juror' | 'observer';

export interface CourtStep {
  id: CourtStepId;
  /** Short label under the tracker dot. */
  label: string;
  phase: 'Arbitration' | 'Court';
  title: string;
  /** How long the step can take. */
  time: string;
  /** What happens, in plain words. */
  points: string[];
  /** What it means for you, by seat. */
  forYou: Record<CourtSeat, string>;
}

export const COURT_STEPS: CourtStep[] = [
  {
    id: 'filed',
    label: 'Filed',
    phase: 'Arbitration',
    title: 'Challenge filed',
    time: 'Day 0',
    points: [
      "A miner says an account isn't a real, unique person, and stakes at least 1,440 of their own points on it.",
      "The defendant's earned points freeze right away. Their daily points still work.",
    ],
    forYou: {
      challenger: 'Your stake is locked. You get it back if the jury agrees with you.',
      juror: 'Jurors are not involved yet.',
      observer: 'Anyone can read the case. Only the two sides can post.',
    },
  },
  {
    id: 'respond',
    label: 'Respond',
    phase: 'Arbitration',
    title: 'The defendant answers',
    time: 'Up to 7 days',
    points: [
      'The defendant tells their side: text, photos, documents, a voice clip, and an offer to do a live call or meet in person.',
      'Both sides can keep posting until the verdict.',
      'On day 7 it goes to a jury. The defendant can ask for one sooner.',
    ],
    forYou: {
      challenger:
        "If their answer convinces you, withdraw. 1,440 of your stake goes to them, the rest comes back, and you can't refile against them for 30 days.",
      juror: "Jurors aren't drawn until this step ends.",
      observer: "Jurors aren't drawn until this step ends.",
    },
  },
  {
    id: 'jury',
    label: 'Jury',
    phase: 'Court',
    title: 'A jury is picked',
    time: 'Up to 7 days',
    points: [
      '3 to 11 verified people are drawn at random, more as the network grows. Each is at least 90% human and gets one seat. Neither side can sit.',
      'Each juror stakes 5% of their own savings to sit.',
      'No jury in 7 days? The case is dismissed and every stake goes back.',
    ],
    forYou: {
      challenger: "You can't pick the jury. The list is public once it's seated.",
      juror: "You were drawn. 5% of your savings is staked on this case until it's final.",
      observer: "If you're 90%+ human, you could be drawn for a case like this.",
    },
  },
  {
    id: 'vote',
    label: 'Vote',
    phase: 'Court',
    title: 'The jury votes',
    time: 'Up to 7 days',
    points: [
      'Jurors read both sides, then vote: human or not human.',
      'Votes stay sealed until every juror has voted.',
    ],
    forYou: {
      challenger: 'You can keep adding evidence until the verdict.',
      juror: "Read both sides, then vote. Don't vote and you lose your stake and sit out of juries for 30 days.",
      observer: 'Votes stay sealed until every juror has voted.',
    },
  },
  {
    id: 'verdict',
    label: 'Verdict',
    phase: 'Court',
    title: 'Verdict and appeal',
    time: '7 days to appeal',
    points: [
      'Majority wins. No majority dismisses the case.',
      'Nothing moves yet. The side that lost has 7 days to appeal to a fresh jury of the same size. One appeal per case.',
    ],
    forYou: {
      challenger: 'If the jury says human, you can appeal from this step.',
      juror: "Your stake stays locked until the case is final, appeal included.",
      observer: 'Nothing moves until the appeal window closes.',
    },
  },
  {
    id: 'final',
    label: 'Final',
    phase: 'Court',
    title: 'Case settled',
    time: 'After the appeal window',
    points: [
      'Not human: the account closes. 20% of its savings go to the challenger and the rest is burned.',
      'Human: the freeze lifts. The challenger loses their stake (half to the defendant, the rest burned), and the defendant is protected for 180 days.',
    ],
    forYou: {
      challenger: 'Win: your stake back plus 20% of their savings. Lose: you lose your stake.',
      juror:
        "Vote with the final verdict: your stake back plus a share of the stakes of jurors who didn't. Vote against it or skip: you lose your stake.",
      observer: "Jurors who voted with the final verdict get their stake back plus a share of the others'.",
    },
  },
];

export function stepIndex(id: CourtStepId): number {
  return COURT_STEPS.findIndex((s) => s.id === id);
}

export interface CaseProgress {
  /** The step the case is on now (or was on when it ended early). */
  current: CourtStepId;
  /** Set when the case closed before a final verdict. */
  endedEarly: 'withdrawn' | 'dismissed' | null;
}

/** Where a case is, from its status. */
export function caseProgress(status: string): CaseProgress {
  switch (status) {
    case 'arbitration_open':
    case 'arbitration_response':
      return { current: 'respond', endedEarly: null };
    case 'withdrawn':
      return { current: 'respond', endedEarly: 'withdrawn' };
    case 'court_open':
    case 'court_waiting_jury':
      return { current: 'jury', endedEarly: null };
    case 'dismissed':
      return { current: 'jury', endedEarly: 'dismissed' };
    case 'court_voting':
      return { current: 'vote', endedEarly: null };
    case 'verdict_pending':
    case 'appeal_open':
    case 'appeal_voting':
      return { current: 'verdict', endedEarly: null };
    default:
      // court_verdict, appeal_verdict, closed
      return { current: 'final', endedEarly: null };
  }
}

/** "Step 2 of 6: Respond", or how the case closed early. */
export function whereLabel(status: string): string {
  const p = caseProgress(status);
  if (p.endedEarly === 'withdrawn') return 'Closed: challenger withdrew';
  if (p.endedEarly === 'dismissed') return 'Closed: dismissed';
  const i = stepIndex(p.current);
  return `Step ${i + 1} of 6: ${COURT_STEPS[i].label}`;
}

/** What the claim is, in plain words, finishing "The challenger ..." */
export function claimText(caseType: string): string {
  return caseType === 'duplicate_account'
    ? 'says this is a second account of a person who already has one.'
    : 'says no real, unique person is behind this account.';
}

// The filing floor, 1,440 points, in base units (8 decimals).
const STAKE_FLOOR_BASE_UNITS = 144_000_000_000n;

/** "(5%)", or "(the 1,440 minimum)" when the chosen percentage came in under the floor. */
export function stakeNote(stake: string, percent: number | null | undefined): string {
  try {
    if (BigInt(stake) === STAKE_FLOOR_BASE_UNITS) return '(the 1,440 minimum)';
  } catch {
    // not an integer string; fall through to the percentage
  }
  return percent != null ? `(${percent}%)` : '';
}
