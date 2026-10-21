import type { ZodType } from "zod";
import {
  LLM_PURPOSES,
  LLM_PURPOSE_LABELS,
  type LlmPurpose,
  type LlmRoute,
  type LlmRoutingSettings,
  type LlmTestResult,
  type LlmThinking,
} from "@cecs/contracts";
import type { Db } from "../db";
import { getSetting } from "../settings";
import { writeAudit } from "../auth-context";
import type { SecretSealer } from "./secret";
import { LlmCallError, streamChat, type ChatEvent, type ChatMessage, type ChatRequest, type ResolvedProfile } from "./pi-adapter";

export type { ChatMessage } from "./pi-adapter";

/**
 * 有的模型只接受默认的 temperature，传别的值直接 400（2026-10-14 探针：claude-haiku-5-5、claude-sonnet-5-5 拒绝，
 * 同家的 claude-opus-5-5、claude-haiku-4-5 接受；OpenAI 推理类模型也有同样限制）。型号之间没有规律，
 * 不维护名单：被拒一次就去掉 temperature 重发，并记住这个档案。
 */
export function rejectsTemperature(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /temperature/i.test(message) && /not support|unsupported|only the default|only supports/i.test(message);
}

/** 带 temperature 先试；被拒且还没出字时，去掉 temperature 再发一次。返回值告诉调用方是否去掉过 */
async function* streamWithTemperatureFallback(
  profile: ResolvedProfile,
  request: ChatRequest,
  signal: AbortSignal,
  onRejected: () => void,
): AsyncGenerator<ChatEvent> {
  let emitted = false;
  try {
    for await (const event of streamChat(profile, request, signal)) {
      if (event.type === "text") emitted = true;
      yield event;
    }
  } catch (error) {
    if (emitted || request.temperature === undefined || !rejectsTemperature(error)) throw error;
    onRejected();
    yield* streamChat(profile, { ...request, temperature: undefined }, signal);
  }
}

/** 主档案连续失败多少次后熔断、熔断多久（期间直接走备用档案） */
const FAILOVER_THRESHOLD = 3;
const FAILOVER_COOLDOWN_MS = 5 * 60_000;
const healthKey = (profileId: string, purpose: LlmPurpose) => `${profileId}:${purpose}`;

export interface CallOptions {
  signal?: AbortSignal;
  conversationId?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 一次调用实际落到的档案（写指标与评分追溯用） */
export interface CallInfo {
  profileId: string;
  profileName: string;
  model: string;
  fallback: boolean;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("AI_PROVIDER_NOT_CONFIGURED");
  }
}

export class LlmParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
  }
}

interface ProfileRow {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string;
  model: string;
  extra_headers: Record<string, string> | null;
  extra_body: Record<string, unknown> | null;
  thinking: LlmThinking | null;
  max_tokens_field: "max_tokens" | "max_completion_tokens";
  json_mode: boolean;
  timeout_ms: number;
  price_input: string | number;
  price_output: string | number;
  is_default: boolean;
}

export function defaultRouting(): LlmRoutingSettings {
  const routes = {} as Record<LlmPurpose, LlmRoute>;
  for (const purpose of LLM_PURPOSES) {
    routes[purpose] = {
      profileId: null,
      fallbackProfileId: null,
      temperature: LLM_PURPOSE_LABELS[purpose].temperature,
      maxTokens: LLM_PURPOSE_LABELS[purpose].maxTokens,
    };
  }
  return { routes, directorEveryNTurns: 1 };
}

export function normalizeRouting(saved: Partial<LlmRoutingSettings> | null): LlmRoutingSettings {
  const base = defaultRouting();
  for (const purpose of LLM_PURPOSES) {
    const route = saved?.routes?.[purpose];
    if (route) base.routes[purpose] = { ...base.routes[purpose], ...route };
  }
  const every = Number(saved?.directorEveryNTurns);
  base.directorEveryNTurns = Number.isFinite(every) ? Math.max(1, Math.min(10, Math.round(every))) : 1;
  return base;
}

/** 从模型输出里取 JSON：去掉 ``` 围栏，取第一个完整对象 / 数组 */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start < 0) throw new Error("NO_JSON");
    const open = text[start]!;
    const close = open === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end <= start) throw new Error("NO_JSON");
    return JSON.parse(text.slice(start, end + 1));
  }
}

/**
 * 模型网关：所有 LLM 调用的唯一入口。
 * - 按用途路由到档案（未指定时用默认档案），可配置备用档案；
 * - 主档案报错且尚未输出正文时立即改用备用；连续失败达阈值后熔断一段时间并写审计告警；
 * - 每次调用记 llm_usage（tokens、按档案单价折算的费用、首字、结果）。
 * 配置变更后调用 reload() 热生效，不用重启。
 */
export class LlmGateway {
  private profiles = new Map<string, ResolvedProfile>();
  private defaultId: string | null = null;
  private routing: LlmRoutingSettings = defaultRouting();
  /** 熔断按“档案 + 用途”分开计（L3）：评分连续出错不会把买家对话也切到备用。键见 healthKey */
  private health = new Map<string, { failures: number; openUntil: number }>();
  /** 只接受默认 temperature 的档案（键：档案 id + 模型名，换了模型重新判断） */
  private defaultTemperatureOnly = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly sealer: SecretSealer,
    private readonly log: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void },
  ) {}

  async reload(): Promise<void> {
    const result = await this.db.query<ProfileRow>(
      `select id, name, base_url, api_key_enc, model, extra_headers, extra_body, thinking, max_tokens_field,
              json_mode, timeout_ms, price_input, price_output, is_default
       from llm_profiles where enabled`,
    );
    const next = new Map<string, ResolvedProfile>();
    let defaultId: string | null = null;
    for (const row of result.rows) {
      let apiKey = "";
      try {
        apiKey = this.sealer.open(row.api_key_enc);
      } catch {
        this.log.error({ profile: row.name }, "llm profile api key cannot be decrypted (SETTINGS_ENCRYPTION_KEY changed?)");
        continue;
      }
      next.set(row.id, profileFromRow(row, apiKey));
      if (row.is_default) defaultId = row.id;
    }
    this.profiles = next;
    this.defaultId = defaultId;
    this.routing = normalizeRouting(await getSetting<Partial<LlmRoutingSettings>>(this.db, "llm_routing"));
  }

  get directorEveryNTurns(): number {
    return this.routing.directorEveryNTurns;
  }

  isConfigured(purpose: LlmPurpose = "dialogue"): boolean {
    return this.candidates(purpose).length > 0;
  }

  /** 该用途当前生效的档案（展示用） */
  describe(purpose: LlmPurpose = "dialogue"): { profileName: string; model: string } | null {
    const first = this.candidates(purpose)[0];
    return first ? { profileName: first.name, model: first.model } : null;
  }

  private candidates(purpose: LlmPurpose): Array<ResolvedProfile & { isFallback: boolean }> {
    const route = this.routing.routes[purpose];
    const primary = this.profiles.get(route.profileId ?? "") ?? this.profiles.get(this.defaultId ?? "");
    const fallback = route.fallbackProfileId ? this.profiles.get(route.fallbackProfileId) : undefined;
    const list: Array<ResolvedProfile & { isFallback: boolean }> = [];
    if (primary) list.push({ ...primary, isFallback: false });
    if (fallback && fallback.id !== primary?.id) list.push({ ...fallback, isFallback: true });
    // 主档案熔断中：备用优先
    if (list.length === 2 && (this.health.get(healthKey(list[0]!.id, purpose))?.openUntil ?? 0) > Date.now()) list.reverse();
    return list;
  }

  /** 对某个档案发起流式调用：已知只接受默认 temperature 的直接不传，否则被拒时自动去掉重发并记住 */
  private streamProfile(profile: ResolvedProfile, request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const key = `${profile.id}:${profile.model}`;
    if (this.defaultTemperatureOnly.has(key)) return streamChat(profile, { ...request, temperature: undefined }, signal);
    return streamWithTemperatureFallback(profile, request, signal, () => {
      this.defaultTemperatureOnly.add(key);
      this.log.warn({ profile: profile.name, model: profile.model }, "model only accepts default temperature, omitting it");
    });
  }

  private request(purpose: LlmPurpose, messages: ChatMessage[], options: CallOptions, json: boolean): ChatRequest {
    const route = this.routing.routes[purpose];
    return {
      messages,
      temperature: options.temperature ?? route.temperature,
      maxTokens: options.maxTokens ?? route.maxTokens,
      json,
    };
  }

  /**
   * 流式调用：逐段产出正文。尚未产出正文时出错会自动换下一个档案；
   * 已经输出过正文再出错则直接抛出（避免同一轮出现两段不同回复）。
   */
  async *stream(
    purpose: LlmPurpose,
    messages: ChatMessage[],
    options: CallOptions & { onInfo?: (info: CallInfo) => void } = {},
  ): AsyncGenerator<string> {
    const candidates = this.candidates(purpose);
    if (candidates.length === 0) throw new LlmNotConfiguredError();
    const request = this.request(purpose, messages, options, false);
    let lastError: unknown;
    for (const profile of candidates) {
      const startedAt = Date.now();
      let ttft: number | null = null;
      let emitted = false;
      const signal = options.signal ?? AbortSignal.timeout(profile.timeoutMs);
      try {
        let usage = { input: 0, output: 0 };
        for await (const event of this.streamProfile(profile, request, signal)) {
          if (event.type === "text" && event.text) {
            if (ttft === null) ttft = Date.now() - startedAt;
            emitted = true;
            yield event.text;
          } else if (event.type === "done" && event.usage) {
            usage = event.usage;
          }
        }
        options.onInfo?.(infoOf(profile));
        this.markSuccess(profile.id, purpose);
        await this.recordUsage(profile, purpose, "success", usage, ttft, startedAt, options.conversationId);
        return;
      } catch (error) {
        lastError = error;
        const outcome = signal.aborted && !(error instanceof LlmCallError && !error.aborted) ? "timeout" : "error";
        await this.recordUsage(profile, purpose, outcome, { input: 0, output: 0 }, ttft, startedAt, options.conversationId, error);
        await this.markFailure(profile, purpose);
        if (emitted || options.signal?.aborted) break;
      }
    }
    throw lastError;
  }

  /** 非流式补全（内部仍走流式，统一首字与用量统计） */
  async complete(purpose: LlmPurpose, messages: ChatMessage[], options: CallOptions = {}): Promise<{ text: string; info: CallInfo }> {
    return this.completeRaw(purpose, messages, options, false);
  }

  private async completeRaw(
    purpose: LlmPurpose,
    messages: ChatMessage[],
    options: CallOptions,
    json: boolean,
  ): Promise<{ text: string; info: CallInfo }> {
    const candidates = this.candidates(purpose);
    if (candidates.length === 0) throw new LlmNotConfiguredError();
    const request = this.request(purpose, messages, options, json);
    let lastError: unknown;
    for (const profile of candidates) {
      const startedAt = Date.now();
      let ttft: number | null = null;
      const signal = options.signal ?? AbortSignal.timeout(profile.timeoutMs);
      try {
        let text = "";
        let usage = { input: 0, output: 0 };
        for await (const event of this.streamProfile(profile, request, signal)) {
          if (event.type === "text" && event.text) {
            if (ttft === null) ttft = Date.now() - startedAt;
            text += event.text;
          } else if (event.type === "done" && event.usage) {
            usage = event.usage;
          }
        }
        if (!text.trim()) throw new LlmCallError("LLM_EMPTY_COMPLETION");
        this.markSuccess(profile.id, purpose);
        await this.recordUsage(profile, purpose, "success", usage, ttft, startedAt, options.conversationId);
        return { text: text.trim(), info: infoOf(profile) };
      } catch (error) {
        lastError = error;
        const outcome = signal.aborted ? "timeout" : "error";
        await this.recordUsage(profile, purpose, outcome, { input: 0, output: 0 }, ttft, startedAt, options.conversationId, error);
        await this.markFailure(profile, purpose);
        if (options.signal?.aborted) break;
      }
    }
    throw lastError;
  }

  /**
   * 结构化输出（J3）：JSON 模式 + zod 校验；不合格时把错误反馈给模型重试 1 次，仍失败抛 LlmParseError
   * 并记一条 parse_error 用量，由调用方决定降级方式。
   */
  async completeJson<T>(
    purpose: LlmPurpose,
    messages: ChatMessage[],
    schema: ZodType<T>,
    options: CallOptions = {},
  ): Promise<{ data: T; info: CallInfo }> {
    let attemptMessages = messages;
    let lastRaw = "";
    let lastProblem = "";
    let info: CallInfo | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.completeRaw(purpose, attemptMessages, options, true);
      info = result.info;
      lastRaw = result.text;
      try {
        const parsed = schema.safeParse(extractJson(result.text));
        if (parsed.success) return { data: parsed.data, info };
        lastProblem = parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
      } catch (error) {
        lastProblem = `not valid JSON (${(error as Error).message})`;
      }
      attemptMessages = [
        ...messages,
        { role: "assistant", content: result.text.slice(0, 4000) },
        { role: "user", content: `Your previous output was rejected: ${lastProblem}. Reply again with ONLY the corrected JSON, no other text.` },
      ];
    }
    await this.db
      .query(
        `insert into llm_usage (profile_id, profile_name, model, purpose, outcome, conversation_id, error)
         values ($1, $2, $3, $4, 'parse_error', $5, $6)`,
        [info?.profileId ?? null, info?.profileName ?? "-", info?.model ?? "-", purpose, options.conversationId ?? null, `${lastProblem}\n${lastRaw}`.slice(0, 2000)],
      )
      .catch(() => undefined);
    throw new LlmParseError(`LLM_OUTPUT_INVALID: ${lastProblem}`, lastRaw);
  }

  private markSuccess(profileId: string, purpose: LlmPurpose): void {
    this.health.delete(healthKey(profileId, purpose));
  }

  /** 管理员重新测试通过：清掉这个档案在各用途上的失败计数和熔断，下一次调用直接回到主档案 */
  markHealthy(profileId: string): void {
    for (const purpose of LLM_PURPOSES) this.health.delete(healthKey(profileId, purpose));
  }

  private async markFailure(profile: ResolvedProfile, purpose: LlmPurpose): Promise<void> {
    const key = healthKey(profile.id, purpose);
    const state = this.health.get(key) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= FAILOVER_THRESHOLD && state.openUntil < Date.now()) {
      state.openUntil = Date.now() + FAILOVER_COOLDOWN_MS;
      this.log.warn({ profile: profile.name, purpose, failures: state.failures }, "llm profile circuit opened");
      // 告警：写审计，管理端「系统总览 / 审计日志」可见
      await writeAudit(this.db, null, "llm.failover", profile.id, {
        profile: profile.name,
        purpose,
        failures: state.failures,
        cooldownMinutes: FAILOVER_COOLDOWN_MS / 60_000,
      }).catch((error) => this.log.error(error, "write failover audit failed"));
    }
    this.health.set(key, state);
  }

  private async recordUsage(
    profile: ResolvedProfile,
    purpose: LlmPurpose,
    outcome: "success" | "error" | "timeout",
    usage: { input: number; output: number },
    ttft: number | null,
    startedAt: number,
    conversationId: string | undefined,
    error?: unknown,
  ): Promise<void> {
    const cost = (usage.input * profile.priceInput + usage.output * profile.priceOutput) / 1_000_000;
    await this.db
      .query(
        `insert into llm_usage
           (profile_id, profile_name, model, purpose, outcome, input_tokens, output_tokens, cost, ttft_ms, duration_ms, fallback, conversation_id, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          profile.id,
          profile.name,
          profile.model,
          purpose,
          outcome,
          usage.input,
          usage.output,
          cost,
          ttft,
          Date.now() - startedAt,
          (profile as ResolvedProfile & { isFallback?: boolean }).isFallback === true,
          conversationId ?? null,
          error ? String((error as Error).message ?? error).slice(0, 2000) : null,
        ],
      )
      .catch((dbError) => this.log.error(dbError, "record llm usage failed"));
  }

  /** 连通性测试（G4）：发一条极短请求，返回首字、输出速度与上游报错原文 */
  static async test(profile: ResolvedProfile): Promise<LlmTestResult> {
    let startedAt = Date.now();
    let note: string | null = null;
    let ttft: number | null = null;
    let text = "";
    let usage = { input: 0, output: 0 };
    try {
      const request: ChatRequest = {
        messages: [
          { role: "system", content: "You are a buyer chatting with an online store. Reply in one short casual sentence." },
          { role: "user", content: "Hi! How can I help you today?" },
        ],
        temperature: 0.7,
        maxTokens: 80,
      };
      const signal = AbortSignal.timeout(Math.min(profile.timeoutMs, 30_000));
      const events = streamWithTemperatureFallback(profile, request, signal, () => {
        // 首字从去掉 temperature 重发那一刻算
        startedAt = Date.now();
        note = "这个模型只接受默认的随机性（temperature），系统会自动不传；用途分配里给它设的随机性不生效。";
      });
      for await (const event of events) {
        if (event.type === "text" && event.text) {
          if (ttft === null) ttft = Date.now() - startedAt;
          text += event.text;
        } else if (event.type === "done" && event.usage) {
          usage = event.usage;
        }
      }
      const totalMs = Date.now() - startedAt;
      if (!text.trim()) {
        return { ok: false, ttftMs: null, charsPerSecond: null, totalMs, inputTokens: usage.input, outputTokens: usage.output, sample: "", error: "上游返回成功但正文为空（常见原因：模型在思考，回复长度被思考用完了；把「深度思考」关掉或调低档位再测）" };
      }
      const genSeconds = Math.max((totalMs - (ttft ?? totalMs)) / 1000, 0.001);
      return {
        ok: true,
        ttftMs: ttft,
        charsPerSecond: Math.round(text.length / genSeconds),
        totalMs,
        inputTokens: usage.input,
        outputTokens: usage.output,
        sample: text.trim().slice(0, 200),
        error: null,
        note,
      };
    } catch (error) {
      return {
        ok: false,
        ttftMs: ttft,
        charsPerSecond: null,
        totalMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        sample: text.slice(0, 200),
        error: String((error as Error).message ?? error).slice(0, 2000) + thinkingHint(profile),
      };
    }
  }
}

/** 测试失败时，档案在发思考参数就补一句：不同模型能用的思考设置不一样 */
function thinkingHint(profile: ResolvedProfile): string {
  if (!profile.thinking.params) return "";
  const sending = !profile.thinking.enabled || profile.thinking.level !== "default";
  return sending ? "\n\n如果是思考参数不被接受：有的模型不能关闭思考、或只支持部分档位（例如 GLM 经总网关只能选 低 / 高 / 最高），换一下「深度思考」再测。" : "";
}

function infoOf(profile: ResolvedProfile & { isFallback?: boolean }): CallInfo {
  return { profileId: profile.id, profileName: profile.name, model: profile.model, fallback: profile.isFallback === true };
}

export function profileFromRow(row: ProfileRow, apiKey: string): ResolvedProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey,
    model: row.model,
    extraHeaders: row.extra_headers ?? {},
    extraBody: row.extra_body ?? {},
    thinking: row.thinking ?? { enabled: false, level: "default", params: null },
    maxTokensField: row.max_tokens_field,
    jsonMode: row.json_mode,
    timeoutMs: row.timeout_ms,
    priceInput: Number(row.price_input) || 0,
    priceOutput: Number(row.price_output) || 0,
  };
}
