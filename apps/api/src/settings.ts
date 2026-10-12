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

/** 月度额度：按金额（元，含语音）或 tokens 计算，0 表示不限（G6） */
export interface QuotaSettings {
  monthlyBudgetYuan: number;
  monthlyTokens: number;
  warnPercent: number;
}
