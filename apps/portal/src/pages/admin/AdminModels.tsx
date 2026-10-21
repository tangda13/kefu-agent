import { AlertTriangle, FlaskConical, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LLM_PRESETS,
  LLM_PURPOSES,
  LLM_PURPOSE_LABELS,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  purposesPinnedElsewhere,
  routingAfterDefaultSwitch,
  type LlmProfileView,
  type LlmThinking,
  type LlmPurpose,
  type LlmRoutingSettings,
  type LlmTestResult,
  type ThinkingLevel,
} from "@cecs/contracts";
import { ApiError, apiGet, apiPost, apiRequestDelete, apiRequestPut, type Session } from "../../api/client";
import { samePool, VoicePoolSection, type VoicePoolData, type VoicePoolState } from "./VoicePool";
import { onProvidersTab, takeProvidersTab, type ProvidersTab } from "./providersTab";
import {
  Button, Callout, Confirm, DataTable, Dialog, Drawer, Empty, Field, HeaderTabs, HelpTip, Input, ListRow, Monogram, MoreMenu, SecretInput, Segmented, Select, SettingSection, Sheet,
  Status, Switch, Tag, Textarea, toast,
} from "../../ui";

/* AI 与语音服务（G1–G7，P4 按 DESIGN.md 2.0 重做）：模型、用途分配、语音服务、用量与额度。
   技术参数（超时、请求体、请求头、输出字段名）收进编辑抽屉的「高级设置」。 */

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "无法连接服务器，请稍后重试");

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
    vendor: string; vendors: VoicePoolData["vendors"]; apiKeyMasked: string;
    ttsResourceId: string; asrResourceId: string;
    ttsPricePer10kChars: number; asrPricePerHour: number;
    aliyunApiKeyMasked: string; aliyunBaseUrl: string; aliyunModel: string; aliyunTtsPricePer10kChars: number;
    voicePool: VoicePoolState;
    poolLanguages: VoicePoolData["poolLanguages"];
    missingVoices: Array<{ language: string; label: string; gender: string; message: string }>;
    aliyunFallback: { count: number; authFailed: number; keyInvalid: boolean };
    availableVendors: string[];
    recommendedPool: VoicePoolState;
    buyerCountries: Record<string, string[]>;
  };
  usage: { llmCalls: number; llmTokens: number; llmCost: number; ttsCalls: number; ttsChars: number; ttsCost: number; asrCalls: number; asrMinutes: number; asrCost: number; totalCost: number };
  quota: { monthlyBudgetYuan: number; monthlyTokens: number; warnPercent: number; budgetPercent: number; tokenPercent: number; usedPercent: number; alert: boolean };
}

const yuan = (value: number) => `¥${value > 0 && value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
const seconds = (ms: number | null | undefined) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} 秒`);
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

type ModelTab = ProvidersTab;

export function AdminModels({ session }: { session: Session }) {
  // 从告警“去处理”跳过来时直接打开对应页签（模型 / 语音服务 / 用量与额度）
  const [tab, setTab] = useState<ModelTab>(() => takeProvidersTab() ?? "models");
  useEffect(() => onProvidersTab(setTab), []);
  const [llm, setLlm] = useState<LlmState | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [providers, setProviders] = useState<ProvidersState | null>(null);

  const load = useCallback(() => {
    apiGet<LlmState>("/v1/admin/llm", session).then(setLlm).catch((cause) => toast.error(errorText(cause)));
    apiGet<UsageState>("/v1/admin/llm/usage", session).then(setUsage).catch(() => undefined);
    apiGet<ProvidersState>("/v1/admin/providers", session).then(setProviders).catch(() => undefined);
  }, [session]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <HeaderTabs
        items={[
          { id: "models", label: "模型", count: llm?.profiles.length },
          { id: "voice", label: "语音服务" },
          { id: "usage", label: providers?.quota.alert ? <>用量与额度 <Tag tone="danger">{providers.quota.usedPercent}%</Tag></> : "用量与额度" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Sheet>
        {tab === "models" ? (
          <>
            <ProfilesSection session={session} llm={llm} reload={load} />
            {llm ? <RoutingSection session={session} llm={llm} reload={load} /> : null}
            {providers ? <MonthSummary providers={providers} onOpen={() => setTab("usage")} /> : null}
          </>
        ) : null}
        {tab === "voice" && providers ? <VoiceSection session={session} data={providers} reload={load} /> : null}
        {tab === "usage" ? <UsageSections session={session} usage={usage} providers={providers} reload={load} /> : null}
      </Sheet>
    </>
  );
}

// ---------- 模型 ----------

function ProfilesSection({ session, llm, reload }: { session: Session; llm: LlmState | null; reload: () => void }) {
  const [editing, setEditing] = useState<LlmProfileView | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LlmProfileView | null>(null);
  const [switching, setSwitching] = useState<LlmProfileView | null>(null);
  const vendors = useMemo(() => [...new Set((llm?.profiles ?? []).map((profile) => host(profile.baseUrl)))], [llm]);

  async function test(profile: LlmProfileView) {
    setTesting(profile.id);
    try {
      const result = await apiPost<LlmTestResult>(`/v1/admin/llm/profiles/${profile.id}/test`, session);
      if (result.ok) toast.ok(`「${profile.name}」连接正常，首字 ${seconds(result.ttftMs)}`);
      else toast.error(`「${profile.name}」测试未通过，点“编辑”查看报错`);
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setTesting(null);
    }
  }

  // 有用途单独指定了别的模型时先问是否一起跟随（D-77）
  function askSetDefault(profile: LlmProfileView) {
    if (llm && purposesPinnedElsewhere(llm.routing, profile.id).length) setSwitching(profile);
    else void setDefault(profile, false);
  }

  async function setDefault(profile: LlmProfileView, followRouting: boolean) {
    try {
      await apiRequestPut("/v1/admin/llm/default", session, { profileId: profile.id, followRouting });
      toast.ok(followRouting ? `已把「${profile.name}」设为默认模型，用途一起跟随` : `已把「${profile.name}」设为默认模型`);
      setSwitching(null);
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await apiRequestDelete(`/v1/admin/llm/profiles/${removing.id}`, session);
      toast.ok("已删除");
      setRemoving(null);
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    <SettingSection
      title="模型"
      desc="接入的大模型服务。密钥只加密保存在服务器上；测试通过的模型才能设为默认，或分配给下面的用途。"
      actions={<Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>新增模型</Button>}
    >
      {!llm ? <Empty>正在读取…</Empty> : llm.profiles.length === 0 ? <Empty>还没有模型。点「新增模型」，选好厂商后填入密钥即可。</Empty> : null}
      {llm?.profiles.map((row) => (
        <ListRow
          key={row.id}
          muted={!row.enabled}
          leading={<Monogram text={row.name} tone={vendors.indexOf(host(row.baseUrl)) + 1} />}
          title={<>{row.name}{row.isDefault ? <Tag tone="accent">默认</Tag> : null}{!row.enabled ? <Tag>已停用</Tag> : null}</>}
          meta={`${row.model} · ${host(row.baseUrl)} · ${row.apiKeyMasked || "未设置密钥"}`}
          status={
            row.testStatus === "ok" ? <Status tone="ok">正常 · 首字 {seconds(row.testResult?.ttftMs)}</Status>
              : row.testStatus === "failed" ? <Status tone="danger">测试未通过</Status>
                : <Status>未测试</Status>
          }
          actions={
            <>
              <Button size="sm" variant="ghost" disabled={testing === row.id} onClick={() => void test(row)}>{testing === row.id ? "测试中…" : "测试"}</Button>
              <Button size="sm" onClick={() => setEditing(row)}>编辑</Button>
              {!row.isDefault ? (
                <MoreMenu items={[
                  { label: "设为默认", disabled: row.testStatus !== "ok" || !row.enabled, onClick: () => askSetDefault(row) },
                  { label: "删除", danger: true, onClick: () => setRemoving(row) },
                ]} />
              ) : <span className="menu-placeholder" />}
            </>
          }
        />
      ))}
      {editing ? <ProfileDrawer session={session} profile={editing === "new" ? null : editing} onClose={() => { setEditing(null); reload(); }} onSaved={() => { setEditing(null); reload(); }} /> : null}
      {removing ? (
        <Confirm title="删除模型" danger confirmText="删除" onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          删除「{removing.name}」后，分配给它的用途会改用默认模型。
        </Confirm>
      ) : null}
      {switching && llm ? (
        <DefaultSwitchDialog llm={llm} profile={switching} onChoose={(follow) => setDefault(switching, follow)} onClose={() => setSwitching(null)} />
      ) : null}
    </SettingSection>
  );
}

/** 设为默认时，列出一起跟随后各用途怎么变（只列有变化的） */
function DefaultSwitchDialog({ llm, profile, onChoose, onClose }: { llm: LlmState; profile: LlmProfileView; onChoose: (follow: boolean) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState<"only" | "follow" | null>(null);
  const nameOf = (id: string | null) => (id ? llm.profiles.find((item) => item.id === id)?.name ?? "已删除的模型" : "跟随默认");
  const next = routingAfterDefaultSwitch(llm.routing, {
    from: llm.profiles.find((item) => item.isDefault)?.id ?? null,
    to: profile.id,
    follow: true,
    usable: new Set(llm.profiles.filter((item) => item.enabled && item.testStatus === "ok").map((item) => item.id)),
  });
  const changes = LLM_PURPOSES.map((purpose) => ({ purpose, before: llm.routing.routes[purpose], after: next.routes[purpose] }))
    .filter(({ before, after }) => before.profileId !== after.profileId || before.fallbackProfileId !== after.fallbackProfileId);
  const pinned = purposesPinnedElsewhere(llm.routing, profile.id).length;
  async function choose(follow: boolean) {
    setBusy(follow ? "follow" : "only");
    await onChoose(follow);
    setBusy(null);
  }
  return (
    <Dialog
      title="设为默认模型"
      onClose={onClose}
      footer={
        <>
          <Button loading={busy === "only"} disabled={busy !== null} onClick={() => void choose(false)}>只改默认</Button>
          <Button variant="primary" loading={busy === "follow"} disabled={busy !== null} onClick={() => void choose(true)}>一起改</Button>
        </>
      }
    >
      <p>{pinned} 个用途单独指定了模型。「{profile.name}」设为默认后，要不要一起改为跟随默认？</p>
      <ul className="default-switch-list">
        {changes.map(({ purpose, before, after }) => (
          <li key={purpose}>
            <strong>{LLM_PURPOSE_LABELS[purpose].label}</strong>
            <span>
              {before.profileId !== after.profileId ? <>{nameOf(before.profileId)} → 跟随默认</> : <>跟随默认</>}
              {before.fallbackProfileId !== after.fallbackProfileId ? (
                <small>备用 {nameOf(before.fallbackProfileId)} → {after.fallbackProfileId ? nameOf(after.fallbackProfileId) : "不设备用"}</small>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function ProfileDrawer({ session, profile, onClose, onSaved }: { session: Session; profile: LlmProfileView | null; onClose: () => void; onSaved: () => void }) {
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
    timeoutSeconds: String(Math.round((profile?.timeoutMs ?? 60000) / 1000)),
    priceInput: String(profile?.priceInput ?? 0),
    priceOutput: String(profile?.priceOutput ?? 0),
    enabled: profile?.enabled ?? true,
  }));
  /** 深度思考：开关 + 档位；参数写法随厂商模板带出（新档案默认关闭） */
  const [thinking, setThinking] = useState<LlmThinking>(() => profile?.thinking ?? { enabled: false, level: "default", params: LLM_PRESETS[0]!.thinking });
  const [result, setResult] = useState<LlmTestResult | null>(profile?.testResult ?? null);
  const [busy, setBusy] = useState<"" | "test" | "save" | "saveTest">("");
  /** 新增时第一次保存后记下 id：测试没过留在抽屉里改，再点保存是更新这一条，不是再建一条 */
  const [savedId, setSavedId] = useState(profile?.id ?? null);
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
    // 换厂商：思考参数写法换成新厂商的，原档位不一定还能用，回到关闭
    setThinking({ enabled: false, level: "default", params: next.thinking });
  }

  /** 这个厂商能选的档位；只有“模型默认”时不显示档位选择 */
  const levelItems = useMemo(
    () => [
      { id: "default" as const, label: THINKING_LEVEL_LABELS.default },
      ...THINKING_LEVELS.filter((level) => thinking.params?.levels[level]).map((level) => ({ id: level, label: THINKING_LEVEL_LABELS[level] })),
    ],
    [thinking.params],
  );

  function payload() {
    let extraBody: unknown;
    let extraHeaders: unknown;
    try {
      extraBody = JSON.parse(form.extraBody.trim() || "{}");
      extraHeaders = JSON.parse(form.extraHeaders.trim() || "{}");
    } catch {
      throw new Error("高级设置里的附加参数和请求头必须是合法的 JSON");
    }
    return {
      name: form.name,
      presetKey: form.presetKey,
      baseUrl: form.baseUrl,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      model: form.model,
      extraBody,
      extraHeaders,
      thinking,
      maxTokensField: form.maxTokensField,
      jsonMode: form.jsonMode,
      timeoutMs: (Number(form.timeoutSeconds) || 60) * 1000,
      priceInput: Number(form.priceInput) || 0,
      priceOutput: Number(form.priceOutput) || 0,
      enabled: form.enabled,
    };
  }

  async function testDraft() {
    setBusy("test");
    setError("");
    try {
      setResult(await apiPost<LlmTestResult>("/v1/admin/llm/test", session, { ...payload(), ...(savedId ? { id: savedId } : {}) }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  async function save(thenTest: boolean) {
    setBusy(thenTest ? "saveTest" : "save");
    setError("");
    try {
      const body = payload();
      let id = savedId;
      if (id) await apiRequestPut(`/v1/admin/llm/profiles/${id}`, session, body);
      else {
        id = (await apiPost<{ id: string }>("/v1/admin/llm/profiles", session, body)).id;
        setSavedId(id);
      }
      if (thenTest) {
        const tested = await apiPost<LlmTestResult>(`/v1/admin/llm/profiles/${id}/test`, session);
        if (!tested.ok) {
          setResult(tested);
          setError("已保存，但连接测试没有通过，请根据下方报错修改");
          return;
        }
        toast.ok(`「${form.name}」已保存，连接正常`);
      } else {
        toast.ok(`「${form.name}」已保存`);
      }
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  return (
    <Drawer
      title={profile ? `编辑模型 · ${profile.name}` : "新增模型"}
      width={720}
      onClose={onClose}
      footer={
        <>
          <Button icon={FlaskConical} loading={busy === "test"} disabled={Boolean(busy)} onClick={() => void testDraft()}>测试连接</Button>
          <span className="drawer-foot-fill" />
          <Button disabled={Boolean(busy)} loading={busy === "save"} onClick={() => void save(false)}>仅保存</Button>
          <Button variant="primary" disabled={Boolean(busy)} loading={busy === "saveTest"} onClick={() => void save(true)}>保存并测试</Button>
        </>
      }
    >
      {preset?.note ? <p className="drawer-note">{preset.note}</p> : null}
      <div className="form-grid-2">
        <Field label="厂商">
          <Select value={form.presetKey} onChange={(event) => applyPreset(event.target.value)}>
            {LLM_PRESETS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </Select>
        </Field>
        <Field label="名称" hint="在本系统里显示的名字"><Input value={form.name} onChange={set("name")} /></Field>
        <Field label="服务地址" hint="填到 /v1 这一级"><Input value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://api.example.com/v1" /></Field>
        <Field label="密钥" hint="厂商控制台里创建的 API Key">
          {/* 解不开的旧密钥（加密密钥换过）服务端返回说明文字，按“没设置”处理，让人重新填 */}
          <SecretInput
            masked={profile?.apiKeyMasked && !profile.apiKeyMasked.startsWith("（") ? profile.apiKeyMasked : undefined}
            value={form.apiKey}
            onChange={(apiKey) => setForm({ ...form, apiKey })}
            placeholder={profile?.apiKeyMasked?.startsWith("（") ? "原密钥无法解密，请重新填写" : "sk-..."}
          />
        </Field>
        <Field label="模型名">
          <Input value={form.model} onChange={set("model")} list="llm-model-options" />
          <datalist id="llm-model-options">{preset?.models.map((model) => <option key={model} value={model} />)}</datalist>
        </Field>
        <Field label="启用">
          <span className="switch-line"><Switch checked={form.enabled} label="启用" onChange={(enabled) => setForm({ ...form, enabled })} />{form.enabled ? "启用中" : "已停用，不会被调用"}</span>
        </Field>
        <div className="ui-field">
          <span className="ui-field-label">
            深度思考
            <HelpTip label="深度思考说明">
                关闭回复更快，买家对话要求首字 3 秒内，建议关闭；开启后推理更好，但更慢、更费 tokens，系统会自动给思考多留回复长度。各模型能用的设置不同（例如 GLM 经总网关不能关闭，只能选 低 / 高 / 最高），测试不通过就换一下再测。
            </HelpTip>
          </span>
          {thinking.params ? (
            <span className="switch-line">
              <Switch checked={thinking.enabled} label="深度思考" onChange={(enabled) => setThinking({ ...thinking, enabled })} />
              {thinking.enabled ? "已开启" : "已关闭"}
            </span>
          ) : (
            <span className="switch-line">这个厂商没有思考开关，按模型默认</span>
          )}
        </div>
        <div className="ui-field">
          <span className="ui-field-label">思考档位</span>
          {levelItems.length > 1 ? (
            <Segmented<ThinkingLevel | "default">
              items={levelItems}
              value={thinking.level}
              disabled={!thinking.enabled || !thinking.params}
              onChange={(level) => setThinking({ ...thinking, level })}
            />
          ) : (
            <span className="switch-line">{thinking.params ? "这个厂商不分档位，开启即按模型默认" : "—"}</span>
          )}
        </div>
        <Field label="输入单价" hint="元 / 百万 tokens，用于统计费用"><Input type="number" step="0.01" value={form.priceInput} onChange={set("priceInput")} /></Field>
        <Field label="输出单价" hint="元 / 百万 tokens"><Input type="number" step="0.01" value={form.priceOutput} onChange={set("priceOutput")} /></Field>
      </div>

      <details className="advanced">
        <summary>高级设置</summary>
        <div className="form-grid-2">
          <Field label="超时" hint="秒，超过就算失败并切到备用模型"><Input type="number" value={form.timeoutSeconds} onChange={set("timeoutSeconds")} /></Field>
          <Field label="回复长度字段名">
            <Select value={form.maxTokensField} onChange={set("maxTokensField")}>
              <option value="max_tokens">max_tokens（多数厂商）</option>
              <option value="max_completion_tokens">max_completion_tokens（OpenAI 新模型）</option>
            </Select>
          </Field>
          <Field label="结构化输出">
            <span className="switch-line"><Switch checked={form.jsonMode} label="支持 JSON 模式" onChange={(jsonMode) => setForm({ ...form, jsonMode })} />支持 JSON 模式（评分、情绪推进会用到）</span>
          </Field>
          <span />
          <Field label="附加请求参数" hint="JSON，合并进每次请求；深度思考用上面的开关">
            <Textarea rows={5} className="mono" value={form.extraBody} onChange={set("extraBody")} spellCheck={false} />
          </Field>
          <Field label="附加请求头" hint="JSON">
            <Textarea rows={5} className="mono" value={form.extraHeaders} onChange={set("extraHeaders")} spellCheck={false} />
          </Field>
        </div>
      </details>

      {error ? <p className="drawer-error" role="alert">{error}</p> : null}
      {result ? (
        <div className={result.ok ? "test-result is-ok" : "test-result is-bad"}>
          {result.ok ? (
            <>
              <strong>连接正常</strong>
              <span>首字 {seconds(result.ttftMs)} · 输出 {result.charsPerSecond} 字/秒 · 用了 {result.inputTokens + result.outputTokens} tokens</span>
              {result.sample ? <q>{result.sample}</q> : null}
              {result.note ? <span>{result.note}</span> : null}
            </>
          ) : (
            <>
              <strong>测试未通过</strong>
              <pre>{result.error}</pre>
            </>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------- 用途分配 ----------

function RoutingSection({ session, llm, reload }: { session: Session; llm: LlmState; reload: () => void }) {
  const [routing, setRouting] = useState<LlmRoutingSettings>(llm.routing);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => setRouting(llm.routing), [llm.routing]);
  const usable = llm.profiles.filter((profile) => profile.enabled && profile.testStatus === "ok");
  const defaultProfile = llm.profiles.find((profile) => profile.isDefault);
  const dirty = JSON.stringify(routing) !== JSON.stringify(llm.routing);

  function update(purpose: LlmPurpose, patch: Partial<LlmRoutingSettings["routes"][LlmPurpose]>) {
    setRouting((current) => ({ ...current, routes: { ...current.routes, [purpose]: { ...current.routes[purpose], ...patch } } }));
  }

  async function save() {
    setBusy(true);
    try {
      await apiRequestPut("/v1/admin/llm/routing", session, routing);
      toast.ok("用途分配已保存，立即生效");
      setAdvanced(false);
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingSection
      title="用途分配"
      desc={<>不同任务用不同模型：对话要快，评分要稳。没有单独指定的用途使用默认模型（{defaultProfile?.name ?? "未设置"}）；主模型连续出错 3 次，自动改用备用模型 5 分钟。</>}
      actions={
        <>
          {dirty ? <Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button> : null}
          {dirty ? <Button variant="ghost" onClick={() => setRouting(llm.routing)}>放弃修改</Button> : null}
          <Button variant="text" onClick={() => setAdvanced(true)}>高级设置：随机性、回复长度</Button>
        </>
      }
    >
      {LLM_PURPOSES.map((purpose) => (
        <div key={purpose} className="route-row">
          <div>
            <strong>{LLM_PURPOSE_LABELS[purpose].label}</strong>
            <small>{LLM_PURPOSE_LABELS[purpose].hint}</small>
          </div>
          <Select value={routing.routes[purpose].profileId ?? ""} onChange={(event) => update(purpose, { profileId: event.target.value || null })}>
            <option value="">跟随默认（{defaultProfile?.name ?? "未设置"}）</option>
            {usable.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </Select>
          <span className="route-arrow">备用</span>
          <Select value={routing.routes[purpose].fallbackProfileId ?? ""} onChange={(event) => update(purpose, { fallbackProfileId: event.target.value || null })}>
            <option value="">不设备用</option>
            {usable.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </Select>
        </div>
      ))}

      {advanced ? (
        <Drawer
          title="用途分配 · 高级设置"
          onClose={() => setAdvanced(false)}
          footer={<><Button onClick={() => setAdvanced(false)}>关闭</Button><Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>保存</Button></>}
        >
          <p className="drawer-note">一般不需要改。随机性越大回复越多变（对话建议 0.8，评分建议 0.2）；回复长度上限的单位是 tokens，约等于 1 个汉字或 0.7 个英文单词。</p>
          {LLM_PURPOSES.map((purpose) => (
            <div key={purpose} className="adv-row">
              <strong>{LLM_PURPOSE_LABELS[purpose].label}</strong>
              <Field label="随机性"><Input type="number" step="0.1" min="0" max="2" value={routing.routes[purpose].temperature} onChange={(event) => update(purpose, { temperature: Number(event.target.value) })} /></Field>
              <Field label="回复长度上限"><Input type="number" min="16" value={routing.routes[purpose].maxTokens} onChange={(event) => update(purpose, { maxTokens: Number(event.target.value) })} /></Field>
            </div>
          ))}
          <Field label="满意度与表现评估的频率" hint="学生每发几条消息，在后台评估一次买家满意度、情绪和学生表现。调大能省钱，但教师端走势会粗一些，催促快慢按较早的情绪算。">
            <span className="inline-number">每<Input type="number" min="1" max="10" className="num-input" value={routing.directorEveryNTurns} onChange={(event) => setRouting({ ...routing, directorEveryNTurns: Number(event.target.value) || 1 })} />条运行一次</span>
          </Field>
        </Drawer>
      ) : null}
    </SettingSection>
  );
}

// ---------- 本月用量摘要 ----------

function MonthSummary({ providers, onOpen }: { providers: ProvidersState; onOpen?: () => void }) {
  const u = providers.usage;
  const q = providers.quota;
  return (
    <SettingSection
      title="本月用量"
      desc="按各模型填写的单价折算。设置了上限后，达到提醒线会在管理端顶部提醒。"
      actions={onOpen ? <Button variant="text" onClick={onOpen}>查看明细、设置额度</Button> : undefined}
    >
      <div className="usage-tiles">
        <UsageTile label="本月费用" value={yuan(u.totalCost)} percent={q.monthlyBudgetYuan > 0 ? q.budgetPercent : null} note={q.monthlyBudgetYuan > 0 ? `上限 ¥${q.monthlyBudgetYuan} · 已用 ${q.budgetPercent}%` : "未设上限"} alert={q.alert && q.budgetPercent >= q.warnPercent} />
        <UsageTile label="模型 tokens" value={u.llmTokens.toLocaleString()} percent={q.monthlyTokens > 0 ? q.tokenPercent : null} note={q.monthlyTokens > 0 ? `上限 ${q.monthlyTokens.toLocaleString()} · 已用 ${q.tokenPercent}%` : "未设上限"} alert={q.alert && q.tokenPercent >= q.warnPercent} />
        <UsageTile label="模型调用" value={u.llmCalls.toLocaleString()} percent={null} note={`语音朗读 ${u.ttsCalls} 次 · 识别 ${u.asrCalls} 次`} />
      </div>
    </SettingSection>
  );
}

function UsageTile({ label, value, percent, note, alert }: { label: string; value: string; percent: number | null; note: string; alert?: boolean }) {
  return (
    <div className="usage-tile">
      <span className="figure-label">{label}</span>
      <strong className="usage-value num">{value}</strong>
      <span className="usage-bar"><i className={alert ? "is-danger" : undefined} style={{ width: `${percent === null ? 0 : Math.min(100, percent)}%` }} /></span>
      <span className="figure-extra">{note}</span>
    </div>
  );
}

// ---------- 语音服务 ----------


function VoiceSection({ session, data, reload }: { session: Session; data: ProvidersState; reload: () => void }) {
  const [voice, setVoice] = useState({ ...data.voice, apiKey: "", aliyunApiKey: "" });
  const [pool, setPool] = useState<VoicePoolState>(data.voice.voicePool);
  const [busy, setBusy] = useState(false);
  const u = data.usage;
  const fallback = data.voice.aliyunFallback;

  async function save() {
    setBusy(true);
    try {
      await apiRequestPut("/v1/admin/providers", session, {
        voice: {
          vendor: voice.vendor,
          ...(voice.apiKey ? { apiKey: voice.apiKey } : {}),
          ...(voice.aliyunApiKey ? { aliyunApiKey: voice.aliyunApiKey } : {}),
          ttsResourceId: voice.ttsResourceId,
          asrResourceId: voice.asrResourceId,
          aliyunBaseUrl: voice.aliyunBaseUrl,
          aliyunModel: voice.aliyunModel,
          ttsPricePer10kChars: Number(voice.ttsPricePer10kChars) || 0,
          asrPricePerHour: Number(voice.asrPricePerHour) || 0,
          aliyunTtsPricePer10kChars: Number(voice.aliyunTtsPricePer10kChars) || 0,
          voicePool: pool,
        },
      });
      setVoice((current) => ({ ...current, apiKey: "", aliyunApiKey: "" }));
      toast.ok("语音服务已保存，立即生效");
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof voice) => (event: { target: { value: string } }) => setVoice({ ...voice, [key]: event.target.value });
  const saveButton = <Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button>;
  return (
    <>
      <span id="voice-keys" className="anchor" aria-hidden="true" />
      <SettingSection
        title="阿里云百炼 · 主用"
        desc="买家朗读优先用千问3-TTS（只做朗读，不做识别）。出错时这一次自动改用豆包，不配置时全部由豆包朗读。"
        actions={saveButton}
      >
        {fallback.keyInvalid ? (
          <div className="voice-missing">
            <Callout tone="danger" icon={AlertTriangle} title="阿里云密钥无效">
              近 24 小时有 {fallback.authFailed} 次因鉴权失败改用豆包，请检查 API Key，以及接口地址与 Key 所在地域是否一致。
            </Callout>
          </div>
        ) : null}
        <div className="form-grid-2 form-max">
          <Field label="百炼 API Key" hint="在阿里云百炼控制台“API-KEY”页创建"><SecretInput masked={data.voice.aliyunApiKeyMasked} value={voice.aliyunApiKey} onChange={(aliyunApiKey) => setVoice({ ...voice, aliyunApiKey })} placeholder="sk-..." /></Field>
          <Field label="模型"><Input value={voice.aliyunModel} onChange={set("aliyunModel")} /></Field>
          <Field label="接口地址" hint="北京地域；新加坡地域需换成国际站地址和对应 Key"><Input value={voice.aliyunBaseUrl} onChange={set("aliyunBaseUrl")} /></Field>
        </div>
        <p className="muted">近 24 小时阿里云出错、自动改用豆包 <strong className="num">{fallback.count}</strong> 次（限流、超时、服务端错误、密钥无效等）。</p>
      </SettingSection>
      <SettingSection
        title="豆包语音（火山引擎）· 备用"
        desc="语音识别固定走豆包；朗读作为阿里云的备用，阿里云没有对应语种或音色、或这一次请求出错时由豆包朗读。"
        actions={saveButton}
      >
        <div className="form-grid-2 form-max">
          <Field label="密钥" hint="火山引擎豆包语音控制台里的 API Key"><SecretInput masked={data.voice.apiKeyMasked} value={voice.apiKey} onChange={(apiKey) => setVoice({ ...voice, apiKey })} /></Field>
          <span />
          <Field label="朗读资源 ID"><Input value={voice.ttsResourceId} onChange={set("ttsResourceId")} /></Field>
          <Field label="识别资源 ID"><Input value={voice.asrResourceId} onChange={set("asrResourceId")} /></Field>
        </div>
      </SettingSection>
      <VoicePoolSection
        session={session}
        data={data.voice}
        pool={pool}
        onChange={setPool}
        dirty={!samePool(pool, data.voice.voicePool)}
        saveButton={saveButton}
        onGoKeys={() => document.getElementById("voice-keys")?.scrollIntoView({ behavior: "smooth", block: "start" })}
      />
      <SettingSection title="计费" desc={`用于统计费用。本月朗读 ${u.ttsChars.toLocaleString()} 字、识别 ${u.asrMinutes} 分钟，合计 ${yuan(u.ttsCost + u.asrCost)}。`}>
        <div className="form-grid-2 form-max">
          <Field label="豆包朗读单价" hint="元 / 万字"><Input type="number" step="0.01" value={voice.ttsPricePer10kChars} onChange={set("ttsPricePer10kChars")} /></Field>
          <Field label="识别单价" hint="元 / 小时"><Input type="number" step="0.01" value={voice.asrPricePerHour} onChange={set("asrPricePerHour")} /></Field>
          <Field label="阿里云朗读单价" hint="元 / 万字（千问3-TTS-Flash 官方价 0.8，以控制台为准）"><Input type="number" step="0.01" value={voice.aliyunTtsPricePer10kChars} onChange={set("aliyunTtsPricePer10kChars")} /></Field>
        </div>
      </SettingSection>
    </>
  );
}


// ---------- 用量与额度 ----------

function UsageSections({ session, usage, providers, reload }: { session: Session; usage: UsageState | null; providers: ProvidersState | null; reload: () => void }) {
  const [quota, setQuota] = useState({ monthlyBudgetYuan: "", monthlyTokens: "", warnPercent: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (providers) setQuota({ monthlyBudgetYuan: String(providers.quota.monthlyBudgetYuan), monthlyTokens: String(providers.quota.monthlyTokens), warnPercent: String(providers.quota.warnPercent) });
  }, [providers]);
  if (!providers) return <Empty>正在读取…</Empty>;

  async function save() {
    setBusy(true);
    try {
      await apiRequestPut("/v1/admin/providers", session, {
        quota: { monthlyBudgetYuan: Number(quota.monthlyBudgetYuan) || 0, monthlyTokens: Number(quota.monthlyTokens) || 0, warnPercent: Number(quota.warnPercent) || 80 },
      });
      toast.ok("额度已保存");
      reload();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MonthSummary providers={providers} />
      <SettingSection title="月度额度" desc="按金额（含语音）或 tokens 计算，任一项达到提醒线就在管理端顶部提醒。填 0 表示不限。" actions={<Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button>}>
        <div className="form-grid-3 form-max">
          <Field label="每月费用上限" hint="元"><Input type="number" value={quota.monthlyBudgetYuan} onChange={(event) => setQuota({ ...quota, monthlyBudgetYuan: event.target.value })} /></Field>
          <Field label="每月 tokens 上限"><Input type="number" value={quota.monthlyTokens} onChange={(event) => setQuota({ ...quota, monthlyTokens: event.target.value })} /></Field>
          <Field label="提醒线" hint="%，达到后提醒"><Input type="number" value={quota.warnPercent} onChange={(event) => setQuota({ ...quota, warnPercent: event.target.value })} /></Field>
        </div>
      </SettingSection>
      <SettingSection title="按用途" desc="本月每种用途的调用、失败和费用。“用了备用”是主模型出错后自动切换的次数。">
        <DataTable
          rows={[...LLM_PURPOSES]}
          rowKey={(purpose) => purpose}
          columns={[
            { key: "purpose", title: "用途", render: (purpose) => LLM_PURPOSE_LABELS[purpose].label },
            { key: "calls", title: "调用", width: 80, align: "right", render: (purpose) => usage?.byPurpose.find((row) => row.purpose === purpose)?.calls ?? 0 },
            { key: "failures", title: "失败", width: 70, align: "right", render: (purpose) => usage?.byPurpose.find((row) => row.purpose === purpose)?.failures ?? 0 },
            { key: "fallbacks", title: "用了备用", width: 90, align: "right", render: (purpose) => usage?.byPurpose.find((row) => row.purpose === purpose)?.fallbacks ?? 0 },
            { key: "tokens", title: "tokens", width: 110, align: "right", render: (purpose) => (usage?.byPurpose.find((row) => row.purpose === purpose)?.tokens ?? 0).toLocaleString() },
            { key: "cost", title: "费用", width: 100, align: "right", render: (purpose) => yuan(usage?.byPurpose.find((row) => row.purpose === purpose)?.cost ?? 0) },
          ]}
        />
      </SettingSection>
      {usage?.byProfile.length ? (
        <SettingSection title="按模型" desc="本月每个模型的用量和平均首字时间。">
          <DataTable
            rows={usage.byProfile}
            rowKey={(row) => `${row.profileName}-${row.model}`}
            columns={[
              { key: "name", title: "模型", render: (row) => <>{row.profileName}<small>{row.model}</small></> },
              { key: "calls", title: "调用", width: 80, align: "right", render: (row) => row.calls },
              { key: "failures", title: "失败", width: 70, align: "right", render: (row) => row.failures },
              { key: "tokens", title: "tokens", width: 110, align: "right", render: (row) => (row.inputTokens + row.outputTokens).toLocaleString() },
              { key: "ttft", title: "平均首字", width: 100, align: "right", render: (row) => seconds(row.avgTtftMs) },
              { key: "cost", title: "费用", width: 100, align: "right", render: (row) => yuan(row.cost) },
            ]}
          />
        </SettingSection>
      ) : null}
    </>
  );
}
