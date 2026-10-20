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

/** 逐轮扫描：waits = 每一轮买家第一条消息到客服第一条回复的秒数；pendingSince = 最后还没回的那一轮从何时开始等 */
function scanWaits(messages: TimedMessage[]): { waits: number[]; pendingSince: number | null } {
  const sorted = messages.filter((m) => m.sender === "buyer" || m.sender === "student").sort((a, b) => timeOf(a.at) - timeOf(b.at));
  const waits: number[] = [];
  let pendingSince: number | null = null;
  for (const message of sorted) {
    if (message.sender === "buyer") {
      if (pendingSince == null) pendingSince = timeOf(message.at);
    } else if (pendingSince != null) {
      waits.push(Math.max(0, (timeOf(message.at) - pendingSince) / 1000));
      pendingSince = null;
    }
  }
  return { waits, pendingSince };
}

/** 每一轮的等待秒数（买家连发、催促不重置计时）；没回复的轮次不算 */
export function replyWaits(messages: TimedMessage[]): number[] {
  return scanWaits(messages).waits;
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
