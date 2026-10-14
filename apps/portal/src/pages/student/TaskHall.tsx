import { Check, Headset } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ASSESSMENT_DIMENSIONS, BUSINESS_STAGES, BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";
import {
  fetchBaselineStatus,
  fetchScenarios,
  fetchStudentSummary,
  fetchStudentTasks,
  type BaselineStatus,
  type ScenarioSummary,
  type Session,
  type StudentSummary,
  type StudentTask,
} from "../../api/client";
import { writePractice } from "./practice";
import { ScenarioPicker } from "./ScenarioPicker";
import { Bench, Button, Drawer } from "../../ui";
import { dueText } from "../teacher/widgets";
import { BaselineQuiz } from "./BaselineQuiz";
import "../../styles/student-learn.css";

type HallTab = "todo" | "done";

/** 业务环节 → 分类色序号（同 StageTag） */
const STAGE_CAT: Record<BusinessStage, number> = { in_sale: 1, pre_sale: 2, after_sale: 3, customer_care: 4 };

const INTERACTION_LABELS: Record<string, string> = {
  text: "文字",
  voice: "语音",
  text_voice: "文字 + 语音",
};

const ARRIVAL_NOTES: Record<StudentTask["arrivalMode"], (minutes: number | null) => string> = {
  sequential: () => "买家会一位一位进线",
  interval: (minutes) => `每 ${minutes ?? 3} 分钟进线一位买家`,
  all_at_once: () => "所有买家会同时进线",
};

const WEEK_LABELS = "一二三四五六日";

/** 任务状态：进行中 / 待开始 / 未开放（定时） / 已完成 */
function statusOf(task: StudentTask): "active" | "pending" | "upcoming" | "done" {
  if (task.progressStatus === "done") return "done";
  if (task.locked && task.progressStatus === "todo") return "upcoming";
  return task.progressStatus === "in_progress" ? "active" : "pending";
}

function monthDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function openText(iso: string | null): string {
  if (!iso) return "待定";
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} 开放`;
}

/** 一行灰字：限时 · 交流方式 · 达标线 · 老师 下发日期 */
function metaLine(task: StudentTask): string {
  const parts = [
    task.timeLimitMinutes != null ? `每次接待限时 ${task.timeLimitMinutes} 分钟` : "每次接待不限时",
    INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode,
  ];
  if (task.passScore != null) parts.push(`达标线 ${task.passScore}`);
  const teacher = task.teacherName ? (task.teacherName.endsWith("老师") ? task.teacherName : `${task.teacherName}老师`) : "";
  parts.push(`${teacher ? `${teacher} ` : ""}${monthDay(task.createdAt)}下发`);
  return parts.join(" · ");
}

/** 列表行的灰字：环节 · 场景数 · 限时 · 交流方式 */
function rowMeta(task: StudentTask): string {
  const limit = task.timeLimitMinutes != null ? `每次限时 ${task.timeLimitMinutes} 分钟` : "不限时";
  return `${BUSINESS_STAGE_LABELS[task.businessStage]} · ${task.scenarioIds.length} 个场景 · ${limit} · ${INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode}`;
}

/** 任务下每个场景的接待状态：按已开过会话的场景和已完成数推断 */
function scenarioSteps(task: StudentTask): Array<{ id: string; name: string; state: "done" | "cur" | "idle"; text: string }> {
  const started = task.startedScenarioIds.filter((id): id is string => !!id);
  const doneIds = new Set(started.slice(0, task.progressDone));
  return task.scenarios.map((scenario) => {
    if (doneIds.has(scenario.id)) return { id: scenario.id, name: scenario.name, state: "done" as const, text: "已接待" };
    if (started.includes(scenario.id)) return { id: scenario.id, name: scenario.name, state: "cur" as const, text: "接待中" };
    return { id: scenario.id, name: scenario.name, state: "idle" as const, text: "未开始" };
  });
}

/** 任务要求：抽屉里的完整说明 */
function TaskRequirements({ task }: { task: StudentTask }) {
  const weights = ASSESSMENT_DIMENSIONS.filter((dim) => (task.scoringWeights[dim.id] ?? 0) > 0);
  const due = dueText(task.deadline);
  return (
    <dl className="sl-detail">
      <div><dt>场景</dt><dd>{task.scenarioNames.length > 0 ? task.scenarioNames.join("、") : "—"}</dd></div>
      <div>
        <dt>完成标准</dt>
        <dd>
          {task.completionRule === "conversation_count"
            ? `完成 ${task.requiredTotal} 次会话`
            : task.requiredTotal > 1 ? `覆盖全部 ${task.requiredTotal} 个场景` : "完成 1 次会话"}
        </dd>
      </div>
      <div><dt>达标线</dt><dd>{task.passScore != null ? `${task.passScore} 分` : "不设线，完成即达标"}</dd></div>
      <div><dt>交流方式</dt><dd>{INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode}</dd></div>
      <div><dt>每次限时</dt><dd>{task.timeLimitMinutes != null ? `${task.timeLimitMinutes} 分钟` : "不限时"}</dd></div>
      {task.startAt ? <div><dt>开放时间</dt><dd>{openText(task.startAt).replace(" 开放", "")}</dd></div> : null}
      <div><dt>截止</dt><dd className={due.tone ? `is-${due.tone}` : undefined}>{task.deadline ? new Date(task.deadline).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "不设截止"}</dd></div>
      <div>
        <dt>评分重点</dt>
        <dd>
          {weights.length > 0
            ? <span className="sl-chips">{weights.map((dim) => <span key={dim.id}>{dim.label} {task.scoringWeights[dim.id]}%</span>)}</span>
            : "各项能力均衡评分"}
        </dd>
      </div>
    </dl>
  );
}

function StageDot({ stage }: { stage: BusinessStage }) {
  return <i className="th3-dot" style={{ background: `var(--c-cat-${STAGE_CAT[stage]})` }} aria-hidden="true" />;
}

export function TaskHall({
  onStart,
  onOpenRecords,
  session,
}: {
  onStart: (taskId?: string) => void;
  /** 传任务 id：直接看这个任务的复盘 */
  onOpenRecords: (taskId?: string) => void;
  session?: Session | null;
}) {
  const [tasks, setTasks] = useState<StudentTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [tab, setTab] = useState<HallTab>("todo");
  const [baseline, setBaseline] = useState<BaselineStatus | null>(null);
  const [summary, setSummary] = useState<StudentSummary | null>(null);
  const [showQuiz, setShowQuiz] = useState(false);
  const [detail, setDetail] = useState<StudentTask | null>(null);

  /* 自由练习：不评分、不计入考核统计，可反复练习任意场景 */
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [practiceStage, setPracticeStage] = useState<BusinessStage | "random">("random");
  const [practiceBusy, setPracticeBusy] = useState(false);
  /** 指定场景；空 = 所选环节里随机 */
  const [practiceScenario, setPracticeScenario] = useState("");
  const [practiceError, setPracticeError] = useState("");

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoadError("");
    fetchStudentTasks(session)
      .then((list) => {
        if (cancelled) return;
        setTasks(list);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError("任务列表加载失败，请检查网络后重试。");
      });
    /* 以下几项各自降级：加载失败只是少一块信息，不挡住任务 */
    fetchBaselineStatus(session)
      .then((status) => { if (!cancelled) setBaseline(status); })
      .catch(() => undefined);
    fetchScenarios(session)
      .then((list) => { if (!cancelled) setScenarios(list.filter((item) => item.enabled)); })
      .catch(() => undefined);
    fetchStudentSummary(session)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, reloadTick]);

  /* 进行中：进行中 → 待开始 → 未开放；按截止升序，未开放按开放时间升序。已完成单独一组 */
  const groups = useMemo(() => {
    const byDeadline = (a: StudentTask, b: StudentTask) =>
      (a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY) - (b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY);
    const active = tasks.filter((task) => statusOf(task) === "active").sort(byDeadline);
    const pending = tasks.filter((task) => statusOf(task) === "pending").sort(byDeadline);
    const upcoming = tasks
      .filter((task) => statusOf(task) === "upcoming")
      .sort((a, b) => (a.startAt ? new Date(a.startAt).getTime() : Number.POSITIVE_INFINITY) - (b.startAt ? new Date(b.startAt).getTime() : Number.POSITIVE_INFINITY));
    const done = tasks
      .filter((task) => statusOf(task) === "done")
      .sort((a, b) => (b.completedAt ? new Date(b.completedAt).getTime() : 0) - (a.completedAt ? new Date(a.completedAt).getTime() : 0));
    return { todo: [...active, ...pending, ...upcoming], done, activeCount: active.length };
  }, [tasks]);

  /* 最近截止：未完成任务里截止最早的 */
  const nearest = useMemo(
    () => groups.todo.filter((task) => task.deadline).sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime())[0] ?? null,
    [groups],
  );
  const nearestDue = nearest ? dueText(nearest.deadline) : null;
  const nearestLeft = nearest ? Math.max(0, nearest.requiredTotal - nearest.progressDone) : 0;

  /* 已完成页签的右侧概览：平均分 + 达标个数 */
  const doneFact = useMemo(() => {
    const scored = groups.done.filter((task) => task.score != null);
    const average = scored.length ? Math.round(scored.reduce((sum, task) => sum + (task.score ?? 0), 0) / scored.length) : null;
    return { average, passed: groups.done.filter((task) => task.qualified).length };
  }, [groups]);

  const isEmpty = loaded && tasks.length === 0;
  const baselineDone = !!baseline?.completed;
  const practiced = (summary?.conversations.practice ?? 0) > 0;
  /* 没有任务时的“当前步”：先测评，再练习 */
  const curStep = !baselineDone ? 1 : !practiced ? 2 : 3;
  /* 有任务但没做训前测评：进行中列表顶部留一行提示 */
  const needBaseline = !!session && !!baseline && !baseline.completed;

  async function startPractice() {
    if (practiceBusy || !session) return;
    setPracticeBusy(true);
    setPracticeError("");
    try {
      const pool = practiceStage === "random" ? scenarios : scenarios.filter((item) => item.stage === practiceStage);
      if (practiceStage !== "random" && pool.length === 0) {
        setPracticeError("这个环节暂时没有可练的场景。");
        return;
      }
      // 进入练习模式：工作台按这里的选择陆续进线练习买家（同时最多“最大接待人数”位）
      writePractice({ stage: practiceStage, scenarioId: practiceScenario || null });
      onStart(undefined);
    } catch {
      setPracticeError("练习会话创建失败，请稍后重试。");
    } finally {
      setPracticeBusy(false);
    }
  }

  /* 顶部四张卡 */
  const weekDaily = summary?.weekDaily ?? [0, 0, 0, 0, 0, 0, 0];
  const weekMax = Math.max(1, ...weekDaily);
  const todayIndex = summary?.todayIndex ?? (new Date().getDay() + 6) % 7;
  const weekCard = (
    <section className="th3-card">
      <div className="lb">本周接待</div>
      <div className="v">
        <b className={summary && summary.weekConversations > 0 ? undefined : "dash"}>{summary ? summary.weekConversations : "—"}</b>
        <small>{summary && summary.weekConversations > 0 ? `次 · 其中练习 ${summary.weekPractice} 次` : "次"}</small>
      </div>
      <div className="th3-bars">
        {weekDaily.map((count, index) => (
          <i
            key={index}
            title={`周${WEEK_LABELS[index]} ${count} 次`}
            style={{ height: count ? 6 + Math.round((count / weekMax) * 26) : 2 }}
            className={`${index === todayIndex ? "today" : ""}${count ? "" : " zero"}`}
          />
        ))}
      </div>
    </section>
  );
  const doingCard = isEmpty || groups.todo.length === 0 ? (
    <section className="th3-card">
      <div className="lb">进行中的任务</div>
      <div className="v"><b className="dash">{isEmpty ? "—" : "0"}</b></div>
      <div className="ft">{isEmpty ? "老师下发后显示" : "没有要完成的任务"}</div>
    </section>
  ) : (
    <section className="th3-card">
      <div className="lb">进行中的任务</div>
      <div className="v"><b>{groups.todo.length}</b><small>个</small></div>
      <div className="ft">{groups.activeCount} 个正在接待 · {groups.todo.length - groups.activeCount} 个还没开始</div>
    </section>
  );
  const nearestCard = nearest && nearestDue ? (
    <section className={`th3-card${nearestDue.tone ? ` is-${nearestDue.tone}` : ""}`}>
      <div className="lb">最近截止</div>
      <div className="v"><b>{nearestDue.text}</b></div>
      <div className="ft">「{nearest.name}」还差 {nearestLeft} 个{nearest.completionRule === "conversation_count" ? "接待" : "场景"}</div>
    </section>
  ) : (
    <section className="th3-card">
      <div className="lb">最近截止</div>
      <div className="v"><b className="dash">—</b></div>
      <div className="ft">{isEmpty ? "老师下发后显示" : "没有设截止的任务"}</div>
    </section>
  );
  const donePercent = tasks.length ? Math.round((groups.done.length / tasks.length) * 100) : 0;
  const doneCard = isEmpty ? (
    <section className="th3-card">
      <div className="lb">已完成任务</div>
      <div className="v"><b className="dash">—</b></div>
      <div className="th3-track empty" />
    </section>
  ) : (
    <section className="th3-card">
      <div className="lb">已完成任务</div>
      <div className="v"><b>{groups.done.length}</b><small>/ {tasks.length}</small></div>
      <div className="th3-track"><i style={{ width: `${donePercent}%` }} /></div>
    </section>
  );

  const practiceCard = (
    <section className="th3-side">
      <h3>自由练习</h3>
      <p>不计成绩，场景随便挑。</p>
      <div className="th3-radio" role="radiogroup" aria-label="练习环节">
        <button type="button" role="radio" aria-checked={practiceStage === "random"} className={practiceStage === "random" ? "on" : undefined} onClick={() => { setPracticeStage("random"); setPracticeScenario(""); }}>
          <i className="rd" aria-hidden="true" />全部随机
        </button>
        {BUSINESS_STAGES.map((stage) => (
          <button key={stage} type="button" role="radio" aria-checked={practiceStage === stage} className={practiceStage === stage ? "on" : undefined} onClick={() => { setPracticeStage(stage); setPracticeScenario(""); }}>
            <i className="rd" aria-hidden="true" /><StageDot stage={stage} />{BUSINESS_STAGE_LABELS[stage]}
          </button>
        ))}
      </div>
      <ScenarioPicker scenarios={scenarios} stage={practiceStage} value={practiceScenario} onChange={setPracticeScenario} />
      {practiceError ? <p className="sl-form-error" role="alert">{practiceError}</p> : null}
      <Button onClick={() => void startPractice()} loading={practiceBusy} disabled={!session}>开始练习</Button>
    </section>
  );

  /* 任务板标题行：页签 + 已完成页签右侧概览 */
  const head = (
    <div className="th3-h">
      <div className="th3-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "todo"} className={tab === "todo" ? "on" : undefined} onClick={() => setTab("todo")}>进行中 <i>{groups.todo.length}</i></button>
        <button type="button" role="tab" aria-selected={tab === "done"} className={tab === "done" ? "on" : undefined} onClick={() => setTab("done")}>已完成 <i>{groups.done.length}</i></button>
      </div>
      {tab === "done" && groups.done.length > 0 ? (
        <span className="th3-hfact">平均 <b>{doneFact.average ?? "—"}</b> 分 · {groups.done.length} 个里 <b>{doneFact.passed}</b> 个达标</span>
      ) : null}
    </div>
  );

  /* 没有任务：开始三步 */
  const stepsView = (
    <div className="th3-steps3">
      <div className="th3-s3h"><b>开始三步</b><span>按顺序做，老师下发任务后这里换成任务列表</span></div>
      <div className={`th3-s3${curStep === 1 ? " cur" : ""}${baselineDone ? " done" : ""}`}>
        <span className="no">{baselineDone ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : 1}</span>
        <div><b>做训前测评</b><small>10 道题，约 8 分钟。测出各项能力的起点，以后的成绩都和它比</small></div>
        {!baselineDone ? <Button variant="primary" onClick={() => setShowQuiz(true)} disabled={!session}>开始测评</Button> : null}
      </div>
      <div className={`th3-s3${curStep === 2 ? " cur" : ""}${practiced ? " done" : ""}`}>
        <span className="no">{practiced ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : 2}</span>
        <div><b>用自由练习熟悉客服工作台</b><small>接待一位练习买家：回消息、查订单、发商品，不计成绩</small></div>
        {!practiced ? <Button variant={curStep === 2 ? "primary" : "secondary"} onClick={() => void startPractice()} loading={practiceBusy} disabled={!session}>开始练习</Button> : null}
      </div>
      <div className="th3-s3 wait">
        <span className="no">3</span>
        <div><b>等老师下发任务</b><small>下发后会出现在这里，右上角的铃铛也会提醒你</small></div>
        <span className="th3-s3-st">等待中</span>
      </div>
    </div>
  );

  /* 进行中：第一条展开，其余一行 */
  const first = groups.todo[0] && statusOf(groups.todo[0]) !== "upcoming" ? groups.todo[0] : null;
  const restTodo = first ? groups.todo.slice(1) : groups.todo;
  const firstView = first ? (() => {
    const due = dueText(first.deadline);
    const steps = first.completionRule === "all_scenarios" ? scenarioSteps(first) : [];
    return (
      <article className="th3-cur">
        <div className="th3-row1">
          <StageDot stage={first.businessStage} />
          <span className="th3-stage">{BUSINESS_STAGE_LABELS[first.businessStage]}</span>
          <h4>{first.name}</h4>
          {first.deadline ? <span className={`th3-due${due.tone ? ` is-${due.tone}` : ""}`}>{due.text}</span> : null}
        </div>
        <div className="th3-meta">{metaLine(first)}</div>
        {steps.length > 0 ? (
          <ol className="th3-steps">
            {steps.map((step, index) => (
              <li key={step.id} className={step.state === "idle" ? undefined : step.state}>
                <span>{index + 1}</span>{step.name}<em>{step.text}</em>
              </li>
            ))}
          </ol>
        ) : (
          <p className="th3-meta">已完成 {first.progressDone} / {first.requiredTotal} 次接待</p>
        )}
        <div className="th3-acts">
          <Button variant="primary" icon={Headset} onClick={() => onStart(first.id)}>进入工作台</Button>
          <Button variant="ghost" onClick={() => setDetail(first)}>任务要求</Button>
          <span className="th3-note">{ARRIVAL_NOTES[first.arrivalMode](first.arrivalIntervalMinutes)}</span>
        </div>
      </article>
    );
  })() : null;

  const todoView = (
    <>
      {needBaseline ? (
        <div className="th3-s3 cur th3-base">
          <span className="no">1</span>
          <div><b>先做训前测评</b><small>10 道题，约 8 分钟，测出各项能力的起点</small></div>
          <Button size="sm" onClick={() => setShowQuiz(true)}>开始测评</Button>
        </div>
      ) : null}
      {firstView}
      {restTodo.map((task) => {
        const status = statusOf(task);
        const due = dueText(task.deadline);
        return (
          <div key={task.id} className="th3-tr">
            <StageDot stage={task.businessStage} />
            <div><b>{task.name}</b><small>{rowMeta(task)}</small></div>
            <span className="th3-p">{task.progressDone} / {task.requiredTotal} {task.completionRule === "conversation_count" ? "次接待" : "场景"}</span>
            <span className={`th3-due${due.tone && status !== "upcoming" ? ` is-${due.tone}` : ""}`}>{status === "upcoming" ? openText(task.startAt) : task.deadline ? due.text : ""}</span>
            {status === "upcoming" ? (
              <span className="th3-go is-off">未开放</span>
            ) : (
              <button type="button" className="th3-go" onClick={() => onStart(task.id)}>{status === "active" ? "继续" : "开始"}</button>
            )}
          </div>
        );
      })}
      {groups.todo.length === 0 && !needBaseline ? <p className="th3-none">现在没有要完成的任务，已完成的可以在“已完成”里看复盘。</p> : null}
    </>
  );

  const doneView = groups.done.length === 0 ? (
    <p className="th3-none">还没有完成的任务。</p>
  ) : (
    <>
      <div className="th3-th"><span /><span>任务</span><span>成绩</span><span>完成于</span><span /></div>
      {groups.done.map((task) => {
        const lo = task.score != null && task.passScore != null && task.score < task.passScore;
        const gap = lo && task.passScore != null && task.score != null ? task.passScore - task.score : 0;
        const noteParts = [task.passScore != null ? `达标线 ${task.passScore}` : "不设达标线"];
        if (task.qualified === false && gap > 0) noteParts.push(`差 ${gap} 分`);
        else if (task.reviewed) noteParts.push("老师已复核");
        return (
          <div key={task.id} className="th3-dr">
            <StageDot stage={task.businessStage} />
            <div><b>{task.name}</b><small>{BUSINESS_STAGE_LABELS[task.businessStage]} · {task.scenarioIds.length} 个场景</small></div>
            <div className="th3-res">
              <b className={lo ? "lo" : undefined}>{task.score ?? "—"}</b>
              {task.score == null ? <span className="wait">评分中</span> : <span className={task.qualified === false ? "bad" : "ok"}>{task.qualified === false ? "未达标" : "达标"}</span>}
              <small>{noteParts.join(" · ")}</small>
            </div>
            <span className="th3-when">{task.completedAt ? monthDay(task.completedAt) : "—"}</span>
            <button type="button" className="th3-go" onClick={() => onOpenRecords(task.id)}>看复盘</button>
          </div>
        );
      })}
    </>
  );

  return (
    <Bench className="sl-page">
      <div className="th3-cards">
        {weekCard}
        {doingCard}
        {nearestCard}
        {doneCard}
      </div>

      {loadError ? <p className="sl-form-error" role="alert">{loadError}<button type="button" className="sl-retry" onClick={() => setReloadTick((tick) => tick + 1)}>重试</button></p> : null}

      <div className="th3-grid">
        <section className="th3-main">
          {head}
          {!loaded ? <p className="th3-none">正在加载任务</p> : isEmpty ? stepsView : tab === "todo" ? todoView : doneView}
        </section>
        {practiceCard}
      </div>

      {detail ? <Drawer title={detail.name} onClose={() => setDetail(null)}><TaskRequirements task={detail} /></Drawer> : null}

      {showQuiz && session ? (
        <BaselineQuiz
          session={session}
          onClose={() => setShowQuiz(false)}
          onCompleted={(result) => setBaseline({ completed: true, result })}
        />
      ) : null}
    </Bench>
  );
}
