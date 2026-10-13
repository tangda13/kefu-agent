import { describe, expect, it } from "vitest";
import { NATIONALITIES } from "@cecs/contracts";
import { composePersonaWithRule, englishLanguageOf, isEnglish, languageNameOf, nativeLanguageOf, personaTemplates } from "./index";

describe("国籍 → 母语（D-43）", () => {
  it("全部国籍取值都有映射", () => {
    const expected: Record<string, string> = {
      美国: "en-US", 英国: "en-GB", 加拿大: "en-CA", 澳大利亚: "en-AU", 德国: "de-DE",
      法国: "fr-FR", 西班牙: "es-ES", 意大利: "it-IT", 日本: "ja-JP", 巴西: "pt-BR",
    };
    for (const nationality of NATIONALITIES) expect(nativeLanguageOf(nationality)).toBe(expected[nationality]);
  });

  it("英语国家给对应英语变体，其余国家的英语退路是美式或其国家变体", () => {
    expect(englishLanguageOf("英国")).toBe("en-GB");
    expect(englishLanguageOf("澳大利亚")).toBe("en-AU");
    expect(englishLanguageOf("德国")).toBe("en-US");
    expect(englishLanguageOf("未知")).toBe("en-US");
    expect(isEnglish("en-NZ")).toBe(true);
    expect(isEnglish("de-DE")).toBe(false);
  });

  it("语言英文名用于提示词", () => {
    expect(languageNameOf("de-DE")).toBe("German");
    expect(languageNameOf("ja-JP")).toBe("Japanese");
    expect(languageNameOf("en-GB")).toBe("English");
  });

  it("画像按国籍说母语；任务规则指定语言时尊重规则", () => {
    const de = composePersonaWithRule(personaTemplates, { nationalityPool: ["德国"] });
    expect(de.language).toBe("de-DE");
    const forced = composePersonaWithRule(personaTemplates, { nationalityPool: ["德国"], languages: ["fr-FR"] });
    expect(forced.language).toBe("fr-FR");
  });
});
