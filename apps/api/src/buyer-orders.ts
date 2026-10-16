import type { Db } from "./db";

/**
 * 买家提示词要用的订单：当前咨询关联的主订单 + 在本店的历史订单（最近 10 单）。
 * 学生在订单页能看到全部订单，买家自己也得知道，否则学生一提“您上次买的两件”买家就对不上。
 */
export async function loadBuyerOrders(
  db: Db,
  conversationId: string,
): Promise<{ primary: Record<string, unknown> | null; past: Array<Record<string, unknown>> }> {
  const result = await db.query(
    `select payload, is_primary from orders where conversation_id = $1
     order by is_primary desc, payload->>'placedAt' desc nulls last limit 11`,
    [conversationId],
  );
  const primary = (result.rows.find((row) => row.is_primary)?.payload as Record<string, unknown> | undefined) ?? null;
  const past = result.rows.filter((row) => !row.is_primary).map((row) => row.payload as Record<string, unknown>);
  return { primary, past };
}
