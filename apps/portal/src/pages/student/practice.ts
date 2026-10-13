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
