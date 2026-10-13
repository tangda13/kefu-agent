/**
 * 模拟店铺资料、系统客户标签、咨询原因（学生端改版，对比稿 docs/design/p12-student）。
 * 店铺资料全平台一份，存 app_settings.store_profile；客户标签按订单规则自动生成，客服只读（千牛云标签 / 会员等级的做法）。
 */

export interface StoreTierRules {
  /** 单笔实付达到即为大订单客户（USD） */
  bigOrderSingle: number;
  /** 近一年累计实付达到即为大订单客户（USD） */
  bigOrderYearly: number;
  /** 最近一次下单超过这么多天即为沉睡客户 */
  dormantDays: number;
}

export interface StoreProfile {
  name: string;
  /** 上传的标识图片地址；空 = 用店铺名首字母 */
  logoUrl: string | null;
  market: "欧美" | "日韩" | "东南亚" | "中东";
  currency: string;
  supportEmail: string;
  signature: string;
  tiers: StoreTierRules;
}

export const STORE_MARKETS = ["欧美", "日韩", "东南亚", "中东"] as const;

export function storeEmailFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "store";
  return `support@${slug}.com`;
}

export const DEFAULT_STORE_PROFILE: StoreProfile = {
  name: "Aurora Mart",
  logoUrl: null,
  market: "欧美",
  currency: "USD",
  supportEmail: storeEmailFromName("Aurora Mart"),
  signature: "Best regards,\nAurora Mart Customer Support",
  tiers: { bigOrderSingle: 100, bigOrderYearly: 300, dormantDays: 180 },
};

/** 合并存储值与默认值，丢弃非法字段 */
export function normalizeStoreProfile(raw: unknown): StoreProfile {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<StoreProfile> & { tiers?: Partial<StoreTierRules> };
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 40) : DEFAULT_STORE_PROFILE.name;
  const num = (input: unknown, fallback: number, min: number, max: number) => {
    const n = Number(input);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
  };
  const tiers: Partial<StoreTierRules> = value.tiers ?? {};
  return {
    name,
    logoUrl: typeof value.logoUrl === "string" && value.logoUrl ? value.logoUrl : null,
    market: (STORE_MARKETS as readonly string[]).includes(value.market as string) ? (value.market as StoreProfile["market"]) : "欧美",
    currency: "USD",
    supportEmail:
      typeof value.supportEmail === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.supportEmail.trim())
        ? value.supportEmail.trim()
        : storeEmailFromName(name),
    signature: typeof value.signature === "string" && value.signature.trim() ? value.signature.trim().slice(0, 200) : `Best regards,\n${name} Customer Support`,
    tiers: {
      bigOrderSingle: num(tiers.bigOrderSingle, DEFAULT_STORE_PROFILE.tiers.bigOrderSingle, 1, 100000),
      bigOrderYearly: num(tiers.bigOrderYearly, DEFAULT_STORE_PROFILE.tiers.bigOrderYearly, 1, 1000000),
      dormantDays: num(tiers.dormantDays, DEFAULT_STORE_PROFILE.tiers.dormantDays, 30, 1000),
    },
  };
}

/** 系统客户标签（参数：粉丝、大订单客户、普通客户、沉睡客户；另有“新客”表示还没成交） */
export const CUSTOMER_TAGS = ["粉丝", "大订单客户", "普通客户", "沉睡客户", "新客"] as const;
export type CustomerTag = (typeof CUSTOMER_TAGS)[number];

/**
 * 按 RFM（最近一次购买 · 频次 · 金额）计算系统标签。
 * customerType 是画像里的客户价值层（生成买家时用的设定），orders 是这位买家的订单（含当前咨询订单）。
 */
export function computeCustomerTags(
  customerType: string | undefined,
  orders: ReadonlyArray<{ totalAmount: number; placedAt: string; status: string }>,
  tiers: StoreTierRules = DEFAULT_STORE_PROFILE.tiers,
  now: Date = new Date(),
): CustomerTag[] {
  const paid = orders.filter((order) => order.status !== "pending_payment");
  const tags: CustomerTag[] = [];
  if (customerType === "粉丝客") tags.push("粉丝");
  if (!paid.length) {
    tags.push("新客");
    return tags;
  }
  const yearAgo = now.getTime() - 365 * 86400_000;
  const maxSingle = Math.max(...paid.map((order) => Number(order.totalAmount) || 0));
  const yearly = paid
    .filter((order) => new Date(order.placedAt).getTime() >= yearAgo)
    .reduce((sum, order) => sum + (Number(order.totalAmount) || 0), 0);
  const lastAt = Math.max(...paid.map((order) => new Date(order.placedAt).getTime() || 0));
  const dormant = customerType === "沉睡客" || now.getTime() - lastAt > tiers.dormantDays * 86400_000;
  const big = maxSingle >= tiers.bigOrderSingle || yearly >= tiers.bigOrderYearly;
  if (big) tags.push("大订单客户");
  if (dormant) tags.push("沉睡客户");
  if (!big && !dormant && !tags.includes("粉丝")) tags.push("普通客户");
  return tags;
}

/** 咨询原因：单选、互不重叠、写买家能看到的原因（参照 Gorgias Contact Reason） */
export const CONTACT_REASONS = [
  "商品咨询",
  "尺码与规格",
  "运费与时效",
  "价格与优惠",
  "付款问题",
  "修改订单",
  "取消订单",
  "催发货",
  "物流查询",
  "清关问题",
  "丢件与派送失败",
  "货损",
  "缺件或错发",
  "质量问题",
  "退换货",
  "退款",
  "平台纠纷",
  "评价相关",
  "店铺回访",
  "其他",
] as const;
export type ContactReason = (typeof CONTACT_REASONS)[number];

const REASON_KEYWORDS: Array<[RegExp, ContactReason]> = [
  [/尺码|适配|规格/, "尺码与规格"],
  [/运费|关税|时效/, "运费与时效"],
  [/议价|询价|优惠|价格/, "价格与优惠"],
  [/催付|付款/, "付款问题"],
  [/改地址|修改/, "修改订单"],
  [/取消/, "取消订单"],
  [/发货延迟|延迟发货|催发/, "催发货"],
  [/清关/, "清关问题"],
  [/丢件|派送/, "丢件与派送失败"],
  [/物流|进度|跟进/, "物流查询"],
  [/货损|破损/, "货损"],
  [/错发|漏发|缺件/, "缺件或错发"],
  [/质量/, "质量问题"],
  [/退换|换货|退货/, "退换货"],
  [/退款/, "退款"],
  [/纠纷/, "平台纠纷"],
  [/评/, "评价相关"],
  [/唤醒|关怀|回访|推送|维系|信任/, "店铺回访"],
  [/新品|卖点|咨询/, "商品咨询"],
];

/** 由场景推断咨询原因，作为系统预填值，学生确认或改正 */
export function suggestContactReason(scenarioName: string | null | undefined, stage?: string | null): ContactReason | null {
  const name = scenarioName ?? "";
  for (const [pattern, reason] of REASON_KEYWORDS) if (pattern.test(name)) return reason;
  if (stage === "customer_care") return "店铺回访";
  if (stage === "pre_sale") return "商品咨询";
  return null;
}
