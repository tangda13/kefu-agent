import { describe, expect, it } from "vitest";
import { buildAliyunTtsRequest, parseAliyunTtsResponse, aliyunLanguageType } from "./aliyun";
import { buyerCountriesByPool, defaultVoicePool, findMissingVoices, normalizeVoicePool, recommendedVoicePool, resolveVoiceLanguage, selectVoice } from "./pool";

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

  it("主用选择：阿里云池里有就用阿里云，没有的语种 / 性别才用豆包", () => {
    expect(selectVoice({ pool, persona: buyer("en-US"), gender: "female", available: both })!.voice.vendor).toBe("aliyun");
    expect(selectVoice({ pool, persona: buyer("en-US"), gender: "male", available: both })!.voice.vendor).toBe("aliyun");
    expect(selectVoice({ pool, persona: buyer("ja-JP"), gender: "female", available: both })!.voice.vendor).toBe("aliyun");
    expect(selectVoice({ pool, persona: buyer("ja-JP"), gender: "male", available: both })!.voice.vendor).toBe("aliyun");
    // 阿里云池里没有该语种：只有豆包有（自定义池）
    const doubaoOnlyPool = { ...pool, ja: { female: [{ vendor: "doubao", id: "zh_female_vv_uranus_bigtts" }], male: [] } };
    expect(selectVoice({ pool: doubaoOnlyPool, persona: buyer("ja-JP"), gender: "female", available: both })!.voice.vendor).toBe("doubao");
    // 阿里云未配置：豆包有的语种仍用豆包
    expect(selectVoice({ pool, persona: buyer("en-US"), gender: "female", available: doubaoOnly })!.voice.vendor).toBe("doubao");
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
    expect(ar.fallback).toBeNull();
  });

  it("什么都没配置返回 null", () => {
    expect(selectVoice({ pool, persona: buyer("en-US"), gender: "female", available: new Set() })).toBeNull();
  });

  it("同一买家永远同一个声音，不同买家分散到池里", () => {
    const pick = (name: string) => selectVoice({ pool, persona: buyer("fr-FR", name), gender: "female", available: both })!.voice.id;
    expect(pick("Claire")).toBe(pick("Claire"));
    const used = new Set(Array.from({ length: 40 }, (_, index) => pick(`Buyer ${index}`)));
    expect(used.size).toBe(3);
  });

  it("备用音色：同语种同性别的豆包音色，同一买家固定；豆包没有该语种时用英语音色", () => {
    const ja = selectVoice({ pool, persona: buyer("ja-JP", "Yui"), gender: "female", available: both })!;
    expect(ja.voice.vendor).toBe("aliyun");
    expect(ja.fallback).toMatchObject({ voice: { vendor: "doubao", id: "zh_female_vv_uranus_bigtts" }, poolLanguage: "ja", fellBack: false });
    const de = selectVoice({ pool, persona: buyer("de-DE", "Hans"), gender: "male", available: both })!;
    expect(de.fallback).toMatchObject({ voice: { vendor: "doubao", id: "en_male_tim_uranus_bigtts" }, poolLanguage: "en", fellBack: true });
    // 豆包英语女声有两个以上：同一买家每次都是同一个备用音色，不同买家分散
    const backup = (name: string) => selectVoice({ pool, persona: buyer("en-US", name), gender: "female", available: both })!.fallback!.voice.id;
    expect(backup("Claire")).toBe(backup("Claire"));
    expect(new Set(Array.from({ length: 40 }, (_, index) => backup(`Buyer ${index}`))).size).toBe(2);
    // 备用音色与主音色用同一个种子，重复选择结果完全一致
    expect(selectVoice({ pool, persona: buyer("de-DE", "Hans"), gender: "male", available: both })).toEqual(de);
  });

  it("没配豆包就没有备用；主用是豆包也没有备用", () => {
    expect(selectVoice({ pool, persona: buyer("de-DE"), gender: "female", available: new Set(["aliyun"]) })!.fallback).toBeNull();
    expect(selectVoice({ pool, persona: buyer("en-US", "Emma", "英国"), gender: "female", available: both })!.fallback).toBeNull();
  });

  it("缺口提示：阿里云未配置时德语缺；配置后没有缺口（俄、韩、阿没有买家，不报）", () => {
    const missingNoAliyun = findMissingVoices(pool, doubaoOnly);
    expect(missingNoAliyun.some((item) => item.language === "de" && item.gender === "both")).toBe(true);
    expect(missingNoAliyun.some((item) => item.language === "es" && item.gender === "male")).toBe(true);
    expect(missingNoAliyun.some((item) => ["ru", "ko", "ar"].includes(item.language))).toBe(false);
    expect(findMissingVoices(pool, both)).toEqual([]);
  });

  it("每个语种对应哪些国家的买家：按国籍 → 母语算", () => {
    const countries = buyerCountriesByPool();
    expect(countries.en).toEqual(["美国", "加拿大"]);
    expect(countries["en-GB"]).toEqual(["英国"]);
    expect(countries.de).toEqual(["德国"]);
    expect(countries.pt).toEqual(["巴西"]);
    expect(countries.ru).toBeUndefined();
    expect(countries.ar).toBeUndefined();
  });

  it("推荐池：海外人设音色排第一位", () => {
    const recommended = recommendedVoicePool();
    expect(recommended.de!.male[0]).toEqual({ vendor: "aliyun", id: "Lenn" });
    expect(recommended.es!.female[0]).toEqual({ vendor: "aliyun", id: "Sonrisa" });
    expect(recommended.ja!.female[0]).toEqual({ vendor: "aliyun", id: "Ono Anna" });
  });

  it("音色池校验丢弃非法厂商和 ID，去重；ID 中间允许空格（Ono Anna）", () => {
    const cleaned = normalizeVoicePool(
      {
        de: {
          female: [
            { vendor: "aliyun", id: "Cherry" }, { vendor: "aliyun", id: "Cherry" }, { vendor: "nope", id: "x1" },
            { vendor: "aliyun", id: "bad/id" }, { vendor: "aliyun", id: "Ono Anna" }, { vendor: "aliyun", id: " x" },
          ],
          male: "x",
        },
      },
      ["doubao", "aliyun"],
    );
    expect(cleaned.de).toEqual({ female: [{ vendor: "aliyun", id: "Cherry" }, { vendor: "aliyun", id: "Ono Anna" }], male: [] });
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
