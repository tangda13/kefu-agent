import { describe, expect, it } from "vitest";
import { weightedTotal } from "./assessment";
import { assessmentOutputSchema, buildAssessmentMessages } from "./prompts/assessment";

const SIX = { professionalism: 80, effectiveness: 70, empathy: 60, resolution: 50, grammar: 90, compliance: 100 };

describe("评分：八项（D-46）", () => {
  it("老记录只有六项：总分只算有分的维度，不把新增两项当 0 分", () => {
    expect(weightedTotal(SIX, {})).toBe(75);
    expect(weightedTotal({ ...SIX, knowledge: 40, responsiveness: 20 }, {})).toBe(64);
  });

  it("按权重计算时，缺分的维度不占权重", () => {
    const weights = { professionalism: 10, effectiveness: 10, empathy: 10, resolution: 10, knowledge: 30, responsiveness: 10, grammar: 10, compliance: 10 };
    // 没有 knowledge、responsiveness：剩下六项各 10，等于六项平均
    expect(weightedTotal(SIX, weights)).toBe(75);
  });

  it("提示词只让模型打七项，响应时效由系统给出；商品资料交给模型对照", () => {
    const [system, user] = buildAssessmentMessages({
      scenarioName: "物流延误",
      objective: "安抚并给出时效",
      stage: "in_sale",
      productFacts: "Product: Earbuds · USD 39 · Battery 7h",
      transcript: "Buyer: hi\nAgent: hello",
      evidence: {
        forbiddenHits: [],
        turnScores: [70],
        summarized: false,
        responsiveness: { score: 60, firstReplySec: 30, avgReplySec: 150, slowReplies: 1, leftWaiting: false, turns: 2 },
      },
    });
    expect(system!.content).toContain("knowledge（商品信息准确性）");
    expect(system!.content).not.toContain("responsiveness（");
    expect(user!.content).toContain("Battery 7h");
    expect(user!.content).toContain("首次响应 30 秒");
    expect(user!.content).toContain("售中处理");
  });

  it("模型漏给某一项也能解析（由调用方兜底）", () => {
    const parsed = assessmentOutputSchema.parse({ scores: { professionalism: 80 }, comment: "ok" });
    expect(parsed.scores.professionalism).toBe(80);
    expect(parsed.scores.knowledge).toBeUndefined();
  });
});
