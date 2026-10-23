import type { ReceptionEndReason, ReceptionStats } from "@cecs/contracts";
import {
  EMPTY_REPLY_SUMMARY,
  addReplySummaries,
  averageReplySec,
  buyerComplaints,
  computeResponsiveness,
  replyRounds,
  summarizeReplies,
  type BuyerLedger,
  type ReplySummary,
  type TimedMessage,
} from "@cecs/domain";
import type { Db } from "./db";

/**
 * 接待指标（D-61）：复盘“本次接待”、我的记录“平均响应时长 / 3 分钟回复率”、工作台顶栏共用这一处取数，
 * 平均响应和 3 分钟回复率都走 domain 的 summarizeReplies，总数和单次对得上。
 */

interface ConversationTiming {
  id: string;
  status: string;
  channel: string;
  created_at: Date;
  closed_at: Date | null;
  closed_reason: string | null;
  service_rating: number | null;
  tool_followup: { endedAt?: string } | null;
  /** 买家的两本账（D-90）：默默离开的接待时长、复盘标注用 */
  buyer_ledger?: BuyerLedger | null;
}

export interface ReceptionTiming {
  conversation: ConversationTiming;
  messages: Array<TimedMessage & { at: Date; id: string }>;
}

/** 最后没回的那一轮等到什么时候为止：还在接待（含工具跟进中）用现在；已结束用结束时间，跟进结束得更晚就用跟进结束时间 */
export function waitingEndAt(conversation: ConversationTiming, now = Date.now()): number {
  if (conversation.status === "active") return now;
  const closed = conversation.closed_at ? conversation.closed_at.getTime() : now;
  const followUpEnded = conversation.tool_followup?.endedAt ? new Date(conversation.tool_followup.endedAt).getTime() : 0;
  return Math.max(closed, followUpEnded);
}

/** 按会话取结束信息和买家、客服的消息时间（教师指导不算） */
export async function loadReceptionTimings(db: Db, conversationIds: string[]): Promise<Map<string, ReceptionTiming>> {
  const map = new Map<string, ReceptionTiming>();
  if (!conversationIds.length) return map;
  const [conversations, messages] = await Promise.all([
    db.query(
      `select id, status, channel, created_at, closed_at, closed_reason, service_rating, tool_followup, buyer_ledger
       from conversations where id = any($1::uuid[])`,
      [conversationIds],
    ),
    db.query(
      `select id, conversation_id, sender, created_at from conversation_messages
       where conversation_id = any($1::uuid[]) and sender in ('buyer', 'student')
       order by conversation_id, created_at, id`,
      [conversationIds],
    ),
  ]);
  for (const row of conversations.rows as ConversationTiming[]) map.set(row.id, { conversation: row, messages: [] });
  for (const row of messages.rows) {
    map.get(row.conversation_id as string)?.messages.push({ id: row.id as string, sender: row.sender as string, at: row.created_at as Date });
  }
  return map;
}

/** 一次接待的平均响应、3 分钟回复率分子分母；sinceMs 只算这之后开始的轮次（工作台顶栏只看今天） */
export function replySummaryOf(timing: ReceptionTiming, sinceMs?: number, now = Date.now()): ReplySummary {
  const rounds = replyRounds(timing.messages).filter((round) => sinceMs == null || round.startedAt >= sinceMs);
  return summarizeReplies(rounds, waitingEndAt(timing.conversation, now));
}

export function sumReplySummaries(timings: Iterable<ReceptionTiming>, sinceMs?: number, now = Date.now()): ReplySummary {
  let total = { ...EMPTY_REPLY_SUMMARY };
  for (const timing of timings) total = addReplySummaries(total, replySummaryOf(timing, sinceMs, now));
  return total;
}

function endReasonOf(timing: ReceptionTiming): ReceptionEndReason | null {
  const { conversation } = timing;
  const reason = conversation.closed_reason;
  if (!reason) return null;
  if (reason === "buyer_left") {
    // 只看接待结束前的消息：结束后用工具卡片跟进的那几条不影响“买家等太久离开”的判断
    const closedAt = conversation.closed_at?.getTime() ?? Date.now();
    const before = timing.messages.filter((message) => message.at.getTime() <= closedAt);
    return computeResponsiveness(before, { closedAt: conversation.closed_at, closedReason: reason }).leftWaiting ? "left_waiting" : "buyer_left";
  }
  return (["student_ended", "timeout", "abandoned", "task_closed"] as const).find((item) => item === reason) ?? null;
}

/**
 * 后台巡检关闭的会话（限时到、长时间没消息、任务结束）关闭时间可能晚很多，接待时长按结束前最后一条消息算；
 * 买家默默离开的（D-90）也是巡检过 2 分钟才关，同样按最后一条消息算
 */
const SWEPT_REASONS = ["timeout", "abandoned", "task_closed"];

function receptionEndAt(timing: ReceptionTiming): number | null {
  const { conversation } = timing;
  if (!conversation.closed_at) return null;
  const closedAt = conversation.closed_at.getTime();
  const swept = SWEPT_REASONS.includes(conversation.closed_reason ?? "") || (conversation.closed_reason === "buyer_left" && Boolean(conversation.buyer_ledger?.exit?.silent));
  if (!swept) return closedAt;
  const last = timing.messages.filter((message) => message.at.getTime() <= closedAt).at(-1);
  return last ? last.at.getTime() : closedAt;
}

/** 复盘“本次接待”；邮件不算接待，不出这一项 */
export function receptionStatsOf(timing: ReceptionTiming, now = Date.now()): ReceptionStats | null {
  const { conversation } = timing;
  if (conversation.channel !== "chat") return null;
  const summary = replySummaryOf(timing, undefined, now);
  const endAt = receptionEndAt(timing);
  const complaints = buyerComplaints(
    conversation.buyer_ledger,
    timing.messages.filter((message) => message.sender === "student").map((message) => ({ id: message.id, at: message.at.getTime() })),
  );
  return {
    rating: conversation.service_rating == null ? null : Number(conversation.service_rating),
    avgReplySec: averageReplySec(summary),
    replyWithin: { within: summary.within, counted: summary.counted },
    rounds: timing.messages.filter((message) => message.sender === "student").length,
    durationSec: endAt != null ? Math.max(0, Math.round((endAt - conversation.created_at.getTime()) / 1000)) : null,
    endReason: endReasonOf(timing),
    // 没有要标的（老记录、没让买家不满）就不带这个字段
    ...(complaints.length ? { complaints } : {}),
  };
}

export async function loadReceptionStats(db: Db, conversationIds: string[]): Promise<Map<string, ReceptionStats | null>> {
  const timings = await loadReceptionTimings(db, conversationIds);
  const now = Date.now();
  return new Map([...timings].map(([id, timing]) => [id, receptionStatsOf(timing, now)]));
}
