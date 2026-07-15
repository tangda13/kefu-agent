import { describe, expect, it } from "vitest";
import type { ConversationMetric } from "@cecs/contracts";
import { summarizeConversationMetrics } from "./metrics";

describe("conversation acceptance summary", () => {
  it("calculates TTFT rate, maximum and output speed from auditable timestamps", () => {
    const metric: ConversationMetric = {
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
      firstCharacterAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:04.000Z",
      validCharacters: 60,
      provider: "provider-a",
      model: "model-a",
      outcome: "success",
    };
    const summary = summarizeConversationMetrics([metric]);
    expect(summary.targetTtftRate).toBe(1);
    expect(summary.maximumTtftMs).toBe(2000);
    expect(summary.averageCharactersPerSecond).toBe(30);
    expect(summary.passesOutputSpeed).toBe(true);
  });
});

