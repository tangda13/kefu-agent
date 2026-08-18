import { Check, Plus, Search } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ASSESSMENT_DIMENSIONS, BUSINESS_STAGES, BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  createTask,
  deleteTask,
  fetchClasses,
  fetchScenarios,
  fetchTeacherTasks,
  updateTask,
  type ClassSummary,
  type ScenarioSummary,
  type Session,
  type TeacherTask,
} from "../../api/client";
import { TeacherDialog } from "./widgets";

const INTERACTION_LABELS: Record<string, string> = {
  text_voice: "文字 + 语音",
  text: "仅文字",
  voice: "仅语音",
};

type StatusFilter = "all" | "published" | "closed";

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "published", label: "进行中" },
  { id: "closed", label: "已结束" },
];

function defaultWeights(): Record<string, number> {
  const base = Math.floor(100 / ASSESSMENT_DIMENSIONS.length);
  const weights: Record<string, number> = {};
  for (const dim of ASSESSMENT_DIMENSIONS) weights[dim.id] = base;
  const firstId = ASSESSMENT_DIMENSIONS[0]!.id;
  weights[firstId] = (weights[firstId] ?? 0) + (100 - base * ASSESSMENT_DIMENSIONS.length);
  return weights;
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function LiveAssignments({ session }: { session: Session }) {
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [businessStage, setBusinessStage] = useState<BusinessStage>("pre_sale");
  const [classIds, setClassIds] = useState<string[]>([]);
  const [scenarioIds, setScenarioIds] = useState<string[]>([]);
  const [interactionMode, setInteractionMode] = useState("text_voice");
  const [timeLimit, setTimeLimit] = useState<number>(30);
  const [startAt, setStartAt] = useState("");
  const [deadline, setDeadline] = useState("");
  const [weights, setWeights] = useState<Record<string, number>>(defaultWeights);
  /* 完成标准：覆盖全部场景 / 完成 N 次会话；达标线 0 = 不设线（完成即达标） */
  const [completionRule, setCompletionRule] = useState<"all_scenarios" | "conversation_count">("all_scenarios");
  const [requiredCount, setRequiredCount] = useState<number>(1);
  const [passScore, setPassScore] = useState<number>(0);
  /* 接待节奏：买家自动进线策略（依次 / 固定间隔并发 / 全部同时），是任务难度参数 */
  const [arrivalMode, setArrivalMode] = useState<"sequential" | "interval" | "all_at_once">("sequential");
  const [arrivalInterval, setArrivalInterval] = useState<number>(5);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [editing, setEditing] = useState<TeacherTask | null>(null);
  const [editName, setEditName] = useState("");
  const [editStartAt, setEditStartAt] = useState("");
  const [editDeadline, setEditDeadline] = useState("");
  const [editTimeLimit, setEditTimeLimit] = useState<number>(0);
  const [editCompletionRule, setEditCompletionRule] = useState<"all_scenarios" | "conversation_count">("all_scenarios");
  const [editRequiredCount, setEditRequiredCount] = useState<number>(1);
  const [editPassScore, setEditPassScore] = useState<number>(0);
  const [editArrivalMode, setEditArrivalMode] = useState<"sequential" | "interval" | "all_at_once">("sequential");
  const [editArrivalInterval, setEditArrivalInterval] = useState<number>(5);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");

  const load = useCallback(async () => {
    try {
      const [taskList, classList, scenarioList] = await Promise.all([
        fetchTeacherTasks(session),
        fetchClasses(session),
        fetchScenarios(session),
      ]);
      setTasks(taskList);
      setClasses(classList);
      setScenarios(scenarioList);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledScenarios = useMemo(() => scenarios.filter((item) => item.enabled), [scenarios]);
  const stageScenarios = useMemo(
    () => enabledScenarios.filter((item) => item.stage === businessStage),
    [enabledScenarios, businessStage],
  );
  const scenarioNames = useMemo(
    () => new Map(scenarios.map((item) => [item.id, item.name])),
    [scenarios],
  );
  const weightSum = useMemo(
    () => Object.values(weights).reduce((sum, value) => sum + value, 0),
    [weights],
  );

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (!keyword) return true;
      const haystack = `${task.name} ${task.classes.map((item) => item.name).join(" ")}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [tasks, statusFilter, query]);

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  function openCreate() {
    setName("");
    setBusinessStage("pre_sale");
    setClassIds([]);
    setScenarioIds([]);
    setInteractionMode("text_voice");
    setTimeLimit(30);
    setStartAt("");
    setDeadline("");
    setWeights(defaultWeights());
    setCompletionRule("all_scenarios");
    setRequiredCount(1);
    setPassScore(0);
    setArrivalMode("sequential");
    setArrivalInterval(5);
    setFormError("");
    setCreating(true);
  }

  async function submit() {
    if (busy) return;
    setFormError("");
    if (!name.trim()) return setFormError("请填写任务名称。");
    if (classIds.length === 0) return setFormError("请至少选择一个下发班级。");
    if (scenarioIds.length === 0) return setFormError("请至少选择一个实训场景。");
    if (weightSum !== 100) return setFormError(`评分权重合计须为 100，当前 ${weightSum}。`);
    if (startAt && deadline && new Date(startAt).getTime() >= new Date(deadline).getTime()) {
      return setFormError("开始时间必须早于截止时间。");
    }
    if (completionRule === "conversation_count" && (requiredCount < 1 || requiredCount > 50)) {
      return setFormError("需完成会话次数须为 1-50。");
    }
    if (arrivalMode === "interval" && (arrivalInterval < 1 || arrivalInterval > 120)) {
      return setFormError("进线间隔须为 1-120 分钟。");
    }
    setBusy(true);
    try {
      await createTask(session, {
        name: name.trim(),
        businessStage,
        scenarioIds,
        classIds,
        interactionMode,
        timeLimitMinutes: timeLimit > 0 ? timeLimit : undefined,
        startAt: startAt ? new Date(startAt).toISOString() : undefined,
        deadline: deadline ? new Date(deadline).toISOString() : undefined,
        scoringWeights: weights,
        completionRule,
        requiredCount: completionRule === "conversation_count" ? requiredCount : undefined,
        passScore: passScore > 0 ? passScore : null,
        arrivalMode,
        arrivalIntervalMinutes: arrivalMode === "interval" ? arrivalInterval : undefined,
      });
      setNotice(
        startAt && new Date(startAt).getTime() > Date.now()
          ? `任务「${name.trim()}」已创建，将于 ${new Date(startAt).toLocaleString("zh-CN")} 对学生开放`
          : `任务「${name.trim()}」已下发，所选班级学生即刻可见`,
      );
      setCreating(false);
      await load();
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function openEdit(task: TeacherTask) {
    setEditing(task);
    setEditName(task.name);
    setEditStartAt(toLocalInput(task.startAt));
    setEditDeadline(toLocalInput(task.deadline));
    setEditTimeLimit(task.timeLimitMinutes ?? 0);
    setEditCompletionRule(task.completionRule ?? "all_scenarios");
    setEditRequiredCount(task.requiredCount ?? 1);
    setEditPassScore(task.passScore ?? 0);
    setEditArrivalMode(task.arrivalMode ?? "sequential");
    setEditArrivalInterval(task.arrivalIntervalMinutes ?? 5);
    setEditError("");
  }

  async function saveEdit() {
    if (!editing || editBusy) return;
    if (!editName.trim()) return setEditError("任务名称不能为空。");
    if (editStartAt && editDeadline && new Date(editStartAt).getTime() >= new Date(editDeadline).getTime()) {
      return setEditError("开始时间必须早于截止时间。");
    }
    if (editCompletionRule === "conversation_count" && (editRequiredCount < 1 || editRequiredCount > 50)) {
      return setEditError("需完成会话次数须为 1-50。");
    }
    if (editArrivalMode === "interval" && (editArrivalInterval < 1 || editArrivalInterval > 120)) {
      return setEditError("进线间隔须为 1-120 分钟。");
    }
    setEditBusy(true);
    setEditError("");
    try {
      await updateTask(session, editing.id, {
        name: editName.trim(),
        startAt: editStartAt ? new Date(editStartAt).toISOString() : null,
        deadline: editDeadline ? new Date(editDeadline).toISOString() : null,
        timeLimitMinutes: editTimeLimit > 0 ? editTimeLimit : null,
        completionRule: editCompletionRule,
        requiredCount: editCompletionRule === "conversation_count" ? editRequiredCount : null,
        passScore: editPassScore > 0 ? editPassScore : null,
        arrivalMode: editArrivalMode,
        arrivalIntervalMinutes: editArrivalMode === "interval" ? editArrivalInterval : null,
      });
      setNotice(`任务「${editName.trim()}」已更新`);
      setEditing(null);
      await load();
    } catch (cause) {
      setEditError(errorText(cause));
    } finally {
      setEditBusy(false);
    }
  }

  async function toggleStatus(task: TeacherTask) {
    const next = task.status === "published" ? "closed" : "published";
    if (next === "closed" && !window.confirm(`确定结束任务「${task.name}」吗？结束后学生端将不再显示该任务。`)) return;
    setError("");
    try {
      await updateTask(session, task.id, { status: next });
      setNotice(next === "closed" ? `任务「${task.name}」已结束` : `任务「${task.name}」已重新开启`);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function remove(task: TeacherTask) {
    if (!window.confirm(`确定删除任务「${task.name}」吗？将同时清除学生的任务进度记录，且不可恢复。`)) return;
    setError("");
    try {
      await deleteTask(session, task.id);
      setNotice(`任务「${task.name}」已删除`);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="实训任务"
        description="创建、下发并跟踪本学期所有实训任务。"
        actions={
          <button className="primary-button" onClick={openCreate}>
            <Plus size={17} /> 新建实训任务
          </button>
        }
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <section className="panel data-panel">
        <div className="tch-toolbar">
          <div className="rec-seg" role="group" aria-label="任务状态筛选">
            {STATUS_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={option.id === statusFilter ? "active" : ""}
                aria-pressed={option.id === statusFilter}
                onClick={() => setStatusFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="tch-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={query}
              placeholder="搜索任务名称或班级"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <span className="tch-count">共 {visible.length} 个任务</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>任务名称</th>
              <th>班级</th>
              <th>业务环节</th>
              <th>截止时间</th>
              <th>完成进度</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((task) => {
              const percent = task.studentTotal > 0 ? Math.round((task.studentDone / task.studentTotal) * 100) : 0;
              const expanded = expandedId === task.id;
              const weightEntries = ASSESSMENT_DIMENSIONS.filter((dim) => (task.scoringWeights?.[dim.id] ?? 0) > 0);
              const notStarted = task.status === "published" && task.startAt != null && new Date(task.startAt).getTime() > Date.now();
              return (
                <Fragment key={task.id}>
                  <tr>
                    <td><strong>{task.name}</strong><small>下发于 {new Date(task.createdAt).toLocaleDateString("zh-CN")}</small></td>
                    <td>{task.classes.map((item) => item.name).join("、")}</td>
                    <td><span className="status-pill">{BUSINESS_STAGE_LABELS[task.businessStage]}</span></td>
                    <td>
                      {task.deadline ? new Date(task.deadline).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未设"}
                      {notStarted ? <small>{new Date(task.startAt!).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 开放</small> : null}
                    </td>
                    <td>
                      <div className="table-progress">
                        <span><i style={{ width: `${percent}%` }} /></span>
                        <small>{task.studentDone}/{task.studentTotal}</small>
                      </div>
                    </td>
                    <td>
                      <em className={notStarted ? "state-warning" : task.status === "published" ? "state-active" : "state-done"}>
                        {notStarted ? "未开始" : task.status === "published" ? "进行中" : task.status === "closed" ? "已结束" : "草稿"}
                      </em>
                    </td>
                    <td className="tch-actions">
                      <button className="text-button" onClick={() => setExpandedId(expanded ? null : task.id)}>{expanded ? "收起" : "详情"}</button>
                      <button className="text-button" onClick={() => openEdit(task)}>编辑</button>
                      <button className="text-button" onClick={() => toggleStatus(task)}>{task.status === "published" ? "结束" : "重新开启"}</button>
                      <button className="text-button tch-danger" onClick={() => remove(task)}>删除</button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="task-detail-row">
                      <td colSpan={7}>
                        <div className="task-detail">
                          <div><span>实训场景</span><strong>{task.scenarioIds.map((id) => scenarioNames.get(id) ?? id).join("、") || "—"}</strong></div>
                          <div>
                            <span>完成标准</span>
                            <strong>
                              {task.completionRule === "conversation_count"
                                ? `完成 ${task.requiredCount ?? 1} 次会话`
                                : `覆盖全部 ${task.scenarioIds.length} 个场景`}
                            </strong>
                          </div>
                          <div><span>达标线</span><strong>{task.passScore != null ? `${task.passScore} 分` : "不设线"}</strong></div>
                          <div>
                            <span>接待节奏</span>
                            <strong>
                              {task.arrivalMode === "interval"
                                ? `每 ${task.arrivalIntervalMinutes ?? 5} 分钟进线一位`
                                : task.arrivalMode === "all_at_once"
                                  ? "全部同时进线"
                                  : "依次进线"}
                            </strong>
                          </div>
                          <div><span>交互模式</span><strong>{INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode}</strong></div>
                          <div><span>限时</span><strong>{task.timeLimitMinutes != null ? `${task.timeLimitMinutes} 分钟` : "不限时"}</strong></div>
                          <div><span>开始时间</span><strong>{task.startAt ? new Date(task.startAt).toLocaleString("zh-CN") : "立即开放"}</strong></div>
                          <div><span>截止时间</span><strong>{task.deadline ? new Date(task.deadline).toLocaleString("zh-CN") : "未设截止"}</strong></div>
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
            {visible.length === 0 ? (
              <tr><td colSpan={7}><span className="muted">{tasks.length === 0 ? "还没有实训任务，点击右上角「新建实训任务」开始。" : "没有符合筛选条件的任务。"}</span></td></tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {creating ? (
        <TeacherDialog
          title="新建实训任务"
          subtitle="保存后立即对所选班级下发，学生端任务大厅即刻可见"
          size="xl"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setCreating(false)}>取消</button>
              <button className="primary-button" onClick={submit} disabled={busy || weightSum !== 100}>
                {busy ? "下发中…" : "保存并下发"}
              </button>
            </>
          }
        >
          {formError ? <p className="form-error" role="alert">{formError}</p> : null}
          <div className="tt-section">基本信息</div>
          <div className="tt-grid-2">
            <label>
              任务名称
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：清关延误客户安抚" autoFocus />
            </label>
            <label>
              业务环节
              <select
                value={businessStage}
                onChange={(event) => {
                  setBusinessStage(event.target.value as BusinessStage);
                  setScenarioIds([]);
                }}
              >
                {BUSINESS_STAGES.map((stage) => (
                  <option key={stage} value={stage}>{BUSINESS_STAGE_LABELS[stage]}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="tt-grid-2">
            <label>
              交互模式
              <select value={interactionMode} onChange={(event) => setInteractionMode(event.target.value)}>
                <option value="text_voice">文字 + 语音</option>
                <option value="text">仅文字</option>
                <option value="voice">仅语音</option>
              </select>
            </label>
            <label>
              限时（分钟，0 = 不限时）
              <input
                type="number"
                min={0}
                value={timeLimit}
                onChange={(event) => setTimeLimit(Number(event.target.value))}
              />
            </label>
            <label>
              开始时间（留空 = 立即开放）
              <input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} />
            </label>
            <label>
              截止时间（留空 = 不设截止）
              <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
            </label>
          </div>
          <p className="muted tch-dialog-hint">
            设置了开始时间的任务会立即出现在学生任务列表中并标注开放时间，但到点前无法进入——适合学期初一次性排好整学期的任务计划。
          </p>

          <div className="tt-section">下发班级</div>
          <div className="tt-chips">
            {classes.map((item) => {
              const on = classIds.includes(item.id);
              return (
                <label key={item.id} className={on ? "tt-chip on" : "tt-chip"}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setClassIds((current) => toggle(current, item.id))}
                  />
                  {on ? <Check size={13} aria-hidden="true" /> : null}
                  {item.name}
                  <small>{item.studentCount} 人</small>
                </label>
              );
            })}
            {classes.length === 0 ? <span className="tt-chips-empty">暂无班级，请先到「班级与学生」创建。</span> : null}
          </div>

          <div className="tt-section">实训场景（{BUSINESS_STAGE_LABELS[businessStage]}）</div>
          <div className="tt-chips">
            {stageScenarios.map((item) => {
              const on = scenarioIds.includes(item.id);
              return (
                <label key={item.id} className={on ? "tt-chip on" : "tt-chip"}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setScenarioIds((current) => toggle(current, item.id))}
                  />
                  {on ? <Check size={13} aria-hidden="true" /> : null}
                  {item.name}
                </label>
              );
            })}
            {stageScenarios.length === 0 ? <span className="tt-chips-empty">该环节暂无启用场景，可到「场景配置」启用。</span> : null}
          </div>

          <div className="tt-section">完成标准</div>
          <div className="tch-dialog-grid">
            <label>
              完成规则
              <select value={completionRule} onChange={(event) => setCompletionRule(event.target.value as "all_scenarios" | "conversation_count")}>
                <option value="all_scenarios">覆盖全部所选场景（每个场景至少完成一次会话）</option>
                <option value="conversation_count">完成指定次数会话</option>
              </select>
            </label>
            {completionRule === "conversation_count" ? (
              <label>
                需完成会话次数
                <input type="number" min={1} max={50} value={requiredCount} onChange={(event) => setRequiredCount(Number(event.target.value))} />
              </label>
            ) : null}
            <label>
              达标分数线（0 = 不设线，完成即达标）
              <input type="number" min={0} max={100} value={passScore} onChange={(event) => setPassScore(Number(event.target.value))} />
            </label>
            <label>
              接待节奏（买家进线方式）
              <select value={arrivalMode} onChange={(event) => setArrivalMode(event.target.value as typeof arrivalMode)}>
                <option value="sequential">依次进线：上一位客户会话结束后，下一位自动进线</option>
                <option value="interval">固定间隔：每隔 N 分钟进线一位（可能同时接待多位）</option>
                <option value="all_at_once">同时进线：开始任务后全部买家一并进线</option>
              </select>
            </label>
            {arrivalMode === "interval" ? (
              <label>
                进线间隔（分钟）
                <input type="number" min={1} max={120} value={arrivalInterval} onChange={(event) => setArrivalInterval(Number(event.target.value))} />
              </label>
            ) : null}
          </div>
          <p className="muted tch-dialog-hint">
            学生覆盖完成标准后任务自动标记完成，任务成绩 = 任务内已评会话的平均分；设置了达标线的任务会按成绩显示「达标 / 未达标」。接待节奏决定买家进线的密度，可用来控制任务难度（依次 = 新手友好，固定间隔 / 同时进线 = 考验多会话并行接待）。
          </p>

          <div className="tt-section">考核维度与权重</div>
          <div className="tt-weight-head">
            <span className={weightSum === 100 ? "tt-weight-total" : "tt-weight-total bad"}>
              合计 {weightSum} / 100
            </span>
            <button className="text-button" onClick={() => setWeights(defaultWeights())}>一键均衡分配</button>
          </div>
          <div className="tt-weight-grid">
            {ASSESSMENT_DIMENSIONS.map((dim) => (
              <label key={dim.id} className="tt-weight-row">
                <span>{dim.label}</span>
                <input
                  type="range"
                  min={0}
                  max={60}
                  value={weights[dim.id] ?? 0}
                  onChange={(event) =>
                    setWeights((current) => ({ ...current, [dim.id]: Number(event.target.value) }))
                  }
                />
                <strong>{weights[dim.id] ?? 0}%</strong>
              </label>
            ))}
          </div>
        </TeacherDialog>
      ) : null}

      {editing ? (
        <TeacherDialog
          title="编辑任务"
          subtitle="业务环节、场景与评分权重在下发后不可修改，以保证已产生成绩的可比性"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setEditing(null)}>取消</button>
              <button className="primary-button" onClick={saveEdit} disabled={editBusy}>{editBusy ? "保存中…" : "保存"}</button>
            </>
          }
        >
          {editError ? <p className="form-error" role="alert">{editError}</p> : null}
          <label>
            任务名称
            <input value={editName} onChange={(event) => setEditName(event.target.value)} />
          </label>
          <label>
            开始时间（留空 = 立即开放；未到开始时间学生不可进入）
            <input type="datetime-local" value={editStartAt} onChange={(event) => setEditStartAt(event.target.value)} />
          </label>
          <label>
            截止时间（留空 = 不设截止）
            <input type="datetime-local" value={editDeadline} onChange={(event) => setEditDeadline(event.target.value)} />
          </label>
          <label>
            限时（分钟，0 = 不限时）
            <input type="number" min={0} value={editTimeLimit} onChange={(event) => setEditTimeLimit(Number(event.target.value))} />
          </label>
          <label>
            完成规则
            <select value={editCompletionRule} onChange={(event) => setEditCompletionRule(event.target.value as "all_scenarios" | "conversation_count")}>
              <option value="all_scenarios">覆盖全部所选场景</option>
              <option value="conversation_count">完成指定次数会话</option>
            </select>
          </label>
          {editCompletionRule === "conversation_count" ? (
            <label>
              需完成会话次数
              <input type="number" min={1} max={50} value={editRequiredCount} onChange={(event) => setEditRequiredCount(Number(event.target.value))} />
            </label>
          ) : null}
          <label>
            达标分数线（0 = 不设线，完成即达标）
            <input type="number" min={0} max={100} value={editPassScore} onChange={(event) => setEditPassScore(Number(event.target.value))} />
          </label>
          <label>
            接待节奏
            <select value={editArrivalMode} onChange={(event) => setEditArrivalMode(event.target.value as typeof editArrivalMode)}>
              <option value="sequential">依次进线</option>
              <option value="interval">固定间隔进线</option>
              <option value="all_at_once">同时进线</option>
            </select>
          </label>
          {editArrivalMode === "interval" ? (
            <label>
              进线间隔（分钟）
              <input type="number" min={1} max={120} value={editArrivalInterval} onChange={(event) => setEditArrivalInterval(Number(event.target.value))} />
            </label>
          ) : null}
        </TeacherDialog>
      ) : null}
    </div>
  );
}
