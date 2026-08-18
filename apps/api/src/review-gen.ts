import { NEGATIVE_REVIEW_POOL, POSITIVE_REVIEW_POOL } from "@cecs/domain";
import type { Db } from "./db";
import type { ConversationProvider } from "./conversation-provider";
import type { SessionState } from "./director";

/** 满意度(0-100) → 星级 */
function ratingFromSatisfaction(satisfaction: number): number {
  if (satisfaction >= 85) return 5;
  if (satisfaction >= 70) return 4;
  if (satisfaction >= 45) return 3;
  if (satisfaction >= 25) return 2;
  return 1;
}

function fallbackContent(rating: number): string {
  const pool = rating >= 4 ? POSITIVE_REVIEW_POOL : NEGATIVE_REVIEW_POOL;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

interface LogLike {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * 闭环评价：会话结束后，AI 买家根据本次服务结果对主订单留下/修改评价。
 * - 主订单无评价且已送达/已完成 → 按最终满意度定星级，LLM 结合对话记忆生成评价内容；
 * - 主订单已有中差评（≤3星）且服务挽回成功（满意度≥70）→ 买家修改评价（升星 + 新内容，保留原评价）；
 * - 其余情况不动。fire-and-forget 调用，失败仅记日志。
 */
export async function generateBuyerReview(
  db: Db,
  provider: ConversationProvider,
  conversationId: string,
  log: LogLike,
): Promise<void> {
  if (provider.providerId === "unconfigured") return;
  const result = await db.query(
    `select o.id as order_id, o.payload, o.order_no, c.persona, c.state
     from conversations c
     join orders o on o.conversation_id = c.id and o.is_primary
     where c.id = $1 and c.status = 'closed'`,
    [conversationId],
  );
  const row = result.rows[0];
  if (!row) {
    log.info(`review-gen skip: conversation ${conversationId} has no primary order`);
    return;
  }
  const persona = row.persona as Record<string, unknown>;
  const state = (row.state ?? {}) as SessionState;
  const order = row.payload as Record<string, unknown>;
  const existing = order.review as { rating?: number; content?: string; at?: string } | null;
  const satisfaction = typeof state.satisfaction === "number" ? state.satisfaction : 60;

  let mode: "create" | "revise";
  if (existing && typeof existing.rating === "number") {
    if (existing.rating <= 3 && satisfaction >= 70) {
      mode = "revise";
    } else {
      log.info(`review-gen skip: order ${row.order_no} already reviewed (rating=${existing.rating}, satisfaction=${satisfaction})`);
      return;
    }
  } else {
    if (order.status !== "delivered" && order.status !== "completed") {
      log.info(`review-gen skip: order ${row.order_no} status=${order.status} not reviewable`);
      return;
    }
    mode = "create";
  }

  const rating = mode === "revise"
    ? Math.max(ratingFromSatisfaction(satisfaction), (existing?.rating ?? 1) + 2)
    : ratingFromSatisfaction(satisfaction);
  const cappedRating = Math.min(5, rating);

  const system =
    `You are ${persona.name ?? "a buyer"}, a cross-border e-commerce buyer from ${persona.nationality ?? "abroad"}. ` +
    `You just finished a customer service conversation about your order (product: ${order.productName}). ` +
    `Final satisfaction with the service: ${satisfaction}/100. ` +
    (mode === "revise"
      ? `You previously left a ${existing?.rating}-star review: "${existing?.content}". The support agent resolved your issue, so you are UPDATING your review to ${cappedRating} stars. Mention that the seller followed up and resolved the problem.`
      : `Now you are leaving a ${cappedRating}-star review for this order, reflecting both the product and the service experience.`) +
    ` Key facts from the conversation: ${state.memory ?? "(none)"}. ` +
    `Write the review in English, 1-3 natural sentences, first person, no absolute marketing phrases. ` +
    'Return ONLY JSON: {"content":"..."}.';

  let content = "";
  try {
    const raw = await provider.complete(system, "Write the review now.");
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { content?: string };
      if (parsed.content?.trim()) content = parsed.content.trim().slice(0, 600);
    }
    if (!content && raw.trim().length >= 15 && !raw.trim().startsWith("{")) {
      content = raw.trim().slice(0, 600);
    }
  } catch (error) {
    log.warn(`review-gen llm failed for ${row.order_no}: ${(error as Error).message}`);
  }
  if (!content) content = fallbackContent(cappedRating);

  const review =
    mode === "revise"
      ? {
          rating: cappedRating,
          content,
          at: new Date().toISOString(),
          revised: true,
          original: { rating: existing?.rating, content: existing?.content, at: existing?.at },
        }
      : { rating: cappedRating, content, at: new Date().toISOString() };

  await db.query(
    `update orders set payload = payload || $1::jsonb where id = $2`,
    [JSON.stringify({ review }), row.order_id],
  );
  log.info(`review-gen ${mode}: order ${row.order_no} rating=${cappedRating} (satisfaction=${satisfaction})`);
}
