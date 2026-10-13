import { Mail, Package2, Search, Truck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  assetUrl,
  fetchStoreProducts,
  fetchStoreProfile,
  type Session,
  type StoreProduct,
  type StoreProfile,
} from "../api/client";
import { Dialog, Tag } from "../ui";
import { ProductDrawer } from "../pages/student/workbench/ProductDrawer";
import "../styles/student-workbench.css";
import "../styles/student-store.css";

/** 侧栏点“店铺后台 · 店名”：查看店铺基本信息和在售商品（学生端，只读） */
export function StoreDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [store, setStore] = useState<StoreProfile | null>(null);
  const [products, setProducts] = useState<StoreProduct[] | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [viewing, setViewing] = useState<StoreProduct | null>(null);

  useEffect(() => {
    fetchStoreProfile(session).then(setStore).catch(() => undefined);
    fetchStoreProducts(session).then(setProducts).catch(() => setProducts([]));
  }, [session]);

  const list = products ?? [];
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of list) if (item.category) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);
  /** 发货地：取商品里最常见的一个 */
  const shipsFrom = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of list) {
      const from = item.details?.shipping?.shipsFrom;
      if (from) counts.set(from, (counts.get(from) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [list]);
  const totalSales = list.reduce((sum, item) => sum + (item.sales || 0), 0);
  const shown = list.filter((item) => {
    if (category && item.category !== category) return false;
    const keyword = query.trim().toLowerCase();
    return !keyword || item.name.toLowerCase().includes(keyword) || item.spec.toLowerCase().includes(keyword);
  });
  const name = store?.name ?? "";

  return (
    <>
      <Dialog title="店铺资料" width={1000} onClose={onClose}>
        <div className="sd">
          <div className="sd-head">
            <span className="sd-logo">{store?.logoUrl ? <img src={store.logoUrl} alt="" /> : name.trim()[0]?.toUpperCase() ?? ""}</span>
            <div>
              <h3>{name}{store ? <Tag>{store.market} · {store.currency}</Tag> : null}</h3>
              <div className="sd-meta">
                {store ? <span><Mail size={14} />{store.supportEmail}</span> : null}
                {shipsFrom ? <span><Truck size={14} />{shipsFrom}发货</span> : null}
              </div>
            </div>
            <dl className="sd-figs">
              <div><dt>在售商品</dt><dd className="num">{products ? list.length : "—"}</dd></div>
              <div><dt>累计销量</dt><dd className="num">{products ? totalSales.toLocaleString("en-US") : "—"}</dd></div>
            </dl>
          </div>

          <div className="sd-tool">
            <label className="sx-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品" aria-label="搜索商品" />
            </label>
            <div className="sd-chips">
              <button type="button" className={category === null ? "is-on" : undefined} onClick={() => setCategory(null)}>全部 <i>{list.length}</i></button>
              {categories.map(([key, n]) => (
                <button key={key} type="button" className={category === key ? "is-on" : undefined} onClick={() => setCategory(key)}>{key} <i>{n}</i></button>
              ))}
            </div>
          </div>

          <div className="sd-grid">
            {shown.map((item) => {
              const image = item.images?.[0] ?? item.imageUrl ?? null;
              return (
                <button key={item.id} type="button" className="sd-card" onClick={() => setViewing(item)}>
                  {image ? <img src={assetUrl(image) ?? image} alt="" /> : <span className="sd-blank"><Package2 size={28} /></span>}
                  <span className="sd-bd">
                    <b>{item.name}</b>
                    <small>{item.spec}</small>
                    <span className="sd-row"><span className="sd-price num">${item.price.toFixed(2)}</span><small>已售 {item.sales.toLocaleString("en-US")}</small></span>
                  </span>
                </button>
              );
            })}
            {products && shown.length === 0 ? <p className="sd-empty">没有符合条件的商品</p> : null}
          </div>
        </div>
      </Dialog>
      {viewing ? (
        <ProductDrawer
          product={viewing}
          canSend={false}
          canFill={false}
          browseOnly
          onClose={() => setViewing(null)}
          onQuote={() => undefined}
          onSend={() => undefined}
        />
      ) : null}
    </>
  );
}
