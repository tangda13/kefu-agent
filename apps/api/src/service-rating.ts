import { ledgerOutcome, starsForOutcome, starsFromSatisfaction, summarizeRatings, SATISFIED_STARS, type BuyerLedger, type RatingSummary } from "@cecs/domain";
import type { Db } from "./db";
import type { SessionState } from "./director";

/**
 * 服务评价（D-54）：接待结束时买家给服务打 1–5 星，存在会话上（不是一条消息，买家历史、评分、催促都不受影响）。
 * 按结束时的满意度换算，再按买家走的原因限定区间（D-90：失望离开最多 2 星、事情都办成至少 4 星）；
 * 买家一句话都没说过的、邮件会话、工具跟进结束时都不打。
 * 每个结束的出口（买家离开、学生结束、超时、无人发言、任务结束）都调用，重复调用不会改已有的星级。
 */
export async function rateService(db: Db, conversationId: string): Promise<number | null> {
  const result = await db.query(
    `select c.state, c.service_rating, c.channel, c.tool_followup, c.buyer_ledger,
            exists (select 1 from conversation_messages m where m.conversation_id = c.id and m.sender = 'buyer') as has_buyer
     from conversations c where c.id = $1 and c.status = 'closed'`,
    [conversationId],
  );
  const row = result.rows[0];
  if (!row || row.service_rating != null || row.channel !== "chat" || row.tool_followup || !row.has_buyer) return null;
  const state = (row.state ?? {}) as SessionState;
  const stars = starsForOutcome(
    starsFromSatisfaction(typeof state.satisfaction === "number" ? state.satisfaction : 60),
    ledgerOutcome(row.buyer_ledger as BuyerLedger | null),
  );
  const updated = await db.query(
    "update conversations set service_rating = $2 where id = $1 and service_rating is null returning id",
    [conversationId, stars],
  );
  return updated.rowCount ? stars : null;
}

/** 满意率口径（D-54）：4 星和 5 星占有星级的接待的比例。where 是额外的会话筛选条件（别名 c） */
export async function ratingSummary(db: Db, studentId: string, extraWhere = "", params: unknown[] = []): Promise<RatingSummary> {
  const result = await db.query(
    `select c.service_rating as stars from conversations c
     where c.student_id = $1 and c.service_rating is not null ${extraWhere}`,
    [studentId, ...params],
  );
  return summarizeRatings(result.rows.map((row) => Number(row.stars)));
}

export { SATISFIED_STARS };
