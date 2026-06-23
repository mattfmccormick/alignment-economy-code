import {
  LifeScore,
  COMPOSITE_WEIGHTS,
  Thresholds,
  DEFAULT_THRESHOLDS,
} from './types.js';
import { Tier1Result, diversityThreshold } from './tier1.js';
import { Tier2Result } from './tier2.js';
import { Tier3Result } from './tier3.js';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function scoreDiversity(
  d90: number,
  ageDays: number,
  t: Thresholds
): number {
  const threshold = diversityThreshold(ageDays, t);
  if (d90 >= threshold * 2) return 1;
  return clamp01(d90 / (threshold * 2));
}

function scoreConcentration(conc: number): number {
  return clamp01(1 - conc);
}

function scoreReciprocity(recip: number): number {
  if (recip <= 0.30) return 1;
  if (recip >= 0.80) return 0;
  return clamp01(1 - (recip - 0.30) / 0.50);
}

function scoreClustering(cc: number): number {
  if (cc <= 0.10) return 1;
  if (cc >= 0.60) return 0;
  return clamp01(1 - (cc - 0.10) / 0.50);
}

function scoreCircular(ratio: number): number {
  if (ratio <= 0.05) return 1;
  if (ratio >= 0.50) return 0;
  return clamp01(1 - (ratio - 0.05) / 0.45);
}

function scoreTemporal(corr: { score: number } | null): number {
  if (!corr) return 1;
  if (corr.score <= 0.60) return 1;
  if (corr.score >= 0.95) return 0;
  return clamp01(1 - (corr.score - 0.60) / 0.35);
}

function scoreGeographic(clusters: number, overlap: { sharedClusters: number } | null): number {
  let s = 1;
  if (clusters === 0) s = 0.5;
  else if (clusters === 1) s = 0.6;
  else if (clusters >= 2 && clusters <= 4) s = 1;
  else s = 0.8;
  if (overlap && overlap.sharedClusters > 0) {
    s *= 0.3;
  }
  return clamp01(s);
}

function scoreVelocity(
  dailyAvg: number,
  t: Thresholds
): number {
  const max = t.velocityMultiplier * t.dailyAllocation;
  if (dailyAvg <= max * 0.5) return 1;
  if (dailyAvg >= max * 2) return 0;
  return clamp01(1 - (dailyAvg - max * 0.5) / (max * 1.5));
}

function scoreAgeRichness(ratio: number): number {
  if (ratio >= 1) return 1;
  return clamp01(ratio);
}

export function computeComposite(
  tier1: Tier1Result,
  tier2: Tier2Result | null,
  tier3: Tier3Result | null,
  ageDays: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): number {
  const w = COMPOSITE_WEIGHTS;

  const divScore = scoreDiversity(tier1.diversity90d, ageDays, thresholds);
  const concScore = scoreConcentration(tier1.concentration);
  const recipScore = scoreReciprocity(tier1.reciprocity);
  const velScore = scoreVelocity(tier1.dailyVelocityAvg, thresholds);
  const ageScore = scoreAgeRichness(tier1.ageRichnessRatio);

  const clusterScore = tier2 ? scoreClustering(tier2.clustering) : 0.5;
  const tempScore = tier2 ? scoreTemporal(tier2.temporalCorrelation) : 0.5;
  const geoScore = tier2
    ? scoreGeographic(tier2.geoClusters, tier2.geoOverlap)
    : 0.5;

  const circScore = tier3 ? scoreCircular(tier3.circularRatio) : 0.5;

  return clamp01(
    divScore * w.diversity +
      concScore * w.concentration +
      recipScore * w.reciprocity +
      clusterScore * w.clustering +
      circScore * w.circular +
      tempScore * w.temporal +
      geoScore * w.geographic +
      velScore * w.velocity +
      ageScore * w.ageRichness
  );
}

export function assembleLifeScore(
  accountId: string,
  tier1: Tier1Result,
  tier2: Tier2Result | null,
  tier3: Tier3Result | null,
  ageDays: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): LifeScore {
  const allFlags = [
    ...tier1.flags,
    ...(tier2?.flags ?? []),
    ...(tier3?.flags ?? []),
  ];

  let tier = 1;
  if (tier2) tier = 2;
  if (tier3) tier = 3;

  return {
    accountId,
    diversity30d: tier1.diversity30d,
    diversity90d: tier1.diversity90d,
    diversity180d: tier1.diversity180d,
    concentration: tier1.concentration,
    reciprocity: tier1.reciprocity,
    clustering: tier2?.clustering ?? 0,
    circularRatio: tier3?.circularRatio ?? 0,
    temporalCorrelation: tier2?.temporalCorrelation ?? null,
    geoClusters: tier2?.geoClusters ?? 0,
    geoOverlap: tier2?.geoOverlap ?? null,
    dailyVelocityAvg: tier1.dailyVelocityAvg,
    ageRichnessRatio: tier1.ageRichnessRatio,
    composite: computeComposite(tier1, tier2, tier3, ageDays, thresholds),
    flags: allFlags,
    tier,
  };
}
