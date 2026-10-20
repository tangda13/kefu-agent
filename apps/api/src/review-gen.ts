import { NEGATIVE_REVIEW_POOL, POSITIVE_REVIEW_POOL, starsFromSatisfaction } from "@cecs/domain";
import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import { buildBuyerReviewMessages, buyerReviewSchema } from "./prompts/assist";
import type { SessionState } from "./director";

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
  gateway: LlmGateway,
  conversationId: string,
  log: LogLike,
): Promise<void> {
  if (!gateway.isConfigured("assist")) return;
  const result = await db.query(
    `select o.id as order_id, o.payload, o.order_no, c.persona, c.state
     from conversations c
     join orders o on o.conversation_id = c.id and o.is_primary
     where c.id = $1 and c.status = 'closed' and c.tool_followup is null`,
    [conversationId],
  );
  const row = result.rows[0];
  if (!row) {
    log.info(`review-gen skip: conversation ${conversationId} has no primary order`);
    return;
  }
  const persona = row.persona as Record<string, unknown>;
  const state = (row.state ?? {}) as SessionState;
  // 评价内容依据聊天原文（D-50 起没有备忘录了）；只取最近一段，评价用不着全部细节
  const messageRows = await db.query(
    "select sender, content from conversation_messages where conversation_id = $1 and sender <> 'teacher' order by created_at desc, id desc limit 30",
    [conversationId],
  );
  const transcript = messageRows.rows
    .reverse()
    .map((message) => `${message.sender === "buyer" ? "Me" : "Store agent"}: ${message.content}`)
    .join("\n")
    .slice(-4000);
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
    ? Math.max(starsFromSatisfaction(satisfaction), (existing?.rating ?? 1) + 2)
    : starsFromSatisfaction(satisfaction);
  const cappedRating = Math.min(5, rating);

  let content = "";
  try {
    const { data } = await gateway.completeJson(
      "assist",
      buildBuyerReviewMessages({
        persona,
        productName: order.productName,
        satisfaction,
        mode,
        rating: cappedRating,
        existing,
        transcript,
      }),
      buyerReviewSchema,
      { conversationId },
    );
    content = data.content.slice(0, 600);
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
