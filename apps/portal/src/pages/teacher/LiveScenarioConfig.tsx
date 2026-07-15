import { FolderUp, Package2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BUSINESS_STAGE_LABELS } from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  apiGet,
  apiPost,
  apiRequestDelete,
  apiRequestPatch,
  assetUrl,
  fetchScenarios,
  uploadProductImage,
  type ScenarioSummary,
  type Session,
  type StoreProduct,
} from "../../api/client";

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

export function LiveScenarioConfig({ session }: { session: Session }) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ name: "", spec: "", price: "", stock: "" });
  const [tab, setTab] = useState<"products" | "scenarios">("products");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const packInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [scenarioList, productList] = await Promise.all([
        fetchScenarios(session),
        apiGet<StoreProduct[]>("/v1/store/products?all=1", session),
      ]);
      setScenarios(scenarioList);
      setProducts(productList);
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

  async function toggleProduct(item: StoreProduct) {
    try {
      await apiRequestPatch(`/v1/store/products/${item.id}`, session, { enabled: item.enabled === false });
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  async function removeProduct(id: string) {
    if (!window.confirm("确定删除该商品吗？")) return;
    try {
      await apiRequestDelete(`/v1/store/products/${id}`, session);
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  async function editPrice(item: StoreProduct) {
    const value = window.prompt(`修改「${item.name}」价格（USD）`, String(item.price));
    if (value === null) return;
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 0) { setError("价格必须为正数。"); return; }
    try {
      await apiRequestPatch(`/v1/store/products/${item.id}`, session, { price });
      await load();
    } catch (cause) { setError(errorText(cause)); }
  }

  async function addProduct() {
    if (busy) return;
    const price = Number(form.price);
    if (!form.name.trim() || !form.spec.trim() || !Number.isFinite(price) || price <= 0) {
      setError("请填写商品名称、规格与正数价格。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await apiPost<{ id: string }>("/v1/store/products", session, {
        name: form.name.trim(), spec: form.spec.trim(), price, stock: Number(form.stock) || 0,
      });
      if (imageFile) await uploadProductImage(session, created.id, imageFile);
      setForm({ name: "", spec: "", price: "", stock: "" });
      setImageFile(null);
      setNotice("商品已添加，学生端工作台即时生效");
      await load();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
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
    setNotice(`批量导入完成：新增 ${created} 个商品${failed ? `，跳过/失败 ${failed} 个（可能重名）` : ""}。价格默认 9.9，可点击价格修改。`);
    setBusy(false);
    await load();
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="SCENE & STORE"
        title="场景配置"
        description="维护实训场景与店铺商品库；商品驱动学生端商品页签、订单生成与买家对话语境。"
        actions={
          tab === "products" ? (
            <button className="secondary-button" disabled={busy} onClick={() => packInputRef.current?.click()}>
              <FolderUp size={16} /> 批量导入资料包
            </button>
          ) : undefined
        }
      />
      <div className="segmented-tabs page-tabs">
        <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>商品库<span>{products.length}</span></button>
        <button className={tab === "scenarios" ? "active" : ""} onClick={() => setTab("scenarios")}>场景库<span>{scenarios.length}</span></button>
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
        <div className="panel-heading"><div><h2><Package2 size={16} /> 商品库</h2><p>{products.length} 个商品（CFG-05）· 点击价格可修改</p></div></div>
        <div className="form-grid product-form">
          <label>名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 Bluetooth Speaker" /></label>
          <label>规格<input value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })} placeholder="如 Black / IPX7" /></label>
          <label>价格(USD)<input type="number" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
          <label>库存<input type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></label>
          <label>主图<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} /></label>
        </div>
        <div className="form-actions"><button className="primary-button compact" disabled={busy} onClick={() => void addProduct()}><Plus size={14} /> 添加商品</button></div>
        <table>
          <thead><tr><th>主图</th><th>商品</th><th>价格</th><th>销量/库存</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {products.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.imageUrl ? (
                    <img className="product-photo" src={assetUrl(item.imageUrl) ?? undefined} alt={item.name} />
                  ) : (
                    <span className="product-thumb" style={{ background: item.tone }}><Package2 size={18} /></span>
                  )}
                </td>
                <td><strong>{item.name}</strong><small>{item.spec}</small></td>
                <td><button className="text-button" onClick={() => void editPrice(item)}>USD {item.price}</button></td>
                <td>{item.sales} / {item.stock}</td>
                <td><em className={item.enabled !== false ? "state-done" : "state-warning"}>{item.enabled !== false ? "在售" : "下架"}</em></td>
                <td>
                  <button className="text-button" onClick={() => void toggleProduct(item)}>{item.enabled !== false ? "下架" : "上架"}</button>
                  <button className="text-button" onClick={() => void removeProduct(item.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      ) : (
      <section className="panel data-panel">
        <div className="panel-heading"><div><h2>场景库</h2><p>{scenarios.length} 个场景 · 覆盖 4 个业务环节</p></div></div>
        <table>
          <thead><tr><th>编号</th><th>场景</th><th>业务环节</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {scenarios.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td><strong>{item.name}</strong><small>{item.objective}</small></td>
                <td><span className="status-pill">{BUSINESS_STAGE_LABELS[item.stage]}</span></td>
                <td><em className={item.enabled ? "state-done" : "state-warning"}>{item.enabled ? "已启用" : "已停用"}</em></td>
                <td><button className="text-button" onClick={() => void toggleScenario(item)}>{item.enabled ? "停用" : "启用"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      )}
    </div>
  );
}
