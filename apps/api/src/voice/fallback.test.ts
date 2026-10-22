import { afterEach, describe, expect, it, vi } from "vitest";
import { AliyunTtsError, AliyunTtsGate, classifyAliyunFailure, parseAliyunTtsResponse } from "./aliyun";
import { synthesizeWithFallback, VoiceSynthesisError, type SynthFn } from "./fallback";
import { defaultVoicePool, selectVoice, type VoiceSelection } from "./pool";
import { ConcurrencyLimiter, EitherQueue, PacedLimiter, type LimiterClock } from "./rate-limit";

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

describe("限流：阿里云 1 秒内轮不到先转豆包，两家都不行才排队", () => {
  /** 假时钟：sleep 直接推进时间 */
  function gateWithClock() {
    const clock: LimiterClock & { t: number; sleeps: number[] } = {
      t: 0,
      sleeps: [],
      now: () => clock.t,
      sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; },
      random: () => 0.5,
    };
    return { clock, gate: new AliyunTtsGate(new PacedLimiter(371, clock), clock) };
  }
  const aliyunOnly = () => selectVoice({ pool, persona: buyer("de-DE"), gender: "male", available: new Set(["aliyun"]) })!;

  it("1 秒内轮得到：等一下，仍用阿里云", async () => {
    const { clock, gate } = gateWithClock();
    expect(await gate.acquireWithin(0)).toBe(true); // 前面刚有人用了这一刻的名额
    const { synth, calls } = fakeSynth(ok);
    const selection = german();
    const result = await synthesizeWithFallback(selection, "Hallo", synth, undefined, { aliyun: gate });
    expect(result).toMatchObject({ vendor: "aliyun", fallback: false });
    expect(calls).toEqual([`aliyun:${selection.voice.id}`]);
    expect(clock.sleeps).toEqual([371]);
  });

  it("要等超过 1 秒：不发阿里云，直接豆包，原因记 busy，不记出错日志", async () => {
    const { clock, gate } = gateWithClock();
    gate.limiter.pause(1_500);
    const { synth, calls } = fakeSynth(ok);
    const selection = german();
    const logs: string[] = [];
    const result = await synthesizeWithFallback(selection, "Hallo", synth, (message) => logs.push(message), { aliyun: gate });
    expect(result).toMatchObject({ vendor: "doubao", fallback: true, fallbackReason: "busy" });
    expect(calls).toEqual([`doubao:${selection.fallback!.voice.id}`]);
    expect(clock.sleeps).toEqual([]);
    expect(logs).toHaveLength(0);
  });

  it("阿里云返回 429：这一次转豆包，并把阿里云队列暂停 1 秒", async () => {
    const { clock, gate } = gateWithClock();
    const { synth } = fakeSynth(fail(new AliyunTtsError("x", "throttled", 429)));
    const result = await synthesizeWithFallback(german(), "Hallo", synth, undefined, { aliyun: gate });
    expect(result).toMatchObject({ vendor: "doubao", fallbackReason: "throttled" });
    clock.t = 500;
    expect(await gate.acquireWithin(0)).toBe(false);
    clock.t = 1_000;
    expect(await gate.acquireWithin(0)).toBe(true);
  });

  it("阿里云忙、豆包也失败：排队等到阿里云的名额，用主音色朗读", async () => {
    const { clock, gate } = gateWithClock();
    gate.limiter.pause(1_500);
    const { synth, calls } = fakeSynth(ok, fail(new Error("doubao 429")));
    const selection = german();
    const logs: string[] = [];
    const result = await synthesizeWithFallback(selection, "Hallo", synth, (message) => logs.push(message), { aliyun: gate });
    expect(result).toMatchObject({ vendor: "aliyun", voiceId: selection.voice.id, fallback: false, queued: true });
    expect(calls).toEqual([`doubao:${selection.fallback!.voice.id}`, `aliyun:${selection.voice.id}`]);
    expect(clock.sleeps).toEqual([1_500]);
    expect(logs).toEqual(["aliyun busy and no backup available, queueing for aliyun"]);
  });

  it("没配豆包、阿里云忙：直接排队", async () => {
    const { gate } = gateWithClock();
    gate.limiter.pause(1_500);
    const { synth, calls } = fakeSynth(ok);
    const result = await synthesizeWithFallback(aliyunOnly(), "Hallo", synth, undefined, { aliyun: gate });
    expect(result).toMatchObject({ vendor: "aliyun", queued: true });
    expect(calls).toHaveLength(1);
  });

  it("阿里云鉴权失败、豆包也失败：排队没用，直接报失败", async () => {
    const { gate } = gateWithClock();
    const { synth, calls } = fakeSynth(fail(new AliyunTtsError("x", "auth", 401)), fail(new Error("doubao down")));
    const error = await synthesizeWithFallback(german(), "Hallo", synth, undefined, { aliyun: gate }).catch((e) => e);
    expect(error).toMatchObject({ vendor: "doubao", fallbackReason: "auth" });
    expect(calls).toHaveLength(2);
  });

  it("豆包出错、阿里云 15 秒内也排不到：报失败，原因记 busy", async () => {
    const { gate } = gateWithClock();
    gate.limiter.pause(20_000);
    const { synth, calls } = fakeSynth(ok, fail(new Error("doubao 429")));
    const error = await synthesizeWithFallback(german(), "Hallo", synth, undefined, { aliyun: gate }).catch((e) => e);
    expect(error).toBeInstanceOf(VoiceSynthesisError);
    expect(error).toMatchObject({ vendor: "aliyun", fallbackReason: "busy" });
    expect(calls).toHaveLength(1);
  });
});

describe("豆包并发计数：占着名额才发", () => {
  afterEach(() => { vi.useRealTimers(); });
  const fullSlots = async () => {
    const slots = new ConcurrencyLimiter(1);
    const release = (await slots.acquire())!;
    return { slots, release };
  };
  const briton = () => selectVoice({ pool, persona: buyer("en-GB", "Emma", "英国"), gender: "female", available: both })!;
  const busyAliyun = () => {
    const clock: LimiterClock = { now: () => 0, sleep: async () => undefined, random: () => 0.5 };
    const gate = new AliyunTtsGate(new PacedLimiter(371, clock), clock);
    gate.limiter.pause(1_500);
    return gate;
  };

  it("阿里云忙、豆包也满：不等豆包，直接排队等阿里云", async () => {
    const { slots } = await fullSlots();
    const { synth, calls } = fakeSynth(ok);
    const selection = german();
    const result = await synthesizeWithFallback(selection, "Hallo", synth, undefined, { aliyun: busyAliyun(), doubao: slots });
    expect(result).toMatchObject({ vendor: "aliyun", queued: true });
    expect(calls).toEqual([`aliyun:${selection.voice.id}`]);
  });

  it("主用豆包（英式女声）、豆包满：等空位，空出来就用", async () => {
    const { slots, release } = await fullSlots();
    const { synth, calls } = fakeSynth(ok);
    const selection = briton();
    expect(selection.voice.vendor).toBe("doubao");
    const pending = synthesizeWithFallback(selection, "Hi", synth, undefined, { doubao: slots });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    release();
    await expect(pending).resolves.toMatchObject({ vendor: "doubao", fallback: false });
    expect(slots.inFlight).toBe(0);
  });

  it("主用豆包、3 秒内都没空位：报失败", async () => {
    vi.useFakeTimers();
    const { slots } = await fullSlots();
    const { synth, calls } = fakeSynth(ok);
    const pending = synthesizeWithFallback(briton(), "Hi", synth, undefined, { doubao: slots }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await pending;
    expect(error).toBeInstanceOf(VoiceSynthesisError);
    expect(String(error.message)).toMatch(/DOUBAO_TTS_BUSY/);
    expect(calls).toHaveLength(0);
  });

  it("阿里云欠费（排队没用）、豆包满：等豆包空位", async () => {
    const { slots, release } = await fullSlots();
    const { synth } = fakeSynth(fail(new AliyunTtsError("x", "quota", 400)));
    const pending = synthesizeWithFallback(german(), "Hallo", synth, undefined, { doubao: slots });
    setTimeout(release, 10);
    await expect(pending).resolves.toMatchObject({ vendor: "doubao", fallbackReason: "quota" });
  });

  it("合成成功或失败都归还名额", async () => {
    const slots = new ConcurrencyLimiter(1);
    await synthesizeWithFallback(briton(), "Hi", fakeSynth(ok).synth, undefined, { doubao: slots });
    expect(slots.inFlight).toBe(0);
    await synthesizeWithFallback(briton(), "Hi", fakeSynth(ok, fail(new Error("x"))).synth, undefined, { doubao: slots }).catch(() => undefined);
    expect(slots.inFlight).toBe(0);
  });
});

describe("两家都忙：进公共队列，谁先空出来用谁（2026-10-22 压测后）", () => {
  afterEach(() => { vi.useRealTimers(); });
  const busyBoth = (aliyunPauseMs: number) => {
    vi.useFakeTimers();
    const gate = new AliyunTtsGate();
    gate.limiter.pause(aliyunPauseMs);
    const slots = new ConcurrencyLimiter(1);
    const hold = slots.tryAcquire()!;
    return { gate, slots, hold, either: new EitherQueue(gate.limiter, slots) };
  };

  it("豆包先空出来：用豆包，原因记 busy，用完归还名额", async () => {
    const { gate, slots, hold, either } = busyBoth(2_000);
    const { synth, calls } = fakeSynth(ok);
    const selection = german();
    const pending = synthesizeWithFallback(selection, "Hallo", synth, undefined, { aliyun: gate, doubao: slots, either });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(calls).toHaveLength(0);
    hold();
    await expect(pending).resolves.toMatchObject({ vendor: "doubao", fallback: true, fallbackReason: "busy" });
    expect(calls).toEqual([`doubao:${selection.fallback!.voice.id}`]);
    expect(slots.inFlight).toBe(0);
  });

  it("阿里云先到下一个发送时刻：用阿里云主音色", async () => {
    const { gate, slots, either } = busyBoth(2_000);
    const { synth, calls } = fakeSynth(ok);
    const selection = german();
    const pending = synthesizeWithFallback(selection, "Hallo", synth, undefined, { aliyun: gate, doubao: slots, either });
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(pending).resolves.toMatchObject({ vendor: "aliyun", fallback: false, queued: true });
    expect(calls).toEqual([`aliyun:${selection.voice.id}`]);
  });

  it("15 秒内两家都没空出来：报失败，不发任何请求", async () => {
    const { gate, slots, either } = busyBoth(60_000);
    const { synth, calls } = fakeSynth(ok);
    const pending = synthesizeWithFallback(german(), "Hallo", synth, undefined, { aliyun: gate, doubao: slots, either }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_100);
    const error = await pending;
    expect(error).toBeInstanceOf(VoiceSynthesisError);
    expect(String(error.message)).toMatch(/VOICE_QUEUE_FULL/);
    expect(calls).toHaveLength(0);
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
