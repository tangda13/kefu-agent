import { Package2 } from "lucide-react";
import { useState } from "react";
import { assetUrl, type StoreProduct } from "../../../api/client";
import { Button, Segmented } from "../../../ui";

/* 右栏「商品」页签：全店商品 / 买家看过；发送、邀请下单、详情抽屉、规格属性、算价 */

export function ProductsTab({ products, browsed, canSend, canFill, onSend, onFill, onDetail }: {
  products: StoreProduct[];
  browsed: StoreProduct[];
  canSend: boolean;
  canFill: boolean;
  onSend: (type: "product" | "invite", productId: string) => void;
  onFill: (text: string) => void;
  onDetail: (product: StoreProduct) => void;
}) {
  const [tab, setTab] = useState<"store" | "browsed">("store");
  const [specOpen, setSpecOpen] = useState<string | null>(null);
  const [calcOpen, setCalcOpen] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const list = tab === "store" ? products : browsed;

  return (
    <div className="wbk-products">
      <Segmented
        className="wbk-seg"
        value={tab}
        onChange={setTab}
        items={[
          { id: "store", label: "全店商品" },
          { id: "browsed", label: "买家看过", count: browsed.length || undefined },
        ]}
      />
      {list.map((product) => {
        const specParts = product.spec.split("/").map((part) => part.trim()).filter(Boolean);
        const specText = `${product.name} — SKU ${product.id} · ${product.spec} · USD ${product.price} · In stock: ${product.stock}`;
        const quoteText = `${product.name}: ${qty} × USD ${product.price} = USD ${(product.price * qty).toFixed(2)}`;
        const image = product.images?.[0] ?? product.imageUrl;
        return (
          <article key={product.id} className="wbk-pc">
            {image ? <img src={assetUrl(image) ?? undefined} alt={product.name} /> : <span className="wbk-card-thumb is-lg" style={{ background: product.tone }}><Package2 size={22} /></span>}
            <div className="wbk-pc-main">
              <b>{product.name}</b>
              <div className="wbk-pc-p num">USD {product.price}</div>
              <div className="wbk-pc-m">已售 {product.sales} · 库存 {product.stock}</div>
              {/* 操作一行平铺：详情、发送、邀请下单、规格、算价 */}
              <div className="wbk-pc-ac is-row">
                <button type="button" onClick={() => onDetail(product)}>详情</button>
                <button type="button" disabled={!canSend} onClick={() => onSend("product", product.id)}>发送</button>
                <button type="button" disabled={!canSend} onClick={() => onSend("invite", product.id)}>邀请下单</button>
                <button type="button" className={specOpen === product.id ? "is-on" : ""} onClick={() => { setSpecOpen(specOpen === product.id ? null : product.id); setCalcOpen(null); }}>规格</button>
                <button type="button" className={calcOpen === product.id ? "is-on" : ""} onClick={() => { setCalcOpen(calcOpen === product.id ? null : product.id); setSpecOpen(null); setQty(1); }}>算价</button>
              </div>
            </div>
            {specOpen === product.id ? (
              <div className="wbk-pc-expand">
                <dl className="wbk-kv">
                  <dt>SKU 编码</dt><dd className="num">{product.id}</dd>
                  {specParts.map((part, index) => (<span key={part} style={{ display: "contents" }}><dt>规格 {index + 1}</dt><dd>{part}</dd></span>))}
                  <dt>单价</dt><dd className="num">USD {product.price}</dd>
                  <dt>库存 / 已售</dt><dd className="num">{product.stock} / {product.sales}</dd>
                </dl>
                <Button size="sm" disabled={!canFill} onClick={() => { onFill(specText); setSpecOpen(null); }}>填入规格信息</Button>
              </div>
            ) : null}
            {calcOpen === product.id ? (
              <div className="wbk-pc-expand wbk-calc">
                <label>数量<input type="number" min={1} max={999} value={qty} onChange={(event) => setQty(Math.max(1, Math.min(999, Number(event.target.value) || 1)))} aria-label="数量" /></label>
                <span>合计 <strong className="num">USD {(product.price * qty).toFixed(2)}</strong></span>
                <Button size="sm" disabled={!canFill} onClick={() => { onFill(quoteText); setCalcOpen(null); }}>填入报价</Button>
              </div>
            ) : null}
          </article>
        );
      })}
      {list.length === 0 ? <p className="wbk-empty">{tab === "browsed" ? "这位买家还没有看过商品。" : "店里还没有上架商品。"}</p> : null}
    </div>
  );
}
