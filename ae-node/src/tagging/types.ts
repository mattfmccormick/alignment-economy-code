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

export type ContractType = 'supportive_auto' | 'ambient_auto' | 'active_standing';

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
