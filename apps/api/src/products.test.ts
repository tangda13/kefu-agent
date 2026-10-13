import { describe, expect, it } from "vitest";
import { normalizeProductDraft, sanitizeDetails } from "./routes/products";

describe("商品采集结果清洗（D-32）", () => {
  it("兼容模型的对象写法：规格、参数、问答、尺码表", () => {
    const details = sanitizeDetails(normalizeProductDraft({
      name: "Dress",
      options: { 颜色: "White / Khaki", 尺码: ["S", "M"] },
      skus: [{ values: { 颜色: "White", 尺码: "S" }, price: "24.99", stock: 5 }],
      specs: { 材质: "亚麻", 长度: "110cm" },
      faq: [{ question: "偏小吗？", answer: "标准尺码" }],
      sizeChart: [{ 尺码: "S", 胸围: 88 }, { 尺码: "M", 胸围: 92 }],
      bullets: "Linen\nPockets",
    }));
    expect(details.options).toEqual([{ name: "颜色", values: ["White", "Khaki"] }, { name: "尺码", values: ["S", "M"] }]);
    expect(details.skus?.[0]).toEqual({ values: { 颜色: "White", 尺码: "S" }, price: 24.99, stock: 5 });
    expect(details.specs).toEqual([{ name: "材质", value: "亚麻" }, { name: "长度", value: "110cm" }]);
    expect(details.faq).toEqual([{ q: "偏小吗？", a: "标准尺码" }]);
    expect(details.sizeChart).toEqual({ headers: ["尺码", "胸围"], rows: [["S", "88"], ["M", "92"]] });
    expect(details.bullets).toEqual(["Linen", "Pockets"]);
  });
});
