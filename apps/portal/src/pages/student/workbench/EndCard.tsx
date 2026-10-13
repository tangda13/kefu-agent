import { type ConversationMessage, type ConversationSummary } from "../../../api/client";
import { durationLabel } from "./shared";

/* 会话结束：消息流末尾一条系统提示（同真实客服软件），复盘在“我的记录”里看 */

export const CLOSED_REASON_TEXT: Record<string, string> = {
  buyer_left: "客户已离开",
  student_ended: "你结束了会话",
  timeout: "会话超时，已自动结束",
  abandoned: "长时间无人发言，已自动结束",
  task_closed: "会话已关闭",
};

export function EndCard({ conversation, messages, closedReason, endedAt }: {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  closedReason: string | null;
  /** 本机刚结束的时间（毫秒）；老会话没有就按最后一条消息算 */
  endedAt: number | null;
}) {
  const talk = messages.filter((message) => message.sender !== "teacher");
  const last = talk.at(-1);
  const endAt = endedAt ?? (last ? new Date(last.createdAt).getTime() : null);
  const seconds = endAt ? Math.max(0, (endAt - new Date(conversation.createdAt).getTime()) / 1000) : null;
  return (
    <span className="wbk-sys wbk-end-line">
      {CLOSED_REASON_TEXT[closedReason ?? ""] ?? "会话已结束"} · 会话时长 {durationLabel(seconds)}
    </span>
  );
}
