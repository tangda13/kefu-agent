import { z } from "zod";
import {
  BUYER_ROLES,
  DECISION_STYLES,
  DECISION_STYLE_INFO,
  PERSONA_CONCERNS,
  CUSTOMER_TYPES,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  PRODUCT_CATEGORIES,
  SUPPORTED_LANGUAGES,
} from "@cecs/contracts";
import type { ChatMessage } from "../llm/gateway";

/** 教师端内容生成（用途 assist）：AI 生成买家画像模板、把商品页内容整理成商品字段（D-32） */
export const CATALOG_PROMPT_VERSION = "catalog@2026-10-13";

const text = (max: number) => z.string().trim().min(1).max(max);

// ---------- 买家画像模板（D-33 结构化） ----------
export const personaDraftSchema = z.object({
  buyerRole: z.enum(BUYER_ROLES),
  decisionStyle: z.enum(DECISION_STYLES),
  customerType: z.enum(CUSTOMER_TYPES),
  concerns: z.array(z.enum(PERSONA_CONCERNS)).min(1).max(5),
  note: z.string().trim().max(60).default(""),
  nationality: z.enum(NATIONALITIES),
  language: z.enum(SUPPORTED_LANGUAGES),
  personality: z.enum(PERSONALITIES),
  emotion: z.enum(EMOTIONS),
});
export type PersonaDraft = z.infer<typeof personaDraftSchema>;

export function buildPersonaDraftMessages(input: { description: string; existingNames: string[] }): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你在帮跨境电商客服实训课的老师设计“买家画像模板”。一个模板代表一类海外买家（人群），由下面的结构化字段组成，不要起人名，也不要写一次性的购买情境（如婚礼、搬家），那些属于场景。",
        `- buyerRole 买家角色（谁在买）只能取：${BUYER_ROLES.join("、")}；`,
        `- decisionStyle 决策风格（怎么做决定，Sproles & Kendall 的 8 种）只能取：${DECISION_STYLES.map((item) => `${item}（${DECISION_STYLE_INFO[item].hint}）`).join("；")}；`,
        `- customerType 客户价值层只能取：${CUSTOMER_TYPES.join("、")}；`,
        `- concerns 关注点 1–3 个，只能取：${PERSONA_CONCERNS.join("、")}；`,
        "- note 补充说明，一句话 10–30 个汉字，写这类人稳定的习惯或顾虑，要能引出客服对话里的具体问题；",
        `- nationality 只能取：${NATIONALITIES.join("、")}；language 只能取：${SUPPORTED_LANGUAGES.join("、")}（en-US 英语、es-ES 西班牙语、fr-FR 法语），一般与国籍匹配，其他国籍用 en-US；`,
        `- personality 沟通性格只能取：${PERSONALITIES.join("、")}；emotion 进店情绪只能取：${EMOTIONS.join("、")}。`,
        "各字段要自洽（例如沉睡客的补充说明里体现很久没下单的原因）。",
        "只返回一个 JSON 对象：{\"buyerRole\":\"\",\"decisionStyle\":\"\",\"customerType\":\"\",\"concerns\":[],\"note\":\"\",\"nationality\":\"\",\"language\":\"\",\"personality\":\"\",\"emotion\":\"\"}",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        input.description.trim()
          ? `老师的描述：${input.description.trim()}`
          : "老师没有给描述：请设计一类和已有模板组合不同、在跨境电商里常见又有训练价值的买家。",
        input.existingNames.length ? `已有模板（尽量不重复）：${input.existingNames.slice(0, 60).join("；")}` : "",
      ].filter(Boolean).join("\n"),
    },
  ];
}

// ---------- 商品页内容 → 商品字段 ----------
/** 结构只校验商品名，其余字段由 normalizeProductDraft 兼容模型常见的变体写法后再清洗（D-32） */
export const productDraftSchema = z.object({ name: text(160) }).passthrough();
export type ProductDraft = z.infer<typeof productDraftSchema>;

export function buildProductDraftMessages(input: { url?: string; title?: string; structured?: string; pageText: string }): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你在帮跨境电商客服实训课的老师，把一个电商商品页的内容整理成模拟店铺的商品资料。学生客服会查这份资料回答海外买家的提问。",
        "规则：",
        "1. 只写页面里有依据的信息，页面上没有的字段留空（空数组、空字符串或 null），不要编造物流、售后、认证、参数。",
        "2. 商品名、卖点、描述用英文（页面是中文就翻译成自然的英文），去掉品牌名、店铺名和夸大用语（best、100%、guaranteed、No.1 等改成客观描述）。",
        "3. 规格维度名用中文（颜色、尺码、容量、款式），取值保留页面写法；skus 列出页面能看到的组合，价格用美元（页面是人民币按 1 美元 = 7.2 元换算并保留两位小数），页面没写库存时 stock 填 100。",
        "4. specs 参数名用中文；sizeChart 只在服饰鞋包且页面有尺码表时填，表头中文带单位。",
        `5. category 只能取：${PRODUCT_CATEGORIES.join("、")}，判断不了填 null。`,
        "6. shipping.methods 的 region 用中文地区名（美国、欧洲、其他地区），days 写时效文字，fee 美元数字（包邮为 0）；afterSale、faq 用中文。",
        "只返回一个 JSON 对象，结构严格如下（数组可以为空，没有的对象填 null）：",
        JSON.stringify({
          name: "<页面商品的英文标题>",
          category: "<类目或 null>",
          price: 0,
          options: [{ name: "<维度名>", values: ["<取值>"] }],
          skus: [{ values: { "<维度名>": "<取值>" }, price: 0, stock: 100 }],
          bullets: ["<英文卖点>"],
          description: "<英文描述>",
          specs: [{ name: "<参数名>", value: "<参数值>" }],
          sizeChart: { headers: ["<表头>"], rows: [["<单元格>"]] },
          shipping: { shipsFrom: "<发货地>", handlingDays: 0, methods: [{ region: "<地区>", method: "<运输方式>", days: "<时效>", fee: 0 }] },
          afterSale: { returnPolicy: "<退换政策>", warranty: "<保修>" },
          faq: [{ q: "<问题>", a: "<回答>" }],
        }),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        input.url ? `页面地址：${input.url}` : "",
        input.title ? `页面标题：${input.title}` : "",
        input.structured ? `页面结构化数据（JSON-LD / meta）：\n${input.structured.slice(0, 6000)}` : "",
        `页面正文：\n${input.pageText.slice(0, 14000)}`,
      ].filter(Boolean).join("\n\n"),
    },
  ];
}
