import { Filter, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ASSESSMENT_DIMENSIONS, BUSINESS_STAGES, BUSINESS_STAGE_LABELS, type BusinessStage } from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  createTask,
  fetchClasses,
  fetchScenarios,
  fetchTeacherTasks,
  type ClassSummary,
  type ScenarioSummary,
  type Session,
  type TeacherTask,
} from "../../api/client";

const INTERACTION_LABELS: Record<string, string> = {
  text_voice: "文字 + 语音",
  text: "仅文字",
  voice: "仅语音",
};

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

export function LiveAssignments({ session }: { session: Session }) {
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [businessStage, setBusinessStage] = useState<BusinessStage>("pre_sale");
  const [classIds, setClassIds] = useState<string[]>([]);
  const [scenarioIds, setScenarioIds] = useState<string[]>([]);
  const [interactionMode, setInteractionMode] = useState("text_voice");
  const [timeLimit, setTimeLimit] = useState<number>(30);
  const [deadline, setDeadline] = useState("");
  const [weights, setWeights] = useState<Record<string, number>>(defaultWeights);

  const load = useCallback(async () => {
    try {
      const [taskList, classList, scenarioList] = await Promise.all([
        fetchTeacherTasks(session),
        fetchClasses(session),
        fetchScenarios(session),
      ]);
      setTasks(taskList);
      setClasses(classList);
      setScenarios(scenarioList.filter((item) => item.enabled));
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const stageScenarios = useMemo(
    () => scenarios.filter((item) => item.stage === businessStage),
    [scenarios, businessStage],
  );
  const weightSum = useMemo(
    () => Object.values(weights).reduce((sum, value) => sum + value, 0),
    [weights],
  );

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  async function submit() {
    if (busy) return;
    setError("");
    if (!name.trim()) return setError("请填写任务名称。");
    if (classIds.length === 0) return setError("请至少选择一个下发班级。");
    if (scenarioIds.length === 0) return setError("请至少选择一个实训场景。");
    if (weightSum !== 100) return setError(`评分权重合计须为 100，当前 ${weightSum}。`);
    setBusy(true);
    try {
      await createTask(session, {
        name: name.trim(),
        businessStage,
        scenarioIds,
        classIds,
        interactionMode,
        timeLimitMinutes: timeLimit > 0 ? timeLimit : undefined,
        deadline: deadline ? new Date(deadline).toISOString() : undefined,
        scoringWeights: weights,
      });
      setNotice(`任务「${name.trim()}」已下发`);
      setCreating(false);
      setName("");
      setClassIds([]);
      setScenarioIds([]);
      setWeights(defaultWeights());
      setDeadline("");
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="ASSIGNMENTS"
        title="实训任务"
        description="创建、下发并跟踪本学期所有实训任务。"
        actions={
          <button className="primary-button" onClick={() => setCreating((value) => !value)}>
            <Plus size={17} /> 新建实训任务
          </button>
        }
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {creating && (
        <section className="panel creation-form">
          <div className="panel-heading">
            <div>
              <h2>新建 / 下发任务</h2>
              <p>字段与产品基线一致；保存后立即对所选班级生效</p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              任务名称
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：清关延误客户安抚" />
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
            <label>
              交互模式
              <select value={interactionMode} onChange={(event) => setInteractionMode(event.target.value)}>
                <option value="text_voice">文字 + 语音</option>
                <option value="text">仅文字</option>
                <option value="voice">仅语音</option>
              </select>
            </label>
            <label>
              限时（分钟）
              <input
                type="number"
                min={0}
                value={timeLimit}
                onChange={(event) => setTimeLimit(Number(event.target.value))}
              />
            </label>
            <label>
              截止时间
              <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
            </label>
          </div>
          <div className="choice-group">
            <strong>下发班级</strong>
            <div>
              {classes.map((item) => (
                <label key={item.id} className="check-line">
                  <input
                    type="checkbox"
                    checked={classIds.includes(item.id)}
                    onChange={() => setClassIds((current) => toggle(current, item.id))}
                  />
                  {item.name}（{item.studentCount} 人）
                </label>
              ))}
              {classes.length === 0 ? <span className="muted">暂无班级，请先到「班级与学生」创建。</span> : null}
            </div>
          </div>
          <div className="choice-group">
            <strong>实训场景（{BUSINESS_STAGE_LABELS[businessStage]}）</strong>
            <div>
              {stageScenarios.map((item) => (
                <label key={item.id} className="check-line">
                  <input
                    type="checkbox"
                    checked={scenarioIds.includes(item.id)}
                    onChange={() => setScenarioIds((current) => toggle(current, item.id))}
                  />
                  {item.name}
                </label>
              ))}
              {stageScenarios.length === 0 ? <span className="muted">该环节暂无启用场景。</span> : null}
            </div>
          </div>
          <div className="weight-panel">
            <h3>考核维度与权重（合计须为 100，当前 {weightSum}）</h3>
            {ASSESSMENT_DIMENSIONS.map((dim) => (
              <label key={dim.id}>
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
          <div className="form-actions">
            <button className="secondary-button" onClick={() => setCreating(false)}>取消</button>
            <button className="primary-button" onClick={submit} disabled={busy || weightSum !== 100}>
              保存并下发
            </button>
          </div>
        </section>
      )}
      <section className="panel data-panel">
        <div className="table-toolbar">
          <div className="search-filter"><Filter size={16} /> 当前学期 · 全部状态</div>
          <span>共 {tasks.length} 个任务</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>任务名称</th>
              <th>班级</th>
              <th>业务环节</th>
              <th>交互模式</th>
              <th>截止时间</th>
              <th>完成进度</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const percent = task.studentTotal > 0 ? Math.round((task.studentDone / task.studentTotal) * 100) : 0;
              return (
                <tr key={task.id}>
                  <td><strong>{task.name}</strong><small>{task.id.slice(0, 8)}</small></td>
                  <td>{task.classes.map((item) => item.name).join("、")}</td>
                  <td><span className="status-pill">{BUSINESS_STAGE_LABELS[task.businessStage]}</span></td>
                  <td>{INTERACTION_LABELS[task.interactionMode] ?? task.interactionMode}</td>
                  <td>{task.deadline ? new Date(task.deadline).toLocaleString("zh-CN") : "未设"}</td>
                  <td>
                    <div className="table-progress">
                      <span><i style={{ width: `${percent}%` }} /></span>
                      <small>{task.studentDone}/{task.studentTotal}</small>
                    </div>
                  </td>
                  <td>
                    <em className={task.status === "published" ? "state-active" : "state-done"}>
                      {task.status === "published" ? "进行中" : task.status === "closed" ? "已结束" : "草稿"}
                    </em>
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 ? (
              <tr><td colSpan={7}><span className="muted">还没有实训任务，点击右上角「新建实训任务」开始。</span></td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
