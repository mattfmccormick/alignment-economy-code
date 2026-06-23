import { LifeScore, Thresholds, DEFAULT_THRESHOLDS } from './types.js';
import { diversityThreshold } from './tier1.js';

function badge(actual: number, good: number, bad: number, lowerIsBetter = false): string {
  if (lowerIsBetter) {
    if (actual <= good) return '  ';
    if (actual >= bad) return '\u{1F534}';
    return '\u{26A0}\u{FE0F}';
  }
  if (actual >= good) return '  ';
  if (actual <= bad) return '\u{1F534}';
  return '\u{26A0}\u{FE0F}';
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

export function formatDashboard(
  score: LifeScore,
  ageDays: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): string {
  const id = score.accountId.length > 8
    ? score.accountId.slice(0, 5) + '...'
    : score.accountId;

  const ageLabel =
    ageDays < 30
      ? `${ageDays} days`
      : ageDays < 365
        ? `${Math.floor(ageDays / 30)} months`
        : `${(ageDays / 365).toFixed(1)} years`;

  const divThresh = diversityThreshold(ageDays, thresholds);

  const lines: string[] = [];
  lines.push(
    `Account #${id}  |  Age: ${ageLabel}  |  Life Score: ${score.composite.toFixed(2)}`
  );
  lines.push('');

  lines.push(
    `${pad('Counterparties (90d):', 26)} ${String(score.diversity90d).padStart(5)}` +
      `       expected: ${divThresh}+`.padEnd(22) +
      badge(score.diversity90d, divThresh, divThresh * 0.5)
  );

  lines.push(
    `${pad('Top-5 concentration:', 26)} ${pct(score.concentration).padStart(5)}` +
      `       expected: <${pct(thresholds.concentration)}`.padEnd(22) +
      badge(score.concentration, thresholds.concentration * 0.5, thresholds.concentration, true)
  );

  lines.push(
    `${pad('Reciprocity ratio:', 26)} ${pct(score.reciprocity).padStart(5)}` +
      `       expected: <${pct(thresholds.reciprocity)}`.padEnd(22) +
      badge(score.reciprocity, 0.30, thresholds.reciprocity, true)
  );

  if (score.tier >= 2) {
    lines.push(
      `${pad('Clustering coefficient:', 26)} ${score.clustering.toFixed(2).padStart(5)}` +
        `       expected: <0.15`.padEnd(22) +
        badge(score.clustering, 0.10, thresholds.clustering, true)
    );
  }

  if (score.tier >= 3) {
    lines.push(
      `${pad('Circular flow ratio:', 26)} ${pct(score.circularRatio).padStart(5)}` +
        `       expected: <10%`.padEnd(22) +
        badge(score.circularRatio, 0.05, thresholds.circularRatio, true)
    );
  }

  if (score.temporalCorrelation) {
    const otherId = score.temporalCorrelation.accountId.slice(0, 5) + '...';
    lines.push(
      `${pad('Temporal match:', 26)} ${score.temporalCorrelation.score.toFixed(2).padStart(5)}` +
        ` with #${otherId}`.padEnd(22) +
        badge(score.temporalCorrelation.score, 0.60, thresholds.temporalSimilarity, true)
    );
  }

  if (score.tier >= 2) {
    let geoExtra = '';
    if (score.geoOverlap) {
      const otherId = score.geoOverlap.accountId.slice(0, 5) + '...';
      geoExtra = ` overlaps #${otherId}`;
    }
    lines.push(
      `${pad('Location clusters:', 26)} ${String(score.geoClusters).padStart(5)}` +
        geoExtra.padEnd(22) +
        badge(score.geoClusters, 2, 0)
    );
  }

  lines.push(
    `${pad('Daily velocity (30d):', 26)} ${score.dailyVelocityAvg.toFixed(0).padStart(5)}` +
      `       expected: <${(thresholds.velocityMultiplier * thresholds.dailyAllocation).toFixed(0)}`.padEnd(22) +
      badge(
        score.dailyVelocityAvg,
        thresholds.velocityMultiplier * thresholds.dailyAllocation * 0.5,
        thresholds.velocityMultiplier * thresholds.dailyAllocation,
        true
      )
  );

  return lines.join('\n');
}

export function formatFlaggedList(
  scores: LifeScore[],
  ageDaysMap: Map<string, number>,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): string {
  const flagged = scores.filter((s) => s.composite < thresholds.compositeFlag);
  if (flagged.length === 0) return 'No flagged accounts.';

  flagged.sort((a, b) => a.composite - b.composite);

  const sections = flagged.map((s) => {
    const age = ageDaysMap.get(s.accountId) ?? 0;
    return formatDashboard(s, age, thresholds);
  });

  return (
    `=== FLAGGED ACCOUNTS (${flagged.length}) ===\n\n` +
    sections.join('\n\n---\n\n')
  );
}
