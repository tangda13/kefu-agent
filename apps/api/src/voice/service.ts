import type { Db } from "../db";
import type { ApiEnv } from "../env";
import { getSetting, setSetting } from "../settings";
import type { SecretSealer } from "../llm/secret";
import { mapAsrLanguage, mapExplicitLanguage, recognizeSpeech, synthesizeSpeech } from "../voice-provider";
import { synthesizeWithFallback, type FallbackReason } from "./fallback";
import { ALIYUN_DEFAULT_BASE_URL, ALIYUN_DEFAULT_MODEL, synthesizeAliyun } from "./aliyun";
import {
  defaultVoicePool, findMissingVoices, normalizeVoicePool, selectVoice,
  type BuyerVoiceFacts, type MissingVoice, type VoiceGender, type VoicePool, type VoiceSelection,
} from "./pool";

/**
 * 语音服务档案（G7）：配置存 app_settings.voice，Key 加密；厂商通过 VoiceProvider 接口接入。
 * 目前有阿里云（千问3-TTS，只做朗读，主用）和豆包（火山引擎，朗读 + 识别，朗读备用）。
 * 买家朗读按 D-42 走音色池：语种 → 厂商 → 音色，见 pool.ts；阿里云出错单次转豆包，见 fallback.ts。
 */
export interface VoiceProfile {
  vendor: string;
  apiKey: string;
  ttsResourceId: string;
  /** 旧版单一男女声，音色池选不出时的最后兜底（豆包） */
  ttsSpeaker: string;
  ttsSpeakerMale: string;
  asrResourceId: string;
  /** 元 / 万字符 */
  ttsPricePer10kChars: number;
  /** 元 / 小时音频 */
  asrPricePerHour: number;
  /** 阿里云（补充语种）：百炼 API Key、地域地址、模型、单价（元 / 万字符） */
  aliyunApiKey: string;
  aliyunBaseUrl: string;
  aliyunModel: string;
  aliyunTtsPricePer10kChars: number;
  /** 买家音色池：语种 × 性别 → 音色列表 */
  voicePool: VoicePool;
}

interface StoredVoice extends Omit<Partial<VoiceProfile>, "apiKey" | "aliyunApiKey"> {
  apiKeyEnc?: string;
  aliyunApiKeyEnc?: string;
  /** 旧版明文 Key，读到后立即加密改存 */
  apiKey?: string;
}

export interface SynthesizedSpeech {
  audio: Buffer;
  elapsedMs: number;
  vendor: string;
  voiceId: string;
  /** 音频文件扩展名（豆包 mp3，阿里云 wav） */
  ext: string;
  /** 本次由阿里云转到了豆包（vendor 是实际出声的豆包） */
  fallback?: boolean;
  fallbackReason?: FallbackReason;
}

export interface VoiceProvider {
  /** speaker 为音色 ID，language 为音色池语种键（en / en-GB / de …），undefined 表示让厂商自动识别 */
  synthesize(profile: VoiceProfile, text: string, speaker: string, language: string | undefined): Promise<{ audio: Buffer; elapsedMs: number }>;
  recognize(profile: VoiceProfile, audio: Buffer, format: "wav" | "mp3", language: string | undefined): Promise<{ text: string; elapsedMs: number }>;
}

const doubaoProvider: VoiceProvider = {
  async synthesize(profile, text, speaker, language) {
    const config = { apiKey: profile.apiKey, resourceId: profile.ttsResourceId, speaker };
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

const aliyunProvider: VoiceProvider = {
  synthesize(profile, text, speaker, language) {
    return synthesizeAliyun(
      { apiKey: profile.aliyunApiKey, baseUrl: profile.aliyunBaseUrl, model: profile.aliyunModel },
      text,
      speaker,
      language,
    );
  },
  async recognize() {
    // 阿里云只接朗读；语音识别固定走豆包
    throw new Error("ASR_NOT_SUPPORTED");
  },
};

/** 可选音色。表外的音色可在管理端手动填 ID */
export interface VoiceSpeaker {
  id: string;
  label: string;
  gender: VoiceGender;
  /** 适用语言说明 */
  lang: string;
  /** 能胜任的音色池语种键 */
  langs: string[];
}

/** 豆包语音合成 2.0（seed-tts-2.0）。英语 4 个来自官方音色表；Vivi 官方标注中、日、西、印尼并支持英语 */
const DOUBAO_SPEAKERS: VoiceSpeaker[] = [
  { id: "en_female_dacey_uranus_bigtts", label: "Dacey", gender: "female", lang: "英语（美式）", langs: ["en"] },
  { id: "en_female_stokie_uranus_bigtts", label: "Stokie", gender: "female", lang: "英语（美式）", langs: ["en"] },
  { id: "zh_female_vv_uranus_bigtts", label: "Vivi", gender: "female", lang: "多语种（中、英、日、西班牙、印尼）", langs: ["en", "es", "ja"] },
  { id: "zh_female_yingyujiaoxue_uranus_bigtts", label: "Tina", gender: "female", lang: "中文、英式英语", langs: ["en-GB", "en"] },
  { id: "zh_female_xiaohe_uranus_bigtts", label: "小何", gender: "female", lang: "中文", langs: [] },
  { id: "zh_female_qingxinnvsheng_uranus_bigtts", label: "清新女声", gender: "female", lang: "中文", langs: [] },
  { id: "zh_female_cancan_uranus_bigtts", label: "知性灿灿", gender: "female", lang: "中文", langs: [] },
  { id: "zh_female_kefunvsheng_uranus_bigtts", label: "暖阳女声", gender: "female", lang: "中文", langs: [] },
  { id: "en_male_tim_uranus_bigtts", label: "Tim", gender: "male", lang: "英语（美式）", langs: ["en"] },
  { id: "zh_male_dayi_uranus_bigtts", label: "大壹", gender: "male", lang: "中文", langs: [] },
  { id: "zh_male_m191_uranus_bigtts", label: "云舟", gender: "male", lang: "中文", langs: [] },
  { id: "zh_male_taocheng_uranus_bigtts", label: "小天", gender: "male", lang: "中文", langs: [] },
  { id: "zh_male_ruyayichen_uranus_bigtts", label: "儒雅逸辰", gender: "male", lang: "中文", langs: [] },
  { id: "zh_male_shaonianzixin_uranus_bigtts", label: "少年梓辛", gender: "male", lang: "中文", langs: [] },
];

/** 阿里云千问3-TTS-Flash 多语种系统音色（官方音色表：除方言音色外均支持中英法德俄意西葡日韩） */
const ALIYUN_LANGS = ["en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko"];
const ALIYUN_LANG_TEXT = "多语种（中、英、法、德、俄、意、西、葡、日、韩）";
const ALIYUN_SPEAKERS: VoiceSpeaker[] = [
  { id: "Cherry", label: "芊悦 Cherry", gender: "female", lang: ALIYUN_LANG_TEXT, langs: ALIYUN_LANGS },
  { id: "Jennifer", label: "詹妮弗 Jennifer", gender: "female", lang: ALIYUN_LANG_TEXT, langs: ALIYUN_LANGS },
  { id: "Katerina", label: "卡捷琳娜 Katerina", gender: "female", lang: ALIYUN_LANG_TEXT, langs: ALIYUN_LANGS },
  { id: "Elias", label: "墨讲师 Elias", gender: "female", lang: ALIYUN_LANG_TEXT, langs: ALIYUN_LANGS },
  { id: "Ethan", label: "晨煦 Ethan", gender: "male", lang: ALIYUN_LANG_TEXT, langs: ALIYUN_LANGS },
  { id: "Nofish", label: "不吃鱼 Nofish", gender: "male", lang: ALIYUN_LANG_TEXT, langs: ALIYUN_LANGS },
  { id: "Ryan", label: "甜茶 Ryan", gender: "male", lang: ALIYUN_LANG_TEXT, langs: ALIYUN_LANGS },
];

export interface VoiceVendorInfo {
  label: string;
  provider: VoiceProvider;
  speakers: VoiceSpeaker[];
  /** 朗读音频文件扩展名 */
  audioExt: string;
  /** 是否支持语音识别 */
  asr: boolean;
}

export const VOICE_VENDORS: Record<string, VoiceVendorInfo> = {
  doubao: { label: "豆包语音（火山引擎）", provider: doubaoProvider, speakers: DOUBAO_SPEAKERS, audioExt: "mp3", asr: true },
  aliyun: { label: "阿里云百炼（千问3-TTS）", provider: aliyunProvider, speakers: ALIYUN_SPEAKERS, audioExt: "wav", asr: false },
};

/** 试听用的句子：各语种买家的真实口吻 */
export const VOICE_PREVIEW_TEXT = "Hi, I ordered a jacket last week and it still hasn't arrived. Could you check where my package is?";
export const VOICE_PREVIEW_TEXTS: Record<string, string> = {
  en: VOICE_PREVIEW_TEXT,
  "en-GB": "Hello, I ordered a jacket last week and it still hasn't arrived. Could you check where my parcel is, please?",
  "en-AU": "G'day, I ordered a jacket last week and it still hasn't arrived. Could you check where my parcel is?",
  es: "Hola, pedí una chaqueta la semana pasada y todavía no ha llegado. ¿Podría revisar dónde está mi paquete?",
  fr: "Bonjour, j'ai commandé une veste la semaine dernière et elle n'est toujours pas arrivée. Pouvez-vous vérifier où se trouve mon colis ?",
  de: "Guten Tag, ich habe letzte Woche eine Jacke bestellt und sie ist noch nicht angekommen. Können Sie bitte prüfen, wo mein Paket ist?",
  it: "Buongiorno, ho ordinato una giacca la settimana scorsa e non è ancora arrivata. Potrebbe controllare dov'è il mio pacco?",
  pt: "Olá, pedi uma jaqueta na semana passada e ela ainda não chegou. Pode verificar onde está o meu pacote?",
  ru: "Здравствуйте, я заказал куртку на прошлой неделе, но она до сих пор не пришла. Не могли бы вы проверить, где моя посылка?",
  ja: "こんにちは、先週ジャケットを注文したのですが、まだ届いていません。荷物の状況を確認していただけますか？",
  ko: "안녕하세요, 지난주에 재킷을 주문했는데 아직 도착하지 않았어요. 제 택배가 어디에 있는지 확인해 주시겠어요?",
  ar: "مرحبًا، طلبت سترة الأسبوع الماضي ولم تصل بعد. هل يمكنك التحقق من مكان طردي؟",
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

  private open(sealed: string | undefined): string {
    try {
      return sealed ? this.sealer.open(sealed) : "";
    } catch {
      return "";
    }
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
    const apiKey = this.open(saved.apiKeyEnc);
    const vendors = Object.keys(VOICE_VENDORS);
    this.cached = {
      vendor: saved.vendor && VOICE_VENDORS[saved.vendor] ? saved.vendor : "doubao",
      apiKey: apiKey || this.env.ttsApiKey,
      ttsResourceId: saved.ttsResourceId || this.env.ttsResourceId,
      ttsSpeaker: saved.ttsSpeaker || this.env.ttsSpeaker,
      ttsSpeakerMale: saved.ttsSpeakerMale || this.env.ttsSpeakerMale,
      asrResourceId: saved.asrResourceId || this.env.asrResourceId,
      ttsPricePer10kChars: Number(saved.ttsPricePer10kChars) || 0,
      asrPricePerHour: Number(saved.asrPricePerHour) || 0,
      aliyunApiKey: this.open(saved.aliyunApiKeyEnc),
      aliyunBaseUrl: saved.aliyunBaseUrl || ALIYUN_DEFAULT_BASE_URL,
      aliyunModel: saved.aliyunModel || ALIYUN_DEFAULT_MODEL,
      aliyunTtsPricePer10kChars: Number(saved.aliyunTtsPricePer10kChars) || 0,
      voicePool: saved.voicePool ? normalizeVoicePool(saved.voicePool, vendors) : defaultVoicePool(),
    };
    return this.cached;
  }

  async save(input: Partial<VoiceProfile>): Promise<void> {
    const saved = (await getSetting<StoredVoice>(this.db, "voice")) ?? {};
    const { apiKey, aliyunApiKey, voicePool, ...rest } = input;
    const next: StoredVoice = { ...saved, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== "")) };
    delete next.apiKey;
    if (apiKey?.trim()) next.apiKeyEnc = this.sealer.seal(apiKey.trim());
    if (aliyunApiKey?.trim()) next.aliyunApiKeyEnc = this.sealer.seal(aliyunApiKey.trim());
    if (voicePool) next.voicePool = normalizeVoicePool(voicePool, Object.keys(VOICE_VENDORS));
    await setSetting(this.db, "voice", next);
    this.invalidate();
  }

  /** 豆包密钥已配置（语音识别、豆包朗读都靠它） */
  async configured(): Promise<boolean> {
    return Boolean((await this.profile()).apiKey);
  }

  /** 哪些厂商可以朗读（密钥已配置） */
  async availableVendors(): Promise<Set<string>> {
    const profile = await this.profile();
    const out = new Set<string>();
    if (profile.apiKey) out.add("doubao");
    if (profile.aliyunApiKey) out.add("aliyun");
    return out;
  }

  async ttsConfigured(): Promise<boolean> {
    return (await this.availableVendors()).size > 0;
  }

  /** 为买家选音色（语种 → 厂商 → 音色，同一买家永远同一个）；没有任何可用厂商返回 null */
  async selectVoice(persona: BuyerVoiceFacts, gender: VoiceGender): Promise<VoiceSelection | null> {
    const profile = await this.profile();
    return selectVoice({ pool: profile.voicePool, persona, gender, available: await this.availableVendors() });
  }

  /**
   * 买家能不能用这个语种朗读（D-43）：阿里云或豆包任一能说该语种 × 性别（池里有已配置厂商的音色）就算能说。
   * 英语口音（en-GB / en-AU）缺音色会自然落到通用英语，仍算可用；其他语种缺音色（含语音整体未配置）为 false。
   */
  async canSpeak(language: string, gender: VoiceGender, nationality?: string): Promise<boolean> {
    const selection = await this.selectVoice({ language, nationality, gender }, gender);
    return Boolean(selection && !selection.fellBack);
  }

  /**
   * 按选定音色合成。退回英语时语种交给厂商自动识别，避免用英语规则硬读其他语言。
   * 主用阿里云出错（限流 / 欠费 / 5xx / 超时 / 网络 / 鉴权）时，这一次自动改用 selection.fallback（豆包备用音色）。
   */
  async synthesizeWith(
    selection: VoiceSelection,
    text: string,
    log?: (message: string, meta: Record<string, unknown>) => void,
  ): Promise<SynthesizedSpeech> {
    const profile = await this.profile();
    const spoken = await synthesizeWithFallback(
      selection,
      text,
      (item, content) => VOICE_VENDORS[item.voice.vendor]!.provider.synthesize(profile, content, item.voice.id, item.fellBack ? undefined : item.poolLanguage),
      log,
    );
    return { ...spoken, ext: VOICE_VENDORS[spoken.vendor]!.audioExt };
  }

  /** 管理端：当前音色池下缺哪些语种的音色 */
  async missingVoices(): Promise<MissingVoice[]> {
    const profile = await this.profile();
    return findMissingVoices(profile.voicePool, await this.availableVendors());
  }

  /** 用指定音色试听（不保存） */
  async preview(vendorKey: string, speaker: string, language = "en"): Promise<SynthesizedSpeech> {
    const profile = await this.profile();
    const vendor = VOICE_VENDORS[vendorKey];
    if (!vendor) throw new Error("VENDOR_UNKNOWN");
    const text = VOICE_PREVIEW_TEXTS[language] ?? VOICE_PREVIEW_TEXT;
    const result = await vendor.provider.synthesize(profile, text, speaker, language);
    return { ...result, vendor: vendorKey, voiceId: speaker, ext: vendor.audioExt };
  }

  /** 语音识别固定走豆包 */
  async recognize(audio: Buffer, format: "wav" | "mp3", language: string | undefined) {
    const profile = await this.profile();
    const result = await VOICE_VENDORS.doubao!.provider.recognize(profile, audio, format, language);
    return { ...result, audioMs: format === "wav" ? wavDurationMs(audio) : 0 };
  }
}
