/**
 * 买家画像结构（D-33）：谁在买（买家角色）· 怎么做决定（决策风格）· 和店铺的关系（客户价值层，见 CUSTOMER_TYPES）
 * 界面上“决策风格”叫“消费偏好”、“客户价值层”叫“客户类型”（D-67），代码字段名不变
 * + 看重什么（关注点）+ 怎么沟通（性格、进店情绪、国籍、语言）。
 * 决策风格取自 Sproles & Kendall 消费者决策风格量表（CSI，1986）的 8 种。
 */

export const BUYER_ROLES = ["个人消费者", "礼品购买者", "小B店主", "批发采购商", "企业采购", "代购转售"] as const;
export type BuyerRole = (typeof BUYER_ROLES)[number];

export const DECISION_STYLES = [
  "品质导向型",
  "品牌口碑型",
  "新奇尝鲜型",
  "享受逛买型",
  "价格敏感型",
  "冲动下单型",
  "选择困难型",
  "习惯忠诚型",
] as const;
export type DecisionStyle = (typeof DECISION_STYLES)[number];

/** 决策风格：给老师看的一句解释 + 给买家 AI 的具体表现 */
export const DECISION_STYLE_INFO: Record<DecisionStyle, { hint: string; behavior: string }> = {
  品质导向型: {
    hint: "追求最好的质量，会细问材质、做工、参数",
    behavior: "You care most about quality. Ask detailed questions about materials, workmanship and specs; vague answers make you doubt the product.",
  },
  品牌口碑型: {
    hint: "看重品牌、评价和销量，认为口碑好的才可靠",
    behavior: "You trust reputation. Ask about reviews, ratings, sales volume, certifications and whether the product is genuine.",
  },
  新奇尝鲜型: {
    hint: "喜欢新品和潮流款，关心是不是最新、有没有新颜色",
    behavior: "You love new and trendy items. Ask what is new, upcoming colors or versions, and whether it looks good in photos.",
  },
  享受逛买型: {
    hint: "把购物当乐趣，愿意聊，容易被推荐打动",
    behavior: "You enjoy shopping as fun. You chat freely, welcome recommendations and styling ideas, and may add more items if the agent is engaging.",
  },
  价格敏感型: {
    hint: "比价、要优惠，价格是主要决定因素",
    behavior: "Price decides for you. Compare with other stores, ask for discounts, coupons or free shipping, and push back on the price at least once.",
  },
  冲动下单型: {
    hint: "决定快，容易被一句话说动，事后也容易后悔",
    behavior: "You decide quickly and can be persuaded by one convincing point or a time-limited offer, but you may change your mind if something feels off.",
  },
  选择困难型: {
    hint: "选项太多会犹豫，反复比较，需要客服帮着做决定",
    behavior: "Too many options confuse you. Keep comparing variants, ask which one the agent recommends and why, and hesitate until you get a clear suggestion.",
  },
  习惯忠诚型: {
    hint: "习惯买熟悉的店和款，不轻易换",
    behavior: "You prefer what you already know. Refer to your previous purchases, expect the same quality and service, and resist switching to unfamiliar items.",
  },
};

export const PERSONA_CONCERNS = [
  "价格优惠",
  "物流时效",
  "退换政策",
  "材质参数",
  "尺码合身",
  "包装礼盒",
  "售后保修",
  "正品资质",
  "批量价格",
  "发票交期",
  "新品",
] as const;
export const PERSONA_CONCERN_MAX = 3;

/** 画像默认名称：决策风格 + 买家角色，如“价格敏感型个人消费者” */
export function personaDisplayName(decisionStyle?: string | null, buyerRole?: string | null): string {
  return `${decisionStyle ?? ""}${buyerRole ?? ""}`;
}
