import {
  Check, CircleAlert, CircleCheck, FileSpreadsheet, Info, LibraryBig, Link2, Loader, Package2, Pencil, Plus, Sparkles, SquarePen, Star, Trash2, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import * as XLSX from "xlsx";
import {
  CATEGORY_SEP, PRODUCT_CATEGORIES, PRODUCT_DETAIL_GROUPS, PRODUCT_SOURCE_LABELS, categoryTemplate, isSizedCategory, productCompleteness,
  type CategoryTemplate, type ProductDetailGroup, type ProductDetails, type ProductSku,
} from "@cecs/contracts";
import {
  ApiError, apiGet, apiPost, apiRequestDelete, apiRequestPatch, assetUrl, uploadProductImage,
  type LibraryItem, type ProductDraft, type Session, type StoreProduct,
} from "../../api/client";
import {
  Bench, Board, Button, Confirm, DataTable, Dialog, Drawer, Field, FilterChips, HelpTip, Input, MoreMenu, SearchBox, Select, Switch, Textarea, Toolbar, toast,
} from "../../ui";
import { StoreCard } from "./StoreProfile";
import { CategoryPicker } from "./CategoryPicker";

/** 店铺商品（D-32）：卡片带详情完整度；添加商品三条主路（D-65）：新建商品（先选类目）/ 粘贴链接（打不开改粘贴文字）/ 商品库；Excel 在工具栏“批量导入” */


const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
/** 主图最多 5 张，第一张是主图（淘宝、1688 发布商品都是 5 张主图） */
const MAX_IMAGES = 5;
const GROUP_COUNT = PRODUCT_DETAIL_GROUPS.length;
const filledCount = (product: StoreProduct) => Object.values(productCompleteness(product)).filter(Boolean).length;

type AddMode = "ways" | "link" | "text";
/** 打开编辑抽屉时的初始内容：已有商品，或采集 / 手动的新草稿 */
interface EditorSeed {
  product: StoreProduct | null;
  draft?: { name: string; category: string | null; price: number | null; details: ProductDetails; source: "manual" | "link" | "text"; sourceUrl?: string };
  pendingImages?: Blob[];
}

export function ProductTab({ session, products, loading, reload }: { session: Session; products: StoreProduct[]; loading: boolean; reload: () => Promise<void> }) {
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<"all" | "partial" | "noimage" | "off">("all");
  const [adding, setAdding] = useState<AddMode | null>(null);
  const [library, setLibrary] = useState(false);
  const [excel, setExcel] = useState(false);
  const [editor, setEditor] = useState<EditorSeed | null>(null);
  const [removing, setRemoving] = useState<StoreProduct | null>(null);
  const [picking, setPicking] = useState(false);
  /* 选类目的“最近使用”：店里最近上架商品的类目（存在库里，不靠本机） */
  const recent = useMemo(() => [...new Set([...products].reverse().map((item) => item.category).filter((item): item is string => Boolean(item)))], [products]);

  const visible = products.filter((item) => !keyword.trim() || `${item.name} ${item.spec}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  const partial = (item: StoreProduct) => filledCount(item) < GROUP_COUNT;
  const noImage = (item: StoreProduct) => !(item.images?.length || item.imageUrl);
  const shown = visible.filter((item) => filter === "all" || (filter === "partial" ? partial(item) : filter === "noimage" ? noImage(item) : item.enabled === false));

  async function toggle(item: StoreProduct, enabled: boolean) {
    try {
      await apiRequestPatch(`/v1/store/products/${item.id}`, session, { enabled });
      toast.ok(enabled ? "已上架" : "已下架，学生端不再显示");
      await reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  const ways = (
    <AddWays
      onPick={(mode) => {
        if (mode === "library") { setAdding(null); setLibrary(true); }
        else if (mode === "manual") { setAdding(null); setPicking(true); }
        else if (mode === "excel") { setAdding(null); setExcel(true); }
        else setAdding(mode);
      }}
    />
  );

  return (
    <Bench>
      <StoreCard session={session} />
      <Toolbar actions={<><Button variant="ghost" icon={FileSpreadsheet} onClick={() => setExcel(true)}>批量导入</Button><Button variant="primary" icon={Plus} onClick={() => setAdding("ways")}>添加商品</Button></>}>
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索商品" />
        <FilterChips
          items={[
            { id: "all" as const, label: "全部", count: products.length },
            { id: "partial" as const, label: "详情不全", count: products.filter(partial).length },
            { id: "noimage" as const, label: "缺图片", count: products.filter(noImage).length },
            { id: "off" as const, label: "已下架", count: products.filter((item) => item.enabled === false).length },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </Toolbar>
      {loading ? <Board><p className="board-quiet">正在读取…</p></Board> : products.length === 0 ? (
        <Board className="gd-empty">
          <h3>店铺里还没有商品</h3>
          <p>学生接待时会查商品详情，买家也会围绕这些商品提问。先上架几个，再下发售前任务。</p>
          {ways}
        </Board>
      ) : shown.length === 0 ? (
        <Board><p className="board-quiet">没有匹配的商品</p></Board>
      ) : (
        <div className="card-grid">
          {shown.map((row) => {
            const filled = filledCount(row);
            const image = row.images?.[0] ?? row.imageUrl;
            const low = filled < 5;
            return (
              <article key={row.id} className={row.enabled === false ? "gd-card is-off" : "gd-card"} role="button" tabIndex={0}
                onClick={() => setEditor({ product: row })} onKeyDown={(event) => { if (event.key === "Enter") setEditor({ product: row }); }}>
                <div className="gd-card-img" style={image ? undefined : { background: `color-mix(in srgb, ${row.tone} 14%, #fff)`, color: row.tone }}>
                  {image ? <img src={assetUrl(image) ?? undefined} alt="" /> : <Package2 size={40} strokeWidth={1.3} />}
                  {row.enabled === false ? <span className="ui-tag is-neutral gd-card-flag">已下架</span> : !image ? <span className="ui-tag is-warn gd-card-flag">缺图片</span> : null}
                  {row.source && row.source !== "manual" ? <span className="ui-tag is-neutral gd-card-state">{PRODUCT_SOURCE_LABELS[row.source]}</span> : null}
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
                    <span className="gd-card-stock">库存 {row.stock}</span>
                  </div>
                  <div className={low ? "gd-card-full is-low" : "gd-card-full"}>
                    <span>详情</span>
                    <i><em style={{ width: `${(filled / GROUP_COUNT) * 100}%` }} /></i>
                    <b>{filled}/{GROUP_COUNT}</b>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {adding === "ways" ? <Dialog title="添加商品" width={900} onClose={() => setAdding(null)}>{ways}</Dialog> : null}
      {adding === "link" || adding === "text" ? (
        <CollectDialog
          session={session}
          mode={adding}
          onMode={setAdding}
          onClose={() => setAdding(null)}
          onDraft={(seed) => { setAdding(null); setEditor(seed); }}
        />
      ) : null}
      {library ? <LibraryDrawer session={session} onClose={() => setLibrary(false)} onAdded={() => { setLibrary(false); void reload(); }} /> : null}
      {excel ? <ExcelDialog session={session} onClose={() => setExcel(false)} onDone={() => { setExcel(false); void reload(); }} /> : null}
      {picking ? (
        <CategoryPicker value={null} recent={recent} onClose={() => setPicking(false)}
          onPick={(path) => { setPicking(false); setEditor({ product: null, draft: { name: "", category: path, price: null, details: {}, source: "manual" } }); }} />
      ) : null}
      {editor ? <ProductEditor session={session} seed={editor} recent={recent} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void reload(); }} /> : null}
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

// ---------- 添加方式 ----------

type WayId = "link" | "text" | "library" | "manual" | "excel";

function AddWays({ onPick }: { onPick: (mode: WayId) => void }) {
  const way = (id: WayId, Icon: typeof Link2, title: string, desc: string, meta: string, extra?: ReactNode) => (
    <div className="gd-way" role="button" tabIndex={0} onClick={() => onPick(id)} onKeyDown={(event) => { if (event.key === "Enter") onPick(id); }}>
      <span className="gd-way-ico"><Icon size={20} /></span>
      <b>{title}</b>
      <p>{desc}</p>
      <span className="gd-way-meta">{meta}</span>
      {extra}
    </div>
  );
  return (
    <div className="gd-ways-wrap">
      <div className="gd-ways">
        {way("manual", SquarePen, "新建商品", "先选类目，再按类目填属性、规格和库存，和电商平台发布商品的流程一样。", "不消耗额度")}
        {way("link", Link2, "粘贴商品链接", "粘贴速卖通、亚马逊、Shopee、1688 等平台的商品页链接，AI 读取后整理成商品信息，类目也自动识别。", "约 20 秒一个 · 消耗少量模型额度",
          <button type="button" className="gd-way-alt" onClick={(event) => { event.stopPropagation(); onPick("text"); }}>链接打不开？改为粘贴详情页文字 ›</button>)}
        {way("library", LibraryBig, "从商品库挑选", "系统内置的跨类目商品，图片和详情都已齐全，勾选后直接上架。", "不消耗额度 · 适合快速开课")}
      </div>
    </div>
  );
}

// ---------- 链接采集 / 粘贴文字 ----------

type StepState = "wait" | "run" | "done";

function CollectDialog({ session, mode, onMode, onClose, onDraft }: {
  session: Session;
  mode: "link" | "text";
  onMode: (mode: "link" | "text") => void;
  onClose: () => void;
  onDraft: (seed: EditorSeed) => void;
}) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<StepState[]>(["wait", "wait", "wait"]);
  const [note, setNote] = useState<{ found?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const canCapture = Boolean(window.desktopRuntime?.capturePage);

  async function extract(body: { url?: string; title?: string; structured?: string; text: string }, source: "link" | "text", images: Blob[]) {
    const draft = await apiPost<ProductDraft>("/v1/store/products/extract", session, body);
    onDraft({
      product: null,
      draft: { name: draft.name, category: draft.category, price: draft.price, details: draft.details, source, sourceUrl: body.url },
      pendingImages: images,
    });
  }

  async function startLink() {
    const target = url.trim();
    if (!/^https?:\/\/\S+$/i.test(target)) return toast.error("请粘贴完整的商品页链接（以 http 开头）");
    setBusy(true);
    setNote({});
    setSteps(["run", "wait", "wait"]);
    try {
      const page = await window.desktopRuntime!.capturePage!(target);
      if (!page.ok) {
        setSteps(["wait", "wait", "wait"]);
        setNote({ error: page.reason === "closed" ? "读取窗口被关掉了。" : page.reason === "timeout" ? "两分钟内没读到商品信息，页面可能要求登录或验证。" : "链接格式不对。" });
        return;
      }
      setSteps(["done", "run", "wait"]);
      setNote({ found: `读到 ${page.text.length} 字${page.images.length ? `、${page.images.length} 张图` : ""}` });
      const images = await Promise.all(page.images.map((item) => fetch(item.dataUrl).then((response) => response.blob())));
      await extract({ url: page.url, title: page.title, structured: page.structured, text: page.text }, "link", images);
    } catch (cause) {
      setSteps((current) => current.map((item) => (item === "run" ? "wait" : item)));
      setNote({ error: errorText(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function startText() {
    if (text.trim().length < 30) return toast.error("内容太少了，把详情页的文字全选复制进来");
    setBusy(true);
    setNote({});
    setSteps(["done", "run", "wait"]);
    try {
      await extract({ text: text.trim() }, "text", []);
    } catch (cause) {
      setSteps(["done", "wait", "wait"]);
      setNote({ error: errorText(cause) });
    } finally {
      setBusy(false);
    }
  }

  const step = (state: StepState, label: string, extra?: string) => (
    <div className={`gd-step is-${state}`}>
      <span className="gd-step-ico">{state === "done" ? <Check size={14} /> : state === "run" ? <Loader size={14} className="spin" /> : null}</span>
      {label}
      {extra ? <span className="gd-step-r">{extra}</span> : null}
    </div>
  );

  return (
    <Dialog
      title={mode === "link" ? "粘贴商品链接" : "粘贴详情页文字"}
      width={760}
      onClose={onClose}
    >
      <div className="gd-collect">
        {mode === "link" ? (
          <>
            <div className="gd-url">
              <Input autoFocus value={url} placeholder="https://www.aliexpress.com/item/…" disabled={busy || !canCapture}
                onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void startLink(); }} />
              <Button variant="primary" loading={busy} disabled={!canCapture} onClick={() => void startLink()}>{busy ? "读取中" : "开始读取"}</Button>
            </div>
            {!canCapture ? (
              <p className="gd-collect-warn"><CircleAlert size={15} />链接采集只能在电脑客户端里用。<button type="button" onClick={() => onMode("text")}>改为粘贴详情页文字</button></p>
            ) : null}
            <div className="gd-steps">
              {step(steps[0]!, "打开页面", steps[0] === "run" ? "会弹出一个窗口，读完自动关闭" : undefined)}
              {step(steps[1]!, "AI 整理标题、规格、卖点、参数、物流和售后", steps[1] === "run" ? note.found : undefined)}
              {step(steps[2]!, "核对并上架")}
            </div>
          </>
        ) : (
          <>
            <Textarea autoFocus rows={10} value={text} disabled={busy} maxLength={30000}
              placeholder="在商品详情页按 Ctrl+A 全选、Ctrl+C 复制，然后粘贴到这里。标题、价格、规格、参数、物流、售后说明越全越好"
              onChange={(event) => setText(event.target.value)} />
            <div className="gd-text-foot">
              <span>{text.length ? `${text.length} 字` : "图片在下一步上传"}</span>
              <Button variant="primary" icon={Sparkles} loading={busy} onClick={() => void startText()}>AI 整理</Button>
            </div>
          </>
        )}
        {note.error ? (
          <p className="gd-collect-error">
            <CircleAlert size={15} />{note.error}
            {mode === "link" ? <button type="button" onClick={() => onMode("text")}>改为粘贴详情页文字</button> : null}
          </p>
        ) : null}
        <p className="gd-collect-note"><Info size={14} />{mode === "link" ? "页面要求验证时，读取窗口会停下来，手动点一下即可继续。" : ""}采集的图片和文字仅限校内教学使用。</p>
      </div>
    </Dialog>
  );
}

// ---------- 内置商品库 ----------

function LibraryDrawer({ session, onClose, onAdded }: { session: Session; onClose: () => void; onAdded: () => void }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [category, setCategory] = useState("");
  const [keyword, setKeyword] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<LibraryItem[]>("/v1/store/library", session).then(setItems).catch((cause) => { toast.error(errorText(cause)); setItems([]); });
  }, [session]);

  const list = (items ?? []).filter((item) => (!category || item.category === category) && (!keyword.trim() || item.name.toLowerCase().includes(keyword.trim().toLowerCase())));
  const toggle = (id: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  async function add() {
    setBusy(true);
    try {
      const result = await apiPost<{ created: number; skipped: number }>("/v1/store/library/add", session, { ids: [...picked] });
      toast.ok(`已上架 ${result.created} 个商品${result.skipped ? `，${result.skipped} 个店里已有` : ""}`);
      onAdded();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="从商品库挑选"
      width={1040}
      flush
      onClose={onClose}
      footer={
        <>
          <span className="gd-lib-foot">上架后可以改价格和库存<HelpTip>每个商品都带图片、规格、卖点、参数、物流和售后，学生端商品详情和买家 AI 都会用到</HelpTip></span>
          <span className="gd-lib-count">已选 <b>{picked.size}</b> 个</span>
          <Button variant="primary" loading={busy} disabled={!picked.size} onClick={() => void add()}>{picked.size ? `上架 ${picked.size} 个商品` : "上架"}</Button>
        </>
      }
    >
      <div className="gd-lib">
        <nav className="gd-lib-cat">
          {[["", "全部"] as const, ...PRODUCT_CATEGORIES.map((item) => [item, item] as const)].map(([id, label]) => {
            const count = (items ?? []).filter((item) => !id || item.category === id).length;
            if (id && !count) return null;
            return <button key={id || "all"} type="button" className={category === id ? "is-on" : ""} onClick={() => setCategory(id)}>{label}<i>{count}</i></button>;
          })}
        </nav>
        <div className="gd-lib-main">
          <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索商品" />
          {items === null ? <p className="board-quiet">正在读取…</p> : list.length === 0 ? <p className="board-quiet">{items.length ? "没有匹配的商品" : "商品库还没准备好"}</p> : (
            <div className="gd-lib-grid">
              {list.map((item) => {
                const on = picked.has(item.id);
                return (
                  <button key={item.id} type="button" disabled={item.inStore} className={item.inStore ? "gd-lib-item is-in" : on ? "gd-lib-item is-sel" : "gd-lib-item"} onClick={() => toggle(item.id)}>
                    <span className="gd-lib-img"><img src={assetUrl(item.imageUrl) ?? undefined} alt="" loading="lazy" /></span>
                    {item.inStore ? <span className="ui-tag is-neutral gd-lib-have">已上架</span> : <span className="gd-lib-ck">{on ? <Check size={14} /> : null}</span>}
                    <span className="gd-lib-body"><b title={item.name}>{item.name}</b><span><b>${item.price.toFixed(2)}</b><em>{item.category}</em></span></span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

// ---------- Excel 批量导入 ----------

const EXCEL_COLUMNS = ["商品名称", "类目", "价格（美元）", "库存", "颜色", "尺码", "卖点（每条用 | 分隔）", "描述", "参数（名称=值，用 ; 分隔）", "发货地", "备货天数", "退换政策", "保修"] as const;

function ExcelDialog({ session, onClose, onDone }: { session: Session; onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ created: number; failed: Array<{ row: number; reason: string }> } | null>(null);
  const [busy, setBusy] = useState(false);

  function download() {
    const sheet = XLSX.utils.aoa_to_sheet([
      [...EXCEL_COLUMNS],
      ["Linen Wide-Leg Pants", "服装 > 女装 > 裤装", 26.9, 200, "Beige/Black", "S/M/L/XL", "Breathable linen blend|Elastic waist with drawstring|Two side pockets", "Relaxed wide-leg pants for summer days.", "材质=55% 亚麻 45% 棉;裤长=约 100cm;产地=中国", "中国广州", 3, "签收后 30 天内可退换，商品需未穿着、吊牌完整", "无"],
    ]);
    sheet["!cols"] = EXCEL_COLUMNS.map((_, index) => ({ wch: index === 0 || index >= 6 ? 30 : 12 }));
    const notes = XLSX.utils.aoa_to_sheet([["列", "说明"], ["类目", "填完整路径（服装 > 女装 > 裤装）或最末一级的名字（裤装、无线耳机、保温杯），和“新建商品”里选类目的名字一样"], ["颜色 / 尺码", "多个取值用 / 分隔，会自动生成规格组合，每个组合的价格和库存先用这一行的价格、库存"], ["图片", "导入后在商品卡片里上传"]]);
    notes["!cols"] = [{ wch: 12 }, { wch: 90 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "店铺商品");
    XLSX.utils.book_append_sheet(book, notes, "填写说明");
    XLSX.writeFile(book, "店铺商品导入模板.xlsx");
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const book = XLSX.read(await file.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[book.SheetNames[0]!]!, { defval: "" });
      const failed: Array<{ row: number; reason: string }> = [];
      const valid: Array<{ row: number; body: Record<string, unknown> }> = [];
      rows.forEach((raw, index) => {
        const cell = (key: string) => String(raw[key] ?? "").trim();
        const row = index + 2;
        const name = cell("商品名称");
        const price = Number(cell("价格（美元）"));
        if (!name && !cell("价格（美元）")) return;
        if (!name) return failed.push({ row, reason: "商品名称没填" });
        if (!Number.isFinite(price) || price <= 0) return failed.push({ row, reason: "价格要大于 0" });
        const stock = Number(cell("库存")) || 100;
        const options = [["颜色", cell("颜色")], ["尺码", cell("尺码")]]
          .map(([optionName, value]) => ({ name: optionName!, values: value!.split("/").map((item) => item.trim()).filter(Boolean) }))
          .filter((option) => option.values.length);
        const details: ProductDetails = {
          options,
          skus: buildSkus(options, [], price, stock),
          bullets: cell("卖点（每条用 | 分隔）").split("|").map((item) => item.trim()).filter(Boolean),
          description: cell("描述"),
          specs: cell("参数（名称=值，用 ; 分隔）").split(/[;；]/).map((pair) => pair.split("=")).filter((pair) => pair.length === 2).map(([key, value]) => ({ name: key!.trim(), value: value!.trim() })),
          shipping: { shipsFrom: cell("发货地"), handlingDays: Number(cell("备货天数")) || undefined, methods: [] },
          afterSale: { returnPolicy: cell("退换政策"), warranty: cell("保修") },
        };
        valid.push({ row, body: { name, price, stock, category: cell("类目") || null, details } });
      });
      let created = 0;
      if (valid.length) {
        const response = await apiPost<{ created: number; failed: Array<{ index: number; reason: string }> }>("/v1/store/products/import", session, { products: valid.map((item) => item.body) });
        created = response.created;
        for (const item of response.failed) failed.push({ row: valid[item.index]!.row, reason: item.reason });
      }
      setResult({ created, failed: failed.sort((a, b) => a.row - b.row) });
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "读不了这个文件，请用模板里的格式");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Dialog title="导入结果" onClose={onDone} footer={<Button variant="primary" onClick={onDone}>好的</Button>}>
        <p>导入 {result.created} 个商品{result.failed.length ? `，${result.failed.length} 行没导入：` : "，全部成功。图片在商品卡片里上传。"}</p>
        {result.failed.length ? (
          <DataTable rows={result.failed} rowKey={(row) => String(row.row)}
            columns={[{ key: "row", title: "Excel 行号", width: 100, render: (row) => `第 ${row.row} 行` }, { key: "reason", title: "原因", render: (row) => row.reason }]} />
        ) : null}
      </Dialog>
    );
  }
  return (
    <Dialog title="Excel 批量导入" onClose={onClose}
      footer={<><Button onClick={download}>下载模板</Button><Button variant="primary" loading={busy} onClick={() => fileRef.current?.click()}>选择文件</Button></>}>
      <p className="gd-excel-desc">按模板一行填一个商品。颜色、尺码用 / 分隔，会自动生成规格组合；图片导入后在商品卡片里上传。</p>
      <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
    </Dialog>
  );
}

// ---------- 商品编辑 / 核对采集结果 ----------

/** 按规格维度生成全部组合；已有组合保留原价格和库存 */
/** 规格最多 3 个维度、60 个组合 */
const MAX_DIMS = 3;
const MAX_SKUS = 60;
/** 添加规格时的常用规格名，去掉商品里已经有的 */
const COMMON_DIM_NAMES = ["款式", "套餐", "包装", "容量", "版本"];
/** 规格值可以一次粘贴多个：逗号、顿号、分号、换行都算分隔 */
const splitValues = (text: string) => text.split(/[,，、;；\n\t]+/).map((item) => item.trim()).filter(Boolean);

function buildSkus(options: Array<{ name: string; values: string[] }>, existing: ProductSku[], price: number, stock: number): ProductSku[] {
  const dims = options.filter((option) => option.name.trim() && option.values.length);
  if (!dims.length) return [];
  let combos: Array<Record<string, string>> = [{}];
  for (const dim of dims) combos = combos.flatMap((combo) => dim.values.map((value) => ({ ...combo, [dim.name]: value })));
  const key = (values: Record<string, string>) => dims.map((dim) => values[dim.name] ?? "").join("|");
  const old = new Map(existing.map((sku) => [key(sku.values), sku]));
  // 加了一个规格后，新组合沿用去掉新规格那一层的老组合的价格和库存（Black · US 7 → Black · US 7 · Classic）
  const parent = (values: Record<string, string>) => existing.find((sku) => {
    const names = Object.keys(sku.values);
    return names.length > 0 && names.every((name) => values[name] === sku.values[name]);
  });
  return combos.slice(0, MAX_SKUS).map((values) => {
    const same = old.get(key(values));
    if (same) return same;
    const from = parent(values);
    return from ? { values, price: from.price, stock: from.stock } : { values, price, stock };
  });
}

type ImageItem = { kind: "saved"; url: string } | { kind: "pending"; blob: Blob; preview: string };

/** 按类目补出要填的类目属性和规格维度（D-65）：已经有的不动，模板的规格维度排在前面，最多 3 个 */
function withTemplate(details: ProductDetails, template: CategoryTemplate | null): ProductDetails {
  if (!template) return details;
  const specs = [...(details.specs ?? [])];
  for (const attr of template.attributes) if (!specs.some((row) => row.name === attr.name)) specs.push({ name: attr.name, value: "" });
  const options = [...(details.options ?? [])];
  for (const dim of template.dims) if (options.length < 3 && !options.some((option) => option.name === dim.name)) options.push({ name: dim.name, values: [] });
  const rank = (name: string) => { const index = template.dims.findIndex((dim) => dim.name === name); return index < 0 ? 9 : index; };
  return { ...details, specs, options: options.sort((a, b) => rank(a.name) - rank(b.name)) };
}

/** 规格值输入框：回车、逗号添加；一次粘贴多个（逗号、顿号、换行隔开）自动拆开 */
function DimValueInput({ placeholder, wide, inputRef, onAdd, onEmptyEnter, onEscape }: {
  placeholder: string; wide?: boolean; inputRef?: Ref<HTMLInputElement>; onAdd: (values: string[]) => void; onEmptyEnter?: () => void; onEscape?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (text: string) => {
    const next = splitValues(text);
    if (next.length) onAdd(next);
    setDraft("");
  };
  return (
    <input ref={inputRef} className={wide ? "pe-dim-add is-wide" : "pe-dim-add"} value={draft} maxLength={40} placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)} onBlur={() => add(draft)}
      onPaste={(event) => {
        const text = event.clipboardData.getData("text");
        if (splitValues(text).length > 1) { event.preventDefault(); add(`${draft},${text}`); }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") return onEscape?.();
        if (event.key !== "Enter" && event.key !== "," && event.key !== "，") return;
        event.preventDefault();
        if (!draft.trim() && event.key === "Enter") onEmptyEnter?.();
        else add(draft);
      }} />
  );
}

/** 一个规格维度：平台标准取值（尺码、鞋码）勾选，其他取值自己填；自己加的规格点名称改名 */
function DimRow({ name, presets, values, taken, onChange, onRename, onRemove }: {
  name: string; presets?: readonly string[]; values: string[]; taken: string[]; onChange: (values: string[]) => void; onRename?: (name: string) => void; onRemove?: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const cancelRename = useRef(false);
  const add = (next: string[]) => {
    const fresh = next.filter((value, index) => !values.includes(value) && next.indexOf(value) === index);
    if (fresh.length) onChange([...values, ...fresh]);
  };
  const commitName = () => {
    const next = (renaming ?? "").trim();
    setRenaming(null);
    if (cancelRename.current) { cancelRename.current = false; return; }
    if (!next || next === name) return;
    if (taken.includes(next)) return void toast.error(`已经有“${next}”了`);
    onRename?.(next);
  };
  const toggle = (value: string) => {
    const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
    // 标准取值按平台顺序排（S 在 M 前面），自己加的排后面
    const rank = (item: string) => { const index = presets?.indexOf(item) ?? -1; return index < 0 ? 99 : index; };
    onChange(next.sort((a, b) => rank(a) - rank(b)));
  };
  const extras = values.filter((value) => !presets?.includes(value));
  return (
    <div className="pe-dim">
      {renaming !== null ? (
        <Input className="pe-dim-name" autoFocus value={renaming} maxLength={12} onChange={(event) => setRenaming(event.target.value)} onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelRename.current = true;
            if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
          }} />
      ) : onRename ? (
        <button type="button" className="pe-dim-rename" title="改名" onClick={() => setRenaming(name)}>{name}<Pencil size={13} /></button>
      ) : <b>{name}</b>}
      <div className="pe-dim-vals">
        {presets?.map((value) => <button key={value} type="button" className={values.includes(value) ? "is-on" : undefined} onClick={() => toggle(value)}>{value}</button>)}
        {extras.map((value) => <span key={value} className="pe-dim-chip">{value}<button type="button" title="去掉" onClick={() => onChange(values.filter((item) => item !== value))}><X size={12} /></button></span>)}
        <DimValueInput placeholder={presets ? "其他取值" : `加${name}，回车添加`} onAdd={add} />
      </div>
      {onRemove ? <button type="button" className="pe-del" title="删除这个规格" onClick={onRemove}><Trash2 size={15} /></button> : <span />}
    </div>
  );
}

/** 添加规格（D-72）：先定规格名（常用名点一下就填好），再填规格值，底部算出添加后一共几个规格；添加后收成普通的一行 */
function NewDimCard({ dims, onAdd, onCancel }: { dims: Array<{ name: string; values: string[] }>; onAdd: (name: string, values: string[]) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const valueRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const taken = dims.map((dim) => dim.name);
  const duplicate = taken.includes(trimmed);
  const suggestions = COMMON_DIM_NAMES.filter((item) => !taken.includes(item));
  const filled = dims.filter((dim) => dim.name.trim() && dim.values.length);
  const total = filled.reduce((count, dim) => count * dim.values.length, 1) * values.length;
  const ready = Boolean(trimmed) && !duplicate && values.length > 0;
  const add = (next: string[]) => setValues((current) => [...current, ...next.filter((value, index) => !current.includes(value) && next.indexOf(value) === index)]);
  const pick = (item: string) => { setName(item); valueRef.current?.focus(); };
  return (
    <div className="pe-newdim">
      <div className="pe-newdim-row">
        <label>规格名</label>
        <div className="pe-newdim-name">
          <Input autoFocus value={name} maxLength={12} placeholder="如 款式"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); valueRef.current?.focus(); }
              if (event.key === "Escape") onCancel();
            }} />
          {suggestions.length ? (
            <span className="pe-newdim-sug">常用{suggestions.map((item) => <button key={item} type="button" className={trimmed === item ? "is-on" : undefined} onClick={() => pick(item)}>{item}</button>)}</span>
          ) : null}
        </div>
      </div>
      {duplicate ? <p className="pe-newdim-err">已经有“{trimmed}”了</p> : null}
      <div className="pe-newdim-row">
        <label>规格值</label>
        <div className="pe-dim-vals">
          {values.map((value) => <span key={value} className="pe-dim-chip">{value}<button type="button" title="去掉" onClick={() => setValues(values.filter((item) => item !== value))}><X size={12} /></button></span>)}
          <DimValueInput wide inputRef={valueRef} placeholder="回车添加，可粘贴多个，用逗号隔开" onAdd={add} onEscape={onCancel}
            onEmptyEnter={() => { if (ready) onAdd(trimmed, values); }} />
        </div>
      </div>
      <div className="pe-newdim-ft">
        <span>
          {ready ? <>添加后 {filled.map((dim) => `${dim.name} ${dim.values.length} × `).join("")}<em>{trimmed} {values.length}</em> = <b>{total}</b> 个规格{total > MAX_SKUS ? <i>，只保留前 {MAX_SKUS} 个</i> : null}</> : null}
        </span>
        <Button size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" variant="primary" disabled={!ready} onClick={() => onAdd(trimmed, values)}>添加</Button>
      </div>
    </div>
  );
}

function ProductEditor({ session, seed, recent, onClose, onSaved }: { session: Session; seed: EditorSeed; recent: string[]; onClose: () => void; onSaved: () => void }) {
  const product = seed.product;
  const initial = product
    ? { name: product.name, category: product.category ?? null, price: product.price, details: product.details ?? {} }
    : { name: seed.draft?.name ?? "", category: seed.draft?.category ?? null, price: seed.draft?.price ?? null, details: seed.draft?.details ?? {} };
  const [name, setName] = useState(initial.name);
  const [category, setCategory] = useState(initial.category ?? "");
  const [price, setPrice] = useState(initial.price ? String(initial.price) : "");
  const [stock, setStock] = useState(product ? String(product.stock) : "100");
  const [details, setDetails] = useState<ProductDetails>(() => withTemplate({
    options: [], skus: [], bullets: [], description: "", specs: [], sizeChart: null,
    shipping: { shipsFrom: "", methods: [] }, afterSale: { returnPolicy: "", warranty: "" }, faq: [],
    ...initial.details,
  }, categoryTemplate(initial.category)));
  const [picking, setPicking] = useState(false);
  /** 换类目会重置类目属性和规格，先确认 */
  const [switching, setSwitching] = useState<string | null>(null);
  const [bulk, setBulk] = useState({ price: "", stock: "" });
  /** 正在添加规格（展开小卡） / 刚加的自定义属性行（名称框自动聚焦） */
  const [addingDim, setAddingDim] = useState(false);
  const [newAttrIndex, setNewAttrIndex] = useState(-1);
  const [images, setImages] = useState<ImageItem[]>(() => [
    ...(product?.images?.length ? product.images : product?.imageUrl ? [product.imageUrl] : []).map((url) => ({ kind: "saved" as const, url })),
    ...(seed.pendingImages ?? []).map((blob) => ({ kind: "pending" as const, blob, preview: URL.createObjectURL(blob) })),
  ].slice(0, MAX_IMAGES));
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<ProductDetailGroup>("images");
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { images.forEach((item) => { if (item.kind === "pending") URL.revokeObjectURL(item.preview); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (next: Partial<ProductDetails>) => setDetails((current) => ({ ...current, ...next }));
  const numericPrice = Number(price);
  const completeness = useMemo(
    () => productCompleteness({ name, price: numericPrice, category: category || null, images: images.map(() => "x"), details }),
    [name, numericPrice, category, images, details],
  );
  const fromCollect = seed.draft?.source === "link" || seed.draft?.source === "text";
  const template = categoryTemplate(category);
  const sized = isSizedCategory(category);
  /* 不需要尺码表的类目，左栏不显示这一组 */
  const groups = PRODUCT_DETAIL_GROUPS.filter((group) => group.key !== "sizeChart" || sized);
  const missingShown = groups.filter((group) => !completeness[group.key]);

  function applyCategory(next: string) {
    setCategory(next);
    setSwitching(null);
    setPicking(false);
    const nextTemplate = categoryTemplate(next);
    setDetails((current) => withTemplate({ ...current, specs: [], options: [], skus: [], sizeChart: null }, nextTemplate));
  }
  function pickCategory(next: string) {
    if (next === category) return setPicking(false);
    const touched = (details.specs ?? []).some((row) => row.value.trim()) || (details.options ?? []).some((option) => option.values.length);
    if (category && touched) { setPicking(false); setSwitching(next); }
    else applyCategory(next);
  }

  function jump(key: ProductDetailGroup) {
    setActive(key);
    bodyRef.current?.querySelector(`[data-group="${key}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_IMAGES - images.length;
    const picked = Array.from(files).filter((file) => /^image\/(png|jpe?g|webp)$/.test(file.type)).slice(0, room);
    if (files.length > room) toast.error(`每个商品最多 ${MAX_IMAGES} 张图片`);
    setImages([...images, ...picked.map((blob) => ({ kind: "pending" as const, blob, preview: URL.createObjectURL(blob) }))]);
  }

  async function save() {
    if (!category) return setPicking(true), toast.error("先选类目，类目决定要填哪些属性和规格");
    if (!name.trim()) return jump("basic"), toast.error("商品标题要填");
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return jump("basic"), toast.error("价格要大于 0");
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        price: numericPrice,
        stock: Number(stock) || 0,
        category: category || null,
        details,
        images: images.filter((item): item is { kind: "saved"; url: string } => item.kind === "saved").map((item) => item.url),
        source: seed.draft?.source ?? "manual",
        sourceUrl: seed.draft?.sourceUrl ?? null,
        spec: "",
      };
      const id = product ? product.id : (await apiPost<{ id: string }>("/v1/store/products", session, body)).id;
      if (product) await apiRequestPatch(`/v1/store/products/${id}`, session, body);
      // 新图逐张上传，再按页面上的顺序整理一次（第一张是主图）
      if (images.some((item) => item.kind === "pending")) {
        const ordered: string[] = [];
        for (const item of images) {
          if (item.kind === "saved") ordered.push(item.url);
          else ordered.push((await uploadProductImage(session, id, item.blob)).imageUrl);
        }
        await apiRequestPatch(`/v1/store/products/${id}`, session, { ...body, images: ordered });
      }
      toast.ok(product ? "已保存" : "已上架");
      onSaved();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const options = details.options ?? [];
  const skus = details.skus ?? [];
  const regenerate = (nextOptions: typeof options) => patch({ options: nextOptions, skus: buildSkus(nextOptions, skus, numericPrice > 0 ? numericPrice : 0, Number(stock) || 100) });
  const skuDims = options.filter((option) => option.name.trim() && option.values.length);
  /** 改名不动价格库存：规格表里的键跟着改 */
  const renameDim = (index: number, next: string) => {
    const before = options[index]?.name ?? "";
    patch({
      options: options.map((option, i) => (i === index ? { ...option, name: next } : option)),
      skus: skus.map((sku) => (before in sku.values ? { ...sku, values: Object.fromEntries(Object.entries(sku.values).map(([key, value]) => [key === before ? next : key, value])) } : sku)),
    });
  };

  const chart = details.sizeChart ?? null;
  const sizeDim = sized ? template?.dims.find((dim) => dim.presets) ?? null : null;
  const sizeValues = sizeDim ? options.find((option) => option.name === sizeDim.name)?.values ?? [] : [];
  const sizeKey = sizeValues.join("|");
  useEffect(() => {
    if (!sized || !sizeValues.length || !template?.sizeChart) return;
    setDetails((current) => {
      const now = current.sizeChart ?? null;
      const headers = now?.headers.length ? now.headers : [...template.sizeChart!];
      const rows = sizeValues.map((value) => now?.rows.find((row) => row[0] === value) ?? [value, ...headers.slice(1).map(() => "")]);
      // 自己加的行（不是勾选出来的尺码）保留
      const manual = (now?.rows ?? []).filter((row) => !sizeDim?.presets?.includes(row[0] ?? "") && !sizeValues.includes(row[0] ?? ""));
      const next = { headers, rows: [...rows, ...manual] };
      return JSON.stringify(next) === JSON.stringify(now) ? current : { ...current, sizeChart: next };
    });
  }, [sized, sizeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shipping = details.shipping ?? {};
  const afterSale = details.afterSale ?? {};

  return (
    <Drawer
      title={<>{product ? "编辑商品" : fromCollect ? "核对商品信息" : "添加商品"}{seed.draft && seed.draft.source !== "manual" ? <span className="ui-tag is-neutral pe-src">{PRODUCT_SOURCE_LABELS[seed.draft.source]}</span> : null}</>}
      width={1040}
      flush
      onClose={onClose}
      footer={<><span className="pe-foot-note">保存后可以随时再编辑</span><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{product ? "保存" : "上架"}</Button></>}
    >
      <div className="pe">
        <nav className="pe-nav">
          <div className="pe-cat">
            <small>类目</small>
            <b>{category ? category.split(CATEGORY_SEP).join(" › ") : "还没选类目"}</b>
            <button type="button" onClick={() => setPicking(true)}>{category ? "更换类目" : "选择类目"}</button>
          </div>
          {groups.map((group) => (
            <button key={group.key} type="button" className={active === group.key ? "is-on" : ""} onClick={() => jump(group.key)}>
              {group.label}
              {completeness[group.key] ? <CircleCheck size={15} className="is-ok" /> : <CircleAlert size={15} className="is-miss" />}
            </button>
          ))}
          <div className="pe-sum"><b>{groups.length - missingShown.length}</b> / {groups.length} 组已填</div>
        </nav>
        <div className="pe-body" ref={bodyRef}>
          {fromCollect && missingShown.length ? (
            <p className="pe-banner">
              <CircleAlert size={16} />页面上没读到{missingShown.map((group) => group.label).join("、")}，补上后买家问起时学生才答得出。
              {seed.draft?.sourceUrl ? <a href={seed.draft.sourceUrl} target="_blank" rel="noreferrer">查看原页面</a> : null}
            </p>
          ) : null}

          <section data-group="images" className="pe-sec">
            <h4>主图<span>{images.length} / {MAX_IMAGES}</span><HelpTip>第一张是主图，买家先看到它。鼠标移到图上可以设为主图或删除</HelpTip></h4>
            <div className="pe-thumbs">
              {images.map((item, index) => (
                <div key={item.kind === "saved" ? item.url : item.preview} className="pe-thumb">
                  <img src={item.kind === "saved" ? assetUrl(item.url) ?? undefined : item.preview} alt="" />
                  {index === 0 ? <span className="pe-thumb-main">主图</span> : null}
                  <span className="pe-thumb-ops">
                    {index > 0 ? <button type="button" title="设为主图" onClick={() => setImages([item, ...images.filter((_, i) => i !== index)])}><Star size={13} /></button> : null}
                    <button type="button" title="删除" onClick={() => setImages(images.filter((_, i) => i !== index))}><X size={13} /></button>
                  </span>
                </div>
              ))}
              {Array.from({ length: MAX_IMAGES - images.length }, (_, index) => images.length + index).map((slot) => (
                <button key={`slot-${slot}`} type="button" className="pe-thumb is-add" onClick={() => fileRef.current?.click()}>
                  <Plus size={18} /><small>{slot === 0 ? "主图" : `图 ${slot + 1}`}</small>
                </button>
              ))}
              <input ref={fileRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
            </div>
          </section>

          <section data-group="basic" className="pe-sec">
            <h4>基本信息</h4>
            <div className="pe-grid-basic">
              <Field label="商品标题"><Input value={name} maxLength={120} placeholder="Wrap V-Neck Short Sleeve Maxi Dress" onChange={(event) => setName(event.target.value)} /></Field>
              <Field label="价格（美元）"><Input type="number" min={0} step={0.01} value={price} onChange={(event) => setPrice(event.target.value)} /></Field>
              {!skus.length ? <Field label="库存"><Input type="number" min={0} value={stock} onChange={(event) => setStock(event.target.value)} /></Field> : null}
            </div>
          </section>

          <section data-group="specs" className="pe-sec">
            <h4>类目属性<span>{template ? "按类目预设，至少填 3 项；买家问起材质、型号这类问题，学生按这里回答" : "至少 3 项，如材质、尺寸、重量、产地、包装清单"}</span></h4>
            {template ? (
              <div className="pe-attrs">
                {template.attributes.map((attr) => {
                  const value = (details.specs ?? []).find((row) => row.name === attr.name)?.value ?? "";
                  const listId = `pe-attr-${attr.name}`;
                  return (
                    <Field key={attr.name} label={attr.name}>
                      <Input value={value} maxLength={120} placeholder={attr.placeholder ?? (attr.options ? attr.options.slice(0, 3).join(" / ") : "")} list={attr.options ? listId : undefined}
                        onChange={(event) => {
                          const rows = details.specs ?? [];
                          patch({ specs: rows.some((row) => row.name === attr.name) ? rows.map((row) => (row.name === attr.name ? { ...row, value: event.target.value } : row)) : [...rows, { name: attr.name, value: event.target.value }] });
                        }} />
                      {attr.options ? <datalist id={listId}>{attr.options.map((option) => <option key={option} value={option} />)}</datalist> : null}
                    </Field>
                  );
                })}
              </div>
            ) : null}
            <div className="pe-list">
              {(details.specs ?? []).map((row, index) => ({ row, index })).filter(({ row }) => !(template?.attributes.map((item) => item.name) ?? []).includes(row.name)).map(({ row, index }) => (
                <div key={index} className="pe-kv">
                  <Input value={row.name} maxLength={20} placeholder="属性名，如 产地" autoFocus={index === newAttrIndex} onChange={(event) => patch({ specs: (details.specs ?? []).map((r, i) => (i === index ? { ...r, name: event.target.value } : r)) })} />
                  <Input value={row.value} maxLength={120} placeholder="中国广东" onChange={(event) => patch({ specs: (details.specs ?? []).map((r, i) => (i === index ? { ...r, value: event.target.value } : r)) })} />
                  <button type="button" className="pe-del" onClick={() => patch({ specs: (details.specs ?? []).filter((_, i) => i !== index) })}><Trash2 size={15} /></button>
                </div>
              ))}
              <button type="button" className="pe-addrow" onClick={() => { setNewAttrIndex((details.specs ?? []).length); patch({ specs: [...(details.specs ?? []), { name: "", value: "" }] }); }}>
                <Plus size={15} />添加自定义属性<small>如 产地、包装清单、认证</small>
              </button>
            </div>
          </section>

          <section data-group="skus" className="pe-sec">
            <h4>规格与库存<span>{skus.length ? `${options.filter((o) => o.values.length).map((o) => `${o.name} ${o.values.length}`).join(" × ")} = ${skus.length} 个规格` : template ? `这个类目用“${template.dims.map((dim) => dim.name).join(" × ")}”；只卖一个款式就不用填，价格库存写在基本信息里` : "最多 3 个维度，如颜色、尺码"}</span>
              <HelpTip>规格是买家下单时要选的，如颜色、尺码、款式，每个组合单独定价、单独算库存。材质、产地这类不用选的，写在上面的类目属性里。</HelpTip>
            </h4>
            <div className="pe-dims">
              {options.map((option, index) => {
                const preset = template?.dims.find((dim) => dim.name === option.name);
                return (
                  <DimRow key={index} name={option.name} presets={preset?.presets} values={option.values} taken={options.filter((_, i) => i !== index).map((o) => o.name)}
                    onChange={(values) => regenerate(options.map((o, i) => (i === index ? { ...o, values } : o)))}
                    onRename={preset ? undefined : (next) => renameDim(index, next)}
                    onRemove={preset ? undefined : () => regenerate(options.filter((_, i) => i !== index))} />
                );
              })}
              {addingDim ? (
                <NewDimCard dims={options} onCancel={() => setAddingDim(false)}
                  onAdd={(dimName, values) => { regenerate([...options, { name: dimName, values }]); setAddingDim(false); }} />
              ) : options.length < MAX_DIMS ? (
                <button type="button" className="pe-addrow" onClick={() => setAddingDim(true)}>
                  <Plus size={15} />添加规格<small>如 款式、套餐、包装</small><small className="pe-addrow-r">还能加 {MAX_DIMS - options.length} 个</small>
                </button>
              ) : <p className="pe-hint">最多 {MAX_DIMS} 个规格</p>}
            </div>
            {skus.length ? (
              <div className="pe-table">
                <div className="pe-tr is-head" style={{ gridTemplateColumns: `repeat(${skuDims.length}, minmax(0, 1fr)) 110px 100px 140px` }}>
                  {skuDims.map((option) => <span key={option.name}>{option.name}</span>)}<span>价格（USD）</span><span>库存</span><span>商家编码</span>
                </div>
                <div className="pe-tr is-bulk" style={{ gridTemplateColumns: `repeat(${skuDims.length}, minmax(0, 1fr)) 110px 100px 140px` }}>
                  <span style={{ gridColumn: `span ${skuDims.length}` }}>批量设置 · 全部 {skus.length} 个规格</span>
                  <Input type="number" min={0} step={0.01} value={bulk.price} placeholder="价格" onChange={(event) => setBulk({ ...bulk, price: event.target.value })} />
                  <Input type="number" min={0} value={bulk.stock} placeholder="库存" onChange={(event) => setBulk({ ...bulk, stock: event.target.value })} />
                  <Button size="sm" variant="ghost" disabled={!bulk.price && !bulk.stock}
                    onClick={() => { patch({ skus: skus.map((sku) => ({ ...sku, ...(bulk.price ? { price: Number(bulk.price) } : {}), ...(bulk.stock ? { stock: Number(bulk.stock) } : {}) })) }); setBulk({ price: "", stock: "" }); }}>应用</Button>
                </div>
                {skus.map((sku, index) => (
                  <div key={index} className="pe-tr" style={{ gridTemplateColumns: `repeat(${skuDims.length}, minmax(0, 1fr)) 110px 100px 140px` }}>
                    {skuDims.map((option) => <span key={option.name}>{sku.values[option.name]}</span>)}
                    <Input type="number" min={0} step={0.01} value={sku.price} onChange={(event) => patch({ skus: skus.map((s, i) => (i === index ? { ...s, price: Number(event.target.value) } : s)) })} />
                    <Input type="number" min={0} className={sku.stock < 10 ? "is-low" : undefined} value={sku.stock} onChange={(event) => patch({ skus: skus.map((s, i) => (i === index ? { ...s, stock: Number(event.target.value) } : s)) })} />
                    <Input value={sku.code ?? ""} maxLength={40} placeholder="选填" onChange={(event) => patch({ skus: skus.map((s, i) => (i === index ? { ...s, code: event.target.value } : s)) })} />
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {sized ? (
            <section data-group="sizeChart" className="pe-sec">
              <h4>尺码表<span>{sizeDim ? `按勾选的${sizeDim.name}自动建好行，填数字就行` : "这个类目需要尺码表"}</span></h4>
              {chart ? (
                <div className="pe-table">
                  <div className="pe-tr is-head" style={{ gridTemplateColumns: `repeat(${chart.headers.length}, minmax(0, 1fr)) 32px` }}>
                    {chart.headers.map((header, col) => (
                      <Input key={col} value={header} maxLength={20} onChange={(event) => patch({ sizeChart: { ...chart, headers: chart.headers.map((h, i) => (i === col ? event.target.value : h)) } })} />
                    ))}
                    <span />
                  </div>
                  {chart.rows.map((row, rowIndex) => (
                    <div key={rowIndex} className="pe-tr" style={{ gridTemplateColumns: `repeat(${chart.headers.length}, minmax(0, 1fr)) 32px` }}>
                      {chart.headers.map((_, col) => (
                        <Input key={col} value={row[col] ?? ""} maxLength={20}
                          onChange={(event) => patch({ sizeChart: { ...chart, rows: chart.rows.map((r, i) => (i === rowIndex ? chart.headers.map((__, c) => (c === col ? event.target.value : r[c] ?? "")) : r)) } })} />
                      ))}
                      <button type="button" className="pe-del" onClick={() => patch({ sizeChart: { ...chart, rows: chart.rows.filter((_, i) => i !== rowIndex) } })}><Trash2 size={15} /></button>
                    </div>
                  ))}
                  <div className="pe-table-ops">
                    <Button variant="ghost" icon={Plus} onClick={() => patch({ sizeChart: { ...chart, rows: [...chart.rows, chart.headers.map(() => "")] } })}>加一行</Button>
                    <Button variant="ghost" icon={Plus} onClick={() => patch({ sizeChart: { headers: [...chart.headers, "新列"], rows: chart.rows.map((r) => [...r, ""]) } })}>加一列</Button>
                  </div>
                </div>
              ) : (
                <p className="pe-hint">先在“规格与库存”里勾选{sizeDim?.name ?? "尺码"}，这里自动建表。</p>
              )}
            </section>
          ) : null}

          <section data-group="copy" className="pe-sec">
            <h4>卖点与描述<HelpTip>学生端商品详情和买家 AI 都会看到。不要写 best、100%、guaranteed 这类绝对化用语</HelpTip></h4>
            <div className="pe-list">
              {[0, 1, 2, 3, 4].map((index) => (
                <div key={index} className="pe-bullet">
                  <i>{index + 1}</i>
                  <Input value={details.bullets?.[index] ?? ""} maxLength={300} placeholder={index === 0 ? "Soft breathable fabric: 95% polyester, 5% spandex" : ""}
                    onChange={(event) => { const next = [...(details.bullets ?? [])]; next[index] = event.target.value; patch({ bullets: next.map((b) => b ?? "") }); }} />
                </div>
              ))}
            </div>
            <Field label="描述"><Textarea rows={3} maxLength={2000} value={details.description ?? ""} onChange={(event) => patch({ description: event.target.value })} /></Field>
          </section>

          <section data-group="shipping" className="pe-sec">
            <h4>物流</h4>
            <div className="form-grid-2">
              <Field label="发货地"><Input value={shipping.shipsFrom ?? ""} maxLength={40} placeholder="中国深圳" onChange={(event) => patch({ shipping: { ...shipping, shipsFrom: event.target.value } })} /></Field>
              <Field label="备货期（工作日）"><Input type="number" min={0} value={shipping.handlingDays ?? ""} onChange={(event) => patch({ shipping: { ...shipping, handlingDays: event.target.value === "" ? undefined : Number(event.target.value) } })} /></Field>
            </div>
            <div className="pe-list">
              {(shipping.methods ?? []).map((method, index) => {
                const set = (key: "region" | "method" | "days" | "fee", value: string) =>
                  patch({ shipping: { ...shipping, methods: (shipping.methods ?? []).map((m, i) => (i === index ? { ...m, [key]: key === "fee" ? Number(value) : value } : m)) } });
                return (
                  <div key={index} className="pe-ship">
                    <Input value={method.region} placeholder="美国" onChange={(event) => set("region", event.target.value)} />
                    <Input value={method.method} placeholder="标准运输" onChange={(event) => set("method", event.target.value)} />
                    <Input value={method.days} placeholder="7–12 个工作日" onChange={(event) => set("days", event.target.value)} />
                    <Input type="number" min={0} step={0.01} value={method.fee} title="运费（美元），0 = 包邮" onChange={(event) => set("fee", event.target.value)} />
                    <button type="button" className="pe-del" onClick={() => patch({ shipping: { ...shipping, methods: (shipping.methods ?? []).filter((_, i) => i !== index) } })}><Trash2 size={15} /></button>
                  </div>
                );
              })}
              <Button variant="ghost" icon={Plus} onClick={() => patch({ shipping: { ...shipping, methods: [...(shipping.methods ?? []), { region: "", method: "标准运输", days: "", fee: 0 }] } })}>加一种运输方式</Button>
            </div>
          </section>

          <section data-group="afterSale" className="pe-sec">
            <h4>售后与常见问题</h4>
            <Field label="退换政策"><Textarea rows={2} maxLength={400} value={afterSale.returnPolicy ?? ""} placeholder="签收后 30 天内可退换，商品需未使用、吊牌完整；质量问题退回运费由店铺承担" onChange={(event) => patch({ afterSale: { ...afterSale, returnPolicy: event.target.value } })} /></Field>
            <Field label="保修"><Input value={afterSale.warranty ?? ""} maxLength={120} placeholder="12 个月" onChange={(event) => patch({ afterSale: { ...afterSale, warranty: event.target.value } })} /></Field>
            <div className="pe-list">
              {(details.faq ?? []).map((item, index) => (
                <div key={index} className="pe-faq">
                  <Input value={item.q} maxLength={150} placeholder="问：尺码偏大还是偏小？" onChange={(event) => patch({ faq: (details.faq ?? []).map((f, i) => (i === index ? { ...f, q: event.target.value } : f)) })} />
                  <Input value={item.a} maxLength={400} placeholder="答：尺码标准，介于两个尺码之间建议选大一码" onChange={(event) => patch({ faq: (details.faq ?? []).map((f, i) => (i === index ? { ...f, a: event.target.value } : f)) })} />
                  <button type="button" className="pe-del" onClick={() => patch({ faq: (details.faq ?? []).filter((_, i) => i !== index) })}><Trash2 size={15} /></button>
                </div>
              ))}
              <Button variant="ghost" icon={Plus} onClick={() => patch({ faq: [...(details.faq ?? []), { q: "", a: "" }] })}>加一条常见问题</Button>
            </div>
          </section>
        </div>
      </div>
      {picking ? <CategoryPicker value={category || null} recent={recent} onClose={() => setPicking(false)} onPick={pickCategory} /> : null}
      {switching ? (
        <Confirm title="更换类目" confirmText="更换" onConfirm={() => applyCategory(switching)} onClose={() => setSwitching(null)}>
          换成「{switching.split(CATEGORY_SEP).join(" › ")}」后，类目属性、规格和尺码表要按新类目重新填，已经填的会清空。
        </Confirm>
      ) : null}
    </Drawer>
  );
}
