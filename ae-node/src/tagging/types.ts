export interface Product {
  id: string;
  name: string;
  category: string;
  manufacturerId: string | null;
  createdBy: string;
  isActive: boolean;
  createdAt: number;
}

export type SpaceType = 'room' | 'building' | 'park' | 'road' | 'transit' | 'city' | 'state' | 'nation' | 'custom';

export interface Space {
  id: string;
  name: string;
  type: SpaceType;
  parentId: string | null;
  entityId: string | null;
  collectionRate: number;
  isActive: boolean;
  createdAt: number;
}

export interface SupportiveTag {
  id: string;
  accountId: string;
  day: number;
  productId: string;
  minutesUsed: number;
  pointsAllocated: bigint;
  status: 'active' | 'finalized';
}

export interface AmbientTag {
  id: string;
  accountId: string;
  day: number;
  spaceId: string;
  minutesOccupied: number;
  pointsAllocated: bigint;
  status: 'active' | 'finalized';
}

/**
 * Smart contract types — the protocol's user-configurable automation layer
 * for recurring tagging + standing transfers per whitepaper §5.
 *
 *   supportive_auto:  every day on schedule, auto-tag a product with
 *                     contract.allocationPercent of the account's daily
 *                     supportive minutes (start_minute → end_minute, or
 *                     full day if both null).
 *   ambient_auto:     same shape as supportive_auto but for ambient/space.
 *   active_standing:  every day on schedule, send allocationPercent of
 *                     the account's daily active balance to targetId.
 *                     The receiver gets earned points; the standard 0.5%
 *                     fee applies. Useful for "all my active points to my
 *                     spouse" / "10% to a community fund every weekday."
 *   earned_recurring: every day on schedule, transfer a FIXED display
 *                     amount of earned points to targetId. Encoded in
 *                     allocationPercent as the number of points (NOT a
 *                     percentage); this lets the existing column handle
 *                     it without a schema bump. Skipped if balance is
 *                     short — the contract doesn't accumulate IOUs.
 *
 * Adding a fifth or sixth type stays additive: extend this union, add a
 * case to executeContracts, and a test in phase6 / phase70.
 */
export type ContractType = 'supportive_auto' | 'ambient_auto' | 'active_standing' | 'earned_recurring';

export interface SmartContract {
  id: string;
  accountId: string;
  type: ContractType;
  targetId: string;
  schedule: 'daily' | 'weekday' | 'weekend' | 'custom';
  startMinute: number | null;
  endMinute: number | null;
  daysOfWeek: number[] | null;
  allocationPercent: number;
  isActive: boolean;
  overriddenToday: boolean;
  createdAt: number;
}
