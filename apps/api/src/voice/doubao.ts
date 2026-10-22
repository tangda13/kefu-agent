import { ConcurrencyLimiter } from "./rate-limit";

/**
 * 豆包正式版默认并发（用户 2026-10-22 提供）：语音合成 2.0 10 个、流式语音识别 2.0 50 个，按同时在跑的会话算，不是 RPM。
 * 和阿里云一样留一成余量。开发和生产共用一个豆包应用时名额也共用，生产最好单独建应用。
 */
export const DOUBAO_TTS_CONCURRENCY = 9;
export const DOUBAO_ASR_CONCURRENCY = 45;
/** 豆包是唯一出路时（主用豆包、阿里云用不了、语音识别）最多等几秒空位 */
export const DOUBAO_WAIT_MS = 3_000;

/** 本进程所有豆包朗读 / 识别各共用一个；只跑一个 api 实例时成立 */
export const doubaoTtsSlots = new ConcurrencyLimiter(DOUBAO_TTS_CONCURRENCY);
export const doubaoAsrSlots = new ConcurrencyLimiter(DOUBAO_ASR_CONCURRENCY);

export const doubaoBusy = (kind: "TTS" | "ASR", waitMs: number) =>
  new Error(`DOUBAO_${kind}_BUSY: ${waitMs}ms 内没有空闲并发`);

/**
 * 指定语种朗读失败后，要不要换成自动识别语种再试一次：只有服务端明确回了错误帧（多为语种和文本对不上）才值得试；
 * 并发 / 额度超限、超时、连不上时重试没用，还会多等一轮。
 */
export function shouldRetryWithAutoLanguage(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  if (!/^TTS_(ERROR_|SESSION_FAILED)/.test(message)) return false;
  return !/quota|limit|concurren|exceed|too many|429/i.test(message);
}
