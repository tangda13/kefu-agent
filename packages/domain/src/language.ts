/**
 * 国籍 → 买家母语（D-43）。买家用其国籍的母语打字和朗读；
 * 朗读做不到该语种时由 API 层改用 englishLanguageOf（国家口音英语）。
 * 纯函数，不依赖语音配置。
 */

/** 英语母语国家 → 对应英语变体 */
const ENGLISH_VARIANT: Record<string, string> = {
  美国: "en-US",
  英国: "en-GB",
  加拿大: "en-CA",
  澳大利亚: "en-AU",
  新西兰: "en-NZ",
  爱尔兰: "en-IE",
  新加坡: "en-SG",
  南非: "en-ZA",
};

const NATIVE: Record<string, string> = {
  ...ENGLISH_VARIANT,
  德国: "de-DE",
  奥地利: "de-AT",
  瑞士: "de-CH",
  法国: "fr-FR",
  比利时: "fr-BE",
  西班牙: "es-ES",
  墨西哥: "es-MX",
  阿根廷: "es-AR",
  智利: "es-CL",
  哥伦比亚: "es-CO",
  意大利: "it-IT",
  葡萄牙: "pt-PT",
  巴西: "pt-BR",
  荷兰: "nl-NL",
  波兰: "pl-PL",
  俄罗斯: "ru-RU",
  乌克兰: "uk-UA",
  土耳其: "tr-TR",
  瑞典: "sv-SE",
  挪威: "nb-NO",
  丹麦: "da-DK",
  芬兰: "fi-FI",
  捷克: "cs-CZ",
  希腊: "el-GR",
  日本: "ja-JP",
  韩国: "ko-KR",
  泰国: "th-TH",
  越南: "vi-VN",
  印度尼西亚: "id-ID",
  沙特阿拉伯: "ar-SA",
  阿联酋: "ar-AE",
  埃及: "ar-EG",
  以色列: "he-IL",
  印度: "en-IN",
  菲律宾: "en-PH",
};

/** 国籍的母语代码（如 de-DE）；不认识的国籍按美式英语 */
export function nativeLanguageOf(nationality: string | undefined | null): string {
  return NATIVE[String(nationality ?? "")] ?? "en-US";
}

/** 国籍对应的英语变体（en-GB / en-AU …），非英语国家用 en-US */
export function englishLanguageOf(nationality: string | undefined | null): string {
  const native = nativeLanguageOf(nationality);
  return native.startsWith("en-") ? native : (ENGLISH_VARIANT[String(nationality ?? "")] ?? "en-US");
}

/** 语言代码是否为英语 */
export function isEnglish(language: string | undefined | null): boolean {
  return String(language ?? "").toLowerCase().split(/[-_]/)[0] === "en";
}

const LANGUAGE_NAMES_EN: Record<string, string> = {
  en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish",
  ru: "Russian", uk: "Ukrainian", tr: "Turkish", sv: "Swedish", nb: "Norwegian", da: "Danish", fi: "Finnish", cs: "Czech",
  el: "Greek", ja: "Japanese", ko: "Korean", th: "Thai", vi: "Vietnamese", id: "Indonesian", ar: "Arabic", he: "Hebrew",
};

/** 语言代码 → 英文名（写进提示词用），如 de-DE → German；不认识的原样返回 */
export function languageNameOf(language: string | undefined | null): string {
  const code = String(language ?? "en-US");
  return LANGUAGE_NAMES_EN[code.toLowerCase().split(/[-_]/)[0] ?? ""] ?? code;
}
