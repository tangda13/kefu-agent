export const BUSINESS_STAGES = ["pre_sale", "in_sale", "after_sale", "customer_care"] as const;
export type BusinessStage = (typeof BUSINESS_STAGES)[number];

export const BUSINESS_STAGE_LABELS: Record<BusinessStage, string> = {
  pre_sale: "售前沟通",
  in_sale: "售中处理",
  after_sale: "售后处理",
  customer_care: "客户分层维护",
};

/** 沟通方式：在线会话 / 邮件（场景卡片标注，邮件类场景在学生端走邮件模块） */
export const SCENARIO_CHANNELS = ["chat", "mail"] as const;
export type ScenarioChannel = (typeof SCENARIO_CHANNELS)[number];
export const SCENARIO_CHANNEL_LABELS: Record<ScenarioChannel, string> = { chat: "在线会话", mail: "邮件" };

/** 场景开会话时生成的关联订单状态（D-32）。未指定时按业务环节取默认 */
export const ORDER_KINDS = [
  "none",
  "pending_payment",
  "paid",
  "in_transit",
  "customs",
  "delivery_failed",
  "delivered",
  "delivered_negative",
  "delivered_positive",
  "completed",
] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const ORDER_KIND_LABELS: Record<OrderKind, string> = {
  none: "没有订单（售前咨询）",
  pending_payment: "待付款",
  paid: "已付款、待发货",
  in_transit: "运输中（正常）",
  customs: "运输中、卡在清关",
  delivery_failed: "派送异常（丢件或派送失败）",
  delivered: "已送达",
  delivered_negative: "已送达，买家给了差评",
  delivered_positive: "已送达，买家给了好评",
  completed: "历史已完成订单",
};

export const CUSTOMER_TYPES = ["潜在意向客", "复购老客", "粉丝客", "沉睡客"] as const;
export const PERSONALITIES = ["理性谨慎", "直接高效", "友好健谈", "敏感挑剔", "犹豫保守"] as const;
export const EMOTIONS = ["平静", "焦虑", "不满", "期待"] as const;
export const SUPPORTED_LANGUAGES = ["en-US", "es-ES", "fr-FR"] as const;

export const NATIONALITIES = [
  "美国",
  "英国",
  "加拿大",
  "澳大利亚",
  "德国",
  "法国",
  "西班牙",
  "意大利",
  "日本",
  "巴西",
] as const;

export const ASSESSMENT_DIMENSIONS = [
  { id: "compliance", label: "违规用语合规" },
  { id: "grammar", label: "语法准确性" },
  { id: "professionalism", label: "话术规范" },
  { id: "effectiveness", label: "沟通有效性" },
  { id: "empathy", label: "客户情绪安抚" },
  { id: "resolution", label: "问题解决" },
] as const;

export const ACCEPTANCE_THRESHOLDS = {
  minConversationTurns: 20,
  minTextLanguages: 3,
  minVoiceLanguages: 3,
  minConcurrentBuyers: 3,
  ttftTargetMs: 3_000,
  ttftTargetPassRate: 0.99,
  ttftMaximumMs: 10_000,
  minOutputCharactersPerSecond: 20,
  voiceMaximumMs: 5_000,
  monitoringRefreshMaximumMs: 10_000,
  acceptanceConversationSamples: 100,
  accountCapacity: 200,
  serviceYears: 3,
} as const;

export type UserRole = "student" | "teacher" | "admin";
export type TaskStatus = "pending" | "active" | "completed";

export interface TrainingScenario {
  id: string;
  name: string;
  stage: BusinessStage;
  objective: string;
  defaultLanguage: (typeof SUPPORTED_LANGUAGES)[number];
  enabled: boolean;
  channel: ScenarioChannel;
  orderKind: OrderKind;
  /** D-33：适用客户价值层（新建任务选了这个场景时预选人群范围），空 = 不限 */
  customerTypes?: string[];
  script?: ScenarioScript;
}

/** 场景剧本（J5）：让买家有明确目标和底线，而不是只凭一句场景描述即兴发挥 */
export interface ScenarioScript {
  /** 买家这次想达成什么 */
  buyerGoal: string;
  /** 隐藏信息：客服问到点子上才透露（如真实损坏程度） */
  hiddenInfo: string;
  /** 情绪触发点：哪些做法让买家更不满、哪些让买家缓和 */
  emotionTriggers: string;
  /** 让步底线：买家最多接受到什么程度 */
  bottomLine: string;
  /** 结束条件：满意离开 / 失望离开的判定 */
  endConditions: string;
}

export const SCENARIO_SCRIPT_FIELDS: Array<{ key: keyof ScenarioScript; label: string }> = [
  { key: "buyerGoal", label: "买家目标" },
  { key: "hiddenInfo", label: "隐藏信息" },
  { key: "emotionTriggers", label: "情绪触发点" },
  { key: "bottomLine", label: "让步底线" },
  { key: "endConditions", label: "结束条件" },
];

export interface PersonaTemplate {
  id: string;
  name: string;
  gender: "male" | "female";
  nationality: (typeof NATIONALITIES)[number];
  identity: string;
  personality: (typeof PERSONALITIES)[number];
  emotion: (typeof EMOTIONS)[number];
  language: (typeof SUPPORTED_LANGUAGES)[number];
  preference: string;
  customerType: (typeof CUSTOMER_TYPES)[number];
  enabled: boolean;
  /** D-33 结构化字段：买家角色、决策风格、关注点（≤3）、补充说明。identity / preference 由它们派生，保留给旧会话快照和提示词 */
  buyerRole?: string | null;
  decisionStyle?: string | null;
  concerns?: string[];
  note?: string | null;
}

export interface ConversationMetric {
  requestId: string;
  receivedAt: string;
  firstCharacterAt?: string;
  completedAt?: string;
  validCharacters: number;
  provider: string;
  model: string;
  outcome: "success" | "timeout" | "error";
}

export * from "./llm";
export * from "./product";
export * from "./persona";
