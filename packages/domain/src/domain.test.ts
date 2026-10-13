import { describe, expect, it } from "vitest";
import {
  composePersona,
  composePersonaWithRule,
  emailTemplates,
  forbiddenTerms,
  personaTemplates,
  standardPhrases,
  toStudentPersonaView,
  trainingScenarios,
} from "./index";

describe("seed catalogs", () => {
  it("meets every initial content minimum", () => {
    expect(trainingScenarios.length).toBeGreaterThanOrEqual(20);
    expect(new Set(trainingScenarios.map((item) => item.stage))).toHaveLength(4);
    expect(personaTemplates.length).toBeGreaterThanOrEqual(20);
    expect(emailTemplates.length).toBeGreaterThanOrEqual(4);
    expect(forbiddenTerms.length).toBeGreaterThanOrEqual(120);
    expect(new Set(forbiddenTerms).size).toBe(forbiddenTerms.length);
    expect(standardPhrases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(standardPhrases).size).toBe(standardPhrases.length);
  });

  it("does not expose hidden persona labels in the student view", () => {
    const snapshot = composePersona(() => 0.2);
    const publicView = toStudentPersonaView(snapshot);
    expect(publicView).not.toHaveProperty("personality");
    expect(publicView).not.toHaveProperty("emotion");
    expect(publicView).not.toHaveProperty("preference");
    // 客户类型用于会话管理标签（粉丝/大订单/普通/沉睡），属公开字段
    expect(publicView).toHaveProperty("customerType");
  });

  it("generates scenario-consistent orders with logistics and review", async () => {
    const { generateOrderForScenario } = await import("./index");
    expect(generateOrderForScenario("pre_sale")).toBeNull();
    const inSale = generateOrderForScenario("in_sale", () => 0.1);
    expect(inSale?.status).toBe("pending_payment");
    expect(inSale?.logistics).toBeNull();
    const inTransit = generateOrderForScenario("in_sale", () => 0.9);
    expect(inTransit?.status).toBe("in_transit");
    expect(inTransit?.logistics?.nodes.find((node) => node.current)?.key).toBe("customs");
    const afterSale = generateOrderForScenario("after_sale", () => 0.1);
    expect(afterSale?.status).toBe("delivered");
    expect(afterSale?.review?.rating).toBeLessThanOrEqual(2);
    const care = generateOrderForScenario("customer_care", () => 0.5);
    expect(care?.status).toBe("completed");
    expect(care?.review?.rating).toBeGreaterThanOrEqual(4);
  });

  it("按场景指定的订单状态生成（D-32）", async () => {
    const { generateOrderForScenario, trainingScenarios } = await import("./index");
    expect(generateOrderForScenario("in_sale", () => 0.9, new Date(), undefined, undefined, "pending_payment")?.status).toBe("pending_payment");
    expect(generateOrderForScenario("in_sale", () => 0.1, new Date(), undefined, undefined, "paid")?.status).toBe("paid");
    const failed = generateOrderForScenario("in_sale", () => 0.1, new Date(), undefined, undefined, "delivery_failed");
    expect(failed?.logistics?.nodes.find((node) => node.current)?.key).toBe("delivery");
    expect(generateOrderForScenario("after_sale", () => 0.1, new Date(), undefined, undefined, "delivered_positive")?.review?.rating).toBe(5);
    expect(generateOrderForScenario("customer_care", () => 0.1, new Date(), undefined, undefined, "none")).toBeNull();
    // 每个内置场景都有剧本，四个环节都有场景
    const { scenarioScripts } = await import("./scenario-scripts");
    for (const scenario of trainingScenarios) expect(scenarioScripts[scenario.id]?.buyerGoal).toBeTruthy();
  });
});

describe("画像规则两步（D-33）", () => {
  it("人群范围只筛选不改身份；没有符合的抛错", async () => {
    const { composePersonaWithRule, filterPersonaTemplates, NoMatchingPersonaError, personaTemplates } = await import("./index");
    const pool = filterPersonaTemplates(personaTemplates, { customerTypes: ["沉睡客"], buyerRoles: ["个人消费者"] });
    expect(pool.length).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) {
      const persona = composePersonaWithRule(personaTemplates, { customerTypes: ["沉睡客"], emotionPool: ["焦虑"] });
      expect(persona.customerType).toBe("沉睡客");
      expect(persona.emotion).toBe("焦虑");
    }
    expect(() => composePersonaWithRule(personaTemplates, { templateIds: ["NOPE"] })).toThrow(NoMatchingPersonaError);
  });
});

describe("画像模板字段生效（D3）", () => {
  const template = { id: "T1", identity: "健身教练", preference: "看重耐用", customerType: "粉丝客", nationality: "德国", personality: "敏感挑剔", emotion: "不满", language: "en-US" };
  it("规则没约束的字段沿用模板值", () => {
    const persona = composePersonaWithRule([template], {});
    expect(persona.nationality).toBe("德国");
    expect(persona.personality).toBe("敏感挑剔");
    expect(persona.emotion).toBe("不满");
    expect(persona.language).toBe("en-US");
    expect(persona.customerType).toBe("粉丝客");
  });
  it("规则约束的字段按规则抽，国籍被换掉时语言跟着新国籍走", () => {
    const persona = composePersonaWithRule([template], { nationalityPool: ["法国"], emotionPool: ["平静"] });
    expect(persona.nationality).toBe("法国");
    expect(persona.emotion).toBe("平静");
    expect(persona.personality).toBe("敏感挑剔");
    expect(persona.language).toBe("fr-FR");
  });
});

describe("系统客户标签与咨询原因（学生端改版 C2）", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  it("按金额、最近下单时间和画像价值层打标签", async () => {
    const { computeCustomerTags } = await import("./store");
    expect(computeCustomerTags("潜在意向客", [], undefined, now)).toEqual(["新客"]);
    expect(computeCustomerTags("复购老客", [{ totalAmount: 43, placedAt: "2026-10-01", status: "completed" }], undefined, now)).toEqual(["普通客户"]);
    expect(computeCustomerTags("复购老客", [{ totalAmount: 119.97, placedAt: "2026-10-01", status: "in_transit" }], undefined, now)).toEqual(["大订单客户"]);
    expect(computeCustomerTags("粉丝客", [{ totalAmount: 160, placedAt: "2026-09-01", status: "completed" }, { totalAmount: 160, placedAt: "2026-08-01", status: "completed" }], undefined, now)).toEqual(["粉丝", "大订单客户"]);
    expect(computeCustomerTags("复购老客", [{ totalAmount: 30, placedAt: "2026-01-01", status: "completed" }], undefined, now)).toEqual(["沉睡客户"]);
    expect(computeCustomerTags("复购老客", [{ totalAmount: 500, placedAt: "2026-10-01", status: "pending_payment" }], undefined, now)).toEqual(["新客"]);
  });
  it("由场景名称推断咨询原因", async () => {
    const { suggestContactReason } = await import("./store");
    expect(suggestContactReason("清关延误安抚")).toBe("清关问题");
    expect(suggestContactReason("差评挽回")).toBe("评价相关");
    expect(suggestContactReason("错发漏发处理")).toBe("缺件或错发");
    expect(suggestContactReason("沉睡客户唤醒", "customer_care")).toBe("店铺回访");
    expect(suggestContactReason("自定义场景", "pre_sale")).toBe("商品咨询");
  });
});
