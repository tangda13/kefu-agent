import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import { getSetting, setSetting, type QuotaSettings } from "../settings";
import type { LlmGateway } from "../llm/gateway";
import { maskSecret } from "../llm/secret";
import { VOICE_VENDORS, type VoiceProfile, type VoiceService } from "../voice/service";
import { loadEnv } from "../env";
import { generateTemporaryPassword, hashPassword } from "../security";
import { clearLoginFailures } from "../login-throttle";

const execFileAsync = promisify(execFile);
const STARTED_AT = Date.now();
const BACKUP_DIR = path.resolve(process.cwd(), "backups");

const DEFAULT_QUOTA: QuotaSettings = { monthlyBudgetYuan: 0, monthlyTokens: 0, warnPercent: 80 };

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
  gateway: LlmGateway,
  voice: VoiceService,
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
      llmProvider: gateway.describe("dialogue")?.profileName ?? "unconfigured",
      llmModel: gateway.describe("dialogue")?.model ?? "",
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

  // ---------- 语音服务配置 + 本月用量与费用额度（模型档案见 admin-llm.ts） ----------
  app.get("/v1/admin/providers", { preHandler: adminOnly }, async () => {
    const profile = await voice.profile();
    const quota = { ...DEFAULT_QUOTA, ...((await getSetting<Partial<QuotaSettings>>(db, "quota")) ?? {}) };
    const usage = await db.query(`select
      (select count(*) from llm_usage where created_at > date_trunc('month', now())) as llm_calls,
      (select coalesce(sum(input_tokens + output_tokens), 0) from llm_usage where created_at > date_trunc('month', now())) as llm_tokens,
      (select coalesce(sum(cost), 0) from llm_usage where created_at > date_trunc('month', now())) as llm_cost,
      (select count(*) from voice_metrics where kind='tts' and created_at > date_trunc('month', now())) as tts_calls,
      (select coalesce(sum(chars), 0) from voice_metrics where kind='tts' and outcome='success' and created_at > date_trunc('month', now())) as tts_chars,
      (select count(*) from voice_metrics where kind='asr' and created_at > date_trunc('month', now())) as asr_calls,
      (select coalesce(sum(audio_ms), 0) from voice_metrics where kind='asr' and outcome='success' and created_at > date_trunc('month', now())) as asr_ms`);
    const u = usage.rows[0];
    const llmTokens = Number(u.llm_tokens);
    const llmCost = Number(u.llm_cost);
    const ttsCost = (Number(u.tts_chars) / 10_000) * profile.ttsPricePer10kChars;
    const asrCost = (Number(u.asr_ms) / 3_600_000) * profile.asrPricePerHour;
    const totalCost = llmCost + ttsCost + asrCost;
    // 额度按金额或 tokens 计算（G6），任一项达到提醒比例即告警；0 表示不限
    const budgetPercent = quota.monthlyBudgetYuan > 0 ? Math.round((totalCost / quota.monthlyBudgetYuan) * 100) : 0;
    const tokenPercent = quota.monthlyTokens > 0 ? Math.round((llmTokens / quota.monthlyTokens) * 100) : 0;
    const usedPercent = Math.max(budgetPercent, tokenPercent);
    return {
      voice: {
        vendor: profile.vendor,
        vendors: Object.entries(VOICE_VENDORS).map(([key, item]) => ({ key, label: item.label })),
        apiKeyMasked: maskSecret(profile.apiKey),
        ttsResourceId: profile.ttsResourceId,
        ttsSpeaker: profile.ttsSpeaker,
        ttsSpeakerMale: profile.ttsSpeakerMale,
        asrResourceId: profile.asrResourceId,
        ttsPricePer10kChars: profile.ttsPricePer10kChars,
        asrPricePerHour: profile.asrPricePerHour,
      },
      usage: {
        llmCalls: Number(u.llm_calls),
        llmTokens,
        llmCost,
        ttsCalls: Number(u.tts_calls),
        ttsChars: Number(u.tts_chars),
        ttsCost,
        asrCalls: Number(u.asr_calls),
        asrMinutes: Math.round(Number(u.asr_ms) / 60_000),
        asrCost,
        totalCost,
      },
      quota: { ...quota, budgetPercent, tokenPercent, usedPercent, alert: usedPercent >= quota.warnPercent },
    };
  });

  app.put<{ Body: { voice?: Partial<VoiceProfile>; quota?: Partial<QuotaSettings> } }>(
    "/v1/admin/providers",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { voice: voiceInput, quota } = request.body ?? {};
      if (voiceInput) {
        if (voiceInput.vendor && !VOICE_VENDORS[voiceInput.vendor]) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "不支持的语音厂商。" };
        }
        const price = (value: unknown) => (value === undefined || value === "" ? undefined : Math.max(0, Number(value) || 0));
        await voice.save({
          ...voiceInput,
          ttsPricePer10kChars: price(voiceInput.ttsPricePer10kChars),
          asrPricePerHour: price(voiceInput.asrPricePerHour),
        });
      }
      if (quota) {
        const current = { ...DEFAULT_QUOTA, ...((await getSetting<Partial<QuotaSettings>>(db, "quota")) ?? {}) };
        const num = (value: unknown, fallback: number) => (value === undefined ? fallback : Math.max(0, Number(value) || 0));
        await setSetting(db, "quota", {
          monthlyBudgetYuan: num(quota.monthlyBudgetYuan, current.monthlyBudgetYuan),
          monthlyTokens: Math.round(num(quota.monthlyTokens, current.monthlyTokens)),
          warnPercent: Math.min(100, Math.max(1, Math.round(num(quota.warnPercent, current.warnPercent)))),
        });
      }
      await writeAudit(db, request.user!.sub, "admin.providers_update", undefined, {
        voice: Boolean(voiceInput), voiceKeyChanged: Boolean(voiceInput?.apiKey), quota: Boolean(quota),
      });
      return { ok: true };
    },
  );

  // ---------- 教师账号管理（新增接口已有，这里补列表/启停/重置） ----------
  app.get("/v1/admin/teachers", { preHandler: adminOnly }, async () => {
    const result = await db.query(
      `select u.id, u.username, u.display_name, u.status, u.must_change_password, u.created_at,
        (select count(*) from classes c where c.head_teacher_id = u.id) as head_count,
        (select count(*) from (
           select class_id from teacher_classes tc where tc.teacher_id = u.id
           union
           select id from classes c where c.head_teacher_id = u.id
         ) x) as class_count
       from users u where u.role = 'teacher' order by u.created_at`,
    );
    return result.rows.map((row) => ({
      id: row.id, username: row.username, displayName: row.display_name,
      status: row.status, mustChangePassword: row.must_change_password,
      classCount: Number(row.class_count), headClassCount: Number(row.head_count), createdAt: row.created_at,
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
      // 停用即时生效（I6）：吊销刷新令牌，鉴权缓存失效后已签发的访问令牌也随即被拒
      if (status === "disabled") {
        await db.query(
          "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
          [request.params.teacherId],
        );
      }
      guard.invalidateAccount(request.params.teacherId);
      await writeAudit(db, request.user!.sub, "admin.teacher_update", request.params.teacherId, { status, displayName });
      return { ok: true };
    },
  );

  // 重置教师密码（I3）：生成临时密码，首次登录强制修改；同时解除登录锁定、吊销原有会话
  app.post<{ Params: { teacherId: string } }>(
    "/v1/admin/teachers/:teacherId/reset-password",
    { preHandler: adminOnly },
    async (request, reply) => {
      const temporaryPassword = generateTemporaryPassword();
      const result = await db.query<{ username: string }>(
        `update users set password_hash = $1, must_change_password = true, updated_at = now()
         where id = $2 and role = 'teacher' returning username`,
        [await hashPassword(temporaryPassword), request.params.teacherId],
      );
      const teacher = result.rows[0];
      if (!teacher) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "教师不存在。" };
      }
      await db.query(
        "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
        [request.params.teacherId],
      );
      await clearLoginFailures(db, teacher.username);
      guard.invalidateAccount(request.params.teacherId);
      await writeAudit(db, request.user!.sub, "admin.teacher_reset_password", request.params.teacherId);
      return { temporaryPassword };
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
  const sinceParam = (value: string | undefined) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined);
  app.get<{ Querystring: { since?: string } }>("/v1/admin/acceptance", { preHandler: adminOnly }, async (request) => {
    const { buildAcceptanceReport, getAcceptanceRunState } = await import("../acceptance");
    const [report, run] = await Promise.all([buildAcceptanceReport(db, sinceParam(request.query.since)), getAcceptanceRunState(db)]);
    return { ...report, run };
  });
  // 验收证据：逐条请求明细 CSV
  app.get<{ Querystring: { since?: string } }>("/v1/admin/acceptance.csv", { preHandler: adminOnly }, async (request, reply) => {
    const { exportAcceptanceCsv } = await import("../acceptance");
    const csv = await exportAcceptanceCsv(db, sinceParam(request.query.since));
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="acceptance-${stamp}.csv"`);
    return csv;
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
      void runAcceptanceTest(db, gateway, samples).catch((error) => request.log.error(error, "acceptance failed"));
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
