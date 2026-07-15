import { ACCEPTANCE_THRESHOLDS, type ConversationMetric } from "@cecs/contracts";

export interface ConversationAcceptanceSummary {
  samples: number;
  successful: number;
  targetTtftRate: number;
  maximumTtftMs: number;
  averageCharactersPerSecond: number;
  passesTargetRate: boolean;
  passesMaximum: boolean;
  passesOutputSpeed: boolean;
}

export function summarizeConversationMetrics(
  metrics: readonly ConversationMetric[],
): ConversationAcceptanceSummary {
  const successful = metrics.filter(
    (item) => item.outcome === "success" && item.firstCharacterAt && item.completedAt,
  );
  const ttfts = successful.map(
    (item) => new Date(item.firstCharacterAt!).getTime() - new Date(item.receivedAt).getTime(),
  );
  const targetHits = ttfts.filter((value) => value <= ACCEPTANCE_THRESHOLDS.ttftTargetMs).length;
  const speeds = successful.map((item) => {
    const durationSeconds = Math.max(
      0.001,
      (new Date(item.completedAt!).getTime() - new Date(item.firstCharacterAt!).getTime()) / 1000,
    );
    return item.validCharacters / durationSeconds;
  });
  const maximumTtftMs = ttfts.length ? Math.max(...ttfts) : 0;
  const averageCharactersPerSecond = speeds.length
    ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length
    : 0;
  const targetTtftRate = successful.length ? targetHits / successful.length : 0;

  return {
    samples: metrics.length,
    successful: successful.length,
    targetTtftRate,
    maximumTtftMs,
    averageCharactersPerSecond,
    passesTargetRate: targetTtftRate >= ACCEPTANCE_THRESHOLDS.ttftTargetPassRate,
    passesMaximum: maximumTtftMs <= ACCEPTANCE_THRESHOLDS.ttftMaximumMs,
    passesOutputSpeed:
      averageCharactersPerSecond >= ACCEPTANCE_THRESHOLDS.minOutputCharactersPerSecond,
  };
}

