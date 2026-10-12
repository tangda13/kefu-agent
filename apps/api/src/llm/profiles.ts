import { z } from "zod";
import type { LlmProfileView, LlmTestResult } from "@cecs/contracts";
import type { Db } from "../db";
import { getSetting } from "../settings";
import { maskSecret, type SecretSealer } from "./secret";
import { profileFromRow } from "./gateway";
import type { ResolvedProfile } from "./pi-adapter";

const jsonObject = z.record(z.string(), z.unknown());

/** 管理端提交的档案（apiKey 留空 = 保持原值） */
export const profileInputSchema = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(60),
  presetKey: z.string().trim().max(40).default("custom"),
  baseUrl: z
    .string()
    .trim()
    .url("地址格式不正确")
    .transform((value) => value.replace(/\/+$/, "")),
  apiKey: z.string().trim().max(500).optional(),
  model: z.string().trim().min(1, "模型名不能为空").max(120),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  extraBody: jsonObject.default({}),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  jsonMode: z.boolean().default(false),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(60_000),
  priceInput: z.number().min(0).max(10_000).default(0),
  priceOutput: z.number().min(0).max(10_000).default(0),
  enabled: z.boolean().default(true),
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

/** 请求体里不允许被 extraBody 覆盖的字段（由服务端控制） */
const RESERVED_BODY_KEYS = ["model", "stream", "messages"];

export function validateExtraBody(body: Record<string, unknown>): string | null {
  const hit = RESERVED_BODY_KEYS.find((key) => key in body);
  return hit ? `额外请求体不能包含 ${hit}（由系统控制）` : null;
}

const SELECT_COLUMNS = `id, name, preset_key, protocol, base_url, api_key_enc, model, extra_headers, extra_body,
  max_tokens_field, json_mode, timeout_ms, price_input, price_output, enabled, is_default,
  test_status, test_result, tested_at, updated_at`;

export async function listProfiles(db: Db, sealer: SecretSealer): Promise<LlmProfileView[]> {
  const result = await db.query(`select ${SELECT_COLUMNS} from llm_profiles order by is_default desc, created_at`);
  return result.rows.map((row) => {
    let masked = "";
    try {
      masked = maskSecret(sealer.open(row.api_key_enc));
    } catch {
      masked = "（无法解密，请重新填写）";
    }
    return {
      id: row.id,
      name: row.name,
      presetKey: row.preset_key,
      protocol: row.protocol,
      baseUrl: row.base_url,
      apiKeyMasked: masked,
      model: row.model,
      extraHeaders: row.extra_headers ?? {},
      extraBody: row.extra_body ?? {},
      maxTokensField: row.max_tokens_field,
      jsonMode: row.json_mode,
      timeoutMs: row.timeout_ms,
      priceInput: Number(row.price_input),
      priceOutput: Number(row.price_output),
      enabled: row.enabled,
      isDefault: row.is_default,
      testStatus: row.test_status,
      testResult: (row.test_result as LlmTestResult | null) ?? null,
      testedAt: row.tested_at ? new Date(row.tested_at).toISOString() : null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}

export async function loadResolvedProfile(db: Db, sealer: SecretSealer, id: string): Promise<ResolvedProfile | null> {
  const result = await db.query(`select ${SELECT_COLUMNS} from llm_profiles where id = $1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  return profileFromRow(row, sealer.open(row.api_key_enc));
}

export async function createProfile(db: Db, sealer: SecretSealer, input: ProfileInput): Promise<string> {
  const result = await db.query(
    `insert into llm_profiles (name, preset_key, base_url, api_key_enc, model, extra_headers, extra_body,
       max_tokens_field, json_mode, timeout_ms, price_input, price_output, enabled)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      input.name,
      input.presetKey,
      input.baseUrl,
      sealer.seal(input.apiKey ?? ""),
      input.model,
      JSON.stringify(input.extraHeaders),
      JSON.stringify(input.extraBody),
      input.maxTokensField,
      input.jsonMode,
      input.timeoutMs,
      input.priceInput,
      input.priceOutput,
      input.enabled,
    ],
  );
  return result.rows[0].id as string;
}

/**
 * 更新档案。地址、Key、模型、请求头、请求体、令牌字段、JSON 模式任一变化都会把测试状态重置为未测试：
 * 配置变了，之前的测试结论不再成立（G4：未通过测试的档案不能被指定为生效档案）。
 */
export async function updateProfile(db: Db, sealer: SecretSealer, id: string, input: ProfileInput): Promise<boolean> {
  const current = await db.query(
    "select base_url, api_key_enc, model, extra_headers, extra_body, max_tokens_field, json_mode from llm_profiles where id = $1",
    [id],
  );
  const row = current.rows[0];
  if (!row) return false;
  const apiKeyEnc = input.apiKey ? sealer.seal(input.apiKey) : row.api_key_enc;
  const configChanged =
    row.base_url !== input.baseUrl ||
    Boolean(input.apiKey) ||
    row.model !== input.model ||
    JSON.stringify(row.extra_headers ?? {}) !== JSON.stringify(input.extraHeaders) ||
    JSON.stringify(row.extra_body ?? {}) !== JSON.stringify(input.extraBody) ||
    row.max_tokens_field !== input.maxTokensField ||
    row.json_mode !== input.jsonMode;
  await db.query(
    `update llm_profiles set name = $2, preset_key = $3, base_url = $4, api_key_enc = $5, model = $6,
       extra_headers = $7, extra_body = $8, max_tokens_field = $9, json_mode = $10, timeout_ms = $11,
       price_input = $12, price_output = $13, enabled = $14, updated_at = now(),
       test_status = case when $15 then 'untested' else test_status end,
       test_result = case when $15 then null else test_result end
     where id = $1`,
    [
      id,
      input.name,
      input.presetKey,
      input.baseUrl,
      apiKeyEnc,
      input.model,
      JSON.stringify(input.extraHeaders),
      JSON.stringify(input.extraBody),
      input.maxTokensField,
      input.jsonMode,
      input.timeoutMs,
      input.priceInput,
      input.priceOutput,
      input.enabled,
      configChanged,
    ],
  );
  return true;
}

/** 旧版 baseUrl 不含版本前缀（代码里拼 /v1/chat/completions）；pi 在 baseUrl 后只拼 /chat/completions */
export function legacyBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return url.pathname === "/" || url.pathname === "" ? `${trimmed}/v1` : trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * 首次启动导入：档案表为空时，把旧版配置（管理端保存的 app_settings.llm，其次 .env 的 LLM_*）
 * 导入为默认档案，保证升级后对话不中断。LLM_EXTRA_BODY 可选（JSON），例如关闭思考。
 */
export async function bootstrapProfiles(
  db: Db,
  sealer: SecretSealer,
  env: { llmBaseUrl: string; llmApiKey: string; llmModel: string; llmExtraBody: string },
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  const count = await db.query("select count(*)::int as n from llm_profiles");
  if (count.rows[0].n > 0) return;
  const saved = await getSetting<{ baseUrl?: string; apiKey?: string; model?: string }>(db, "llm");
  const source = saved?.baseUrl && saved.apiKey && saved.model
    ? { baseUrl: saved.baseUrl, apiKey: saved.apiKey, model: saved.model, from: "管理端旧配置" }
    : env.llmBaseUrl && env.llmApiKey && env.llmModel
      ? { baseUrl: env.llmBaseUrl, apiKey: env.llmApiKey, model: env.llmModel, from: ".env" }
      : null;
  if (!source) return;
  let extraBody: Record<string, unknown> = {};
  if (env.llmExtraBody.trim()) {
    try {
      extraBody = JSON.parse(env.llmExtraBody) as Record<string, unknown>;
    } catch {
      log.warn({ value: env.llmExtraBody }, "LLM_EXTRA_BODY is not valid JSON, ignored");
    }
  }
  const host = (() => {
    try {
      return new URL(source.baseUrl).host;
    } catch {
      return source.baseUrl;
    }
  })();
  await db.query(
    `insert into llm_profiles (name, preset_key, base_url, api_key_enc, model, extra_body, is_default)
     values ($1, 'custom', $2, $3, $4, $5, true)`,
    [`${host}（导入自${source.from}）`, legacyBaseUrl(source.baseUrl), sealer.seal(source.apiKey), source.model, JSON.stringify(extraBody)],
  );
  // 旧配置里的明文 Key 不再保留
  if (saved) await db.query("delete from app_settings where key = 'llm'");
  log.info({ from: source.from, host }, "imported legacy llm config as default profile");
}
