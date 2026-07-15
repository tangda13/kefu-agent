import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import { getSetting, setSetting, type LlmSettings, type QuotaSettings, type VoiceSettings } from "../settings";
import { createConversationProvider, type SwappableConversationProvider } from "../conversation-provider";
import { loadEnv } from "../env";

const execFileAsync = promisify(execFile);
const STARTED_AT = Date.now();
const BACKUP_DIR = path.resolve(process.cwd(), "backups");

function maskKey(key: string | undefined): string {
  if (!key) return "";
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 执行数据库备份（路由与定时调度共用） */
export async function performBackup(db: Db): Promise<{ fileName: string; size: number }> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const fileName = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
  const target = path.join(BACKUP_DIR, fileName);
  const env = loadEnv();
  const url = new URL(env.databaseUrl);
  try {
    const { stdout } = await execFileAsync("pg_dump", ["--dbname", env.databaseUrl], {
      maxBuffer: 256 * 1024 * 1024,
    });
    fs.writeFileSync(target, stdout);
  } catch {
    const { stdout } = await execFileAsync(
      "docker",
      ["exec", "cecs-pg", "pg_dump", "-U", url.username, url.pathname.slice(1)],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    fs.writeFileSync(target, stdout);
  }
  return { fileName, size: fs.statSync(target).size };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  provider: SwappableConversationProvider,
): void {
  const adminOnly = guard.requireRole("admin");

  // ---------- 系统总览 ----------
  app.get("/v1/admin/system", { preHandler: adminOnly }, async () => {
    const [counts, errors] = await Promise.all([
      db.query(`select
        (select count(*) from users where role='student') as students,
        (select count(*) from users where role='teacher') as teachers,
        (select count(*) from conversations) as conversations,
        (select count(*) from conversation_messages) as messages,
        (select count(*) from assessments) as assessments`),
      db.query(`select
        (select count(*) from conversation_metrics where outcome!='success' and received_at > now()-interval '24 hours') as llm_errors,
        (select count(*) from voice_metrics where outcome!='success' and created_at > now()-interval '24 hours') as voice_errors`),
    ]);
    const row = counts.rows[0];
    const err = errors.rows[0];
    return {
      version: "0.4.0",
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      database: "ok",
      llmProvider: provider.providerId,
      llmModel: provider.modelId,
      counts: {
        students: Number(row.students),
        teachers: Number(row.teachers),
        conversations: Number(row.conversations),
        messages: Number(row.messages),
        assessments: Number(row.assessments),
      },
      alerts24h: { llmErrors: Number(err.llm_errors), voiceErrors: Number(err.voice_errors) },
    };
  });

  // ---------- AI 与语音服务配置 + 计量告警 ----------
  app.get("/v1/admin/providers", { preHandler: adminOnly }, async () => {
    const env = loadEnv();
    const llm = (await getSetting<LlmSettings>(db, "llm")) ?? {
      baseUrl: env.llmBaseUrl, apiKey: env.llmApiKey, model: env.llmModel,
    };
    const voice = (await getSetting<Partial<VoiceSettings>>(db, "voice")) ?? {};
    const quota = (await getSetting<QuotaSettings>(db, "quota")) ?? { monthlyLlmCalls: 10000, warnPercent: 80 };
    const usage = await db.query(`select
      (select count(*) from conversation_metrics where received_at > date_trunc('month', now())) as llm_calls,
      (select coalesce(sum(valid_chars),0) from conversation_metrics where received_at > date_trunc('month', now())) as llm_chars,
      (select count(*) from voice_metrics where kind='tts' and created_at > date_trunc('month', now())) as tts_calls,
      (select count(*) from voice_metrics where kind='asr' and created_at > date_trunc('month', now())) as asr_calls`);
    const u = usage.rows[0];
    const llmCalls = Number(u.llm_calls);
    const usedPercent = quota.monthlyLlmCalls > 0 ? Math.round((llmCalls / quota.monthlyLlmCalls) * 100) : 0;
    return {
      llm: { baseUrl: llm.baseUrl, model: llm.model, apiKeyMasked: maskKey(llm.apiKey) },
      voice: {
        apiKeyMasked: maskKey(voice.apiKey || env.ttsApiKey),
        ttsResourceId: voice.ttsResourceId || env.ttsResourceId,
        ttsSpeaker: voice.ttsSpeaker || env.ttsSpeaker,
        ttsSpeakerMale: voice.ttsSpeakerMale || env.ttsSpeakerMale,
        asrResourceId: voice.asrResourceId || env.asrResourceId,
      },
      usage: {
        llmCalls, llmChars: Number(u.llm_chars),
        ttsCalls: Number(u.tts_calls), asrCalls: Number(u.asr_calls),
      },
      quota: { ...quota, usedPercent, alert: usedPercent >= quota.warnPercent },
    };
  });

  app.put<{ Body: { llm?: Partial<LlmSettings>; voice?: Partial<VoiceSettings>; quota?: Partial<QuotaSettings> } }>(
    "/v1/admin/providers",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { llm, voice, quota } = request.body ?? {};
      const env = loadEnv();
      if (llm) {
        const current = (await getSetting<LlmSettings>(db, "llm")) ?? {
          baseUrl: env.llmBaseUrl, apiKey: env.llmApiKey, model: env.llmModel,
        };
        const next: LlmSettings = {
          baseUrl: (llm.baseUrl ?? current.baseUrl).replace(/\/+$/, ""),
          apiKey: llm.apiKey?.trim() || current.apiKey,
          model: llm.model ?? current.model,
        };
        if (!next.baseUrl || !next.apiKey || !next.model) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "LLM 配置需包含地址、密钥与模型。" };
        }
        await setSetting(db, "llm", next);
        // 热切换：新配置即时生效，无需重启
        provider.swap(createConversationProvider({
          llmBaseUrl: next.baseUrl, llmApiKey: next.apiKey, llmModel: next.model,
        }));
      }
      if (voice) {
        const current = (await getSetting<Partial<VoiceSettings>>(db, "voice")) ?? {};
        await setSetting(db, "voice", { ...current, ...Object.fromEntries(Object.entries(voice).filter(([, v]) => v)) });
      }
      if (quota) {
        const current = (await getSetting<QuotaSettings>(db, "quota")) ?? { monthlyLlmCalls: 10000, warnPercent: 80 };
        await setSetting(db, "quota", { ...current, ...quota });
      }
      await writeAudit(db, request.user!.sub, "admin.providers_update", undefined, {
        llm: Boolean(llm), voice: Boolean(voice), quota: Boolean(quota),
      });
      return { ok: true };
    },
  );

  // ---------- 教师账号管理（新增接口已有，这里补列表/启停/重置） ----------
  app.get("/v1/admin/teachers", { preHandler: adminOnly }, async () => {
    const result = await db.query(
      `select u.id, u.username, u.display_name, u.status, u.created_at,
        (select count(*) from teacher_classes tc where tc.teacher_id = u.id) +
        (select count(*) from classes c where c.head_teacher_id = u.id) as class_count
       from users u where u.role = 'teacher' order by u.created_at`,
    );
    return result.rows.map((row) => ({
      id: row.id, username: row.username, displayName: row.display_name,
      status: row.status, classCount: Number(row.class_count), createdAt: row.created_at,
    }));
  });

  app.patch<{ Params: { teacherId: string }; Body: { status?: string; displayName?: string } }>(
    "/v1/admin/teachers/:teacherId",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { status, displayName } = request.body ?? {};
      if (status && !["active", "disabled"].includes(status)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "状态无效。" };
      }
      const result = await db.query(
        `update users set status = coalesce($1, status), display_name = coalesce($2, display_name), updated_at = now()
         where id = $3 and role = 'teacher' returning id`,
        [status ?? null, displayName ?? null, request.params.teacherId],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "教师不存在。" };
      }
      await writeAudit(db, request.user!.sub, "admin.teacher_update", request.params.teacherId, { status, displayName });
      return { ok: true };
    },
  );

  // ---------- 内容资源库（违规词/标准话术 DB 维护） ----------
  app.get<{ Querystring: { kind?: string } }>(
    "/v1/admin/content",
    { preHandler: guard.requireRole("admin", "teacher") },
    async (request) => {
      const kind = request.query.kind === "phrase" ? "phrase" : "forbidden";
      const result = await db.query(
        "select id, text, enabled from content_terms where kind = $1 order by id",
        [kind],
      );
      return result.rows;
    },
  );

  app.post<{ Body: { kind?: string; text?: string } }>(
    "/v1/admin/content",
    { preHandler: adminOnly },
    async (request, reply) => {
      const kind = request.body?.kind === "phrase" ? "phrase" : "forbidden";
      const text = request.body?.text?.trim();
      if (!text) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "内容不能为空。" };
      }
      await db.query(
        "insert into content_terms (kind, text) values ($1, $2) on conflict do nothing",
        [kind, text],
      );
      await writeAudit(db, request.user!.sub, "admin.content_add", kind, { text });
      return { ok: true };
    },
  );

  app.delete<{ Params: { termId: string } }>(
    "/v1/admin/content/:termId",
    { preHandler: adminOnly },
    async (request, reply) => {
      const result = await db.query("delete from content_terms where id = $1 returning id", [request.params.termId]);
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "条目不存在。" };
      }
      await writeAudit(db, request.user!.sub, "admin.content_delete", request.params.termId);
      return { ok: true };
    },
  );

  // ---------- 数据与备份 ----------
  app.post("/v1/admin/backups", { preHandler: adminOnly }, async (request, reply) => {
    try {
      const result = await performBackup(db);
      await writeAudit(db, request.user!.sub, "admin.backup", result.fileName, { size: result.size });
      return { ok: true, ...result };
    } catch (error) {
      request.log.error(error, "backup failed");
      reply.code(500);
      return { code: "BACKUP_FAILED", message: "备份失败：pg_dump 不可用，请检查部署环境。" };
    }
  });

  // 定时备份策略
  app.get("/v1/admin/backup-schedule", { preHandler: adminOnly }, async () => {
    return (await getSetting(db, "backupSchedule")) ?? { enabled: false, hour: 2 };
  });
  app.put<{ Body: { enabled?: boolean; hour?: number } }>(
    "/v1/admin/backup-schedule",
    { preHandler: adminOnly },
    async (request) => {
      const current = ((await getSetting(db, "backupSchedule")) ?? { enabled: false, hour: 2 }) as Record<string, unknown>;
      const next = {
        ...current,
        enabled: request.body?.enabled ?? current.enabled,
        hour: Math.max(0, Math.min(23, Number(request.body?.hour ?? current.hour ?? 2))),
      };
      await setSetting(db, "backupSchedule", next);
      await writeAudit(db, request.user!.sub, "admin.backup_schedule", undefined, next);
      return next;
    },
  );

  // 验收指标报表 + 一键验收测试
  app.get("/v1/admin/acceptance", { preHandler: adminOnly }, async () => {
    const { buildAcceptanceReport, getAcceptanceRunState } = await import("../acceptance");
    const [report, run] = await Promise.all([buildAcceptanceReport(db), getAcceptanceRunState(db)]);
    return { ...report, run };
  });
  app.post<{ Body: { samples?: number } }>(
    "/v1/admin/acceptance/run",
    { preHandler: adminOnly },
    async (request, reply) => {
      const samples = Math.max(1, Math.min(200, Number(request.body?.samples ?? 100)));
      const { getAcceptanceRunState, runAcceptanceTest } = await import("../acceptance");
      const state = await getAcceptanceRunState(db);
      if (state?.running) {
        reply.code(409);
        return { code: "ALREADY_RUNNING", message: "验收测试正在进行中。" };
      }
      await writeAudit(db, request.user!.sub, "admin.acceptance_run", undefined, { samples });
      void runAcceptanceTest(db, provider, samples).catch((error) => request.log.error(error, "acceptance failed"));
      return { ok: true, samples };
    },
  );

  app.get("/v1/admin/backups", { preHandler: adminOnly }, async () => {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, name));
        return { fileName: name, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.get<{ Params: { fileName: string } }>(
    "/v1/admin/backups/:fileName",
    { preHandler: adminOnly },
    async (request, reply) => {
      const safe = path.basename(request.params.fileName);
      const target = path.join(BACKUP_DIR, safe);
      if (!safe.endsWith(".sql") || !fs.existsSync(target)) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "备份不存在。" };
      }
      reply.header("content-disposition", `attachment; filename="${safe}"`);
      reply.type("application/sql");
      return reply.send(fs.createReadStream(target));
    },
  );

  // 数据导出：对话 / 考核 CSV
  app.get<{ Params: { kind: string } }>(
    "/v1/admin/export/:kind",
    { preHandler: adminOnly },
    async (request, reply) => {
      const esc = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
      let csv = "";
      if (request.params.kind === "conversations") {
        const rows = await db.query(
          `select c.id, u.username, c.persona->>'name' as buyer, s.name as scenario, m.sender, m.content, m.created_at
           from conversation_messages m
           join conversations c on c.id = m.conversation_id
           join users u on u.id = c.student_id
           left join scenarios s on s.id = c.scenario_id
           order by m.created_at limit 20000`,
        );
        csv = "会话ID,学生,买家,场景,发送方,内容,时间\n" + rows.rows
          .map((r) => [r.id, r.username, r.buyer, r.scenario, r.sender, r.content, r.created_at].map(esc).join(","))
          .join("\n");
      } else if (request.params.kind === "assessments") {
        const rows = await db.query(
          `select a.id, u.username, u.display_name, a.total, a.scores, a.comment, a.created_at
           from assessments a join users u on u.id = a.student_id order by a.created_at`,
        );
        csv = "评分ID,账号,姓名,总分,六维明细,评语,时间\n" + rows.rows
          .map((r) => [r.id, r.username, r.display_name, r.total, JSON.stringify(r.scores), r.comment, r.created_at].map(esc).join(","))
          .join("\n");
      } else {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "导出类型无效。" };
      }
      await writeAudit(db, request.user!.sub, "admin.export", request.params.kind);
      reply.header("content-disposition", `attachment; filename="${request.params.kind}.csv"`);
      reply.type("text/csv; charset=utf-8");
      return reply.send("﻿" + csv);
    },
  );

  // ---------- 审计日志 ----------
  app.get<{ Querystring: { limit?: string } }>(
    "/v1/admin/audit",
    { preHandler: adminOnly },
    async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 100), 500);
      const result = await db.query(
        `select a.id, a.action, a.target, a.detail, a.created_at, u.username as actor
         from audit_log a left join users u on u.id = a.actor_id
         order by a.id desc limit $1`,
        [limit],
      );
      return result.rows;
    },
  );
}
