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

  it("covers the six evaluation dimensions named in the parameter document", () => {
    const named = ["违规用语合规", "语法准确性", "话术规范", "沟通有效性", "客户情绪安抚", "问题解决"];
    const covered = ASSESSMENT_DIMENSIONS.map((dim) => ("paramLabel" in dim ? dim.paramLabel : null));
    for (const label of named) expect(covered).toContain(label);
  });

  it("preserves the measurable acceptance thresholds", () => {
    expect(ACCEPTANCE_THRESHOLDS.ttftTargetMs).toBe(3000);
    expect(ACCEPTANCE_THRESHOLDS.ttftTargetPassRate).toBe(0.99);
    expect(ACCEPTANCE_THRESHOLDS.ttftMaximumMs).toBe(10000);
    expect(ACCEPTANCE_THRESHOLDS.minOutputCharactersPerSecond).toBe(20);
    expect(ACCEPTANCE_THRESHOLDS.acceptanceConversationSamples).toBe(100);
  });
});

