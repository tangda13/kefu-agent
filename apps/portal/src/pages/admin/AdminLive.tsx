import { Activity, CircleCheck, ClipboardCheck, Database, Download, FileUp, MessagesSquare, Play, Plus, Search, ShieldAlert, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError, apiGet, apiPost, apiRequestPatch,
  addContentTerm, assignClassTeachers, createBackup, createClassAsAdmin, deleteContentTerm, downloadWithAuth,
  fetchAdminSystem, fetchAdminTeachers, fetchBackupSchedule, fetchBackups, fetchClassStudents, fetchClasses,
  fetchContentTerms, importContentTerms, importStudents, resetStudentPassword, resetTeacherPassword, saveBackupSchedule,
  setContentTermEnabled,
  type AdminSystemOverview, type AdminTeacher, type BackupFile, type BackupSchedule, type ClassStudent, type ClassSummary,
  type ContentKind, type ContentTerm, type ImportResult, type ServiceStatus, type Session,
} from "../../api/client";
import {
  Button, Callout, Confirm, DataTable, Dialog, Empty, Field, Figures, Gauge, HeaderTabs, HelpTip, Input, ListRow, MoreMenu, Section,
  SearchBox, Select, SettingSection, Sheet, Status, StatusHero, Switch, Tag, Textarea, Toolbar, toast,
} from "../../ui";
import { PasswordNotice } from "../../components/AccountDialogs";
import type { LlmTestResult } from "@cecs/contracts";
import { openProvidersTab } from "./providersTab";

/* 管理端：系统总览（运行状态）· 账号与权限 · 内容资源库 · 数据与备份。P4 按 DESIGN.md 2.0 重做（E3–E6）。 */

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试");
const formatTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const statusLabel: Record<ServiceStatus, string> = { ok: "正常", warn: "有异常", error: "故障", off: "未配置" };

/** 一次性显示的初始密码 / 临时密码 */
// ======================================================================
// 系统总览 · 运行状态
// ======================================================================

export function AdminSystem({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [data, setData] = useState<AdminSystemOverview | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [retesting, setRetesting] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchAdminSystem(session)
      .then((next) => {
        setData(next);
        setCheckedAt(new Date());
      })
      .catch((cause) => toast.error(errorText(cause)));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  /** 告警里的“重新测试”：通过后网关解除熔断，提醒随之消失 */
  async function retest(profileId: string) {
    setRetesting(profileId);
    try {
      const result = await apiPost<LlmTestResult>(`/v1/admin/llm/profiles/${profileId}/test`, session);
      if (result.ok) toast.ok("测试通过，已切回主模型");
      else toast.error(`测试没通过：${(result.error ?? "").split("\n")[0]!.slice(0, 120)}`);
      load();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setRetesting(null);
    }
  }

  async function backupNow() {
    setBackingUp(true);
    try {
      const result = await createBackup(session);
      toast.ok(result.removed > 0 ? `备份完成（${formatSize(result.size)}），已清理 ${result.removed} 份旧备份` : `备份完成（${formatSize(result.size)}）`);
      load();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBackingUp(false);
    }
  }

  const uptime = data?.version.uptimeSeconds ?? 0;
  const uptimeText = `${Math.floor(uptime / 86400) ? `${Math.floor(uptime / 86400)} 天 ` : ""}${Math.floor((uptime % 86400) / 3600)} 小时`;
  const broken = data?.services.filter((item) => item.status === "error") ?? [];
  const fine = data?.services.filter((item) => item.status === "ok") ?? [];
  const alerts = data?.alerts ?? [];
  const hero = !data
    ? { tone: "ok" as const, icon: Activity, title: "正在检测…", desc: "" }
    : broken.length > 0 && broken.length === data.services.length
      ? { tone: "danger" as const, icon: ShieldAlert, title: "服务故障", desc: "所有服务都无法正常工作，请检查服务器。" }
      : alerts.length > 0 || broken.length > 0
        ? { tone: "warn" as const, icon: TriangleAlert, title: `系统基本正常，有 ${alerts.length || broken.length} 项需要处理`, desc: `${fine.map((item) => item.name).join("、") || "暂无服务"}运行正常${broken.length ? `；${broken.map((item) => item.name).join("、")}有故障` : ""}。` }
        : { tone: "ok" as const, icon: CircleCheck, title: "系统运行正常", desc: "数据库、对话模型、语音服务和数据备份都没有问题。" };

  return (
    <Sheet>
      <StatusHero
        tone={hero.tone}
        icon={hero.icon}
        title={hero.title}
        desc={hero.desc}
        meta={data ? <>服务端 {data.version.server} · 数据库结构 {data.version.schema.slice(0, 3)}<br />已连续运行 {uptimeText}{checkedAt ? ` · ${checkedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 检测` : ""}</> : null}
      />
      {alerts.length ? (
        <div className="callout-stack">
          {alerts.map((alert) => (
            <Callout
              key={alert.title}
              tone={alert.level === "danger" ? "danger" : "warn"}
              icon={alert.page === "backup" ? Database : TriangleAlert}
              title={alert.title}
              actions={
                alert.page === "backup" ? (
                  <>
                    <Button size="sm" loading={backingUp} onClick={() => void backupNow()}>立即备份</Button>
                    {onNavigate ? <Button size="sm" variant="ghost" onClick={() => onNavigate("backup")}>查看备份</Button> : null}
                  </>
                ) : onNavigate && alert.page !== "system" ? (
                  <>
                    {alert.action?.kind === "test-profile" ? (
                      <Button size="sm" loading={retesting === alert.action.profileId} onClick={() => void retest(alert.action!.profileId)}>重新测试</Button>
                    ) : null}
                    <Button size="sm" variant={alert.action ? "ghost" : undefined} onClick={() => { openProvidersTab(alert.tab); onNavigate(alert.page); }}>去处理</Button>
                  </>
                ) : null
              }
            >
              {alert.detail}
            </Callout>
          ))}
        </div>
      ) : null}
      <Figures
        items={[
          { label: "学生账号", value: data?.counts.students, extra: "容量 200 人" },
          { label: "教师账号", value: data?.counts.teachers },
          { label: "累计对话", value: data?.counts.conversations },
          { label: "累计消息", value: data?.counts.messages },
          { label: "已完成评分", value: data?.counts.assessments },
        ]}
      />
      <div className="sec-cols">
        <Section title="服务状态" desc="每次打开本页时实时检测" actions={<Button size="sm" variant="ghost" onClick={load}>重新检测</Button>}>
          <div className="svc-list">
            {(data?.services ?? []).map((item) => (
              <div key={item.key} className="svc-row">
                <i className={`svc-dot is-${item.status}`} aria-label={statusLabel[item.status]} />
                <strong>{item.name}</strong>
                <span>{item.detail}</span>
              </div>
            ))}
          </div>
        </Section>
        <AcceptanceSection session={session} />
      </div>
    </Sheet>
  );
}

interface AcceptanceReport {
  llm: {
    totalRequests: number; validRequests: number; errorRequests: number; timeoutRequests: number; sampleEnough: boolean;
    ttftP50: number | null; ttftP95: number | null; ttftP99: number | null; ttftMax: number | null;
    ttftRate3s: number | null; ttftRate10s: number | null; charsPerSecond: number | null; passTtft: boolean; passSpeed: boolean;
    recentFailures: Array<{ at: string; model: string; outcome: string }>;
  };
  voice: Record<string, { total: number; avgMs: number; maxMs: number; within5sRate: number | null }>;
  run?: { running: boolean; done: number; total: number } | null;
}

/** 参数 2.1.3 / 2.1.4 的性能红线：进度条 + 要求线 */
function AcceptanceSection({ session }: { session: Session }) {
  const [report, setReport] = useState<AcceptanceReport | null>(null);
  const load = useCallback(() => {
    apiGet<AcceptanceReport>("/v1/admin/acceptance", session).then(setReport).catch(() => undefined);
  }, [session]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function run() {
    try {
      await apiPost("/v1/admin/acceptance/run", session, { samples: 100 });
      toast.ok("验收已开始，后台执行 100 次真实对话请求");
      load();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const L = report?.llm;
  const sec = (ms: number | null | undefined) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} 秒`);
  const rate = (value: number | null | undefined) => (value == null ? null : Math.round(value * 1000) / 10);
  const r3 = rate(L?.ttftRate3s);
  const r10 = rate(L?.ttftRate10s);
  /** “越大越好”的指标：标尺取要求的 5 倍或实测值，取大 */
  const higher = (value: number | null | undefined, requirement: number) => {
    if (value == null) return { percent: null, at: undefined };
    const max = Math.max(requirement * 5, value * 1.15);
    return { percent: (value / max) * 100, at: (requirement / max) * 100 };
  };
  /** “越小越好”的耗时：标尺取要求的 1.6 倍或实测值，取大 */
  const lower = (ms: number | null | undefined, limitMs: number) => {
    if (ms == null) return { percent: null, at: undefined };
    const max = Math.max(limitMs * 1.6, ms * 1.15);
    return { percent: (ms / max) * 100, at: (limitMs / max) * 100 };
  };
  const speed = higher(L?.charsPerSecond, 20);
  const tts = report?.voice?.tts;
  const asr = report?.voice?.asr;
  const ttsBar = lower(tts?.avgMs, 5000);
  const asrBar = lower(asr?.avgMs, 5000);

  return (
    <Section
      title={<>性能验收<HelpTip>按全部真实对话请求统计：首字时间从服务端收到请求时算起，失败和超时也计入分母。验收需要至少 100 次请求。竖线是参数要求的红线。</HelpTip></>}
      desc={L ? `共 ${L.totalRequests} 次请求 · 失败 ${L.errorRequests} · 超时 ${L.timeoutRequests}` : "暂无请求记录"}
      actions={
        <>
          <Button size="sm" variant="ghost" icon={Download} onClick={() => void downloadWithAuth(session, "/v1/admin/acceptance.csv", `验收明细-${new Date().toISOString().slice(0, 10)}.csv`).catch((cause) => toast.error(errorText(cause)))}>导出明细</Button>
          {report?.run?.running ? <Tag tone="accent">验收中 {report.run.done}/{report.run.total}</Tag> : <Button size="sm" icon={Play} onClick={() => void run()}>运行 100 次验收</Button>}
        </>
      }
    >
      <Gauge
        label="首字 3 秒内"
        requirement="≥ 99%"
        value={`${r3}%`}
        percent={r3}
        requirementAt={99}
        pass={L ? L.passTtft : null}
        note={L ? `中位 ${sec(L.ttftP50)} · 最慢 ${sec(L.ttftMax)}` : undefined}
        diff={r3 != null && r3 < 99 ? `差 ${(99 - r3).toFixed(1)} 个百分点` : undefined}
      />
      <Gauge label="首字 10 秒内" requirement="100%" value={`${r10}%`} percent={r10} requirementAt={99.7} pass={r10 == null ? null : r10 >= 100} />
      <Gauge label="输出速度" requirement="≥ 20 字/秒" value={`${L?.charsPerSecond} 字/秒`} percent={speed.percent} requirementAt={speed.at} pass={L ? L.passSpeed : null} />
      <Gauge label="语音朗读" requirement="≤ 5 秒" value={`平均 ${sec(tts?.avgMs)}`} percent={ttsBar.percent} requirementAt={ttsBar.at} pass={tts ? (tts.within5sRate ?? 0) >= 1 : null} note={tts ? `最慢 ${sec(tts.maxMs)}` : undefined} />
      <Gauge label="语音识别" requirement="≤ 5 秒" value={`平均 ${sec(asr?.avgMs)}`} percent={asrBar.percent} requirementAt={asrBar.at} pass={asr ? (asr.within5sRate ?? 0) >= 1 : null} note={asr ? `最慢 ${sec(asr.maxMs)}` : undefined} />
    </Section>
  );
}


// ======================================================================
// 账号与权限
// ======================================================================

type AccountTab = "teachers" | "classes" | "students";

export function AdminAccounts({ session }: { session: Session }) {
  const [tab, setTab] = useState<AccountTab>("teachers");
  const [teachers, setTeachers] = useState<AdminTeacher[]>([]);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    Promise.all([fetchAdminTeachers(session), fetchClasses(session)])
      .then(([teacherList, classList]) => {
        setTeachers(teacherList);
        setClasses(classList);
      })
      .catch((cause) => toast.error(errorText(cause)))
      .finally(() => setLoading(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <HeaderTabs
          items={[
            { id: "teachers", label: "教师账号", count: teachers.length },
            { id: "classes", label: "班级与授权", count: classes.length },
            { id: "students", label: "学生账号", count: classes.reduce((sum, item) => sum + item.studentCount, 0) },
          ]}
          value={tab}
          onChange={setTab}
        />
      <Sheet>
        {tab === "teachers" ? <TeacherAccounts session={session} teachers={teachers} loading={loading} reload={load} /> : null}
        {tab === "classes" ? <ClassAuthorization session={session} teachers={teachers} classes={classes} loading={loading} reload={load} /> : null}
        {tab === "students" ? <StudentAccounts session={session} classes={classes} reload={load} /> : null}
      </Sheet>
    </>
  );
}

function TeacherAccounts({ session, teachers, loading, reload }: { session: Session; teachers: AdminTeacher[]; loading: boolean; reload: () => void }) {
  const [keyword, setKeyword] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "" });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<AdminTeacher | null>(null);
  const [passwords, setPasswords] = useState<{ title: string; rows: Array<{ name: string; account: string; password: string }> } | null>(null);

  const visible = teachers.filter((t) => `${t.displayName}${t.username}`.toLowerCase().includes(keyword.trim().toLowerCase()));

  async function create() {
    if (!form.username.trim() || !form.displayName.trim()) {
      setFormError("请填写账号和姓名");
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<{ initialPassword?: string }>("/v1/admin/teachers", session, { username: form.username.trim(), displayName: form.displayName.trim() });
      setCreating(false);
      if (result.initialPassword) setPasswords({ title: "教师已创建", rows: [{ name: form.displayName.trim(), account: form.username.trim(), password: result.initialPassword }] });
      else toast.ok("教师已创建");
      setForm({ username: "", displayName: "" });
      reload();
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(t: AdminTeacher) {
    try {
      await apiRequestPatch(`/v1/admin/teachers/${t.id}`, session, { status: t.status === "active" ? "disabled" : "active" });
      toast.ok(t.status === "active" ? `已停用 ${t.displayName}，对方会立即退出登录` : `已启用 ${t.displayName}`);
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function confirmReset() {
    if (!resetting) return;
    setBusy(true);
    try {
      const { temporaryPassword } = await resetTeacherPassword(session, resetting.id);
      setPasswords({ title: "密码已重置", rows: [{ name: resetting.displayName, account: resetting.username, password: temporaryPassword }] });
      setResetting(null);
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Toolbar actions={<Button variant="primary" icon={Plus} onClick={() => { setFormError(""); setCreating(true); }}>新增教师</Button>}>
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索姓名或账号" />
      </Toolbar>
      <DataTable
          loading={loading}
          rows={visible}
          rowKey={(row) => row.id}
          empty={keyword ? "没有匹配的教师" : "还没有教师账号"}
          columns={[
            { key: "name", title: "姓名", render: (row) => <>{row.displayName}{row.mustChangePassword ? <small>尚未修改初始密码</small> : null}</> },
            { key: "account", title: "账号", render: (row) => row.username },
            { key: "classes", title: "负责班级", width: 160, render: (row) => (row.classCount ? <>{row.classCount} 个{row.headClassCount ? <span className="faint">（班主任 {row.headClassCount}）</span> : null}</> : <span className="faint">未分配</span>) },
            { key: "status", title: "状态", width: 100, render: (row) => (row.status === "active" ? <Status tone="ok">启用</Status> : <Status tone="danger">停用</Status>) },
            {
              key: "ops", title: "操作", width: 140, render: (row) => (
                <span className="ui-row-actions">
                  <Button variant="text" onClick={() => setResetting(row)}>重置密码</Button>
                  <MoreMenu items={[{ label: row.status === "active" ? "停用账号" : "启用账号", danger: row.status === "active", onClick: () => void toggle(row) }]} />
                </span>
              ),
            },
          ]}
        />

      {creating ? (
        <Dialog
          title="新增教师"
          onClose={() => setCreating(false)}
          footer={<><Button onClick={() => setCreating(false)}>取消</Button><Button variant="primary" loading={busy} onClick={() => void create()}>创建</Button></>}
        >
          <Field label="账号" hint="登录用，建议用姓名拼音，如 li.teacher" error={formError}>
            <Input autoFocus value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </Field>
          <Field label="姓名"><Input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="如 李老师" /></Field>
          <p className="faint">创建后系统生成初始密码，教师首次登录时需要修改。</p>
        </Dialog>
      ) : null}
      {resetting ? (
        <Confirm title="重置密码" confirmText="重置" busy={busy} onConfirm={() => void confirmReset()} onClose={() => setResetting(null)}>
          重置 {resetting.displayName}（{resetting.username}）的密码后，原密码立即失效，对方会被强制退出登录。
        </Confirm>
      ) : null}
      {passwords ? <PasswordNotice title={passwords.title} rows={passwords.rows} onClose={() => setPasswords(null)} /> : null}
    </>
  );
}

/** 班级与授权：班主任一位（classes.head_teacher_id），任课教师可多位（teacher_classes） */
function ClassAuthorization({ session, teachers, classes, loading, reload }: { session: Session; teachers: AdminTeacher[]; classes: ClassSummary[]; loading: boolean; reload: () => void }) {
  const activeTeachers = teachers.filter((t) => t.status === "active");
  const [creating, setCreating] = useState(false);
  const [newClass, setNewClass] = useState({ name: "", headTeacherId: "" });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ classId: string; name: string; headTeacherId: string; teacherIds: string[] } | null>(null);

  async function create() {
    if (!newClass.name.trim()) {
      setFormError("请填写班级名称");
      return;
    }
    setBusy(true);
    try {
      await createClassAsAdmin(session, newClass.name.trim(), newClass.headTeacherId || null);
      toast.ok(`班级「${newClass.name.trim()}」已创建`);
      setCreating(false);
      setNewClass({ name: "", headTeacherId: "" });
      reload();
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      await assignClassTeachers(session, editing.classId, editing.headTeacherId || null, editing.teacherIds);
      toast.ok("授权已保存，教师刷新后就能看到这个班级");
      setEditing(null);
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Toolbar actions={<Button variant="primary" icon={Plus} onClick={() => { setFormError(""); setCreating(true); }}>新建班级</Button>}>
        <span className="toolbar-hint">班主任和任课教师都能管理本班学生、给本班下发任务<HelpTip>一个班级只有一位班主任，可以有多位任课教师。</HelpTip></span>
      </Toolbar>
      <DataTable
          loading={loading}
          rows={classes}
          rowKey={(row) => row.id}
          empty="还没有班级"
          columns={[
            { key: "name", title: "班级", render: (row) => row.name },
            { key: "students", title: "学生", width: 90, align: "right", render: (row) => row.studentCount },
            { key: "head", title: "班主任", width: 160, render: (row) => row.headTeacherName ?? <Status tone="warn">未指定</Status> },
            { key: "teachers", title: "任课教师", render: (row) => (row.teachers.length ? row.teachers.map((t) => t.displayName).join("、") : <span className="faint">无</span>) },
            { key: "ops", title: "操作", width: 100, render: (row) => <Button variant="text" onClick={() => setEditing({ classId: row.id, name: row.name, headTeacherId: row.headTeacherId ?? "", teacherIds: row.teachers.map((t) => t.id) })}>修改授权</Button> },
          ]}
        />

      {creating ? (
        <Dialog
          title="新建班级"
          onClose={() => setCreating(false)}
          footer={<><Button onClick={() => setCreating(false)}>取消</Button><Button variant="primary" loading={busy} onClick={() => void create()}>创建</Button></>}
        >
          <Field label="班级名称" error={formError}><Input autoFocus value={newClass.name} onChange={(event) => setNewClass({ ...newClass, name: event.target.value })} placeholder="如 跨境电商2603班" /></Field>
          <Field label="班主任">
            <Select value={newClass.headTeacherId} onChange={(event) => setNewClass({ ...newClass, headTeacherId: event.target.value })}>
              <option value="">暂不指定</option>
              {activeTeachers.map((t) => <option key={t.id} value={t.id}>{t.displayName}（{t.username}）</option>)}
            </Select>
          </Field>
        </Dialog>
      ) : null}
      {editing ? (
        <Dialog
          title={`修改授权 · ${editing.name}`}
          onClose={() => setEditing(null)}
          footer={<><Button onClick={() => setEditing(null)}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button></>}
        >
          <Field label="班主任">
            <Select
              value={editing.headTeacherId}
              onChange={(event) => setEditing({ ...editing, headTeacherId: event.target.value, teacherIds: editing.teacherIds.filter((id) => id !== event.target.value) })}
            >
              <option value="">暂不指定</option>
              {activeTeachers.map((t) => <option key={t.id} value={t.id}>{t.displayName}（{t.username}）</option>)}
            </Select>
          </Field>
          <div className="ui-field">
            <span className="ui-field-label">任课教师</span>
            <div className="check-grid">
              {activeTeachers.filter((t) => t.id !== editing.headTeacherId).map((t) => (
                <label key={t.id} className="check-item">
                  <input
                    type="checkbox"
                    checked={editing.teacherIds.includes(t.id)}
                    onChange={() => setEditing({ ...editing, teacherIds: editing.teacherIds.includes(t.id) ? editing.teacherIds.filter((id) => id !== t.id) : [...editing.teacherIds, t.id] })}
                  />
                  {t.displayName}<span className="faint">{t.username}</span>
                </label>
              ))}
              {activeTeachers.filter((t) => t.id !== editing.headTeacherId).length === 0 ? <span className="faint">没有其他启用的教师</span> : null}
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** 学生账号（E3）：管理端也能批量导入和重置密码，复用教师端接口 */
function StudentAccounts({ session, classes, reload }: { session: Session; classes: ClassSummary[]; reload: () => void }) {
  const [classId, setClassId] = useState("");
  const [students, setStudents] = useState<ClassStudent[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<ClassStudent | null>(null);
  const [passwords, setPasswords] = useState<{ title: string; rows: Array<{ name: string; account: string; password: string }> } | null>(null);

  useEffect(() => {
    if (!classId && classes[0]) setClassId(classes[0].id);
  }, [classes, classId]);
  const loadStudents = useCallback(() => {
    if (!classId) return;
    setLoading(true);
    fetchClassStudents(session, classId).then(setStudents).catch((cause) => toast.error(errorText(cause))).finally(() => setLoading(false));
  }, [session, classId]);
  useEffect(() => { loadStudents(); }, [loadStudents]);

  const visible = students.filter((s) => `${s.displayName}${s.username}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  const className = classes.find((item) => item.id === classId)?.name ?? "";

  async function submitImport() {
    const rows = importText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [username = "", displayName = "", password = ""] = line.split(/[,，\t]/).map((part) => part.trim());
      return password ? { username, displayName, password } : { username, displayName };
    });
    if (rows.length === 0) {
      setImportError("每行一个学生：学号,姓名 或 学号,姓名,初始密码");
      return;
    }
    setBusy(true);
    setImportError("");
    try {
      const result = await importStudents(session, classId, rows);
      setImportResult(result);
      setImportText("");
      loadStudents();
      reload();
    } catch (cause) {
      setImportError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset() {
    if (!resetting) return;
    setBusy(true);
    try {
      const { temporaryPassword } = await resetStudentPassword(session, resetting.id);
      setPasswords({ title: "密码已重置", rows: [{ name: resetting.displayName, account: resetting.username, password: temporaryPassword }] });
      setResetting(null);
      loadStudents();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (classes.length === 0) return <Empty>还没有班级，先在「班级与授权」里新建班级</Empty>;

  return (
    <>
      <Toolbar actions={<Button variant="primary" icon={FileUp} onClick={() => { setImportResult(null); setImportError(""); setImporting(true); }}>批量导入</Button>}>
        <Select className="toolbar-select" value={classId} onChange={(event) => setClassId(event.target.value)}>
          {classes.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.studentCount} 人）</option>)}
        </Select>
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索姓名或学号" />
      </Toolbar>
      <DataTable
          loading={loading}
          rows={visible}
          rowKey={(row) => row.id}
          empty={keyword ? "没有匹配的学生" : "这个班还没有学生"}
          columns={[
            { key: "account", title: "学号", width: 160, render: (row) => <span className="num">{row.username}</span> },
            { key: "name", title: "姓名", render: (row) => <>{row.displayName}{row.mustChangePassword ? <small>尚未修改初始密码</small> : null}</> },
            { key: "status", title: "状态", width: 100, render: (row) => (row.status === "active" ? <Status tone="ok">启用</Status> : <Status tone="danger">停用</Status>) },
            { key: "ops", title: "操作", width: 100, render: (row) => <Button variant="text" onClick={() => setResetting(row)}>重置密码</Button> },
          ]}
        />

      {importing ? (
        <Dialog
          title={`批量导入 · ${className}`}
          width={640}
          onClose={() => setImporting(false)}
          footer={
            importResult
              ? <Button variant="primary" onClick={() => setImporting(false)}>完成</Button>
              : <><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" loading={busy} onClick={() => void submitImport()}>导入</Button></>
          }
        >
          {importResult ? (
            <>
              <p>成功 {importResult.created.length} 人{importResult.failed.length ? `，失败 ${importResult.failed.length} 人` : ""}。初始密码只显示这一次。</p>
              {importResult.created.length ? (
                <DataTable
                  rows={importResult.created}
                  rowKey={(row) => row.username}
                  columns={[
                    { key: "account", title: "学号", render: (row) => row.username },
                    { key: "name", title: "姓名", render: (row) => row.displayName },
                    { key: "password", title: "初始密码", render: (row) => (row.initialPassword ? <code className="mono-strong">{row.initialPassword}</code> : <span className="faint">导入时已指定</span>) },
                  ]}
                />
              ) : null}
              {importResult.failed.length ? <p className="ui-field-error">失败：{importResult.failed.map((row) => `${row.username}（${row.reason}）`).join("、")}</p> : null}
            </>
          ) : (
            <Field label="学生名单" hint="每行一个学生：学号,姓名 或 学号,姓名,初始密码。可以直接从 Excel 复制两列粘贴进来。" error={importError}>
              <Textarea autoFocus rows={10} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={"s2602001,王小明\ns2602002,刘小红"} />
            </Field>
          )}
        </Dialog>
      ) : null}
      {resetting ? (
        <Confirm title="重置密码" confirmText="重置" busy={busy} onConfirm={() => void confirmReset()} onClose={() => setResetting(null)}>
          重置 {resetting.displayName}（{resetting.username}）的密码后，原密码立即失效。
        </Confirm>
      ) : null}
      {passwords ? <PasswordNotice title={passwords.title} rows={passwords.rows} onClose={() => setPasswords(null)} /> : null}
    </>
  );
}


// ======================================================================
// 内容资源库（E6）
// ======================================================================

const contentMeta: Record<ContentKind, { label: string; unit: string; minimum: number; usage: string; example: string }> = {
  forbidden: { label: "违规词", unit: "个", minimum: 100, usage: "学生发送消息时实时提醒，并计入评分的“违规用语合规”维度", example: "100% guaranteed\n绝对有效" },
  phrase: { label: "标准话术", unit: "条", minimum: 50, usage: "显示在学生工作台的快捷话术里，教师端只读引用", example: "Thank you for reaching out to us.\nCould you please confirm your order number?" },
};

export function AdminContent({ session }: { session: Session }) {
  const [kind, setKind] = useState<ContentKind>("forbidden");
  const [terms, setTerms] = useState<Record<ContentKind, ContentTerm[]>>({ forbidden: [], phrase: [] });
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ContentTerm | null>(null);

  const load = useCallback(() => {
    Promise.all([fetchContentTerms(session, "forbidden"), fetchContentTerms(session, "phrase")])
      .then(([forbidden, phrase]) => setTerms({ forbidden, phrase }))
      .catch((cause) => toast.error(errorText(cause)))
      .finally(() => setLoading(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  const meta = contentMeta[kind];
  const list = terms[kind];
  const visible = useMemo(() => list.filter((item) => item.text.toLowerCase().includes(keyword.trim().toLowerCase())), [list, keyword]);
  const enabledCount = list.filter((item) => item.enabled).length;

  function open(mode: "add" | "import") {
    setText("");
    setFormError("");
    if (mode === "add") setAdding(true);
    else setImporting(true);
  }

  async function submitAdd() {
    if (!text.trim()) {
      setFormError(`请填写${meta.label}`);
      return;
    }
    setBusy(true);
    try {
      await addContentTerm(session, kind, text.trim());
      toast.ok("已添加，学生端立即生效");
      setAdding(false);
      load();
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitImport() {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      setFormError("每行一条，至少填一条");
      return;
    }
    setBusy(true);
    try {
      const result = await importContentTerms(session, kind, lines);
      toast.ok(`导入 ${result.added} 条${result.skipped ? `，${result.skipped} 条已存在已跳过` : ""}`);
      setImporting(false);
      load();
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: ContentTerm, enabled: boolean) {
    setTerms((current) => ({ ...current, [kind]: current[kind].map((row) => (row.id === item.id ? { ...row, enabled } : row)) }));
    try {
      await setContentTermEnabled(session, item.id, enabled);
    } catch (cause) {
      toast.error(errorText(cause));
      load();
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setBusy(true);
    try {
      await deleteContentTerm(session, removing.id);
      toast.ok("已删除");
      setRemoving(null);
      load();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <HeaderTabs
          items={[
            { id: "forbidden", label: "违规词库", count: terms.forbidden.length },
            { id: "phrase", label: "标准话术库", count: terms.phrase.length },
          ]}
          value={kind}
          onChange={(next) => { setKind(next); setKeyword(""); }}
        />
      <Sheet>
        <Toolbar
          actions={
            <>
              <Button icon={FileUp} onClick={() => open("import")}>批量导入</Button>
              <Button variant="primary" icon={Plus} onClick={() => open("add")}>新增{meta.label}</Button>
            </>
          }
        >
          <SearchBox value={keyword} onChange={setKeyword} placeholder={`搜索${meta.label}`} />
          <span className="toolbar-hint">
            启用 {enabledCount} {meta.unit} · 共 {list.length} {meta.unit}
            <HelpTip>{meta.usage}。参数要求初始不少于 {meta.minimum} {meta.unit}。停用的条目保留但不生效。</HelpTip>
          </span>
        </Toolbar>
        <DataTable
            loading={loading}
            rows={visible}
            rowKey={(row) => String(row.id)}
            empty={keyword ? `没有匹配的${meta.label}` : `还没有${meta.label}`}
            columns={[
              { key: "text", title: meta.label, render: (row) => <span className={row.enabled ? undefined : "faint"}>{row.text}</span> },
              { key: "enabled", title: "启用", width: 80, render: (row) => <Switch checked={row.enabled} label={row.enabled ? "停用" : "启用"} onChange={(next) => void toggle(row, next)} /> },
              { key: "ops", title: "", width: 56, render: (row) => <MoreMenu items={[{ label: "删除", danger: true, onClick: () => setRemoving(row) }]} /> },
            ]}
          />
      </Sheet>

      {adding ? (
        <Dialog
          title={`新增${meta.label}`}
          onClose={() => setAdding(false)}
          footer={<><Button onClick={() => setAdding(false)}>取消</Button><Button variant="primary" loading={busy} onClick={() => void submitAdd()}>添加</Button></>}
        >
          <Field label={meta.label} error={formError}>
            <Input autoFocus value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitAdd(); }} />
          </Field>
        </Dialog>
      ) : null}
      {importing ? (
        <Dialog
          title={`批量导入${meta.label}`}
          width={640}
          onClose={() => setImporting(false)}
          footer={<><Button onClick={() => setImporting(false)}>取消</Button><Button variant="primary" loading={busy} onClick={() => void submitImport()}>导入</Button></>}
        >
          <Field label={`${meta.label}名单`} hint="每行一条；重复的和已存在的会自动跳过" error={formError}>
            <Textarea autoFocus rows={12} value={text} onChange={(event) => setText(event.target.value)} placeholder={meta.example} />
          </Field>
        </Dialog>
      ) : null}
      {removing ? (
        <Confirm title={`删除${meta.label}`} danger confirmText="删除" busy={busy} onConfirm={() => void confirmRemove()} onClose={() => setRemoving(null)}>
          删除「{removing.text}」后不可恢复。只是暂时不用的话，可以改为停用。
        </Confirm>
      ) : null}
    </>
  );
}

// ======================================================================
// 数据与备份
// ======================================================================

export function AdminBackup({ session }: { session: Session }) {
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    fetchBackups(session).then(setBackups).catch((cause) => toast.error(errorText(cause))).finally(() => setLoading(false));
  }, [session]);
  useEffect(() => {
    load();
    fetchBackupSchedule(session).then(setSchedule).catch(() => undefined);
  }, [load, session]);

  async function backupNow() {
    setBusy(true);
    try {
      const result = await createBackup(session);
      toast.ok(`备份完成（${formatSize(result.size)}）`);
      load();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule(next: BackupSchedule, message: string) {
    const previous = schedule;
    setSchedule(next);
    try {
      await saveBackupSchedule(session, next);
      toast.ok(message);
    } catch (cause) {
      setSchedule(previous);
      toast.error(errorText(cause));
    }
  }

  const download = (path: string, name: string) => void downloadWithAuth(session, path, name).catch((cause) => toast.error(errorText(cause)));
  const visible = showAll ? backups : backups.slice(0, 5);

  return (
    <Sheet>
      <SettingSection
        title="备份文件"
        desc="每次备份整个数据库，文件保存在服务器上。出问题时可以下载最近一份交给运维恢复。"
        actions={<Button variant="primary" icon={Database} loading={busy} onClick={() => void backupNow()}>立即备份</Button>}
      >
        {loading ? <Empty>正在读取…</Empty> : backups.length === 0 ? <Empty>还没有备份，建议立即备份一次</Empty> : (
          <>
            {visible.map((row, index) => (
              <ListRow
                key={row.fileName}
                leading={<span className="row-icon"><Database size={16} /></span>}
                title={<>{formatTime(row.createdAt)}{index === 0 ? <Tag tone="accent">最新</Tag> : null}</>}
                meta={`${row.fileName} · ${formatSize(row.size)}`}
                actions={<Button size="sm" variant="ghost" icon={Download} onClick={() => download(`/v1/admin/backups/${row.fileName}`, row.fileName)}>下载</Button>}
              />
            ))}
            {backups.length > 5 ? <Button variant="text" onClick={() => setShowAll((value) => !value)}>{showAll ? "收起" : `显示全部 ${backups.length} 份`}</Button> : null}
          </>
        )}
      </SettingSection>
      <SettingSection title="定时备份与清理" desc="建议开启。时间选在夜间没人上课的时段，备份时不影响使用。每次备份后自动删除最早的文件，服务器磁盘不会越占越多。">
        {schedule ? (
          <div className="setting-rows">
            <div className="setting-row">
              <div><strong>每天自动备份</strong><p>{schedule.enabled ? `每天 ${schedule.hour}:00 执行` : "已关闭"}</p></div>
              <Switch checked={schedule.enabled} label="每天自动备份" onChange={(enabled) => void saveSchedule({ ...schedule, enabled }, enabled ? `已开启，每天 ${schedule.hour}:00 自动备份` : "已关闭定时备份")} />
            </div>
            <div className="setting-row">
              <div><strong>执行时间</strong></div>
              <Select className="hour-select" value={schedule.hour} disabled={!schedule.enabled} onChange={(event) => { const hour = Number(event.target.value); void saveSchedule({ ...schedule, hour }, `已改为每天 ${hour}:00 自动备份`); }}>
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hour}:00</option>)}
              </Select>
            </div>
            <div className="setting-row">
              <div>
                <strong>保留份数</strong>
                <p>手动备份也计入。{backups.length > schedule.keep ? `现有 ${backups.length} 份，下次备份后会删到 ${schedule.keep} 份。` : `按每天一份算，可回退到 ${schedule.keep} 天前。`}</p>
              </div>
              <Select className="keep-select" value={schedule.keep} onChange={(event) => { const keep = Number(event.target.value); void saveSchedule({ ...schedule, keep }, `已改为保留最近 ${keep} 份`); }}>
                {[...new Set([...schedule.keepOptions, schedule.keep])].sort((a, b) => a - b).map((count) => <option key={count} value={count}>最近 {count} 份</option>)}
              </Select>
            </div>
          </div>
        ) : <Empty>正在读取…</Empty>}
      </SettingSection>
      <SettingSection title="数据导出" desc="导出 CSV 表格，可以用 Excel 打开，用于存档或交给学校做统计。">
        <ListRow
          leading={<span className="row-icon"><MessagesSquare size={16} /></span>}
          title="对话数据"
          meta="全部买家对话的每一条消息"
          actions={<Button size="sm" icon={Download} onClick={() => download("/v1/admin/export/conversations", "对话数据.csv")}>导出</Button>}
        />
        <ListRow
          leading={<span className="row-icon"><ClipboardCheck size={16} /></span>}
          title="考核数据"
          meta="每次对话的各项评分和总分"
          actions={<Button size="sm" icon={Download} onClick={() => download("/v1/admin/export/assessments", "考核数据.csv")}>导出</Button>}
        />
      </SettingSection>
    </Sheet>
  );
}
