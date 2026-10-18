// The court process as six steps, in two phases, so a person pulled into court
// can see where they are and what comes next (a delivery tracker for a case).
//
// The numbers here mirror ae-node's court defaults (src/config/defaults.ts):
// 7-day response, jury and voting windows, 7-day appeal window, 1,440-point
// withdrawal floor, 5% juror stake, 90% juror floor, 20% bounty, 50% of a
// forfeited challenger stake to the defendant, 180-day protection window.

export type CourtStepId = 'filed' | 'respond' | 'jury' | 'vote' | 'verdict' | 'final';

export interface CourtStep {
  id: CourtStepId;
  /** Short label under the tracker dot. */
  label: string;
  phase: 'Arbitration' | 'Court';
  title: string;
  /** How long the step can take. */
  time: string;
  /** What happens, in plain words, one line each. */
  points: string[];
}

export const COURT_STEPS: CourtStep[] = [
  {
    id: 'filed',
    label: 'Filed',
    phase: 'Arbitration',
    title: 'Challenge filed',
    time: 'Day 0',
    points: [
      "A miner says this account isn't a real, unique person, and stakes their own points on it.",
      'Your earned points freeze right away. Daily points still work.',
    ],
  },
  {
    id: 'respond',
    label: 'Respond',
    phase: 'Arbitration',
    title: 'Tell your side',
    time: 'Up to 7 days',
    points: [
      'Read what they say, then answer. Add photos, documents or a voice clip, and offer a live call or to meet in person.',
      'If you convince the challenger, they can drop the case. You get 1,440 of their points for the trouble.',
      'On day 7 it goes to a jury. You can ask for one sooner.',
    ],
  },
  {
    id: 'jury',
    label: 'Jury',
    phase: 'Court',
    title: 'A jury is picked',
    time: 'Up to 7 days',
    points: [
      '3 to 11 verified people are drawn at random, more as the network grows. Each is at least 90% human and gets one seat.',
      'Each juror stakes 5% of their own savings to sit.',
      'No jury in 7 days? The case is dismissed and everyone gets their stake back.',
    ],
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
      'You can keep adding to your side until the verdict.',
    ],
  },
  {
    id: 'verdict',
    label: 'Verdict',
    phase: 'Court',
    title: 'Verdict and appeal',
    time: '7 days to appeal',
    points: [
      'Majority wins. No majority dismisses the case.',
      'Nothing moves yet. Either side has 7 days to appeal to a fresh jury of the same size. One appeal per case.',
    ],
  },
  {
    id: 'final',
    label: 'Final',
    phase: 'Court',
    title: 'Case settled',
    time: 'After the appeal window',
    points: [
      "Found human: your freeze lifts, you get half the challenger's stake, and nobody can challenge you for 180 days.",
      'Found not human: the account closes. 20% of its savings go to the challenger and the rest is burned.',
      "Jurors who voted with the final verdict get their stake back plus a share of the others'.",
    ],
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

/** What the challenger claims, in plain words. */
export function claimText(caseType: string): string {
  return caseType === 'duplicate_account'
    ? 'says this is a second account of a person who already has one.'
    : "says no real, unique person is behind this account.";
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
