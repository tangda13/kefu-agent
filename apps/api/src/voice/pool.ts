import { stableHash } from "@cecs/domain";

/**
 * 买家语音音色池（D-42）：每个语种 × 性别配置一组音色，每位买家按画像种子固定分到其中一个。
 * 本文件只放纯函数（语种判定、选择、校验、缺口提示），不碰网络和数据库，便于单测。
 */

export type VoiceGender = "male" | "female";

/** 音色池的语种键：en = 美式/通用英语，en-GB / en-AU 为口音，其余为语种两位码 */
export const POOL_LANGUAGES = [
  { key: "en", label: "英语（美式 / 通用）", core: true },
  { key: "en-GB", label: "英语（英式）", core: false },
  { key: "en-AU", label: "英语（澳式）", core: false },
  { key: "es", label: "西班牙语", core: true },
  { key: "fr", label: "法语", core: true },
  { key: "de", label: "德语", core: true },
  { key: "it", label: "意大利语", core: true },
  { key: "pt", label: "葡萄牙语", core: true },
  { key: "ru", label: "俄语", core: true },
  { key: "ja", label: "日语", core: true },
  { key: "ko", label: "韩语", core: true },
  { key: "ar", label: "阿拉伯语", core: true },
] as const;

export type PoolLanguage = (typeof POOL_LANGUAGES)[number]["key"];

const POOL_LANGUAGE_KEYS = new Set<string>(POOL_LANGUAGES.map((item) => item.key));

export interface PoolVoice {
  vendor: string;
  id: string;
}

export type VoicePool = Record<string, { female: PoolVoice[]; male: PoolVoice[] }>;

/** 豆包优先，没有该语种音色时才轮到其他厂商 */
export const PRIMARY_VENDOR = "doubao";

/**
 * 默认音色池。豆包 2.0（seed-tts-2.0）只有英语（美式 3 个、英式 1 个女声）和 Vivi 多语种女声
 * （中、英、日、西、印尼）；德、法、意、葡、俄、韩，以及西语、日语男声走阿里云千问3-TTS-Flash。
 * 阿拉伯语国内厂商暂无系统音色，留空，运行时退回英语。
 */
const ALIYUN_FEMALE = ["Cherry", "Jennifer", "Katerina", "Elias"];
const ALIYUN_MALE = ["Ethan", "Nofish", "Ryan"];
const aliyun = (ids: string[]): PoolVoice[] => ids.map((id) => ({ vendor: "aliyun", id }));
const doubao = (ids: string[]): PoolVoice[] => ids.map((id) => ({ vendor: "doubao", id }));

export function defaultVoicePool(): VoicePool {
  return {
    en: {
      female: doubao(["en_female_dacey_uranus_bigtts", "en_female_stokie_uranus_bigtts", "zh_female_vv_uranus_bigtts"]),
      male: doubao(["en_male_tim_uranus_bigtts"]),
    },
    "en-GB": { female: doubao(["zh_female_yingyujiaoxue_uranus_bigtts"]), male: [] },
    "en-AU": { female: [], male: [] },
    es: { female: doubao(["zh_female_vv_uranus_bigtts"]), male: aliyun(ALIYUN_MALE) },
    fr: { female: aliyun(ALIYUN_FEMALE), male: aliyun(ALIYUN_MALE) },
    de: { female: aliyun(ALIYUN_FEMALE), male: aliyun(ALIYUN_MALE) },
    it: { female: aliyun(ALIYUN_FEMALE), male: aliyun(ALIYUN_MALE) },
    pt: { female: aliyun(ALIYUN_FEMALE), male: aliyun(ALIYUN_MALE) },
    ru: { female: aliyun(ALIYUN_FEMALE), male: aliyun(ALIYUN_MALE) },
    ja: { female: doubao(["zh_female_vv_uranus_bigtts"]), male: aliyun(ALIYUN_MALE) },
    ko: { female: aliyun(ALIYUN_FEMALE), male: aliyun(ALIYUN_MALE) },
    ar: { female: [], male: [] },
  };
}

/** 校验并规整管理端提交的音色池；非法项丢弃，返回规整后的池 */
export function normalizeVoicePool(input: unknown, knownVendors: string[]): VoicePool {
  const result: VoicePool = {};
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const { key } of POOL_LANGUAGES) {
    const entry = (source[key] ?? {}) as { female?: unknown; male?: unknown };
    const clean = (list: unknown): PoolVoice[] => {
      if (!Array.isArray(list)) return [];
      const seen = new Set<string>();
      const out: PoolVoice[] = [];
      for (const item of list) {
        const vendor = String((item as PoolVoice)?.vendor ?? "");
        const id = String((item as PoolVoice)?.id ?? "").trim();
        if (!knownVendors.includes(vendor) || !/^[A-Za-z0-9_.-]{2,80}$/.test(id)) continue;
        const dedupe = `${vendor}:${id}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({ vendor, id });
        if (out.length >= 12) break;
      }
      return out;
    };
    result[key] = { female: clean(entry.female), male: clean(entry.male) };
  }
  return result;
}

export interface BuyerVoiceFacts {
  language?: string;
  nationality?: string;
  gender?: VoiceGender;
  name?: string;
  sourceTemplateId?: string;
}

/**
 * 买家说什么就用什么语种的音色：画像 language 是英语（多数）→ 英语音色，
 * 国籍是英国 / 澳大利亚时优先对应口音；language 是其他语种（es-ES、de-DE…）→ 该语种。
 * 不认识的语种按英语处理。
 */
export function resolveVoiceLanguage(persona: { language?: string; nationality?: string }): PoolLanguage {
  const raw = String(persona.language ?? "").trim();
  const lower = raw.toLowerCase();
  const base = lower.split(/[-_]/)[0] ?? "";
  if (!base || base === "en") {
    if (lower === "en-gb" || persona.nationality === "英国") return "en-GB";
    if (lower === "en-au" || persona.nationality === "澳大利亚") return "en-AU";
    return "en";
  }
  return POOL_LANGUAGE_KEYS.has(base) ? (base as PoolLanguage) : "en";
}

/** 画像种子：同一买家（姓名 + 来源模板）永远同一个种子 */
export function personaVoiceSeed(persona: { name?: string; sourceTemplateId?: string }): string {
  return `${persona.name ?? ""}|${persona.sourceTemplateId ?? ""}`;
}

export interface VoiceSelection {
  voice: PoolVoice;
  /** 实际使用的音色池语种键 */
  poolLanguage: string;
  /** 买家本来的语种 */
  language: PoolLanguage;
  /** 该语种没有可用音色，退回了英语（此时朗读语种应交给厂商自动识别） */
  fellBack: boolean;
}

function usableVoices(pool: VoicePool, language: string, gender: VoiceGender, available: Set<string>): PoolVoice[] {
  const all = (pool[language]?.[gender] ?? []).filter((item) => available.has(item.vendor));
  const primary = all.filter((item) => item.vendor === PRIMARY_VENDOR);
  return primary.length > 0 ? primary : all;
}

/**
 * 语种 → 厂商 → 音色。
 * 候选链：买家语种 →（英语口音）英语。每一级里豆包有就只用豆包，否则用其他已配置的厂商。
 * 全部没有时退回英语（fellBack = true）；英语也没有返回 null。
 * 同一画像种子 + 性别永远得到同一个音色；不同买家按散列均匀落到池里。
 */
export function selectVoice(options: {
  pool: VoicePool;
  persona: BuyerVoiceFacts;
  gender: VoiceGender;
  available: Set<string>;
}): VoiceSelection | null {
  const { pool, persona, gender, available } = options;
  const language = resolveVoiceLanguage(persona);
  const seed = `${personaVoiceSeed(persona)}|${gender}`;
  const chain = language.startsWith("en") && language !== "en" ? [language, "en"] : [language];
  for (const poolLanguage of chain) {
    const list = usableVoices(pool, poolLanguage, gender, available);
    if (list.length > 0) {
      return { voice: list[stableHash(seed) % list.length]!, poolLanguage, language, fellBack: false };
    }
  }
  if (language !== "en" && !language.startsWith("en")) {
    const list = usableVoices(pool, "en", gender, available);
    if (list.length > 0) {
      return { voice: list[stableHash(seed) % list.length]!, poolLanguage: "en", language, fellBack: true };
    }
  }
  return null;
}

export interface MissingVoice {
  language: string;
  label: string;
  gender: VoiceGender | "both";
  message: string;
}

/** 管理端提示：哪些语种缺音色（只看核心语种，口音缺了会自然退回英语） */
export function findMissingVoices(pool: VoicePool, available: Set<string>): MissingVoice[] {
  const out: MissingVoice[] = [];
  for (const item of POOL_LANGUAGES) {
    if (!item.core) continue;
    const female = usableVoices(pool, item.key, "female", available).length > 0;
    const male = usableVoices(pool, item.key, "male", available).length > 0;
    if (female && male) continue;
    const gender = !female && !male ? "both" : !female ? "female" : "male";
    const who = gender === "both" ? "" : gender === "female" ? "女声" : "男声";
    out.push({
      language: item.key,
      label: item.label,
      gender,
      message: `缺少 ${item.label} ${who}音色`.replace(/\s+/g, " ").trim() + "，该语种的买家会改用英语音色朗读",
    });
  }
  return out;
}
