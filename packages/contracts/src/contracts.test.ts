import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_THRESHOLDS,
  ASSESSMENT_DIMENSIONS,
  CUSTOMER_TYPES,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  SUPPORTED_LANGUAGES,
} from "./index";

describe("parameter document minimums", () => {
  it("keeps every quantified catalog floor in executable form", () => {
    expect(NATIONALITIES.length).toBeGreaterThanOrEqual(10);
    expect(PERSONALITIES.length).toBeGreaterThanOrEqual(5);
    expect(EMOTIONS.length).toBeGreaterThanOrEqual(3);
    expect(CUSTOMER_TYPES.length).toBeGreaterThanOrEqual(4);
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(3);
    expect(ASSESSMENT_DIMENSIONS.length).toBeGreaterThanOrEqual(6);
  });

  it("preserves the measurable acceptance thresholds", () => {
    expect(ACCEPTANCE_THRESHOLDS.ttftTargetMs).toBe(3000);
    expect(ACCEPTANCE_THRESHOLDS.ttftTargetPassRate).toBe(0.99);
    expect(ACCEPTANCE_THRESHOLDS.ttftMaximumMs).toBe(10000);
    expect(ACCEPTANCE_THRESHOLDS.minOutputCharactersPerSecond).toBe(20);
    expect(ACCEPTANCE_THRESHOLDS.acceptanceConversationSamples).toBe(100);
  });
});

