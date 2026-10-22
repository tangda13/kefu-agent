import type { Db } from "../db";
import type { ApiEnv } from "../env";
import { getSetting, setSetting } from "../settings";
import type { SecretSealer } from "../llm/secret";
import { mapAsrLanguage, mapExplicitLanguage, recognizeSpeech, synthesizeSpeech } from "../voice-provider";
import { synthesizeWithFallback, type FallbackReason } from "./fallback";
import { ALIYUN_DEFAULT_BASE_URL, ALIYUN_DEFAULT_MODEL, aliyunTtsGate, synthesizeAliyun } from "./aliyun";
import { DOUBAO_WAIT_MS, doubaoAsrSlots, doubaoBusy, doubaoTtsSlots, shouldRetryWithAutoLanguage } from "./doubao";
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
    const explicit = mapExplicitLanguage(language);
    try {
      return await synthesizeSpeech(config, text, 20_000, explicit);
    } catch (error) {
      // 指定语种失败（如混合语言文本）时回退自动检测；并发 / 额度超限、超时等重试没用
      if (!explicit || !shouldRetryWithAutoLanguage(error)) throw error;
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
  /** 显示名（中文名或英文名），管理端卡片上用 */
  name: string;
  /** 下拉、日志里用的完整名：显示名 + ID */
  label: string;
  /** 一句特点（卡片上跟在名字后面，≤6 字） */
  tag: string;
  /** 官方描述（编辑抽屉里显示） */
  desc: string;
  gender: VoiceGender;
  /** 适用语言说明 */
  lang: string;
  /** 能胜任的音色池语种键 */
  langs: string[];
  /** 海外人设：为哪个音色池语种设计（如德国青年 → de），推荐时排第一 */
  persona?: string;
}

type SpeakerSeed = Omit<VoiceSpeaker, "label" | "lang" | "langs"> & { lang?: string; langs?: string[] };
const speaker = (seed: SpeakerSeed, lang: string, langs: string[]): VoiceSpeaker => ({
  lang,
  langs,
  ...seed,
  label: seed.name === seed.id ? seed.id : `${seed.name} ${seed.id}`,
});

/** 豆包语音合成 2.0（seed-tts-2.0）。英语 4 个来自官方音色表；Vivi 官方标注中、日、西、印尼并支持英语 */
const DOUBAO_SPEAKERS: VoiceSpeaker[] = [
  speaker({ id: "en_female_dacey_uranus_bigtts", name: "Dacey", tag: "美式女声", desc: "美式英语女声", gender: "female" }, "英语（美式）", ["en"]),
  speaker({ id: "en_female_stokie_uranus_bigtts", name: "Stokie", tag: "美式女声", desc: "美式英语女声", gender: "female" }, "英语（美式）", ["en"]),
  speaker({ id: "zh_female_vv_uranus_bigtts", name: "Vivi", tag: "多语种女声", desc: "会说中、英、日、西班牙、印尼语", gender: "female" }, "多语种（中、英、日、西班牙、印尼）", ["en", "es", "ja"]),
  speaker({ id: "zh_female_yingyujiaoxue_uranus_bigtts", name: "Tina", tag: "英式女声", desc: "英式英语女声", gender: "female", persona: "en-GB" }, "中文、英式英语", ["en-GB", "en"]),
  speaker({ id: "zh_female_xiaohe_uranus_bigtts", name: "小何", tag: "中文女声", desc: "中文女声", gender: "female" }, "中文", []),
  speaker({ id: "zh_female_qingxinnvsheng_uranus_bigtts", name: "清新女声", tag: "中文女声", desc: "中文女声", gender: "female" }, "中文", []),
  speaker({ id: "zh_female_cancan_uranus_bigtts", name: "知性灿灿", tag: "中文女声", desc: "中文女声", gender: "female" }, "中文", []),
  speaker({ id: "zh_female_kefunvsheng_uranus_bigtts", name: "暖阳女声", tag: "中文女声", desc: "中文女声", gender: "female" }, "中文", []),
  speaker({ id: "en_male_tim_uranus_bigtts", name: "Tim", tag: "美式男声", desc: "美式英语男声", gender: "male" }, "英语（美式）", ["en"]),
  speaker({ id: "zh_male_dayi_uranus_bigtts", name: "大壹", tag: "中文男声", desc: "中文男声", gender: "male" }, "中文", []),
  speaker({ id: "zh_male_m191_uranus_bigtts", name: "云舟", tag: "中文男声", desc: "中文男声", gender: "male" }, "中文", []),
  speaker({ id: "zh_male_taocheng_uranus_bigtts", name: "小天", tag: "中文男声", desc: "中文男声", gender: "male" }, "中文", []),
  speaker({ id: "zh_male_ruyayichen_uranus_bigtts", name: "儒雅逸辰", tag: "中文男声", desc: "中文男声", gender: "male" }, "中文", []),
  speaker({ id: "zh_male_shaonianzixin_uranus_bigtts", name: "少年梓辛", tag: "中文男声", desc: "中文男声", gender: "male" }, "中文", []),
];

/**
 * 阿里云千问3-TTS-Flash 系统音色（百炼《Qwen-TTS 音色列表》非实时部分，2026-10-14 核对）：
 * 每个音色都能说中英法德俄意西葡日韩。只收适合成年买家的 24 个；儿童、萝莉、二次元、方言、助眠、戏曲腔不收，需要时手动填 ID。
 */
const ALIYUN_LANGS = ["en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko"];
const ALIYUN_LANG_TEXT = "多语种（中、英、法、德、俄、意、西、葡、日、韩）";
const ali = (seed: SpeakerSeed) => speaker(seed, ALIYUN_LANG_TEXT, ALIYUN_LANGS);
const ALIYUN_SPEAKERS: VoiceSpeaker[] = [
  ali({ id: "Cherry", name: "芊悦", tag: "亲切自然", desc: "阳光积极、亲切自然的小姐姐", gender: "female" }),
  ali({ id: "Serena", name: "苏瑶", tag: "温柔", desc: "温柔小姐姐", gender: "female" }),
  ali({ id: "Maia", name: "四月", tag: "知性温柔", desc: "知性与温柔的碰撞", gender: "female" }),
  ali({ id: "Jennifer", name: "詹妮弗", tag: "美语女声", desc: "品牌级、电影质感般的美语女声", gender: "female" }),
  ali({ id: "Katerina", name: "卡捷琳娜", tag: "御姐音", desc: "御姐音色，韵律回味十足", gender: "female" }),
  ali({ id: "Elias", name: "墨讲师", tag: "讲师腔", desc: "严谨又会讲故事的讲师", gender: "female" }),
  ali({ id: "Mia", name: "乖小妹", tag: "乖巧温顺", desc: "温顺如春水，乖巧如初雪", gender: "female" }),
  ali({ id: "Sonrisa", name: "索尼莎", tag: "拉美大姐", desc: "热情开朗的拉美大姐", gender: "female", persona: "es" }),
  ali({ id: "Sohee", name: "素熙", tag: "韩国欧尼", desc: "温柔开朗、情绪丰富的韩国欧尼", gender: "female", persona: "ko" }),
  ali({ id: "Ono Anna", name: "小野杏", tag: "日本少女", desc: "鬼灵精怪的青梅竹马", gender: "female", persona: "ja" }),
  ali({ id: "Ethan", name: "晨煦", tag: "阳光温暖", desc: "阳光、温暖、活力、朝气", gender: "male" }),
  ali({ id: "Nofish", name: "不吃鱼", tag: "设计师", desc: "不会翘舌音的设计师", gender: "male" }),
  ali({ id: "Ryan", name: "甜茶", tag: "戏感强", desc: "节奏拉满，戏感炸裂", gender: "male" }),
  ali({ id: "Aiden", name: "艾登", tag: "美语大男孩", desc: "精通厨艺的美语大男孩", gender: "male" }),
  ali({ id: "Kai", name: "凯", tag: "低沉舒缓", desc: "低沉舒缓，耳朵的一场 SPA", gender: "male" }),
  ali({ id: "Moon", name: "月白", tag: "率性帅气", desc: "率性帅气", gender: "male" }),
  ali({ id: "Neil", name: "阿闻", tag: "新闻主播腔", desc: "平直的语调、字正腔圆，新闻主持人", gender: "male" }),
  ali({ id: "Andre", name: "安德雷", tag: "沉稳磁性", desc: "声音磁性，自然舒服、沉稳", gender: "male" }),
  ali({ id: "Bodega", name: "博德加", tag: "西班牙大叔", desc: "热情的西班牙大叔", gender: "male", persona: "es" }),
  ali({ id: "Alek", name: "阿列克", tag: "俄罗斯男声", desc: "战斗民族的冷，也是毛呢大衣下的暖", gender: "male", persona: "ru" }),
  ali({ id: "Dolce", name: "多尔切", tag: "意大利大叔", desc: "慵懒的意大利大叔", gender: "male", persona: "it" }),
  ali({ id: "Lenn", name: "莱恩", tag: "德国青年", desc: "理性是底色，叛逆藏在细节里——穿西装也听后朋克的德国青年", gender: "male", persona: "de" }),
  ali({ id: "Emilien", name: "埃米尔安", tag: "法国大哥哥", desc: "浪漫的法国大哥哥", gender: "male", persona: "fr" }),
  ali({ id: "Radio Gol", name: "拉迪奥·戈尔", tag: "巴西解说", desc: "足球诗人，解说腔，很夸张", gender: "male", persona: "pt" }),
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

/** 管理端试听没有备用，排队可以多等 */
const VOICE_PREVIEW_WAIT_MS = 15_000;

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
   * 阿里云这一刻没名额（每秒约 3 个）或出错（限流 / 欠费 / 5xx / 超时 / 网络 / 鉴权）时，这一次自动改用
   * selection.fallback（豆包备用音色）；豆包也不行再排队等阿里云，见 fallback.ts。
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
      { aliyun: aliyunTtsGate, doubao: doubaoTtsSlots },
    );
    return { ...spoken, ext: VOICE_VENDORS[spoken.vendor]!.audioExt };
  }

  /** 管理端：当前音色池下缺哪些语种的音色 */
  async missingVoices(): Promise<MissingVoice[]> {
    const profile = await this.profile();
    return findMissingVoices(profile.voicePool, await this.availableVendors());
  }

  /** 用指定音色试听（不保存）；和买家播报共用阿里云限流队列、豆包并发名额 */
  async preview(vendorKey: string, speaker: string, language = "en"): Promise<SynthesizedSpeech> {
    const profile = await this.profile();
    const vendor = VOICE_VENDORS[vendorKey];
    if (!vendor) throw new Error("VENDOR_UNKNOWN");
    const text = VOICE_PREVIEW_TEXTS[language] ?? VOICE_PREVIEW_TEXT;
    const run = () => vendor.provider.synthesize(profile, text, speaker, language);
    const result = vendorKey === "aliyun"
      ? await aliyunTtsGate.queue(run, VOICE_PREVIEW_WAIT_MS)
      : vendorKey === "doubao"
        ? await doubaoTtsSlots.run(run, VOICE_PREVIEW_WAIT_MS, () => doubaoBusy("TTS", VOICE_PREVIEW_WAIT_MS))
        : await run();
    return { ...result, vendor: vendorKey, voiceId: speaker, ext: vendor.audioExt };
  }

  /** 语音识别固定走豆包：占着并发名额才发，最多等 3 秒空位；耗时含等待 */
  async recognize(audio: Buffer, format: "wav" | "mp3", language: string | undefined) {
    const profile = await this.profile();
    const started = Date.now();
    const result = await doubaoAsrSlots.run(
      () => VOICE_VENDORS.doubao!.provider.recognize(profile, audio, format, language),
      DOUBAO_WAIT_MS,
      () => doubaoBusy("ASR", DOUBAO_WAIT_MS),
    );
    return { ...result, elapsedMs: Date.now() - started, audioMs: format === "wav" ? wavDurationMs(audio) : 0 };
  }
}
