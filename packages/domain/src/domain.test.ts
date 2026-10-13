import { describe, expect, it } from "vitest";
import { NATIONALITIES } from "@cecs/contracts";
import {
  AVATAR_LIBRARY,
  AVATAR_REGIONS,
  avatarRegionOf,
  composePersona,
  composePersonaWithRule,
  emailTemplates,
  ensurePersonaAvatar,
  pickAvatar,
  forbiddenTerms,
  patienceAction,
  patienceFactor,
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
    expect(persona.language).toBe("de-DE");
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

describe("买家耐心（D-40）", () => {
  it("倍率覆盖全部情绪与性格取值，未知取值按 1", async () => {
    const { EMOTIONS, PERSONALITIES } = await import("@cecs/contracts");
    for (const emotion of EMOTIONS) for (const personality of PERSONALITIES) {
      const factor = patienceFactor({ emotion, personality });
      expect(factor).toBeGreaterThanOrEqual(0.3);
      expect(factor).toBeLessThanOrEqual(2);
    }
    expect(patienceFactor({})).toBe(1);
    expect(patienceFactor({ emotion: "平静", personality: "不存在" })).toBe(1);
    expect(patienceFactor({ emotion: "焦虑" })).toBeLessThan(1);
    expect(patienceFactor({ emotion: "不满", personality: "敏感挑剔" })).toBeLessThan(patienceFactor({ emotion: "不满" }));
    expect(patienceFactor({ personality: "随和" })).toBe(1.5);
  });

  it("按等待时长一步步推进：催、再催、离开", () => {
    expect(patienceAction(1.9, 0, 1)).toBeNull();
    expect(patienceAction(2, 0, 1)).toBe("nudge");
    expect(patienceAction(4, 1, 1)).toBeNull();
    expect(patienceAction(5, 1, 1)).toBe("nudge");
    expect(patienceAction(9, 2, 1)).toBeNull();
    expect(patienceAction(10, 2, 1)).toBe("leave");
    expect(patienceAction(60, 3, 1)).toBeNull();
    // 焦虑减半、随和延长
    expect(patienceAction(1.2, 0, 0.5)).toBe("nudge");
    expect(patienceAction(2.5, 0, 1.5)).toBeNull();
  });
});

describe("D-41 买家头像多样化", () => {
  const seeded = (seed: string) => {
    let hash = 0;
    for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return () => {
      hash = (hash * 1103515245 + 12345) >>> 0;
      return ((hash >>> 8) % 1000) / 1000;
    };
  };

  it("同一种子结果稳定", () => {
    for (const seed of ["a", "conv-1", "conv-2"]) {
      expect(ensurePersonaAvatar({ name: "x" }, seed)).toEqual(ensurePersonaAvatar({ name: "x" }, seed));
    }
  });

  it("老快照已有头像保持不变，default/initial 不会被重抽", () => {
    expect(ensurePersonaAvatar({ avatarUrl: "avatars/f-03.jpg" }, "s").avatarUrl).toBe("avatars/f-03.jpg");
    expect(ensurePersonaAvatar({ avatarUrl: "avatars/f-03.jpg" }, "s").avatarKind).toBe("photo");
    expect(ensurePersonaAvatar({ avatarUrl: "", avatarKind: "default" }, "s")).toMatchObject({ avatarUrl: "", avatarKind: "default" });
  });

  it("1000 个随机种子比例大致符合", () => {
    const count: Record<string, number> = { default: 0, initial: 0, photo: 0, object: 0 };
    for (let i = 0; i < 1000; i += 1) {
      const pick = pickAvatar(i % 2 ? "female" : "male", seeded(`seed-${i}`), "美国");
      count[pick.avatarKind] = (count[pick.avatarKind] ?? 0) + 1;
      if (pick.avatarKind === "default" || pick.avatarKind === "initial") expect(pick.avatarUrl).toBe("");
      else if (pick.avatarKind === "object") expect(pick.avatarUrl).toMatch(/^avatars\/o-\d{2}\.jpg$/);
      else expect(pick.avatarUrl).toMatch(/^avatars\/a-(eu|la|ea|sea|sa|me|af)-(f|m)-\d{2,3}\.jpg$/);
    }
    expect(count.default).toBeGreaterThan(60);
    expect(count.default).toBeLessThan(150);
    expect(count.initial).toBeGreaterThan(60);
    expect(count.initial).toBeLessThan(150);
    expect(count.photo).toBeGreaterThan(680);
    expect(count.photo).toBeLessThan(820);
    expect(count.object).toBeGreaterThan(20);
    expect(count.object).toBeLessThan(90);
  });

  it("国籍映射到大区，覆盖全部国籍取值", () => {
    for (const nationality of NATIONALITIES) expect(AVATAR_REGIONS).toContain(avatarRegionOf(nationality));
    expect(avatarRegionOf("日本")).toBe("ea");
    expect(avatarRegionOf("巴西")).toBe("la");
    expect(avatarRegionOf("德国")).toBe("eu");
    expect(avatarRegionOf("印度")).toBe("sa");
    expect(avatarRegionOf("某未知国家")).toBe("eu");
  });

  it("人像优先选买家国籍对应大区（约 85%），并按性别", () => {
    for (const [nationality, region] of [["日本", "ea"], ["巴西", "la"], ["美国", "eu"]] as const) {
      let photo = 0;
      let same = 0;
      for (let i = 0; i < 3000; i += 1) {
        const gender = i % 2 ? "female" : "male";
        const pick = pickAvatar(gender, seeded(`n-${nationality}-${i}`), nationality);
        if (pick.avatarKind !== "photo") continue;
        photo += 1;
        const match = /^avatars\/a-(\w+)-(f|m)-(\d{2,3})\.jpg$/.exec(pick.avatarUrl)!;
        expect(match[2]).toBe(gender === "female" ? "f" : "m");
        expect(Number(match[3])).toBeLessThanOrEqual(AVATAR_LIBRARY.portraits[match[1] as keyof typeof AVATAR_LIBRARY.portraits][gender]);
        if (match[1] === region) same += 1;
      }
      expect(same / photo).toBeGreaterThan(0.8);
      expect(same / photo).toBeLessThan(0.92);
    }
  });

  it("同一国籍+种子+性别头像稳定", () => {
    expect(pickAvatar("female", seeded("x"), "日本")).toEqual(pickAvatar("female", seeded("x"), "日本"));
  });

  it("非人脸/默认/首字母不分性别", () => {
    for (const kind of ["object", "default", "initial"]) {
      for (let i = 0; i < 300; i += 1) {
        const m = pickAvatar("male", seeded(`k-${i}`));
        const f = pickAvatar("female", seeded(`k-${i}`));
        if (m.avatarKind === kind && f.avatarKind === kind) expect(m).toEqual(f);
      }
    }
  });
});
