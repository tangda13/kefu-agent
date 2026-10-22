import { afterEach, describe, expect, it, vi } from "vitest";
import { AliyunTtsError, classifyAliyunFailure, parseAliyunTtsResponse } from "./aliyun";
import { ConcurrencyLimiter, PacedLimiter, pacedCall, type LimiterClock } from "./rate-limit";

/** 假时钟：sleep 不真等；advance 为 true 时 sleep 会推进时间（单条流程用），false 时只记录（并发排队用） */
function fakeClock(advance: boolean, random = 0.5) {
  const sleeps: number[] = [];
  const clock: LimiterClock & { t: number; sleeps: number[] } = {
    t: 0,
    sleeps,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (advance) clock.t += ms;
    },
    random: () => random,
  };
  return clock;
}

const throttled = () => {
  try { parseAliyunTtsResponse(429, { code: "Throttling.RateQuota", message: "x" }); } catch (e) { return e; }
};
const options = (limiter: PacedLimiter, clock: LimiterClock, latestStart = 2_000) => ({
  limiter,
  latestStart,
  maxAttempts: 3,
  baseDelayMs: 300,
  throttlePauseMs: 1_000,
  classify: classifyAliyunFailure,
  queueFull: () => new AliyunTtsError("ALIYUN_TTS_QUEUE_FULL", "throttled", undefined, "LocalQueueFull"),
  clock,
});

describe("平滑限速器", () => {
  it("同一瞬间 4 个请求：按到达顺序每隔一个间隔放一个，不扎堆", async () => {
    const clock = fakeClock(false);
    const limiter = new PacedLimiter(371, clock);
    const results = await Promise.all([0, 1, 2, 3].map(() => limiter.acquire(10_000)));
    expect(results).toEqual([true, true, true, true]);
    expect(clock.sleeps).toEqual([371, 742, 1113]);
  });

  it("排到的时刻超过最晚发出时间：不排、不占名额，后面的人照样按原位置排", async () => {
    const clock = fakeClock(false);
    const limiter = new PacedLimiter(371, clock);
    expect(await limiter.acquire(1_000)).toBe(true); // 0
    expect(await limiter.acquire(1_000)).toBe(true); // 371
    expect(await limiter.acquire(1_000)).toBe(true); // 742
    expect(await limiter.acquire(1_000)).toBe(false); // 1113 > 1000
    expect(await limiter.acquire(5_000)).toBe(true); // 仍是 1113
    expect(clock.sleeps).toEqual([371, 742, 1113]);
  });

  it("空闲之后不攒额度：隔很久再来一批，照样一个一个放", async () => {
    const clock = fakeClock(false);
    const limiter = new PacedLimiter(371, clock);
    await limiter.acquire(Infinity);
    clock.t = 60_000;
    await Promise.all([0, 1, 2].map(() => limiter.acquire(Infinity)));
    expect(clock.sleeps).toEqual([371, 742]);
  });

  it("暂停：整条队列往后推", async () => {
    const clock = fakeClock(false);
    const limiter = new PacedLimiter(371, clock);
    limiter.pause(1_000);
    await limiter.acquire(Infinity);
    expect(clock.sleeps).toEqual([1_000]);
  });
});

describe("排队调用 + 退避重试", () => {
  it("429 后暂停队列、重新排队再发，第二次成功", async () => {
    const clock = fakeClock(true);
    const limiter = new PacedLimiter(371, clock);
    const sentAt: number[] = [];
    const result = await pacedCall(async () => {
      sentAt.push(clock.t);
      if (sentAt.length === 1) throw throttled();
      return "ok";
    }, options(limiter, clock));
    expect(result).toBe("ok");
    // 第一次 0ms 发出；429 后队列暂停 1 秒，退避 150ms 被暂停覆盖，第二次 1000ms 发出
    expect(sentAt).toEqual([0, 1_000]);
  });

  it("5xx 也重试，退避按指数增长并带抖动", async () => {
    const clock = fakeClock(true, 1);
    const limiter = new PacedLimiter(10, clock);
    const sentAt: number[] = [];
    await expect(pacedCall(async () => {
      sentAt.push(clock.t);
      throw new AliyunTtsError("x", "server", 500);
    }, options(limiter, clock))).rejects.toMatchObject({ kind: "server" });
    // 3 次：0；退避 300 → 300；退避 600 → 900
    expect(sentAt).toEqual([0, 300, 900]);
  });

  it("参数错误、欠费、鉴权、超时不重试，直接抛给调用方", async () => {
    for (const error of [
      new AliyunTtsError("x", "other", 400),
      new AliyunTtsError("x", "quota", 400),
      new AliyunTtsError("x", "auth", 401),
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    ]) {
      const clock = fakeClock(true);
      let calls = 0;
      await expect(pacedCall(async () => { calls += 1; throw error; }, options(new PacedLimiter(371, clock), clock))).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  it("重试名额排到最晚发出时间之后：不再重试，抛上游的 429（按限流转豆包）", async () => {
    const clock = fakeClock(true);
    const limiter = new PacedLimiter(371, clock);
    let calls = 0;
    const error = throttled();
    await expect(pacedCall(async () => { calls += 1; throw error; }, options(limiter, clock, 500))).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it("第一次就排不上：抛本地排队超时，分类为限流", async () => {
    const clock = fakeClock(false);
    const limiter = new PacedLimiter(371, clock);
    limiter.pause(5_000);
    let calls = 0;
    const failure = await pacedCall(async () => { calls += 1; return "ok"; }, options(limiter, clock)).catch((e) => e);
    expect(calls).toBe(0);
    expect(classifyAliyunFailure(failure)).toBe("throttled");
    expect((failure as AliyunTtsError).code).toBe("LocalQueueFull");
  });
});

describe("并发信号量", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("满了不等就返回 null；有人归还后按到达顺序给等着的人", async () => {
    const slots = new ConcurrencyLimiter(2);
    const a = (await slots.acquire())!;
    await slots.acquire();
    expect(await slots.acquire(0)).toBeNull();
    const order: string[] = [];
    const first = slots.acquire(1_000).then((release) => { order.push("first"); return release; });
    const second = slots.acquire(1_000).then((release) => { order.push("second"); return release; });
    a();
    (await first)!();
    await second;
    expect(order).toEqual(["first", "second"]);
    expect(slots.inFlight).toBe(2);
  });

  it("等超时返回 null，之后有人归还也不会再给它", async () => {
    vi.useFakeTimers();
    const slots = new ConcurrencyLimiter(1);
    const held = (await slots.acquire())!;
    const waiting = slots.acquire(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiting).toBeNull();
    held();
    expect(slots.inFlight).toBe(0);
  });

  it("归还重复调用无副作用；run 出错也归还", async () => {
    const slots = new ConcurrencyLimiter(1);
    const release = (await slots.acquire())!;
    release();
    release();
    expect(slots.inFlight).toBe(0);
    await expect(slots.run(async () => { throw new Error("boom"); }, 0, () => new Error("busy"))).rejects.toThrow("boom");
    expect(slots.inFlight).toBe(0);
    const hold = (await slots.acquire())!;
    await expect(slots.run(async () => "x", 0, () => new Error("busy"))).rejects.toThrow("busy");
    hold();
  });
});
