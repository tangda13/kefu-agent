import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import { getSetting, type QuotaSettings } from "./settings";
import type { VoiceService } from "./voice/service";

/* 管理端系统总览（E4）与额度提醒（E5）：服务状态实时检测、告警逐条列出，系统总览和顶栏提醒共用。 */

export const BACKUP_DIR = path.resolve(process.cwd(), "backups");
/** 默认保留最近几份备份（手动与定时都计入），超出的旧文件在下次备份后删除 */
export const DEFAULT_BACKUP_KEEP = 14;
export const BACKUP_KEEP_OPTIONS = [7, 14, 30, 60];

/** 只保留最新的 keep 份备份，返回被删除的文件名 */
export function pruneBackups(keep: number): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith("backup-") && name.endsWith(".sql"))
    .map((name) => ({ name, time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  const removed = files.slice(Math.max(1, keep)).map((file) => file.name);
  for (const name of removed) fs.rmSync(path.join(BACKUP_DIR, name), { force: true });
  return removed;
}
export const DEFAULT_QUOTA: QuotaSettings = { monthlyBudgetYuan: 0, monthlyTokens: 0, warnPercent: 80 };
const STARTED_AT = Date.now();

export type ServiceStatus = "ok" | "warn" | "error" | "off";

export interface ServiceItem {
  key: "database" | "llm" | "voice" | "backup";
  name: string;
  status: ServiceStatus;
  /** 一句给管理员看的说明 */
  detail: string;
}

export interface AlertItem {
  level: "warn" | "danger";
  title: string;
  detail: string;
  /** 告警对应的管理端页面，前端据此跳转 */
  page: "providers" | "backup" | "system";
  /** “AI 与语音服务”里要打开的页签 */
  tab?: "models" | "voice" | "usage";
  /** 告警里能直接做的事：重新测试出错的模型（通过后提醒自动消失） */
  action?: { kind: "test-profile"; profileId: string };
}

/**
 * 近 24 小时阿里云出错转豆包的次数（语音页展示用）；pending = 最近一次阿里云成功朗读之后还在转豆包的次数（告警用，恢复后归零）；
 * 密钥无效 = 有鉴权失败转移且之后没有阿里云成功朗读
 */
export async function aliyunFallbackStats(db: Db) {
  const result = await db.query(`with w as (
      select * from voice_metrics where kind = 'tts' and created_at > now() - interval '24 hours'
    ), ok as (
      select max(created_at) as last_ok from w where vendor = 'aliyun' and outcome = 'success' and not fallback
    )
    select
      count(*) filter (where fallback) as total,
      count(*) filter (where fallback and created_at > coalesce((select last_ok from ok), '-infinity')) as pending,
      count(*) filter (where fallback and fallback_reason = 'auth') as auth,
      max(created_at) filter (where fallback and fallback_reason = 'auth') as last_auth,
      (select last_ok from ok) as last_ok
    from w`);
  const row = result.rows[0];
  const lastAuth = row.last_auth ? new Date(row.last_auth).getTime() : 0;
  const lastOk = row.last_ok ? new Date(row.last_ok).getTime() : 0;
  return { count: Number(row.total), pending: Number(row.pending), authFailed: Number(row.auth), keyInvalid: lastAuth > 0 && lastAuth > lastOk };
}

/** 本月用量与额度（金额含语音，或按 tokens），G6 */
export async function computeUsage(db: Db, voice: VoiceService) {
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
  const ttsByVendor = await db.query(`select vendor, coalesce(sum(chars), 0) as chars from voice_metrics
    where kind='tts' and outcome='success' and created_at > date_trunc('month', now()) group by vendor`);
  const ttsCost = ttsByVendor.rows.reduce(
    (sum, row) => sum + (Number(row.chars) / 10_000) * (row.vendor === "aliyun" ? profile.aliyunTtsPricePer10kChars : profile.ttsPricePer10kChars),
    0,
  );
  const asrCost = (Number(u.asr_ms) / 3_600_000) * profile.asrPricePerHour;
  const totalCost = llmCost + ttsCost + asrCost;
  // 任一项达到提醒比例即告警；0 表示不限
  const budgetPercent = quota.monthlyBudgetYuan > 0 ? Math.round((totalCost / quota.monthlyBudgetYuan) * 100) : 0;
  const tokenPercent = quota.monthlyTokens > 0 ? Math.round((llmTokens / quota.monthlyTokens) * 100) : 0;
  const usedPercent = Math.max(budgetPercent, tokenPercent);
  return {
    profile,
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
}

function latestBackup(): { fileName: string; createdAt: Date } | null {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR).filter((name) => name.endsWith(".sql"));
  let latest: { fileName: string; createdAt: Date } | null = null;
  for (const fileName of files) {
    const createdAt = fs.statSync(path.join(BACKUP_DIR, fileName)).mtime;
    if (!latest || createdAt > latest.createdAt) latest = { fileName, createdAt };
  }
  return latest;
}

const hoursAgo = (date: Date) => (Date.now() - date.getTime()) / 3_600_000;
const formatTime = (date: Date) =>
  date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 告警：额度、模型失败与切换、语音失败、备份过期。只列需要管理员处理、而且现在还没好的事：
 * 失败类只数“最近一次成功之后”的失败，恢复（再次成功、或重新测试通过）后自动消失，不等 24 小时过去。
 */
export async function collectAlerts(db: Db, voice: VoiceService): Promise<AlertItem[]> {
  const alerts: AlertItem[] = [];
  const { quota } = await computeUsage(db, voice);
  if (quota.alert) {
    alerts.push({
      level: quota.usedPercent >= 100 ? "danger" : "warn",
      title: quota.usedPercent >= 100 ? "本月额度已用完" : `本月额度已用 ${quota.usedPercent}%`,
      detail: `达到提醒线 ${quota.warnPercent}%，请在「AI 与语音服务」调整额度或更换模型。`,
      page: "providers",
      tab: "usage",
    });
  }
  // 买家对话、语音：只数最近一次成功之后的失败（24 小时内）
  const failures = await db.query(`select
    (select count(*) from conversation_metrics where outcome != 'success' and received_at > now() - interval '24 hours'
       and received_at > coalesce((select max(received_at) from conversation_metrics where outcome = 'success'), '-infinity')) as llm_failed,
    (select count(*) from voice_metrics v where v.kind = 'tts' and v.outcome != 'success' and v.created_at > now() - interval '24 hours'
       and v.created_at > coalesce((select max(created_at) from voice_metrics s where s.kind = 'tts' and s.outcome = 'success'), '-infinity')) as tts_failed,
    (select count(*) from voice_metrics v where v.kind = 'asr' and v.outcome != 'success' and v.created_at > now() - interval '24 hours'
       and v.created_at > coalesce((select max(created_at) from voice_metrics s where s.kind = 'asr' and s.outcome = 'success'), '-infinity')) as asr_failed`);
  const f = failures.rows[0];
  const llmFailed = Number(f.llm_failed);
  if (llmFailed > 0) {
    alerts.push({
      level: llmFailed >= 10 ? "danger" : "warn",
      title: `买家回复连续失败 ${llmFailed} 次`,
      detail: "最近的买家回复都没成功，学生会看到“买家暂时无法回复”。在「AI 与语音服务」测试对话模型；下一次回复成功后这条提示自动消失。",
      page: "providers",
      tab: "models",
    });
  }
  // 主模型切到备用：按档案看，之后它又成功回复过、或重新测试通过就算恢复
  const failovers = await db.query(`select f.target as profile_id, f.n, f.last_at, p.name
    from (select target, count(*) as n, max(created_at) as last_at from audit_log
          where action = 'llm.failover' and created_at > now() - interval '24 hours' group by target) f
    join llm_profiles p on p.id::text = f.target and p.enabled
    where not exists (select 1 from llm_usage u where u.profile_id::text = f.target and u.outcome = 'success' and u.created_at > f.last_at)
      and not (p.test_status = 'ok' and p.tested_at > f.last_at)
    order by f.last_at desc`);
  for (const row of failovers.rows) {
    alerts.push({
      level: "warn",
      title: `「${row.name}」连续出错，已自动切到备用模型`,
      detail: `${formatTime(new Date(row.last_at))} 起改由备用模型回复（24 小时内切换 ${Number(row.n)} 次）。重新测试通过、或它再次正常回复后，这条提示自动消失。`,
      page: "providers",
      tab: "models",
      action: { kind: "test-profile", profileId: String(row.profile_id) },
    });
  }
  const ttsFailed = Number(f.tts_failed);
  const asrFailed = Number(f.asr_failed);
  if (ttsFailed > 0 || asrFailed > 0) {
    const what = [ttsFailed ? `朗读 ${ttsFailed} 次` : "", asrFailed ? `识别 ${asrFailed} 次` : ""].filter(Boolean).join("、");
    alerts.push({
      level: "warn",
      title: `语音连续失败：${what}`,
      detail: "检查语音服务的密钥和额度；下一次成功后这条提示自动消失。",
      page: "providers",
      tab: "voice",
    });
  }
  const fallback = await aliyunFallbackStats(db);
  if (fallback.keyInvalid) {
    alerts.push({ level: "danger", title: "阿里云密钥无效，朗读已自动改用豆包", detail: "在「AI 与语音服务」检查阿里云百炼 API Key（以及接口地址与 Key 所在地域是否一致）。", page: "providers", tab: "voice" });
  } else if (fallback.pending > 0) {
    alerts.push({ level: "warn", title: `阿里云朗读出错，已转豆包 ${fallback.pending} 次`, detail: "多为限流或网络波动，朗读已由豆包备用音色完成；阿里云再次成功朗读后这条提示自动消失。频繁出现请检查阿里云额度。", page: "providers", tab: "voice" });
  }
  const schedule = (await getSetting<{ enabled: boolean; hour: number }>(db, "backupSchedule")) ?? { enabled: false, hour: 2 };
  const backup = latestBackup();
  if (!backup) {
    alerts.push({ level: "warn", title: "还没有任何数据备份", detail: "建议立即备份一次，并开启每日定时备份。", page: "backup" });
  } else if (schedule.enabled && hoursAgo(backup.createdAt) > 36) {
    alerts.push({ level: "danger", title: "定时备份没有按时执行", detail: `最近一次备份在 ${formatTime(backup.createdAt)}，请检查服务器上的备份工具。`, page: "backup" });
  }
  return alerts;
}

/** 服务状态：每次打开系统总览时实时检测 */
export async function collectServices(db: Db, gateway: LlmGateway, voice: VoiceService): Promise<ServiceItem[]> {
  const services: ServiceItem[] = [];

  const dbStart = Date.now();
  try {
    await db.query("select 1");
    services.push({ key: "database", name: "数据库", status: "ok", detail: `连接正常，响应 ${Date.now() - dbStart} 毫秒` });
  } catch {
    services.push({ key: "database", name: "数据库", status: "error", detail: "无法连接数据库" });
  }

  const dialogue = gateway.describe("dialogue");
  if (!dialogue) {
    services.push({ key: "llm", name: "对话模型", status: "off", detail: "还没有配置模型，学生无法开始对话" });
  } else {
    const recent = await db.query(`select count(*) as total, count(*) filter (where outcome != 'success') as failed
      from conversation_metrics where received_at > now() - interval '1 hour'`);
    const total = Number(recent.rows[0].total);
    const failed = Number(recent.rows[0].failed);
    const status: ServiceStatus = total > 0 && failed === total ? "error" : failed > 0 ? "warn" : "ok";
    services.push({
      key: "llm",
      name: "对话模型",
      status,
      detail: total === 0 ? `${dialogue.profileName} · 近 1 小时没有对话` : `${dialogue.profileName} · 近 1 小时 ${total} 次对话，失败 ${failed} 次`,
    });
  }

  const profile = await voice.profile();
  if (!profile.apiKey) {
    services.push({ key: "voice", name: "语音服务", status: "off", detail: "未配置，学生端不能语音输入和朗读" });
  } else {
    const recent = await db.query(`select count(*) as total, count(*) filter (where outcome != 'success') as failed
      from voice_metrics where created_at > now() - interval '24 hours'`);
    const total = Number(recent.rows[0].total);
    const failed = Number(recent.rows[0].failed);
    const fb = await aliyunFallbackStats(db);
    const fallbackNote = fb.keyInvalid ? " · 阿里云密钥无效，已改用豆包" : fb.count > 0 ? ` · 阿里云转豆包 ${fb.count} 次` : "";
    services.push({
      key: "voice",
      name: "语音服务",
      status: total > 0 && failed === total ? "error" : failed > 0 ? "warn" : "ok",
      detail: (total === 0 ? "已配置 · 近 24 小时没有使用" : `已配置 · 近 24 小时 ${total} 次，失败 ${failed} 次`) + fallbackNote,
    });
  }

  const schedule = (await getSetting<{ enabled: boolean; hour: number }>(db, "backupSchedule")) ?? { enabled: false, hour: 2 };
  const backup = latestBackup();
  services.push({
    key: "backup",
    name: "数据备份",
    status: !backup ? "warn" : schedule.enabled && hoursAgo(backup.createdAt) > 36 ? "error" : "ok",
    detail: `${backup ? `最近一次 ${formatTime(backup.createdAt)}` : "还没有备份"} · ${schedule.enabled ? `每日 ${schedule.hour}:00 自动备份` : "未开启定时备份"}`,
  });

  return services;
}

/** 系统版本：服务端版本取发布时注入的 APP_VERSION，数据库结构取最近一次迁移 */
export async function collectVersion(db: Db) {
  const migration = await db.query("select id from schema_migrations order by id desc limit 1").catch(() => ({ rows: [] as Array<{ id: string }> }));
  return {
    server: process.env.APP_VERSION ?? process.env.npm_package_version ?? "开发版",
    schema: (migration.rows[0]?.id as string | undefined) ?? "—",
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
  };
}
