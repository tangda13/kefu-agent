import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Db } from "./db";
import { LlmGateway, rejectsTemperature } from "./llm/gateway";
import { streamChat, THINKING_HEADROOM_TOKENS, type ResolvedProfile } from "./llm/pi-adapter";
import { createSecretSealer, maskSecret } from "./llm/secret";
import { legacyBaseUrl, profileInputSchema, validateExtraBody } from "./llm/profiles";
import { LLM_PRESETS, thinkingBody } from "@cecs/contracts";

/**
 * 模型网关测试：用本地假上游接住 pi 真实发出的 HTTP 请求，断言请求体（D-18：思考与 extraBody
 * 参数必须用 pi 实际序列化一次来验证，不能只看配置对象）。不连真实厂商、不依赖数据库。
 */
type Behavior = { kind: "sse"; chunks: string[]; usage?: [number, number] } | { kind: "status"; code: number; body: string };

interface Captured {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  route: string;
}

let server: Server;
let base = "";
const captured: Captured[] = [];
/** 按路由前缀（/a、/b ...）排队的响应 */
const behaviors = new Map<string, Behavior[]>();

function sse(chunks: string[], usage?: [number, number]): string {
  const lines = chunks.map((text) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  if (usage) {
    lines.push(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: usage[0], completion_tokens: usage[1], total_tokens: usage[0] + usage[1] } })}\n\n`);
  }
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const route = `/${(req.url ?? "/").split("/")[1]}`;
      captured.push({ path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {}, route });
      const queue = behaviors.get(route) ?? [];
      const behavior = queue.length > 1 ? queue.shift()! : queue[0] ?? { kind: "sse", chunks: ["ok"] };
      if (behavior.kind === "status") {
        res.writeHead(behavior.code, { "content-type": "application/json" });
        res.end(behavior.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(behavior.chunks, behavior.usage));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured.length = 0;
  behaviors.clear();
});

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    id: "p1",
    name: "测试档案",
    baseUrl: `${base}/a/v1`,
    apiKey: "sk-test",
    model: "deepseek-flash",
    extraHeaders: {},
    extraBody: {},
    // 默认按“明确关闭、且该厂商关闭时不用发参数”：请求体与 max_tokens 不受思考影响
    thinking: { enabled: false, level: "default", params: { off: {}, on: {}, levels: {} } },
    maxTokensField: "max_tokens",
    jsonMode: false,
    timeoutMs: 10_000,
    priceInput: 0,
    priceOutput: 0,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<{ type: string; text?: string }>): Promise<string> {
  let text = "";
  for await (const event of iterable) if (event.type === "text") text += event.text ?? "";
  return text;
}

describe("pi 适配层：请求体序列化（D-17/D-18）", () => {
  it("extraBody 原样合并进请求体，消息数组由我方构造（含对话中途的 system）", async () => {
    behaviors.set("/a", [{ kind: "sse", chunks: ["Hel", "lo"], usage: [12, 3] }]);
    const text = await collect(
      streamChat(
        profile({ extraBody: { thinking: { type: "disabled" } }, extraHeaders: { "x-gateway-tag": "cecs" } }),
        {
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
            { role: "system", content: "[Teacher guidance to trainee]: be polite" },
          ],
          temperature: 0.3,
          maxTokens: 123,
        },
        AbortSignal.timeout(5000),
      ),
    );
    expect(text).toBe("Hello");
    const request = captured[0]!;
    expect(request.path).toBe("/a/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer sk-test");
    expect(request.headers["x-gateway-tag"]).toBe("cecs");
    expect(request.body).toMatchObject({
      model: "deepseek-flash",
      stream: true,
      temperature: 0.3,
      max_tokens: 123,
      thinking: { type: "disabled" },
      stream_options: { include_usage: true },
    });
    expect(request.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "system", content: "[Teacher guidance to trainee]: be polite" },
    ]);
    for (const key of ["max_completion_tokens", "reasoning_effort", "store", "response_format"]) {
      expect(request.body).not.toHaveProperty(key);
    }
  });

  it("深度思考：按档案存的写法合并——关闭发关闭参数、开启发档位参数；会思考时 max_tokens 多留余量", async () => {
    const params = LLM_PRESETS.find((item) => item.key === "newapi")!.thinking!;
    behaviors.set("/a", [{ kind: "sse", chunks: ["x"] }]);
    const ask = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 400 };
    await collect(streamChat(profile({ thinking: { enabled: false, level: "default", params } }), ask, AbortSignal.timeout(5000)));
    expect(captured[0]!.body).toMatchObject({ thinking: { type: "disabled" }, reasoning_effort: "none", max_tokens: 400 });
    await collect(streamChat(profile({ thinking: { enabled: true, level: "high", params } }), ask, AbortSignal.timeout(5000)));
    expect(captured[1]!.body).toMatchObject({ reasoning_effort: "high", max_tokens: 400 + THINKING_HEADROOM_TOKENS });
    expect(captured[1]!.body).not.toHaveProperty("thinking");
    // 开启 + 模型默认：什么思考参数都不发
    await collect(streamChat(profile({ thinking: { enabled: true, level: "default", params } }), ask, AbortSignal.timeout(5000)));
    expect(captured[2]!.body).not.toHaveProperty("reasoning_effort");
    expect(captured[2]!.body).not.toHaveProperty("thinking");
  });

  it("thinkingBody 与附加参数校验：附加参数里写思考字段会被拦下", () => {
    const params = LLM_PRESETS.find((item) => item.key === "deepseek")!.thinking!;
    expect(thinkingBody({ enabled: false, level: "default", params })).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingBody({ enabled: true, level: "default", params })).toEqual({ thinking: { type: "enabled" } });
    expect(thinkingBody({ enabled: true, level: "default", params: null })).toEqual({});
    expect(validateExtraBody({ thinking: { type: "disabled" } }, { enabled: false, level: "default", params })).toContain("深度思考");
    expect(validateExtraBody({ top_k: 20 }, { enabled: false, level: "default", params })).toBeNull();
    expect(profileInputSchema.safeParse({ name: "x", baseUrl: "https://a.com/v1", model: "m", thinking: { enabled: true, level: "high", params } }).success).toBe(false);
  });

  it("地址里带厂商域名也不会触发 pi 的内置厂商参数（行为只由配置决定）", async () => {
    behaviors.set("/b", [{ kind: "sse", chunks: ["x"] }]);
    await collect(streamChat(profile({ baseUrl: `${base}/b/deepseek.com/v1` }), { messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(5000)));
    const body = captured[0]!.body;
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(JSON.stringify(body.messages)).not.toContain("reasoning_content");
  });

  it("max_completion_tokens 字段可配；JSON 模式下发 response_format，extraBody 可覆盖", async () => {
    behaviors.set("/a", [{ kind: "sse", chunks: ["{}"] }]);
    await collect(
      streamChat(profile({ maxTokensField: "max_completion_tokens", jsonMode: true }), { messages: [{ role: "user", content: "json" }], maxTokens: 50, json: true }, AbortSignal.timeout(5000)),
    );
    expect(captured[0]!.body).toMatchObject({ max_completion_tokens: 50, response_format: { type: "json_object" } });
    expect(captured[0]!.body).not.toHaveProperty("max_tokens");
  });

  it("上游报错时抛出并保留原文", async () => {
    behaviors.set("/a", [{ kind: "status", code: 401, body: JSON.stringify({ error: { message: "Authentication Fails (invalid key)" } }) }]);
    await expect(collect(streamChat(profile(), { messages: [{ role: "user", content: "hi" }] }, AbortSignal.timeout(5000)))).rejects.toThrow(/invalid key/);
  });

  it("旧版地址（无版本前缀）导入时补 /v1", () => {
    expect(legacyBaseUrl("https://api.keliagent.cn")).toBe("https://api.keliagent.cn/v1");
    expect(legacyBaseUrl("https://api.keliagent.cn/")).toBe("https://api.keliagent.cn/v1");
    expect(legacyBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });
});

/** 不连数据库的假 Db：档案与路由来自内存，用量写入只记录 */
function fakeDb(rows: Array<Record<string, unknown>>, routing: unknown = null) {
  const usage: unknown[][] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("from llm_profiles")) return { rows, rowCount: rows.length };
      if (sql.includes("from app_settings")) return { rows: routing ? [{ value: routing }] : [], rowCount: routing ? 1 : 0 };
      if (sql.includes("insert into llm_usage")) usage.push(params);
      return { rows: [], rowCount: 0 };
    },
  };
  return { db: db as unknown as Db, usage };
}

const sealer = createSecretSealer("test-key");

function profileRow(id: string, route: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `档案${id}`,
    base_url: `${base}${route}/v1`,
    api_key_enc: sealer.seal(`sk-${id}`),
    model: `model-${id}`,
    extra_headers: {},
    extra_body: {},
    thinking: { enabled: false, level: "default", params: { off: {}, on: {}, levels: {} } },
    max_tokens_field: "max_tokens",
    json_mode: true,
    timeout_ms: 10_000,
    price_input: 2,
    price_output: 8,
    is_default: false,
    ...extra,
  };
}

const log = { warn: () => undefined, error: () => undefined };

describe("模型网关：路由、备用切换、计量、结构化输出", () => {
  it("Key 加密存储可还原，密文不含明文", () => {
    const sealed = sealer.seal("sk-secret-123");
    expect(sealed).not.toContain("sk-secret");
    expect(sealer.open(sealed)).toBe("sk-secret-123");
    expect(() => createSecretSealer("other").open(sealed)).toThrow();
  });

  it("打码：长密钥露前后各 4 位、短的露 2 位、8 位以内全遮，中间固定 4 个星号", () => {
    expect(maskSecret("sk-abcdefghijklmnopqrstuvwxyz1234")).toBe("sk-a****1234");
    expect(maskSecret("abcdefghijkl")).toBe("ab****kl");
    expect(maskSecret("12345678")).toBe("****");
    expect(maskSecret("")).toBe("");
  });

  it("用途未单独指定时走默认档案；按单价折算费用", async () => {
    behaviors.set("/a", [{ kind: "sse", chunks: ["hi"], usage: [1000, 500] }]);
    const { db, usage } = fakeDb([profileRow("1", "/a", { is_default: true })]);
    const gateway = new LlmGateway(db, sealer, log);
    await gateway.reload();
    expect(gateway.isConfigured("assessment")).toBe(true);
    const { text, info } = await gateway.complete("assessment", [{ role: "user", content: "x" }]);
    expect(text).toBe("hi");
    expect(info.model).toBe("model-1");
    // 用途默认参数：评分 temperature 0.2、max_tokens 1200
    expect(captured[0]!.body).toMatchObject({ temperature: 0.2, max_tokens: 1200 });
    const row = usage[0]!;
    expect(row[3]).toBe("assessment");
    expect(row[4]).toBe("success");
    expect(row[7]).toBeCloseTo((1000 * 2 + 500 * 8) / 1_000_000);
  });

  it("主档案报错且未出字时立即改用备用档案；连续失败后熔断，备用优先", async () => {
    behaviors.set("/a", [{ kind: "status", code: 500, body: "upstream down" }]);
    behaviors.set("/b", [{ kind: "sse", chunks: ["fallback ok"] }]);
    const routing = { routes: { dialogue: { profileId: "1", fallbackProfileId: "2", temperature: 0.8, maxTokens: 400 } } };
    const { db, usage } = fakeDb([profileRow("1", "/a", { is_default: true }), profileRow("2", "/b")], routing);
    const gateway = new LlmGateway(db, sealer, log);
    await gateway.reload();
    for (let i = 0; i < 3; i += 1) {
      let used = "";
      let text = "";
      for await (const part of gateway.stream("dialogue", [{ role: "user", content: "hi" }], { onInfo: (info) => (used = info.profileName) })) text += part;
      expect(text).toBe("fallback ok");
      expect(used).toBe("档案2");
    }
    const primaryHits = captured.filter((item) => item.route === "/a").length;
    expect(primaryHits).toBe(3);
    // 第 4 次：主档案已熔断，直接走备用，不再打主档案
    for await (const part of gateway.stream("dialogue", [{ role: "user", content: "hi" }])) void part;
    expect(captured.filter((item) => item.route === "/a").length).toBe(3);
    expect(usage.some((row) => row[4] === "error")).toBe(true);
    expect(usage.some((row) => row[10] === true)).toBe(true);
  });

  it("L3：熔断按档案 + 用途分开计，评分连续出错不会把买家对话也切到备用；重新测试通过清掉所有用途的熔断", async () => {
    behaviors.set("/a", [{ kind: "status", code: 500, body: "upstream down" }]);
    behaviors.set("/b", [{ kind: "sse", chunks: ["fallback ok"] }]);
    const route = { profileId: "1", fallbackProfileId: "2", temperature: 0.5, maxTokens: 400 };
    const { db } = fakeDb([profileRow("1", "/a", { is_default: true }), profileRow("2", "/b")], { routes: { dialogue: route, assessment: route } });
    const gateway = new LlmGateway(db, sealer, log);
    await gateway.reload();
    const primaryHits = () => captured.filter((item) => item.route === "/a").length;
    for (let i = 0; i < 4; i += 1) await gateway.complete("assessment", [{ role: "user", content: "x" }]);
    // 评分：前 3 次先打主档案，第 4 次已熔断直接走备用
    expect(primaryHits()).toBe(3);
    // 买家对话没有受牵连，照样先打主档案
    await gateway.complete("dialogue", [{ role: "user", content: "hi" }]);
    expect(primaryHits()).toBe(4);
    gateway.markHealthy("1");
    await gateway.complete("assessment", [{ role: "user", content: "x" }]);
    expect(primaryHits()).toBe(5);
  });

  it("结构化输出：不合格时带着错误重试一次，第二次合格即返回", async () => {
    behaviors.set("/a", [
      { kind: "sse", chunks: ["Sure! here you go"] },
      { kind: "sse", chunks: ['```json\n{"score": 88, "comment": "好"}\n```'] },
    ]);
    const { db } = fakeDb([profileRow("1", "/a", { is_default: true })]);
    const gateway = new LlmGateway(db, sealer, log);
    await gateway.reload();
    const schema = z.object({ score: z.number(), comment: z.string() });
    const { data } = await gateway.completeJson("director", [{ role: "user", content: "json please" }], schema);
    expect(data).toEqual({ score: 88, comment: "好" });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.body).toMatchObject({ response_format: { type: "json_object" } });
    const retryMessages = captured[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)!.content).toContain("rejected");
  });

  it("两次都不合格时抛出并记录 parse_error", async () => {
    behaviors.set("/a", [{ kind: "sse", chunks: ['{"score":"high"}'] }]);
    const { db } = fakeDb([profileRow("1", "/a", { is_default: true })]);
    const inserts: string[] = [];
    const original = db.query.bind(db);
    (db as unknown as { query: (sql: string, params?: unknown[]) => unknown }).query = (sql: string, params?: unknown[]) => {
      if (sql.includes("'parse_error'")) inserts.push(sql);
      return original(sql, params as never);
    };
    const gateway = new LlmGateway(db, sealer, log);
    await gateway.reload();
    await expect(gateway.completeJson("director", [{ role: "user", content: "json" }], z.object({ score: z.number() }))).rejects.toThrow(/LLM_OUTPUT_INVALID/);
    expect(inserts).toHaveLength(1);
  });

  it("没有任何档案时报未配置", async () => {
    const { db } = fakeDb([]);
    const gateway = new LlmGateway(db, sealer, log);
    await gateway.reload();
    expect(gateway.isConfigured()).toBe(false);
    await expect(gateway.complete("assist", [{ role: "user", content: "x" }])).rejects.toThrow("AI_PROVIDER_NOT_CONFIGURED");
  });

  it("模型只接受默认 temperature：被拒后去掉重发并记住，不算失败、不切备用", async () => {
    const rejected = '{"error":{"message":"claude-haiku-5-5 does not support non-default temperature","type":"invalid_request_error"}}';
    behaviors.set("/a", [{ kind: "status", code: 400, body: rejected }, { kind: "sse", chunks: ["hi"] }]);
    behaviors.set("/b", [{ kind: "sse", chunks: ["fallback"] }]);
    const routing = { routes: { dialogue: { profileId: "1", fallbackProfileId: "2", temperature: 0.8, maxTokens: 400 } } };
    const { db, usage } = fakeDb([profileRow("1", "/a", { is_default: true }), profileRow("2", "/b")], routing);
    const gateway = new LlmGateway(db, sealer, log);
    await gateway.reload();
    let text = "";
    for await (const part of gateway.stream("dialogue", [{ role: "user", content: "hi" }])) text += part;
    expect(text).toBe("hi");
    expect(captured.map((item) => [item.route, item.body.temperature])).toEqual([["/a", 0.8], ["/a", undefined]]);
    // 记住了：下一次直接不传，不再先挨一次 400
    await gateway.complete("dialogue", [{ role: "user", content: "again" }]);
    expect(captured).toHaveLength(3);
    expect(captured[2]!.body).not.toHaveProperty("temperature");
    expect(usage.every((row) => row[4] === "success")).toBe(true);
  });

  it("识别“只接受默认 temperature”的报错，别的 400 不算", () => {
    expect(rejectsTemperature(new Error('400: {"message":"claude-sonnet-5-5 does not support non-default temperature"}'))).toBe(true);
    expect(rejectsTemperature(new Error("400: Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported."))).toBe(true);
    expect(rejectsTemperature(new Error('400: {"message":"模型 x 的价格尚未由管理员配置","code":"model_price_error"}'))).toBe(false);
  });

  it("连通性测试：模型拒绝 temperature 时自动去掉重测，通过并提示随机性设置不生效", async () => {
    behaviors.set("/a", [
      { kind: "status", code: 400, body: '{"error":{"message":"claude-haiku-5-5 does not support non-default temperature"}}' },
      { kind: "sse", chunks: ["Hey there"] },
    ]);
    const result = await LlmGateway.test(profile({ model: "claude-haiku-5-5" }));
    expect(result.ok).toBe(true);
    expect(result.sample).toBe("Hey there");
    expect(result.note).toContain("temperature");
    expect(captured[1]!.body).not.toHaveProperty("temperature");
  });

  it("连通性测试：正文为空时提示调整深度思考", async () => {
    behaviors.set("/a", [{ kind: "sse", chunks: [] }]);
    const result = await LlmGateway.test(profile());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("深度思考");
  });
});
