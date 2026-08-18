import { describe, expect, it } from "vitest";
import {
  baselinePublicQuestions,
  gradeBaseline,
  validateBaselineAnswers,
  type BaselineAnswer,
} from "./baseline";

const PERFECT: Record<string, BaselineAnswer> = {
  b01: "no",
  b02: "b",
  b03: "a",
  b04: "yes",
  b05: "b",
  b06: ["a", "b", "c", "d"],
  b07: "c",
  b08: "c",
  b09: ["a", "b", "c"],
  b10: "Dear Emma, I'm so sorry to hear that your mug arrived broken. We will send you a new one or issue a full refund within 24 hours. Please let me know which you prefer.",
};

describe("初始测评引擎", () => {
  it("公开题目不泄露答案，共 10 题且覆盖四种题型", () => {
    const questions = baselinePublicQuestions();
    expect(questions).toHaveLength(10);
    expect(new Set(questions.map((q) => q.kind))).toEqual(
      new Set(["single", "multi", "judge", "practical"]),
    );
    for (const question of questions) {
      expect(question).not.toHaveProperty("correct");
    }
  });

  it("全部答对得满分，六个维度齐全", () => {
    const { scores, total } = gradeBaseline(PERFECT);
    expect(total).toBe(100);
    expect(Object.keys(scores).sort()).toEqual(
      ["compliance", "effectiveness", "empathy", "grammar", "professionalism", "resolution"].sort(),
    );
    for (const value of Object.values(scores)) expect(value).toBe(100);
  });

  it("实操题使用违规用语时合规维度被扣分", () => {
    const answers = { ...PERFECT, b10: "Dear Emma, I'm so sorry about the broken mug. We will send you a new one within 24 hours. This is the best mug and I guarantee 100% it will never break again." };
    const { scores } = gradeBaseline(answers);
    expect(scores.compliance).toBeLessThan(100);
    expect(scores.empathy).toBe(100);
  });

  it("多选题选错选项会抵扣得分", () => {
    const answers = { ...PERFECT, b09: ["a", "b", "d", "e"] };
    const { scores } = gradeBaseline(answers);
    expect(scores.resolution).toBeLessThan(100);
  });

  it("漏答校验给出具体题号", () => {
    const { b07: _skip, ...rest } = PERFECT;
    expect(validateBaselineAnswers(rest)).toContain("07");
    expect(validateBaselineAnswers(PERFECT)).toBeNull();
    expect(validateBaselineAnswers({ ...PERFECT, b10: "too short" })).toContain("实操");
  });
});
