import { ORDER_STATUS_LABELS, type OrderInfo } from "@cecs/domain";
import type { Db } from "./db";
import type { ToolCardKind } from "./prompts/buyer";

/**
 * 订单页工具（D-56）：付款提醒、物流通知是“工具卡片”，不是普通消息。
 * - 会话进行中：卡片直接进当前聊天，买家照常回复，算一次工具使用、照常评分
 * - 会话已结束：卡片仍记在原会话里（会话本身不能再打字）；买家看了卡片自己决定回复、去付款或不理。
 *   回复了就进入跟进：会话临时回到“接待中”，最多 3 轮（买家一句 + 客服一句算一轮），买家按 2–3 轮内收尾；
 *   客服回满 3 次后系统结束跟进。跟进不评分、不出新的服务评价、不改原来的结束原因和成绩。
 * 状态存 conversations.tool_followup（见 ToolFollowUp）。
 */
export const TOOL_CARD_KINDS: readonly ToolCardKind[] = ["payment_reminder", "logistics_update"];
export const FOLLOWUP_MAX_TURNS = 3;
/** 跟进中两边都不说话超过这么久，跟进自动结束 */
export const FOLLOWUP_ABANDON_MINUTES = 30;

export type FollowUpEndReason = "turn_limit" | "buyer_left" | "student_ended" | "abandoned" | "paid" | "no_reply" | "task_closed";

export interface ToolFollowUp {
  kind: ToolCardKind;
  orderId: string;
  /** 卡片发出时间 */
  sentAt: string;
  /** 买家回复、跟进开始的时间；还没回复时为空 */
  startedAt?: string | null;
  endedAt?: string | null;
  endReason?: FollowUpEndReason | null;
}

export function isToolCardKind(value: unknown): value is ToolCardKind {
  return typeof value === "string" && (TOOL_CARD_KINDS as readonly string[]).includes(value);
}

/** 跟进是否进行中：买家已回复、还没结束 */
export function followUpActive(value: unknown): value is ToolFollowUp & { startedAt: string } {
  const followUp = value as ToolFollowUp | null | undefined;
  return !!followUp && !!followUp.startedAt && !followUp.endedAt;
}

/** 卡片还在等买家反应或跟进进行中：这期间同一订单不能再发同一种卡片 */
export function followUpOpen(value: unknown): value is ToolFollowUp {
  const followUp = value as ToolFollowUp | null | undefined;
  return !!followUp && !followUp.endedAt;
}

/** 这张订单能不能发这种卡片：付款提醒只给待付款订单，物流通知只给已发货的订单 */
export function toolCardProblem(kind: ToolCardKind, order: OrderInfo): string | null {
  if (kind === "payment_reminder" && order.status !== "pending_payment") return "这笔订单不是待付款状态，不能发付款提醒。";
  if (kind === "logistics_update" && !order.logistics) return "这笔订单还没有发货，没有物流可以通知。";
  return null;
}

/** 卡片内容：订单摘要 + 学生选好并改过的话术。前端按它画卡片，复盘和教师回放同一份 */
export function toolCardPayload(kind: ToolCardKind, orderId: string, order: OrderInfo, text: string): Record<string, unknown> {
  const base = {
    orderId,
    orderNo: order.orderNo,
    productName: order.productName,
    productSpec: order.productSpec,
    productImage: order.productImage ?? null,
    quantity: order.quantity,
    totalAmount: order.totalAmount,
    currency: order.currency,
    statusLabel: order.statusLabel,
    text,
  };
  if (kind === "logistics_update" && order.logistics) {
    const nodes = order.logistics.nodes;
    const currentIndex = Math.max(0, nodes.findIndex((node) => node.current));
    const current = nodes[currentIndex] ?? nodes.at(-1) ?? null;
    return {
      ...base,
      carrier: order.logistics.carrier,
      trackingNo: order.logistics.trackingNo,
      node: current?.label ?? null,
      nodeAt: current?.at ?? null,
      nextNode: nodes[currentIndex + 1]?.label ?? null,
    };
  }
  return { ...base, placedAt: order.placedAt };
}

/** 卡片在聊天记录里给买家模型看的样子（方括号说明，和商品卡、订单卡同一种写法） */
export function toolCardContent(kind: ToolCardKind, order: OrderInfo, text: string): string {
  if (kind === "payment_reminder") {
    return `[Sent a payment reminder card for order ${order.orderNo} (${order.productName} x${order.quantity}, ${order.currency} ${order.totalAmount}, with a Pay now button): "${text}"]`;
  }
  const current = order.logistics?.nodes.find((node) => node.current)?.label;
  return `[Sent a shipping update card for order ${order.orderNo} (${order.logistics?.carrier ?? ""} ${order.logistics?.trackingNo ?? ""}${current ? `, current stage: ${current}` : ""}, with a Track parcel button): "${text}"]`;
}

/** 买家看了付款提醒直接付款：订单改成已付款（待发货） */
export function paidOrder(order: OrderInfo): OrderInfo {
  return { ...order, status: "paid", statusLabel: ORDER_STATUS_LABELS.paid };
}

/** 结束跟进：会话回到结束状态，原来的结束原因、结束时间、成绩、星级都不动 */
export async function endFollowUp(db: Db, conversationId: string, reason: FollowUpEndReason): Promise<boolean> {
  const result = await db.query(
    `update conversations set status = 'closed',
       tool_followup = coalesce(tool_followup, '{}'::jsonb) || jsonb_build_object('endedAt', now(), 'endReason', $2::text)
     where id = $1 and status = 'active' and tool_followup is not null and tool_followup->>'endedAt' is null
     returning id`,
    [conversationId, reason],
  );
  return Boolean(result.rowCount);
}
