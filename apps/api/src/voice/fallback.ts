import { classifyAliyunFailure, type AliyunFailureKind } from "./aliyun";
import type { VoiceSelection } from "./pool";

/**
 * 朗读故障转移（阿里云主用、豆包备用）：阿里云限流 / 欠费额度 / 5xx / 超时 / 网络错误 / 鉴权失败时，
 * 这一次改用豆包备用音色合成；其他错误（如参数错误）直接抛出，不转移。
 * 纯逻辑，厂商调用通过 synth 注入，便于用假 provider 单测。
 */

export type FallbackReason = Exclude<AliyunFailureKind, "other">;

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

export async function synthesizeWithFallback(
  selection: VoiceSelection,
  text: string,
  synth: SynthFn,
  log?: (message: string, meta: Record<string, unknown>) => void,
): Promise<FallbackSpeech> {
  const primaryVendor = selection.voice.vendor;
  try {
    const result = await synth(selection, text);
    return { ...result, vendor: primaryVendor, voiceId: selection.voice.id, fallback: false };
  } catch (error) {
    const kind = primaryVendor === "aliyun" ? classifyAliyunFailure(error) : "other";
    const backup = selection.fallback;
    if (kind === "other" || !backup) {
      throw new VoiceSynthesisError(String((error as Error)?.message ?? error), primaryVendor, undefined, error);
    }
    log?.("aliyun tts failed, falling back to doubao", {
      kind,
      error: String((error as Error)?.message ?? error).slice(0, 200),
      voice: selection.voice.id,
      backupVoice: backup.voice.id,
      // 豆包也没有该语种时只能用英语音色读，留痕方便排查
      backupFellBackToEnglish: backup.fellBack,
      language: selection.language,
    });
    try {
      const result = await synth(backup, text);
      return { ...result, vendor: backup.voice.vendor, voiceId: backup.voice.id, fallback: true, fallbackReason: kind };
    } catch (backupError) {
      throw new VoiceSynthesisError(String((backupError as Error)?.message ?? backupError), backup.voice.vendor, kind, backupError);
    }
  }
}
