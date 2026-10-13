import { describe, expect, it } from "vitest";
import { buildAliyunTtsRequest, parseAliyunTtsResponse, aliyunLanguageType } from "./aliyun";
import { defaultVoicePool, findMissingVoices, normalizeVoicePool, resolveVoiceLanguage, selectVoice } from "./pool";

const both = new Set(["doubao", "aliyun"]);
const doubaoOnly = new Set(["doubao"]);
const pool = defaultVoicePool();

describe("音色池：语种判定", () => {
  it("英语用英语音色，国籍给口音，其他语种按语种", () => {
    expect(resolveVoiceLanguage({ language: "en-US", nationality: "德国" })).toBe("en");
    expect(resolveVoiceLanguage({ language: "en-US", nationality: "英国" })).toBe("en-GB");
    expect(resolveVoiceLanguage({ language: "en-US", nationality: "澳大利亚" })).toBe("en-AU");
    expect(resolveVoiceLanguage({ language: "en-GB" })).toBe("en-GB");
    expect(resolveVoiceLanguage({ language: "de-DE" })).toBe("de");
    expect(resolveVoiceLanguage({ language: "es-ES", nationality: "西班牙" })).toBe("es");
    expect(resolveVoiceLanguage({ language: "xx-YY" })).toBe("en");
    expect(resolveVoiceLanguage({})).toBe("en");
  });
});

describe("音色池：语种 → 厂商 → 音色", () => {
  const buyer = (language: string, name = "Anna", nationality?: string) => ({ language, name, sourceTemplateId: "P-001", nationality });

  it("豆包有的语种用豆包，没有的用阿里云", () => {
    expect(selectVoice({ pool, persona: buyer("en-US"), gender: "female", available: both })!.voice.vendor).toBe("doubao");
    expect(selectVoice({ pool, persona: buyer("ja-JP"), gender: "female", available: both })!.voice.vendor).toBe("doubao");
    expect(selectVoice({ pool, persona: buyer("ja-JP"), gender: "male", available: both })!.voice.vendor).toBe("aliyun");
    expect(selectVoice({ pool, persona: buyer("de-DE"), gender: "female", available: both })!.voice.vendor).toBe("aliyun");
    expect(selectVoice({ pool, persona: buyer("ko-KR"), gender: "male", available: both })!.voice.vendor).toBe("aliyun");
  });

  it("英式口音优先；没有对应口音音色时退到英语", () => {
    const gb = selectVoice({ pool, persona: buyer("en-US", "Emma", "英国"), gender: "female", available: both })!;
    expect(gb.poolLanguage).toBe("en-GB");
    expect(gb.voice.id).toBe("zh_female_yingyujiaoxue_uranus_bigtts");
    const gbMale = selectVoice({ pool, persona: buyer("en-US", "Tom", "英国"), gender: "male", available: both })!;
    expect(gbMale.poolLanguage).toBe("en");
    expect(gbMale.fellBack).toBe(false);
    const au = selectVoice({ pool, persona: buyer("en-US", "Kate", "澳大利亚"), gender: "female", available: both })!;
    expect(au.poolLanguage).toBe("en");
  });

  it("阿里云未配置：德语等退回豆包英语且标记 fellBack；阿拉伯语同样", () => {
    const de = selectVoice({ pool, persona: buyer("de-DE"), gender: "female", available: doubaoOnly })!;
    expect(de.voice.vendor).toBe("doubao");
    expect(de.poolLanguage).toBe("en");
    expect(de.fellBack).toBe(true);
    const ar = selectVoice({ pool, persona: buyer("ar-SA"), gender: "male", available: both })!;
    expect(ar.fellBack).toBe(true);
    expect(ar.voice.id).toBe("en_male_tim_uranus_bigtts");
  });

  it("什么都没配置返回 null", () => {
    expect(selectVoice({ pool, persona: buyer("en-US"), gender: "female", available: new Set() })).toBeNull();
  });

  it("同一买家永远同一个声音，不同买家分散到池里", () => {
    const pick = (name: string) => selectVoice({ pool, persona: buyer("fr-FR", name), gender: "female", available: both })!.voice.id;
    expect(pick("Claire")).toBe(pick("Claire"));
    const used = new Set(Array.from({ length: 40 }, (_, index) => pick(`Buyer ${index}`)));
    expect(used.size).toBe(4);
  });

  it("缺口提示：阿里云未配置时德语缺；配置后只剩阿拉伯语", () => {
    const missingNoAliyun = findMissingVoices(pool, doubaoOnly);
    expect(missingNoAliyun.some((item) => item.language === "de" && item.gender === "both")).toBe(true);
    expect(missingNoAliyun.some((item) => item.language === "es" && item.gender === "male")).toBe(true);
    expect(findMissingVoices(pool, both).map((item) => item.language)).toEqual(["ar"]);
  });

  it("音色池校验丢弃非法厂商和 ID，去重", () => {
    const cleaned = normalizeVoicePool(
      { de: { female: [{ vendor: "aliyun", id: "Cherry" }, { vendor: "aliyun", id: "Cherry" }, { vendor: "nope", id: "x1" }, { vendor: "aliyun", id: "bad id" }], male: "x" } },
      ["doubao", "aliyun"],
    );
    expect(cleaned.de).toEqual({ female: [{ vendor: "aliyun", id: "Cherry" }], male: [] });
    expect(cleaned.en).toEqual({ female: [], male: [] });
  });
});

describe("阿里云千问3-TTS 请求构造", () => {
  const config = { apiKey: "sk-test", baseUrl: "https://dashscope.aliyuncs.com/api/v1/", model: "qwen3-tts-flash" };

  it("端点、鉴权头、请求体、语种映射", () => {
    const request = buildAliyunTtsRequest(config, "Guten Tag", "Cherry", "de");
    expect(request.url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    expect(request.headers.authorization).toBe("Bearer sk-test");
    expect(request.body).toEqual({ model: "qwen3-tts-flash", input: { text: "Guten Tag", voice: "Cherry", language_type: "German" } });
    expect(aliyunLanguageType("en-GB")).toBe("English");
    expect(aliyunLanguageType(undefined)).toBe("Auto");
    expect(aliyunLanguageType("ar")).toBe("Auto");
  });

  it("文本截到 600 字符", () => {
    expect(buildAliyunTtsRequest(config, "a".repeat(900), "Ethan", "en").body.input.text).toHaveLength(600);
  });

  it("响应解析：url / base64 / 错误", () => {
    expect(parseAliyunTtsResponse(200, { output: { audio: { url: "https://x/a.wav" } } })).toEqual({ url: "https://x/a.wav" });
    expect(parseAliyunTtsResponse(200, { output: { audio: { data: "AAAA" } } })).toEqual({ data: "AAAA" });
    expect(() => parseAliyunTtsResponse(401, { code: "InvalidApiKey", message: "bad key" })).toThrow(/ALIYUN_TTS_401_InvalidApiKey/);
    expect(() => parseAliyunTtsResponse(200, { output: {} })).toThrow(/EMPTY_AUDIO/);
  });
});
