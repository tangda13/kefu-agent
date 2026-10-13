import { ChevronDown, Timer } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type StudentTask, type WorkbenchStats } from "../../../api/client";
import { ShellSlotContext, toast } from "../../../ui";
import { clockLabel, durationLabel, useNow } from "./shared";
import { TaskChip } from "./TaskChip";

/* 工作台顶栏（放进外壳顶栏的槽里）：客服状态（在线 / 挂起）+ 今日指标 + 会话剩余时间。
   仿真：不显示任务名、业务环节、接待进度、交流方式这些训练信息（任务要求在任务大厅看）。 */


interface Props {
  /** 训练信息（任务条）：当前接待是否自由练习、可切换的进行中任务 */
  practice: boolean;
  switchable: StudentTask[];
  onPickTask: (taskId: string) => void;
  /** 客服状态：挂起时不再进线新买家（同千牛 / 飞鸽的“挂起”） */
  online: boolean;
  onToggleOnline: () => void;
  /** 当前聚焦的任务；null = 自由练习或空闲 */
  task: StudentTask | null;
  /** 倒计时依据：当前这场会话的开始时间 */
  startedAt: number | null;
  /** 当前这场会话的标识，用来保证 5 分钟提示、超时处理只触发一次 */
  timerKey: string | null;
  stats: WorkbenchStats | null;
  onTimeUp: () => void;
}

/** 本场结束时间 = min(会话开始 + 单次限时, 任务截止) */
function endsAtOf(task: StudentTask | null, startedAt: number | null): number | null {
  if (!task) return null;
  const candidates: number[] = [];
  if (task.timeLimitMinutes && startedAt) candidates.push(startedAt + task.timeLimitMinutes * 60_000);
  if (task.deadline) candidates.push(new Date(task.deadline).getTime());
  return candidates.length ? Math.min(...candidates) : null;
}

export function ShiftBar({ task, practice, switchable, onPickTask, online, onToggleOnline, startedAt, timerKey, stats, onTimeUp }: Props) {
  const slot = useContext(ShellSlotContext);
  const now = useNow(1000);
  const endsAt = endsAtOf(task, startedAt);
  const remaining = endsAt === null ? null : Math.ceil((endsAt - now) / 1000);

  // 剩 5 分钟轻提示一次；到 0 提示并刷新会话状态（服务端每分钟扫描超时会话）
  const warned = useRef<string | null>(null);
  const ended = useRef<string | null>(null);
  const onTimeUpRef = useRef(onTimeUp);
  onTimeUpRef.current = onTimeUp;
  useEffect(() => {
    if (remaining === null || !timerKey) return;
    if (remaining <= 300 && remaining > 0 && warned.current !== timerKey) {
      warned.current = timerKey;
      toast.ok(`会话还剩 ${Math.max(1, Math.ceil(remaining / 60))} 分钟`);
    }
    if (remaining <= 0 && ended.current !== timerKey) {
      ended.current = timerKey;
      toast.error("会话已超时结束");
      onTimeUpRef.current();
    }
  }, [remaining, timerKey]);

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [moreOpen]);

  if (!slot) return null;

  const clockTone = remaining === null ? "" : remaining <= 60 ? "is-bad" : remaining <= 300 ? "is-warn" : "";
  const unreplied = stats?.unreplied ?? 0;

  const bar = (
    <div className="wbk-shift">
      <button type="button" className={online ? "wbk-status" : "wbk-status is-off"} onClick={onToggleOnline} aria-pressed={!online}>
        <i />{online ? "在线" : "挂起"}<ChevronDown size={13} />
      </button>
      <span className="wbk-sep" />
      <div className="wbk-stats">
        <span>今日接待<b className="num">{stats?.todayConversations ?? "—"}</b></span>
        <span>平均响应<b className="num">{durationLabel(stats?.avgResponseSeconds)}</b></span>
        <span>未回复<b className={`num ${unreplied > 0 ? "is-red" : ""}`}>{stats?.unreplied ?? "—"}</b></span>
        <span>满意率<b className="num">{stats?.satisfactionRate != null ? `${stats.satisfactionRate}%` : "—"}</b></span>
        <div className="wbk-more" ref={moreRef}>
          <button type="button" aria-label="更多指标" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}><ChevronDown size={15} /></button>
          {moreOpen ? (
            <div className="wbk-pop wbk-more-pop">
              <dl>
                <dt>12 小时响应率</dt><dd className="num">{stats?.twelveHourResponseRate != null ? `${stats.twelveHourResponseRate}%` : "—"}</dd>
                <dt>询单支付金额</dt><dd className="num">USD {(stats?.inquiryPaidAmount ?? 0).toFixed(2)}</dd>
                <dt>付款人数</dt><dd className="num">{stats?.paidBuyers ?? "—"}</dd>
                <dt>询单转化率</dt><dd className="num">{stats?.conversionRate != null ? `${stats.conversionRate}%` : "—"}</dd>
              </dl>
            </div>
          ) : null}
        </div>
      </div>
      <span className="wbk-shift-right">
      <TaskChip task={task} practice={practice} switchable={switchable} onPick={onPickTask} />
      {remaining !== null && task ? (
        <span className={`wbk-clock is-quiet ${clockTone}`} title="当前会话剩余时间">
          <Timer size={14} />剩余 <span className="num">{clockLabel(remaining)}</span>
        </span>
      ) : null}
      </span>
    </div>
  );
  return createPortal(bar, slot);
}

