import type { FastifyInstance } from "fastify";
import { LLM_PURPOSES, LLM_PURPOSE_LABELS, type LlmPurpose, type LlmRoutingSettings } from "@cecs/contracts";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import { getSetting, setSetting } from "../settings";
import { LlmGateway, normalizeRouting } from "../llm/gateway";
import type { SecretSealer } from "../llm/secret";
import {
  createProfile,
  listProfiles,
  loadResolvedProfile,
  profileInputSchema,
  updateProfile,
  validateExtraBody,
  type ProfileInput,
} from "../llm/profiles";

function parseProfileInput(body: unknown): { input?: ProfileInput; error?: string } {
  const parsed = profileInputSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue ? `${issue.path.join(".") || "输入"}：${issue.message}` : "输入不合法" };
  }
  const extraError = validateExtraBody(parsed.data.extraBody, parsed.data.thinking);
  return extraError ? { error: extraError } : { input: parsed.data };
}

/** 哪些用途引用了该档案（主或备用） */
function purposesUsing(routing: LlmRoutingSettings, profileId: string): LlmPurpose[] {
  return LLM_PURPOSES.filter(
    (purpose) => routing.routes[purpose].profileId === profileId || routing.routes[purpose].fallbackProfileId === profileId,
  );
}

/**
 * 模型网关管理（G1–G6）：档案增删改、连通性测试、默认档案、按用途路由、用量与费用。
 * 任何改动都 reload 网关，立即生效并写审计。
 */
export function registerAdminLlmRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  gateway: LlmGateway,
  sealer: SecretSealer,
): void {
  const adminOnly = guard.requireRole("admin");
  const loadRouting = async () => normalizeRouting(await getSetting<Partial<LlmRoutingSettings>>(db, "llm_routing"));

  app.get("/v1/admin/llm", { preHandler: adminOnly }, async () => {
    const [profiles, routing] = await Promise.all([listProfiles(db, sealer), loadRouting()]);
    const active = Object.fromEntries(LLM_PURPOSES.map((purpose) => [purpose, gateway.describe(purpose)]));
    return { profiles, routing, active };
  });

  app.post("/v1/admin/llm/profiles", { preHandler: adminOnly }, async (request, reply) => {
    const { input, error } = parseProfileInput(request.body);
    if (!input) {
      reply.code(400);
      return { code: "INVALID_INPUT", message: error };
    }
    const id = await createProfile(db, sealer, input);
    await writeAudit(db, request.user!.sub, "llm.profile_create", id, { name: input.name, baseUrl: input.baseUrl, model: input.model });
    await gateway.reload();
    return { id };
  });

  app.put<{ Params: { id: string } }>("/v1/admin/llm/profiles/:id", { preHandler: adminOnly }, async (request, reply) => {
    const { input, error } = parseProfileInput(request.body);
    if (!input) {
      reply.code(400);
      return { code: "INVALID_INPUT", message: error };
    }
    if (!input.enabled) {
      const current = await db.query("select is_default from llm_profiles where id = $1", [request.params.id]);
      const used = purposesUsing(await loadRouting(), request.params.id);
      if (current.rows[0]?.is_default || used.length) {
        reply.code(409);
        return {
          code: "PROFILE_IN_USE",
          message: current.rows[0]?.is_default
            ? "这是默认档案，不能停用。请先把其他档案设为默认。"
            : `该档案正被「${used.map((p) => LLM_PURPOSE_LABELS[p].label).join("、")}」使用，请先在用途分配里换掉。`,
        };
      }
    }
    const ok = await updateProfile(db, sealer, request.params.id, input);
    if (!ok) {
      reply.code(404);
      return { code: "NOT_FOUND", message: "档案不存在。" };
    }
    await writeAudit(db, request.user!.sub, "llm.profile_update", request.params.id, {
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      keyChanged: Boolean(input.apiKey),
      enabled: input.enabled,
    });
    await gateway.reload();
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/v1/admin/llm/profiles/:id", { preHandler: adminOnly }, async (request, reply) => {
    const current = await db.query("select name, is_default from llm_profiles where id = $1", [request.params.id]);
    const row = current.rows[0];
    if (!row) {
      reply.code(404);
      return { code: "NOT_FOUND", message: "档案不存在。" };
    }
    const used = purposesUsing(await loadRouting(), request.params.id);
    if (row.is_default || used.length) {
      reply.code(409);
      return {
        code: "PROFILE_IN_USE",
        message: row.is_default ? "默认档案不能删除。" : `该档案正被「${used.map((p) => LLM_PURPOSE_LABELS[p].label).join("、")}」使用。`,
      };
    }
    await db.query("delete from llm_profiles where id = $1", [request.params.id]);
    await writeAudit(db, request.user!.sub, "llm.profile_delete", request.params.id, { name: row.name });
    await gateway.reload();
    return { ok: true };
  });

  // 测试已保存的档案：结果落库（未通过 / 未测试的档案不能设为默认或分配给用途）
  app.post<{ Params: { id: string } }>("/v1/admin/llm/profiles/:id/test", { preHandler: adminOnly }, async (request, reply) => {
    let profile;
    try {
      profile = await loadResolvedProfile(db, sealer, request.params.id);
    } catch {
      reply.code(400);
      return { code: "KEY_UNREADABLE", message: "该档案的 API Key 无法解密，请重新填写后保存。" };
    }
    if (!profile) {
      reply.code(404);
      return { code: "NOT_FOUND", message: "档案不存在。" };
    }
    const result = await LlmGateway.test(profile);
    await db.query(
      "update llm_profiles set test_status = $2, test_result = $3, tested_at = now() where id = $1",
      [profile.id, result.ok ? "ok" : "failed", JSON.stringify(result)],
    );
    await writeAudit(db, request.user!.sub, "llm.profile_test", profile.id, { ok: result.ok, ttftMs: result.ttftMs });
    return result;
  });

  // 测试未保存的草稿（表单里的配置）；apiKey 留空且带 id 时沿用已存的 Key
  app.post<{ Body: Record<string, unknown> & { id?: string } }>("/v1/admin/llm/test", { preHandler: adminOnly }, async (request, reply) => {
    const { input, error } = parseProfileInput(request.body);
    if (!input) {
      reply.code(400);
      return { code: "INVALID_INPUT", message: error };
    }
    let apiKey = input.apiKey ?? "";
    if (!apiKey && typeof request.body?.id === "string") {
      apiKey = (await loadResolvedProfile(db, sealer, request.body.id).catch(() => null))?.apiKey ?? "";
    }
    return LlmGateway.test({
      id: "draft",
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey,
      model: input.model,
      extraHeaders: input.extraHeaders,
      extraBody: input.extraBody,
      thinking: input.thinking,
      maxTokensField: input.maxTokensField,
      jsonMode: input.jsonMode,
      timeoutMs: input.timeoutMs,
      priceInput: input.priceInput,
      priceOutput: input.priceOutput,
    });
  });

  app.put<{ Body: { profileId?: string } }>("/v1/admin/llm/default", { preHandler: adminOnly }, async (request, reply) => {
    const profileId = request.body?.profileId ?? "";
    const result = await db.query("select name, enabled, test_status from llm_profiles where id = $1", [profileId]);
    const row = result.rows[0];
    if (!row) {
      reply.code(404);
      return { code: "NOT_FOUND", message: "档案不存在。" };
    }
    if (!row.enabled || row.test_status !== "ok") {
      reply.code(409);
      return { code: "PROFILE_NOT_TESTED", message: "只有已启用且测试通过的档案才能设为默认。请先测试。" };
    }
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("update llm_profiles set is_default = false where is_default");
      await client.query("update llm_profiles set is_default = true where id = $1", [profileId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await writeAudit(db, request.user!.sub, "llm.default_switch", profileId, { name: row.name });
    await gateway.reload();
    return { ok: true };
  });

  app.put<{ Body: Partial<LlmRoutingSettings> }>("/v1/admin/llm/routing", { preHandler: adminOnly }, async (request, reply) => {
    const next = normalizeRouting(request.body ?? null);
    const referenced = new Set<string>();
    for (const purpose of LLM_PURPOSES) {
      const route = next.routes[purpose];
      route.profileId = route.profileId || null;
      route.fallbackProfileId = route.fallbackProfileId || null;
      route.temperature = Math.max(0, Math.min(2, Number(route.temperature) || 0));
      route.maxTokens = Math.max(16, Math.min(32_000, Math.round(Number(route.maxTokens) || LLM_PURPOSE_LABELS[purpose].maxTokens)));
      if (route.profileId) referenced.add(route.profileId);
      if (route.fallbackProfileId) referenced.add(route.fallbackProfileId);
    }
    if (referenced.size) {
      const check = await db.query("select id, name, enabled, test_status from llm_profiles where id = any($1::uuid[])", [[...referenced]]);
      const byId = new Map(check.rows.map((row) => [row.id as string, row]));
      for (const id of referenced) {
        const row = byId.get(id);
        if (!row) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "引用的档案不存在。" };
        }
        if (!row.enabled || row.test_status !== "ok") {
          reply.code(409);
          return { code: "PROFILE_NOT_TESTED", message: `档案「${row.name}」未启用或未通过测试，不能分配给用途。` };
        }
      }
    }
    await setSetting(db, "llm_routing", next);
    await writeAudit(db, request.user!.sub, "llm.routing_update", undefined, next as unknown as Record<string, unknown>);
    await gateway.reload();
    return next;
  });

  // 用量与费用（G6）：按档案 / 用途汇总，默认本月
  app.get<{ Querystring: { days?: string } }>("/v1/admin/llm/usage", { preHandler: adminOnly }, async (request) => {
    const days = Number(request.query.days);
    const since = Number.isFinite(days) && days > 0
      ? new Date(Date.now() - Math.min(days, 366) * 86_400_000)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const [byProfile, byPurpose, daily] = await Promise.all([
      db.query(
        `select profile_name, model, count(*)::int as calls,
                count(*) filter (where outcome <> 'success')::int as failures,
                coalesce(sum(input_tokens), 0)::bigint as input_tokens, coalesce(sum(output_tokens), 0)::bigint as output_tokens,
                coalesce(sum(cost), 0)::float as cost,
                round(avg(ttft_ms) filter (where outcome = 'success'))::int as avg_ttft_ms
         from llm_usage where created_at >= $1 group by profile_name, model order by cost desc, calls desc`,
        [since],
      ),
      db.query(
        `select purpose, count(*)::int as calls, count(*) filter (where outcome <> 'success')::int as failures,
                count(*) filter (where fallback)::int as fallbacks,
                coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens, coalesce(sum(cost), 0)::float as cost
         from llm_usage where created_at >= $1 group by purpose`,
        [since],
      ),
      db.query(
        `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as calls,
                coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens, coalesce(sum(cost), 0)::float as cost
         from llm_usage where created_at >= $1 group by 1 order by 1`,
        [since],
      ),
    ]);
    return {
      since: since.toISOString(),
      byProfile: byProfile.rows.map((row) => ({
        profileName: row.profile_name,
        model: row.model,
        calls: row.calls,
        failures: row.failures,
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cost: row.cost,
        avgTtftMs: row.avg_ttft_ms,
      })),
      byPurpose: byPurpose.rows.map((row) => ({
        purpose: row.purpose,
        calls: row.calls,
        failures: row.failures,
        fallbacks: row.fallbacks,
        tokens: Number(row.tokens),
        cost: row.cost,
      })),
      daily: daily.rows.map((row) => ({ day: row.day, calls: row.calls, tokens: Number(row.tokens), cost: row.cost })),
    };
  });
}
