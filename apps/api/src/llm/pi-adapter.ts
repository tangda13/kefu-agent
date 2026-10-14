import type { Context, Model } from "@earendil-works/pi-ai";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { thinkingBody, type LlmThinking } from "@cecs/contracts";

/**
 * pi（@earendil-works/pi-ai 0.82.1，决策 D-18）适配层：管理端档案 → pi Model。
 * pi 负责发请求、解析 SSE、错误归一和用量；业务编排在我们自己的代码里。
 *
 * 不写死（D-17）的做法：
 * - reasoning=false：pi 不会按厂商下发任何思考参数；
 * - compat 显式写全：pi 会按 baseUrl/厂商名自动探测兼容项（例如识别 deepseek.com），这里全部覆盖，
 *   保证同一份配置无论填官方地址还是自建网关地址，请求体都一样；
 * - 厂商专有参数只经 extraBody 从配置合并进请求体（onPayload 钩子）；
 * - 深度思考按档案里存的写法（thinking.params）合并，代码不判断厂商。
 */
export interface ResolvedProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  /** 深度思考开关、档位与该厂商的参数写法 */
  thinking: LlmThinking;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  jsonMode: boolean;
  timeoutMs: number;
  /** 元 / 百万 tokens */
  priceInput: number;
  priceOutput: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 要求 JSON 输出：档案开启 jsonMode 时下发 response_format=json_object */
  json?: boolean;
}

export interface ChatEvent {
  type: "text" | "done";
  text?: string;
  usage?: { input: number; output: number };
}

export function toPiModel(profile: ResolvedProfile): Model<"openai-completions"> {
  return {
    id: profile.model,
    name: profile.model,
    api: "openai-completions",
    // 自定义 provider 名，避免触发 pi 按厂商名的内置行为
    provider: `cecs-profile-${profile.id}`,
    baseUrl: profile.baseUrl,
    reasoning: false,
    input: ["text"],
    // 费用由我方按档案单价（元）计算，不用 pi 的美元单价
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    headers: { ...profile.extraHeaders },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: profile.maxTokensField,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: "openai",
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
      sendSessionAffinityHeaders: false,
      supportsLongCacheRetention: false,
    },
  };
}

/**
 * 最终请求体 = pi 生成的参数（model/stream/max_tokens/temperature/stream_options）
 *            → response_format（JSON 模式）→ 深度思考参数 → 档案 extraBody → 强制项（model、stream、messages）。
 * 消息数组由我方构造后整体替换：对话中途的教师指导需要以 system 角色插入，pi 的 Context 不支持。
 */
export function buildPayload(
  base: Record<string, unknown>,
  profile: ResolvedProfile,
  request: ChatRequest,
): Record<string, unknown> {
  return {
    ...base,
    ...(request.json && profile.jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...thinkingBody(profile.thinking),
    ...profile.extraBody,
    model: profile.model,
    stream: true,
    messages: request.messages.map((item) => ({ role: item.role, content: item.content })),
  };
}

/**
 * 思考也算在 max_tokens 里（DeepSeek、Claude、OpenAI 推理模型都是）：没明确关掉思考时多留这么多，
 * 免得用途里设的回复长度（如买家对话 400）全被思考吃掉、正文为空。只是上限，按实际用量计费。
 */
export const THINKING_HEADROOM_TOKENS = 4096;

/** 这个档案会不会思考：明确关闭才算不会（没有开关的厂商按模型默认，可能会） */
export function mayThink(profile: ResolvedProfile): boolean {
  return !(profile.thinking.params && !profile.thinking.enabled);
}

export async function* streamChat(
  profile: ResolvedProfile,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const model = toPiModel(profile);
  // pi 的 Context 只用来满足接口，真正的消息在 onPayload 里替换
  const context: Context = { messages: [{ role: "user", content: ".", timestamp: Date.now() }] };
  const events = streamOpenAICompletions(model, context, {
    apiKey: profile.apiKey || "none",
    temperature: request.temperature,
    maxTokens: request.maxTokens !== undefined && mayThink(profile) ? request.maxTokens + THINKING_HEADROOM_TOKENS : request.maxTokens,
    signal,
    timeoutMs: profile.timeoutMs,
    maxRetries: 0,
    cacheRetention: "none",
    onPayload: (payload) => buildPayload(payload as Record<string, unknown>, profile, request),
  });
  for await (const event of events) {
    if (event.type === "text_delta") {
      if (event.delta) yield { type: "text", text: event.delta };
    } else if (event.type === "done") {
      yield { type: "done", usage: { input: event.message.usage.input, output: event.message.usage.output } };
      return;
    } else if (event.type === "error") {
      const message = event.error.errorMessage || (event.reason === "aborted" ? "aborted" : "LLM_ERROR");
      throw new LlmCallError(message, event.reason === "aborted");
    }
  }
}

export class LlmCallError extends Error {
  constructor(message: string, readonly aborted = false) {
    super(message);
    this.name = "LlmCallError";
  }
}
