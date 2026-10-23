import { describe, expect, it } from "vitest";
import type { BuyerLedger } from "@cecs/domain";
import { weightedTotal } from "./assessment";
import { assessmentOutputSchema, buildAssessmentMessages, buyerExitSummary } from "./prompts/assessment";

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

  it("买家怎么走的（D-90）交给评分模型，总评第一句写清怎么结束、为什么", () => {
    const [system, user] = buildAssessmentMessages({
      scenarioName: "售前咨询",
      objective: "解答疑问",
      transcript: "Buyer: is it accurate?\nAgent: medical-grade!",
      evidence: {
        forbiddenHits: [],
        turnScores: [],
        summarized: false,
        buyerExit: {
          summary: "买家失望离开（耐心用完）",
          complaints: [
            { excerpt: "It reaches medical-grade accuracy!", faults: ["exaggerate"], severe: false, last: false },
            { excerpt: "Please wait, not my problem", faults: ["blame"], severe: true, last: true },
          ],
        },
      },
    });
    expect(system!.content).toContain("总评第一句写清这次接待怎么结束、为什么");
    expect(user!.content).toContain(
      "客观依据——买家怎么走的：买家失望离开（耐心用完）。让买家不满的客服回复共 2 条：「It reaches medical-grade accuracy!」（夸大宣传）；「Please wait, not my problem」（推卸责任，很不满，买家随后离开）",
    );
    // 老记录没有账
    expect(buildAssessmentMessages({ scenarioName: null, objective: null, transcript: "-", evidence: { forbiddenHits: [], turnScores: [], summarized: false } })[1]!.content).toContain("买家怎么走的：无（旧记录）");
  });

  it("结局一句话：失望 / 等不到回复 / 都办成（含默默离开）/ 主要的办成 / 等客服回复 / 学生结束", () => {
    const base: BuyerLedger = {
      version: 1,
      items: [
        { no: 1, kind: "main", text: "退款", status: "done", misses: 0 },
        { no: 2, kind: "side", text: "how long", topic: "shipping", status: "dropped", misses: 2 },
      ],
      extrasLeft: 0,
      patience: { start: 3, left: 1 },
      silentLeave: false,
      judgements: [],
    };
    const exit = (patch: Partial<NonNullable<BuyerLedger["exit"]>>) => ({ ...base, exit: { outcome: "disappointed" as const, at: "", ...patch } });
    // 耐心用完优先；还有耐心但主要的事两次没答上
    expect(buyerExitSummary({ ...exit({ outcome: "disappointed", fault: "vague" }), patience: { start: 3, left: 0 } }, "buyer_left")).toBe("买家失望离开（耐心用完）");
    const mainDropped = { ...base, items: [{ ...base.items[0]!, status: "dropped" as const }, base.items[1]!] };
    expect(buyerExitSummary({ ...mainDropped, exit: { outcome: "disappointed", at: "", fault: "ignored" } }, "buyer_left")).toBe("买家失望离开（主要问题两次没得到能用的答复）");
    expect(buyerExitSummary(exit({ outcome: "disappointed", fault: "slow" }), "buyer_left")).toBe("买家等不到回复离开");
    expect(buyerExitSummary(exit({ outcome: "settled", silent: true }), "buyer_left")).toBe("问题都解决了，买家没说再见直接离开");
    expect(buyerExitSummary(exit({ outcome: "partial" }), "buyer_left")).toBe("主要问题解决了，物流时效没谈妥，买家离开");
    expect(buyerExitSummary(exit({ outcome: "pending" }), "buyer_left")).toBe("客服答应稍后回复，买家先离开了");
    expect(buyerExitSummary(base, "student_ended")).toBe("客服结束了接待，买家的主要问题已经解决");
    expect(buyerExitSummary(null, "buyer_left")).toBeNull();
  });

  it("模型漏给某一项也能解析（由调用方兜底）", () => {
    const parsed = assessmentOutputSchema.parse({ scores: { professionalism: 80 }, comment: "ok" });
    expect(parsed.scores.professionalism).toBe(80);
    expect(parsed.scores.knowledge).toBeUndefined();
  });
});
