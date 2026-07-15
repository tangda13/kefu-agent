import { ArrowRight, CheckCircle2, Clock3, MessageCircleMore, Play, Sparkles, Target, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";
import { MetricCard, PageHeader } from "../../components/AppShell";
import { tasks as demoTasks } from "../../data/demo";
import { fetchStudentTasks, type Session, type StudentTask } from "../../api/client";

type TaskFilter = "pending" | "active" | "completed";

interface TaskRowData {
  id: string;
  name: string;
  stage: string;
  stageKey: BusinessStage | null;
  due: string;
  status: TaskFilter;
  progress: number;
  score: number | null;
}

const PROGRESS_TO_FILTER: Record<StudentTask["progressStatus"], TaskFilter> = {
  todo: "pending",
  in_progress: "active",
  done: "completed",
};

function toRow(task: StudentTask): TaskRowData {
  const status = PROGRESS_TO_FILTER[task.progressStatus];
  return {
    id: task.id,
    name: task.name,
    stage: BUSINESS_STAGE_LABELS[task.businessStage],
    stageKey: task.businessStage,
    due: task.deadline ? new Date(task.deadline).toLocaleDateString("zh-CN") : "未设截止",
    status,
    progress: status === "completed" ? 100 : status === "active" ? 50 : 0,
    score: task.score,
  };
}

function demoRows(): TaskRowData[] {
  return demoTasks.map((task) => ({
    id: task.id,
    name: task.name,
    stage: task.stage,
    stageKey: null,
    due: task.due,
    status: task.status as TaskFilter,
    progress: task.progress,
    score: (task as { score?: number }).score ?? null,
  }));
}

export function TaskHall({ onStart, session }: { onStart: (taskId?: string) => void; session?: Session | null }) {
  const [filter, setFilter] = useState<TaskFilter>("pending");
  const [rows, setRows] = useState<TaskRowData[]>(session ? [] : demoRows());
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchStudentTasks(session)
      .then((tasks) => {
        if (!cancelled) setRows(tasks.map(toRow));
      })
      .catch(() => {
        if (!cancelled) setLoadError("任务列表加载失败，请检查网络后刷新。");
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const counts = useMemo(
    () => ({
      pending: rows.filter((row) => row.status === "pending").length,
      active: rows.filter((row) => row.status === "active").length,
      completed: rows.filter((row) => row.status === "completed").length,
    }),
    [rows],
  );
  const filters = [
    { id: "pending", label: "待办", count: counts.pending },
    { id: "active", label: "进行中", count: counts.active },
    { id: "completed", label: "已完成", count: counts.completed },
  ] as const;
  const visible = rows.filter((row) => row.status === filter);
  const completedCount = counts.completed;
  const greetName = session?.user.displayName ?? "李明轩";

  return (
    <div className="page task-hall">
      <PageHeader eyebrow="TRAINING CENTER" title="任务大厅" description={`你好，${greetName}。今天从一场真实的客户沟通开始。`} actions={<button className="secondary-button"><Sparkles size={17} /> 查看能力建议</button>} />
      <section className="metric-grid four">
        <MetricCard label="已完成任务" value={session ? String(completedCount) : "12"} trend={session ? `共 ${rows.length} 个任务` : "较上月 +2"} icon={CheckCircle2} tone="green" />
        <MetricCard label="平均分" value="—" trend="完成实训后生成" icon={Target} />
        <MetricCard label="班级排名" value="—" trend="完成实训后生成" icon={Trophy} tone="amber" />
        <MetricCard label="累计对话" value="—" trend="完成实训后生成" icon={MessageCircleMore} tone="coral" />
      </section>

      <section className="focus-banner">
        <div className="focus-graphic"><span>AI</span><i /><i /><i /></div>
        <div><span className="eyebrow light">今日推荐</span><h2>新品咨询：从识别需求到合规表达</h2><p>买家画像将在进入后随机生成。建议先查看关联订单，再开始英文对话。</p></div>
        <button className="light-button" onClick={() => onStart()}>继续实训 <ArrowRight size={18} /></button>
      </section>

      <section className="panel task-panel">
        <div className="panel-heading"><div><h2>我的实训任务</h2><p>按任务状态查看并继续训练</p></div><div className="segmented-tabs">{filters.map((item) => <button key={item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>{item.label}<span>{item.count}</span></button>)}</div></div>
        {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
        <div className="task-list">
          {visible.length === 0 && !loadError ? <p className="muted">暂无该状态的实训任务。</p> : null}
          {visible.map((task) => <article className="task-row" key={task.id}>
            <div className={`stage-mark ${task.stage.includes("售后") ? "after" : task.stage.includes("售中") ? "during" : "pre"}`}><span>{task.stage.slice(0, 2)}</span></div>
            <div className="task-copy"><div><span className="status-pill">{task.stage}</span><small>{task.id.slice(0, 8)}</small></div><h3>{task.name}</h3><p><Clock3 size={14} /> 截止：{task.due}</p></div>
            <div className="task-progress"><span>{task.status === "completed" ? `得分 ${task.score ?? "—"}` : `进度 ${task.progress}%`}</span><div><i style={{ width: `${task.progress}%` }} /></div></div>
            <button className={task.status === "completed" ? "secondary-button compact" : "primary-button compact"} onClick={() => onStart(task.stageKey ? task.id : undefined)}>{task.status === "completed" ? "查看复盘" : <><Play size={15} /> {task.status === "active" ? "继续实训" : "开始实训"}</>}</button>
          </article>)}
        </div>
      </section>
    </div>
  );
}
