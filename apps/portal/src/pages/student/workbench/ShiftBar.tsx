import { AudioLines, ChevronDown, MessageSquareText, Mic, Timer } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BUSINESS_STAGE_LABELS } from "@cecs/contracts";
import { type StudentTask, type WorkbenchStats } from "../../../api/client";
import { HelpTip, ShellSlotContext, Tag, toast } from "../../../ui";
import { clockLabel, durationLabel, useNow } from "./shared";

/* 「本场」信息栏：放进外壳顶栏的槽里（见 ui 的 ShellSlotContext）。
   环节 + 任务名 | 倒计时 | 已接待进度 | 交流方式 | 右侧今日指标。
   没有进行中的任务时只显示“自由练习”或今日指标。 */

export const MODE_LABELS: Record<string, string> = {
  text: "只能打字",
  voice: "只能语音",
  text_voice: "文字 + 语音",
};

const STAGE_TONE: Record<string, number> = { pre_sale: 2, in_sale: 1, after_sale: 3, customer_care: 4 };

interface Props {
  /** 当前聚焦的任务；null = 自由练习或空闲 */
  task: StudentTask | null;
  /** 可切换的任务（进行中 / 待办） */
  switchable: StudentTask[];
  /** 当前的任务筛选："all" / "practice" / 任务 id */
  taskFilter: string;
  onPickTask: (taskId: string) => void;
  /** 空闲时（没有任务也没有会话）不写“自由练习” */
  practice: boolean;
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

export function ShiftBar({ task, switchable, taskFilter, onPickTask, practice, startedAt, timerKey, stats, onTimeUp }: Props) {
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
      toast.ok(`本场还剩 ${Math.max(1, Math.ceil(remaining / 60))} 分钟，到时间后正在接待的会话会自动结束`);
    }
    if (remaining <= 0 && ended.current !== timerKey) {
      ended.current = timerKey;
      toast.error("本场时间到，正在接待的会话已自动结束");
      onTimeUpRef.current();
    }
  }, [remaining, timerKey]);

  const [moreOpen, setMoreOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen && !taskOpen) return;
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
      if (!taskRef.current?.contains(event.target as Node)) setTaskOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [moreOpen, taskOpen]);

  if (!slot) return null;

  const clockTone = remaining === null ? "" : remaining <= 60 ? "is-bad" : remaining <= 300 ? "is-warn" : "";
  const done = task?.progressDone ?? 0;
  const total = task?.requiredTotal ?? 0;
  const pips = Math.min(total, 8);
  const mode = task?.interactionMode ?? "text_voice";
  const ModeIcon = mode === "text" ? MessageSquareText : mode === "voice" ? Mic : AudioLines;
  const unreplied = stats?.unreplied ?? 0;
  const tone = task ? STAGE_TONE[task.businessStage] ?? 1 : 1;

  const bar = (
    <div className="wbk-shift">
      {task ? (
        <>
          <div className="wbk-shift-name" ref={taskRef}>
            <span className={`wbk-stage c${tone}`}>{BUSINESS_STAGE_LABELS[task.businessStage]}</span>
            {switchable.length > 1 ? (
              <button type="button" className="wbk-shift-task" aria-expanded={taskOpen} onClick={() => setTaskOpen((value) => !value)}>
                <span>{task.name}</span>
                <ChevronDown size={14} />
              </button>
            ) : (
              <strong>{task.name}</strong>
            )}
            {taskOpen ? (
              <div className="wbk-pop wbk-shift-pop" role="menu">
                <button type="button" role="menuitemradio" aria-checked={taskFilter === "all"} className={taskFilter === "all" ? "is-on" : ""} onClick={() => { setTaskOpen(false); onPickTask("all"); }}>全部任务</button>
                {switchable.map((item) => (
                  <button key={item.id} type="button" role="menuitemradio" aria-checked={taskFilter === item.id} className={taskFilter === item.id ? "is-on" : ""} onClick={() => { setTaskOpen(false); onPickTask(item.id); }}>
                    {item.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="wbk-sep" />
          {remaining !== null ? (
            <span className={`wbk-clock ${clockTone}`}>
              <Timer size={15} />
              <span className="num">{clockLabel(remaining)}</span>
              <small>{task.timeLimitMinutes && startedAt ? "本场剩余" : "距截止"}</small>
            </span>
          ) : null}
          {total > 0 ? (
            <span className="wbk-cnt">
              已接待
              <span className="wbk-pips" aria-hidden="true">
                {Array.from({ length: pips }, (_, index) => <i key={index} className={index < done ? "d" : index === done ? "c" : ""} />)}
              </span>
              <b className="num">{done} / {total}</b>
            </span>
          ) : null}
          <span className="wbk-mode"><ModeIcon size={15} />{MODE_LABELS[mode] ?? MODE_LABELS.text_voice}</span>
        </>
      ) : practice ? (
        <div className="wbk-shift-name"><Tag>自由练习</Tag><HelpTip>自由练习不限时间、不计入任务进度，也不会进入评分。</HelpTip></div>
      ) : null}
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
    </div>
  );
  return createPortal(bar, slot);
}

