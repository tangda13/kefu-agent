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
    expect(trainingScenarios).toHaveLength(8);
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
