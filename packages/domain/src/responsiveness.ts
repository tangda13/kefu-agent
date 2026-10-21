/**
 * 消息响应时效（D-46）：由系统按消息时间计算，不交给评分模型。纯函数，无数据库。
 * 每一轮 = 买家发言（可能连发几条）到客服第一条回复；计时从这一轮买家的第一条消息算起，
 * 买家的催促消息不重置计时。首次响应按 2 倍权重计。
 */

export interface TimedMessage {
  sender: string;
  at: string | Date;
}

export interface ResponsivenessResult {
  /** 0–100；没有可计的轮次时为 null */
  score: number | null;
  firstReplySec: number | null;
  avgReplySec: number | null;
  /** 超过 2 分钟才回复的轮次（买家耐心机制约从这时开始催促） */
  slowReplies: number;
  /** 买家等不到回复离开 */
  leftWaiting: boolean;
  turns: number;
}

/** 等待秒数 → 单轮得分：45 秒内满分，2 分钟起明显扣分，10 分钟以上 0 分 */
const CURVE: Array<[number, number]> = [
  [0, 100],
  [45, 100],
  [90, 85],
  [180, 60],
  [360, 30],
  [600, 0],
];

export const SLOW_REPLY_SEC = 120;
/** 会话结束时还有买家消息没回、且已等了这么久，才算“没回就结束了” */
const UNANSWERED_MIN_SEC = 60;
/** 买家因等待离开时，这一项最高分 */
const LEFT_WAITING_CAP = 40;

export function replyTurnScore(seconds: number): number {
  if (seconds <= CURVE[0]![0]) return CURVE[0]![1];
  for (let i = 1; i < CURVE.length; i += 1) {
    const [x1, y1] = CURVE[i]!;
    const [x0, y0] = CURVE[i - 1]!;
    if (seconds <= x1) return y0 + ((y1 - y0) * (seconds - x0)) / (x1 - x0);
  }
  return 0;
}

const timeOf = (value: string | Date) => new Date(value).getTime();

export interface ReplyRound {
  /** 这一轮买家第一条消息的时间（毫秒） */
  startedAt: number;
  /** 等了多少秒才回；到最后也没回为 null */
  waitSec: number | null;
}

/** 逐轮扫描：每一轮 = 买家第一条消息到客服第一条回复；最后还没回的那一轮 waitSec 为 null */
export function replyRounds(messages: TimedMessage[]): ReplyRound[] {
  const sorted = messages.filter((m) => m.sender === "buyer" || m.sender === "student").sort((a, b) => timeOf(a.at) - timeOf(b.at));
  const rounds: ReplyRound[] = [];
  let pendingSince: number | null = null;
  for (const message of sorted) {
    if (message.sender === "buyer") {
      if (pendingSince == null) pendingSince = timeOf(message.at);
    } else if (pendingSince != null) {
      rounds.push({ startedAt: pendingSince, waitSec: Math.max(0, (timeOf(message.at) - pendingSince) / 1000) });
      pendingSince = null;
    }
  }
  if (pendingSince != null) rounds.push({ startedAt: pendingSince, waitSec: null });
  return rounds;
}

function scanWaits(messages: TimedMessage[]): { waits: number[]; pendingSince: number | null } {
  const rounds = replyRounds(messages);
  const last = rounds[rounds.length - 1];
  return {
    waits: rounds.filter((round) => round.waitSec != null).map((round) => round.waitSec!),
    pendingSince: last && last.waitSec == null ? last.startedAt : null,
  };
}

/** 每一轮的等待秒数（买家连发、催促不重置计时）；没回复的轮次不算 */
export function replyWaits(messages: TimedMessage[]): number[] {
  return scanWaits(messages).waits;
}

/** 接待指标里单轮等待按 10 分钟封顶：买家等这么久早已离开（D-53） */
export const RESPONSE_CAP_SEC = 600;
/** 3 分钟回复率的门槛（D-61，同飞鸽“3 分钟人工回复率”） */
export const REPLY_WITHIN_SEC = 180;

export interface ReplySummary {
  /** 回了的轮次等待秒数之和（单轮封顶 10 分钟）；平均响应 = waitSum / replied */
  waitSum: number;
  replied: number;
  /** 3 分钟回复率 = within / counted */
  within: number;
  counted: number;
}

export const EMPTY_REPLY_SUMMARY: ReplySummary = { waitSum: 0, replied: 0, within: 0, counted: 0 };

/**
 * 平均响应与 3 分钟回复率（D-61）：工作台顶栏、我的记录、复盘“本次接待”都用这一个函数，总数和单次对得上。
 * endAt：最后没回的那一轮等到什么时候为止（会话结束时间；还在接待用现在）。等满 3 分钟算没达标，不满 3 分钟会话就结束的不计入。
 */
export function summarizeReplies(rounds: ReplyRound[], endAt: number): ReplySummary {
  const summary = { ...EMPTY_REPLY_SUMMARY };
  for (const round of rounds) {
    if (round.waitSec != null) {
      summary.waitSum += Math.min(round.waitSec, RESPONSE_CAP_SEC);
      summary.replied += 1;
      summary.counted += 1;
      if (round.waitSec <= REPLY_WITHIN_SEC) summary.within += 1;
    } else if ((endAt - round.startedAt) / 1000 >= REPLY_WITHIN_SEC) {
      summary.counted += 1;
    }
  }
  return summary;
}

export function addReplySummaries(a: ReplySummary, b: ReplySummary): ReplySummary {
  return { waitSum: a.waitSum + b.waitSum, replied: a.replied + b.replied, within: a.within + b.within, counted: a.counted + b.counted };
}

export function averageReplySec(summary: ReplySummary): number | null {
  return summary.replied ? Math.round(summary.waitSum / summary.replied) : null;
}

export function replyWithinRate(summary: ReplySummary): number | null {
  return summary.counted ? Math.round((summary.within / summary.counted) * 100) : null;
}

export function computeResponsiveness(
  messages: TimedMessage[],
  closing?: { closedAt?: string | Date | null; closedReason?: string | null },
): ResponsivenessResult {
  const { waits, pendingSince } = scanWaits(messages);
  let leftWaiting = false;
  if (pendingSince != null && closing?.closedAt) {
    const waited = (timeOf(closing.closedAt) - pendingSince) / 1000;
    if (waited >= UNANSWERED_MIN_SEC) {
      waits.push(waited);
      leftWaiting = closing.closedReason === "buyer_left";
    }
  }
  if (!waits.length) return { score: null, firstReplySec: null, avgReplySec: null, slowReplies: 0, leftWaiting: false, turns: 0 };

  let weighted = 0;
  let weightSum = 0;
  waits.forEach((seconds, index) => {
    const weight = index === 0 ? 2 : 1;
    weighted += replyTurnScore(seconds) * weight;
    weightSum += weight;
  });
  let score = Math.round(weighted / weightSum);
  if (leftWaiting) score = Math.min(score, LEFT_WAITING_CAP);
  return {
    score,
    firstReplySec: Math.round(waits[0]!),
    avgReplySec: Math.round(waits.reduce((sum, value) => sum + value, 0) / waits.length),
    slowReplies: waits.filter((value) => value > SLOW_REPLY_SEC).length,
    leftWaiting,
    turns: waits.length,
  };
}
