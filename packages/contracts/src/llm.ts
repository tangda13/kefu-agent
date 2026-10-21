/**
 * 模型网关共享定义（前后端共用）。
 * 预置模板只是“新增档案表单的默认值”，保存后一切以数据库为准；后端代码不出现任何厂商判断分支（决策 D-17）。
 */

/** 模型用途：每种用途可分别指定档案（主 + 备用）与采样参数 */
export const LLM_PURPOSES = ["dialogue", "director", "assessment", "assist"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export const LLM_PURPOSE_LABELS: Record<LlmPurpose, { label: string; hint: string; temperature: number; maxTokens: number }> = {
  dialogue: { label: "买家对话", hint: "学生实时对话，最看重回复速度，建议关闭深度思考", temperature: 0.8, maxTokens: 400 },
  director: { label: "满意度与表现评估", hint: "在后台评估买家满意度、情绪和学生每轮表现（教师端走势、评分依据、催促快慢），不影响买家说什么；可用便宜、快速的模型", temperature: 0.3, maxTokens: 600 },
  assessment: { label: "能力评分", hint: "会话结束后评分，看重稳定和准确", temperature: 0.2, maxTokens: 1200 },
  assist: { label: "辅助生成", hint: "回复建议、邮件草稿、翻译、买家评价等", temperature: 0.5, maxTokens: 1200 },
};

/** 协议族：目前只开放 OpenAI 兼容 Chat Completions（国内主流厂商与 NewAPI 网关均支持） */
export const LLM_PROTOCOLS = ["openai-completions"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

/** 思考档位（不含“模型默认”）：低 / 中 / 高 / 最高 */
export const THINKING_LEVELS = ["low", "medium", "high", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel | "default", string> = {
  default: "模型默认",
  low: "低",
  medium: "中",
  high: "高",
  max: "最高",
};

/**
 * 厂商的思考参数写法：关闭、开启、各档位分别往请求体里合并什么。
 * 没列出的档位就是这个厂商表达不了，界面不给选（不悄悄降档）。保存档案时随档案存库，后端只按存的写法合并。
 */
export interface LlmThinkingParams {
  off: Record<string, unknown>;
  on: Record<string, unknown>;
  levels: Partial<Record<ThinkingLevel, Record<string, unknown>>>;
}

/** 档案的深度思考设置；params 为 null 表示这个厂商没有思考开关，什么都不发 */
export interface LlmThinking {
  enabled: boolean;
  level: ThinkingLevel | "default";
  params: LlmThinkingParams | null;
}

/** 按开关和档位算出要合并进请求体的思考参数（前后端共用） */
export function thinkingBody(thinking: LlmThinking | null | undefined): Record<string, unknown> {
  if (!thinking?.params) return {};
  if (!thinking.enabled) return { ...thinking.params.off };
  const level = thinking.level === "default" ? {} : (thinking.params.levels[thinking.level] ?? {});
  return { ...thinking.params.on, ...level };
}

/** 思考参数会用到的请求体字段（附加请求参数里不能再写这些，免得和开关打架） */
export function thinkingKeys(params: LlmThinkingParams | null | undefined): string[] {
  if (!params) return [];
  const keys = new Set([...Object.keys(params.off), ...Object.keys(params.on)]);
  for (const body of Object.values(params.levels)) for (const key of Object.keys(body ?? {})) keys.add(key);
  return [...keys];
}

/** OpenAI 标准写法 reasoning_effort（2026-10-14 经 NewAPI 总网关实测：DeepSeek、Claude 认 none 关闭和 low～max 档位） */
const EFFORT_LEVELS: LlmThinkingParams["levels"] = {
  low: { reasoning_effort: "low" },
  medium: { reasoning_effort: "medium" },
  high: { reasoning_effort: "high" },
  max: { reasoning_effort: "max" },
};

export interface LlmPreset {
  key: string;
  label: string;
  /** pi 在其后拼接 /chat/completions */
  baseUrl: string;
  models: string[];
  extraBody: Record<string, unknown>;
  jsonMode: boolean;
  /** 思考参数写法；null = 没有思考开关 */
  thinking: LlmThinkingParams | null;
  note: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    key: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    extraBody: {},
    jsonMode: true,
    thinking: { off: { thinking: { type: "disabled" } }, on: { thinking: { type: "enabled" } }, levels: {} },
    note: "默认推荐。买家对话务必关闭深度思考，否则首字 1.6 秒以上甚至正文为空；关闭后首字约 0.5 秒",
  },
  {
    key: "qwen",
    label: "通义千问（阿里云百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-flash", "qwen-plus"],
    extraBody: {},
    jsonMode: true,
    thinking: { off: { enable_thinking: false }, on: { enable_thinking: true }, levels: {} },
    note: "混合思考模型用 enable_thinking 开关思考",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5-air", "glm-4-flash"],
    extraBody: {},
    jsonMode: true,
    thinking: { off: { thinking: { type: "disabled" } }, on: { thinking: { type: "enabled" } }, levels: {} },
    note: "GLM-4.5 系列默认开思考",
  },
  {
    key: "ark",
    label: "豆包（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-1-6-flash-250828"],
    extraBody: {},
    jsonMode: true,
    thinking: { off: { thinking: { type: "disabled" } }, on: { thinking: { type: "enabled" } }, levels: {} },
    note: "模型名填方舟控制台的模型 ID 或推理接入点 ID",
  },
  {
    key: "kimi",
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-turbo-preview", "moonshot-v1-8k"],
    extraBody: {},
    jsonMode: true,
    thinking: null,
    note: "",
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-8B"],
    extraBody: {},
    jsonMode: true,
    thinking: { off: { enable_thinking: false }, on: { enable_thinking: true }, levels: {} },
    note: "Qwen3 等混合思考模型用 enable_thinking 开关思考",
  },
  {
    key: "newapi",
    label: "自建网关（NewAPI）",
    baseUrl: "",
    models: [],
    extraBody: {},
    jsonMode: true,
    // 关闭时两个都带：总网关多渠道随机分配，DeepSeek 部分渠道只认 thinking.type
    thinking: { off: { thinking: { type: "disabled" }, reasoning_effort: "none" }, on: {}, levels: EFFORT_LEVELS },
    note: "地址填到 /v1，例如 https://网关域名/v1；厂商专有参数按上游模型填写",
  },
  {
    key: "custom",
    label: "OpenAI 兼容（自定义）",
    baseUrl: "",
    models: [],
    extraBody: {},
    jsonMode: false,
    thinking: {
      off: { reasoning_effort: "none" },
      on: {},
      levels: { low: { reasoning_effort: "low" }, medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" } },
    },
    note: "任意兼容 /chat/completions 的服务",
  },
];

/** 管理端看到的档案（Key 打码） */
export interface LlmProfileView {
  id: string;
  name: string;
  presetKey: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  thinking: LlmThinking;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  jsonMode: boolean;
  timeoutMs: number;
  priceInput: number;
  priceOutput: number;
  enabled: boolean;
  isDefault: boolean;
  testStatus: "untested" | "ok" | "failed";
  testResult: LlmTestResult | null;
  testedAt: string | null;
  updatedAt: string;
}

export interface LlmTestResult {
  ok: boolean;
  ttftMs: number | null;
  charsPerSecond: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  sample: string;
  /** 上游报错原文（≤2000 字） */
  error: string | null;
  /** 测试通过但有需要知道的情况（如模型只接受默认 temperature） */
  note?: string | null;
}

export interface LlmRoute {
  profileId: string | null;
  fallbackProfileId: string | null;
  temperature: number;
  maxTokens: number;
}

export interface LlmRoutingSettings {
  routes: Record<LlmPurpose, LlmRoute>;
  /** 导演每 N 轮学生发言运行一次（1 = 每轮） */
  directorEveryNTurns: number;
}

/** 单独指定了别的模型的用途：把 profileId 设为默认时，要问一下这些用途是否一起跟随（D-77） */
export function purposesPinnedElsewhere(routing: LlmRoutingSettings, profileId: string): LlmPurpose[] {
  return LLM_PURPOSES.filter((purpose) => {
    const pinned = routing.routes[purpose].profileId;
    return pinned !== null && pinned !== profileId;
  });
}

/**
 * 默认模型从 from 换成 to 之后的用途分配（D-77）。follow：所有用途一起改为跟随默认。
 * 主模型因此变了的用途，备用如果正好是新的主模型（等于没备用），换成原来的主模型（主备对调）；原来的不可用就清空。
 */
export function routingAfterDefaultSwitch(
  routing: LlmRoutingSettings,
  change: { from: string | null; to: string; follow: boolean; usable: ReadonlySet<string> },
): LlmRoutingSettings {
  const routes = { ...routing.routes };
  for (const purpose of LLM_PURPOSES) {
    const route = routing.routes[purpose];
    const profileId = change.follow ? null : route.profileId;
    const before = route.profileId ?? change.from;
    const after = profileId ?? change.to;
    let fallbackProfileId = route.fallbackProfileId;
    if (before !== after && fallbackProfileId === after) {
      fallbackProfileId = before && change.usable.has(before) ? before : null;
    }
    routes[purpose] = { ...route, profileId, fallbackProfileId };
  }
  return { ...routing, routes };
}
