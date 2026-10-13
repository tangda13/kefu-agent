import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ASSESSMENT_DIMENSIONS, BUSINESS_STAGES, BUSINESS_STAGE_LABELS, CUSTOMER_TYPES, EMOTIONS, NATIONALITIES, PERSONALITIES,
  type BusinessStage,
} from "@cecs/contracts";
import {
  ApiError, createTask, deleteTask, fetchClasses, fetchScenarios, fetchTeacherTasks, updateTask,
  type ClassSummary, type ScenarioSummary, type Session, type TeacherTask,
} from "../../api/client";
import {
  Bench, Board, Button, ChipSelect, Confirm, Drawer, Field, HeaderTabs, Input, KeyValues, MoreMenu, SearchBox, Segmented, Select,
  Status, toast,
} from "../../ui";
import { TaskRow, TaskRowHead } from "./TaskRow";

const INTERACTION_LABELS: Record<string, string> = { text_voice: "文字和语音", text: "只用文字", voice: "只用语音" };
const LANGUAGE_LABELS: Record<string, string> = { "en-US": "英语", "es-ES": "西班牙语", "fr-FR": "法语" };
const ARRIVAL_LABELS = { sequential: "一位接一位", interval: "按间隔进线", all_at_once: "同时进线" } as const;

type ArrivalMode = keyof typeof ARRIVAL_LABELS;
type CompletionRule = "all_scenarios" | "conversation_count";
type TaskTab = "active" | "upcoming" | "closed";

interface PersonaRule {
  nationalityPool?: string[];
  personalityPool?: string[];
  emotionPool?: string[];
  languages?: string[];
  customerTypes?: string[];
}

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

function defaultWeights(): Record<string, number> {
  const base = Math.floor(100 / ASSESSMENT_DIMENSIONS.length);
  const weights: Record<string, number> = {};
  for (const dim of ASSESSMENT_DIMENSIONS) weights[dim.id] = base;
  const firstId = ASSESSMENT_DIMENSIONS[0]!.id;
  weights[firstId] = (weights[firstId] ?? 0) + (100 - base * ASSESSMENT_DIMENSIONS.length);
  return weights;
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
    arrivalMode: "sequential", arrivalInterval: "5", weights: defaultWeights(),
    rule: { nationalityPool: [], personalityPool: [], emotionPool: [], languages: [], customerTypes: [] },
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
    arrivalInterval: String(task.arrivalIntervalMinutes ?? 5), weights: { ...defaultWeights(), ...task.scoringWeights },
    rule: {
      nationalityPool: rule.nationalityPool ?? [], personalityPool: rule.personalityPool ?? [], emotionPool: rule.emotionPool ?? [],
      languages: rule.languages ?? [], customerTypes: rule.customerTypes ?? [],
    },
  };
}

function taskState(task: TeacherTask): TaskTab {
  if (task.status === "closed") return "closed";
  if (task.startAt && new Date(task.startAt).getTime() > Date.now()) return "upcoming";
  return "active";
}

function ruleSummary(rule: PersonaRule | undefined): string {
  if (!rule) return "完全随机";
  const parts = [
    rule.nationalityPool?.length ? `国籍 ${rule.nationalityPool.join("、")}` : "",
    rule.personalityPool?.length ? `性格 ${rule.personalityPool.join("、")}` : "",
    rule.emotionPool?.length ? `情绪 ${rule.emotionPool.join("、")}` : "",
    rule.languages?.length ? `语言 ${rule.languages.map((item) => LANGUAGE_LABELS[item] ?? item).join("、")}` : "",
    rule.customerTypes?.length ? `客户类型 ${rule.customerTypes.join("、")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("；") : "完全随机";
}

export function LiveAssignments({ session }: { session: Session }) {
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TaskTab>("active");
  const [keyword, setKeyword] = useState("");
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

  const scenarioNames = useMemo(() => new Map(scenarios.map((item) => [item.id, item.name])), [scenarios]);
  const counts = useMemo(() => {
    const result: Record<TaskTab, number> = { active: 0, upcoming: 0, closed: 0 };
    for (const task of tasks) result[taskState(task)] += 1;
    return result;
  }, [tasks]);
  const visible = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return tasks.filter((task) => taskState(task) === tab && (!word || `${task.name} ${task.classes.map((item) => item.name).join(" ")}`.toLowerCase().includes(word)));
  }, [tasks, tab, keyword]);

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
      <HeaderTabs
        items={[
          { id: "active", label: "进行中", count: counts.active },
          { id: "upcoming", label: "未开始", count: counts.upcoming },
          { id: "closed", label: "已结束", count: counts.closed },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Bench>
        <div className="bench-bar">
          <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索任务或班级" />
          <div className="bench-bar-end"><Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>新建任务</Button></div>
        </div>
        <Board>
          <TaskRowHead timeLabel={tab === "upcoming" ? "开放时间" : "截止"} />
          {loading ? <p className="board-quiet">正在读取…</p> : visible.length === 0 ? (
            <p className="board-quiet">{keyword ? "没有匹配的任务" : tab === "active" ? "没有进行中的任务。点「新建任务」给班级下发一个。" : tab === "upcoming" ? "没有预约开放的任务。新建任务时设置“开放时间”，就会先出现在这里。" : "还没有结束的任务"}</p>
          ) : visible.map((row) => (
            <TaskRow
              key={row.id}
              task={row}
              showOpenTime={tab === "upcoming"}
              onOpen={() => setViewing(row)}
              menu={
                <MoreMenu items={[
                  { label: "编辑", onClick: () => setEditing(row) },
                  row.status === "closed"
                    ? { label: "重新开启", onClick: () => void setStatus(row, "published") }
                    : { label: "结束任务", onClick: () => setClosing(row) },
                  { label: "删除", danger: true, onClick: () => setRemoving(row) },
                ]} />
              }
            />
          ))}
        </Board>
      </Bench>

      {viewing ? (
        <Drawer
          title={viewing.name}
          width={480}
          onClose={() => setViewing(null)}
          footer={<Button onClick={() => { setEditing(viewing); setViewing(null); }}>编辑</Button>}
        >
          <KeyValues
            items={[
              { label: "状态", value: { active: <Status tone="ok">进行中</Status>, upcoming: <Status tone="warn">未开始</Status>, closed: <Status>已结束</Status> }[taskState(viewing)] },
              { label: "班级", value: viewing.classes.map((item) => item.name).join("、") || "—" },
              { label: "业务环节", value: BUSINESS_STAGE_LABELS[viewing.businessStage] },
              { label: "场景", value: viewing.scenarioIds.map((id) => scenarioNames.get(id) ?? id).join("、") || "—" },
              { label: "完成情况", value: `${viewing.studentDone} / ${viewing.studentTotal} 人完成` },
              { label: "开放时间", value: viewing.startAt ? new Date(viewing.startAt).toLocaleString("zh-CN") : "下发后立即开放" },
              { label: "截止时间", value: viewing.deadline ? new Date(viewing.deadline).toLocaleString("zh-CN") : "不设截止" },
              { label: "单次限时", value: viewing.timeLimitMinutes ? `${viewing.timeLimitMinutes} 分钟` : "不限时" },
              { label: "回复方式", value: INTERACTION_LABELS[viewing.interactionMode] ?? viewing.interactionMode },
              { label: "完成标准", value: viewing.completionRule === "conversation_count" ? `完成 ${viewing.requiredCount ?? 1} 次接待` : `每个场景至少接待一次（共 ${viewing.scenarioIds.length} 个）` },
              { label: "达标线", value: viewing.passScore != null ? `${viewing.passScore} 分` : "不设，完成即达标" },
              { label: "买家进线", value: viewing.arrivalMode === "interval" ? `每 ${viewing.arrivalIntervalMinutes ?? 5} 分钟进线一位` : ARRIVAL_LABELS[viewing.arrivalMode ?? "sequential"] },
              { label: "买家画像", value: ruleSummary(viewing.personaRule as PersonaRule | undefined) },
              { label: "评分权重", value: ASSESSMENT_DIMENSIONS.map((dim) => `${dim.label} ${viewing.scoringWeights?.[dim.id] ?? 0}%`).join("、") },
            ]}
          />
        </Drawer>
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

  const stageScenarios = scenarios.filter((item) => item.enabled && item.stage === form.businessStage);
  const weightSum = Object.values(form.weights).reduce((sum, value) => sum + value, 0);

  async function save() {
    const name = form.name.trim();
    const timeLimit = Number(form.timeLimit) || 0;
    const passScore = Number(form.passScore) || 0;
    const requiredCount = Number(form.requiredCount) || 0;
    const interval = Number(form.arrivalInterval) || 0;
    if (!name) return setError("请填写任务名称。");
    if (creating && form.classIds.length === 0) return setError("请至少选一个班级。");
    if (creating && form.scenarioIds.length === 0) return setError("请至少选一个场景。");
    if (creating && weightSum !== 100) return setError(`评分权重合计要等于 100，现在是 ${weightSum}。`);
    if (form.startAt && form.deadline && new Date(form.startAt) >= new Date(form.deadline)) return setError("开放时间要早于截止时间。");
    if (form.completionRule === "conversation_count" && (requiredCount < 1 || requiredCount > 50)) return setError("接待次数填 1–50。");
    if (form.arrivalMode === "interval" && (interval < 1 || interval > 120)) return setError("进线间隔填 1–120 分钟。");
    if (passScore < 0 || passScore > 100) return setError("达标线填 0–100。");
    setError("");
    setBusy(true);
    const common = {
      name,
      timeLimitMinutes: timeLimit > 0 ? timeLimit : null,
      startAt: form.startAt ? new Date(form.startAt).toISOString() : null,
      deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
      completionRule: form.completionRule,
      requiredCount: form.completionRule === "conversation_count" ? requiredCount : null,
      passScore: passScore > 0 ? passScore : null,
      arrivalMode: form.arrivalMode,
      arrivalIntervalMinutes: form.arrivalMode === "interval" ? interval : null,
    };
    try {
      if (creating) {
        const rule = Object.fromEntries(Object.entries(form.rule).filter(([, value]) => value.length > 0));
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
          personaRule: rule,
        });
        toast.ok(form.startAt && new Date(form.startAt).getTime() > Date.now()
          ? `已创建，${new Date(form.startAt).toLocaleString("zh-CN")} 对学生开放`
          : "已下发，学生现在就能看到");
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

  return (
    <Drawer
      title={creating ? "新建任务" : "编辑任务"}
      width={720}
      onClose={onClose}
      footer={
        <>
          {error ? <span className="drawer-error" role="alert">{error}</span> : null}
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>{creating ? "下发" : "保存"}</Button>
        </>
      }
    >
      <div className="form-block">
        <div className="form-grid-2">
          <Field label="任务名称"><Input value={form.name} onChange={(event) => set("name", event.target.value)} placeholder="例如：清关延误安抚" autoFocus /></Field>
          <Field label="业务环节" hint={creating ? undefined : "下发后不能改"}>
            <Select value={form.businessStage} disabled={!creating} onChange={(event) => setForm((current) => ({ ...current, businessStage: event.target.value as BusinessStage, scenarioIds: [] }))}>
              {BUSINESS_STAGES.map((stage) => <option key={stage} value={stage}>{BUSINESS_STAGE_LABELS[stage]}</option>)}
            </Select>
          </Field>
        </div>
      </div>

      <div className="form-block">
        <h3>下发给哪些班级</h3>
        <ChipSelect
          options={classes.map((item) => ({ id: item.id, label: item.name, meta: `${item.studentCount} 人` }))}
          value={form.classIds}
          onChange={(value) => set("classIds", value)}
          disabled={!creating}
          empty="还没有班级，先到「班级与学生」新建"
        />
      </div>

      <div className="form-block">
        <h3>练哪些场景</h3>
        <p className="form-block-desc">只列出「{BUSINESS_STAGE_LABELS[form.businessStage]}」里已启用的场景。</p>
        <ChipSelect
          options={stageScenarios.map((item) => ({ id: item.id, label: item.name }))}
          value={form.scenarioIds}
          onChange={(value) => set("scenarioIds", value)}
          disabled={!creating}
          empty="这个环节还没有启用的场景，先到「场景配置」启用"
        />
      </div>

      <div className="form-block">
        <h3>时间</h3>
        <div className="form-grid-2">
          <Field label="开放时间" hint="留空表示下发后立即开放"><Input type="datetime-local" value={form.startAt} onChange={(event) => set("startAt", event.target.value)} /></Field>
          <Field label="截止时间" hint="留空表示不设截止"><Input type="datetime-local" value={form.deadline} onChange={(event) => set("deadline", event.target.value)} /></Field>
          <Field label="单次接待限时" hint="分钟，留空表示不限时"><Input type="number" min={0} value={form.timeLimit} onChange={(event) => set("timeLimit", event.target.value)} /></Field>
          <Field label="回复方式" hint={creating ? undefined : "下发后不能改"}>
            <Select value={form.interactionMode} disabled={!creating} onChange={(event) => set("interactionMode", event.target.value)}>
              {Object.entries(INTERACTION_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </Select>
          </Field>
        </div>
      </div>

      <div className="form-block">
        <h3>完成与达标</h3>
        <div className="form-grid-2">
          <Field label="怎样算完成">
            <Select value={form.completionRule} onChange={(event) => set("completionRule", event.target.value as CompletionRule)}>
              <option value="all_scenarios">每个场景至少接待一次</option>
              <option value="conversation_count">接待满指定次数</option>
            </Select>
          </Field>
          {form.completionRule === "conversation_count" ? (
            <Field label="接待次数"><Input type="number" min={1} max={50} value={form.requiredCount} onChange={(event) => set("requiredCount", event.target.value)} /></Field>
          ) : (
            <Field label="达标线" hint="0–100 分，留空表示完成即达标"><Input type="number" min={0} max={100} value={form.passScore} onChange={(event) => set("passScore", event.target.value)} /></Field>
          )}
          {form.completionRule === "conversation_count" ? (
            <Field label="达标线" hint="0–100 分，留空表示完成即达标"><Input type="number" min={0} max={100} value={form.passScore} onChange={(event) => set("passScore", event.target.value)} /></Field>
          ) : null}
        </div>
      </div>

      <div className="form-block">
        <h3>买家怎么进线</h3>
        <p className="form-block-desc">决定学生同时要接待几位买家，是控制难度的主要手段。</p>
        <Segmented
          items={(Object.keys(ARRIVAL_LABELS) as ArrivalMode[]).map((id) => ({ id, label: ARRIVAL_LABELS[id] }))}
          value={form.arrivalMode}
          onChange={(value) => set("arrivalMode", value)}
        />
        <p className="form-block-desc form-block-after">
          {form.arrivalMode === "sequential" ? "上一位接待结束，下一位才进来。适合刚开始练。"
            : form.arrivalMode === "interval" ? "每隔一段时间进来一位，可能同时接待好几位。"
              : "开始后所有买家一起进来，考验多会话并行接待。"}
        </p>
        {form.arrivalMode === "interval" ? (
          <Field label="进线间隔" hint="分钟" className="form-narrow-field"><Input type="number" min={1} max={120} value={form.arrivalInterval} onChange={(event) => set("arrivalInterval", event.target.value)} /></Field>
        ) : null}
      </div>

      <div className="form-block">
        <h3>买家画像</h3>
        <p className="form-block-desc">
          {creating ? "每次接待都会随机生成一位买家。下面不选就是完全随机，选了就只在选中的范围里抽。" : `下发后不能改。当前：${ruleSummary(form.rule)}`}
        </p>
        {creating ? (
          <div className="rule-grid">
            <RuleRow label="国籍" options={[...NATIONALITIES]} value={form.rule.nationalityPool} onChange={(value) => setRule("nationalityPool", value)} />
            <RuleRow label="性格" options={[...PERSONALITIES]} value={form.rule.personalityPool} onChange={(value) => setRule("personalityPool", value)} />
            <RuleRow label="情绪" options={[...EMOTIONS]} value={form.rule.emotionPool} onChange={(value) => setRule("emotionPool", value)} />
            <RuleRow label="语言" options={Object.keys(LANGUAGE_LABELS)} labels={LANGUAGE_LABELS} value={form.rule.languages} onChange={(value) => setRule("languages", value)} hint="按国籍" />
            <RuleRow label="客户类型" options={[...CUSTOMER_TYPES]} value={form.rule.customerTypes} onChange={(value) => setRule("customerTypes", value)} />
          </div>
        ) : null}
      </div>

      <div className="form-block">
        <h3>评分权重</h3>
        <p className="form-block-desc">
          {creating
            ? <>想重点考核哪一项，就把它调高。<span className={weightSum === 100 ? "weight-sum" : "weight-sum is-bad"}>合计 {weightSum} / 100</span>
              {weightSum !== 100 ? <Button variant="text" size="sm" onClick={() => set("weights", defaultWeights())}>平均分配</Button> : null}</>
            : "下发后不能改，保证同一任务的成绩可以互相比较。"}
        </p>
        <div className="weight-rows">
          {ASSESSMENT_DIMENSIONS.map((dim) => (
            <label key={dim.id} className="weight-row">
              <span>{dim.label}</span>
              <input
                type="range" min={0} max={60} step={1} disabled={!creating}
                value={form.weights[dim.id] ?? 0}
                onChange={(event) => set("weights", { ...form.weights, [dim.id]: Number(event.target.value) })}
              />
              <strong>{form.weights[dim.id] ?? 0}%</strong>
            </label>
          ))}
        </div>
      </div>
    </Drawer>
  );
}

function RuleRow({ label, options, labels, value, onChange, hint }: {
  label: string; options: string[]; labels?: Record<string, string>; value: string[]; onChange: (value: string[]) => void; hint?: string;
}) {
  return (
    <div className="rule-row">
      <span className="rule-row-label">{label}<small>{value.length ? `已选 ${value.length}` : hint ?? "随机"}</small></span>
      <ChipSelect options={options.map((id) => ({ id, label: labels?.[id] ?? id }))} value={value} onChange={onChange} />
    </div>
  );
}
