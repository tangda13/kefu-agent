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

/**
 * 评分维度（D-46）：参数点名的六项 + 商品信息准确性、消息响应时效。数组顺序就是雷达图上的顺序。
 * - paramLabel：参数文件里的原名（验收对照用），新增两项没有
 * - hint：评分口径，学生端悬停、评分提示词共用
 * - scoredBy：ai = 评分模型打分；system = 系统按消息时间计算，不交给模型
 * id 不变，历史成绩照常对得上；老记录没有新增两项的分，显示“—”。
 */
export const ASSESSMENT_DIMENSIONS = [
  {
    id: "professionalism",
    label: "服务话术规范",
    paramLabel: "话术规范",
    hint: "开场、确认、收尾话术是否到位，称呼和语气是否专业，称呼和礼仪是否符合买家所在国的习惯",
    scoredBy: "ai",
  },
  {
    id: "effectiveness",
    label: "客户沟通有效性",
    paramLabel: "沟通有效性",
    hint: "先回应买家最关心的问题、一次说清；需要订单号、用途、预算等信息时先问清再答",
    scoredBy: "ai",
  },
  {
    id: "empathy",
    label: "客户情绪安抚",
    paramLabel: "客户情绪安抚",
    hint: "识别买家不满，先共情再给方案，买家情绪是否好转",
    scoredBy: "ai",
  },
  {
    id: "resolution",
    label: "订单问题解决",
    paramLabel: "问题解决",
    hint: "方案可执行、写清时限和步骤、问题闭环；售前看是否推进到下单，售中售后看是否挽回取消、纠纷和差评",
    scoredBy: "ai",
  },
  {
    id: "knowledge",
    label: "商品信息准确性",
    hint: "规格参数、物流时效、退换和运费政策是否和店铺资料一致，有没有乱承诺",
    scoredBy: "ai",
  },
  {
    id: "responsiveness",
    label: "消息响应时效",
    hint: "首次响应和平均响应快不快，有没有让买家催促或等到离开；由系统按消息时间计算",
    scoredBy: "system",
  },
  {
    id: "grammar",
    label: "语法准确性",
    paramLabel: "语法准确性",
    hint: "外语拼写、语法、用词是否准确",
    scoredBy: "ai",
  },
  {
    id: "compliance",
    label: "沟通用语合规",
    paramLabel: "违规用语合规",
    hint: "有无绝对化宣传、违规承诺、泄露隐私；命中违规词库会明显扣分",
    scoredBy: "ai",
  },
] as const;

export type AssessmentDimensionId = (typeof ASSESSMENT_DIMENSIONS)[number]["id"];

/** 由评分模型打分的维度（响应时效由系统计算） */
export const AI_ASSESSMENT_DIMENSIONS = ASSESSMENT_DIMENSIONS.filter((dim) => dim.scoredBy === "ai");

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

/**
 * 复盘里的“本次接待”（D-61）：学生端我的记录、教师端回放与评分共用。
 * 和工作台顶栏、我的记录的总数是同一套算法，邮件记录没有这一项。
 */
export type ReceptionEndReason = "buyer_left" | "left_waiting" | "student_ended" | "timeout" | "abandoned" | "task_closed";

export interface ReceptionStats {
  /** 买家服务评价 1–5 星（D-54）；老记录没有为 null */
  rating: number | null;
  /** 平均响应秒数（单轮封顶 10 分钟）；没有买家发言为 null */
  avgReplySec: number | null;
  /** 3 分钟回复率：买家发言的轮次里 3 分钟内回复的次数 / 计入的次数 */
  replyWithin: { within: number; counted: number };
  /** 客服发出的消息条数，和“累计对话”的“共 N 轮”同一口径 */
  rounds: number;
  /** 进线到接待结束的秒数（结束后的工具跟进不算） */
  durationSec: number | null;
  endReason: ReceptionEndReason | null;
}

export * from "./llm";
export * from "./product";
export * from "./persona";
