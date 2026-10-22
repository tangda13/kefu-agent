/**
 * 百炼限流应对，按官方《限流应对最佳实践》（https://help.aliyun.com/zh/model-studio/rate-limiting-best-practices）：
 *  - RPM 可能按秒执行（RPS = RPM/60），同一瞬间扎堆就会 429 → 平滑限速器拉开请求间距，排队按到达顺序；
 *  - 不攒额度：空闲后来一批请求也是一个一个放，不会瞬间拉满（相当于令牌桶 initial_tokens=0）；
 *  - 只对 429、5xx 重试，指数退避 + 随机抖动，重试也要重新排队拿名额；
 *  - 收到 429 说明上游比我们算的更紧（同一主账号下别的程序也在用），整条队列暂停一会儿；
 *  - 重试用完或等不起了，抛给调用方。
 * 豆包按并发计（不是 RPM），用并发信号量 ConcurrencyLimiter；两家都忙时用 EitherQueue 排队，谁先空出来给谁。
 * 朗读怎么用它们（阿里云 1 秒内轮不到先转豆包、两家都忙才排队）见 fallback.ts。
 * 队列在进程内；只跑一个 api 实例时够用，多实例要换成 Redis 之类的集中计数。
 */

export interface LimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

export const systemClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/** 平滑限速器：相邻两次请求的发出时刻至少隔 intervalMs */
export class PacedLimiter {
  private nextFreeAt = 0;

  constructor(
    readonly intervalMs: number,
    private readonly clock: LimiterClock = systemClock,
  ) {}

  /**
   * 排一个发送名额：排到的时刻晚于 latestStart 就不排（不占名额）并返回 false，否则等到该时刻返回 true。
   * notBefore 用于重试退避：名额不早于这个时刻。
   */
  async acquire(latestStart: number, notBefore = 0): Promise<boolean> {
    const now = this.clock.now();
    const slot = Math.max(now, this.nextFreeAt, notBefore);
    if (slot > latestStart) return false;
    this.nextFreeAt = slot + this.intervalMs;
    if (slot > now) await this.clock.sleep(slot - now);
    return true;
  }

  /** 这一刻就有名额：占下返回 true；要等才轮得到返回 false，不占名额（EitherQueue 用，到点再来拿，不提前预订） */
  tryAcquireNow(): boolean {
    const now = this.clock.now();
    if (this.nextFreeAt > now) return false;
    this.nextFreeAt = now + this.intervalMs;
    return true;
  }

  /** 下一个名额最早什么时候空出来 */
  get nextFreeTime(): number {
    return this.nextFreeAt;
  }

  /** 整条队列暂停 ms（已排到更晚的不受影响） */
  pause(ms: number): void {
    this.nextFreeAt = Math.max(this.nextFreeAt, this.clock.now() + ms);
  }
}

export interface PacedCallOptions {
  limiter: PacedLimiter;
  /** 最晚什么时候还能发出（含重试），过了就不再排，交给调用方降级 */
  latestStart: number;
  /** 总共最多发几次（含第一次） */
  maxAttempts: number;
  /** 退避基数：第 n 次重试在 [0, baseDelayMs × 2^(n-1)) 里随机等 */
  baseDelayMs: number;
  /** 收到 429 时整条队列暂停多久 */
  throttlePauseMs: number;
  /** 错误分类：throttled（429）、server（5xx）可重试，其余直接抛 */
  classify(error: unknown): string;
  /** 第一次就排不上时抛的错误（调用方按限流处理） */
  queueFull(): Error;
  clock?: LimiterClock;
}

export async function pacedCall<T>(fn: () => Promise<T>, options: PacedCallOptions): Promise<T> {
  const clock = options.clock ?? systemClock;
  let notBefore = 0;
  let lastError: unknown;
  for (let attempt = 1; ; attempt += 1) {
    if (!(await options.limiter.acquire(options.latestStart, notBefore))) {
      throw lastError ?? options.queueFull();
    }
    try {
      return await fn();
    } catch (error) {
      const kind = options.classify(error);
      if ((kind !== "throttled" && kind !== "server") || attempt >= options.maxAttempts) throw error;
      if (kind === "throttled") options.limiter.pause(options.throttlePauseMs);
      // 指数退避 + 随机抖动，避免一批失败请求同时重发
      notBefore = clock.now() + clock.random() * options.baseDelayMs * 2 ** (attempt - 1);
      lastError = error;
    }
  }
}

/**
 * 并发信号量：同时在跑的不超过 capacity 个（豆包这类按并发计的厂商）。满了按到达顺序等，等不到就放弃。
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly releaseListeners: Array<() => void> = [];

  constructor(readonly capacity: number) {}

  get inFlight(): number {
    return this.active;
  }

  /** 现在就有空位（且没人在排）：占下返回释放函数，否则返回 null，不排队 */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.capacity || this.waiters.length > 0) return null;
    this.active += 1;
    return this.releaser();
  }

  /** 有名额归还时通知（先满足自己的排队者，再通知；EitherQueue 用它来派发） */
  onRelease(listener: () => void): void {
    this.releaseListeners.push(listener);
  }

  /** waitMs 内拿到名额返回释放函数（用完必须调用，重复调用无副作用），拿不到返回 null；waitMs 为 0 表示不等 */
  acquire(waitMs = 0): Promise<(() => void) | null> {
    if (this.active < this.capacity && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        this.active += 1;
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, waitMs);
      this.waiters.push(grant);
    });
  }

  /** 占着名额跑 fn，跑完（成功或失败）归还；等不到名额抛 busy() */
  async run<T>(fn: () => Promise<T>, waitMs: number, busy: () => Error): Promise<T> {
    const release = await this.acquire(waitMs);
    if (!release) throw busy();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
      for (const listener of this.releaseListeners) listener();
    };
  }
}

export type EitherGrant = { vendor: "aliyun" } | { vendor: "doubao"; release: () => void };

/**
 * 阿里云、豆包都忙时的公共排队：按到达顺序，谁先空出来就派给谁——豆包空出一个并发名额，或阿里云到了下一个发送时刻；
 * waitMs 内没轮到返回 null。阿里云不提前预订名额（预订了又被豆包抢先做完，那个名额就白白浪费）。
 * 2026-10-22 压测：原来只排阿里云、不等豆包，100 条朗读同一秒齐发失败 69 条；豆包每秒能腾出约 7 个名额，比阿里云快。
 */
export class EitherQueue {
  private readonly waiting: Array<{ grant: (result: EitherGrant | null) => void; deadline: number }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly aliyun: PacedLimiter,
    private readonly doubao: ConcurrencyLimiter,
    private readonly clock: LimiterClock = systemClock,
  ) {
    doubao.onRelease(() => this.pump());
  }

  get length(): number {
    return this.waiting.length;
  }

  wait(waitMs: number): Promise<EitherGrant | null> {
    return new Promise((resolve) => {
      this.waiting.push({ grant: resolve, deadline: this.clock.now() + waitMs });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.clock.now();
    // 等过期的先放弃（不管排在第几）
    for (let i = this.waiting.length - 1; i >= 0; i -= 1) {
      if (this.waiting[i]!.deadline <= now) this.waiting.splice(i, 1)[0]!.grant(null);
    }
    while (this.waiting.length) {
      const release = this.doubao.tryAcquire();
      if (release) {
        this.waiting.shift()!.grant({ vendor: "doubao", release });
        continue;
      }
      if (this.aliyun.tryAcquireNow()) {
        this.waiting.shift()!.grant({ vendor: "aliyun" });
        continue;
      }
      break;
    }
    if (!this.waiting.length) return;
    // 下次再看：阿里云下一个名额空出来，或最早的那个等过期（豆包归还名额会另外叫醒）
    const nextDeadline = Math.min(...this.waiting.map((item) => item.deadline));
    const at = Math.min(this.aliyun.nextFreeTime, nextDeadline);
    this.timer = setTimeout(() => this.pump(), Math.max(1, at - this.clock.now()));
  }
}
