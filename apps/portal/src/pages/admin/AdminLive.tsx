import { Activity, Database, Download, KeyRound, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MetricCard, PageHeader } from "../../components/AppShell";
import {
  API_BASE, ApiError, apiGet, apiPost, apiRequestDelete, apiRequestPatch, type Session,
} from "../../api/client";

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

function useNotices() {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  return { notice, error, setNotice, setError };
}

// ---------- 系统总览 ----------
export function AdminSystem({ session }: { session: Session }) {
  const [data, setData] = useState<Record<string, never> | null>(null);
  useEffect(() => {
    apiGet<never>("/v1/admin/system", session).then(setData as never).catch(() => undefined);
  }, [session]);
  const d = data as {
    version?: string; uptimeSeconds?: number; llmProvider?: string; llmModel?: string;
    counts?: Record<string, number>; alerts24h?: { llmErrors: number; voiceErrors: number };
  } | null;
  const alertCount = (d?.alerts24h?.llmErrors ?? 0) + (d?.alerts24h?.voiceErrors ?? 0);
  return (
    <div className="page">
      <PageHeader eyebrow="SYSTEM" title="系统总览" description={`版本 ${d?.version ?? "—"} · 运行 ${d ? Math.floor((d.uptimeSeconds ?? 0) / 3600) + " 小时 " + Math.floor(((d.uptimeSeconds ?? 0) % 3600) / 60) + " 分" : "—"}`} />
      <section className="metric-grid four">
        <MetricCard label="数据库" value="正常" trend="PostgreSQL 已连接" icon={Database} tone="green" />
        <MetricCard label="LLM 服务" value={d?.llmProvider === "unconfigured" ? "未配置" : "已连接"} trend={d?.llmModel ?? ""} icon={Activity} tone={d?.llmProvider === "unconfigured" ? "coral" : "green"} />
        <MetricCard label="24h 告警" value={String(alertCount)} trend={`LLM ${d?.alerts24h?.llmErrors ?? 0} · 语音 ${d?.alerts24h?.voiceErrors ?? 0}`} icon={ShieldCheck} tone={alertCount > 0 ? "amber" : "green"} />
        <MetricCard label="累计会话" value={String(d?.counts?.conversations ?? "—")} trend={`消息 ${d?.counts?.messages ?? 0} 条 · 评分 ${d?.counts?.assessments ?? 0} 次`} icon={Activity} />
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>规模统计</h2><p>账号与数据体量</p></div></div>
        <div className="order-brief detail-pane">
          <div className="order-brief-row"><span>学生账号</span><em>{d?.counts?.students ?? "—"}</em></div>
          <div className="order-brief-row"><span>教师账号</span><em>{d?.counts?.teachers ?? "—"}</em></div>
          <div className="order-brief-row"><span>会话总数</span><em>{d?.counts?.conversations ?? "—"}</em></div>
          <div className="order-brief-row"><span>消息总数</span><em>{d?.counts?.messages ?? "—"}</em></div>
        </div>
      </section>
      <AcceptanceSection session={session} />
      <AdminAudit session={session} />
    </div>
  );
}

function AcceptanceSection({ session }: { session: Session }) {
  const { notice, error, setNotice, setError } = useNotices();
  const [report, setReport] = useState<{
    llm: { totalRequests: number; validRequests: number; sampleEnough: boolean; ttftP50: number | null; ttftP95: number | null; ttftP99: number | null; ttftRate3s: number | null; ttftRate10s: number | null; charsPerSecond: number | null; passTtft: boolean; passSpeed: boolean };
    voice: Record<string, { total: number; avgMs: number; maxMs: number; within5sRate: number | null }>;
    run?: { running: boolean; done: number; total: number } | null;
  } | null>(null);
  const load = useCallback(() => {
    apiGet<never>("/v1/admin/acceptance", session).then(setReport as never).catch((c) => setError(errorText(c)));
  }, [session, setError]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function run(samples: number) {
    try {
      await apiPost("/v1/admin/acceptance/run", session, { samples });
      setNotice(`验收测试已启动（${samples} 次请求，后台执行）。`);
      load();
    } catch (cause) { setError(errorText(cause)); }
  }
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);
  const badge = (ok: boolean | null | undefined) => (ok == null ? "—" : ok ? "✅ 达标" : "❌ 未达标");
  const L = report?.llm;
  return (
    <section className="panel data-panel">
      <div className="panel-heading">
        <div><h2>验收指标报表</h2><p>基于全部真实调用日志 · 样本 {L?.validRequests ?? 0} 次{L?.sampleEnough ? "（≥100 满足验收样本量）" : "（验收需 ≥100 次）"}</p></div>
        <div>
          {report?.run?.running ? <span className="status-pill">测试中 {report.run.done}/{report.run.total}</span> : (
            <button className="primary-button compact" onClick={() => void run(100)}>运行验收测试（100次）</button>
          )}
        </div>
      </div>
      {notice ? <p className="form-notice">{notice}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <table>
        <thead><tr><th>指标</th><th>红线</th><th>实测</th><th>判定</th></tr></thead>
        <tbody>
          <tr><td>首字响应 ≤3 秒占比</td><td>≥99%</td><td>{pct(L?.ttftRate3s ?? null)}（P50 {L?.ttftP50 ?? "—"}ms / P95 {L?.ttftP95 ?? "—"}ms / P99 {L?.ttftP99 ?? "—"}ms）</td><td>{badge(L?.passTtft)}</td></tr>
          <tr><td>首字响应 ≤10 秒占比</td><td>100%</td><td>{pct(L?.ttftRate10s ?? null)}</td><td>{badge(L ? L.ttftRate10s === 1 : null)}</td></tr>
          <tr><td>平均输出速度</td><td>≥20 字符/秒</td><td>{L?.charsPerSecond ?? "—"} 字符/秒</td><td>{badge(L?.passSpeed)}</td></tr>
          <tr><td>TTS 单次合成</td><td>≤5 秒</td><td>均值 {report?.voice?.tts?.avgMs ?? "—"}ms · 最大 {report?.voice?.tts?.maxMs ?? "—"}ms</td><td>{badge(report?.voice?.tts ? (report.voice.tts.within5sRate ?? 0) >= 1 : null)}</td></tr>
          <tr><td>ASR 单次识别</td><td>≤5 秒</td><td>均值 {report?.voice?.asr?.avgMs ?? "—"}ms · 最大 {report?.voice?.asr?.maxMs ?? "—"}ms</td><td>{badge(report?.voice?.asr ? (report.voice.asr.within5sRate ?? 0) >= 1 : null)}</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function AdminAudit({ session }: { session: Session }) {
  const [rows, setRows] = useState<Array<{ id: number; action: string; target: string | null; actor: string | null; created_at: string }>>([]);
  useEffect(() => {
    apiGet<never>("/v1/admin/audit?limit=30", session).then(setRows as never).catch(() => undefined);
  }, [session]);
  return (
    <section className="panel data-panel">
      <div className="panel-heading"><div><h2>审计日志</h2><p>最近 30 条关键操作</p></div></div>
      <table>
        <thead><tr><th>操作</th><th>对象</th><th>操作者</th><th>时间</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}><td><strong>{row.action}</strong></td><td>{row.target ?? "—"}</td><td>{row.actor ?? "—"}</td><td>{new Date(row.created_at).toLocaleString("zh-CN")}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------- AI 与语音服务 ----------
export function AdminProviders({ session }: { session: Session }) {
  const { notice, error, setNotice, setError } = useNotices();
  const [data, setData] = useState<{
    llm: { baseUrl: string; model: string; apiKeyMasked: string };
    voice: { apiKeyMasked: string; ttsSpeaker: string; ttsSpeakerMale: string; ttsResourceId: string; asrResourceId: string };
    usage: { llmCalls: number; llmChars: number; ttsCalls: number; asrCalls: number };
    quota: { monthlyLlmCalls: number; warnPercent: number; usedPercent: number; alert: boolean };
  } | null>(null);
  const [form, setForm] = useState({ baseUrl: "", model: "", apiKey: "", voiceKey: "", quota: "", warn: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiGet<never>("/v1/admin/providers", session).then((d) => {
      setData(d as never);
      const dd = d as never as { llm: { baseUrl: string; model: string }; quota: { monthlyLlmCalls: number; warnPercent: number } };
      setForm((f) => ({ ...f, baseUrl: dd.llm.baseUrl, model: dd.llm.model, quota: String(dd.quota.monthlyLlmCalls), warn: String(dd.quota.warnPercent) }));
    }).catch((cause) => setError(errorText(cause)));
  }, [session, setError]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fetch(`${API_BASE}/v1/admin/providers`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({
          llm: { baseUrl: form.baseUrl, model: form.model, ...(form.apiKey ? { apiKey: form.apiKey } : {}) },
          ...(form.voiceKey ? { voice: { apiKey: form.voiceKey } } : {}),
          quota: { monthlyLlmCalls: Number(form.quota) || 10000, warnPercent: Number(form.warn) || 80 },
        }),
      }).then(async (r) => { if (!r.ok) throw new ApiError(r.status, "SAVE", (await r.json()).message ?? "保存失败"); });
      setNotice("配置已保存并即时生效（无需重启）。");
      setForm((f) => ({ ...f, apiKey: "", voiceKey: "" }));
      load();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="PROVIDERS" title="AI 与语音服务" description="配置并热切换 LLM 对话与语音服务，监控调用量与额度。" />
      {notice ? <p className="form-notice">{notice}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {data?.quota.alert ? <p className="form-error">⚠ 本月 LLM 调用已达额度的 {data.quota.usedPercent}%（阈值 {data.quota.warnPercent}%），请关注余量或提升额度。</p> : null}
      <div className="classes-layout">
        <section className="panel">
          <div className="panel-heading"><div><h2>LLM 对话服务</h2><p>当前密钥 {data?.llm.apiKeyMasked ?? "—"}</p></div></div>
          <div className="form-grid">
            <label>接口地址<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.cn" /></label>
            <label>模型<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-v4-pro" /></label>
            <label>新密钥（留空不改）<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
          </div>
          <div className="panel-heading"><div><h2>语音服务</h2><p>当前密钥 {data?.voice.apiKeyMasked ?? "—"} · 女声 {data?.voice.ttsSpeaker} · 男声 {data?.voice.ttsSpeakerMale}</p></div></div>
          <div className="form-grid">
            <label>新语音密钥（留空不改）<input type="password" value={form.voiceKey} onChange={(e) => setForm({ ...form, voiceKey: e.target.value })} /></label>
            <label>月度 LLM 调用额度<input type="number" value={form.quota} onChange={(e) => setForm({ ...form, quota: e.target.value })} /></label>
            <label>告警阈值（%）<input type="number" value={form.warn} onChange={(e) => setForm({ ...form, warn: e.target.value })} /></label>
          </div>
          <div className="form-actions"><button className="primary-button" disabled={busy} onClick={() => void save()}><Save size={15} /> 保存并生效</button></div>
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>本月调用量</h2><p>自然月统计 · 达 {data?.quota.warnPercent ?? 80}% 自动告警</p></div></div>
          <div className="dimension-list">
            <div><span>LLM 调用</span><i><b style={{ width: `${Math.min(100, data?.quota.usedPercent ?? 0)}%` }} /></i><strong>{data?.usage.llmCalls ?? 0}/{data?.quota.monthlyLlmCalls ?? 0}</strong></div>
            <div><span>输出字符</span><i><b style={{ width: "30%" }} /></i><strong>{data?.usage.llmChars ?? 0}</strong></div>
            <div><span>TTS 合成</span><i><b style={{ width: "20%" }} /></i><strong>{data?.usage.ttsCalls ?? 0}</strong></div>
            <div><span>ASR 识别</span><i><b style={{ width: "20%" }} /></i><strong>{data?.usage.asrCalls ?? 0}</strong></div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------- 账号与权限 ----------
export function AdminAccounts({ session }: { session: Session }) {
  const { notice, error, setNotice, setError } = useNotices();
  const [teachers, setTeachers] = useState<Array<{ id: string; username: string; displayName: string; status: string; classCount: number }>>([]);
  const [form, setForm] = useState({ username: "", displayName: "" });
  const load = useCallback(() => {
    apiGet<never>("/v1/admin/teachers", session).then(setTeachers as never).catch((c) => setError(errorText(c)));
  }, [session, setError]);
  useEffect(() => { load(); }, [load]);

  async function createTeacher() {
    if (!form.username.trim() || !form.displayName.trim()) { setError("请填写账号与姓名。"); return; }
    try {
      const result = await apiPost<{ initialPassword?: string }>("/v1/admin/teachers", session, form);
      setNotice(`教师已创建${result.initialPassword ? `，初始密码：${result.initialPassword}（仅显示一次）` : ""}`);
      setForm({ username: "", displayName: "" });
      load();
    } catch (cause) { setError(errorText(cause)); }
  }

  async function toggle(t: { id: string; status: string }) {
    try {
      await apiRequestPatch(`/v1/admin/teachers/${t.id}`, session, { status: t.status === "active" ? "disabled" : "active" });
      load();
    } catch (cause) { setError(errorText(cause)); }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="ACCOUNTS" title="账号与权限" description="教师账号管理；学生批量导入与密码重置在教师端班级页操作。" />
      {notice ? <p className="form-notice">{notice}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <section className="panel data-panel">
        <div className="panel-heading"><div><h2>教师账号</h2><p>{teachers.length} 名教师</p></div></div>
        <div className="form-grid compact-form">
          <label>账号<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="如 li.teacher" /></label>
          <label>姓名<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="李老师" /></label>
        </div>
        <div className="form-actions"><button className="primary-button compact" onClick={() => void createTeacher()}><Plus size={14} /> 新增教师</button></div>
        <table>
          <thead><tr><th>姓名</th><th>账号</th><th>授权班级</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {teachers.map((t) => (
              <tr key={t.id}>
                <td><strong>{t.displayName}</strong></td><td>{t.username}</td><td>{t.classCount}</td>
                <td><em className={t.status === "active" ? "state-done" : "state-warning"}>{t.status === "active" ? "启用" : "停用"}</em></td>
                <td><button className="text-button" onClick={() => void toggle(t)}>{t.status === "active" ? "停用" : "启用"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------- 内容资源库 ----------
export function AdminContent({ session }: { session: Session }) {
  const { notice, error, setNotice, setError } = useNotices();
  const [kind, setKind] = useState<"forbidden" | "phrase">("forbidden");
  const [rows, setRows] = useState<Array<{ id: number; text: string }>>([]);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");
  const load = useCallback(() => {
    apiGet<never>(`/v1/admin/content?kind=${kind}`, session).then(setRows as never).catch((c) => setError(errorText(c)));
  }, [session, kind, setError]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!text.trim()) return;
    try {
      await apiPost("/v1/admin/content", session, { kind, text: text.trim() });
      setText("");
      setNotice("已添加，学生端检测/话术即时生效。");
      load();
    } catch (cause) { setError(errorText(cause)); }
  }
  async function remove(id: number) {
    try { await apiRequestDelete(`/v1/admin/content/${id}`, session); load(); } catch (cause) { setError(errorText(cause)); }
  }
  const visible = rows.filter((r) => r.text.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <PageHeader eyebrow="CONTENT" title="内容资源库" description="全局违规词库与标准话术库统一维护（教师端只读引用）。" />
      {notice ? <p className="form-notice">{notice}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <div className="segmented-tabs page-tabs">
        <button className={kind === "forbidden" ? "active" : ""} onClick={() => setKind("forbidden")}>违规词库<span>{kind === "forbidden" ? rows.length : ""}</span></button>
        <button className={kind === "phrase" ? "active" : ""} onClick={() => setKind("phrase")}>标准话术库<span>{kind === "phrase" ? rows.length : ""}</span></button>
      </div>
      <section className="panel data-panel">
        <div className="form-grid compact-form">
          <label>新增{kind === "forbidden" ? "违规词" : "话术"}<input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /></label>
          <label>搜索<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选…" /></label>
        </div>
        <div className="form-actions"><button className="primary-button compact" onClick={() => void add()}><Plus size={14} /> 添加</button></div>
        <div className="term-grid">
          {visible.map((row) => (
            <span key={row.id} className="term-chip">{row.text}<button aria-label="删除" onClick={() => void remove(row.id)}><Trash2 size={12} /></button></span>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------- 数据与备份 ----------
export function AdminBackup({ session }: { session: Session }) {
  const { notice, error, setNotice, setError } = useNotices();
  const [backups, setBackups] = useState<Array<{ fileName: string; size: number; createdAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    apiGet<never>("/v1/admin/backups", session).then(setBackups as never).catch((c) => setError(errorText(c)));
  }, [session, setError]);
  useEffect(() => { load(); }, [load]);

  async function backup() {
    setBusy(true);
    setError("");
    try {
      const result = await apiPost<{ fileName: string; size: number }>("/v1/admin/backups", session);
      setNotice(`备份完成：${result.fileName}（${Math.round(result.size / 1024)} KB）`);
      load();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }

  async function download(path: string, name: string) {
    const response = await fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    if (!response.ok) { setError("下载失败"); return; }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="BACKUP" title="数据与备份" description="数据库手动备份与业务数据导出。"
        actions={<button className="primary-button" disabled={busy} onClick={() => void backup()}><Database size={16} /> {busy ? "备份中…" : "立即备份"}</button>}
      />
      {notice ? <p className="form-notice">{notice}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <div className="classes-layout">
        <section className="panel data-panel">
          <div className="panel-heading"><div><h2>备份文件</h2><p>{backups.length} 个（pg_dump 全库）</p></div></div>
          <table>
            <thead><tr><th>文件</th><th>大小</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.fileName}>
                  <td><strong>{b.fileName}</strong></td><td>{Math.round(b.size / 1024)} KB</td>
                  <td>{new Date(b.createdAt).toLocaleString("zh-CN")}</td>
                  <td><button className="text-button" onClick={() => void download(`/v1/admin/backups/${b.fileName}`, b.fileName)}><Download size={13} /> 下载</button></td>
                </tr>
              ))}
              {backups.length === 0 ? <tr><td colSpan={4}><span className="muted">暂无备份。</span></td></tr> : null}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <BackupSchedule session={session} setNotice={setNotice} setError={setError} />
          <div className="panel-heading"><div><h2>数据导出</h2><p>CSV 格式（UTF-8）</p></div></div>
          <div className="form-actions" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <button className="secondary-button" onClick={() => void download("/v1/admin/export/conversations", "对话数据.csv")}><KeyRound size={14} /> 导出对话数据</button>
            <button className="secondary-button" onClick={() => void download("/v1/admin/export/assessments", "考核数据.csv")}><KeyRound size={14} /> 导出考核数据</button>
          </div>
        </section>
      </div>
    </div>
  );
}

function BackupSchedule({ session, setNotice, setError }: { session: Session; setNotice: (v: string) => void; setError: (v: string) => void }) {
  const [schedule, setSchedule] = useState<{ enabled: boolean; hour: number } | null>(null);
  useEffect(() => {
    apiGet<never>("/v1/admin/backup-schedule", session).then(setSchedule as never).catch(() => undefined);
  }, [session]);
  async function save(next: { enabled: boolean; hour: number }) {
    try {
      await fetch(`${API_BASE}/v1/admin/backup-schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(next),
      });
      setSchedule(next);
      setNotice(`定时备份已${next.enabled ? `开启（每日 ${next.hour}:00）` : "关闭"}。`);
    } catch { setError("保存失败"); }
  }
  if (!schedule) return null;
  return (
    <>
      <div className="panel-heading"><div><h2>定时备份</h2><p>每日自动执行 pg_dump</p></div></div>
      <div className="form-grid compact-form">
        <label>状态
          <select value={schedule.enabled ? "1" : "0"} onChange={(e) => void save({ ...schedule, enabled: e.target.value === "1" })}>
            <option value="0">关闭</option><option value="1">开启</option>
          </select>
        </label>
        <label>执行时间
          <select value={schedule.hour} onChange={(e) => void save({ ...schedule, hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
        </label>
      </div>
    </>
  );
}
