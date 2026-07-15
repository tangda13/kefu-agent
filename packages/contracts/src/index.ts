export const BUSINESS_STAGES = ["pre_sale", "in_sale", "after_sale", "customer_care"] as const;
export type BusinessStage = (typeof BUSINESS_STAGES)[number];

export const BUSINESS_STAGE_LABELS: Record<BusinessStage, string> = {
  pre_sale: "售前沟通",
  in_sale: "售中处理",
  after_sale: "售后处理",
  customer_care: "客户分层维护",
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
}

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

