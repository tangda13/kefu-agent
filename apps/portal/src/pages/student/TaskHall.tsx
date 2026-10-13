import { AlarmClock, Check, ClipboardPenLine, Dumbbell, Headset, Inbox, Mic, Shuffle, Target, Timer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ASSESSMENT_DIMENSIONS, BUSINESS_STAGES, BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";
import {
  apiGet,
  createConversation,
  fetchBaselineStatus,
  fetchScenarios,
  fetchStudentTasks,
  type BaselineStatus,
  type ScenarioSummary,
  type Session,
  type StudentTask,
} from "../../api/client";
import { OPEN_CONVERSATION_EVENT, OPEN_CONVERSATION_KEY } from "../../App";
import { Bench, Board, Button, Drawer, FilterChips, StageTag } from "../../ui";
import { dueText } from "../teacher/widgets";
import { BaselineQuiz } from "./BaselineQuiz";
import { StudentKpis } from "./StudentKpis";
import "../../styles/student-learn.css";

type HallFilter = "all" | "todo" | "done";

/** 业务环节 → 分类色序号（同 StageTag） */
const STAGE_CAT: Record<BusinessStage, number> = { in_sale: 1, pre_sale: 2, after_sale: 3, customer_care: 4 };

const INTERACTION_LABELS: Record<string, string> = {
  text: "文字",
  voice: "语音",
  text_voice: "文字 + 语音",
};

const ARRIVAL_NOTES: Record<StudentTask["arrivalMode"], (minutes: number | null) => string> = {
  sequential: () => "进入后买家会一位一位进线",
  interval: (minutes) => `进入后每 ${minutes ?? 3} 分钟进线一位买家`,
  all_at_once: () => "进入后所有买家会同时进线",
};

/** 任务状态：进行中 / 待开始 / 未开放（定时） / 已完成 */
function statusOf(task: StudentTask): "active" | "pending" | "upcoming" | "done" {
  if (task.progressStatus === "done") return "done";
  if (task.locked && task.progressStatus === "todo") return "upcoming";
  return task.progressStatus === "in_progress" ? "active" : "pending";
}

function metaText(task: StudentTask): string {
  const count = task.scenarioIds.length;
  const limit = task.timeLimitMinutes != null ? `每次限时 ${task.timeLimitMinutes} 分钟` : "不限时";
  return `${count} 个场景 · ${limit} · ${INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode}`;
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

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "上午好" : hour < 18 ? "下午好" : "晚上好";
}

/** 分数块颜色：低于达标线红，80 分以上绿，其余中性 */
function scoreTone(score: number, passScore: number | null): "lo" | "hi" | "mid" {
  if (passScore != null && score < passScore) return "lo";
  return score >= 80 ? "hi" : "mid";
}

/** 任务下每个场景的接待状态：按已开过会话的场景和已完成数推断 */
function scenarioSteps(task: StudentTask): Array<{ id: string; name: string; state: "done" | "cur" | "next" | "idle"; text: string }> {
  const started = task.startedScenarioIds.filter((id): id is string => !!id);
  const doneIds = new Set(started.slice(0, task.progressDone));
  const hasRunning = task.scenarios.some((scenario) => started.includes(scenario.id) && !doneIds.has(scenario.id));
  let nextAssigned = hasRunning;
  return task.scenarios.map((scenario) => {
    if (doneIds.has(scenario.id)) return { id: scenario.id, name: scenario.name, state: "done" as const, text: "已接待" };
    if (started.includes(scenario.id)) return { id: scenario.id, name: scenario.name, state: "cur" as const, text: "接待中" };
    if (!nextAssigned) {
      nextAssigned = true;
      return { id: scenario.id, name: scenario.name, state: "cur" as const, text: "还没开始" };
    }
    return { id: scenario.id, name: scenario.name, state: "idle" as const, text: "还没开始" };
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
            : "六项能力均衡评分"}
        </dd>
      </div>
    </dl>
  );
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
  const [tasks, setTasks] = useState<StudentTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [filter, setFilter] = useState<HallFilter>("all");
  const [className, setClassName] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<BaselineStatus | null>(null);
  const [showQuiz, setShowQuiz] = useState(false);
  const [detail, setDetail] = useState<StudentTask | null>(null);

  /* 自由练习：不评分、不计入考核统计，可反复练习任意场景 */
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [practiceStage, setPracticeStage] = useState<BusinessStage | "random">("random");
  const [practiceBusy, setPracticeBusy] = useState(false);
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
    apiGet<{ className: string | null }>("/v1/me", session)
      .then((me) => { if (!cancelled) setClassName(me.className); })
      .catch(() => undefined);
    fetchBaselineStatus(session)
      .then((status) => { if (!cancelled) setBaseline(status); })
      .catch(() => undefined);
    fetchScenarios(session)
      .then((list) => { if (!cancelled) setScenarios(list.filter((item) => item.enabled)); })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, reloadTick]);

  /* 要完成：进行中 → 待开始 → 未开放；按截止升序，未开放按开放时间升序。已完成放后面 */
  const groups = useMemo(() => {
    const byDeadline = (a: StudentTask, b: StudentTask) =>
      (a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY) - (b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY);
    const active = tasks.filter((task) => statusOf(task) === "active").sort(byDeadline);
    const pending = tasks.filter((task) => statusOf(task) === "pending").sort(byDeadline);
    const upcoming = tasks
      .filter((task) => statusOf(task) === "upcoming")
      .sort((a, b) => (a.startAt ? new Date(a.startAt).getTime() : Number.POSITIVE_INFINITY) - (b.startAt ? new Date(b.startAt).getTime() : Number.POSITIVE_INFINITY));
    const done = tasks.filter((task) => statusOf(task) === "done");
    return { todo: [...active, ...pending, ...upcoming], done, current: active[0] ?? pending[0] ?? null };
  }, [tasks]);
  const current = groups.current;
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
      const chosen = pool.length ? pool[Math.floor(Math.random() * pool.length)]!.id : undefined;
      const created = await createConversation(session, chosen ? { scenarioId: chosen } : {});
      sessionStorage.setItem(OPEN_CONVERSATION_KEY, created.id);
      window.dispatchEvent(new Event(OPEN_CONVERSATION_EVENT));
      onStart(undefined);
    } catch {
      setPracticeError("练习会话创建失败，请稍后重试。");
    } finally {
      setPracticeBusy(false);
    }
  }

  const practiceCard = (
    <section className="sl-prac">
      <h4><Dumbbell size={16} aria-hidden="true" />自由练习</h4>
      <p>不计成绩，场景随便挑，可以反复练。</p>
      <div className="sl-prac-opts" role="radiogroup" aria-label="练习环节">
        <button type="button" role="radio" aria-checked={practiceStage === "random"} className={practiceStage === "random" ? "is-on" : undefined} onClick={() => setPracticeStage("random")}>
          <Shuffle size={14} aria-hidden="true" />随机
        </button>
        {BUSINESS_STAGES.map((stage) => (
          <button key={stage} type="button" role="radio" aria-checked={practiceStage === stage} className={practiceStage === stage ? "is-on" : undefined} onClick={() => setPracticeStage(stage)}>
            <i style={{ background: `var(--c-cat-${STAGE_CAT[stage]})` }} aria-hidden="true" />{BUSINESS_STAGE_LABELS[stage]}
          </button>
        ))}
      </div>
      {practiceError ? <p className="sl-form-error" role="alert">{practiceError}</p> : null}
      <Button variant={tasks.length === 0 ? "primary" : "secondary"} onClick={() => void startPractice()} loading={practiceBusy} disabled={!session}>开始练习</Button>
    </section>
  );

  /* 现在要做的任务卡 */
  const nowCard = current ? (() => {
    const due = dueText(current.deadline);
    const steps = current.completionRule === "all_scenarios" ? scenarioSteps(current) : [];
    return (
      <section className="sl-now" style={{ borderLeftColor: `var(--c-cat-${STAGE_CAT[current.businessStage]})` }}>
        <div className="sl-now-k"><StageTag stage={current.businessStage} />现在要做的 · {monthDay(current.createdAt)}下发</div>
        <h3>{current.name}</h3>
        <div className="sl-facts">
          {current.deadline ? <span className={due.tone ? `is-${due.tone}` : undefined}><AlarmClock size={15} aria-hidden="true" />{due.text}</span> : null}
          <span><Timer size={15} aria-hidden="true" />{current.timeLimitMinutes != null ? `每次接待限时 ${current.timeLimitMinutes} 分钟` : "每次接待不限时"}</span>
          <span><Mic size={15} aria-hidden="true" />{INTERACTION_LABELS[current.interactionMode] ?? current.interactionMode}</span>
          {current.passScore != null ? <span><Target size={15} aria-hidden="true" />达标线 {current.passScore} 分</span> : null}
        </div>
        {steps.length > 0 ? (
          <div className="sl-steps" style={{ gridTemplateColumns: `repeat(${Math.min(steps.length, 4)}, minmax(0, 1fr))` }}>
            {steps.map((step, index) => (
              <div key={step.id} className={`sl-step is-${step.state}`}>
                <span className="sl-step-ck">{step.state === "done" ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : index + 1}</span>
                <div><b>{step.name}</b><small>{step.text}</small></div>
              </div>
            ))}
          </div>
        ) : (
          <p className="sl-now-progress">已完成 {current.progressDone} / {current.requiredTotal} 次接待</p>
        )}
        <div className="sl-now-acts">
          <Button variant="primary" className="sl-lg" icon={Headset} onClick={() => onStart(current.id)}>进入工作台</Button>
          <Button onClick={() => setDetail(current)}>任务要求</Button>
          <span className="sl-now-note">{ARRIVAL_NOTES[current.arrivalMode](current.arrivalIntervalMinutes)}</span>
        </div>
      </section>
    );
  })() : null;

  const showTodo = filter !== "done" && groups.todo.length > 0;
  const showDone = filter !== "todo" && groups.done.length > 0;

  return (
    <Bench className="sl-page">
      <div className="sl-greet"><h2>{greeting()}，{session?.user.displayName ?? "同学"}</h2>{className ? <span>{className}</span> : null}</div>

      {needBaseline ? (
        <section className="sl-base">
          <span className="sl-base-ic"><ClipboardPenLine size={26} aria-hidden="true" /></span>
          <div>
            <h3>先做一次训前测评</h3>
            <p>10 道题，测出你现在六项能力的起点。以后每次成绩都会和它比，看自己进步了多少。</p>
            <div className="sl-base-facts"><span>单选 · 多选 · 判断 · 英文实操</span><span>约 8 分钟</span><span>中途退出不保存</span></div>
          </div>
          <Button variant="primary" className="sl-lg" onClick={() => setShowQuiz(true)}>开始测评</Button>
        </section>
      ) : null}

      <StudentKpis session={session} />

      {loadError ? <p className="sl-form-error" role="alert">{loadError}<button type="button" className="sl-retry" onClick={() => setReloadTick((tick) => tick + 1)}>重试</button></p> : null}

      <div className="sl-focus">
        {nowCard ?? (
          <Board title="任务">
            <div className="sl-empty-line">
              <span className="sl-empty-ic"><Inbox size={20} aria-hidden="true" /></span>
              {!loaded ? <div className="sl-muted">正在加载任务</div> : tasks.length === 0 ? (
                <div><b>老师还没有下发任务</b><div className="sl-muted">下发后会出现在这里，顶部也会有通知。可以先去自由练习熟悉工作台。</div></div>
              ) : (
                <div><b>现在没有要做的任务</b><div className="sl-muted">已完成的任务可以在下面看复盘。</div></div>
              )}
            </div>
          </Board>
        )}
        {practiceCard}
      </div>

      {tasks.length > 0 ? (
        <Board
          title="全部任务"
          count={tasks.length}
          extra={
            <FilterChips<HallFilter>
              value={filter}
              onChange={setFilter}
              items={[
                { id: "all", label: "全部" },
                { id: "todo", label: "要完成", count: groups.todo.length },
                { id: "done", label: "已完成", count: groups.done.length },
              ]}
            />
          }
        >
          {showTodo ? (
            <>
              <div className="sl-grp">要完成 · {groups.todo.length}</div>
              {groups.todo.map((task) => {
                const status = statusOf(task);
                const due = dueText(task.deadline);
                const percent = task.requiredTotal ? Math.round((task.progressDone / task.requiredTotal) * 100) : 0;
                return (
                  <div key={task.id} className="sl-tr">
                    <span className="sl-tr-bar" style={{ background: `var(--c-cat-${STAGE_CAT[task.businessStage]})` }} />
                    <div className="sl-tr-name">
                      <b>{task.name}</b>
                      <div className="sl-tr-meta"><StageTag stage={task.businessStage} />{metaText(task)}</div>
                    </div>
                    <div className="sl-tr-prog">
                      <div><b>{task.progressDone} / {task.requiredTotal}</b> {task.completionRule === "conversation_count" ? "次接待" : "个场景"}</div>
                      <div className="sl-track"><i style={{ width: `${percent}%` }} /></div>
                    </div>
                    <div className={due.tone ? `sl-tr-due is-${due.tone}` : "sl-tr-due"}>{status === "upcoming" ? openText(task.startAt) : due.text}</div>
                    <div className="sl-tr-act">
                      {status === "upcoming" ? (
                        <Button size="sm" disabled>未开放</Button>
                      ) : (
                        <Button size="sm" variant={status === "active" ? "primary" : "secondary"} onClick={() => onStart(task.id)}>{status === "active" ? "继续" : "开始"}</Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          ) : null}
          {showDone ? (
            <>
              <div className="sl-grp">已完成 · {groups.done.length}</div>
              {groups.done.map((task) => {
                const tone = task.score != null ? scoreTone(task.score, task.passScore) : "mid";
                const gap = task.score != null && task.passScore != null ? task.passScore - task.score : 0;
                return (
                  <div key={task.id} className="sl-tr">
                    <span className="sl-tr-bar" style={{ background: `var(--c-cat-${STAGE_CAT[task.businessStage]})` }} />
                    <div className="sl-tr-name">
                      <b>{task.name}</b>
                      <div className="sl-tr-meta"><StageTag stage={task.businessStage} />{metaText(task)}</div>
                    </div>
                    <div className="sl-tr-score">
                      <span className={`sl-sc is-${tone}`}>{task.score ?? "—"}{task.score != null ? <small>分</small> : null}</span>
                      <div>
                        {task.score == null ? <div>评分中</div> : <div className={task.qualified === false ? "is-bad" : undefined}>{task.qualified === false ? "未达标" : "达标"}</div>}
                        <div className="sl-cap">{task.passScore != null ? `达标线 ${task.passScore}${task.qualified === false && gap > 0 ? ` · 差 ${gap} 分` : ""}` : "不设达标线"}</div>
                      </div>
                    </div>
                    <div className="sl-tr-due">{task.deadline ? dueText(task.deadline, true).text : "不设截止"}</div>
                    <div className="sl-tr-act"><Button size="sm" variant="text" onClick={onOpenRecords}>看复盘</Button></div>
                  </div>
                );
              })}
            </>
          ) : null}
        </Board>
      ) : null}

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
