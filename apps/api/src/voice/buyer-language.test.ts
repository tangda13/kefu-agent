import { describe, expect, it } from "vitest";
import { resolveBuyerLanguage } from "./buyer-language";
import { defaultVoicePool, selectVoice, type VoiceGender } from "./pool";

/** 用真实选择逻辑造一个只配置了指定厂商的“语音服务” */
const voiceWith = (vendors: string[]) => ({
  async canSpeak(language: string, gender: VoiceGender, nationality?: string) {
    const selection = selectVoice({ pool: defaultVoicePool(), persona: { language, nationality, gender, name: "x" }, gender, available: new Set(vendors) });
    return Boolean(selection && !selection.fellBack);
  },
});

describe("买家语言（D-43）", () => {
  const german = { language: "de-DE", nationality: "德国", gender: "female" as const };

  it("语音整体未配置 → 德国买家改用英语", async () => {
    expect(await resolveBuyerLanguage(voiceWith([]), german)).toBe("en-US");
  });
  it("只配豆包：德语没有音色 → 英语；西语、日语女声有 → 母语", async () => {
    const doubao = voiceWith(["doubao"]);
    expect(await resolveBuyerLanguage(doubao, german)).toBe("en-US");
    expect(await resolveBuyerLanguage(doubao, { language: "es-ES", nationality: "西班牙", gender: "female" })).toBe("es-ES");
    expect(await resolveBuyerLanguage(doubao, { language: "ja-JP", nationality: "日本", gender: "female" })).toBe("ja-JP");
    expect(await resolveBuyerLanguage(doubao, { language: "ja-JP", nationality: "日本", gender: "male" })).toBe("en-US");
    expect(await resolveBuyerLanguage(doubao, { language: "pt-BR", nationality: "巴西", gender: "female" })).toBe("en-US");
  });
  it("配了阿里云 → 德语男女都用母语", async () => {
    const both = voiceWith(["doubao", "aliyun"]);
    expect(await resolveBuyerLanguage(both, german)).toBe("de-DE");
    expect(await resolveBuyerLanguage(both, { ...german, gender: "male" })).toBe("de-DE");
  });
  it("英语国家照常英语，口音保留；老师指定语言时不改", async () => {
    expect(await resolveBuyerLanguage(voiceWith([]), { language: "en-GB", nationality: "英国", gender: "male" })).toBe("en-GB");
    expect(await resolveBuyerLanguage(voiceWith([]), { language: "fr-FR", nationality: "美国", gender: "male" }, true)).toBe("fr-FR");
  });
});
