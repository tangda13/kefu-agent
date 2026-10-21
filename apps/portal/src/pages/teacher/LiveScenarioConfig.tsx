import { CircleAlert, CopyPlus, Dices, EyeOff, FileUp, Heart, Lock, Mail, MessageCircle, Moon, Pencil, Pin, Plus, Repeat2, RotateCw, Shuffle, SlidersHorizontal, Sparkles, Sprout, type LucideIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as XLSX from "xlsx";
import {
  BUSINESS_STAGES, BUSINESS_STAGE_LABELS, BUYER_ROLES, CUSTOMER_TYPES, DECISION_STYLES, DECISION_STYLE_INFO, PERSONA_CONCERNS, PERSONA_CONCERN_MAX, personaDisplayName, EMOTIONS, NATIONALITIES, ORDER_KINDS, ORDER_KIND_LABELS, PERSONALITIES,
  SCENARIO_CHANNEL_LABELS, SCENARIO_SCRIPT_FIELDS, SUPPORTED_LANGUAGES, type BusinessStage, type OrderKind, type ScenarioChannel,
} from "@cecs/contracts";
import {
  ApiError, apiGet, apiPost, apiRequestPatch, createPersona, deletePersona, fetchPersonas, fetchScenarios, fetchTeacherTasks,
  generatePersonaDraft, samplePersona, updatePersona,
  fetchStoreCoupons,
  type PersonaSample, type PersonaTemplate, type ScenarioSummary, type Session, type StoreCoupon, type StoreProduct, type TeacherTask,
} from "../../api/client";
import {
  Bench, Board, Button, Confirm, DataTable, Dialog, Drawer, Field, FilterChips, HeaderTabs, HelpTip, Input, MoreMenu, SearchBox, Segmented, Select, StageTag,
  Switch, Textarea, Toolbar, toast,
} from "../../ui";
import { composePersonaWithRule } from "@cecs/domain";
import { ProductTab } from "./ProductConfig";
import { CouponTab } from "./CouponConfig";

type ConfigTab = "scenarios" | "personas" | "products" | "coupons";

const LANGUAGE_LABELS: Record<string, string> = { "en-US": "英语", "es-ES": "西班牙语", "fr-FR": "法语" };
const LANGUAGE_BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(LANGUAGE_LABELS).map(([code, label]) => [label, code]));
const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
/** 客户类型：分类色（复购老客 1、潜在意向客 2、粉丝客 4，沉睡客 6）+ 图标。画像卡片用图标代替真人头像（D-32） */
const CUSTOMER_TYPE_CAT: Record<string, number> = { 复购老客: 1, 潜在意向客: 2, 粉丝客: 4 };
const CUSTOMER_TYPE_ICON: Record<string, LucideIcon> = { 复购老客: Repeat2, 潜在意向客: Sprout, 粉丝客: Heart, 沉睡客: Moon };

export function LiveScenarioConfig({ session }: { session: Session }) {
  const [tab, setTab] = useState<ConfigTab>("scenarios");
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [personas, setPersonas] = useState<PersonaTemplate[]>([]);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [coupons, setCoupons] = useState<StoreCoupon[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [scenarioList, personaList, productList, couponList] = await Promise.all([
        fetchScenarios(session), fetchPersonas(session), apiGet<StoreProduct[]>("/v1/store/products?all=1", session), fetchStoreCoupons(session),
      ]);
      setScenarios(scenarioList);
      setPersonas(personaList);
      setProducts(productList);
      setCoupons(couponList);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [session]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <HeaderTabs
        items={[
          { id: "scenarios", label: "场景", count: scenarios.length },
          { id: "personas", label: "买家画像", count: personas.length },
          { id: "products", label: "店铺商品", count: products.length },
          { id: "coupons", label: "优惠券", count: coupons.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "scenarios" ? <ScenarioTab session={session} scenarios={scenarios} reload={load} /> : null}
      {tab === "personas" ? <PersonaTab session={session} personas={personas} loading={loading} reload={load} /> : null}
      {tab === "products" ? <ProductTab session={session} products={products} loading={loading} reload={load} /> : null}
      {tab === "coupons" ? <CouponTab session={session} coupons={coupons} products={products} loading={loading} reload={load} /> : null}
    </>
  );
}

// ---------- 场景 ----------

function ScenarioTab({ session, scenarios, reload }: { session: Session; scenarios: ScenarioSummary[]; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<ScenarioSummary | "new" | null>(null);
  const [keyword, setKeyword] = useState("");
  const [channel, setChannel] = useState<"" | ScenarioChannel>("");

  async function toggle(item: ScenarioSummary, enabled: boolean) {
    try {
      await apiRequestPatch(`/v1/catalog/scenarios/${item.id}`, session, { enabled });
      toast.ok(enabled ? `已启用「${item.name}」` : `已停用「${item.name}」，新建任务时不再出现`);
      await reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function copy(item: ScenarioSummary) {
    try {
      const created = await apiPost<{ id: string; name: string }>("/v1/catalog/scenarios", session, { fromId: item.id });
      toast.ok(`已复制为「${created.name}」，可以接着修改`);
      await reload();
      const list = await fetchScenarios(session);
      setEditing(list.find((row) => row.id === created.id) ?? null);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const word = keyword.trim().toLowerCase();
  const channelOf = (item: ScenarioSummary) => item.channel ?? "chat";
  const matches = (item: ScenarioSummary) => (!channel || channelOf(item) === channel) && (!word || `${item.name} ${item.objective}`.toLowerCase().includes(word));

  return (
    <Bench>
      <Toolbar actions={<Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>新建场景</Button>}>
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索场景" />
        <FilterChips
          items={[
            { id: "" as const, label: "全部", count: scenarios.length },
            { id: "chat" as const, label: "在线会话", count: scenarios.filter((item) => channelOf(item) === "chat").length },
            { id: "mail" as const, label: "邮件", count: scenarios.filter((item) => channelOf(item) === "mail").length },
          ]}
          value={channel}
          onChange={setChannel}
        />
        <span className="sc-note"><Lock size={13} />学生看不到剧本<HelpTip>剧本（买家目标、隐藏信息、让步底线等）只交给 AI 买家扮演用，学生端任何地方都不显示</HelpTip></span>
      </Toolbar>
      {/* 按业务环节分区：每个环节一行标题 + 三列卡片。只有缺剧本才标橙（健康度），底部是沟通方式和被几个任务在用（影响面） */}
      <div className="sc-sections">
        {BUSINESS_STAGES.map((stage) => {
          const all = scenarios.filter((item) => item.stage === stage);
          const list = all.filter(matches);
          const enabled = all.filter((item) => item.enabled).length;
          if ((word || channel) && list.length === 0) return null;
          return (
            <section key={stage} className="sc-sec">
              <header className="sc-sec-head">
                <StageTag stage={stage} />
                <span>{all.length} 个 · {enabled === all.length ? "全部启用" : `${enabled} 个启用`}</span>
                {all.length ? (
                  <MoreMenu
                    trigger={<><CopyPlus size={14} />复制一个场景</>}
                    triggerClassName="sc-sec-copy"
                    items={all.map((item) => ({ label: `复制「${item.name}」`, onClick: () => void copy(item) }))}
                  />
                ) : null}
              </header>
              {all.length === 0 ? <p className="sc-none">这个环节还没有场景，点右上角「新建场景」</p> : null}
              <div className="sc-grid">
              {list.map((item) => {
                const missing = SCENARIO_SCRIPT_FIELDS.filter(({ key }) => !item.script?.[key]?.trim()).length;
                const tasks = item.taskCount ?? 0;
                const mail = channelOf(item) === "mail";
                return (
                  <article
                    key={item.id}
                    className={item.enabled ? "sc-card" : "sc-card is-off"}
                    role="button"
                    tabIndex={0}
                    onClick={() => setEditing(item)}
                    onKeyDown={(event) => { if (event.key === "Enter") setEditing(item); }}
                  >
                    <div className="sc-card-top">
                      <b>{item.name}</b>
                      <span onClick={(event) => event.stopPropagation()}>
                        <Switch checked={item.enabled} label={`启用 ${item.name}`} onChange={(next) => void toggle(item, next)} />
                      </span>
                    </div>
                    <p title={item.objective}>{item.objective}</p>
                    <div className="sc-card-foot">
                      <span>{mail ? <Mail size={14} /> : <MessageCircle size={14} />}{SCENARIO_CHANNEL_LABELS[channelOf(item)]}</span>
                      {missing ? <span className="is-warn"><CircleAlert size={14} />剧本缺 {missing} 项</span> : null}
                      <span className="sc-card-use">{tasks ? `${tasks} 个任务在用` : "没有任务在用"}</span>
                    </div>
                  </article>
                );
              })}
              </div>
            </section>
          );
        })}
        {(word || channel) && !scenarios.some(matches) ? <p className="sc-none">没有匹配的场景</p> : null}
      </div>
      {editing ? (
        <ScenarioDrawer
          session={session}
          scenario={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      ) : null}
    </Bench>
  );
}

/** 场景编辑抽屉：新建（scenario = null）与编辑共用 */
function ScenarioDrawer({ session, scenario, onClose, onSaved }: { session: Session; scenario: ScenarioSummary | null; onClose: () => void; onSaved: () => void }) {
  const [stage, setStage] = useState<BusinessStage>(scenario?.stage ?? "pre_sale");
  const [channel, setChannel] = useState<ScenarioChannel>(scenario?.channel ?? "chat");
  const [orderKind, setOrderKind] = useState<OrderKind | "">(scenario?.orderKind ?? "");
  const [customerTypes, setCustomerTypes] = useState<string[]>(scenario?.customerTypes ?? []);
  const [name, setName] = useState(scenario?.name ?? "");
  const [objective, setObjective] = useState(scenario?.objective ?? "");
  const [script, setScript] = useState<Record<string, string>>(() => Object.fromEntries(SCENARIO_SCRIPT_FIELDS.map(({ key }) => [key, scenario?.script?.[key] ?? ""])));
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || !objective.trim()) return toast.error("名称和训练目标不能为空");
    setBusy(true);
    try {
      const fields = { name: name.trim(), objective: objective.trim(), channel, orderKind: orderKind || null, customerTypes };
      if (scenario) {
        await apiRequestPatch(`/v1/catalog/scenarios/${scenario.id}`, session, { ...fields, script });
      } else {
        const created = await apiPost<{ id: string }>("/v1/catalog/scenarios", session, { ...fields, stage });
        await apiRequestPatch(`/v1/catalog/scenarios/${created.id}`, session, { script, customerTypes });
      }
      toast.ok(scenario ? "已保存，之后新开始的接待马上用新剧本" : "已新建，新建任务时可以选它了");
      onSaved();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={scenario ? `编辑场景 · ${BUSINESS_STAGE_LABELS[scenario.stage]}` : "新建场景"}
      width={720}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{scenario ? "保存" : "新建"}</Button></>}
    >
      <div className="form-block">
        <div className="form-stack">
          {!scenario ? (
            <Field label="业务环节">
              <Select value={stage} onChange={(event) => setStage(event.target.value as BusinessStage)}>
                {BUSINESS_STAGES.map((item) => <option key={item} value={item}>{BUSINESS_STAGE_LABELS[item]}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="场景名称"><Input maxLength={40} autoFocus={!scenario} value={name} placeholder="退款进度查询" onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="训练目标" hint="学生在任务里能看到这一句"><Textarea rows={2} maxLength={300} value={objective} onChange={(event) => setObjective(event.target.value)} /></Field>
          <div className="form-grid-2">
            <Field label="沟通方式">
              <Segmented
                items={[{ id: "chat" as const, label: "在线会话" }, { id: "mail" as const, label: "邮件" }]}
                value={channel}
                onChange={setChannel}
              />
            </Field>
            <Field label={<>关联订单<HelpTip>开始接待时给买家生成一张什么状态的订单，学生在订单面板里能查到。选“按业务环节”时售中、售后各随机一半</HelpTip></>}>
              <Select value={orderKind} onChange={(event) => setOrderKind(event.target.value as OrderKind | "")}>
                <option value="">按业务环节</option>
                {ORDER_KINDS.map((item) => <option key={item} value={item}>{ORDER_KIND_LABELS[item]}</option>)}
              </Select>
            </Field>
          </div>
          <Field label={<>适用客户类型<HelpTip>新建任务选了这个场景时，买家范围会自动预选这些客户类型，老师可以再改。不选 = 不限</HelpTip></>}>
            <OptionChips items={CUSTOMER_TYPES} icons={CUSTOMER_TYPE_ICON} value={customerTypes} onChange={setCustomerTypes} />
          </Field>
        </div>
      </div>
      <div className="form-block">
        <h3>剧本</h3>
        <p className="form-block-desc">只给 AI 买家看，学生看不到。写得越具体，买家越像真人。</p>
        <div className="form-stack">
          {SCENARIO_SCRIPT_FIELDS.map(({ key, label }) => (
            <Field key={key} label={label}>
              <Textarea rows={2} maxLength={500} value={script[key] ?? ""} onChange={(event) => setScript({ ...script, [key]: event.target.value })} />
            </Field>
          ))}
        </div>
      </div>
    </Drawer>
  );
}

// ---------- 买家画像（D-33：谁 · 怎么决策 · 看重什么） ----------

interface PersonaForm {
  name: string;
  buyerRole: string;
  decisionStyle: string;
  customerType: string;
  concerns: string[];
  note: string;
  nationality: string;
  language: string;
  personality: string;
  emotion: string;
}
const EMPTY_PERSONA: PersonaForm = {
  name: "", buyerRole: "", decisionStyle: "", customerType: "", concerns: [], note: "",
  nationality: NATIONALITIES[0]!, language: SUPPORTED_LANGUAGES[0]!, personality: PERSONALITIES[0]!, emotion: EMOTIONS[0]!,
};
const PERSONA_COLUMNS = ["买家角色", "消费偏好", "客户类型", "关注点", "补充说明", "国籍", "语言", "性格", "进店情绪", "名称（选填）"] as const;

/** 卡片上的“看重”：新结构用关注点，旧结构（还没选角色和风格）退回消费偏好 */
const lookOf = (item: { concerns?: string[]; preference?: string }) => (item.concerns?.length ? item.concerns.join("、") : item.preference ?? "");

function TypeIcon({ type, size = 40 }: { type: string; size?: number }) {
  const Icon = CUSTOMER_TYPE_ICON[type] ?? Sprout;
  const cat = CUSTOMER_TYPE_CAT[type] ?? 6;
  return (
    <span className="pc-type-ico" style={{ width: size, height: size, background: `var(--c-cat-${cat}-soft)`, color: `var(--c-cat-${cat})` }}>
      <Icon size={Math.round(size / 2)} />
    </span>
  );
}

/** 画像卡片的内容（列表和新建弹窗里的预览共用） */
function PersonaCardBody({ name, nationality, language, concerns, preference, customerType, personality, emotion, ops, foot }: {
  name: string; nationality: string; language: string; concerns?: string[]; preference?: string; customerType: string; personality: string; emotion: string;
  ops?: ReactNode; foot: ReactNode;
}) {
  return (
    <>
      <div className="pc-card-top">
        <TypeIcon type={customerType} />
        <div><b title={name}>{name || "未命名"}</b><span>默认 {nationality} · {LANGUAGE_LABELS[language] ?? language}</span></div>
        {ops ? <span className="pc-card-ops" onClick={(event) => event.stopPropagation()}>{ops}</span> : null}
      </div>
      <p className="pc-card-pref" title={lookOf({ concerns, preference })}><em>看重：</em>{lookOf({ concerns, preference }) || "—"}</p>
      <div className="pc-card-tags">
        {customerType ? <span className={`ui-tag is-cat-${CUSTOMER_TYPE_CAT[customerType] ?? 6}`}>{customerType}</span> : null}
        <span className="ui-tag is-neutral">{personality}</span>
        <span className="ui-tag is-neutral">{emotion}</span>
      </div>
      <div className="pc-card-foot">{foot}</div>
    </>
  );
}

/** 可点选的选项（单选或多选） */
function OptionChips({ items, value, onChange, max, icons, tips }: {
  items: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
  icons?: Record<string, LucideIcon>;
  tips?: Record<string, string>;
}) {
  const single = max === 1;
  return (
    <div className="opt-chips">
      {items.map((item) => {
        const on = value.includes(item);
        const full = !single && !on && max !== undefined && value.length >= max;
        const Icon = icons?.[item];
        return (
          <button key={item} type="button" title={tips?.[item]} className={on ? "opt-chip is-on" : full ? "opt-chip is-full" : "opt-chip"} disabled={full}
            onClick={() => onChange(single ? [item] : on ? value.filter((v) => v !== item) : [...value, item])}>
            {Icon ? <Icon size={14} /> : null}{item}
          </button>
        );
      })}
    </div>
  );
}

const DECISION_STYLE_TIPS: Record<string, string> = Object.fromEntries(DECISION_STYLES.map((item) => [item, DECISION_STYLE_INFO[item].hint]));

function PersonaTab({ session, personas, loading, reload }: { session: Session; personas: PersonaTemplate[]; loading: boolean; reload: () => Promise<void> }) {
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState("");
  const [style, setStyle] = useState("");
  const [editing, setEditing] = useState<PersonaTemplate | "new" | null>(null);
  const [drawing, setDrawing] = useState<PersonaTemplate | null>(null);
  const [removing, setRemoving] = useState<PersonaTemplate | null>(null);
  const [importResult, setImportResult] = useState<{ created: number; failed: Array<{ row: number; reason: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return personas.filter((item) => (!type || item.customerType === type) && (!style || item.decisionStyle === style)
      && (!word || `${item.name} ${item.nationality} ${item.buyerRole ?? ""} ${lookOf(item)} ${item.note ?? ""}`.toLowerCase().includes(word)));
  }, [personas, keyword, type, style]);

  function downloadTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([
      [...PERSONA_COLUMNS],
      ["个人消费者", "价格敏感型", "潜在意向客", "价格优惠、物流时效", "习惯先在几家店比价", "美国", "英语", "直接高效", "期待", ""],
    ]);
    sheet["!cols"] = PERSONA_COLUMNS.map((_, index) => ({ wch: index === 3 || index === 4 ? 26 : 12 }));
    const notes = XLSX.utils.aoa_to_sheet([
      ["列", "可填的值"],
      ["买家角色", BUYER_ROLES.join("、")],
      ["消费偏好", DECISION_STYLES.join("、")],
      ["客户类型", CUSTOMER_TYPES.join("、")],
      ["关注点", `${PERSONA_CONCERNS.join("、")}；1–${PERSONA_CONCERN_MAX} 个，用顿号分隔`],
      ["国籍", NATIONALITIES.join("、")],
      ["语言", Object.values(LANGUAGE_LABELS).join("、")],
      ["性格", PERSONALITIES.join("、")],
      ["进店情绪", EMOTIONS.join("、")],
      ["名称", "不填就用“消费偏好 + 买家角色”"],
    ]);
    notes["!cols"] = [{ wch: 10 }, { wch: 90 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "买家画像");
    XLSX.utils.book_append_sheet(book, notes, "填写说明");
    XLSX.writeFile(book, "买家画像导入模板.xlsx");
  }

  /* 按模板批量导入：本地逐行检查，能导的交给服务端，结果逐行回显 */
  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const book = XLSX.read(await file.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[book.SheetNames[0]!]!, { defval: "" });
      const failed: Array<{ row: number; reason: string }> = [];
      const valid: Array<{ row: number; body: PersonaForm }> = [];
      rows.forEach((raw, index) => {
        const cell = (key: string) => String(raw[key] ?? "").trim();
        const row = index + 2;
        const body: PersonaForm = {
          name: cell("名称（选填）"), buyerRole: cell("买家角色"), decisionStyle: cell("消费偏好") || cell("决策风格"), customerType: cell("客户类型") || cell("客户价值层"),
          concerns: cell("关注点").split(/[、,，/]/).map((item) => item.trim()).filter(Boolean), note: cell("补充说明"),
          nationality: cell("国籍"), language: LANGUAGE_BY_LABEL[cell("语言")] ?? cell("语言"), personality: cell("性格"), emotion: cell("进店情绪"),
        };
        if (!body.buyerRole && !body.decisionStyle) return;
        const has = (list: readonly string[], value: string) => list.includes(value);
        const problem = !has(BUYER_ROLES, body.buyerRole) ? `买家角色「${body.buyerRole}」不在可选范围`
          : !has(DECISION_STYLES, body.decisionStyle) ? `消费偏好「${body.decisionStyle}」不在可选范围`
            : !has(CUSTOMER_TYPES, body.customerType) ? `客户类型「${body.customerType}」不在可选范围`
              : !body.concerns.length || body.concerns.length > PERSONA_CONCERN_MAX || body.concerns.some((item) => !has(PERSONA_CONCERNS, item)) ? `关注点要从可选项里选 1–${PERSONA_CONCERN_MAX} 个`
                : !has(NATIONALITIES, body.nationality) ? `国籍「${body.nationality}」不在可选范围`
                  : !has(SUPPORTED_LANGUAGES, body.language) ? `语言「${cell("语言")}」不在可选范围`
                    : !has(PERSONALITIES, body.personality) ? `性格「${body.personality}」不在可选范围`
                      : !has(EMOTIONS, body.emotion) ? `进店情绪「${body.emotion}」不在可选范围` : "";
        if (problem) failed.push({ row, reason: problem });
        else valid.push({ row, body });
      });
      let created = 0;
      if (valid.length) {
        const result = await apiPost<{ created: string[]; failed: Array<{ index: number; reason: string }> }>(
          "/v1/catalog/personas/import", session, { personas: valid.map((item) => item.body) },
        );
        created = result.created.length;
        for (const item of result.failed) failed.push({ row: valid[item.index]!.row, reason: item.reason });
      }
      setImportResult({ created, failed: failed.sort((a, b) => a.row - b.row) });
      await reload();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "读不了这个文件，请用模板里的格式");
    }
  }

  async function toggle(item: PersonaTemplate, enabled: boolean) {
    try {
      await updatePersona(session, item.id, { enabled });
      await reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const firstEnabled = personas.find((item) => item.enabled) ?? personas[0] ?? null;

  return (
    <Bench>
      <Toolbar
        actions={
          <>
            <Button icon={Dices} disabled={!firstEnabled} onClick={() => setDrawing(firstEnabled)}>试抽</Button>
            <MoreMenu
              trigger={<><FileUp size={14} />批量导入</>}
              triggerClassName="ui-btn ui-btn-secondary"
              items={[{ label: "下载导入模板", onClick: downloadTemplate }, { label: "选择 Excel 文件导入", onClick: () => fileRef.current?.click() }]}
            />
            <Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>新建画像</Button>
            <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
          </>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索人群或关注点" />
        <Select className="pc-style-filter" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">全部客户类型</option>
          {CUSTOMER_TYPES.map((item) => <option key={item} value={item}>{item} {personas.filter((row) => row.customerType === item).length}</option>)}
        </Select>
        <Select className="pc-style-filter" value={style} onChange={(event) => setStyle(event.target.value)}>
          <option value="">全部消费偏好</option>
          {DECISION_STYLES.map((item) => <option key={item} value={item}>{item} {personas.filter((row) => row.decisionStyle === item).length}</option>)}
        </Select>
        <HelpTip>每张卡片是一类买家：谁在买（买家角色）、怎么做决定（消费偏好）、和店铺的关系（客户类型），外加看重什么。每次接待时姓名、性别、头像随机生成；国籍、性格、情绪是默认值，任务的随机规则可以改掉</HelpTip>
      </Toolbar>
      {loading ? <Board><p className="board-quiet">正在读取…</p></Board> : visible.length === 0 ? (
        <Board><p className="board-quiet">{keyword || type || style ? "没有符合条件的画像" : "还没有画像，点「新建画像」或按模板批量导入"}</p></Board>
      ) : (
        <div className="card-grid">
          {visible.map((row) => (
            <article key={row.id} className={row.enabled ? "pc-card" : "pc-card is-off"} role="button" tabIndex={0}
              onClick={() => setEditing(row)} onKeyDown={(event) => { if (event.key === "Enter") setEditing(row); }}>
              <PersonaCardBody
                {...row}
                ops={<Switch checked={row.enabled} label={`启用 ${row.name}`} onChange={(next) => void toggle(row, next)} />}
                foot={
                  <>
                    <span>{!row.buyerRole ? <span className="pc-old">旧格式，点开补全</span> : row.conversationCount ? `被抽中 ${row.conversationCount} 次` : "还没被抽中"}</span>
                    <span onClick={(event) => event.stopPropagation()}>
                      <MoreMenu items={[{ label: "试抽", onClick: () => setDrawing(row) }, { label: "删除", danger: true, onClick: () => setRemoving(row) }]} />
                    </span>
                  </>
                }
              />
            </article>
          ))}
        </div>
      )}
      {editing ? <PersonaDialog session={session} persona={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} /> : null}
      {drawing ? <PersonaDrawDialog session={session} personas={personas} initial={drawing} onClose={() => setDrawing(null)} /> : null}
      {removing ? (
        <Confirm title="删除画像" danger confirmText="删除"
          onConfirm={() => void deletePersona(session, removing.id).then(() => { toast.ok("已删除"); setRemoving(null); return reload(); }).catch((cause) => toast.error(errorText(cause)))}
          onClose={() => setRemoving(null)}>
          删除「{removing.name}」后不会再被抽到，已经发生的接待不受影响。只是暂时不想用的话，关掉「启用」就行。
        </Confirm>
      ) : null}
      {importResult ? (
        <Dialog title="导入结果" onClose={() => setImportResult(null)} footer={<Button variant="primary" onClick={() => setImportResult(null)}>好的</Button>}>
          <p>导入 {importResult.created} 个{importResult.failed.length ? `，${importResult.failed.length} 行没导入：` : "，全部成功。"}</p>
          {importResult.failed.length ? (
            <DataTable
              rows={importResult.failed}
              rowKey={(row) => String(row.row)}
              columns={[
                { key: "row", title: "Excel 行号", width: 100, render: (row) => `第 ${row.row} 行` },
                { key: "reason", title: "原因", render: (row) => row.reason },
              ]}
            />
          ) : null}
        </Dialog>
      ) : null}
    </Bench>
  );
}

/** 试抽（单个模板）：左边列出哪些固定、哪些是默认值、哪些每次随机；右边抽 3 个示例买家，可以套某个任务的随机规则 */
function PersonaDrawDialog({ session, personas, initial, onClose }: { session: Session; personas: PersonaTemplate[]; initial: PersonaTemplate; onClose: () => void }) {
  const [templateId, setTemplateId] = useState(initial.id);
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [taskId, setTaskId] = useState("");
  const [samples, setSamples] = useState<PersonaSample[]>([]);
  const [busy, setBusy] = useState(false);
  const template = personas.find((item) => item.id === templateId) ?? initial;

  useEffect(() => {
    fetchTeacherTasks(session)
      .then((list) => setTasks(list.filter((item) => item.status !== "closed"
        && ["nationalityPool", "personalityPool", "emotionPool", "languages"].some((key) => (item.personaRule?.[key] as unknown[] | undefined)?.length))))
      .catch(() => undefined);
  }, [session]);

  const draw = useCallback(async () => {
    setBusy(true);
    try {
      const result = await samplePersona(session, templateId, taskId || undefined);
      setSamples(result.samples);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [session, templateId, taskId]);
  useEffect(() => { void draw(); }, [draw]);

  const fixed: Array<[string, string]> = [
    ["买家角色", template.buyerRole ?? template.identity], ["消费偏好", template.decisionStyle ?? "—"], ["客户类型", template.customerType], ["看重", lookOf(template)],
  ];
  const defaults: Array<[string, string]> = [
    ["国籍", template.nationality], ["语言", LANGUAGE_LABELS[template.language] ?? template.language], ["性格", template.personality], ["情绪", template.emotion],
  ];
  const changed = (sample: PersonaSample) => [
    sample.nationality !== template.nationality ? "国籍" : "", sample.personality !== template.personality ? "性格" : "", sample.emotion !== template.emotion ? "情绪" : "",
  ].filter(Boolean);

  return (
    <Dialog
      title="试抽"
      width={1000}
      onClose={onClose}
      footer={
        <>
          <span className="pd-foot-note"><EyeOff size={15} />学生开始接待前看不到抽中的是谁</span>
          <Button icon={RotateCw} loading={busy} onClick={() => void draw()}>再抽一次</Button>
          <Button variant="primary" onClick={onClose}>好的</Button>
        </>
      }
    >
      <div className="pd-grid">
        <aside className="pd-side">
          <Field label="画像模板">
            <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              {personas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
          <div className="pd-group">
            <h5><Pin size={14} />固定</h5>
            <dl className="pd-kv">{fixed.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>
          </div>
          <div className="pd-group">
            <h5><SlidersHorizontal size={14} />默认值<HelpTip>任务的“每次随机变化”限定了某一项时，以任务为准，比如只允许“不满”“焦虑”两种情绪</HelpTip></h5>
            <dl className="pd-kv">{defaults.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>
          </div>
          <div className="pd-group">
            <h5><Shuffle size={14} />每次随机</h5>
            <div className="pd-tags"><span className="ui-tag is-neutral">姓名</span><span className="ui-tag is-neutral">性别</span><span className="ui-tag is-neutral">头像</span></div>
          </div>
        </aside>
        <div className="pd-main">
          <div className="pd-rule">
            <span>按</span>
            <Select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
              <option value="">只按模板</option>
              {tasks.map((item) => <option key={item.id} value={item.id}>任务「{item.name}」的随机规则</option>)}
            </Select>
            <span>抽 3 个</span>
          </div>
          <div className="pd-samples">
            {samples.map((sample, index) => {
              const diff = changed(sample);
              return (
                <div key={`${sample.name}-${index}`} className="pd-sample">
                  <div className="pd-sample-top">
                    <img src={sample.avatarUrl} alt="" />
                    <div><b>{sample.name}</b><span>{sample.nationality} · {LANGUAGE_LABELS[sample.language] ?? sample.language}</span></div>
                  </div>
                  <div className="pc-card-tags">
                    <span className={`ui-tag is-cat-${CUSTOMER_TYPE_CAT[sample.customerType] ?? 6}`}>{sample.customerType}</span>
                    <span className="ui-tag is-neutral">{sample.personality}</span>
                    <span className="ui-tag is-neutral">{sample.emotion}</span>
                  </div>
                  {diff.length ? <p className="pd-changed">{diff.join("、")}被任务规则改掉了</p> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** 新建 / 编辑画像（D-33）：三组字段 + 右侧实时预览（卡片 + 本地试抽两个买家） */
function PersonaDialog({ session, persona, onClose, onSaved }: { session: Session; persona: PersonaTemplate | null; onClose: () => void; onSaved: () => void }) {
  const autoName = (form: PersonaForm) => personaDisplayName(form.decisionStyle, form.buyerRole);
  const [form, setForm] = useState<PersonaForm>(() => (persona ? {
    name: persona.name, buyerRole: persona.buyerRole ?? "", decisionStyle: persona.decisionStyle ?? "", customerType: persona.customerType,
    concerns: persona.concerns ?? [], note: persona.note ?? "", nationality: persona.nationality, language: persona.language,
    personality: persona.personality, emotion: persona.emotion,
  } : EMPTY_PERSONA));
  // 名称默认跟着“消费偏好 + 买家角色”走；老师手改过就不再自动覆盖
  const [nameTouched, setNameTouched] = useState(() => Boolean(persona && persona.buyerRole && persona.name !== personaDisplayName(persona.decisionStyle, persona.buyerRole)));
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [seed, setSeed] = useState(0);
  const name = nameTouched ? form.name : autoName(form);
  const patch = (next: Partial<PersonaForm>) => setForm((current) => ({ ...current, ...next }));

  const samples = useMemo(() => {
    void seed;
    const template = { id: "preview", identity: form.buyerRole, preference: "", customerType: form.customerType || CUSTOMER_TYPES[0]!, nationality: form.nationality, language: form.language, personality: form.personality, emotion: form.emotion };
    return [composePersonaWithRule([template]), composePersonaWithRule([template])];
  }, [form.buyerRole, form.customerType, form.nationality, form.language, form.personality, form.emotion, seed]);

  async function generate() {
    setGenerating(true);
    try {
      const draft = await generatePersonaDraft(session, prompt);
      setForm((current) => ({ ...current, ...draft, note: draft.note ?? "", concerns: draft.concerns ?? [] } as PersonaForm));
      setNameTouched(false);
      toast.ok("已生成，检查一下再保存");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    if (!form.buyerRole || !form.decisionStyle || !form.customerType) return toast.error("买家角色、消费偏好、客户类型都要选");
    if (!form.concerns.length) return toast.error("至少选一个关注点");
    setBusy(true);
    const body = { ...form, name: name.trim(), note: form.note.trim() };
    try {
      if (persona) await updatePersona(session, persona.id, body);
      else await createPersona(session, body as Parameters<typeof createPersona>[1]);
      toast.ok(persona ? "已保存" : "已新建");
      onSaved();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={persona ? "编辑画像" : "新建画像"}
      width={1000}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button></>}
    >
      <div className="pf">
        <div className="pf-form">
          <div className="pf-ai">
            <Sparkles size={17} />
            <input value={prompt} maxLength={300} placeholder="一句话描述想要的买家，如：很在意退换政策、第一次在独立站下单的年轻妈妈"
              onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void generate(); }} />
            <Button variant="primary" size="sm" loading={generating} onClick={() => void generate()}>AI 生成</Button>
          </div>
          <section className="pf-grp">
            <h5>这类买家是谁</h5>
            <div className="pf-row"><label>买家角色</label><OptionChips items={BUYER_ROLES} max={1} value={form.buyerRole ? [form.buyerRole] : []} onChange={([value]) => patch({ buyerRole: value ?? "" })} /></div>
            <div className="pf-row">
              <label>消费偏好<HelpTip>取自 Sproles &amp; Kendall 消费者决策风格量表的 8 种，决定对话怎么走：价格敏感型会压价，选择困难型会反复比较。鼠标停在选项上看说明</HelpTip></label>
              <OptionChips items={DECISION_STYLES} max={1} tips={DECISION_STYLE_TIPS} value={form.decisionStyle ? [form.decisionStyle] : []} onChange={([value]) => patch({ decisionStyle: value ?? "" })} />
            </div>
            <div className="pf-row"><label>客户类型</label><OptionChips items={CUSTOMER_TYPES} max={1} icons={CUSTOMER_TYPE_ICON} value={form.customerType ? [form.customerType] : []} onChange={([value]) => patch({ customerType: value ?? "" })} /></div>
          </section>
          <section className="pf-grp">
            <h5>看重什么<span>最多选 {PERSONA_CONCERN_MAX} 个，买家会围绕这些提问</span></h5>
            <OptionChips items={PERSONA_CONCERNS} max={PERSONA_CONCERN_MAX} value={form.concerns} onChange={(concerns) => patch({ concerns })} />
            <Textarea rows={2} maxLength={120} value={form.note} placeholder="补充说明（选填）：比如“习惯先在几家店比价，喜欢问有没有优惠码”" onChange={(event) => patch({ note: event.target.value })} />
          </section>
          <section className="pf-grp">
            <h5>怎么沟通<span>都是默认值，任务的随机规则可以改掉</span></h5>
            <div className="pf-sel4">
              <Field label="性格"><Select value={form.personality} onChange={(event) => patch({ personality: event.target.value })}>{PERSONALITIES.map((item) => <option key={item}>{item}</option>)}</Select></Field>
              <Field label="进店情绪"><Select value={form.emotion} onChange={(event) => patch({ emotion: event.target.value })}>{EMOTIONS.map((item) => <option key={item}>{item}</option>)}</Select></Field>
              <Field label="默认国籍"><Select value={form.nationality} onChange={(event) => patch({ nationality: event.target.value })}>{NATIONALITIES.map((item) => <option key={item}>{item}</option>)}</Select></Field>
              <Field label="语言"><Select value={form.language} onChange={(event) => patch({ language: event.target.value })}>{SUPPORTED_LANGUAGES.map((item) => <option key={item} value={item}>{LANGUAGE_LABELS[item] ?? item}</option>)}</Select></Field>
            </div>
          </section>
        </div>
        <aside className="pf-preview">
          <h6>卡片预览</h6>
          <div className="pf-name">
            名称
            {editingName ? (
              <Input autoFocus maxLength={30} value={name} onChange={(event) => { setNameTouched(true); patch({ name: event.target.value }); }} onBlur={() => setEditingName(false)} />
            ) : (
              <>
                <b>{name || "选好角色和风格后自动生成"}</b>
                <button type="button" title="改名称" onClick={() => { patch({ name }); setEditingName(true); }}><Pencil size={13} /></button>
                {nameTouched ? <button type="button" className="pf-name-reset" onClick={() => setNameTouched(false)}>恢复自动</button> : null}
              </>
            )}
          </div>
          <div className="pc-card">
            <PersonaCardBody name={name} nationality={form.nationality} language={form.language} concerns={form.concerns} customerType={form.customerType}
              personality={form.personality} emotion={form.emotion} ops={<Switch checked label="启用" onChange={() => undefined} />} foot={<span>{persona?.conversationCount ? `被抽中 ${persona.conversationCount} 次` : "还没被抽中"}</span>} />
          </div>
          <h6 className="pf-try">试抽一个<button type="button" onClick={() => setSeed(seed + 1)}><RotateCw size={12} />换一批</button></h6>
          {samples.map((sample, index) => (
            <div key={`${sample.name}-${index}`} className="pf-sample">
              <img src={sample.avatarUrl} alt="" />
              <div><b>{sample.name}</b><span>{sample.nationality} · {LANGUAGE_LABELS[sample.language] ?? sample.language} · {sample.emotion}</span></div>
            </div>
          ))}
        </aside>
      </div>
    </Dialog>
  );
}
