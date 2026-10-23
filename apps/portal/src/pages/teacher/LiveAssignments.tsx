import { Archive, CalendarClock, CircleStop, Pencil, RotateCcw, Trash2, Check, CircleCheck, Dices, Keyboard, Layers, Lock, Mail, MessageCircle, Mic, Package, Plus, Sparkles, Type, Users } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ASSESSMENT_DIMENSIONS, BUSINESS_STAGES, BUSINESS_STAGE_LABELS, BUYER_ROLES, CUSTOMER_TYPES, DECISION_STYLES, EMOTIONS, NATIONALITIES, PERSONALITIES,
  type BusinessStage,
} from "@cecs/contracts";
import { DEFAULT_ARRIVAL_INTERVAL_MINUTES } from "@cecs/domain";
import {
  ApiError, createTask, deleteTask, fetchClasses, fetchPersonas, fetchScenarios, fetchTeacherTasks, previewPersonaRule, updateTask,
  type ClassSummary, type PersonaSample, type PersonaTemplate, type ScenarioSummary, type Session, type TeacherTask,
} from "../../api/client";
import {
  Bench, Board, Button, ChipSelect, Confirm, Drawer, Field, HeaderTabs, Input, MoreMenu, SearchBox, Segmented, Select,
  HelpTip, StageTag, Status, toast,
} from "../../ui";
import { TaskCard } from "./TaskRow";
import { openReportFor, openTrackingTab } from "./widgets";

const INTERACTION_LABELS: Record<string, string> = { text_voice: "文字和语音", text: "只用文字", voice: "只用语音" };
const LANGUAGE_LABELS: Record<string, string> = { "en-US": "英语", "es-ES": "西班牙语", "fr-FR": "法语" };
const ARRIVAL_LABELS = { sequential: "一位接一位", interval: "按间隔进线", all_at_once: "同时进线" } as const;
/** T5：邮件评六项，权重怎么算（weightedTotal 只在有分的维度里按权重平均） */
const WEIGHT_MAIL_NOTE = "邮件不评客户情绪安抚、消息响应时效，这两项的权重在邮件里按比例分给其余几项。";

type ArrivalMode = keyof typeof ARRIVAL_LABELS;
type CompletionRule = "all_scenarios" | "conversation_count";
type TaskTab = "active" | "upcoming" | "closed";

/** 买家画像规则（D-33 两步）：人群范围（只筛选画像）+ 每次随机变化的沟通方式（覆盖画像默认值） */
interface PersonaRule {
  customerTypes?: string[];
  buyerRoles?: string[];
  decisionStyles?: string[];
  templateIds?: string[];
  nationalityPool?: string[];
  personalityPool?: string[];
  emotionPool?: string[];
  languages?: string[];
}
const EMPTY_RULE: Required<PersonaRule> = { customerTypes: [], buyerRoles: [], decisionStyles: [], templateIds: [], nationalityPool: [], personalityPool: [], emotionPool: [], languages: [] };

interface TaskForm {
  name: string;
  businessStage: BusinessStage;
  classIds: string[];
  scenarioIds: string[];
  interactionMode: string;
  timeLimit: string;
  startAt: string;
  deadline: string;
  completionRule: CompletionRule;
  requiredCount: string;
  passScore: string;
  arrivalMode: ArrivalMode;
  arrivalInterval: string;
  weights: Record<string, number>;
  rule: Required<PersonaRule>;
}

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");

/** 均衡：除不尽的余数从前往后各加 1（八项时为 13/13/13/13/12/12/12/12） */
function defaultWeights(): Record<string, number> {
  const base = Math.floor(100 / ASSESSMENT_DIMENSIONS.length);
  const rest = 100 - base * ASSESSMENT_DIMENSIONS.length;
  return Object.fromEntries(ASSESSMENT_DIMENSIONS.map((dim, index) => [dim.id, base + (index < rest ? 1 : 0)]));
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const dateText = (iso: string | null, fallback: string) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : fallback;

function emptyForm(): TaskForm {
  return {
    name: "", businessStage: "pre_sale", classIds: [], scenarioIds: [], interactionMode: "text_voice",
    timeLimit: "30", startAt: "", deadline: "", completionRule: "all_scenarios", requiredCount: "1", passScore: "",
    arrivalMode: "sequential", arrivalInterval: String(DEFAULT_ARRIVAL_INTERVAL_MINUTES), weights: defaultWeights(),
    rule: { ...EMPTY_RULE },
  };
}

function formFromTask(task: TeacherTask): TaskForm {
  const rule = (task.personaRule ?? {}) as PersonaRule;
  return {
    name: task.name, businessStage: task.businessStage, classIds: task.classes.map((item) => item.id), scenarioIds: task.scenarioIds,
    interactionMode: task.interactionMode, timeLimit: task.timeLimitMinutes ? String(task.timeLimitMinutes) : "",
    startAt: toLocalInput(task.startAt), deadline: toLocalInput(task.deadline),
    completionRule: task.completionRule ?? "all_scenarios", requiredCount: String(task.requiredCount ?? 1),
    passScore: task.passScore != null ? String(task.passScore) : "", arrivalMode: task.arrivalMode ?? "sequential",
    arrivalInterval: String(task.arrivalIntervalMinutes ?? DEFAULT_ARRIVAL_INTERVAL_MINUTES), weights: { ...defaultWeights(), ...task.scoringWeights },
    rule: { ...EMPTY_RULE, ...Object.fromEntries(Object.entries(rule).filter(([, value]) => Array.isArray(value))) },
  };
}

/** 学期（T6）：2–7 月春季，8 月到次年 1 月秋季 */
function semesterOf(date: Date): { key: number; label: string } {
  const month = date.getMonth() + 1;
  const year = month === 1 ? date.getFullYear() - 1 : date.getFullYear();
  const spring = month >= 2 && month <= 7;
  return { key: year * 2 + (spring ? 0 : 1), label: `${year} ${spring ? "春季" : "秋季"}` };
}

/** 任务归哪个学期：进行中、未开始的都算本学期；已结束的按截止时间，没设截止按下发时间 */
function taskSemester(task: TeacherTask): { key: number; label: string } {
  return taskState(task) === "closed" ? semesterOf(new Date(task.deadline ?? task.createdAt)) : semesterOf(new Date());
}

function taskState(task: TeacherTask): TaskTab {
  if (task.status === "closed") return "closed";
  if (task.startAt && new Date(task.startAt).getTime() > Date.now()) return "upcoming";
  return "active";
}

function ruleSummary(rule: PersonaRule | undefined, personaNames?: Record<string, string>): string {
  const scope = rule?.templateIds?.length
    ? `指定画像 ${rule.templateIds.map((id) => personaNames?.[id] ?? id).join("、")}`
    : [
      rule?.customerTypes?.length ? rule.customerTypes.join("、") : "",
      rule?.buyerRoles?.length ? rule.buyerRoles.join("、") : "",
      rule?.decisionStyles?.length ? rule.decisionStyles.join("、") : "",
    ].filter(Boolean).join(" · ") || "画像库全部";
  const vary = [
    rule?.nationalityPool?.length ? `国籍 ${rule.nationalityPool.join("、")}` : "",
    rule?.personalityPool?.length ? `性格 ${rule.personalityPool.join("、")}` : "",
    rule?.emotionPool?.length ? `情绪 ${rule.emotionPool.join("、")}` : "",
    rule?.languages?.length ? `语言 ${rule.languages.map((item) => LANGUAGE_LABELS[item] ?? item).join("、")}` : "",
  ].filter(Boolean).join("；");
  return `从「${scope}」里抽${vary ? `；${vary}` : "，沟通方式用画像默认值"}`;
}

/** 买家画像规则按行列出（任务详情 T2）：人群范围一行一项，沟通方式只列设了的 */
function ruleRows(rule: PersonaRule | undefined, personaNames?: Record<string, string>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (rule?.templateIds?.length) rows.push(["指定画像", rule.templateIds.map((id) => personaNames?.[id] ?? id).join("、")]);
  else {
    if (rule?.customerTypes?.length) rows.push(["客户类型", rule.customerTypes.join("、")]);
    if (rule?.buyerRoles?.length) rows.push(["买家角色", rule.buyerRoles.join("、")]);
    if (rule?.decisionStyles?.length) rows.push(["消费偏好", rule.decisionStyles.join("、")]);
    if (!rows.length) rows.push(["人群", "画像库全部"]);
  }
  const vary: Array<[string, string[] | undefined]> = [
    ["国籍", rule?.nationalityPool],
    ["性格", rule?.personalityPool],
    ["情绪", rule?.emotionPool],
    ["语言", rule?.languages?.map((item) => LANGUAGE_LABELS[item] ?? item)],
  ];
  const picked = vary.filter(([, value]) => value?.length);
  if (picked.length) picked.forEach(([label, value]) => rows.push([label, value!.join("、")]));
  else rows.push(["沟通方式", "用画像的默认值"]);
  return rows;
}

function DetailGroup({ title, rows }: { title: ReactNode; rows: Array<[string, ReactNode]> }) {
  return (
    <section className="tdv-sec">
      <h5>{title}</h5>
      <dl className="tdv-kv">{rows.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>
    </section>
  );
}

/** 任务详情（T2，设计稿 docs/design/p17-params-teacher 第七节）：顶部状态和完成进度，下面按组列，组之间一条分隔线、组内不画线 */
function TaskDetail({ session, task, scenarios, onClose, onEdit }: {
  session: Session; task: TeacherTask; scenarios: ScenarioSummary[]; onClose: () => void; onEdit: () => void;
}) {
  const rule = task.personaRule as PersonaRule | undefined;
  const picked = rule?.templateIds?.length ?? 0;
  const [personaNames, setPersonaNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!picked) return;
    fetchPersonas(session).then((list) => setPersonaNames(Object.fromEntries(list.map((item) => [item.id, item.name])))).catch(() => undefined);
  }, [session, picked]);
  const byId = new Map(scenarios.map((item) => [item.id, item]));
  const state = taskState(task);
  const percent = task.studentTotal ? Math.round((task.studentDone / task.studentTotal) * 100) : 0;
  return (
    <Drawer title={task.name} width={480} onClose={onClose} footer={<Button onClick={onEdit}>编辑</Button>}>
      <div className="tdv">
        <div className="tdv-top">
          {{ active: <Status tone="ok">进行中</Status>, upcoming: <Status tone="warn">未开始</Status>, closed: <Status>已结束</Status> }[state]}
          <StageTag stage={task.businessStage} />
          <span>{task.classes.map((item) => item.name).join("、") || "未分配班级"} · {task.studentTotal} 名学生</span>
        </div>
        <div className="tdv-prog">
          <b>{task.studentDone}<em>/ {task.studentTotal} 人完成</em></b>
          {task.averageScore != null ? <span>平均分 {task.averageScore}</span> : null}
        </div>
        <span className="tdv-bar"><i style={{ width: `${percent}%` }} /></span>
        <DetailGroup title="时间" rows={[
          ["开放", task.startAt ? new Date(task.startAt).toLocaleString("zh-CN") : "下发后立即开放"],
          ["截止", task.deadline ? new Date(task.deadline).toLocaleString("zh-CN") : "不设截止"],
          ["单次限时", task.timeLimitMinutes ? `${task.timeLimitMinutes} 分钟` : "不限时"],
        ]} />
        <DetailGroup title="交互模式" rows={[
          ["交互模式", INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode],
          ["买家进线", task.arrivalMode === "interval" ? `每 ${task.arrivalIntervalMinutes ?? DEFAULT_ARRIVAL_INTERVAL_MINUTES} 分钟进线一位` : ARRIVAL_LABELS[task.arrivalMode ?? "sequential"]],
        ]} />
        <DetailGroup title="完成与达标" rows={[
          ["完成标准", task.completionRule === "conversation_count" ? `完成 ${task.requiredCount ?? 1} 次接待` : `每个场景至少接待一次（共 ${task.scenarioIds.length} 个）`],
          ["达标线", task.passScore != null ? `${task.passScore} 分` : "不设，完成即达标"],
        ]} />
        <section className="tdv-sec">
          <h5>场景</h5>
          <div className="tdv-chips">
            {task.scenarioIds.map((id) => {
              const scenario = byId.get(id);
              return <span key={id}>{scenario?.channel === "mail" ? <Mail size={12} /> : <MessageCircle size={12} />}{scenario?.name ?? id}</span>;
            })}
          </div>
        </section>
        <DetailGroup title="买家画像" rows={ruleRows(rule, personaNames)} />
        <section className="tdv-sec">
          <h5>评分权重<HelpTip>{WEIGHT_MAIL_NOTE}</HelpTip></h5>
          {ASSESSMENT_DIMENSIONS.map((dim) => {
            const value = task.scoringWeights?.[dim.id] ?? 0;
            return (
              <div key={dim.id} className={value ? "tdv-w" : "tdv-w is-off"}>
                <span>{dim.label}</span>
                <span className="tdv-w-bar">{value ? <i style={{ width: `${Math.min(100, value * 2.5)}%` }} /> : null}</span>
                <b>{value ? `${value}%` : "不计分"}</b>
              </div>
            );
          })}
        </section>
      </div>
    </Drawer>
  );
}

export function LiveAssignments({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TaskTab | "all">("all");
  const [stage, setStage] = useState<BusinessStage | "">("");
  const [showClosed, setShowClosed] = useState(false);
  const [keyword, setKeyword] = useState("");
  /** T6：默认看本学期；current = 本学期，all = 全部学期，数字 = 某个往期学期 */
  const [semester, setSemester] = useState<string>("current");
  const [viewing, setViewing] = useState<TeacherTask | null>(null);
  const [editing, setEditing] = useState<TeacherTask | "new" | null>(null);
  const [closing, setClosing] = useState<TeacherTask | null>(null);
  const [removing, setRemoving] = useState<TeacherTask | null>(null);

  const load = useCallback(async () => {
    try {
      const [taskList, classList, scenarioList] = await Promise.all([fetchTeacherTasks(session), fetchClasses(session), fetchScenarios(session)]);
      setTasks(taskList);
      setClasses(classList);
      setScenarios(scenarioList);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [session]);
  useEffect(() => { void load(); }, [load]);

  const current = semesterOf(new Date());
  const pastSemesters = useMemo(() => {
    const seen = new Map<number, string>();
    for (const task of tasks) {
      const item = taskSemester(task);
      if (item.key !== current.key) seen.set(item.key, item.label);
    }
    return [...seen.entries()].sort((a, b) => b[0] - a[0]);
  }, [tasks, current.key]);
  const inSemester = useMemo(() => {
    if (semester === "all") return tasks;
    const key = semester === "current" ? current.key : Number(semester);
    return tasks.filter((task) => taskSemester(task).key === key);
  }, [tasks, semester, current.key]);
  const counts = useMemo(() => {
    const result: Record<TaskTab, number> = { active: 0, upcoming: 0, closed: 0 };
    for (const task of inSemester) result[taskState(task)] += 1;
    return result;
  }, [inSemester]);
  const visible = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return inSemester.filter((task) => (tab === "all" || taskState(task) === tab) && (!stage || task.businessStage === stage)
      && (!word || `${task.name} ${task.classes.map((item) => item.name).join(" ")}`.toLowerCase().includes(word)));
  }, [inSemester, tab, stage, keyword]);
  // D-35：按状态分组。进行中按截止时间排（快截止的在前），未开始按开放时间，已结束按截止倒序
  const groups = useMemo(() => {
    const by = (state: TaskTab) => visible.filter((task) => taskState(task) === state);
    const time = (iso: string | null, fallback: number) => (iso ? new Date(iso).getTime() : fallback);
    return {
      active: by("active").sort((a, b) => time(a.deadline, Infinity) - time(b.deadline, Infinity)),
      upcoming: by("upcoming").sort((a, b) => time(a.startAt, 0) - time(b.startAt, 0)),
      closed: by("closed").sort((a, b) => time(b.deadline, 0) - time(a.deadline, 0)),
    };
  }, [visible]);

  const taskMenu = (row: TeacherTask) => (
    <MoreMenu items={[
      { label: "编辑任务", icon: Pencil, onClick: () => setEditing(row) },
      row.status === "closed"
        ? { label: "重新开启", icon: RotateCcw, onClick: () => void setStatus(row, "published") }
        : { label: "结束任务", icon: CircleStop, onClick: () => setClosing(row) },
      { label: "删除任务", icon: Trash2, danger: true, separated: true, onClick: () => setRemoving(row) },
    ]} />
  );

  async function setStatus(task: TeacherTask, status: "published" | "closed") {
    try {
      await updateTask(session, task.id, { status });
      toast.ok(status === "closed" ? `「${task.name}」已结束` : `「${task.name}」已重新开启`);
      setClosing(null);
      await load();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await deleteTask(session, removing.id);
      toast.ok(`已删除「${removing.name}」`);
      setRemoving(null);
      await load();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    <>
      <Bench>
        <div className="tl-bar">
          <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索任务或班级" />
          <Select className="tl-stage" value={semester} onChange={(event) => setSemester(event.target.value)} aria-label="学期">
            <option value="current">本学期（{current.label}）</option>
            {pastSemesters.map(([key, label]) => <option key={key} value={String(key)}>{label}</option>)}
            <option value="all">全部学期</option>
          </Select>
          <div className="tl-seg" role="tablist">
            {([["all", "全部", inSemester.length], ["active", "进行中", counts.active], ["upcoming", "未开始", counts.upcoming], ["closed", "已结束", counts.closed]] as Array<[TaskTab | "all", string, number]>).map(([id, label, count]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-on" : undefined} onClick={() => setTab(id)}>{label}<i>{count}</i></button>
            ))}
          </div>
          <Select className="tl-stage" value={stage} onChange={(event) => setStage(event.target.value as BusinessStage | "")} aria-label="业务环节">
            <option value="">全部业务环节</option>
            {BUSINESS_STAGES.map((item) => <option key={item} value={item}>{BUSINESS_STAGE_LABELS[item]}</option>)}
          </Select>
          <div className="bench-bar-end"><Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>新建任务</Button></div>
        </div>
        {loading ? <Board><p className="board-quiet">正在读取…</p></Board> : visible.length === 0 ? (
          <Board><p className="board-quiet">{keyword || stage ? "没有匹配的任务" : semester !== "all" && !inSemester.length && tasks.length ? <>这个学期还没有任务。<Button variant="text" onClick={() => setSemester("all")}>看全部学期</Button></> : tab === "upcoming" ? "没有预约开放的任务。新建任务时选“指定时间”开放，就会先出现在这里。" : tab === "closed" ? "还没有结束的任务" : <>还没有任务。<Button variant="text" onClick={() => setEditing("new")}>新建一个</Button>，给班级下发练习。</>}</p></Board>
        ) : (
          <>
            {([["active", "进行中", "ok"], ["upcoming", "未开始", "muted"]] as Array<[TaskTab, string, string]>).map(([state, label, tone]) => groups[state].length ? (
              <section key={state} className="tl-group">
                <h4 className="tl-group-h"><i className={`is-${tone}`} />{label}<span>{groups[state].length}</span></h4>
                <div className="tl-grid">
                  {groups[state].map((row) => (
                    <TaskCard key={row.id} task={row} state={state} onOpen={() => setViewing(row)} menu={taskMenu(row)}
                      onTracking={() => { openTrackingTab("live"); onNavigate?.("tracking"); }}
                      onReport={() => { openReportFor(row.id); onNavigate?.("reports"); }} />
                  ))}
                </div>
              </section>
            ) : null)}
            {groups.closed.length ? (
              tab === "closed" || showClosed ? (
                <section className="tl-group">
                  <h4 className="tl-group-h"><i className="is-line" />已结束<span>{groups.closed.length}</span>
                    {tab !== "closed" ? <button type="button" className="tl-link" onClick={() => setShowClosed(false)}>收起</button> : null}
                  </h4>
                  <div className="tl-grid">
                    {groups.closed.map((row) => (
                      <TaskCard key={row.id} task={row} state="closed" onOpen={() => setViewing(row)} menu={taskMenu(row)}
                        onTracking={() => { openTrackingTab("replay"); onNavigate?.("tracking"); }}
                        onReport={() => { openReportFor(row.id); onNavigate?.("reports"); }} />
                    ))}
                  </div>
                </section>
              ) : (
                <button type="button" className="tl-fold" onClick={() => setShowClosed(true)}>
                  <Archive size={16} />已结束 {groups.closed.length} 个任务：{groups.closed.slice(0, 3).map((item) => item.name).join("、")}{groups.closed.length > 3 ? "……" : ""}<span>展开</span>
                </button>
              )
            ) : null}
          </>
        )}
      </Bench>

      {viewing ? (
        <TaskDetail session={session} task={viewing} scenarios={scenarios} onClose={() => setViewing(null)} onEdit={() => { setEditing(viewing); setViewing(null); }} />
      ) : null}

      {editing ? (
        <TaskDrawer
          session={session}
          task={editing === "new" ? null : editing}
          classes={classes}
          scenarios={scenarios}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      ) : null}

      {closing ? (
        <Confirm title="结束任务" confirmText="结束" onConfirm={() => void setStatus(closing, "closed")} onClose={() => setClosing(null)}>
          结束后学生端不再显示「{closing.name}」，已有成绩保留。之后可以重新开启。
        </Confirm>
      ) : null}
      {removing ? (
        <Confirm title="删除任务" danger confirmText="删除" onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          删除「{removing.name}」会同时清除学生在这个任务下的进度，不能恢复。只想停止的话，用「结束任务」。
        </Confirm>
      ) : null}
    </>
  );
}

// ---------- 新建 / 编辑 ----------

/** 业务环节卡片的分类色（与 StageTag 一致：售前 2、售中 1、售后 3、客户维护 4） */
const STAGE_CAT = [2, 1, 3, 4];
const LIMIT_PRESETS = ["", "15", "30", "45", "60"];
const PASS_PRESETS = ["", "60", "70", "80"];
const INTERACTION_OPTIONS: Array<[string, string, typeof Keyboard]> = [["text_voice", "文字和语音", Keyboard], ["text", "只用文字", Type], ["voice", "只用语音", Mic]];
const ORDER_KIND_SHORT: Record<string, string> = {
  none: "无订单", pending_payment: "待付款", paid: "待发货", in_transit: "运输中", customs: "清关中", delivery_failed: "派送异常",
  delivered: "已送达", delivered_negative: "已送达 · 差评", delivered_positive: "已送达 · 好评", completed: "历史订单",
};
const ARRIVAL_CARDS: Array<{ id: ArrivalMode; level: "easy" | "mid" | "hard"; levelLabel: string; desc: string; lanes: Array<[number, number]> }> = [
  { id: "sequential", level: "easy", levelLabel: "入门", desc: "上一位接待结束，下一位才进来", lanes: [[30, 0], [30, 34], [30, 68]] },
  { id: "interval", level: "mid", levelLabel: "进阶", desc: "", lanes: [[46, 0], [46, 27], [46, 54]] },
  { id: "all_at_once", level: "hard", levelLabel: "挑战", desc: "开始后所有买家一起进来", lanes: [[98, 0], [98, 0], [98, 0]] },
];
/** 评分维度的颜色（堆叠条和每行色块） */
const WEIGHT_COLORS = ["var(--c-cat-1)", "var(--c-cat-2)", "var(--c-cat-3)", "var(--c-cat-4)", "var(--c-cat-5)", "var(--c-cat-6)", "var(--c-cat-7)", "var(--c-cat-8)"];
const DIM_IDS = ASSESSMENT_DIMENSIONS.map((dim) => dim.id);
const toWeights = (values: number[]) => Object.fromEntries(DIM_IDS.map((id, index) => [id, values[index] ?? 0]));
/**
 * 评分权重预设（D-34、D-46），顺序同 ASSESSMENT_DIMENSIONS：
 * 服务话术规范、客户沟通有效性、客户情绪安抚、订单问题解决、商品信息准确性、消息响应时效、语法准确性、沟通用语合规
 */
const STAGE_WEIGHTS: Record<BusinessStage, number[]> = {
  pre_sale: [15, 15, 5, 15, 20, 10, 10, 10],
  in_sale: [10, 15, 15, 20, 10, 10, 10, 10],
  after_sale: [10, 10, 20, 25, 10, 10, 5, 10],
  customer_care: [15, 20, 20, 10, 10, 10, 10, 5],
};
function weightPresets(stage: BusinessStage) {
  return [
    { id: "balanced", label: "均衡", weights: defaultWeights() },
    { id: "stage", label: `${BUSINESS_STAGE_LABELS[stage]}推荐`, weights: toWeights(STAGE_WEIGHTS[stage]) },
    { id: "compliance", label: "重合规", weights: toWeights([10, 10, 10, 10, 10, 10, 10, 30]) },
    { id: "empathy", label: "重安抚", weights: toWeights([10, 15, 30, 15, 5, 10, 5, 10]) },
    { id: "resolution", label: "重解决", weights: toWeights([10, 15, 10, 30, 10, 10, 5, 10]) },
  ];
}
/** 调整一项权重，其他项按原比例补齐，合计保持 100（取整误差落在最大的一项上） */
function rebalanceWeights(weights: Record<string, number>, id: string, delta: number): Record<string, number> {
  const current = weights[id] ?? 0;
  const next = Math.max(0, Math.min(60, current + delta));
  if (next === current) return weights;
  const others = DIM_IDS.filter((key) => key !== id);
  const pool = others.reduce((sum, key) => sum + (weights[key] ?? 0), 0);
  const target = 100 - next;
  // 原来都是 5 的倍数时，补齐后也保持 5 的倍数（避免出现 9%、14% 这种零碎数）
  const unit = DIM_IDS.every((key) => (weights[key] ?? 0) % 5 === 0) ? 5 : 1;
  const round = (value: number) => Math.round(value / unit) * unit;
  const result: Record<string, number> = { [id]: next };
  for (const key of others) result[key] = round(pool > 0 ? ((weights[key] ?? 0) * target) / pool : target / others.length);
  let drift = 100 - Object.values(result).reduce((sum, value) => sum + value, 0);
  while (drift !== 0) {
    const step = Math.sign(drift) * Math.min(unit, Math.abs(drift));
    // 多出来的从最大的一项扣，少的补给最大的一项（扣不动时换下一项）
    const candidates = [...others].sort((x, y) => (result[y] ?? 0) - (result[x] ?? 0)).filter((key) => (result[key] ?? 0) + step >= 0);
    const key = candidates[0];
    if (!key) break;
    result[key] = (result[key] ?? 0) + step;
    drift -= step;
  }
  return result;
}

function TaskDrawer({ session, task, classes, scenarios, onClose, onSaved }: {
  session: Session;
  task: TeacherTask | null;
  classes: ClassSummary[];
  scenarios: ScenarioSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const creating = task === null;
  const [form, setForm] = useState<TaskForm>(() => (task ? formFromTask(task) : emptyForm()));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TaskForm>(key: K, value: TaskForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setRule = (key: keyof PersonaRule, value: string[]) => setForm((current) => ({ ...current, rule: { ...current.rule, [key]: value } }));
  const [personas, setPersonas] = useState<PersonaTemplate[]>([]);
  const [scopeMode, setScopeMode] = useState<"filter" | "pick">(() => (form.rule.templateIds.length ? "pick" : "filter"));
  const [typesTouched, setTypesTouched] = useState(!creating);
  const [preview, setPreview] = useState<{ matchCount: number; matched: Array<{ id: string; name: string }>; samples: PersonaSample[] } | null>(null);
  const [previewSeed, setPreviewSeed] = useState(0);
  const varyCount = form.rule.nationalityPool.length + form.rule.personalityPool.length + form.rule.emotionPool.length + form.rule.languages.length;
  const [varyOpen, setVaryOpen] = useState(false);
  const [pickWord, setPickWord] = useState("");
  useEffect(() => { fetchPersonas(session).then((list) => setPersonas(list.filter((item) => item.enabled))).catch(() => undefined); }, [session]);
  const personaNames = useMemo(() => Object.fromEntries(personas.map((item) => [item.id, item.name])), [personas]);

  // D-33：选了场景就按场景的“适用客户类型”预选人群范围；老师手动改过就不再跟着变
  const scenarioTypes = useMemo(
    () => [...new Set(scenarios.filter((item) => form.scenarioIds.includes(item.id)).flatMap((item) => item.customerTypes ?? []))],
    [scenarios, form.scenarioIds],
  );
  const scenarioTypesKey = scenarioTypes.join(",");
  useEffect(() => {
    if (!creating || typesTouched) return;
    setForm((current) => ({ ...current, rule: { ...current.rule, customerTypes: scenarioTypesKey ? scenarioTypesKey.split(",") : [] } }));
  }, [creating, typesTouched, scenarioTypesKey]);

  // 实际提交的规则：两种方式只留一种
  const effectiveRule = useMemo(() => {
    const scope = scopeMode === "pick"
      ? { templateIds: form.rule.templateIds }
      : { customerTypes: form.rule.customerTypes, buyerRoles: form.rule.buyerRoles, decisionStyles: form.rule.decisionStyles };
    const vary = { nationalityPool: form.rule.nationalityPool, personalityPool: form.rule.personalityPool, emotionPool: form.rule.emotionPool, languages: form.rule.languages };
    return Object.fromEntries(Object.entries({ ...scope, ...vary }).filter(([, value]) => value.length > 0)) as Record<string, string[]>;
  }, [form.rule, scopeMode]);
  useEffect(() => {
    if (!creating) return;
    const timer = setTimeout(() => { previewPersonaRule(session, effectiveRule).then(setPreview).catch(() => setPreview(null)); }, 250);
    return () => clearTimeout(timer);
  }, [creating, session, effectiveRule, previewSeed]);

  const stageScenarios = scenarios.filter((item) => item.enabled && item.stage === form.businessStage);
  const weightSum = Object.values(form.weights).reduce((sum, value) => sum + value, 0);
  const studentTotal = classes.filter((item) => form.classIds.includes(item.id)).reduce((sum, item) => sum + item.studentCount, 0);

  // 时间：常用值优先，选“指定”才出现日期框（D-34）
  const [startMode, setStartMode] = useState<"now" | "custom">(() => (form.startAt ? "custom" : "now"));
  const [deadlineMode, setDeadlineMode] = useState<"none" | "3" | "7" | "custom">(() => (form.deadline ? "custom" : "none"));
  const [limitCustom, setLimitCustom] = useState(() => Boolean(form.timeLimit) && !LIMIT_PRESETS.includes(form.timeLimit));
  const [passCustom, setPassCustom] = useState(() => Boolean(form.passScore) && !PASS_PRESETS.includes(form.passScore));
  const pickDeadline = (mode: "none" | "3" | "7" | "custom") => {
    setDeadlineMode(mode);
    if (mode === "none") set("deadline", "");
    else if (mode !== "custom") {
      const date = new Date();
      date.setDate(date.getDate() + Number(mode));
      date.setHours(18, 0, 0, 0);
      set("deadline", toLocalInput(date.toISOString()));
    }
  };
  const deadlineFact = form.deadline
    ? `${new Date(form.deadline).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} 截止，还有 ${Math.max(0, Math.ceil((new Date(form.deadline).getTime() - Date.now()) / 86_400_000))} 天`
    : "不设截止";
  const [weightPreset, setWeightPreset] = useState<string>("");

  // 分步导航：点击跳到对应位置，滚动时高亮当前步骤
  const mainRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  /** T1：新建时只有老师看过（滚到或点开）的步骤才打勾；这几步有默认值，没看过就打勾像是已经设置过 */
  const [seenSteps, setSeenSteps] = useState<Set<number>>(() => new Set([0]));
  useEffect(() => { setSeenSteps((prev) => (prev.has(activeStep) ? prev : new Set(prev).add(activeStep))); }, [activeStep]);
  // 点击导航时只滚右侧内容区；滚动过程中不跟着滚动位置改高亮，滚完再恢复（避免导航闪跳）
  const jumping = useRef<number | null>(null);
  const jump = (index: number) => {
    const root = mainRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-step="${index}"]`);
    setActiveStep(index);
    if (!root || !target) return;
    if (jumping.current) window.clearTimeout(jumping.current);
    jumping.current = window.setTimeout(() => { jumping.current = null; }, 700);
    root.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
  };
  const onScroll = () => {
    const root = mainRef.current;
    if (!root) return;
    if (jumping.current) {
      // 还在滚动中：顺延解锁时间
      window.clearTimeout(jumping.current);
      jumping.current = window.setTimeout(() => { jumping.current = null; }, 150);
      return;
    }
    const top = root.getBoundingClientRect().top;
    let current = 0;
    root.querySelectorAll<HTMLElement>("[data-step]").forEach((el) => {
      if (el.getBoundingClientRect().top - top < 120) current = Number(el.dataset.step);
    });
    // 滚到底时最后一步也要能高亮
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = 4;
    setActiveStep((prev) => (prev === current ? prev : current));
  };
  const steps = [
    { label: "基本信息", value: BUSINESS_STAGE_LABELS[form.businessStage], valid: Boolean(form.name.trim()) },
    { label: "班级与场景", value: `${form.classIds.length} 班 · ${form.scenarioIds.length} 个`, valid: form.classIds.length > 0 && form.scenarioIds.length > 0 },
    { label: "时间与交互", value: form.deadline ? `${Math.max(0, Math.ceil((new Date(form.deadline).getTime() - Date.now()) / 86_400_000))} 天` : "不限期", valid: true },
    { label: "买家画像", value: creating ? (preview ? `${preview.matchCount} 个画像` : "…") : "已设定", valid: creating ? Boolean(preview?.matchCount) : true },
    { label: "评分权重", value: `合计 ${weightSum}`, valid: weightSum === 100 },
  ].map((step, index) => ({ ...step, done: step.valid && (!creating || seenSteps.has(index)) }));

  async function save() {
    const name = form.name.trim();
    const timeLimit = Number(form.timeLimit) || 0;
    const passScore = Number(form.passScore) || 0;
    const requiredCount = Number(form.requiredCount) || 0;
    const interval = Number(form.arrivalInterval) || 0;
    if (!name) return jump(0), setError("请填写任务名称。");
    if (creating && form.classIds.length === 0) return jump(1), setError("请至少选一个班级。");
    if (creating && form.scenarioIds.length === 0) return jump(1), setError("请至少选一个场景。");
    if (creating && weightSum !== 100) return jump(4), setError(`评分权重合计要等于 100，现在是 ${weightSum}。`);
    if (startMode === "custom" && !form.startAt) return jump(2), setError("请选择开放时间。");
    if (deadlineMode === "custom" && !form.deadline) return jump(2), setError("请选择截止时间。");
    if (form.startAt && form.deadline && new Date(form.startAt) >= new Date(form.deadline)) return jump(2), setError("开放时间要早于截止时间。");
    if (form.completionRule === "conversation_count" && (requiredCount < 1 || requiredCount > 50)) return jump(2), setError("接待次数填 1–50。");
    if (form.arrivalMode === "interval" && (interval < 1 || interval > 120)) return jump(2), setError("进线间隔填 1–120 分钟。");
    if (passScore < 0 || passScore > 100) return jump(2), setError("达标线填 0–100。");
    if (creating && preview && preview.matchCount === 0) return jump(3), setError("买家范围里没有可用的画像，请放宽条件。");
    setError("");
    setBusy(true);
    const startAt = startMode === "custom" && form.startAt ? new Date(form.startAt).toISOString() : null;
    const common = {
      name,
      timeLimitMinutes: timeLimit > 0 ? timeLimit : null,
      startAt,
      deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
      completionRule: form.completionRule,
      requiredCount: form.completionRule === "conversation_count" ? requiredCount : null,
      passScore: passScore > 0 ? passScore : null,
      arrivalMode: form.arrivalMode,
      arrivalIntervalMinutes: form.arrivalMode === "interval" ? interval : null,
    };
    try {
      if (creating) {
        await createTask(session, {
          ...common,
          timeLimitMinutes: common.timeLimitMinutes ?? undefined,
          startAt: common.startAt ?? undefined,
          deadline: common.deadline ?? undefined,
          businessStage: form.businessStage,
          classIds: form.classIds,
          scenarioIds: form.scenarioIds,
          interactionMode: form.interactionMode,
          scoringWeights: form.weights,
          personaRule: effectiveRule,
        });
        toast.ok(startAt && new Date(startAt).getTime() > Date.now()
          ? `已创建，${new Date(startAt).toLocaleString("zh-CN")} 对学生开放`
          : `已下发给 ${studentTotal} 名学生`);
      } else {
        await updateTask(session, task.id, common);
        toast.ok("已保存");
      }
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const locked = (label: string, value: string) => (
    <div className="td-locked"><Lock size={14} /><b>{label}</b><span>{value}</span><em>下发后不能改</em></div>
  );
  const scenarioNames = scenarios.filter((item) => form.scenarioIds.includes(item.id)).map((item) => item.name);

  return (
    <Drawer
      title={creating ? "新建任务" : "编辑任务"}
      width={1040}
      flush
      onClose={onClose}
      footer={
        <>
          <span className="td-foot">
            <span><Users size={15} /><b>{studentTotal}</b> 名学生</span>
            <span><Layers size={15} /><b>{form.scenarioIds.length}</b> 个场景</span>
            <span><CalendarClock size={15} />{form.deadline ? `${new Date(form.deadline).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}截止` : "不设截止"}</span>
          </span>
          {error ? <span className="drawer-error" role="alert">{error}</span> : null}
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>{creating ? (studentTotal ? `下发给 ${studentTotal} 名学生` : "下发") : "保存"}</Button>
        </>
      }
    >
      <div className="td">
        <nav className="td-nav">
          {steps.map((step, index) => (
            <button key={step.label} type="button" className={index === activeStep ? "is-on" : step.done ? "is-done" : ""} onClick={() => jump(index)}>
              <span className="td-n">{step.done && index !== activeStep ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
              {step.label}
              <small>{step.value}</small>
            </button>
          ))}
          <div className="td-sum">
            {creating ? "这次下发" : "这个任务"}
            <b>{form.classIds.length} 个班 · {studentTotal} 名学生</b>
            <span>练 <b>{form.scenarioIds.length} 个场景</b>{form.completionRule === "all_scenarios" ? " · 每个场景至少 1 次" : ` · 接待满 ${form.requiredCount} 次`}</span>
            <span>{deadlineFact}</span>
          </div>
        </nav>

        <div className="td-main" ref={mainRef} onScroll={onScroll}>
          <h4 className="td-sec" data-step="0"><span>1</span>基本信息</h4>
          <section className="td-box">
            <Field label="任务名称"><Input value={form.name} onChange={(event) => set("name", event.target.value)} placeholder="例如：售后第 3 周 · 错发与质量争议" autoFocus /></Field>
            {creating ? (
              <div className="td-field">
                <span className="td-label">业务环节<em>选了以后只列这个环节的场景</em></span>
                <div className="td-stages">
                  {BUSINESS_STAGES.map((stage, index) => (
                    <button key={stage} type="button" className={form.businessStage === stage ? "is-on" : ""}
                      onClick={() => setForm((current) => ({ ...current, businessStage: stage, scenarioIds: [] }))}>
                      <b><i style={{ background: `var(--c-cat-${STAGE_CAT[index]})` }} />{BUSINESS_STAGE_LABELS[stage]}</b>
                      <span>{scenarios.filter((item) => item.enabled && item.stage === stage).length} 个场景</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : locked("业务环节", BUSINESS_STAGE_LABELS[form.businessStage])}
          </section>

          <h4 className="td-sec" data-step="1"><span>2</span>班级与场景</h4>
          {creating ? (
            <>
              <section className="td-box">
                <span className="td-label">下发给哪些班级
                  {classes.length > 1 ? <button type="button" className="td-link" onClick={() => set("classIds", form.classIds.length === classes.length ? [] : classes.map((item) => item.id))}>{form.classIds.length === classes.length ? "取消全选" : "全选"}</button> : null}
                </span>
                {classes.length ? (
                  <div className="td-classes">
                    {classes.map((item) => {
                      const on = form.classIds.includes(item.id);
                      return (
                        <button key={item.id} type="button" className={on ? "td-check is-on" : "td-check"} onClick={() => set("classIds", on ? form.classIds.filter((id) => id !== item.id) : [...form.classIds, item.id])}>
                          <span className="td-ck">{on ? <Check size={11} strokeWidth={3.5} /> : null}</span>
                          <span><b>{item.name}</b><small>{item.studentCount} 名学生</small></span>
                        </button>
                      );
                    })}
                  </div>
                ) : <p className="td-empty">还没有班级，先到「班级与学生」新建</p>}
              </section>
              <section className="td-box">
                <span className="td-label">练哪些场景<em>{form.scenarioIds.length ? `已选 ${form.scenarioIds.length} 个` : "只列已启用的场景"}</em>
                  {stageScenarios.length ? <button type="button" className="td-link" onClick={() => set("scenarioIds", form.scenarioIds.length === stageScenarios.length ? [] : stageScenarios.map((item) => item.id))}>{form.scenarioIds.length === stageScenarios.length ? "取消全选" : `全选${BUSINESS_STAGE_LABELS[form.businessStage]}`}</button> : null}
                </span>
                {stageScenarios.length ? (
                  <div className="td-scenes">
                    {stageScenarios.map((item) => {
                      const on = form.scenarioIds.includes(item.id);
                      const mail = item.channel === "mail";
                      return (
                        <button key={item.id} type="button" className={on ? "td-scene is-on" : "td-scene"} onClick={() => set("scenarioIds", on ? form.scenarioIds.filter((id) => id !== item.id) : [...form.scenarioIds, item.id])}>
                          <span className="td-ck">{on ? <Check size={11} strokeWidth={3.5} /> : null}</span>
                          <span className="td-scene-b">
                            <b>{item.name}</b>
                            <span className="td-scene-o" title={item.objective}>{item.objective}</span>
                            <span className="td-meta">
                              <span>{mail ? <Mail size={11} /> : <MessageCircle size={11} />}{mail ? "邮件" : "在线会话"}</span>
                              <span><Package size={11} />{ORDER_KIND_SHORT[item.orderKind ?? ""] ?? "按环节"}</span>
                              {item.customerTypes?.length ? <span><Users size={11} />{item.customerTypes.join("、")}</span> : null}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : <p className="td-empty">这个环节还没有启用的场景，先到「场景配置」启用</p>}
              </section>
            </>
          ) : (
            <section className="td-box">
              {locked("班级", task.classes.map((item) => item.name).join("、") || "—")}
              {locked("场景", scenarioNames.join("、") || "—")}
            </section>
          )}

          <h4 className="td-sec" data-step="2"><span>3</span>时间与交互</h4>
          <section className="td-box">
            <div className="td-grid2">
              <div className="td-field">
                <span className="td-label">开放时间</span>
                <div className="td-pills">
                  <Pill on={startMode === "now"} onClick={() => { setStartMode("now"); set("startAt", ""); }}>立即开放</Pill>
                  <Pill on={startMode === "custom"} onClick={() => setStartMode("custom")}>指定时间</Pill>
                  {startMode === "custom" ? <Input className="td-date" type="datetime-local" value={form.startAt} onChange={(event) => set("startAt", event.target.value)} /> : null}
                </div>
                <span className="td-fact">{startMode === "now" ? (creating ? "下发后学生马上能看到" : "已开放") : form.startAt ? `${new Date(form.startAt).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} 对学生开放` : "选一个开放时间"}</span>
              </div>
              <div className="td-field">
                <span className="td-label">截止时间</span>
                <div className="td-pills">
                  <Pill on={deadlineMode === "none"} onClick={() => pickDeadline("none")}>不设</Pill>
                  <Pill on={deadlineMode === "3"} onClick={() => pickDeadline("3")}>3 天后</Pill>
                  <Pill on={deadlineMode === "7"} onClick={() => pickDeadline("7")}>1 周后</Pill>
                  <Pill on={deadlineMode === "custom"} onClick={() => pickDeadline("custom")}>指定</Pill>
                  {deadlineMode === "custom" ? <Input className="td-date" type="datetime-local" value={form.deadline} onChange={(event) => set("deadline", event.target.value)} /> : null}
                </div>
                <span className="td-fact">{deadlineFact}</span>
              </div>
              <div className="td-field">
                <span className="td-label">单次接待限时</span>
                <div className="td-pills">
                  {LIMIT_PRESETS.map((value) => <Pill key={value || "none"} on={!limitCustom && form.timeLimit === value} onClick={() => { setLimitCustom(false); set("timeLimit", value); }}>{value || "不限"}</Pill>)}
                  <Pill on={limitCustom} onClick={() => setLimitCustom(true)}>自定义</Pill>
                  {limitCustom ? <Input className="td-num" type="number" min={1} value={form.timeLimit} onChange={(event) => set("timeLimit", event.target.value)} /> : null}
                  <span className="td-unit">分钟</span>
                </div>
              </div>
              <div className="td-field">
                <span className="td-label">交互模式</span>
                {creating ? (
                  <div className="td-pills">
                    {INTERACTION_OPTIONS.map(([id, label, Icon]) => <Pill key={id} on={form.interactionMode === id} onClick={() => set("interactionMode", id)}><Icon size={14} />{label}</Pill>)}
                  </div>
                ) : <span className="td-fact">{INTERACTION_LABELS[form.interactionMode]} · 下发后不能改</span>}
              </div>
            </div>
          </section>

          <section className="td-box">
            <span className="td-label">买家怎么进线<em>控制难度的主要手段</em></span>
            <div className="td-arrivals">
              {ARRIVAL_CARDS.map((card) => (
                <button key={card.id} type="button" className={form.arrivalMode === card.id ? "td-arrival is-on" : "td-arrival"} onClick={() => set("arrivalMode", card.id)}>
                  <b>{ARRIVAL_LABELS[card.id]}<em className={`is-${card.level}`}>{card.levelLabel}</em></b>
                  <span className="td-lane">{card.lanes.map(([width, left], index) => <i key={index} style={{ width: `${width}%`, marginLeft: `${left}%` }} />)}</span>
                  <span>{card.id === "interval" ? `每隔 ${form.arrivalInterval || "?"} 分钟进一位，可能同时接待好几位` : card.desc}</span>
                </button>
              ))}
            </div>
            {form.arrivalMode === "interval" ? (
              <div className="td-pills"><span className="td-unit">每隔</span><Input className="td-num" type="number" min={1} max={120} value={form.arrivalInterval} onChange={(event) => set("arrivalInterval", event.target.value)} /><span className="td-unit">分钟进一位</span></div>
            ) : null}
          </section>

          <section className="td-box">
            <span className="td-label">怎样算完成</span>
            <div className="td-radios">
              <button type="button" className={form.completionRule === "all_scenarios" ? "td-radio is-on" : "td-radio"} onClick={() => set("completionRule", "all_scenarios")}>
                <span className="td-rd" /><span><b>每个场景至少接待一次</b><small>{form.scenarioIds.length ? `选了 ${form.scenarioIds.length} 个场景，每人至少 ${form.scenarioIds.length} 次接待` : "按所选场景计算"}</small></span>
              </button>
              <button type="button" className={form.completionRule === "conversation_count" ? "td-radio is-on" : "td-radio"} onClick={() => set("completionRule", "conversation_count")}>
                <span className="td-rd" /><span><b>接待满指定次数</b><small>不限场景，凑够次数就算完成</small></span>
              </button>
            </div>
            {form.completionRule === "conversation_count" ? (
              <div className="td-pills"><span className="td-unit">接待满</span><Input className="td-num" type="number" min={1} max={50} value={form.requiredCount} onChange={(event) => set("requiredCount", event.target.value)} /><span className="td-unit">次</span></div>
            ) : null}
            <span className="td-label">达标线<em>任务平均分达到这条线才算达标</em></span>
            <div className="td-pills">
              {PASS_PRESETS.map((value) => <Pill key={value || "none"} on={!passCustom && form.passScore === value} onClick={() => { setPassCustom(false); set("passScore", value); }}>{value ? `${value} 分` : "不设"}</Pill>)}
              <Pill on={passCustom} onClick={() => setPassCustom(true)}>自定义</Pill>
              {passCustom ? <><Input className="td-num" type="number" min={1} max={100} value={form.passScore} onChange={(event) => set("passScore", event.target.value)} /><span className="td-unit">分</span></> : null}
            </div>
          </section>

          <h4 className="td-sec" data-step="3"><span>4</span>买家画像</h4>
          <section className="td-persona">
            {creating ? <p className="td-desc">每次接待随机生成一位买家：先定从哪些人群里抽，再定每次随机变化的沟通方式。</p> : locked("买家画像", ruleSummary(form.rule, personaNames))}
          {creating ? (
            <>
              <section className="tp-box">
                <header className="tp-box-h">
                  <span className="tp-n">1</span><b>从哪些人群里抽</b>
                  <Segmented items={[{ id: "filter" as const, label: "按条件筛选" }, { id: "pick" as const, label: "指定画像" }]} value={scopeMode} onChange={setScopeMode} />
                </header>
                {scopeMode === "filter" ? (
                  <div className="tp-rows">
                    <TpRow label="客户类型" options={[...CUSTOMER_TYPES]} value={form.rule.customerTypes} onChange={(value) => { setTypesTouched(true); setRule("customerTypes", value); }}
                      note={scenarioTypes.length && !typesTouched ? "已按场景预选" : undefined} />
                    <TpRow label="买家角色" options={[...BUYER_ROLES]} value={form.rule.buyerRoles} onChange={(value) => setRule("buyerRoles", value)} />
                    <TpRow label="消费偏好" options={[...DECISION_STYLES]} value={form.rule.decisionStyles} onChange={(value) => setRule("decisionStyles", value)} />
                    <p className="tp-foot-note">每行不选 = 不限</p>
                  </div>
                ) : (
                  <PersonaPicker personas={personas} word={pickWord} onWord={setPickWord} value={form.rule.templateIds} onChange={(value) => setRule("templateIds", value)} />
                )}
              </section>
  
              <section className="tp-box">
                <header className="tp-box-h">
                  <span className="tp-n">2</span><b>每次随机变化的</b>
                  {!varyOpen ? <span className="tp-sum">{varyCount ? ruleSummary({ ...form.rule, customerTypes: [], buyerRoles: [], decisionStyles: [], templateIds: [] }).replace(/^从「画像库全部」里抽；/, "") : "国籍、性格、情绪、语言都用画像的默认值"}</span> : <span className="tp-sum">不选就用画像的默认值</span>}
                  <Button variant="text" size="sm" onClick={() => setVaryOpen(!varyOpen)}>{varyOpen ? "收起" : "调整"}</Button>
                </header>
                {varyOpen ? (
                  <div className="tp-rows">
                    <TpRow label="国籍" options={[...NATIONALITIES]} value={form.rule.nationalityPool} onChange={(value) => setRule("nationalityPool", value)} />
                    <TpRow label="性格" options={[...PERSONALITIES]} value={form.rule.personalityPool} onChange={(value) => setRule("personalityPool", value)} />
                    <TpRow label="进店情绪" options={[...EMOTIONS]} value={form.rule.emotionPool} onChange={(value) => setRule("emotionPool", value)} />
                    <TpRow label="语言" options={Object.keys(LANGUAGE_LABELS)} labels={LANGUAGE_LABELS} value={form.rule.languages} onChange={(value) => setRule("languages", value)} note="不选跟随国籍" />
                  </div>
                ) : null}
              </section>
  
              <section className={preview?.matchCount === 0 ? "tp-result is-bad" : "tp-result"}>
                <header>
                  <Users size={16} />
                  <b>{preview ? (preview.matchCount ? `符合的画像 ${preview.matchCount} 个` : "没有符合的画像，放宽一下条件，否则不能下发") : "正在计算…"}</b>
                  {preview?.matchCount ? <Button variant="text" size="sm" icon={Dices} onClick={() => setPreviewSeed(previewSeed + 1)}>再抽一次</Button> : null}
                </header>
                {preview?.samples.length ? (
                  <ul>
                    {preview.samples.map((sample, index) => (
                      <li key={`${sample.name}-${index}`}>
                        <img src={sample.avatarUrl} alt="" />
                        <b>{sample.name}</b>
                        <span>{sample.templateName}</span>
                        <em>{sample.nationality} · {sample.personality} · {sample.emotion}</em>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            </>
          ) : null}
            </section>

          <h4 className="td-sec" data-step="4"><span>5</span>评分权重<em>想重点考核哪一项，就把它调高</em><HelpTip>{WEIGHT_MAIL_NOTE}</HelpTip></h4>
          <section className="td-box">
            {creating ? (
              <>
                <span className="td-label">从预设开始</span>
                <div className="td-pills">
                  {weightPresets(form.businessStage).map((preset) => (
                    <Pill key={preset.id} on={weightPreset === preset.id} onClick={() => { setWeightPreset(preset.id); set("weights", { ...preset.weights }); }}>
                      {preset.id === "stage" ? <Sparkles size={14} /> : null}{preset.label}
                    </Pill>
                  ))}
                </div>
              </>
            ) : <p className="td-desc">下发后不能改，保证同一任务的成绩可以互相比较。</p>}
            <div className="td-stack">
              {ASSESSMENT_DIMENSIONS.map((dim, index) => (form.weights[dim.id] ?? 0) > 0 ? (
                <i key={dim.id} style={{ width: `${form.weights[dim.id]}%`, background: WEIGHT_COLORS[index] }}>{(form.weights[dim.id] ?? 0) >= 6 ? `${form.weights[dim.id]}%` : ""}</i>
              ) : null)}
            </div>
            <div className="td-weights">
              {ASSESSMENT_DIMENSIONS.map((dim, index) => {
                const value = form.weights[dim.id] ?? 0;
                return (
                  <div key={dim.id} className="td-weight">
                    <i style={{ background: WEIGHT_COLORS[index] }} />
                    <span>{dim.label}</span>
                    <span className="td-bar"><em style={{ width: `${Math.min(100, value * 2.5)}%`, background: WEIGHT_COLORS[index] }} /></span>
                    {creating ? (
                      <span className="td-step">
                        <button type="button" disabled={value <= 0} onClick={() => { setWeightPreset(""); set("weights", rebalanceWeights(form.weights, dim.id, -5)); }}>−</button>
                        <b>{value}%</b>
                        <button type="button" disabled={value >= 60} onClick={() => { setWeightPreset(""); set("weights", rebalanceWeights(form.weights, dim.id, 5)); }}>+</button>
                      </span>
                    ) : <b className="td-weight-v">{value}%</b>}
                  </div>
                );
              })}
            </div>
            {creating ? <span className={weightSum === 100 ? "td-ok" : "td-bad"}><CircleCheck size={14} />合计 {weightSum}%{weightSum === 100 ? "。调一项时，其他项按比例自动补齐" : ""}</span> : null}
          </section>
        </div>
      </div>
    </Drawer>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={on ? "td-pill is-on" : "td-pill"} onClick={onClick}>{children}</button>;
}

/** 买家画像的一行选项：标签在左，选项在右，不再在标签下面放说明小字 */
function TpRow({ label, options, labels, value, onChange, note }: {
  label: string; options: string[]; labels?: Record<string, string>; value: string[]; onChange: (value: string[]) => void; note?: string;
}) {
  return (
    <div className="tp-row">
      <span className="tp-row-label">{label}{value.length ? <i>{value.length}</i> : null}</span>
      <div className="tp-row-opts">
        <ChipSelect options={options.map((id) => ({ id, label: labels?.[id] ?? id }))} value={value} onChange={onChange} />
        {note ? <span className="tp-row-note">{note}</span> : null}
      </div>
    </div>
  );
}

/** 指定画像：按客户类型分组的勾选列表（两列对齐、组可全选、可搜索、限高滚动） */
function PersonaPicker({ personas, word, onWord, value, onChange }: {
  personas: PersonaTemplate[]; word: string; onWord: (word: string) => void; value: string[]; onChange: (value: string[]) => void;
}) {
  const keyword = word.trim().toLowerCase();
  const shown = personas.filter((item) => !keyword || `${item.name} ${(item.concerns ?? []).join(" ")}`.toLowerCase().includes(keyword));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  return (
    <div className="pp">
      <div className="pp-bar">
        <SearchBox value={word} onChange={onWord} placeholder="搜索画像或关注点" />
        <span>已选 <b>{value.length}</b> 个</span>
        {value.length ? <Button variant="text" size="sm" onClick={() => onChange([])}>清空</Button> : null}
      </div>
      <div className="pp-list">
        {CUSTOMER_TYPES.map((type) => {
          const group = shown.filter((item) => item.customerType === type);
          if (!group.length) return null;
          const allOn = group.every((item) => value.includes(item.id));
          return (
            <div key={type} className="pp-group">
              <div className="pp-group-h">
                <span>{type}</span><em>{group.length}</em>
                <button type="button" onClick={() => onChange(allOn ? value.filter((id) => !group.some((item) => item.id === id)) : [...new Set([...value, ...group.map((item) => item.id)])])}>{allOn ? "取消全选" : "全选"}</button>
              </div>
              <div className="pp-items">
                {group.map((item) => (
                  <label key={item.id} className={value.includes(item.id) ? "pp-item is-on" : "pp-item"}>
                    <input type="checkbox" checked={value.includes(item.id)} onChange={() => toggle(item.id)} />
                    <span className="pp-name">{item.name}</span>
                    <span className="pp-meta">{(item.concerns ?? []).slice(0, 2).join("、")}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {!shown.length ? <p className="pp-none">没有匹配的画像</p> : null}
      </div>
    </div>
  );
}

