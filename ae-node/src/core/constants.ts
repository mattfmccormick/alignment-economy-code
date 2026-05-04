// HARDCODED protocol constants. Cannot change without a hard fork.
// All point values stored as integer * PRECISION (8 decimal places, like BTC satoshis).

export const PRECISION = 100_000_000n; // 10^8 - one point = 100,000,000 base units

// Daily allocations (in base units)
export const DAILY_ACTIVE_POINTS = 144_000_000_000n;       // 1,440.00000000 points
export const DAILY_SUPPORTIVE_POINTS = 14_400_000_000n;     // 144.00000000 points
export const DAILY_AMBIENT_POINTS = 1_440_000_000n;          // 14.40000000 points

// Target earned balance per participant (for rebase)
export const TARGET_EARNED_PER_PERSON = 1_440_000_000_000n;  // 14,400.00000000 points

// Transaction fee in basis points (50 = 0.50%)
export const TRANSACTION_FEE_RATE = 50n;
export const FEE_DENOMINATOR = 10_000n;

// Protocol rules (boolean constants)
export const POINTS_EXPIRE_DAILY = true;
export const ONLY_INDIVIDUALS_RECEIVE_ALLOCATIONS = true;
export const EARNED_POINTS_SAVEABLE_WITHOUT_LIMIT = true;
