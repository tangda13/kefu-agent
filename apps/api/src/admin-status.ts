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
}

/** 近 24 小时阿里云出错转豆包的次数；密钥无效 = 有鉴权失败转移且之后没有阿里云成功朗读 */
export async function aliyunFallbackStats(db: Db) {
  const result = await db.query(`select
    count(*) filter (where fallback) as total,
    count(*) filter (where fallback and fallback_reason = 'auth') as auth,
    max(created_at) filter (where fallback and fallback_reason = 'auth') as last_auth,
    max(created_at) filter (where vendor = 'aliyun' and outcome = 'success' and not fallback) as last_ok
    from voice_metrics where kind = 'tts' and created_at > now() - interval '24 hours'`);
  const row = result.rows[0];
  const lastAuth = row.last_auth ? new Date(row.last_auth).getTime() : 0;
  const lastOk = row.last_ok ? new Date(row.last_ok).getTime() : 0;
  return { count: Number(row.total), authFailed: Number(row.auth), keyInvalid: lastAuth > 0 && lastAuth > lastOk };
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

/** 告警：额度、模型失败与切换、语音失败、备份过期。只列需要管理员处理的事。 */
export async function collectAlerts(db: Db, voice: VoiceService): Promise<AlertItem[]> {
  const alerts: AlertItem[] = [];
  const { quota } = await computeUsage(db, voice);
  if (quota.alert) {
    alerts.push({
      level: quota.usedPercent >= 100 ? "danger" : "warn",
      title: quota.usedPercent >= 100 ? "本月额度已用完" : `本月额度已用 ${quota.usedPercent}%`,
      detail: `达到提醒线 ${quota.warnPercent}%，请在「AI 与语音服务」调整额度或更换模型。`,
      page: "providers",
    });
  }
  const failures = await db.query(`select
    (select count(*) from conversation_metrics where outcome != 'success' and received_at > now() - interval '24 hours') as llm_failed,
    (select count(*) from conversation_metrics where received_at > now() - interval '24 hours') as llm_total,
    (select count(*) from voice_metrics where outcome != 'success' and created_at > now() - interval '24 hours') as voice_failed,
    (select count(*) from audit_log where action = 'llm.failover' and created_at > now() - interval '24 hours') as failovers`);
  const f = failures.rows[0];
  const llmFailed = Number(f.llm_failed);
  if (llmFailed > 0) {
    alerts.push({
      level: llmFailed >= 10 ? "danger" : "warn",
      title: `近 24 小时买家对话失败 ${llmFailed} 次`,
      detail: `共 ${Number(f.llm_total)} 次对话请求，失败或超时的学生会看到“买家暂时无法回复”。`,
      page: "providers",
    });
  }
  if (Number(f.failovers) > 0) {
    alerts.push({
      level: "warn",
      title: `主模型连续出错，已自动切到备用模型 ${Number(f.failovers)} 次`,
      detail: "建议在「AI 与语音服务」测试主模型的连通性。",
      page: "providers",
    });
  }
  if (Number(f.voice_failed) > 0) {
    alerts.push({
      level: "warn",
      title: `近 24 小时语音识别或朗读失败 ${Number(f.voice_failed)} 次`,
      detail: "检查语音服务的密钥和额度。",
      page: "providers",
    });
  }
  const fallback = await aliyunFallbackStats(db);
  if (fallback.keyInvalid) {
    alerts.push({ level: "danger", title: "阿里云密钥无效，朗读已自动改用豆包", detail: "在「AI 与语音服务」检查阿里云百炼 API Key（以及接口地址与 Key 所在地域是否一致）。", page: "providers" });
  } else if (fallback.count > 0) {
    alerts.push({ level: "warn", title: `近 24 小时阿里云朗读失败转豆包 ${fallback.count} 次`, detail: "多为限流或网络波动，朗读已自动由豆包备用音色完成；频繁出现请检查阿里云额度。", page: "providers" });
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
