import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_THRESHOLDS,
  ASSESSMENT_DIMENSIONS,
  CUSTOMER_TYPES,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  SUPPORTED_LANGUAGES,
  categoryLeaves,
  categoryTemplate,
  isLeafCategory,
  isSizedCategory,
  normalizeCategory,
  couponFace,
  couponRuleText,
  discountRate,
  percentOffOf,
  couponScopeText,
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


describe("商品类目树（D-65）", () => {
  it("完整路径照收，老类目对到树上，只写末级名按名字找", () => {
    expect(normalizeCategory("服装 > 女装 > 连衣裙")).toBe("服装 > 女装 > 连衣裙");
    expect(normalizeCategory("服装›女装›连衣裙")).toBe("服装 > 女装 > 连衣裙");
    expect(normalizeCategory("女装")).toBe("服装 > 女装");
    expect(normalizeCategory("鞋靴箱包", "Women's Faux Leather Tote Bag")).toBe("箱包");
    expect(normalizeCategory("鞋靴箱包", "Men's Lightweight Mesh Running Shoes")).toBe("鞋靴");
    expect(normalizeCategory("托特包")).toBe("箱包 > 女包 > 托特包");
    expect(normalizeCategory("针织衫 / 毛衣")).toBe("服装 > 女装 > 针织衫 / 毛衣");
    expect(normalizeCategory("不存在的类目")).toBeNull();
  });

  it("模板从末级往上继承，写了就覆盖；只有服饰、鞋靴、宠物服饰有尺码表", () => {
    expect(categoryTemplate("服装 > 女装 > 连衣裙")!.dims.map((dim) => dim.name)).toEqual(["颜色", "尺码"]);
    expect(isSizedCategory("服装 > 女装 > 连衣裙")).toBe(true);
    expect(isSizedCategory("服装 > 服饰配件 > 帽子")).toBe(false);
    expect(categoryTemplate("3C 数码 > 耳机音箱 > 无线耳机")!.dims.map((dim) => dim.name)).toEqual(["颜色", "版本"]);
    expect(isSizedCategory("3C 数码 > 耳机音箱 > 无线耳机")).toBe(false);
    expect(isSizedCategory("宠物用品 > 宠物服饰 > 宠物衣服")).toBe(true);
    expect(isLeafCategory("服装 > 女装")).toBe(false);
    expect(isLeafCategory("服装 > 女装 > 连衣裙")).toBe(true);
    expect(categoryLeaves().length).toBeGreaterThan(50);
  });
});

describe("店铺优惠券文字（D-66）", () => {
  it("规则、票面、适用范围", () => {
    expect(couponRuleText({ kind: "amount", amount: 5, threshold: 30 })).toBe("满 $30 减 $5");
    expect(couponRuleText({ kind: "percent", amount: 10, threshold: 0 })).toBe("打 9 折");
    expect(couponRuleText({ kind: "percent", amount: 15, threshold: 50 })).toBe("满 $50 打 8.5 折");
    expect(percentOffOf(8.5)).toBe(15);
    expect(discountRate(10)).toBe(9);
    expect(couponRuleText({ kind: "shipping", amount: 0, threshold: 20 })).toBe("满 $20 免运费");
    expect(couponFace({ kind: "amount", amount: 7.5, threshold: 0 })).toEqual({ value: "$7.50", gate: "无门槛" });
    expect(couponScopeText({ productIds: ["A", "B"], customerTypes: ["复购老客", "粉丝客"] })).toBe("指定 2 个商品 · 仅复购老客、粉丝客");
    expect(couponScopeText({ productIds: [], customerTypes: [] })).toBe("全店商品 · 不限客户");
  });
});
