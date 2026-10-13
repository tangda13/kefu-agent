/**
 * 买家耐心（D-40）：买家发完消息后客服一直不回，按等待时长催促，最后离开。
 * 纯函数，无数据库；时间点写死，按画像乘倍率。
 */

/** 基础等待分钟数：第 1 次催促 / 第 2 次催促 / 离开 */
export const PATIENCE_BASE_MINUTES = [2, 5, 10] as const;

/** 情绪倍率（平静 / 焦虑 / 不满 / 期待 是系统可选值，其余写法兜底） */
const EMOTION_FACTOR: Record<string, number> = {
  平静: 1,
  期待: 1.1,
  焦虑: 0.6,
  不满: 0.6,
  焦急: 0.5,
  愤怒: 0.5,
};

/** 性格倍率（理性谨慎 / 直接高效 / 友好健谈 / 敏感挑剔 / 犹豫保守 是系统可选值，其余写法兜底） */
const PERSONALITY_FACTOR: Record<string, number> = {
  理性谨慎: 1.2,
  直接高效: 0.8,
  友好健谈: 1.4,
  敏感挑剔: 0.8,
  犹豫保守: 1.1,
  随和: 1.5,
  耐心: 1.5,
  急躁: 0.7,
};

/** 耐心倍率：情绪 × 性格，限制在 0.3–2.0；缺字段或未知取值按 1 */
export function patienceFactor(persona: { emotion?: unknown; personality?: unknown }): number {
  const emotion = typeof persona.emotion === "string" ? (EMOTION_FACTOR[persona.emotion] ?? 1) : 1;
  const personality = typeof persona.personality === "string" ? (PERSONALITY_FACTOR[persona.personality] ?? 1) : 1;
  return Math.min(2, Math.max(0.3, Math.round(emotion * personality * 100) / 100));
}

export type PatienceAction = "nudge" | "leave" | null;

/**
 * 到哪个阶段：已催促 nudgeCount 次、已等待 waitedMinutes 分钟时，现在该做什么。
 * 一次只推进一步（即使等了很久，也是先催第 1 次、下一轮再催第 2 次、再离开），避免连发。
 */
export function patienceAction(waitedMinutes: number, nudgeCount: number, factor: number): PatienceAction {
  if (nudgeCount >= PATIENCE_BASE_MINUTES.length) return null;
  const due = PATIENCE_BASE_MINUTES[nudgeCount]! * factor;
  if (waitedMinutes < due) return null;
  return nudgeCount === PATIENCE_BASE_MINUTES.length - 1 ? "leave" : "nudge";
}
