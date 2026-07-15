import type { Db } from "./db";

export async function getSetting<T>(db: Db, key: string): Promise<T | null> {
  const result = await db.query("select value from app_settings where key = $1", [key]);
  return (result.rows[0]?.value as T | undefined) ?? null;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = $2, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VoiceSettings {
  apiKey: string;
  ttsResourceId: string;
  ttsSpeaker: string;
  ttsSpeakerMale: string;
  asrResourceId: string;
}

export interface QuotaSettings {
  monthlyLlmCalls: number;
  warnPercent: number;
}

/** 语音配置：DB 设置优先，回退 env */
export async function getVoiceSettings(
  db: Db,
  env: { ttsApiKey: string; ttsResourceId: string; ttsSpeaker: string; ttsSpeakerMale: string; asrResourceId: string },
): Promise<VoiceSettings> {
  const saved = await getSetting<Partial<VoiceSettings>>(db, "voice");
  return {
    apiKey: saved?.apiKey || env.ttsApiKey,
    ttsResourceId: saved?.ttsResourceId || env.ttsResourceId,
    ttsSpeaker: saved?.ttsSpeaker || env.ttsSpeaker,
    ttsSpeakerMale: saved?.ttsSpeakerMale || env.ttsSpeakerMale,
    asrResourceId: saved?.asrResourceId || env.asrResourceId,
  };
}
