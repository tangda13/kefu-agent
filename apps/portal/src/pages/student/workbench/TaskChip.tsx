import { ChevronDown, GraduationCap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BUSINESS_STAGE_LABELS } from "@cecs/contracts";
import { type StudentTask } from "../../../api/client";
import { ReasonGrid } from "./HeadControls";

/* 任务条：训练信息（环节、任务、进度、要求）放在平台外壳顶栏，用虚线框和学士帽图标
   和仿真的客服软件区分开；收起时一行，点开看完整要求、切换任务。 */

const MODE_LABELS: Record<string, string> = { text: "只能打字", voice: "只能语音", text_voice: "文字 + 语音" };
const STAGE_TONE: Record<string, number> = { pre_sale: 2, in_sale: 1, after_sale: 3, customer_care: 4 };

function deadlineText(deadline: string | null): string {
  if (!deadline) return "不设截止";
  const date = new Date(deadline);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} 截止`;
}

export function TaskChip({ task, practice, switchable, onPick, reason }: {
  task: StudentTask | null;
  /** 当前接待的是自由练习 */
  practice: boolean;
  /** 进行中的任务，可切换聚焦 */
  switchable: StudentTask[];
  onPick: (taskId: string) => void;
  /** 自由练习时，咨询类型收在这里（不放会话头） */
  reason?: { value: string | null; disabled: boolean; onPick: (reason: string) => void } | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!task && !practice) return null;
  if (!task) {
    return (
      <div className="wbk-taskchip-wrap" ref={ref}>
        <button type="button" className="wbk-taskchip" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <GraduationCap size={14} />自由练习
          {reason?.value ? <span className="wbk-taskchip-stage">· {reason.value}</span> : null}
          <ChevronDown size={13} />
        </button>
        {open ? (
          <div className="wbk-pop wbk-taskpop" role="dialog" aria-label="自由练习">
            <div className="wbk-taskpop-h"><b>自由练习</b><span className="wbk-taskchip-stage">不限时、不计成绩</span></div>
            {reason ? (
              <div className="wbk-taskpop-reason">
                <span>咨询类型</span>
                {reason.disabled ? <b>{reason.value ?? "未选择"}</b> : <ReasonGrid value={reason.value} onPick={(value) => { reason.onPick(value); setOpen(false); }} />}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  const tone = STAGE_TONE[task.businessStage] ?? 1;
  const done = task.progressDone ?? 0;
  const total = task.requiredTotal ?? 0;
  const started = new Set(task.startedScenarioIds ?? []);
  return (
    <div className="wbk-taskchip-wrap" ref={ref}>
      <button type="button" className="wbk-taskchip" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <GraduationCap size={14} />
        <span className={`wbk-taskchip-dot c${tone}`} />
        <span className="wbk-taskchip-stage">{BUSINESS_STAGE_LABELS[task.businessStage]}</span>
        <b>{task.name}</b>
        {total > 0 ? <span className="num">{done}/{total}</span> : null}
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="wbk-pop wbk-taskpop" role="dialog" aria-label="任务要求">
          <div className="wbk-taskpop-h">
            <span className={`wbk-stage c${tone}`}>{BUSINESS_STAGE_LABELS[task.businessStage]}</span>
            <b>{task.name}</b>
          </div>
          <dl>
            <dt>进度</dt><dd><span className="num">{done} / {total}</span> {task.completionRule === "conversation_count" ? "次接待" : "个场景"}</dd>
            <dt>交流方式</dt><dd>{MODE_LABELS[task.interactionMode] ?? MODE_LABELS.text_voice}</dd>
            <dt>每次限时</dt><dd>{task.timeLimitMinutes ? `${task.timeLimitMinutes} 分钟` : "不限时"}</dd>
            <dt>截止</dt><dd>{deadlineText(task.deadline)}</dd>
            {task.passScore != null ? <><dt>达标线</dt><dd>{task.passScore} 分</dd></> : null}
          </dl>
          {task.completionRule !== "conversation_count" && task.scenarios?.length ? (
            <ul className="wbk-taskpop-sc">
              {task.scenarios.map((scenario) => (
                <li key={scenario.id} className={started.has(scenario.id) ? "is-done" : ""}>{scenario.name}</li>
              ))}
            </ul>
          ) : null}
          {switchable.length > 1 ? (
            <div className="wbk-taskpop-sw">
              <span>切换任务</span>
              {switchable.map((item) => (
                <button key={item.id} type="button" className={item.id === task.id ? "is-on" : ""} onClick={() => { setOpen(false); onPick(item.id); }}>
                  {item.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
