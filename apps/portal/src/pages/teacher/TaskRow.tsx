import { CalendarClock, FileChartColumn, MessageSquareMore } from "lucide-react";
import type { ReactNode } from "react";
import type { TeacherTask } from "../../api/client";
import { StageTag } from "../../ui";
import { dueText, Progress } from "./widgets";

const ARRIVAL_SHORT: Record<string, string> = { sequential: "", interval: "按间隔进线", all_at_once: "同时进线" };

/** 任务行（总览与实训任务共用）：名称 | 完成进度 | 平均分 | 截止 | … ；整行点开详情 */
export function TaskRow({ task, onOpen, menu, showOpenTime }: { task: TeacherTask; onOpen: () => void; menu?: ReactNode; showOpenTime?: boolean }) {
  const due = showOpenTime && task.startAt
    ? { text: `${new Date(task.startAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 开放`, tone: "" as const }
    : dueText(task.deadline, task.status === "closed");
  const meta = [
    task.classes.map((item) => item.name).join("、") || "未分配班级",
    `${task.scenarioIds.length} 个场景`,
    ARRIVAL_SHORT[task.arrivalMode ?? "sequential"],
  ].filter(Boolean).join(" · ");
  const score = task.averageScore;
  return (
    <div className="task-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}>
      <div><div className="task-name">{task.name}<StageTag stage={task.businessStage} /></div><div className="task-meta">{meta}</div></div>
      <Progress done={task.studentDone} total={task.studentTotal} />
      <div className={score == null ? "task-score is-none" : score < 60 ? "task-score is-bad" : "task-score"}>{score ?? "未评分"}</div>
      <div className={due.tone ? `task-due is-${due.tone}` : "task-due"}>{due.text}</div>
      <div className="task-row-more" onClick={(event) => event.stopPropagation()}>{menu}</div>
    </div>
  );
}

export function TaskRowHead({ timeLabel = "截止" }: { timeLabel?: string }) {
  return (
    <div className="task-row is-head">
      <span>任务</span><span>完成情况</span><span>平均分</span><span>{timeLabel}</span><span />
    </div>
  );
}

const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
const shortDate = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 截止一格（参数 2.2.2 要列出截止时间）：大字日期，小字还剩几天；进行中 2 天内、已过截止标橙 */
function DueFigure({ task, state }: { task: TeacherTask; state: "active" | "upcoming" | "closed" }) {
  if (!task.deadline) return <b className="is-small">不设</b>;
  const date = new Date(task.deadline).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  if (state === "closed") return <b className="is-small">{date}</b>;
  const past = new Date(task.deadline).getTime() < Date.now();
  const left = daysLeft(task.deadline);
  const warn = past || left <= 2;
  return (
    <>
      <b className={warn ? "is-small is-warn" : "is-small"}>{date}</b>
      <span className={warn ? "tl-due-sub is-warn" : "tl-due-sub"}>{past ? "已过截止" : left === 0 ? "今天截止" : `还剩 ${left} 天`}</span>
    </>
  );
}

/** 任务卡片（D-35，实训任务页）：头部业务环节 + 状态；中间三格只放判断要用的数：完成、平均分（低于达标线标红）、截止（T3：日期 + 还剩几天，2 天内标橙） */
export function TaskCard({ task, state, onOpen, menu, onTracking, onReport }: {
  task: TeacherTask; state: "active" | "upcoming" | "closed"; onOpen: () => void; menu?: ReactNode; onTracking: () => void; onReport: () => void;
}) {
  const meta = [task.classes.map((item) => item.name).join("、") || "未分配班级", `${task.scenarioIds.length} 个场景`, ARRIVAL_SHORT[task.arrivalMode ?? "sequential"]].filter(Boolean).join(" · ");
  const score = task.averageScore;
  const percent = task.studentTotal ? Math.round((task.studentDone / task.studentTotal) * 100) : 0;
  return (
    <article className={`tl-card is-${state}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}>
      <div className="tl-card-top">
        <h3>{task.name}</h3>
        <StageTag stage={task.businessStage} />
      </div>
      <p className="tl-meta">{meta}</p>
      {state === "upcoming" && task.startAt ? (
        <div className="tl-open"><CalendarClock size={15} /><span><b>{shortDate(task.startAt)}</b> 开放 · 还有 {daysLeft(task.startAt)} 天</span></div>
      ) : (
        <div className="tl-figs">
          <div>
            <small>完成</small>
            <b>{task.studentDone}<em>/ {task.studentTotal} 人</em></b>
            <span className="tl-prog"><i style={{ width: `${percent}%` }} /></span>
          </div>
          <div>
            <small>平均分{task.passScore != null ? ` · 达标 ${task.passScore}` : ""}</small>
            <b className={score == null ? "is-na" : task.passScore != null && score < task.passScore ? "is-bad" : score < 60 ? "is-bad" : undefined}>{score ?? "—"}</b>
          </div>
          <div>
            <small>截止</small>
            <DueFigure task={task} state={state} />
          </div>
        </div>
      )}
      <div className="tl-foot" onClick={(event) => event.stopPropagation()}>
        {state === "upcoming"
          ? <span className="tl-foot-note">{task.studentTotal} 名学生 · 开放后出现在学生任务大厅</span>
          : <>
            <button type="button" className="tl-go" onClick={onTracking}><MessageSquareMore size={13} />{state === "closed" ? "看回放" : "看跟踪"}</button>
            <button type="button" className="tl-go" onClick={onReport}><FileChartColumn size={13} />看成绩</button>
          </>}
        <span className="tl-more">{menu}</span>
      </div>
    </article>
  );
}
