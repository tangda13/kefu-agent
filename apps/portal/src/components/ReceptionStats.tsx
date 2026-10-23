import type { ReceptionEndReason, ReceptionStats } from "@cecs/contracts";
import { REPLY_FAULTS } from "@cecs/domain";

type Complaint = NonNullable<ReceptionStats["complaints"]>[number];

/** 复盘、回放里消息下的红字（D-90）：哪条学生消息让买家不满、为什么；按消息 id 查 */
export function complaintMap(stats: ReceptionStats | null | undefined): Map<string, Complaint> {
  return new Map((stats?.complaints ?? []).map((item) => [item.messageId, item]));
}

export function complaintText(item: Complaint): string {
  const faults = item.faults.map((fault) => REPLY_FAULTS[fault as keyof typeof REPLY_FAULTS] ?? fault).join("、");
  return `${item.severe ? "买家很不满" : "买家不满"}${faults ? `：${faults}` : ""}${item.last ? " · 随后离开" : ""}`;
}

/* 复盘里的“本次接待”（D-61，设计稿 docs/design/p17-params-teacher 第五节）：学生端我的记录、教师端回放与评分共用。
   每一项对应一个总数：买家评价 → 满意率，平均响应 → 平均响应时长，3 分钟回复率 → 同名总数，对话轮次 → 累计对话的“共 N 轮” */

const END_TEXT: Record<ReceptionEndReason, string> = {
  buyer_left: "买家结束对话",
  left_waiting: "买家等太久离开",
  student_ended: "客服结束接待",
  timeout: "到了限时",
  abandoned: "长时间没有消息",
  task_closed: "任务已结束",
};

function seconds(value: number): { value: number; unit: string } {
  return value < 120 ? { value, unit: "秒" } : { value: Math.round(value / 60), unit: "分钟" };
}

/** 接待时长：一般几分钟到几十分钟；隔天才回的老会话按小时写 */
function minutes(value: number): { value: number; unit: string } {
  if (value < 60) return { value, unit: "秒" };
  if (value < 7200) return { value: Math.round(value / 60), unit: "分钟" };
  return { value: Math.round(value / 3600), unit: "小时" };
}

function rate(stats: ReceptionStats): number | null {
  return stats.replyWithin.counted ? Math.round((stats.replyWithin.within / stats.replyWithin.counted) * 100) : null;
}

/** 导出回放用的一行文字 */
export function receptionText(stats: ReceptionStats): string {
  const avg = stats.avgReplySec != null ? seconds(stats.avgReplySec) : null;
  const within = rate(stats);
  const duration = stats.durationSec != null ? minutes(stats.durationSec) : null;
  return [
    `买家评价 ${stats.rating ? `${stats.rating} 星` : "—"}`,
    `平均响应 ${avg ? `${avg.value} ${avg.unit}` : "—"}`,
    `3 分钟回复率 ${within != null ? `${within}%（${stats.replyWithin.within} / ${stats.replyWithin.counted} 次）` : "—"}`,
    `对话 ${stats.rounds} 轮`,
    `接待时长 ${duration ? `${duration.value} ${duration.unit}` : "—"}${stats.endReason ? `（${END_TEXT[stats.endReason]}）` : ""}`,
  ].join(" · ");
}

export function ReceptionGrid({ stats }: { stats: ReceptionStats }) {
  const avg = stats.avgReplySec != null ? seconds(stats.avgReplySec) : null;
  const within = rate(stats);
  const duration = stats.durationSec != null ? minutes(stats.durationSec) : null;
  return (
    <dl className="reception-grid">
      <div>
        <dt>买家评价</dt>
        {stats.rating ? (
          <dd className="reception-stars" aria-label={`${stats.rating} 星`}>{"★".repeat(stats.rating)}<i>{"★".repeat(5 - stats.rating)}</i></dd>
        ) : <dd className="is-dash">—</dd>}
      </div>
      <div>
        <dt>平均响应</dt>
        <dd className={avg ? undefined : "is-dash"}>{avg ? <>{avg.value}<small>{avg.unit}</small></> : "—"}</dd>
      </div>
      <div>
        <dt>3 分钟回复率</dt>
        <dd className={within != null ? undefined : "is-dash"}>{within != null ? `${within}%` : "—"}</dd>
      </div>
      <div>
        <dt>对话</dt>
        <dd>{stats.rounds}<small>轮</small></dd>
      </div>
      <div>
        <dt>接待时长</dt>
        <dd className={duration ? undefined : "is-dash"}>{duration ? <>{duration.value}<small>{duration.unit}</small></> : "—"}</dd>
      </div>
    </dl>
  );
}
