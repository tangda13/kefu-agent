import { NATIONALITIES } from "@cecs/contracts";
import { nativeLanguageOf, stableHash } from "@cecs/domain";

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

/** 厂商优先级：阿里云主用，豆包备用（阿里云池里没有该语种 × 性别的音色才用豆包；阿里云出错时单次转豆包） */
export const VENDOR_PRIORITY = ["aliyun", "doubao"] as const;
export const BACKUP_VENDOR = "doubao";

/**
 * 推荐音色池（D-48，也是默认池）：按买家国籍配，海外人设音色放第一位（卡片上显示它）。
 * 阿里云千问3-TTS-Flash 每个音色都能说中英法德俄意西葡日韩；豆包 2.0 只有英语（美式 3 个、英式 Tina）
 * 和多语种 Vivi（英、日、西），作为备用。英式口音只有豆包 Tina；澳式、阿拉伯语两家都没有，留空，运行时退回英语。
 */
const aliyun = (ids: string[]): PoolVoice[] => ids.map((id) => ({ vendor: "aliyun", id }));
const doubao = (ids: string[]): PoolVoice[] => ids.map((id) => ({ vendor: "doubao", id }));

export function recommendedVoicePool(): VoicePool {
  const vivi = doubao(["zh_female_vv_uranus_bigtts"]);
  return {
    en: {
      female: [...aliyun(["Jennifer", "Cherry", "Serena", "Maia"]), ...doubao(["en_female_dacey_uranus_bigtts", "en_female_stokie_uranus_bigtts"])],
      male: [...aliyun(["Aiden", "Ethan", "Ryan", "Andre"]), ...doubao(["en_male_tim_uranus_bigtts"])],
    },
    "en-GB": { female: doubao(["zh_female_yingyujiaoxue_uranus_bigtts"]), male: [] },
    "en-AU": { female: [], male: [] },
    de: { female: aliyun(["Katerina", "Maia", "Cherry"]), male: aliyun(["Lenn", "Ethan", "Andre"]) },
    fr: { female: aliyun(["Serena", "Cherry", "Jennifer"]), male: aliyun(["Emilien", "Andre", "Ethan"]) },
    es: { female: [...aliyun(["Sonrisa", "Cherry", "Serena"]), ...vivi], male: aliyun(["Bodega", "Ethan", "Ryan"]) },
    it: { female: aliyun(["Cherry", "Maia"]), male: aliyun(["Dolce", "Ethan"]) },
    pt: { female: aliyun(["Cherry", "Serena"]), male: aliyun(["Andre", "Ethan"]) },
    ru: { female: aliyun(["Katerina", "Cherry"]), male: aliyun(["Alek", "Ethan"]) },
    ja: { female: [...aliyun(["Ono Anna", "Cherry"]), ...vivi], male: aliyun(["Kai", "Ethan"]) },
    ko: { female: aliyun(["Sohee", "Cherry"]), male: aliyun(["Ethan", "Kai"]) },
    ar: { female: [], male: [] },
  };
}

export const defaultVoicePool = recommendedVoicePool;

/**
 * 每个音色池语种对应哪些国家的买家（按随机买家的国籍算：国籍 → 母语 → 音色池语种）。
 * 没有国家的语种（俄、韩、阿拉伯）不会有买家，管理端收起、缺口不报。
 */
export function buyerCountriesByPool(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const nationality of NATIONALITIES) {
    const key = resolveVoiceLanguage({ language: nativeLanguageOf(nationality), nationality });
    (out[key] ??= []).push(nationality);
  }
  return out;
}

/** 音色 ID：字母数字和 _ . - ，中间可以有空格（阿里云有 Ono Anna、Radio Gol 这类） */
export const VOICE_ID_PATTERN = /^[A-Za-z0-9_.-](?:[A-Za-z0-9_. -]{0,78}[A-Za-z0-9_.-])?$/;

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
        if (!knownVendors.includes(vendor) || id.length < 2 || !VOICE_ID_PATTERN.test(id)) continue;
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
  /** 备用音色：主用是阿里云时，出错单次转豆包用（同语种同性别，同一买家固定同一个；豆包没有该语种则为英语音色，fellBack = true） */
  fallback: VoiceSelection | null;
}

/** 按厂商优先级取第一个“已配置且池里有音色”的厂商的全部音色；vendors 可限定厂商顺序 */
function usableVoices(
  pool: VoicePool,
  language: string,
  gender: VoiceGender,
  available: Set<string>,
  vendors: readonly string[] = VENDOR_PRIORITY,
): PoolVoice[] {
  const all = (pool[language]?.[gender] ?? []).filter((item) => available.has(item.vendor));
  for (const vendor of vendors) {
    const list = all.filter((item) => item.vendor === vendor);
    if (list.length > 0) return list;
  }
  return vendors === VENDOR_PRIORITY ? all : [];
}

function pickStable(list: PoolVoice[], seed: string): PoolVoice {
  return list[stableHash(seed) % list.length]!;
}

/** 备用（豆包）音色：同语种同性别；没有该语种时用豆包英语音色（fellBack = true）。种子与主音色相同，保证稳定 */
function selectBackup(
  pool: VoicePool, language: PoolLanguage, chain: string[], gender: VoiceGender, available: Set<string>, seed: string,
): VoiceSelection | null {
  if (!available.has(BACKUP_VENDOR)) return null;
  const only = [BACKUP_VENDOR];
  for (const poolLanguage of chain) {
    const list = usableVoices(pool, poolLanguage, gender, available, only);
    if (list.length > 0) return { voice: pickStable(list, seed), poolLanguage, language, fellBack: false, fallback: null };
  }
  const english = usableVoices(pool, "en", gender, available, only);
  if (english.length > 0) {
    return { voice: pickStable(english, seed), poolLanguage: "en", language, fellBack: !language.startsWith("en"), fallback: null };
  }
  return null;
}

/**
 * 语种 → 厂商 → 音色（阿里云主用、豆包备用）。
 * 候选链：买家语种 →（英语口音）英语。每一级里阿里云池有就用阿里云，没有再用豆包。
 * 全部没有时退回英语（fellBack = true，两家都不会说该语种，直接用豆包英语）；英语也没有返回 null。
 * 主用是阿里云时附带 fallback（豆包备用音色）。
 * 同一画像种子 + 性别永远得到同一个主音色和同一个备用音色；不同买家按散列均匀落到池里。
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
      const voice = pickStable(list, seed);
      const fallback = voice.vendor === "aliyun" ? selectBackup(pool, language, chain, gender, available, seed) : null;
      return { voice, poolLanguage, language, fellBack: false, fallback };
    }
  }
  if (!language.startsWith("en")) {
    const list = usableVoices(pool, "en", gender, available, [BACKUP_VENDOR, "aliyun"]);
    if (list.length > 0) return { voice: pickStable(list, seed), poolLanguage: "en", language, fellBack: true, fallback: null };
  }
  return null;
}

export interface MissingVoice {
  language: string;
  label: string;
  gender: VoiceGender | "both";
  message: string;
}

/** 管理端提示：哪些语种缺音色（只看会有买家的核心语种；口音缺了会自然退回英语） */
export function findMissingVoices(pool: VoicePool, available: Set<string>): MissingVoice[] {
  const out: MissingVoice[] = [];
  const buyers = buyerCountriesByPool();
  for (const item of POOL_LANGUAGES) {
    if (!item.core || !buyers[item.key]) continue;
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
