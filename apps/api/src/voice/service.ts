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

/** 可选音色。买家多为海外客户，英语音色排在前面；表外的音色可在管理端手动填 ID */
export interface VoiceSpeaker {
  id: string;
  label: string;
  gender: "male" | "female";
  /** 适用语言说明 */
  lang: string;
}

const DOUBAO_SPEAKERS: VoiceSpeaker[] = [
  { id: "en_female_dacey_uranus_bigtts", label: "Dacey", gender: "female", lang: "英语" },
  { id: "en_female_stokie_uranus_bigtts", label: "Stokie", gender: "female", lang: "英语" },
  { id: "zh_female_vv_uranus_bigtts", label: "Vivi", gender: "female", lang: "多语种（中、英、日、西班牙、印尼）" },
  { id: "zh_female_yingyujiaoxue_uranus_bigtts", label: "Tina", gender: "female", lang: "中文、英式英语" },
  { id: "zh_female_xiaohe_uranus_bigtts", label: "小何", gender: "female", lang: "中文" },
  { id: "zh_female_qingxinnvsheng_uranus_bigtts", label: "清新女声", gender: "female", lang: "中文" },
  { id: "zh_female_cancan_uranus_bigtts", label: "知性灿灿", gender: "female", lang: "中文" },
  { id: "zh_female_kefunvsheng_uranus_bigtts", label: "暖阳女声", gender: "female", lang: "中文" },
  { id: "en_male_tim_uranus_bigtts", label: "Tim", gender: "male", lang: "英语" },
  { id: "zh_male_dayi_uranus_bigtts", label: "大壹", gender: "male", lang: "中文" },
  { id: "zh_male_m191_uranus_bigtts", label: "云舟", gender: "male", lang: "中文" },
  { id: "zh_male_taocheng_uranus_bigtts", label: "小天", gender: "male", lang: "中文" },
  { id: "zh_male_ruyayichen_uranus_bigtts", label: "儒雅逸辰", gender: "male", lang: "中文" },
  { id: "zh_male_shaonianzixin_uranus_bigtts", label: "少年梓辛", gender: "male", lang: "中文" },
];

export const VOICE_VENDORS: Record<string, { label: string; provider: VoiceProvider; speakers: VoiceSpeaker[] }> = {
  doubao: { label: "豆包语音（火山引擎）", provider: doubaoProvider, speakers: DOUBAO_SPEAKERS },
};

/** 试听用的句子：买家的真实口吻 */
export const VOICE_PREVIEW_TEXT = "Hi, I ordered a jacket last week and it still hasn't arrived. Could you check where my package is?";

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

  /** 用指定音色试听（不保存） */
  async preview(speaker: string, text = VOICE_PREVIEW_TEXT) {
    const profile = await this.profile();
    const trial = { ...profile, ttsSpeaker: speaker, ttsSpeakerMale: speaker };
    return VOICE_VENDORS[profile.vendor]!.provider.synthesize(trial, text, "female", "en");
  }

  async recognize(audio: Buffer, format: "wav" | "mp3", language: string | undefined) {
    const profile = await this.profile();
    const result = await VOICE_VENDORS[profile.vendor]!.provider.recognize(profile, audio, format, language);
    return { ...result, audioMs: format === "wav" ? wavDurationMs(audio) : 0 };
  }
}
