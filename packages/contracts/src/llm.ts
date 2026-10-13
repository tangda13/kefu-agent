/**
 * 模型网关共享定义（前后端共用）。
 * 预置模板只是“新增档案表单的默认值”，保存后一切以数据库为准；后端代码不出现任何厂商判断分支（决策 D-17）。
 */

/** 模型用途：每种用途可分别指定档案（主 + 备用）与采样参数 */
export const LLM_PURPOSES = ["dialogue", "director", "assessment", "assist"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export const LLM_PURPOSE_LABELS: Record<LlmPurpose, { label: string; hint: string; temperature: number; maxTokens: number }> = {
  dialogue: { label: "买家对话", hint: "学生实时对话，最看重回复速度，建议关闭深度思考", temperature: 0.8, maxTokens: 400 },
  director: { label: "情绪与剧情推进", hint: "在后台推演买家情绪和剧情走向，可用便宜、快速的模型", temperature: 0.3, maxTokens: 600 },
  assessment: { label: "六维评分", hint: "会话结束后评分，看重稳定和准确", temperature: 0.2, maxTokens: 1200 },
  assist: { label: "辅助生成", hint: "回复建议、邮件草稿、翻译、买家评价等", temperature: 0.5, maxTokens: 1200 },
};

/** 协议族：目前只开放 OpenAI 兼容 Chat Completions（国内主流厂商与 NewAPI 网关均支持） */
export const LLM_PROTOCOLS = ["openai-completions"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

export interface LlmPreset {
  key: string;
  label: string;
  /** pi 在其后拼接 /chat/completions */
  baseUrl: string;
  models: string[];
  extraBody: Record<string, unknown>;
  jsonMode: boolean;
  note: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    key: "deepseek",
    label: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    extraBody: { thinking: { type: "disabled" } },
    jsonMode: true,
    note: "默认推荐。必须关闭思考，否则首字 1.6 秒以上甚至正文为空；关闭后首字约 0.5 秒",
  },
  {
    key: "qwen",
    label: "通义千问（阿里云百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-flash", "qwen-plus"],
    extraBody: { enable_thinking: false },
    jsonMode: true,
    note: "混合思考模型需 enable_thinking=false",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5-air", "glm-4-flash"],
    extraBody: { thinking: { type: "disabled" } },
    jsonMode: true,
    note: "GLM-4.5 系列默认开思考，需关闭",
  },
  {
    key: "ark",
    label: "豆包（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-1-6-flash-250828"],
    extraBody: { thinking: { type: "disabled" } },
    jsonMode: true,
    note: "模型名填方舟控制台的模型 ID 或推理接入点 ID",
  },
  {
    key: "kimi",
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-turbo-preview", "moonshot-v1-8k"],
    extraBody: {},
    jsonMode: true,
    note: "",
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-8B"],
    extraBody: { enable_thinking: false },
    jsonMode: true,
    note: "Qwen3 等混合思考模型需 enable_thinking=false",
  },
  {
    key: "newapi",
    label: "自建网关（NewAPI）",
    baseUrl: "",
    models: [],
    extraBody: {},
    jsonMode: true,
    note: "地址填到 /v1，例如 https://网关域名/v1；厂商专有参数按上游模型填写",
  },
  {
    key: "custom",
    label: "OpenAI 兼容（自定义）",
    baseUrl: "",
    models: [],
    extraBody: {},
    jsonMode: false,
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
