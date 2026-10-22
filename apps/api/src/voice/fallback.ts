import { ALIYUN_TTS_DIVERT_WAIT_MS, ALIYUN_TTS_QUEUE_WAIT_MS, AliyunTtsError, classifyAliyunFailure, type AliyunFailureKind, type AliyunTtsGate } from "./aliyun";
import { DOUBAO_WAIT_MS, doubaoBusy } from "./doubao";
import type { VoiceSelection } from "./pool";
import type { ConcurrencyLimiter, EitherQueue } from "./rate-limit";

/**
 * 朗读故障转移（阿里云主用、豆包备用），两家额度都用上再排队：
 *  1. 阿里云每秒约 3 个名额（见 aliyun.ts 闸口），1 秒内轮得到就等它；要等更久（busy）或出错（限流 / 欠费额度 / 5xx / 超时 /
 *     网络 / 鉴权）这一次立刻改用豆包备用音色；其他错误（如参数错误）直接抛出，不转移。
 *  2. 阿里云只是忙或限流、豆包这一刻也没空位：进两家共用的队（EitherQueue），按到达顺序，谁先空出来就用谁，最多等 15 秒。
 *     豆包出错（不是没空位）：排队等阿里云，最多等 15 秒，429 / 5xx 退避重试。还不行才报失败。
 *  3. 豆包按并发计（见 doubao.ts），占着名额才发；豆包是唯一出路（主用豆包、阿里云欠费 / 鉴权 / 出错）时最多等 3 秒空位。
 * 纯逻辑，厂商调用通过 synth 注入，便于用假 provider 单测。
 */

/** busy = 阿里云 1 秒内轮不到、按设计分到豆包，不算出错（管理端告警不计） */
export type FallbackReason = Exclude<AliyunFailureKind, "other"> | "busy";

export interface SynthResult {
  audio: Buffer;
  elapsedMs: number;
}

export interface FallbackSpeech extends SynthResult {
  vendor: string;
  voiceId: string;
  /** 本次是否由阿里云转到了豆包 */
  fallback: boolean;
  fallbackReason?: FallbackReason;
  /** 两家都不行，排队等到了阿里云 */
  queued?: boolean;
}

/** 合成失败：带上“是否已经尝试过转移”和原因，路由据此写 voice_metrics */
export class VoiceSynthesisError extends Error {
  constructor(
    message: string,
    readonly vendor: string,
    readonly fallbackReason: FallbackReason | undefined,
    readonly original: unknown,
  ) {
    super(message);
    this.name = "VoiceSynthesisError";
  }
}

export type SynthFn = (selection: VoiceSelection, text: string) => Promise<SynthResult>;

/** 两家的限流：阿里云按速率（闸口），豆包按并发（信号量），两家都忙时的公共队列；不传就不限（单测、旧调用） */
export interface VoiceLimits {
  aliyun?: AliyunTtsGate;
  doubao?: ConcurrencyLimiter;
  either?: EitherQueue;
}

const messageOf = (error: unknown) => String((error as Error)?.message ?? error);

export async function synthesizeWithFallback(
  selection: VoiceSelection,
  text: string,
  synth: SynthFn,
  log?: (message: string, meta: Record<string, unknown>) => void,
  limits?: VoiceLimits,
): Promise<FallbackSpeech> {
  const primaryVendor = selection.voice.vendor;
  const backup = selection.fallback;
  const paced = primaryVendor === "aliyun" ? limits?.aliyun : undefined;
  const slots = limits?.doubao;
  // 豆包占着并发名额才发；doubaoWaitMs 内没空位抛 DOUBAO_TTS_BUSY
  const call = (item: VoiceSelection, doubaoWaitMs: number) =>
    item.voice.vendor === "doubao" && slots
      ? slots.run(() => synth(item, text), doubaoWaitMs, () => doubaoBusy("TTS", doubaoWaitMs))
      : synth(item, text);
  const started = Date.now();
  // 耗时从请求进来算起：转豆包、排队时学生实际等的是几段加起来
  const asPrimary = (result: SynthResult, queued = false): FallbackSpeech => ({
    ...result,
    elapsedMs: Date.now() - started,
    vendor: primaryVendor,
    voiceId: selection.voice.id,
    fallback: false,
    ...(queued ? { queued } : {}),
  });

  let error: unknown;
  let kind: FallbackReason | "other";
  if (!paced || (await paced.acquireWithin(ALIYUN_TTS_DIVERT_WAIT_MS))) {
    try {
      return asPrimary(await call(selection, DOUBAO_WAIT_MS));
    } catch (caught) {
      error = caught;
      kind = primaryVendor === "aliyun" ? classifyAliyunFailure(caught) : "other";
      if (kind === "throttled") paced?.throttled();
    }
  } else {
    error = new AliyunTtsError(`ALIYUN_TTS_BUSY: ${ALIYUN_TTS_DIVERT_WAIT_MS}ms 内轮不到`, "throttled", undefined, "LocalRateLimit");
    kind = "busy";
  }

  // 阿里云只是忙或限流、又没有别的路可走：排队等阿里云
  const queueForPrimary = async (cause: unknown): Promise<FallbackSpeech> => {
    log?.("aliyun busy and no backup available, queueing for aliyun", {
      kind,
      cause: messageOf(cause).slice(0, 200),
      voice: selection.voice.id,
      language: selection.language,
    });
    try {
      return asPrimary(await paced!.queue(() => synth(selection, text), ALIYUN_TTS_QUEUE_WAIT_MS), true);
    } catch (queuedError) {
      throw new VoiceSynthesisError(messageOf(queuedError), primaryVendor, backup ? kind as FallbackReason : undefined, queuedError);
    }
  };
  const canQueue = Boolean(paced) && (kind === "busy" || kind === "throttled");

  if (kind === "other" || !backup) {
    if (canQueue) return queueForPrimary(error);
    throw new VoiceSynthesisError(messageOf(error), primaryVendor, undefined, error);
  }
  // 高峰分流（busy）是常态，不记日志；真出错才记
  if (kind !== "busy") {
    log?.("aliyun tts failed, falling back to doubao", {
      kind,
      error: messageOf(error).slice(0, 200),
      voice: selection.voice.id,
      backupVoice: backup.voice.id,
      // 豆包也没有该语种时只能用英语音色读，留痕方便排查
      backupFellBackToEnglish: backup.fellBack,
      language: selection.language,
    });
  }
  const asBackup = (result: SynthResult): FallbackSpeech => ({
    ...result,
    elapsedMs: Date.now() - started,
    vendor: backup.voice.vendor,
    voiceId: backup.voice.id,
    fallback: true,
    fallbackReason: kind as FallbackReason,
  });
  const held = async (release: () => void) => {
    try {
      return asBackup(await synth(backup, text));
    } finally {
      release();
    }
  };

  // 阿里云只是忙或限流：豆包这一刻有空位就用，没有就进两家共用的队，谁先空出来用谁
  const either = canQueue && slots && limits?.either && backup.voice.vendor === "doubao" ? limits.either : undefined;
  if (either) {
    const release = slots!.tryAcquire();
    let grant = release ? ({ vendor: "doubao", release } as const) : null;
    if (!grant) {
      const waited = await either.wait(ALIYUN_TTS_QUEUE_WAIT_MS);
      if (!waited) {
        log?.("aliyun and doubao both busy, queue timed out", { kind, waitMs: ALIYUN_TTS_QUEUE_WAIT_MS, voice: selection.voice.id });
        throw new VoiceSynthesisError(`VOICE_QUEUE_FULL: 两家都忙，${ALIYUN_TTS_QUEUE_WAIT_MS}ms 内没轮到`, primaryVendor, kind as FallbackReason, null);
      }
      if (waited.vendor === "aliyun") {
        try {
          return asPrimary(await synth(selection, text), true);
        } catch (aliyunError) {
          if (classifyAliyunFailure(aliyunError) === "throttled") paced?.throttled();
          throw new VoiceSynthesisError(messageOf(aliyunError), primaryVendor, kind as FallbackReason, aliyunError);
        }
      }
      grant = waited;
    }
    try {
      return await held(grant.release);
    } catch (backupError) {
      // 豆包出错（不是没空位）：再排阿里云
      return queueForPrimary(backupError);
    }
  }

  try {
    // 阿里云还能排队时豆包没空位就不等
    const result = await call(backup, canQueue ? 0 : DOUBAO_WAIT_MS);
    return asBackup(result);
  } catch (backupError) {
    if (canQueue) return queueForPrimary(backupError);
    throw new VoiceSynthesisError(messageOf(backupError), backup.voice.vendor, kind, backupError);
  }
}
