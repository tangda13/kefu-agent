/**
 * 百炼限流应对，按官方《限流应对最佳实践》（https://help.aliyun.com/zh/model-studio/rate-limiting-best-practices）：
 *  - RPM 可能按秒执行（RPS = RPM/60），同一瞬间扎堆就会 429 → 平滑限速器拉开请求间距，排队按到达顺序；
 *  - 不攒额度：空闲后来一批请求也是一个一个放，不会瞬间拉满（相当于令牌桶 initial_tokens=0）；
 *  - 只对 429、5xx 重试，指数退避 + 随机抖动，重试也要重新排队拿名额；
 *  - 收到 429 说明上游比我们算的更紧（同一主账号下别的程序也在用），整条队列暂停一会儿；
 *  - 重试用完或等不起了，抛给调用方。
 * 豆包按并发计（不是 RPM），用文件末尾的并发信号量 ConcurrencyLimiter。
 * 朗读怎么用它们（阿里云 1 秒内轮不到先转豆包、两家都不行才排队）见 fallback.ts。
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

  constructor(readonly capacity: number) {}

  get inFlight(): number {
    return this.active;
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
    };
  }
}
