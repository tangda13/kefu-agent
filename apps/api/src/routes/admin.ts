import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import { once } from "../inflight";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import { getSetting, setSetting, type QuotaSettings } from "../settings";
import type { LlmGateway } from "../llm/gateway";
import { maskSecret } from "../llm/secret";
import { VOICE_VENDORS, type VoiceProfile, type VoiceService } from "../voice/service";
import { POOL_LANGUAGES } from "../voice/pool";
import { loadEnv } from "../env";
import { generateTemporaryPassword, hashPassword } from "../security";
import { clearLoginFailures } from "../login-throttle";
import { BACKUP_DIR, BACKUP_KEEP_OPTIONS, DEFAULT_BACKUP_KEEP, DEFAULT_QUOTA, pruneBackups, aliyunFallbackStats, collectAlerts, collectServices, collectVersion, computeUsage } from "../admin-status";

const execFileAsync = promisify(execFile);

/** 执行数据库备份（路由与定时调度共用） */
export async function performBackup(db: Db): Promise<{ fileName: string; size: number; removed: number }> {
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
  const size = fs.statSync(target).size;
  const schedule = await getSetting<{ keep?: number }>(db, "backupSchedule");
  const removed = pruneBackups(Number(schedule?.keep) || DEFAULT_BACKUP_KEEP);
  return { fileName, size, removed: removed.length };
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
    const [counts, services, alerts, version] = await Promise.all([
      db.query(`select
        (select count(*) from users where role='student') as students,
        (select count(*) from users where role='teacher') as teachers,
        (select count(*) from conversations) as conversations,
        (select count(*) from conversation_messages) as messages,
        (select count(*) from assessments) as assessments`),
      collectServices(db, gateway, voice),
      collectAlerts(db, voice),
      collectVersion(db),
    ]);
    const row = counts.rows[0];
    return {
      version,
      services,
      alerts,
      counts: {
        students: Number(row.students),
        teachers: Number(row.teachers),
        conversations: Number(row.conversations),
        messages: Number(row.messages),
        assessments: Number(row.assessments),
      },
    };
  });

  // 顶栏常驻提醒（E5）：只返回需要处理的告警，管理端定时拉取
  app.get("/v1/admin/alerts", { preHandler: adminOnly }, async () => collectAlerts(db, voice));

  app.get("/v1/admin/providers", { preHandler: adminOnly }, async () => {
    const { profile, usage, quota } = await computeUsage(db, voice);
    return {
      voice: {
        vendor: profile.vendor,
        vendors: Object.entries(VOICE_VENDORS).map(([key, item]) => ({ key, label: item.label, speakers: item.speakers })),
        apiKeyMasked: maskSecret(profile.apiKey),
        ttsResourceId: profile.ttsResourceId,
        asrResourceId: profile.asrResourceId,
        ttsPricePer10kChars: profile.ttsPricePer10kChars,
        aliyunApiKeyMasked: maskSecret(profile.aliyunApiKey),
        aliyunBaseUrl: profile.aliyunBaseUrl,
        aliyunModel: profile.aliyunModel,
        aliyunTtsPricePer10kChars: profile.aliyunTtsPricePer10kChars,
        voicePool: profile.voicePool,
        poolLanguages: POOL_LANGUAGES,
        missingVoices: await voice.missingVoices(),
        aliyunFallback: await aliyunFallbackStats(db),
        asrPricePerHour: profile.asrPricePerHour,
      },
      usage,
      quota,
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
          aliyunTtsPricePer10kChars: price(voiceInput.aliyunTtsPricePer10kChars),
          aliyunBaseUrl: typeof voiceInput.aliyunBaseUrl === "string" && /^https:\/\//.test(voiceInput.aliyunBaseUrl.trim()) ? voiceInput.aliyunBaseUrl.trim() : undefined,
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
        voice: Boolean(voiceInput), voiceKeyChanged: Boolean(voiceInput?.apiKey), aliyunKeyChanged: Boolean(voiceInput?.aliyunApiKey), quota: Boolean(quota),
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

  app.patch<{ Params: { termId: string }; Body: { enabled?: unknown } }>(
    "/v1/admin/content/:termId",
    { preHandler: adminOnly },
    async (request, reply) => {
      if (typeof request.body?.enabled !== "boolean") {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "缺少启用状态。" };
      }
      const result = await db.query("update content_terms set enabled = $2 where id = $1 returning id", [request.params.termId, request.body.enabled]);
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "条目不存在。" };
      }
      await writeAudit(db, request.user!.sub, request.body.enabled ? "admin.content_enable" : "admin.content_disable", request.params.termId);
      return { ok: true };
    },
  );

  // 批量导入：每行一条，去掉空行和重复，已存在的跳过
  app.post<{ Body: { kind?: string; texts?: unknown } }>(
    "/v1/admin/content/import",
    { preHandler: adminOnly },
    async (request, reply) => {
      const kind = request.body?.kind === "phrase" ? "phrase" : "forbidden";
      const raw = Array.isArray(request.body?.texts) ? request.body.texts : [];
      const texts = [...new Set(raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
      if (texts.length === 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "没有可导入的内容。" };
      }
      if (texts.length > 2000) {
        reply.code(400);
        return { code: "TOO_MANY", message: "一次最多导入 2000 条。" };
      }
      const result = await db.query(
        "insert into content_terms (kind, text) select $1, unnest($2::text[]) on conflict do nothing returning id",
        [kind, texts],
      );
      const added = result.rowCount ?? 0;
      await writeAudit(db, request.user!.sub, "admin.content_import", kind, { added, skipped: texts.length - added });
      return { added, skipped: texts.length - added };
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

  // 音色试听：用当前密钥合成一句该语种买家口吻的话，返回音频（同一厂商 + 音色 + 语种只合成一次）
  app.post<{ Body: { speaker?: string; vendor?: string; language?: string } }>("/v1/admin/voice/preview", { preHandler: adminOnly }, async (request, reply) => {
    const speaker = String(request.body?.speaker ?? "").trim();
    const vendor = String(request.body?.vendor ?? "doubao");
    const language = POOL_LANGUAGES.some((item) => item.key === request.body?.language) ? String(request.body?.language) : "en";
    if (!/^[A-Za-z0-9_.-]{3,80}$/.test(speaker) || !VOICE_VENDORS[vendor]) {
      reply.code(400);
      return { code: "INVALID_SPEAKER", message: "音色 ID 格式不对。" };
    }
    if (!(await voice.availableVendors()).has(vendor)) {
      reply.code(503);
      return { code: "TTS_NOT_CONFIGURED", message: vendor === "aliyun" ? "还没有配置阿里云密钥。" : "还没有配置语音密钥。" };
    }
    try {
      const path = await import("node:path");
      const fs = await import("node:fs");
      const ext = VOICE_VENDORS[vendor]!.audioExt;
      const target = path.resolve(process.cwd(), "uploads", "tts", `preview-${vendor}-${speaker}-${language}.${ext}`);
      const audio = fs.existsSync(target)
        ? fs.readFileSync(target)
        : await once(`voice-preview:${vendor}:${speaker}:${language}`, async () => {
            const { audio: fresh } = await voice.preview(vendor, speaker, language);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, fresh);
            return fresh;
          });
      reply.type(ext === "wav" ? "audio/wav" : "audio/mpeg");
      return reply.send(audio);
    } catch (error) {
      request.log.warn(error, "voice preview failed");
      reply.code(502);
      return { code: "PREVIEW_FAILED", message: "试听失败：音色 ID 可能不存在、与朗读资源不匹配，或该厂商不支持此语种。" };
    }
  });

  // ---------- 数据与备份 ----------
  app.post("/v1/admin/backups", { preHandler: adminOnly }, async (request, reply) => {
    try {
      const result = await performBackup(db);
      await writeAudit(db, request.user!.sub, "admin.backup", result.fileName, { size: result.size, removed: result.removed });
      return { ok: true, ...result };
    } catch (error) {
      request.log.error(error, "backup failed");
      reply.code(500);
      return { code: "BACKUP_FAILED", message: "备份失败：pg_dump 不可用，请检查部署环境。" };
    }
  });

  // 定时备份策略
  app.get("/v1/admin/backup-schedule", { preHandler: adminOnly }, async () => {
    const saved = (await getSetting<Record<string, unknown>>(db, "backupSchedule")) ?? {};
    return { enabled: false, hour: 2, keep: DEFAULT_BACKUP_KEEP, ...saved, keepOptions: BACKUP_KEEP_OPTIONS };
  });
  app.put<{ Body: { enabled?: boolean; hour?: number; keep?: number } }>(
    "/v1/admin/backup-schedule",
    { preHandler: adminOnly },
    async (request) => {
      const current = ((await getSetting(db, "backupSchedule")) ?? { enabled: false, hour: 2 }) as Record<string, unknown>;
      const next = {
        ...current,
        enabled: request.body?.enabled ?? current.enabled,
        hour: Math.max(0, Math.min(23, Number(request.body?.hour ?? current.hour ?? 2))),
        keep: Math.max(3, Math.min(90, Number(request.body?.keep ?? current.keep ?? DEFAULT_BACKUP_KEEP))),
      };
      await setSetting(db, "backupSchedule", next);
      await writeAudit(db, request.user!.sub, "admin.backup_schedule", undefined, next);
      return { ...next, keepOptions: BACKUP_KEEP_OPTIONS };
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
