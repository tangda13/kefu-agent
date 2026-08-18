import { ArrowRight, BarChart3, CalendarCheck, CheckCircle2, ClipboardCheck, ClipboardList, Dumbbell, MessagesSquare, Target, ThumbsUp, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ASSESSMENT_DIMENSIONS, BUSINESS_STAGES, BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";
import { MetricCard, PageHeader } from "../../components/AppShell";
import { tasks as demoTasks } from "../../data/demo";
import {
  apiGet,
  createConversation,
  fetchBaselineStatus,
  fetchScenarios,
  fetchStudentTasks,
  fetchWorkbenchStats,
  type BaselineStatus,
  type ScenarioSummary,
  type Session,
  type StudentTask,
} from "../../api/client";
import { OPEN_CONVERSATION_EVENT, OPEN_CONVERSATION_KEY } from "../../App";
import { BaselineQuiz } from "./BaselineQuiz";

type TaskStatus = "pending" | "active" | "completed" | "upcoming";

interface DueState {
  label: string;
  tone: "overdue" | "today" | "normal" | "none";
}

interface TaskRowData {
  id: string;
  name: string;
  stage: string;
  stageKey: BusinessStage | null;
  scenarioNames: string[];
  interactionMode: string;
  timeLimitMinutes: number | null;
  scoringWeights: Record<string, number>;
  due: string;
  dueFull: string;
  dueState: DueState;
  deadlineTs: number | null;
  assignedAt: string;
  status: TaskStatus;
  score: number | null;
  /** 完成标准与进度（教师可配：覆盖全部场景 / 完成 N 次会话；passScore 空 = 不设线） */
  completionRule: string;
  progressDone: number;
  requiredTotal: number;
  passScore: number | null;
  qualified: boolean | null;
  /** 定时开放：开放时间展示文本（未开始任务用） */
  startLabel: string | null;
  startTs: number | null;
}

const PROGRESS_TO_STATUS: Record<StudentTask["progressStatus"], TaskStatus> = {
  todo: "pending",
  in_progress: "active",
  done: "completed",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "待办",
  active: "进行中",
  completed: "已完成",
  upcoming: "未开始",
};

const INTERACTION_LABELS: Record<string, string> = {
  text: "图文",
  voice: "语音",
  text_voice: "图文+语音",
};

const STATUS_STATE_CLASS: Record<TaskStatus, string> = {
  pending: "state-warning",
  active: "state-active",
  completed: "state-done",
  upcoming: "state-upcoming",
};

function toDueState(deadline: string | null): DueState {
  if (!deadline) return { label: "—", tone: "none" };
  const due = new Date(deadline);
  const now = new Date();
  if (due.getTime() < now.getTime()) return { label: "已逾期", tone: "overdue" };
  if (due.toDateString() === now.toDateString()) return { label: "今天截止", tone: "today" };
  return { label: `剩 ${Math.ceil((due.getTime() - now.getTime()) / 86_400_000)} 天`, tone: "normal" };
}

function toRow(task: StudentTask): TaskRowData {
  /* 定时开放：未到开始时间且尚未开始做的任务显示「未开始」，不可进入 */
  const upcoming = task.locked && task.progressStatus === "todo";
  return {
    id: task.id,
    name: task.name,
    stage: BUSINESS_STAGE_LABELS[task.businessStage],
    stageKey: task.businessStage,
    scenarioNames: task.scenarioNames ?? [],
    interactionMode: task.interactionMode,
    timeLimitMinutes: task.timeLimitMinutes,
    scoringWeights: task.scoringWeights ?? {},
    due: task.deadline ? new Date(task.deadline).toLocaleDateString("zh-CN") : "未设截止",
    dueFull: task.deadline
      ? new Date(task.deadline).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "未设截止",
    dueState: toDueState(task.deadline),
    deadlineTs: task.deadline ? new Date(task.deadline).getTime() : null,
    assignedAt: new Date(task.createdAt).toLocaleDateString("zh-CN"),
    status: upcoming ? "upcoming" : PROGRESS_TO_STATUS[task.progressStatus],
    score: task.score,
    completionRule: task.completionRule ?? "all_scenarios",
    progressDone: task.progressDone ?? 0,
    requiredTotal: task.requiredTotal ?? task.scenarioIds.length,
    passScore: task.passScore,
    qualified: task.qualified,
    startLabel: task.startAt
      ? new Date(task.startAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      : null,
    startTs: task.startAt ? new Date(task.startAt).getTime() : null,
  };
}

function demoRows(): TaskRowData[] {
  return demoTasks.map((task) => ({
    id: task.id,
    name: task.name,
    stage: task.stage,
    stageKey: null,
    scenarioNames: [],
    interactionMode: "text_voice",
    timeLimitMinutes: null,
    scoringWeights: {},
    due: task.due,
    dueFull: task.due,
    dueState: { label: task.due, tone: "none" as const },
    deadlineTs: null,
    assignedAt: "—",
    status: task.status as TaskStatus,
    score: (task as { score?: number }).score ?? null,
    completionRule: "all_scenarios",
    progressDone: 0,
    requiredTotal: 1,
    passScore: null,
    qualified: null,
    startLabel: null,
    startTs: null,
  }));
}

export function TaskHall({
  onStart,
  onOpenRecords,
  session,
}: {
  onStart: (taskId?: string) => void;
  onOpenRecords: () => void;
  session?: Session | null;
}) {
  const [rows, setRows] = useState<TaskRowData[]>(session ? [] : demoRows());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [averageScore, setAverageScore] = useState<number | null>(session ? null : 83);
  const [satisfaction, setSatisfaction] = useState<number | null>(session ? null : 92);
  const [baseline, setBaseline] = useState<BaselineStatus | null>(null);
  const [showQuiz, setShowQuiz] = useState(false);

  /* 自由练习：不评分、不计入考核统计，可反复练习任意场景 */
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [practiceScenario, setPracticeScenario] = useState("");
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [practiceError, setPracticeError] = useState("");

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoadError("");
    fetchStudentTasks(session)
      .then((tasks) => {
        if (!cancelled) setRows(tasks.map(toRow));
      })
      .catch(() => {
        if (!cancelled) setLoadError("任务列表加载失败，请检查网络后重试。");
      });
    // 平均分与满意率各自独立降级：加载失败仅显示占位，不阻塞页面
    apiGet<{ average: number | null }>("/v1/student/assessments", session)
      .then((data) => {
        if (!cancelled) setAverageScore(data.average);
      })
      .catch(() => undefined);
    fetchWorkbenchStats(session)
      .then((stats) => {
        if (!cancelled) setSatisfaction(stats.satisfactionRate);
      })
      .catch(() => undefined);
    // 初始测评状态：未完成则横幅优先引导测评；加载失败时不打扰正常任务流
    fetchBaselineStatus(session)
      .then((status) => {
        if (!cancelled) setBaseline(status);
      })
      .catch(() => undefined);
    // 自由练习场景池（启用中的场景；加载失败则练习入口降级为随机场景）
    fetchScenarios(session)
      .then((list) => {
        if (!cancelled) setScenarios(list.filter((item) => item.enabled));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, reloadTick]);

  // 全部任务平铺：进行中→待办→未开始→已完成；前两组按截止时间升序，未开始按开放时间升序
  const sorted = useMemo(() => {
    const byDeadline = (a: TaskRowData, b: TaskRowData) =>
      (a.deadlineTs ?? Number.POSITIVE_INFINITY) - (b.deadlineTs ?? Number.POSITIVE_INFINITY);
    const pending = rows.filter((row) => row.status === "pending").sort(byDeadline);
    const active = rows.filter((row) => row.status === "active").sort(byDeadline);
    const upcoming = rows
      .filter((row) => row.status === "upcoming")
      .sort((a, b) => (a.startTs ?? Number.POSITIVE_INFINITY) - (b.startTs ?? Number.POSITIVE_INFINITY));
    const completed = rows.filter((row) => row.status === "completed");
    return { all: [...active, ...pending, ...upcoming, ...completed], pending, active, upcoming, completed };
  }, [rows]);
  const visible = sorted.all;
  const nextTask = sorted.active[0] ?? sorted.pending[0] ?? null;
  const greetName = session?.user.displayName ?? "李明轩";

  async function startPractice() {
    if (practiceBusy || !session) return;
    setPracticeBusy(true);
    setPracticeError("");
    try {
      const chosenId =
        practiceScenario ||
        (scenarios.length ? scenarios[Math.floor(Math.random() * scenarios.length)]!.id : undefined);
      const created = await createConversation(session, chosenId ? { scenarioId: chosenId } : {});
      sessionStorage.setItem(OPEN_CONVERSATION_KEY, created.id);
      window.dispatchEvent(new Event(OPEN_CONVERSATION_EVENT));
      setPracticeOpen(false);
      onStart(undefined);
    } catch {
      setPracticeError("练习会话创建失败，请稍后重试。");
    } finally {
      setPracticeBusy(false);
    }
  }

  return (
    <div className="page task-hall">
      <PageHeader eyebrow="SERVICE CENTER" title="任务大厅" description={`你好，${greetName}。今天从一场真实的客户沟通开始。`} actions={<button className="secondary-button" onClick={onOpenRecords} title="查看历史成绩与六维能力分析"><BarChart3 size={16} /> 成绩与能力分析</button>} />
      <section className="metric-grid four">
        <MetricCard label="待办任务" value={String(sorted.pending.length)} trend={sorted.pending.length > 0 ? "尽快开始，避免逾期" : "暂无待办任务"} icon={ClipboardList} />
        <MetricCard label="已完成任务" value={String(sorted.completed.length)} trend={`共 ${rows.length} 个任务`} icon={CheckCircle2} tone="green" />
        <MetricCard label="平均分" value={averageScore != null ? String(averageScore) : "—"} trend={averageScore != null ? "实训任务会话的平均成绩（自由练习不计入）" : "完成任务并结束会话后生成"} icon={Target} tone="amber" />
        <MetricCard label="客户满意率" value={satisfaction != null ? `${satisfaction}%` : "—"} trend="近 7 天接待客户的反馈" icon={ThumbsUp} tone="coral" />
      </section>

      <section className={session ? "focus-banner with-practice" : "focus-banner"}>
        <div className="fb-glyph" aria-hidden="true">
          {session && baseline && !baseline.completed
            ? <ClipboardCheck size={26} />
            : nextTask
              ? <MessagesSquare size={26} />
              : <CalendarCheck size={26} />}
        </div>
        {session && baseline && !baseline.completed ? (
          <>
            <div>
              <span className="eyebrow light">初始能力测评</span>
              <h2>10 道题，生成你的六维能力基线</h2>
              <p>正式实训前先完成一次快速测评（单选 / 多选 / 判断 / 实操，约 5 分钟）。系统会生成你的初始六维雷达，之后每次实训都能对照成长。</p>
            </div>
            <button className="light-button" onClick={() => setShowQuiz(true)}>开始测评 <ArrowRight size={18} /></button>
          </>
        ) : nextTask ? (
          <>
            <div>
              <span className="eyebrow light">{nextTask.status === "active" ? "继续任务" : "新任务"}</span>
              <h2>{nextTask.name}</h2>
              <p>{nextTask.status === "active" ? "这个任务还没有完成，尽快回到工作台，继续与买家的沟通。" : `${sorted.pending.length} 个待办任务。建议先查看关联订单，再开始英文对话。`}</p>
            </div>
            <button className="light-button" onClick={() => onStart(nextTask.stageKey ? nextTask.id : undefined)}>{nextTask.status === "active" ? "继续任务" : "开始任务"} <ArrowRight size={18} /></button>
          </>
        ) : (
          <>
            <div>
              <span className="eyebrow light">今日安排</span>
              <h2>当前没有待完成的任务</h2>
              <p>老师下发新任务后会第一时间出现在这里。可以先回顾历史成绩，看看有哪些可以提升的地方。</p>
            </div>
            <button className="light-button" onClick={onOpenRecords}>查看我的记录 <ArrowRight size={18} /></button>
          </>
        )}
        {session ? (
          <>
            <i className="fb-divider" aria-hidden="true" />
            <div className="fb-practice">
              <span className="eyebrow light">自由练习</span>
              <p>不计入成绩，任意场景随时开练。</p>
              <button
                className="light-button ghost"
                onClick={() => { setPracticeScenario(""); setPracticeError(""); setPracticeOpen(true); }}
              >
                <Dumbbell size={16} /> 开始练习
              </button>
            </div>
          </>
        ) : null}
      </section>

      {practiceOpen && session ? (
        <div className="tch-dialog-overlay" onClick={() => setPracticeOpen(false)}>
          <div className="tch-dialog" role="dialog" aria-modal="true" aria-label="自由练习" onClick={(event) => event.stopPropagation()}>
            <header>
              <div className="tt-dialog-title">
                <strong>自由练习</strong>
                <p>练习不评分、不计入考核统计，可反复开练</p>
              </div>
              <button className="icon-button" onClick={() => setPracticeOpen(false)} aria-label="关闭"><X size={17} /></button>
            </header>
            {practiceError ? <p className="form-error" role="alert">{practiceError}</p> : null}
            <label>
              练习场景
              <select value={practiceScenario} onChange={(event) => setPracticeScenario(event.target.value)}>
                <option value="">随机场景（推荐）</option>
                {BUSINESS_STAGES.map((stage) => {
                  const group = scenarios.filter((item) => item.stage === stage);
                  if (group.length === 0) return null;
                  return (
                    <optgroup key={stage} label={BUSINESS_STAGE_LABELS[stage]}>
                      {group.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </optgroup>
                  );
                })}
              </select>
            </label>
            <p className="muted tch-dialog-hint">
              开始后会有一位模拟买家进线，接待方式与正式任务完全一致；练习会保留 AI 反馈供复盘（「我的记录」中标记为练习、不计分），也不影响平均分与老师的考核统计。
            </p>
            <footer>
              <button className="secondary-button" onClick={() => setPracticeOpen(false)}>取消</button>
              <button className="primary-button" onClick={() => void startPractice()} disabled={practiceBusy}>
                {practiceBusy ? "创建中…" : "开始练习"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {showQuiz && session ? (
        <BaselineQuiz
          session={session}
          onClose={() => setShowQuiz(false)}
          onCompleted={(result) => setBaseline({ completed: true, result })}
        />
      ) : null}

      <section className="panel data-panel task-panel">
        <div className="panel-heading"><div><h2>任务列表</h2><p>老师下发的任务都会在这里列出，点击「详情」查看任务要求</p></div><p className="task-counts">待办 {sorted.pending.length} · 进行中 {sorted.active.length}{sorted.upcoming.length > 0 ? ` · 未开始 ${sorted.upcoming.length}` : ""} · 已完成 {sorted.completed.length}</p></div>
        {loadError ? <p className="form-error" role="alert">{loadError}<button className="text-button" onClick={() => setReloadTick((tick) => tick + 1)}>重试</button></p> : null}
        {visible.length === 0 && !loadError ? (
          <p className="muted table-empty">暂无任务。老师下发新任务后会显示在这里。</p>
        ) : (
          <table>
            <thead>
              <tr><th>任务名称</th><th>业务阶段</th><th>截止时间</th><th>状态</th><th>成绩</th><th>操作</th></tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const expanded = expandedId === task.id;
                const weightEntries = ASSESSMENT_DIMENSIONS.filter((dim) => (task.scoringWeights[dim.id] ?? 0) > 0);
                return (
                  <Fragment key={task.id}>
                    <tr>
                      <td><strong>{task.name}</strong>{task.assignedAt !== "—" ? <small>下发于 {task.assignedAt}</small> : null}</td>
                      <td>{task.stage}</td>
                      <td>
                        {task.due}
                        {task.status !== "completed" && task.dueState.tone !== "none"
                          ? <small className={task.dueState.tone === "overdue" ? "due-overdue" : task.dueState.tone === "today" ? "due-today" : ""}>{task.dueState.label}</small>
                          : null}
                      </td>
                      <td>
                        <em className={STATUS_STATE_CLASS[task.status]}>{STATUS_LABELS[task.status]}</em>
                        {task.status === "active" && task.requiredTotal > 1
                          ? <small className="task-progress-hint">进度 {task.progressDone}/{task.requiredTotal}</small>
                          : null}
                      </td>
                      <td>
                        {task.score != null ? <strong>{task.score} 分</strong> : task.status === "completed" ? "评分中" : "—"}
                        {task.status === "completed" && task.qualified != null
                          ? <em className={task.qualified ? "qualify-badge pass" : "qualify-badge fail"}>{task.qualified ? "达标" : "未达标"}</em>
                          : null}
                      </td>
                      <td>
                        {task.status === "completed" ? (
                          <button className="text-button" onClick={onOpenRecords}>查看成绩</button>
                        ) : task.status === "upcoming" ? (
                          <span className="muted task-upcoming-hint">{task.startLabel ?? "待定"} 开放</span>
                        ) : (
                          <button className="text-button" onClick={() => onStart(task.stageKey ? task.id : undefined)}>{task.status === "active" ? "继续任务" : "开始任务"}</button>
                        )}
                        <button className="text-button quiet" onClick={() => setExpandedId(expanded ? null : task.id)}>{expanded ? "收起" : "详情"}</button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="task-detail-row">
                        <td colSpan={6}>
                          <div className="task-detail">
                            <div><span>场景</span><strong>{task.scenarioNames.length > 0 ? task.scenarioNames.join("、") : "—"}</strong></div>
                            <div>
                              <span>完成标准</span>
                              <strong>
                                {task.completionRule === "conversation_count"
                                  ? `完成 ${task.requiredTotal} 次会话`
                                  : task.requiredTotal > 1
                                    ? `覆盖全部 ${task.requiredTotal} 个场景`
                                    : "完成 1 次会话"}
                              </strong>
                            </div>
                            <div><span>达标线</span><strong>{task.passScore != null ? `${task.passScore} 分` : "不设线（完成即达标）"}</strong></div>
                            <div><span>互动方式</span><strong>{INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode}</strong></div>
                            <div><span>限时</span><strong>{task.timeLimitMinutes != null ? `${task.timeLimitMinutes} 分钟` : "不限时"}</strong></div>
                            {task.startLabel ? <div><span>开始时间</span><strong>{task.startLabel}</strong></div> : null}
                            <div><span>截止时间</span><strong className={task.dueState.tone === "overdue" ? "overdue" : ""}>{task.dueFull}</strong></div>
                            <div className="task-detail-weights">
                              <span>评分重点</span>
                              {weightEntries.length > 0
                                ? <div className="chip-row">{weightEntries.map((dim) => <span key={dim.id} className="chip">{dim.label} {task.scoringWeights[dim.id]}%</span>)}</div>
                                : <strong>六个维度均衡评分</strong>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
