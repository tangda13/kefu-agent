import { CornerDownLeft, Send, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";
import { assetUrl, type StoreProduct } from "../../../api/client";
import { Button, Drawer, Tag, toast } from "../../../ui";

/* 商品详情抽屉（D-32）：主图 + 缩略图、价格、款式、卖点、参数、物流、售后、常见问题。
   每条参数 / 问答右上角“引用”：把这句填进输入框。 */

function Quote({ onClick, hidden }: { onClick: () => void; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <button type="button" className="wbk-pd-use" onClick={onClick} title="把这句填进输入框">
      <CornerDownLeft size={13} />引用
    </button>
  );
}

export function ProductDrawer({ product, canSend, canFill, onClose, onQuote, onSend, browseOnly }: {
  product: StoreProduct;
  canSend: boolean;
  canFill: boolean;
  onClose: () => void;
  onQuote: (text: string) => void;
  onSend: (type: "product" | "invite") => void;
  /** 只看资料（侧栏店铺弹窗里打开）：不显示“引用”和发送按钮 */
  browseOnly?: boolean;
}) {
  const details = product.details ?? {};
  const images = useMemo(() => {
    const list = product.images?.length ? product.images : product.imageUrl ? [product.imageUrl] : [];
    return list.map((url) => assetUrl(url) ?? url);
  }, [product]);
  const [shown, setShown] = useState(0);
  const options = details.options ?? [];
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(options.map((option) => [option.name, option.values[0] ?? ""])));

  // 选中的款式能对上某个 SKU 时，价格 / 库存跟着变
  const sku = (details.skus ?? []).find((item) => options.every((option) => item.values[option.name] === picked[option.name]));
  const price = sku?.price ?? product.price;
  const stock = sku?.stock ?? product.stock;

  const quote = (text: string) => {
    if (!canFill) {
      toast.error("这场接待已经结束，不能再填入。");
      return;
    }
    onQuote(text);
    toast.ok("已填入输入框");
  };

  const specs = (details.specs ?? []).filter((row) => row.name.trim() && row.value.trim());
  const methods = details.shipping?.methods ?? [];
  const faq = details.faq ?? [];
  const after = details.afterSale;

  return (
    <Drawer
      width={720}
      onClose={onClose}
      title={<span className="wbk-pd-title">商品详情{product.category ? <Tag>{product.category}</Tag> : null}</span>}
      footer={browseOnly ? undefined : (
        <div className="wbk-pd-foot">
          <div>
            <Button icon={Send} disabled={!canSend} onClick={() => onSend("product")}>发送商品</Button>
            <Button variant="primary" icon={ShoppingCart} disabled={!canSend} onClick={() => onSend("invite")}>邀请下单</Button>
          </div>
        </div>
      )}
    >
      <div className="wbk-pd">
        <div className="wbk-pd-hero">
          <div className="wbk-pd-gal">
            {images[shown] ? <img className="is-main" src={images[shown]} alt={product.name} /> : <span className="wbk-pd-noimg" style={{ background: product.tone }} />}
            {images.length > 1 ? (
              <div className="wbk-pd-thumbs">
                {images.map((url, index) => (
                  <button key={url + index} type="button" className={index === shown ? "is-on" : ""} onClick={() => setShown(index)} aria-label={`第 ${index + 1} 张图`}>
                    <img src={url} alt="" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div>
            <h4>{product.name}</h4>
            <div className="wbk-pd-price num">${price}<small>已售 {product.sales} · 库存 {stock}</small></div>
            {options.length > 0 ? (
              <div className="wbk-pd-skus">
                {options.map((option) => (
                  <div key={option.name} className="r">
                    <span>{option.name}</span>
                    {option.values.map((value) => (
                      <button key={value} type="button" className={picked[option.name] === value ? "o on" : "o"} onClick={() => setPicked((current) => ({ ...current, [option.name]: value }))}>{value}</button>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="wbk-pd-spec1">{product.spec}</p>
            )}
            {(details.bullets ?? []).length > 0 ? (
              <ul className="wbk-pd-bul">
                {(details.bullets ?? []).map((line) => <li key={line}>{line}</li>)}
              </ul>
            ) : null}
          </div>
        </div>

        {specs.length > 0 ? (
          <section>
            <h5>规格参数<span>{specs.length} 项</span></h5>
            <dl className="wbk-pd-spec">
              {specs.map((row) => (
                <div key={row.name}>
                  <dt>{row.name}</dt>
                  <dd>{row.value}</dd>
                  <Quote hidden={browseOnly} onClick={() => quote(`${row.name}: ${row.value}`)} />
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {details.sizeChart && details.sizeChart.rows.length > 0 ? (
          <section>
            <h5>尺码表</h5>
            <table className="wbk-pd-table">
              <thead><tr>{details.sizeChart.headers.map((head) => <th key={head}>{head}</th>)}</tr></thead>
              <tbody>{details.sizeChart.rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </section>
        ) : null}

        {details.shipping && (methods.length > 0 || details.shipping.shipsFrom) ? (
          <section>
            <h5>
              物流时效
              <span>{[details.shipping.shipsFrom ? `${details.shipping.shipsFrom}发货` : "", details.shipping.handlingDays ? `${details.shipping.handlingDays} 个工作日内出库` : ""].filter(Boolean).join(" · ")}</span>
            </h5>
            {methods.length > 0 ? (
              <table className="wbk-pd-table">
                <thead><tr><th>地区</th><th>方式</th><th>时效</th><th>运费</th></tr></thead>
                <tbody>
                  {methods.map((item, index) => (
                    <tr key={index}><td>{item.region}</td><td>{item.method}</td><td>{item.days}</td><td className="num">{item.fee === 0 ? "免运费" : `$${item.fee}`}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>
        ) : null}

        {after && (after.returnPolicy || after.warranty) ? (
          <section>
            <h5>售后</h5>
            <div className="wbk-pd-after">
              {after.returnPolicy ? <div><b>退换货</b>{after.returnPolicy}<Quote hidden={browseOnly} onClick={() => quote(after.returnPolicy!)} /></div> : null}
              {after.warranty ? <div><b>保修</b>{after.warranty}<Quote hidden={browseOnly} onClick={() => quote(after.warranty!)} /></div> : null}
            </div>
          </section>
        ) : null}

        {faq.length > 0 ? (
          <section>
            <h5>常见问题<span>{faq.length}</span></h5>
            <div className="wbk-pd-faq">
              {faq.map((item) => (
                <div key={item.q}>
                  <b>{item.q}</b>
                  <span>{item.a}</span>
                  <Quote hidden={browseOnly} onClick={() => quote(item.a)} />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {specs.length === 0 && faq.length === 0 && !after && methods.length === 0 ? (
          <p className="wbk-empty">这件商品的详细资料还没有补全，可以先看规格属性。</p>
        ) : null}
      </div>
    </Drawer>
  );
}
