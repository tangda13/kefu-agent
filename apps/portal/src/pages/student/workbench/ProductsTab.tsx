import { Package2 } from "lucide-react";
import { useState } from "react";
import { assetUrl, type StoreProduct } from "../../../api/client";
import { Segmented } from "../../../ui";

/* 右栏「商品」页签：全店商品 / 买家看过；详情抽屉、发送、邀请下单。
   规格、算价已去掉（D-73）：规格、价格、库存都在详情里，要哪句点“引用”填进输入框 */

export function ProductsTab({ products, browsed, canSend, onSend, onDetail }: {
  products: StoreProduct[];
  browsed: StoreProduct[];
  canSend: boolean;
  onSend: (type: "product" | "invite", productId: string) => void;
  onDetail: (product: StoreProduct) => void;
}) {
  const [tab, setTab] = useState<"store" | "browsed">("store");
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
        const image = product.images?.[0] ?? product.imageUrl;
        return (
          <article key={product.id} className="wbk-pc">
            {image ? <img src={assetUrl(image) ?? undefined} alt={product.name} /> : <span className="wbk-card-thumb is-lg" style={{ background: product.tone }}><Package2 size={22} /></span>}
            <div className="wbk-pc-main">
              <b>{product.name}</b>
              <div className="wbk-pc-p num">USD {Number(product.price).toFixed(2)}</div>
              <div className="wbk-pc-m">已售 {product.sales} · 库存 {product.stock}</div>
              <div className="wbk-pc-ac is-row">
                <button type="button" onClick={() => onDetail(product)}>详情</button>
                <button type="button" disabled={!canSend} onClick={() => onSend("product", product.id)}>发送</button>
                <button type="button" disabled={!canSend} onClick={() => onSend("invite", product.id)}>邀请下单</button>
              </div>
            </div>
          </article>
        );
      })}
      {list.length === 0 ? <p className="wbk-empty">{tab === "browsed" ? "这位买家还没有看过商品。" : "店里还没有上架商品。"}</p> : null}
    </div>
  );
}
