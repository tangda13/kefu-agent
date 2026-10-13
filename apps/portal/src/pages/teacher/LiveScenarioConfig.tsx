import { CircleAlert, CircleCheck, ClipboardList, CopyPlus, Lock, Download, FileUp, FolderUp, Package2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  BUSINESS_STAGES, BUSINESS_STAGE_LABELS, CUSTOMER_TYPES, EMOTIONS, NATIONALITIES, PERSONALITIES, SCENARIO_SCRIPT_FIELDS, SUPPORTED_LANGUAGES,
} from "@cecs/contracts";
import {
  ApiError, apiGet, apiPost, apiRequestDelete, apiRequestPatch, assetUrl, createPersona, deletePersona, fetchPersonas, fetchScenarios,
  updatePersona, uploadProductImage,
  type PersonaTemplate, type ScenarioSummary, type Session, type StoreProduct,
} from "../../api/client";
import {
  Bench, Board, Button, Confirm, DataTable, Dialog, Drawer, Field, FilterChips, Flag, HeaderTabs, HelpTip, Input, ListRow, MoreMenu, SearchBox, Select, StageTag,
  Switch, Tag, Textarea, Toolbar, toast,
} from "../../ui";

type ConfigTab = "scenarios" | "personas" | "products";

const LANGUAGE_LABELS: Record<string, string> = { "en-US": "英语", "es-ES": "西班牙语", "fr-FR": "法语" };
const LANGUAGE_BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(LANGUAGE_LABELS).map(([code, label]) => [label, code]));
const PERSONA_COLUMNS = ["姓名", "国籍", "语言", "性格", "情绪", "客户类型", "身份", "消费偏好"] as const;
const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
/** 客户类型的分类色：复购老客 1、潜在意向客 2、粉丝客 4，其他（沉睡客）6 */
const CUSTOMER_TYPE_CAT: Record<string, number> = { 复购老客: 1, 潜在意向客: 2, 粉丝客: 4 };

/** 从资料包相对路径解析商品：{任意}/N.商品名/主图/主图_01.png */
function groupPackFiles(files: FileList): Map<string, File> {
  const byProduct = new Map<string, File[]>();
  for (const file of Array.from(files)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const parts = rel.split("/");
    const mainIndex = parts.findIndex((part) => part === "主图");
    if (mainIndex < 1 || !/\.(png|jpe?g|webp)$/i.test(file.name)) continue;
    const folder = parts[mainIndex - 1]!.replace(/^\d+\./, "").trim();
    if (!folder) continue;
    byProduct.set(folder, [...(byProduct.get(folder) ?? []), file]);
  }
  const result = new Map<string, File>();
  for (const [name, list] of byProduct) result.set(name, list.sort((a, b) => a.name.localeCompare(b.name))[0]!);
  return result;
}

export function LiveScenarioConfig({ session }: { session: Session }) {
  const [tab, setTab] = useState<ConfigTab>("scenarios");
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [personas, setPersonas] = useState<PersonaTemplate[]>([]);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [scenarioList, personaList, productList] = await Promise.all([
        fetchScenarios(session), fetchPersonas(session), apiGet<StoreProduct[]>("/v1/store/products?all=1", session),
      ]);
      setScenarios(scenarioList);
      setPersonas(personaList);
      setProducts(productList);
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
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "scenarios" ? <ScenarioTab session={session} scenarios={scenarios} reload={load} /> : null}
      {tab === "personas" ? <PersonaTab session={session} personas={personas} loading={loading} reload={load} /> : null}
      {tab === "products" ? <ProductTab session={session} products={products} loading={loading} reload={load} /> : null}
    </>
  );
}

// ---------- 场景 ----------

function ScenarioTab({ session, scenarios, reload }: { session: Session; scenarios: ScenarioSummary[]; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<ScenarioSummary | null>(null);

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

  const [keyword, setKeyword] = useState("");
  const word = keyword.trim().toLowerCase();
  const matches = (item: ScenarioSummary) => !word || `${item.name} ${item.objective}`.toLowerCase().includes(word);

  return (
    <Bench>
      <div className="bench-bar">
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索场景" />
        <span className="sc-note"><Lock size={13} />学生看不到剧本<HelpTip>剧本（买家目标、隐藏信息、让步底线等）只交给 AI 买家扮演用，学生端任何地方都不显示</HelpTip></span>
      </div>
      {/* 四个业务环节四列卡片：卡片上露出剧本完整度（健康度）和被几个任务在用（影响面） */}
      <div className="sc-cols">
        {BUSINESS_STAGES.map((stage) => {
          const all = scenarios.filter((item) => item.stage === stage);
          const list = all.filter(matches);
          const enabled = all.filter((item) => item.enabled).length;
          return (
            <section key={stage} className="sc-col">
              <header className="sc-col-head"><StageTag stage={stage} /><span>{all.length} 个 · {enabled === all.length ? "全部启用" : `${enabled} 个启用`}</span></header>
              {list.map((item) => {
                const missing = SCENARIO_SCRIPT_FIELDS.filter(({ key }) => !item.script?.[key]?.trim()).length;
                const tasks = item.taskCount ?? 0;
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
                    <p>{item.objective}</p>
                    <div className="sc-card-foot">
                      {missing === 0
                        ? <span className="is-ok"><CircleCheck size={14} />剧本完整</span>
                        : <span className="is-warn"><CircleAlert size={14} />剧本缺 {missing} 项</span>}
                      <span className="sc-card-use"><ClipboardList size={14} />{tasks ? `${tasks} 个任务在用` : "没有任务在用"}</span>
                    </div>
                  </article>
                );
              })}
              {list.length === 0 && word ? <p className="sc-none">没有匹配的场景</p> : null}
              {all.length ? (
                <MoreMenu
                  trigger={<><CopyPlus size={15} />复制一个场景</>}
                  triggerClassName="sc-add"
                  items={all.map((item) => ({ label: `复制「${item.name}」`, onClick: () => void copy(item) }))}
                />
              ) : <p className="sc-none">这个环节还没有场景</p>}
            </section>
          );
        })}
      </div>
      {editing ? <ScenarioDrawer session={session} scenario={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} /> : null}
    </Bench>
  );
}

function ScenarioDrawer({ session, scenario, onClose, onSaved }: { session: Session; scenario: ScenarioSummary; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(scenario.name);
  const [objective, setObjective] = useState(scenario.objective);
  const [script, setScript] = useState<Record<string, string>>(() => Object.fromEntries(SCENARIO_SCRIPT_FIELDS.map(({ key }) => [key, scenario.script?.[key] ?? ""])));
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || !objective.trim()) return toast.error("名称和训练目标不能为空");
    setBusy(true);
    try {
      await apiRequestPatch(`/v1/catalog/scenarios/${scenario.id}`, session, { name: name.trim(), objective: objective.trim(), script });
      toast.ok("已保存，之后新开始的接待马上用新剧本");
      onSaved();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={`编辑场景 · ${BUSINESS_STAGE_LABELS[scenario.stage]}`}
      width={720}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button></>}
    >
      <div className="form-block">
        <div className="form-stack">
          <Field label="场景名称"><Input maxLength={40} value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="训练目标" hint="学生在任务里能看到这一句"><Textarea rows={2} maxLength={300} value={objective} onChange={(event) => setObjective(event.target.value)} /></Field>
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

// ---------- 买家画像 ----------

type PersonaForm = Omit<PersonaTemplate, "id" | "enabled" | "avatarUrl" | "conversationCount">;
const EMPTY_PERSONA: PersonaForm = {
  name: "", nationality: NATIONALITIES[0]!, identity: "", personality: PERSONALITIES[0]!, emotion: EMOTIONS[0]!,
  language: SUPPORTED_LANGUAGES[0]!, preference: "", customerType: CUSTOMER_TYPES[0]!,
};

function PersonaTab({ session, personas, loading, reload }: { session: Session; personas: PersonaTemplate[]; loading: boolean; reload: () => Promise<void> }) {
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState("");
  const [editing, setEditing] = useState<PersonaTemplate | "new" | null>(null);
  const [removing, setRemoving] = useState<PersonaTemplate | null>(null);
  const [importResult, setImportResult] = useState<{ created: number; failed: Array<{ row: number; reason: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return personas.filter((item) => (!type || item.customerType === type) && (!word || `${item.name} ${item.nationality} ${item.identity}`.toLowerCase().includes(word)));
  }, [personas, keyword, type]);

  function downloadTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([
      [...PERSONA_COLUMNS],
      ["Emily Carter", "美国", "英语", "理性谨慎", "平静", "潜在意向客", "三十岁的健身教练，注重产品耐用性", "偏好高性价比，关注物流时效，习惯先比价再下单"],
    ]);
    sheet["!cols"] = PERSONA_COLUMNS.map((_, index) => ({ wch: index >= 6 ? 36 : 12 }));
    const notes = XLSX.utils.aoa_to_sheet([
      ["列", "可填的值"],
      ["国籍", NATIONALITIES.join("、")],
      ["语言", Object.values(LANGUAGE_LABELS).join("、")],
      ["性格", PERSONALITIES.join("、")],
      ["情绪", EMOTIONS.join("、")],
      ["客户类型", CUSTOMER_TYPES.join("、")],
    ]);
    notes["!cols"] = [{ wch: 10 }, { wch: 80 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "买家画像");
    XLSX.utils.book_append_sheet(book, notes, "填写说明");
    XLSX.writeFile(book, "买家画像导入模板.xlsx");
  }

  /* D4：按模板批量导入，先在本地逐行检查，能导的交给服务端，结果逐行回显 */
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
          name: cell("姓名"), nationality: cell("国籍"), language: LANGUAGE_BY_LABEL[cell("语言")] ?? cell("语言"), personality: cell("性格"),
          emotion: cell("情绪"), customerType: cell("客户类型"), identity: cell("身份"), preference: cell("消费偏好"),
        };
        if (!body.name && !body.identity) return;
        const problem = !body.name ? "姓名没填"
          : !(NATIONALITIES as readonly string[]).includes(body.nationality) ? `国籍「${body.nationality}」不在可选范围`
            : !(SUPPORTED_LANGUAGES as readonly string[]).includes(body.language) ? `语言「${cell("语言")}」不在可选范围`
              : !(PERSONALITIES as readonly string[]).includes(body.personality) ? `性格「${body.personality}」不在可选范围`
                : !(EMOTIONS as readonly string[]).includes(body.emotion) ? `情绪「${body.emotion}」不在可选范围`
                  : !(CUSTOMER_TYPES as readonly string[]).includes(body.customerType) ? `客户类型「${body.customerType}」不在可选范围`
                    : !body.identity || !body.preference ? "身份和消费偏好都要填" : "";
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

  return (
    <Bench>
      <Toolbar
        actions={
          <>
            <Button variant="ghost" icon={Download} onClick={downloadTemplate}>下载模板</Button>
            <Button icon={FileUp} onClick={() => fileRef.current?.click()}>批量导入</Button>
            <Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>新建画像</Button>
            <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
          </>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索姓名、国籍或身份" />
        <FilterChips
          items={[{ id: "", label: "全部", count: personas.length }, ...CUSTOMER_TYPES.map((item) => ({ id: item, label: item, count: personas.filter((row) => row.customerType === item).length }))]}
          value={type}
          onChange={setType}
        />
      </Toolbar>
      {loading ? <Board><p className="board-quiet">正在读取…</p></Board> : visible.length === 0 ? (
        <Board><p className="board-quiet">{keyword || type ? "没有符合条件的画像" : "还没有画像，点「新建画像」或按模板批量导入"}</p></Board>
      ) : (
        <div className="card-grid">
          {visible.map((row) => (
            <article key={row.id} className={row.enabled ? "pc-card" : "pc-card is-off"} role="button" tabIndex={0}
              onClick={() => setEditing(row)} onKeyDown={(event) => { if (event.key === "Enter") setEditing(row); }}>
              <div className="pc-card-top">
                {/* 头像在前端 public/avatars 下，和工作台里的买家头像同一套，直接用相对路径 */}
                {row.avatarUrl ? <img src={row.avatarUrl} alt="" /> : <span className="pc-card-ph">{row.name.slice(0, 1)}</span>}
                <div><b title={row.name}>{row.name}</b><span>{row.identity}</span></div>
                <span className="pc-card-ops" onClick={(event) => event.stopPropagation()}>
                  <MoreMenu items={[{ label: "删除", danger: true, onClick: () => setRemoving(row) }]} />
                </span>
              </div>
              <div className="pc-card-tags">
                <span className={`ui-tag is-cat-${CUSTOMER_TYPE_CAT[row.customerType] ?? 6}`}>{row.customerType}</span>
                <span className="ui-tag is-neutral">{row.personality}</span>
                <span className="ui-tag is-neutral">{row.emotion}</span>
              </div>
              <div className="pc-card-foot">
                <span>{row.nationality} · {LANGUAGE_LABELS[row.language] ?? row.language} · {row.conversationCount ? `接待 ${row.conversationCount} 次` : "还没接待过"}</span>
                <span onClick={(event) => event.stopPropagation()}>
                  <Switch checked={row.enabled} label={`启用 ${row.name}`} onChange={(next) => void toggle(row, next)} />
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing ? <PersonaDialog session={session} persona={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} /> : null}
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

function PersonaDialog({ session, persona, onClose, onSaved }: { session: Session; persona: PersonaTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<PersonaForm>(() => {
    if (!persona) return EMPTY_PERSONA;
    const { id: _id, enabled: _enabled, avatarUrl: _avatar, conversationCount: _count, ...rest } = persona;
    return rest;
  });
  const [busy, setBusy] = useState(false);
  const set = (key: keyof PersonaForm) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  async function save() {
    if (!form.name.trim() || !form.identity.trim() || !form.preference.trim()) return toast.error("姓名、身份和消费偏好都要填");
    setBusy(true);
    const body = { ...form, name: form.name.trim(), identity: form.identity.trim(), preference: form.preference.trim() };
    try {
      if (persona) await updatePersona(session, persona.id, body);
      else await createPersona(session, body);
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
      width={640}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>保存</Button></>}
    >
      <div className="form-stack">
        <div className="form-grid-3">
          <Field label="姓名"><Input autoFocus value={form.name} placeholder="Emily Carter" onChange={set("name")} /></Field>
          <Field label="国籍"><Select value={form.nationality} onChange={set("nationality")}>{NATIONALITIES.map((item) => <option key={item}>{item}</option>)}</Select></Field>
          <Field label="语言"><Select value={form.language} onChange={set("language")}>{SUPPORTED_LANGUAGES.map((item) => <option key={item} value={item}>{LANGUAGE_LABELS[item] ?? item}</option>)}</Select></Field>
          <Field label="性格"><Select value={form.personality} onChange={set("personality")}>{PERSONALITIES.map((item) => <option key={item}>{item}</option>)}</Select></Field>
          <Field label="一开始的情绪"><Select value={form.emotion} onChange={set("emotion")}>{EMOTIONS.map((item) => <option key={item}>{item}</option>)}</Select></Field>
          <Field label="客户类型"><Select value={form.customerType} onChange={set("customerType")}>{CUSTOMER_TYPES.map((item) => <option key={item}>{item}</option>)}</Select></Field>
        </div>
        <Field label="身份"><Input value={form.identity} placeholder="三十岁的健身教练，注重产品耐用性" onChange={set("identity")} /></Field>
        <Field label="消费偏好"><Textarea rows={3} value={form.preference} placeholder="偏好高性价比，关注物流时效，习惯先比价再下单" onChange={set("preference")} /></Field>
      </div>
    </Dialog>
  );
}

// ---------- 店铺商品 ----------

function ProductTab({ session, products, loading, reload }: { session: Session; products: StoreProduct[]; loading: boolean; reload: () => Promise<void> }) {
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<StoreProduct | "new" | null>(null);
  const [removing, setRemoving] = useState<StoreProduct | null>(null);
  const [importing, setImporting] = useState(false);
  const packRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<"all" | "noimage" | "off">("all");
  const visible = products.filter((item) => !keyword.trim() || `${item.name} ${item.spec}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  const shown = visible.filter((item) => filter === "all" || (filter === "noimage" ? !item.imageUrl : item.enabled === false));

  async function toggle(item: StoreProduct, enabled: boolean) {
    try {
      await apiRequestPatch(`/v1/store/products/${item.id}`, session, { enabled });
      toast.ok(enabled ? "已上架" : "已下架，学生端不再显示");
      await reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function importPack(files: FileList | null) {
    if (!files?.length) return;
    const grouped = groupPackFiles(files);
    if (grouped.size === 0) return toast.error("没找到商品。资料包里每个商品要有一个文件夹，里面放「主图」文件夹");
    setImporting(true);
    let created = 0;
    let skipped = 0;
    const existing = new Set(products.map((item) => item.name));
    for (const [name, file] of grouped) {
      if (existing.has(name)) { skipped += 1; continue; }
      try {
        const product = await apiPost<{ id: string }>("/v1/store/products", session, { name, spec: "均码 / 常规款（待完善）", price: 9.9, stock: 100 });
        await uploadProductImage(session, product.id, file);
        created += 1;
      } catch {
        skipped += 1;
      }
    }
    setImporting(false);
    toast.ok(`导入 ${created} 个商品${skipped ? `，跳过 ${skipped} 个（重名或失败）` : ""}。价格默认 9.9，记得改`);
    await reload();
  }

  return (
    <Bench>
      <Toolbar
        actions={
          <>
            <Button icon={FolderUp} loading={importing} onClick={() => packRef.current?.click()}>导入资料包</Button>
            <Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>添加商品</Button>
            {/* @ts-expect-error 非标准属性：整目录选择 */}
            <input ref={packRef} type="file" hidden webkitdirectory="" multiple onChange={(event) => { void importPack(event.target.files); event.target.value = ""; }} />
          </>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索商品" />
        <FilterChips
          items={[
            { id: "all", label: "全部", count: products.length },
            { id: "noimage", label: "缺图片", count: products.filter((item) => !item.imageUrl).length },
            { id: "off", label: "已下架", count: products.filter((item) => item.enabled === false).length },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </Toolbar>
      {loading ? <Board><p className="board-quiet">正在读取…</p></Board> : shown.length === 0 ? (
        <Board><p className="board-quiet">{keyword || filter !== "all" ? "没有匹配的商品" : "店铺还没有商品，点「添加商品」或导入资料包"}</p></Board>
      ) : (
        <div className="card-grid">
          {shown.map((row) => (
            <article key={row.id} className={row.enabled === false ? "gd-card is-off" : "gd-card"} role="button" tabIndex={0}
              onClick={() => setEditing(row)} onKeyDown={(event) => { if (event.key === "Enter") setEditing(row); }}>
              <div className="gd-card-img" style={row.imageUrl ? undefined : { background: `color-mix(in srgb, ${row.tone} 14%, #fff)`, color: row.tone }}>
                {row.imageUrl ? <img src={assetUrl(row.imageUrl) ?? undefined} alt="" /> : <Package2 size={40} strokeWidth={1.3} />}
                {row.enabled === false ? <span className="ui-tag is-neutral gd-card-state">已下架</span> : null}
                {!row.imageUrl ? <span className="ui-tag is-warn gd-card-flag">缺图片</span> : null}
                <span className="gd-card-ops" onClick={(event) => event.stopPropagation()}>
                  <Switch checked={row.enabled !== false} label={`上架 ${row.name}`} onChange={(next) => void toggle(row, next)} />
                  <MoreMenu items={[{ label: "删除", danger: true, onClick: () => setRemoving(row) }]} />
                </span>
              </div>
              <div className="gd-card-body">
                <b title={row.name}>{row.name}</b>
                <span className="gd-card-spec">{row.spec}</span>
                <div className="gd-card-row">
                  <span className="gd-card-price">${Number(row.price).toFixed(2)}</span>
                  <span className={row.stock < 100 ? "gd-card-stock is-low" : "gd-card-stock"}>已售 {row.sales} · 库存 {row.stock}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing ? <ProductDialog session={session} product={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} /> : null}
      {removing ? (
        <Confirm title="删除商品" danger confirmText="删除"
          onConfirm={() => void apiRequestDelete(`/v1/store/products/${removing.id}`, session).then(() => { toast.ok("已删除"); setRemoving(null); return reload(); }).catch((cause) => toast.error(errorText(cause)))}
          onClose={() => setRemoving(null)}>
          删除「{removing.name}」？已经生成的订单不受影响。只是暂时不卖的话，关掉「上架」就行。
        </Confirm>
      ) : null}
    </Bench>
  );
}

function ProductDialog({ session, product, onClose, onSaved }: { session: Session; product: StoreProduct | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: product?.name ?? "", spec: product?.spec ?? "", price: product ? String(product.price) : "", stock: product ? String(product.stock) : "100" });
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const current = preview ?? (product?.imageUrl ? assetUrl(product.imageUrl) : null);

  async function save() {
    const price = Number(form.price);
    const stock = Number(form.stock);
    if (!form.name.trim() || !form.spec.trim()) return toast.error("名称和规格要填");
    if (!Number.isFinite(price) || price <= 0) return toast.error("价格要大于 0");
    if (!Number.isInteger(stock) || stock < 0) return toast.error("库存填 0 或正整数");
    setBusy(true);
    try {
      const body = { name: form.name.trim(), spec: form.spec.trim(), price, stock };
      const id = product ? product.id : (await apiPost<{ id: string }>("/v1/store/products", session, body)).id;
      if (product) await apiRequestPatch(`/v1/store/products/${product.id}`, session, body);
      if (image) await uploadProductImage(session, id, image);
      toast.ok(product ? "已保存" : "已上架");
      onSaved();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={product ? "编辑商品" : "添加商品"}
      width={640}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{product ? "保存" : "上架"}</Button></>}
    >
      <div className="product-form">
        <label className="product-image-pick">
          {current ? <img src={current} alt="" /> : <span><Package2 size={22} />主图</span>}
          <input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(event) => setImage(event.target.files?.[0] ?? null)} />
          <em>{current ? "点击更换" : "点击上传"}</em>
        </label>
        <div className="form-stack">
          <Field label="商品名称"><Input autoFocus value={form.name} placeholder="Bluetooth Speaker" onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="规格"><Input value={form.spec} placeholder="Black / IPX7" onChange={(event) => setForm({ ...form, spec: event.target.value })} /></Field>
          <div className="form-grid-2">
            <Field label="价格（美元）"><Input type="number" min={0} step={0.1} value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></Field>
            <Field label="库存"><Input type="number" min={0} value={form.stock} onChange={(event) => setForm({ ...form, stock: event.target.value })} /></Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
