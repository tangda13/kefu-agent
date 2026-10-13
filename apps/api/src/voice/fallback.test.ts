import { describe, expect, it } from "vitest";
import { AliyunTtsError, classifyAliyunFailure, parseAliyunTtsResponse } from "./aliyun";
import { synthesizeWithFallback, VoiceSynthesisError, type SynthFn } from "./fallback";
import { defaultVoicePool, selectVoice, type VoiceSelection } from "./pool";

const both = new Set(["doubao", "aliyun"]);
const pool = defaultVoicePool();
const buyer = (language: string, name = "Hans", nationality?: string) => ({ language, name, sourceTemplateId: "P-001", nationality });
const audio = Buffer.from("fake-audio");

/** 假 provider：aliyun 按给定行为，doubao 总是成功；记录调用顺序 */
function fakeSynth(aliyunBehavior: () => Promise<unknown>, doubaoBehavior?: () => Promise<unknown>) {
  const calls: string[] = [];
  const synth: SynthFn = async (selection) => {
    calls.push(`${selection.voice.vendor}:${selection.voice.id}`);
    if (selection.voice.vendor === "aliyun") await aliyunBehavior();
    else if (doubaoBehavior) await doubaoBehavior();
    return { audio, elapsedMs: 5 };
  };
  return { synth, calls };
}

const german = () => selectVoice({ pool, persona: buyer("de-DE"), gender: "male", available: both })!;
const ok = async () => undefined;
const fail = (error: unknown) => async () => { throw error; };

describe("朗读故障转移：阿里云主用", () => {
  it("主用成功：只请求阿里云，不转移", async () => {
    const { synth, calls } = fakeSynth(ok);
    const selection = german();
    const result = await synthesizeWithFallback(selection, "Hallo", synth);
    expect(result).toMatchObject({ vendor: "aliyun", voiceId: selection.voice.id, fallback: false });
    expect(result.fallbackReason).toBeUndefined();
    expect(calls).toEqual([`aliyun:${selection.voice.id}`]);
  });

  it.each([
    ["HTTP 429", () => { try { parseAliyunTtsResponse(429, { code: "Throttling.RateQuota", message: "x" }); } catch (e) { return e; } }, "throttled"],
    ["429 无错误码", () => new AliyunTtsError("x", "throttled", 429), "throttled"],
    ["200 返回体里的 Throttling.AllocationQuota", () => { try { parseAliyunTtsResponse(200, { code: "Throttling.AllocationQuota", message: "x" }); } catch (e) { return e; } }, "throttled"],
    ["LimitRequests 错误码", () => { try { parseAliyunTtsResponse(400, { code: "LimitRequests", message: "x" }); } catch (e) { return e; } }, "throttled"],
    ["HTTP 500", () => { try { parseAliyunTtsResponse(500, { code: "InternalError", message: "x" }); } catch (e) { return e; } }, "server"],
    ["HTTP 503 无 body", () => { try { parseAliyunTtsResponse(503, null); } catch (e) { return e; } }, "server"],
    ["超时", () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "timeout"],
    ["网络错误", () => new TypeError("fetch failed"), "network"],
    ["欠费", () => { try { parseAliyunTtsResponse(400, { code: "Arrearage", message: "x" }); } catch (e) { return e; } }, "quota"],
  ])("%s → 这一次改用豆包", async (_name, makeError, reason) => {
    const { synth, calls } = fakeSynth(fail(makeError()));
    const selection = german();
    const logs: string[] = [];
    const result = await synthesizeWithFallback(selection, "Hallo", synth, (message) => logs.push(message));
    expect(result).toMatchObject({ vendor: "doubao", voiceId: selection.fallback!.voice.id, fallback: true, fallbackReason: reason });
    expect(calls).toEqual([`aliyun:${selection.voice.id}`, `doubao:${selection.fallback!.voice.id}`]);
    expect(logs).toHaveLength(1);
  });

  it("401 / 403 转豆包并标记 auth（管理端据此提示密钥无效）", async () => {
    for (const status of [401, 403]) {
      let error: unknown;
      try { parseAliyunTtsResponse(status, { code: "InvalidApiKey", message: "bad key" }); } catch (e) { error = e; }
      expect(classifyAliyunFailure(error)).toBe("auth");
      const { synth } = fakeSynth(fail(error));
      const result = await synthesizeWithFallback(german(), "Hallo", synth);
      expect(result).toMatchObject({ vendor: "doubao", fallback: true, fallbackReason: "auth" });
    }
  });

  it("其他 4xx（如参数错误）不转移，直接失败", async () => {
    const error = (() => { try { parseAliyunTtsResponse(400, { code: "InvalidParameter", message: "x" }); } catch (e) { return e; } })();
    const { synth, calls } = fakeSynth(fail(error));
    await expect(synthesizeWithFallback(german(), "Hallo", synth)).rejects.toBeInstanceOf(VoiceSynthesisError);
    expect(calls).toHaveLength(1);
  });

  it("豆包也没有该语种：用豆包英语音色朗读，并在日志里标明", async () => {
    const { synth, calls } = fakeSynth(fail(new AliyunTtsError("x", "throttled", 429)));
    const selection = german();
    expect(selection.fallback!.fellBack).toBe(true);
    const metas: Array<Record<string, unknown>> = [];
    await synthesizeWithFallback(selection, "Hallo", synth, (_m, meta) => metas.push(meta));
    expect(calls[1]).toBe("doubao:en_male_tim_uranus_bigtts");
    expect(metas[0]).toMatchObject({ backupFellBackToEnglish: true, language: "de" });
  });

  it("豆包也失败：抛出带原因的错误，原因仍记为阿里云的失败类型", async () => {
    const { synth } = fakeSynth(fail(new AliyunTtsError("x", "auth", 401)), fail(new Error("doubao down")));
    const error = await synthesizeWithFallback(german(), "Hallo", synth).catch((e) => e);
    expect(error).toBeInstanceOf(VoiceSynthesisError);
    expect(error).toMatchObject({ vendor: "doubao", fallbackReason: "auth" });
  });

  it("没有备用音色（没配豆包）：不转移，直接失败", async () => {
    const selection = selectVoice({ pool, persona: buyer("de-DE"), gender: "male", available: new Set(["aliyun"]) })!;
    const { synth, calls } = fakeSynth(fail(new AliyunTtsError("x", "throttled", 429)));
    await expect(synthesizeWithFallback(selection, "Hallo", synth)).rejects.toBeInstanceOf(VoiceSynthesisError);
    expect(calls).toHaveLength(1);
  });

  it("主用就是豆包时出错不转移", async () => {
    const selection: VoiceSelection = selectVoice({ pool, persona: buyer("en-US", "Emma", "英国"), gender: "female", available: both })!;
    expect(selection.voice.vendor).toBe("doubao");
    const { synth, calls } = fakeSynth(ok, fail(new Error("x")));
    await expect(synthesizeWithFallback(selection, "Hi", synth)).rejects.toBeInstanceOf(VoiceSynthesisError);
    expect(calls).toHaveLength(1);
  });

  it("同一买家转移到的备用音色每次都一样", async () => {
    const results = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const selection = selectVoice({ pool, persona: buyer("en-US", "Claire"), gender: "female", available: both })!;
      const { synth } = fakeSynth(fail(new AliyunTtsError("x", "throttled", 429)));
      results.add((await synthesizeWithFallback(selection, "Hi", synth)).voiceId);
    }
    expect(results.size).toBe(1);
  });
});

describe("canSpeak：阿里云或豆包任一能说就算能说", () => {
  const can = (available: string[], language: string, gender: "male" | "female", custom = pool) => {
    const selection = selectVoice({ pool: custom, persona: buyer(language), gender, available: new Set(available) });
    return Boolean(selection && !selection.fellBack);
  };
  it("只有阿里云能说（德语）", () => {
    expect(can(["aliyun"], "de-DE", "female")).toBe(true);
    expect(can(["doubao"], "de-DE", "female")).toBe(false);
  });
  it("只有豆包能说（自定义池里日语只配了豆包）", () => {
    const custom = { ...pool, ja: { female: [{ vendor: "doubao", id: "zh_female_vv_uranus_bigtts" }], male: [] } };
    expect(can(["doubao", "aliyun"], "ja-JP", "female", custom)).toBe(true);
    expect(can(["doubao"], "ja-JP", "female", custom)).toBe(true);
    expect(can(["aliyun"], "ja-JP", "female", custom)).toBe(false);
  });
  it("两家都不能说（阿拉伯语）或都没配置", () => {
    expect(can(["doubao", "aliyun"], "ar-SA", "male")).toBe(false);
    expect(can([], "de-DE", "female")).toBe(false);
  });
});
