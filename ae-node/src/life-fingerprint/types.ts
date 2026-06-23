export interface Transaction {
  sender: string;
  receiver: string;
  amount: number;
  timestamp: number;
  location?: {
    lat: number;
    lng: number;
    terminalId: string;
  };
}

export interface TemporalCorrelation {
  accountId: string;
  score: number;
}

export interface GeoOverlap {
  accountId: string;
  sharedClusters: number;
}

export interface LifeScore {
  accountId: string;
  diversity30d: number;
  diversity90d: number;
  diversity180d: number;
  concentration: number;
  reciprocity: number;
  clustering: number;
  circularRatio: number;
  temporalCorrelation: TemporalCorrelation | null;
  geoClusters: number;
  geoOverlap: GeoOverlap | null;
  dailyVelocityAvg: number;
  ageRichnessRatio: number;
  composite: number;
  flags: string[];
  tier: number;
}

export interface Thresholds {
  diversity: {
    under30d: number;
    under90d: number;
    under180d: number;
    over180d: number;
  };
  concentration: number;
  reciprocity: number;
  velocityMultiplier: number;
  dailyAllocation: number;
  ageRichnessRatio: number;
  clustering: number;
  temporalSimilarity: number;
  geoClusterRadiusKm: number;
  geoClusterMinPoints: number;
  geoOverlapRadiusKm: number;
  circularRatio: number;
  circularMaxHops: number;
  compositeFlag: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  diversity: {
    under30d: 3,
    under90d: 10,
    under180d: 25,
    over180d: 40,
  },
  concentration: 0.70,
  reciprocity: 0.65,
  velocityMultiplier: 5,
  dailyAllocation: 1440,
  ageRichnessRatio: 0.3,
  clustering: 0.40,
  temporalSimilarity: 0.85,
  geoClusterRadiusKm: 2,
  geoClusterMinPoints: 3,
  geoOverlapRadiusKm: 0.5,
  circularRatio: 0.30,
  circularMaxHops: 4,
  compositeFlag: 0.40,
};

export const COMPOSITE_WEIGHTS = {
  diversity: 0.15,
  concentration: 0.10,
  reciprocity: 0.10,
  clustering: 0.20,
  circular: 0.15,
  temporal: 0.10,
  geographic: 0.10,
  velocity: 0.05,
  ageRichness: 0.05,
};

export interface AccountMeta {
  accountId: string;
  createdAt: number;
}
