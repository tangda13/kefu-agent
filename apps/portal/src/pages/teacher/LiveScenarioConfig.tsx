import { FolderUp, Package2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUSINESS_STAGE_LABELS,
  CUSTOMER_TYPES,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  SCENARIO_SCRIPT_FIELDS,
  SUPPORTED_LANGUAGES,
} from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  apiGet,
  apiPost,
  apiRequestDelete,
  apiRequestPatch,
  assetUrl,
  createPersona,
  deletePersona,
  fetchPersonas,
  fetchScenarios,
  updatePersona,
  uploadProductImage,
  type PersonaTemplate,
  type ScenarioSummary,
  type Session,
  type StoreProduct,
} from "../../api/client";
import { TeacherDialog } from "./widgets";

const LANGUAGE_LABELS: Record<string, string> = {
  "en-US": "英语",
  "es-ES": "西班牙语",
  "fr-FR": "法语",
};

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

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
    const list = byProduct.get(folder) ?? [];
    list.push(file);
    byProduct.set(folder, list);
  }
  const result = new Map<string, File>();
  for (const [name, list] of byProduct) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    result.set(name, list[0]!);
  }
  return result;
}

interface PersonaForm {
  name: string;
  nationality: string;
  identity: string;
  personality: string;
  emotion: string;
  language: string;
  preference: string;
  customerType: string;
}

const EMPTY_PERSONA: PersonaForm = {
  name: "",
  nationality: NATIONALITIES[0]!,
  identity: "",
  personality: PERSONALITIES[0]!,
  emotion: EMOTIONS[0]!,
  language: SUPPORTED_LANGUAGES[0]!,
  preference: "",
  customerType: CUSTOMER_TYPES[0]!,
};

export function LiveScenarioConfig({ session }: { session: Session }) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [personas, setPersonas] = useState<PersonaTemplate[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"products" | "scenarios" | "personas">("products");
  const [scriptEditing, setScriptEditing] = useState<ScenarioSummary | null>(null);
  const [scriptForm, setScriptForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const packInputRef = useRef<HTMLInputElement>(null);

  const [productCreating, setProductCreating] = useState(false);
  const [form, setForm] = useState({ name: "", spec: "", price: "", stock: "" });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const imagePreview = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : null), [imageFile]);
  useEffect(() => () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

  const [productEditing, setProductEditing] = useState<StoreProduct | null>(null);
  const [productForm, setProductForm] = useState({ name: "", spec: "", price: "", stock: "" });

  const [personaEditing, setPersonaEditing] = useState<{ mode: "create" } | { mode: "edit"; id: string } | null>(null);
  const [personaForm, setPersonaForm] = useState<PersonaForm>(EMPTY_PERSONA);

  const load = useCallback(async () => {
    try {
      const [scenarioList, productList, personaList] = await Promise.all([
        fetchScenarios(session),
        apiGet<StoreProduct[]>("/v1/store/products?all=1", session),
        fetchPersonas(session),
      ]);
      setScenarios(scenarioList);
      setProducts(productList);
      setPersonas(personaList);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  async function toggleScenario(item: ScenarioSummary) {
    try {
      await apiRequestPatch(`/v1/catalog/scenarios/${item.id}`, session, { enabled: !item.enabled });
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  function openScript(item: ScenarioSummary) {
    setDialogError("");
    setScriptForm(Object.fromEntries(SCENARIO_SCRIPT_FIELDS.map(({ key }) => [key, item.script?.[key] ?? ""])));
    setScriptEditing(item);
  }

  async function saveScript() {
    if (!scriptEditing) return;
    setBusy(true);
    setDialogError("");
    try {
      await apiRequestPatch(`/v1/catalog/scenarios/${scriptEditing.id}`, session, { script: scriptForm });
      setNotice(`「${scriptEditing.name}」的剧本已保存，新开始的会话立即使用。`);
      setScriptEditing(null);
      await load();
    } catch (cause) {
      setDialogError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleProduct(item: StoreProduct) {
    try {
      await apiRequestPatch(`/v1/store/products/${item.id}`, session, { enabled: item.enabled === false });
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  async function removeProduct(item: StoreProduct) {
    if (!window.confirm(`确定删除商品「${item.name}」吗？`)) return;
    try {
      await apiRequestDelete(`/v1/store/products/${item.id}`, session);
      setNotice(`商品「${item.name}」已删除`);
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  function openProductCreate() {
    setForm({ name: "", spec: "", price: "", stock: "" });
    setImageFile(null);
    setDialogError("");
    setProductCreating(true);
  }

  function openProductEdit(item: StoreProduct) {
    setProductEditing(item);
    setProductForm({ name: item.name, spec: item.spec, price: String(item.price), stock: String(item.stock) });
    setDialogError("");
  }

  async function saveProductEdit() {
    if (!productEditing || busy) return;
    const price = Number(productForm.price);
    const stock = Number(productForm.stock);
    if (!productForm.name.trim() || !productForm.spec.trim() || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0) {
      setDialogError("请填写有效的商品名称、规格、正数价格与非负整数库存。");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      await apiRequestPatch(`/v1/store/products/${productEditing.id}`, session, {
        name: productForm.name.trim(),
        spec: productForm.spec.trim(),
        price,
        stock,
      });
      setNotice(`商品「${productForm.name.trim()}」已更新`);
      setProductEditing(null);
      await load();
    } catch (cause) { setDialogError(errorText(cause)); } finally { setBusy(false); }
  }

  async function addProduct() {
    if (busy) return;
    const price = Number(form.price);
    if (!form.name.trim() || !form.spec.trim() || !Number.isFinite(price) || price <= 0) {
      setDialogError("请填写商品名称、规格与正数价格。");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      const created = await apiPost<{ id: string }>("/v1/store/products", session, {
        name: form.name.trim(), spec: form.spec.trim(), price, stock: Number(form.stock) || 0,
      });
      if (imageFile) await uploadProductImage(session, created.id, imageFile);
      setProductCreating(false);
      setNotice(`商品「${form.name.trim()}」已上架，学生端即时生效`);
      await load();
    } catch (cause) { setDialogError(errorText(cause)); } finally { setBusy(false); }
  }

  async function importPack(files: FileList | null) {
    if (!files || files.length === 0 || busy) return;
    const grouped = groupPackFiles(files);
    if (grouped.size === 0) {
      setError("未识别到商品：请选择包含「商品文件夹/主图/图片」结构的资料包目录。");
      return;
    }
    setBusy(true);
    setError("");
    let created = 0;
    let failed = 0;
    const existing = new Set(products.map((item) => item.name));
    for (const [name, file] of grouped) {
      if (existing.has(name)) { failed += 1; continue; }
      try {
        const product = await apiPost<{ id: string }>("/v1/store/products", session, {
          name, spec: "均码 / 常规款（待完善）", price: 9.9, stock: 100,
        });
        await uploadProductImage(session, product.id, file);
        created += 1;
      } catch {
        failed += 1;
      }
    }
    setNotice(`批量导入完成：新增 ${created} 个商品${failed ? `，跳过/失败 ${failed} 个（可能重名）` : ""}。价格默认 9.9，可点「编辑」修改。`);
    setBusy(false);
    await load();
  }

  /* ---------- 买家画像 ---------- */

  function openPersonaCreate() {
    setPersonaForm(EMPTY_PERSONA);
    setDialogError("");
    setPersonaEditing({ mode: "create" });
  }

  function openPersonaEdit(item: PersonaTemplate) {
    setPersonaForm({
      name: item.name,
      nationality: item.nationality,
      identity: item.identity,
      personality: item.personality,
      emotion: item.emotion,
      language: item.language,
      preference: item.preference,
      customerType: item.customerType,
    });
    setDialogError("");
    setPersonaEditing({ mode: "edit", id: item.id });
  }

  async function savePersona() {
    if (!personaEditing || busy) return;
    if (!personaForm.name.trim() || !personaForm.identity.trim() || !personaForm.preference.trim()) {
      setDialogError("请填写买家姓名、身份与消费偏好。");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      if (personaEditing.mode === "create") {
        await createPersona(session, { ...personaForm, name: personaForm.name.trim(), identity: personaForm.identity.trim(), preference: personaForm.preference.trim() });
        setNotice(`画像「${personaForm.name.trim()}」已创建`);
      } else {
        await updatePersona(session, personaEditing.id, { ...personaForm, name: personaForm.name.trim(), identity: personaForm.identity.trim(), preference: personaForm.preference.trim() });
        setNotice(`画像「${personaForm.name.trim()}」已更新`);
      }
      setPersonaEditing(null);
      await load();
    } catch (cause) { setDialogError(errorText(cause)); } finally { setBusy(false); }
  }

  async function togglePersona(item: PersonaTemplate) {
    try {
      await updatePersona(session, item.id, { enabled: !item.enabled });
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  async function removePersona(item: PersonaTemplate) {
    if (!window.confirm(`确定删除画像「${item.name}」吗？已生成的会话快照不受影响。`)) return;
    try {
      await deletePersona(session, item.id);
      setNotice(`画像「${item.name}」已删除`);
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  const enabledPersonas = personas.filter((item) => item.enabled).length;
  const enabledProducts = products.filter((item) => item.enabled !== false).length;
  const enabledScenarios = scenarios.filter((item) => item.enabled).length;

  return (
    <div className="page">
      <PageHeader
        title="场景配置"
        description="维护实训场景、店铺商品库与买家画像模板；三者共同驱动学生端的商品页签、订单生成与买家对话。"
        actions={
          tab === "products" ? (
            <>
              <button className="secondary-button" disabled={busy} onClick={() => packInputRef.current?.click()}>
                <FolderUp size={16} /> 批量导入资料包
              </button>
              <button className="primary-button" onClick={openProductCreate}>
                <Plus size={16} /> 添加商品
              </button>
            </>
          ) : tab === "personas" ? (
            <button className="primary-button" onClick={openPersonaCreate}>
              <Plus size={16} /> 新建画像
            </button>
          ) : undefined
        }
      />
      <div className="segmented-tabs page-tabs">
        <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>商品库<span>{products.length}</span></button>
        <button className={tab === "scenarios" ? "active" : ""} onClick={() => setTab("scenarios")}>场景库<span>{scenarios.length}</span></button>
        <button className={tab === "personas" ? "active" : ""} onClick={() => setTab("personas")}>买家画像<span>{personas.length}</span></button>
      </div>
      <input
        ref={packInputRef}
        type="file"
        style={{ display: "none" }}
        // @ts-expect-error 非标准属性：整目录选择
        webkitdirectory=""
        multiple
        onChange={(event) => { void importPack(event.target.files); event.target.value = ""; }}
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {tab === "products" ? (
      <section className="panel data-panel">
        <div className="panel-heading">
          <div>
            <h2>商品库</h2>
            <p>{products.length} 个商品 · {enabledProducts} 个在售 · 上架商品即时同步学生端</p>
          </div>
        </div>
        {products.length === 0 ? (
          <div className="tt-empty">
            <Package2 size={26} aria-hidden="true" />
            <strong>商品库还是空的</strong>
            <p>点击右上角「添加商品」逐个录入，或用「批量导入资料包」一次导入整套商品与主图。</p>
          </div>
        ) : (
          <table>
            <thead><tr><th>主图</th><th>商品</th><th>价格</th><th>销量 / 库存</th><th>在售</th><th>操作</th></tr></thead>
            <tbody>
              {products.map((item) => (
                <tr key={item.id} className={item.enabled === false ? "tch-row-muted" : undefined}>
                  <td>
                    {item.imageUrl ? (
                      <img className="product-photo" src={assetUrl(item.imageUrl) ?? undefined} alt={item.name} />
                    ) : (
                      <span className="product-thumb" style={{ background: item.tone }}><Package2 size={18} /></span>
                    )}
                  </td>
                  <td><strong>{item.name}</strong><small>{item.spec}</small></td>
                  <td>USD {item.price}</td>
                  <td>{item.sales} / {item.stock}</td>
                  <td>
                    <span className="tt-switch-cell">
                      <button
                        className={item.enabled !== false ? "toggle on" : "toggle"}
                        role="switch"
                        aria-checked={item.enabled !== false}
                        aria-label={item.enabled !== false ? `下架 ${item.name}` : `上架 ${item.name}`}
                        onClick={() => void toggleProduct(item)}
                      />
                      <small>{item.enabled !== false ? "在售" : "已下架"}</small>
                    </span>
                  </td>
                  <td className="tch-actions">
                    <button className="text-button" onClick={() => openProductEdit(item)}>编辑</button>
                    <button className="text-button tch-danger" onClick={() => void removeProduct(item)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      ) : tab === "scenarios" ? (
      <section className="panel data-panel">
        <div className="panel-heading">
          <div>
            <h2>场景库</h2>
            <p>{scenarios.length} 个场景 · {enabledScenarios} 个启用中 · 停用后不可再被新任务选择，已下发任务不受影响</p>
          </div>
        </div>
        <table>
          <thead><tr><th>编号</th><th>场景</th><th>业务环节</th><th>剧本</th><th>启用</th></tr></thead>
          <tbody>
            {scenarios.map((item) => (
              <tr key={item.id} className={item.enabled ? undefined : "tch-row-muted"}>
                <td>{item.id}</td>
                <td className="tt-obj-cell"><strong>{item.name}</strong><small>{item.objective}</small></td>
                <td><span className="status-pill">{BUSINESS_STAGE_LABELS[item.stage]}</span></td>
                <td>
                  <button className="text-button" onClick={() => openScript(item)}>
                    {item.script?.buyerGoal ? "查看 / 修改" : "未设置，去填写"}
                  </button>
                </td>
                <td>
                  <span className="tt-switch-cell">
                    <button
                      className={item.enabled ? "toggle on" : "toggle"}
                      role="switch"
                      aria-checked={item.enabled}
                      aria-label={item.enabled ? `停用场景 ${item.name}` : `启用场景 ${item.name}`}
                      onClick={() => void toggleScenario(item)}
                    />
                    <small>{item.enabled ? "已启用" : "已停用"}</small>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      ) : (
      <section className="panel data-panel">
        <div className="panel-heading">
          <div>
            <h2>买家画像模板</h2>
            <p>{personas.length} 个模板 · {enabledPersonas} 个启用中 · 会话开始时按任务规则从启用模板随机组合，学生不可见</p>
          </div>
        </div>
        {personas.length === 0 ? (
          <div className="tt-empty">
            <Package2 size={26} aria-hidden="true" />
            <strong>暂无画像模板</strong>
            <p>点击右上角「新建画像」创建第一个买家画像模板。</p>
          </div>
        ) : (
          <table>
            <thead><tr><th>编号</th><th>买家</th><th>国籍 / 语言</th><th>性格 / 情绪</th><th>客户类型</th><th>启用</th><th>操作</th></tr></thead>
            <tbody>
              {personas.map((item) => (
                <tr key={item.id} className={item.enabled ? undefined : "tch-row-muted"}>
                  <td>{item.id}</td>
                  <td><strong>{item.name}</strong><small>{item.identity}</small></td>
                  <td>{item.nationality} · {LANGUAGE_LABELS[item.language] ?? item.language}</td>
                  <td>{item.personality} · {item.emotion}</td>
                  <td><span className="status-pill">{item.customerType}</span></td>
                  <td>
                    <span className="tt-switch-cell">
                      <button
                        className={item.enabled ? "toggle on" : "toggle"}
                        role="switch"
                        aria-checked={item.enabled}
                        aria-label={item.enabled ? `停用画像 ${item.name}` : `启用画像 ${item.name}`}
                        onClick={() => void togglePersona(item)}
                      />
                      <small>{item.enabled ? "已启用" : "已停用"}</small>
                    </span>
                  </td>
                  <td className="tch-actions">
                    <button className="text-button" onClick={() => openPersonaEdit(item)}>编辑</button>
                    <button className="text-button tch-danger" onClick={() => void removePersona(item)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      )}

      {scriptEditing ? (
        <TeacherDialog
          title={`场景剧本 · ${scriptEditing.name}`}
          subtitle="剧本决定 AI 买家想要什么、隐瞒了什么、什么会让买家更不满、最多接受到哪一步、什么时候离开。学生看不到剧本。"
          size="wide"
          onClose={() => setScriptEditing(null)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setScriptEditing(null)}>取消</button>
              <button className="primary-button" onClick={() => void saveScript()} disabled={busy}>{busy ? "保存中…" : "保存剧本"}</button>
            </>
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          {SCENARIO_SCRIPT_FIELDS.map(({ key, label }) => (
            <label key={key}>{label}
              <textarea rows={2} maxLength={500} value={scriptForm[key] ?? ""} onChange={(event) => setScriptForm({ ...scriptForm, [key]: event.target.value })} />
            </label>
          ))}
        </TeacherDialog>
      ) : null}
      {productCreating ? (
        <TeacherDialog
          title="添加商品"
          subtitle="保存后立即上架，学生端工作台与商品页签即时生效"
          size="wide"
          onClose={() => setProductCreating(false)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setProductCreating(false)}>取消</button>
              <button className="primary-button" onClick={() => void addProduct()} disabled={busy}>
                {busy ? "保存中…" : "保存并上架"}
              </button>
            </>
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          <div className="tt-grid-2">
            <label>商品名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 Bluetooth Speaker" autoFocus /></label>
            <label>规格<input value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })} placeholder="如 Black / IPX7" /></label>
          </div>
          <div className="tt-grid-2">
            <label>价格（USD）<input type="number" min="0" step="0.1" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
            <label>库存<input type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></label>
          </div>
          <label>
            商品主图（可选）
            <span className="tt-upload">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
              />
              <span className="secondary-button compact" role="button">选择图片</span>
              {imagePreview ? <img className="tt-img-preview" src={imagePreview} alt="主图预览" /> : null}
              <em>{imageFile ? imageFile.name : "未选择，将使用占位底色"}</em>
            </span>
          </label>
        </TeacherDialog>
      ) : null}

      {productEditing ? (
        <TeacherDialog
          title={`编辑商品 · ${productEditing.name}`}
          onClose={() => setProductEditing(null)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setProductEditing(null)}>取消</button>
              <button className="primary-button" onClick={() => void saveProductEdit()} disabled={busy}>{busy ? "保存中…" : "保存"}</button>
            </>
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          <label>名称<input value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} /></label>
          <label>规格<input value={productForm.spec} onChange={(e) => setProductForm({ ...productForm, spec: e.target.value })} /></label>
          <div className="tch-dialog-grid">
            <label>价格（USD）<input type="number" min="0" step="0.1" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} /></label>
            <label>库存<input type="number" min="0" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} /></label>
          </div>
        </TeacherDialog>
      ) : null}

      {personaEditing ? (
        <TeacherDialog
          title={personaEditing.mode === "create" ? "新建买家画像" : "编辑买家画像"}
          subtitle="画像与任务规则、国籍姓名池共同决定每次会话的买家人设，学生不可见"
          size="xl"
          onClose={() => setPersonaEditing(null)}
          footer={
            <>
              <button className="secondary-button" onClick={() => setPersonaEditing(null)}>取消</button>
              <button className="primary-button" onClick={() => void savePersona()} disabled={busy}>
                {busy ? "保存中…" : personaEditing.mode === "create" ? "创建画像" : "保存"}
              </button>
            </>
          }
        >
          {dialogError ? <p className="form-error" role="alert">{dialogError}</p> : null}
          <div className="tt-grid-3">
            <label>买家姓名<input value={personaForm.name} onChange={(e) => setPersonaForm({ ...personaForm, name: e.target.value })} placeholder="如 Emily Carter" autoFocus /></label>
            <label>国籍
              <select value={personaForm.nationality} onChange={(e) => setPersonaForm({ ...personaForm, nationality: e.target.value })}>
                {NATIONALITIES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>语言
              <select value={personaForm.language} onChange={(e) => setPersonaForm({ ...personaForm, language: e.target.value })}>
                {SUPPORTED_LANGUAGES.map((item) => <option key={item} value={item}>{LANGUAGE_LABELS[item] ?? item}</option>)}
              </select>
            </label>
            <label>性格
              <select value={personaForm.personality} onChange={(e) => setPersonaForm({ ...personaForm, personality: e.target.value })}>
                {PERSONALITIES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>初始情绪
              <select value={personaForm.emotion} onChange={(e) => setPersonaForm({ ...personaForm, emotion: e.target.value })}>
                {EMOTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>客户类型
              <select value={personaForm.customerType} onChange={(e) => setPersonaForm({ ...personaForm, customerType: e.target.value })}>
                {CUSTOMER_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <label>买家身份<input value={personaForm.identity} onChange={(e) => setPersonaForm({ ...personaForm, identity: e.target.value })} placeholder="如 三十岁的健身教练，注重产品耐用性" /></label>
          <label>消费偏好<textarea rows={3} value={personaForm.preference} onChange={(e) => setPersonaForm({ ...personaForm, preference: e.target.value })} placeholder="如 偏好高性价比，关注物流时效，习惯先比价再下单" /></label>
        </TeacherDialog>
      ) : null}
    </div>
  );
}
