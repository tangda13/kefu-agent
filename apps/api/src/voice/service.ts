import type { Db } from "../db";
import type { ApiEnv } from "../env";
import { getSetting, setSetting } from "../settings";
import type { SecretSealer } from "../llm/secret";
import { mapAsrLanguage, mapExplicitLanguage, recognizeSpeech, synthesizeSpeech } from "../voice-provider";

/**
 * 语音服务档案（G7）：配置存 app_settings.voice，Key 加密；厂商通过 VoiceProvider 接口接入，
 * 目前实现豆包（火山引擎），新增厂商只需在 VOICE_VENDORS 注册一个实现。
 */
export interface VoiceProfile {
  vendor: string;
  apiKey: string;
  ttsResourceId: string;
  ttsSpeaker: string;
  ttsSpeakerMale: string;
  asrResourceId: string;
  /** 元 / 万字符 */
  ttsPricePer10kChars: number;
  /** 元 / 小时音频 */
  asrPricePerHour: number;
}

interface StoredVoice extends Omit<Partial<VoiceProfile>, "apiKey"> {
  apiKeyEnc?: string;
  /** 旧版明文 Key，读到后立即加密改存 */
  apiKey?: string;
}

export interface VoiceProvider {
  synthesize(profile: VoiceProfile, text: string, gender: "male" | "female", language: string | undefined): Promise<{ audio: Buffer; elapsedMs: number }>;
  recognize(profile: VoiceProfile, audio: Buffer, format: "wav" | "mp3", language: string | undefined): Promise<{ text: string; elapsedMs: number }>;
}

const doubaoProvider: VoiceProvider = {
  async synthesize(profile, text, gender, language) {
    const config = {
      apiKey: profile.apiKey,
      resourceId: profile.ttsResourceId,
      speaker: gender === "male" ? profile.ttsSpeakerMale : profile.ttsSpeaker,
    };
    try {
      return await synthesizeSpeech(config, text, 20_000, mapExplicitLanguage(language));
    } catch {
      // 指定语种失败（如混合语言文本）时回退自动检测
      return synthesizeSpeech(config, text);
    }
  },
  recognize(profile, audio, format, language) {
    return recognizeSpeech({ apiKey: profile.apiKey, resourceId: profile.asrResourceId }, audio, format, mapAsrLanguage(language));
  },
};

export const VOICE_VENDORS: Record<string, { label: string; provider: VoiceProvider }> = {
  doubao: { label: "豆包语音（火山引擎）", provider: doubaoProvider },
};

/** WAV 时长（毫秒），用于按小时计费；非 WAV 返回 0 */
export function wavDurationMs(audio: Buffer): number {
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return 0;
  const byteRate = audio.readUInt32LE(28);
  return byteRate > 0 ? Math.round(((audio.length - 44) / byteRate) * 1000) : 0;
}

export class VoiceService {
  private cached: VoiceProfile | null = null;

  constructor(
    private readonly db: Db,
    private readonly sealer: SecretSealer,
    private readonly env: Pick<ApiEnv, "ttsApiKey" | "ttsResourceId" | "ttsSpeaker" | "ttsSpeakerMale" | "asrResourceId">,
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  /** DB 设置优先，回退 env */
  async profile(): Promise<VoiceProfile> {
    if (this.cached) return this.cached;
    const saved = (await getSetting<StoredVoice>(this.db, "voice")) ?? {};
    if (saved.apiKey) {
      // 旧版明文 Key → 加密改存
      const { apiKey, ...rest } = saved;
      await setSetting(this.db, "voice", { ...rest, apiKeyEnc: this.sealer.seal(apiKey) });
      saved.apiKeyEnc = this.sealer.seal(apiKey);
    }
    let apiKey = "";
    try {
      apiKey = saved.apiKeyEnc ? this.sealer.open(saved.apiKeyEnc) : "";
    } catch {
      apiKey = "";
    }
    this.cached = {
      vendor: saved.vendor && VOICE_VENDORS[saved.vendor] ? saved.vendor : "doubao",
      apiKey: apiKey || this.env.ttsApiKey,
      ttsResourceId: saved.ttsResourceId || this.env.ttsResourceId,
      ttsSpeaker: saved.ttsSpeaker || this.env.ttsSpeaker,
      ttsSpeakerMale: saved.ttsSpeakerMale || this.env.ttsSpeakerMale,
      asrResourceId: saved.asrResourceId || this.env.asrResourceId,
      ttsPricePer10kChars: Number(saved.ttsPricePer10kChars) || 0,
      asrPricePerHour: Number(saved.asrPricePerHour) || 0,
    };
    return this.cached;
  }

  async save(input: Partial<VoiceProfile>): Promise<void> {
    const saved = (await getSetting<StoredVoice>(this.db, "voice")) ?? {};
    const { apiKey, ...rest } = input;
    const next: StoredVoice = { ...saved, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== "")) };
    delete next.apiKey;
    if (apiKey?.trim()) next.apiKeyEnc = this.sealer.seal(apiKey.trim());
    await setSetting(this.db, "voice", next);
    this.invalidate();
  }

  async configured(): Promise<boolean> {
    return Boolean((await this.profile()).apiKey);
  }

  async synthesize(text: string, gender: "male" | "female", language: string | undefined) {
    const profile = await this.profile();
    return VOICE_VENDORS[profile.vendor]!.provider.synthesize(profile, text, gender, language);
  }

  async recognize(audio: Buffer, format: "wav" | "mp3", language: string | undefined) {
    const profile = await this.profile();
    const result = await VOICE_VENDORS[profile.vendor]!.provider.recognize(profile, audio, format, language);
    return { ...result, audioMs: format === "wav" ? wavDurationMs(audio) : 0 };
  }
}
