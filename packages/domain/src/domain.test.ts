import { describe, expect, it } from "vitest";
import {
  composePersona,
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
    expect(forbiddenTerms.length).toBeGreaterThanOrEqual(100);
    expect(standardPhrases.length).toBeGreaterThanOrEqual(50);
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

