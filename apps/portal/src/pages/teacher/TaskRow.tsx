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
