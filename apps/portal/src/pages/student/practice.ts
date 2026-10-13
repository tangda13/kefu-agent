import type { BusinessStage } from "@cecs/contracts";

/**
 * 自由练习的设置：任务大厅点“开始练习”时写入，工作台据此自动进线练习买家。
 * 只是这次打开客户端的界面状态（sessionStorage），不算业务数据。
 */
export interface PracticeConfig {
  /** 业务环节；random = 全部环节随机 */
  stage: BusinessStage | "random";
  /** 指定场景；null = 在所选环节里随机 */
  scenarioId: string | null;
  /** 这一轮已经进线的练习买家数（到“最大接待人数”就不再进线） */
  arrived?: number;
}

const KEY = "cecs.practice";
export const PRACTICE_EVENT = "cecs:practice";

export function readPractice(): PracticeConfig | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PracticeConfig) : null;
  } catch {
    return null;
  }
}

/** 传 null = 结束练习（不再进线练习买家，已在聊的会话不受影响） */
export function writePractice(config: PracticeConfig | null): void {
  try {
    if (config) sessionStorage.setItem(KEY, JSON.stringify(config));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 存不了就只在本页生效 */
  }
  window.dispatchEvent(new Event(PRACTICE_EVENT));
}

/** 进线一位练习买家后计数 */
export function bumpPractice(): void {
  const current = readPractice();
  if (current) writePractice({ ...current, arrived: (current.arrived ?? 0) + 1 });
}

/** 最大接待人数（这一轮累计进线上限）：界面偏好，存本机；0 = 不限 */
const TOTAL_KEY = "cecs.practiceTotal";
export const PRACTICE_TOTALS = [5, 10, 20, 0] as const;
export function readPracticeTotal(): number {
  try {
    const value = Number(localStorage.getItem(TOTAL_KEY) ?? 10);
    return (PRACTICE_TOTALS as readonly number[]).includes(value) ? value : 10;
  } catch {
    return 10;
  }
}
export function writePracticeTotal(value: number): void {
  try {
    localStorage.setItem(TOTAL_KEY, String(value));
  } catch {
    /* 存不了只在本次生效 */
  }
}
