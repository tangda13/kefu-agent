import { CheckCircle2, FlaskConical, Pencil, Plus, Save, Star, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LLM_PRESETS,
  LLM_PURPOSES,
  LLM_PURPOSE_LABELS,
  type LlmProfileView,
  type LlmPurpose,
  type LlmRoutingSettings,
  type LlmTestResult,
} from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import { ApiError, apiGet, apiPost, apiRequestDelete, apiRequestPut, type Session } from "../../api/client";

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

interface LlmState {
  profiles: LlmProfileView[];
  routing: LlmRoutingSettings;
  active: Record<LlmPurpose, { profileName: string; model: string } | null>;
}

interface UsageState {
  byProfile: Array<{ profileName: string; model: string; calls: number; failures: number; inputTokens: number; outputTokens: number; cost: number; avgTtftMs: number | null }>;
  byPurpose: Array<{ purpose: LlmPurpose; calls: number; failures: number; fallbacks: number; tokens: number; cost: number }>;
}

interface ProvidersState {
  voice: {
    vendor: string; vendors: Array<{ key: string; label: string }>; apiKeyMasked: string;
    ttsResourceId: string; ttsSpeaker: string; ttsSpeakerMale: string; asrResourceId: string;
    ttsPricePer10kChars: number; asrPricePerHour: number;
  };
  usage: { llmCalls: number; llmTokens: number; llmCost: number; ttsCalls: number; ttsChars: number; ttsCost: number; asrCalls: number; asrMinutes: number; asrCost: number; totalCost: number };
  quota: { monthlyBudgetYuan: number; monthlyTokens: number; warnPercent: number; budgetPercent: number; tokenPercent: number; usedPercent: number; alert: boolean };
}

const yuan = (value: number) => `¥${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** AI 与语音服务（G1–G7）：档案、用途分配、用量费用、语音、额度 */
export function AdminModels({ session }: { session: Session }) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [llm, setLlm] = useState<LlmState | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [providers, setProviders] = useState<ProvidersState | null>(null);
  const [editing, setEditing] = useState<LlmProfileView | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<LlmState>("/v1/admin/llm", session).then(setLlm).catch((cause) => setError(errorText(cause)));
    apiGet<UsageState>("/v1/admin/llm/usage", session).then(setUsage).catch(() => undefined);
    apiGet<ProvidersState>("/v1/admin/providers", session).then(setProviders).catch(() => undefined);
  }, [session]);
  useEffect(() => { load(); }, [load]);

  const flash = (message: string) => { setNotice(message); setError(""); };
  const fail = (cause: unknown) => { setError(errorText(cause)); setNotice(""); };

  async function testProfile(profile: LlmProfileView) {
    setTesting(profile.id);
    try {
      const result = await apiPost<LlmTestResult>(`/v1/admin/llm/profiles/${profile.id}/test`, session);
      if (result.ok) flash(`「${profile.name}」测试通过：首字 ${result.ttftMs}ms，输出 ${result.charsPerSecond} 字/秒。`);
      else setError(`「${profile.name}」测试未通过：${result.error ?? "未知错误"}`);
      load();
    } catch (cause) { fail(cause); } finally { setTesting(null); }
  }

  async function setDefault(profile: LlmProfileView) {
    try {
      await apiRequestPut("/v1/admin/llm/default", session, { profileId: profile.id });
      flash(`已把「${profile.name}」设为默认档案，立即生效。`);
      load();
    } catch (cause) { fail(cause); }
  }

  async function remove(profile: LlmProfileView) {
    if (!window.confirm(`删除档案「${profile.name}」？`)) return;
    try {
      await apiRequestDelete(`/v1/admin/llm/profiles/${profile.id}`, session);
      flash("档案已删除。");
      load();
    } catch (cause) { fail(cause); }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="MODELS & VOICE"
        title="AI 与语音服务"
        description="模型厂商档案、按用途分配模型、连通性测试与费用统计。所有改动立即生效，API Key 只在云端加密保存。"
        actions={<button className="primary-button" onClick={() => setEditing("new")}><Plus size={16} /> 新增模型档案</button>}
      />
      {notice ? <p className="form-notice">{notice}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {providers?.quota.alert ? (
        <p className="form-error">本月费用 / tokens 已用到额度的 {providers.quota.usedPercent}%（提醒线 {providers.quota.warnPercent}%），请关注余额或调整额度。</p>
      ) : null}

      {editing ? (
        <ProfileForm
          session={session}
          profile={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); flash(message); load(); }}
        />
      ) : null}

      <section className="panel data-panel">
        <div className="panel-heading"><div><h2>模型档案</h2><p>一个档案 = 一个厂商地址 + 一个模型 + 参数。测试通过后才能设为默认或分配给用途。</p></div></div>
        <table>
          <thead><tr><th>名称</th><th>模型</th><th>地址</th><th>Key</th><th>测试</th><th>操作</th></tr></thead>
          <tbody>
            {llm?.profiles.length === 0 ? <tr><td colSpan={6}>还没有模型档案。点右上角「新增模型档案」，选择厂商模板后填入 Key 即可。</td></tr> : null}
            {llm?.profiles.map((profile) => (
              <tr key={profile.id}>
                <td>
                  <strong>{profile.name}</strong>
                  {profile.isDefault ? <em className="status-pill green" style={{ marginLeft: 6 }}>默认</em> : null}
                  {!profile.enabled ? <em className="status-pill gray" style={{ marginLeft: 6 }}>已停用</em> : null}
                </td>
                <td>{profile.model}</td>
                <td title={profile.baseUrl}>{host(profile.baseUrl)}</td>
                <td>{profile.apiKeyMasked || "—"}</td>
                <td>
                  {profile.testStatus === "ok" ? (
                    <span className="status-pill green"><CheckCircle2 size={12} /> 首字 {profile.testResult?.ttftMs ?? "—"}ms</span>
                  ) : profile.testStatus === "failed" ? (
                    <span className="status-pill warn-pill" title={profile.testResult?.error ?? ""}><XCircle size={12} /> 未通过</span>
                  ) : <span className="status-pill gray">未测试</span>}
                </td>
                <td>
                  <button className="text-button" disabled={testing === profile.id} onClick={() => void testProfile(profile)}><FlaskConical size={14} /> {testing === profile.id ? "测试中" : "测试"}</button>
                  <button className="text-button" onClick={() => setEditing(profile)}><Pencil size={14} /> 编辑</button>
                  {!profile.isDefault ? <button className="text-button" onClick={() => void setDefault(profile)}><Star size={14} /> 设为默认</button> : null}
                  {!profile.isDefault ? <button className="text-button" onClick={() => void remove(profile)}><Trash2 size={14} /> 删除</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {llm ? <RoutingSection session={session} llm={llm} onSaved={(message) => { flash(message); load(); }} onError={fail} /> : null}
      <UsageSection usage={usage} />
      {providers ? <VoiceAndQuota session={session} data={providers} onSaved={(message) => { flash(message); load(); }} onError={fail} /> : null}
    </div>
  );
}

// ---------- 新增 / 编辑档案 ----------
function ProfileForm({ session, profile, onClose, onSaved }: {
  session: Session;
  profile: LlmProfileView | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState(() => ({
    presetKey: profile?.presetKey ?? "deepseek",
    name: profile?.name ?? LLM_PRESETS[0]!.label,
    baseUrl: profile?.baseUrl ?? LLM_PRESETS[0]!.baseUrl,
    apiKey: "",
    model: profile?.model ?? LLM_PRESETS[0]!.models[0] ?? "",
    extraBody: JSON.stringify(profile?.extraBody ?? LLM_PRESETS[0]!.extraBody, null, 2),
    extraHeaders: JSON.stringify(profile?.extraHeaders ?? {}, null, 2),
    maxTokensField: profile?.maxTokensField ?? "max_tokens",
    jsonMode: profile?.jsonMode ?? LLM_PRESETS[0]!.jsonMode,
    timeoutMs: String(profile?.timeoutMs ?? 60000),
    priceInput: String(profile?.priceInput ?? 0),
    priceOutput: String(profile?.priceOutput ?? 0),
    enabled: profile?.enabled ?? true,
  }));
  const [result, setResult] = useState<LlmTestResult | null>(profile?.testResult ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preset = useMemo(() => LLM_PRESETS.find((item) => item.key === form.presetKey), [form.presetKey]);

  function applyPreset(key: string) {
    const next = LLM_PRESETS.find((item) => item.key === key);
    if (!next) return;
    setForm((current) => ({
      ...current,
      presetKey: key,
      name: profile ? current.name : next.label,
      baseUrl: next.baseUrl || current.baseUrl,
      model: next.models[0] ?? current.model,
      extraBody: JSON.stringify(next.extraBody, null, 2),
      jsonMode: next.jsonMode,
    }));
  }

  function payload() {
    let extraBody: unknown;
    let extraHeaders: unknown;
    try {
      extraBody = JSON.parse(form.extraBody.trim() || "{}");
      extraHeaders = JSON.parse(form.extraHeaders.trim() || "{}");
    } catch {
      throw new Error("额外请求体 / 请求头必须是合法的 JSON 对象");
    }
    return {
      name: form.name,
      presetKey: form.presetKey,
      baseUrl: form.baseUrl,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      model: form.model,
      extraBody,
      extraHeaders,
      maxTokensField: form.maxTokensField,
      jsonMode: form.jsonMode,
      timeoutMs: Number(form.timeoutMs) || 60000,
      priceInput: Number(form.priceInput) || 0,
      priceOutput: Number(form.priceOutput) || 0,
      enabled: form.enabled,
    };
  }

  async function testDraft() {
    setBusy(true);
    setError("");
    try {
      setResult(await apiPost<LlmTestResult>("/v1/admin/llm/test", session, { ...payload(), ...(profile ? { id: profile.id } : {}) }));
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof ApiError) ? cause.message : errorText(cause));
    } finally { setBusy(false); }
  }

  async function save(thenTest: boolean) {
    setBusy(true);
    setError("");
    try {
      const body = payload();
      let id = profile?.id;
      if (id) await apiRequestPut(`/v1/admin/llm/profiles/${id}`, session, body);
      else id = (await apiPost<{ id: string }>("/v1/admin/llm/profiles", session, body)).id;
      if (thenTest) {
        const tested = await apiPost<LlmTestResult>(`/v1/admin/llm/profiles/${id}/test`, session);
        if (!tested.ok) {
          setResult(tested);
          setError("已保存，但连通性测试未通过，请根据下方报错修改。");
          return;
        }
        onSaved(`「${form.name}」已保存并测试通过（首字 ${tested.ttftMs}ms）。`);
      } else {
        onSaved(`「${form.name}」已保存。修改了地址、Key、模型或参数后需要重新测试。`);
      }
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof ApiError) ? cause.message : errorText(cause));
    } finally { setBusy(false); }
  }

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><h2>{profile ? `编辑档案：${profile.name}` : "新增模型档案"}</h2><p>{preset?.note || "选好厂商模板会自动带出地址、推荐模型和必要参数，通常只需填 Key。"}</p></div>
        <button className="secondary-button compact" onClick={onClose}>取消</button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="form-grid">
        <label>厂商模板
          <select value={form.presetKey} onChange={(event) => applyPreset(event.target.value)}>
            {LLM_PRESETS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
        <label>档案名称<input value={form.name} onChange={set("name")} /></label>
        <label>接口地址（到 /v1 这一级，系统会拼上 /chat/completions）<input value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://api.example.com/v1" /></label>
        <label>API Key{profile ? `（当前 ${profile.apiKeyMasked || "未设置"}，留空不改）` : ""}<input type="password" value={form.apiKey} onChange={set("apiKey")} placeholder="sk-..." autoComplete="off" /></label>
        <label>模型名
          <input value={form.model} onChange={set("model")} list="llm-model-options" />
          <datalist id="llm-model-options">{preset?.models.map((model) => <option key={model} value={model} />)}</datalist>
        </label>
        <label>最大输出字段
          <select value={form.maxTokensField} onChange={set("maxTokensField")}>
            <option value="max_tokens">max_tokens（多数厂商）</option>
            <option value="max_completion_tokens">max_completion_tokens（OpenAI 新模型）</option>
          </select>
        </label>
        <label>超时（毫秒）<input type="number" value={form.timeoutMs} onChange={set("timeoutMs")} /></label>
        <label>输入单价（元 / 百万 tokens）<input type="number" step="0.01" value={form.priceInput} onChange={set("priceInput")} /></label>
        <label>输出单价（元 / 百万 tokens）<input type="number" step="0.01" value={form.priceOutput} onChange={set("priceOutput")} /></label>
        <label className="checkbox-row"><input type="checkbox" checked={form.jsonMode} onChange={(event) => setForm({ ...form, jsonMode: event.target.checked })} /> 支持 JSON 模式（评分、导演等结构化输出时下发 response_format）</label>
        <label className="checkbox-row"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> 启用</label>
      </div>
      <div className="form-grid two">
        <label>额外请求体（JSON，合并进每次请求，例如关闭思考）<textarea rows={4} value={form.extraBody} onChange={set("extraBody")} spellCheck={false} /></label>
        <label>自定义请求头（JSON）<textarea rows={4} value={form.extraHeaders} onChange={set("extraHeaders")} spellCheck={false} /></label>
      </div>
      {result ? (
        <div className={result.ok ? "form-notice" : "form-error"}>
          {result.ok
            ? <>测试通过：首字 {result.ttftMs}ms · 输出 {result.charsPerSecond} 字/秒 · tokens {result.inputTokens}/{result.outputTokens} · 样例回复：“{result.sample}”</>
            : <>测试未通过（耗时 {result.totalMs}ms）：<pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>{result.error}</pre></>}
        </div>
      ) : null}
      <div className="form-actions">
        <button className="secondary-button" disabled={busy} onClick={() => void testDraft()}><FlaskConical size={15} /> 测试连通</button>
        <button className="secondary-button" disabled={busy} onClick={() => void save(false)}><Save size={15} /> 仅保存</button>
        <button className="primary-button" disabled={busy} onClick={() => void save(true)}><Save size={15} /> 保存并测试</button>
      </div>
    </section>
  );
}

// ---------- 用途分配 ----------
function RoutingSection({ session, llm, onSaved, onError }: {
  session: Session;
  llm: LlmState;
  onSaved: (message: string) => void;
  onError: (cause: unknown) => void;
}) {
  const [routing, setRouting] = useState<LlmRoutingSettings>(llm.routing);
  useEffect(() => setRouting(llm.routing), [llm.routing]);
  const usable = llm.profiles.filter((profile) => profile.enabled && profile.testStatus === "ok");
  const defaultProfile = llm.profiles.find((profile) => profile.isDefault);

  function update(purpose: LlmPurpose, patch: Partial<LlmRoutingSettings["routes"][LlmPurpose]>) {
    setRouting((current) => ({ ...current, routes: { ...current.routes, [purpose]: { ...current.routes[purpose], ...patch } } }));
  }

  async function save() {
    try {
      await apiRequestPut("/v1/admin/llm/routing", session, routing);
      onSaved("用途分配已保存，立即生效。");
    } catch (cause) { onError(cause); }
  }

  return (
    <section className="panel data-panel">
      <div className="panel-heading">
        <div><h2>用途分配</h2><p>不同任务可以用不同模型：对话要快，评分要稳，辅助任务可以用便宜的。没单独指定的用途走默认档案（{defaultProfile?.name ?? "未设置"}）。主档案连续失败 3 次会自动切到备用档案 5 分钟，并写入审计日志。</p></div>
        <button className="primary-button compact" onClick={() => void save()}><Save size={15} /> 保存分配</button>
      </div>
      <table>
        <thead><tr><th>用途</th><th>主档案</th><th>备用档案</th><th>temperature</th><th>最大输出 tokens</th><th>当前生效</th></tr></thead>
        <tbody>
          {LLM_PURPOSES.map((purpose) => {
            const route = routing.routes[purpose];
            return (
              <tr key={purpose}>
                <td><strong>{LLM_PURPOSE_LABELS[purpose].label}</strong><br /><small>{LLM_PURPOSE_LABELS[purpose].hint}</small></td>
                <td>
                  <select value={route.profileId ?? ""} onChange={(event) => update(purpose, { profileId: event.target.value || null })}>
                    <option value="">跟随默认档案</option>
                    {usable.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </td>
                <td>
                  <select value={route.fallbackProfileId ?? ""} onChange={(event) => update(purpose, { fallbackProfileId: event.target.value || null })}>
                    <option value="">不设备用</option>
                    {usable.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </td>
                <td><input type="number" step="0.1" min="0" max="2" style={{ width: 70 }} value={route.temperature} onChange={(event) => update(purpose, { temperature: Number(event.target.value) })} /></td>
                <td><input type="number" min="16" style={{ width: 90 }} value={route.maxTokens} onChange={(event) => update(purpose, { maxTokens: Number(event.target.value) })} /></td>
                <td>{llm.active[purpose] ? `${llm.active[purpose]!.profileName} · ${llm.active[purpose]!.model}` : <span className="status-pill warn-pill">未配置</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="form-grid">
        <label>导演运行频率：每
          <input type="number" min="1" max="10" style={{ width: 70, margin: "0 6px" }} value={routing.directorEveryNTurns}
            onChange={(event) => setRouting({ ...routing, directorEveryNTurns: Number(event.target.value) || 1 })} />
          轮学生发言运行一次（调大可降低成本，买家情绪更新会变慢）
        </label>
      </div>
    </section>
  );
}

// ---------- 用量与费用 ----------
function UsageSection({ usage }: { usage: UsageState | null }) {
  return (
    <section className="panel data-panel">
      <div className="panel-heading"><div><h2>本月模型用量与费用</h2><p>费用按各档案填写的单价折算；未填单价的档案费用显示为 0。</p></div></div>
      <table>
        <thead><tr><th>用途</th><th>调用</th><th>失败</th><th>走备用</th><th>tokens</th><th>费用</th></tr></thead>
        <tbody>
          {LLM_PURPOSES.map((purpose) => {
            const row = usage?.byPurpose.find((item) => item.purpose === purpose);
            return (
              <tr key={purpose}>
                <td>{LLM_PURPOSE_LABELS[purpose].label}</td>
                <td>{row?.calls ?? 0}</td><td>{row?.failures ?? 0}</td><td>{row?.fallbacks ?? 0}</td>
                <td>{(row?.tokens ?? 0).toLocaleString()}</td><td>{yuan(row?.cost ?? 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {usage?.byProfile.length ? (
        <table>
          <thead><tr><th>档案 / 模型</th><th>调用</th><th>失败</th><th>输入 tokens</th><th>输出 tokens</th><th>平均首字</th><th>费用</th></tr></thead>
          <tbody>
            {usage.byProfile.map((row) => (
              <tr key={`${row.profileName}-${row.model}`}>
                <td>{row.profileName} · {row.model}</td><td>{row.calls}</td><td>{row.failures}</td>
                <td>{row.inputTokens.toLocaleString()}</td><td>{row.outputTokens.toLocaleString()}</td>
                <td>{row.avgTtftMs !== null ? `${row.avgTtftMs}ms` : "—"}</td><td>{yuan(row.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

// ---------- 语音服务 + 月度额度 ----------
function VoiceAndQuota({ session, data, onSaved, onError }: {
  session: Session;
  data: ProvidersState;
  onSaved: (message: string) => void;
  onError: (cause: unknown) => void;
}) {
  const [voice, setVoice] = useState({ ...data.voice, apiKey: "" });
  const [quota, setQuota] = useState({ monthlyBudgetYuan: String(data.quota.monthlyBudgetYuan), monthlyTokens: String(data.quota.monthlyTokens), warnPercent: String(data.quota.warnPercent) });
  const u = data.usage;

  async function saveVoice() {
    try {
      await apiRequestPut("/v1/admin/providers", session, {
        voice: {
          vendor: voice.vendor,
          ...(voice.apiKey ? { apiKey: voice.apiKey } : {}),
          ttsResourceId: voice.ttsResourceId,
          ttsSpeaker: voice.ttsSpeaker,
          ttsSpeakerMale: voice.ttsSpeakerMale,
          asrResourceId: voice.asrResourceId,
          ttsPricePer10kChars: Number(voice.ttsPricePer10kChars) || 0,
          asrPricePerHour: Number(voice.asrPricePerHour) || 0,
        },
      });
      setVoice((current) => ({ ...current, apiKey: "" }));
      onSaved("语音服务配置已保存，立即生效。");
    } catch (cause) { onError(cause); }
  }

  async function saveQuota() {
    try {
      await apiRequestPut("/v1/admin/providers", session, {
        quota: { monthlyBudgetYuan: Number(quota.monthlyBudgetYuan) || 0, monthlyTokens: Number(quota.monthlyTokens) || 0, warnPercent: Number(quota.warnPercent) || 80 },
      });
      onSaved("月度额度已保存。");
    } catch (cause) { onError(cause); }
  }

  const setV = (key: keyof typeof voice) => (event: { target: { value: string } }) => setVoice({ ...voice, [key]: event.target.value });
  return (
    <div className="classes-layout">
      <section className="panel">
        <div className="panel-heading"><div><h2>语音服务</h2><p>当前 Key {data.voice.apiKeyMasked || "未设置"} · 本月合成 {u.ttsCalls} 次（{u.ttsChars.toLocaleString()} 字）· 识别 {u.asrCalls} 次（{u.asrMinutes} 分钟）</p></div></div>
        <div className="form-grid">
          <label>厂商
            <select value={voice.vendor} onChange={setV("vendor")}>
              {data.voice.vendors.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label>新 API Key（留空不改）<input type="password" value={voice.apiKey} onChange={setV("apiKey")} autoComplete="off" /></label>
          <label>合成资源 ID<input value={voice.ttsResourceId} onChange={setV("ttsResourceId")} /></label>
          <label>女声音色<input value={voice.ttsSpeaker} onChange={setV("ttsSpeaker")} /></label>
          <label>男声音色<input value={voice.ttsSpeakerMale} onChange={setV("ttsSpeakerMale")} /></label>
          <label>识别资源 ID<input value={voice.asrResourceId} onChange={setV("asrResourceId")} /></label>
          <label>合成单价（元 / 万字符）<input type="number" step="0.01" value={voice.ttsPricePer10kChars} onChange={setV("ttsPricePer10kChars")} /></label>
          <label>识别单价（元 / 小时）<input type="number" step="0.01" value={voice.asrPricePerHour} onChange={setV("asrPricePerHour")} /></label>
        </div>
        <div className="form-actions"><button className="primary-button" onClick={() => void saveVoice()}><Save size={15} /> 保存语音配置</button></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>月度额度</h2><p>按金额（含语音）或 tokens 计算，任一项达到提醒线即告警；填 0 表示不限。</p></div></div>
        <div className="dimension-list">
          <div><span>本月费用</span><i><b style={{ width: `${Math.min(100, data.quota.budgetPercent)}%` }} /></i><strong>{yuan(u.totalCost)}{data.quota.monthlyBudgetYuan > 0 ? ` / ¥${data.quota.monthlyBudgetYuan}` : ""}</strong></div>
          <div><span>模型 tokens</span><i><b style={{ width: `${Math.min(100, data.quota.tokenPercent)}%` }} /></i><strong>{u.llmTokens.toLocaleString()}{data.quota.monthlyTokens > 0 ? ` / ${data.quota.monthlyTokens.toLocaleString()}` : ""}</strong></div>
          <div><span>其中模型</span><i><b style={{ width: u.totalCost > 0 ? `${(u.llmCost / u.totalCost) * 100}%` : "0%" }} /></i><strong>{yuan(u.llmCost)}</strong></div>
          <div><span>其中语音</span><i><b style={{ width: u.totalCost > 0 ? `${((u.ttsCost + u.asrCost) / u.totalCost) * 100}%` : "0%" }} /></i><strong>{yuan(u.ttsCost + u.asrCost)}</strong></div>
        </div>
        <div className="form-grid">
          <label>每月费用上限（元）<input type="number" value={quota.monthlyBudgetYuan} onChange={(event) => setQuota({ ...quota, monthlyBudgetYuan: event.target.value })} /></label>
          <label>每月 tokens 上限<input type="number" value={quota.monthlyTokens} onChange={(event) => setQuota({ ...quota, monthlyTokens: event.target.value })} /></label>
          <label>提醒线（%）<input type="number" value={quota.warnPercent} onChange={(event) => setQuota({ ...quota, warnPercent: event.target.value })} /></label>
        </div>
        <div className="form-actions"><button className="primary-button" onClick={() => void saveQuota()}><Save size={15} /> 保存额度</button></div>
      </section>
    </div>
  );
}
