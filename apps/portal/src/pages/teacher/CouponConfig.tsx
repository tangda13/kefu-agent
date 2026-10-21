import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  COUPON_KIND_LABELS, CUSTOMER_TYPES, couponFace, couponRuleText, couponScopeText,
  type CouponKind,
} from "@cecs/contracts";
import { ApiError, apiPost, apiRequestDelete, apiRequestPatch, type Session, type StoreCoupon, type StoreProduct } from "../../api/client";
import { Bench, Board, Button, ChipSelect, Confirm, Dialog, FilterChips, HelpTip, Input, MoreMenu, SearchBox, Segmented, Switch, Toolbar, toast } from "../../ui";

/**
 * 店铺优惠券（D-66，设计稿 docs/design/p17-params-teacher 第九节）：参照速卖通、Shopee 的店铺优惠券和千牛的客服发券。
 * 左边票面是买家看到的面额和门槛；开关控制学生工作台能不能发。已经发出去的券卡片是快照，改券、删券不影响
 */

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");

export function CouponTab({ session, coupons, products, loading, reload }: {
  session: Session; coupons: StoreCoupon[]; products: StoreProduct[]; loading: boolean; reload: () => Promise<void>;
}) {
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const [editing, setEditing] = useState<StoreCoupon | "new" | null>(null);
  const [removing, setRemoving] = useState<StoreCoupon | null>(null);
  const word = keyword.trim().toLowerCase();
  const shown = coupons.filter((item) => (filter === "all" || (filter === "on") === item.enabled) && (!word || item.title.toLowerCase().includes(word)));

  async function toggle(item: StoreCoupon, enabled: boolean) {
    try {
      await apiRequestPatch(`/v1/store/coupons/${item.id}`, session, { enabled });
      toast.ok(enabled ? "已启用，学生工作台可以发" : "已停用，学生工作台不再显示");
      await reload();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    <Bench>
      <Toolbar actions={<Button variant="primary" icon={Plus} onClick={() => setEditing("new")}>新建优惠券</Button>}>
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索优惠券" />
        <FilterChips
          items={[
            { id: "all" as const, label: "全部", count: coupons.length },
            { id: "on" as const, label: "启用", count: coupons.filter((item) => item.enabled).length },
            { id: "off" as const, label: "已停用", count: coupons.filter((item) => !item.enabled).length },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </Toolbar>
      {loading ? <Board><p className="board-quiet">正在读取…</p></Board> : shown.length === 0 ? (
        <Board><p className="board-quiet">{coupons.length ? "没有符合条件的优惠券" : "还没有优惠券。新建一张，学生接待时就能发给买家"}</p></Board>
      ) : (
        <div className="cpn-list">
          {shown.map((item) => (
            <article key={item.id} className={item.enabled ? "cpn" : "cpn is-off"} role="button" tabIndex={0}
              onClick={() => setEditing(item)} onKeyDown={(event) => { if (event.key === "Enter") setEditing(item); }}>
              <div className="cpn-face"><b>{item.face.value}</b><small>{item.face.gate}</small></div>
              <div className="cpn-body">
                <div className="cpn-top">
                  <b>{item.title}</b>
                  <span className="cpn-ops" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <Switch checked={item.enabled} label={`启用 ${item.title}`} onChange={(next) => void toggle(item, next)} />
                    <MoreMenu items={[{ label: "编辑", onClick: () => setEditing(item) }, { label: "删除", danger: true, separated: true, onClick: () => setRemoving(item) }]} />
                  </span>
                </div>
                <p>{item.rule}</p>
                <div className="cpn-meta">
                  <span>{item.productIds.length ? `指定 ${item.productIds.length} 个商品` : "全店商品"}</span>
                  <span>领取后 {item.validDays} 天</span>
                  <span className="is-cust">{item.customerTypes.length ? item.customerTypes.join("、") : "不限客户"}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing ? <CouponEditor session={session} coupon={editing === "new" ? null : editing} products={products} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} /> : null}
      {removing ? (
        <Confirm title="删除优惠券" danger confirmText="删除"
          onConfirm={() => void apiRequestDelete(`/v1/store/coupons/${removing.id}`, session).then(() => { toast.ok("已删除"); setRemoving(null); return reload(); }).catch((cause) => toast.error(errorText(cause)))}
          onClose={() => setRemoving(null)}>
          删除「{removing.title}」？已经发给买家的券卡片照原样显示。只是暂时不发的话，关掉开关就行。
        </Confirm>
      ) : null}
    </Bench>
  );
}

function CouponEditor({ session, coupon, products, onClose, onSaved }: {
  session: Session; coupon: StoreCoupon | null; products: StoreProduct[]; onClose: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState(coupon?.title ?? "");
  const [kind, setKind] = useState<CouponKind>(coupon?.kind ?? "amount");
  const [amount, setAmount] = useState(coupon && coupon.kind !== "shipping" ? String(coupon.amount) : "");
  const [gated, setGated] = useState<"none" | "gate">(coupon && coupon.threshold > 0 ? "gate" : "none");
  const [threshold, setThreshold] = useState(coupon && coupon.threshold > 0 ? String(coupon.threshold) : "");
  const [scope, setScope] = useState<"all" | "some">(coupon?.productIds.length ? "some" : "all");
  const [productIds, setProductIds] = useState<string[]>(coupon?.productIds ?? []);
  const [customerTypes, setCustomerTypes] = useState<string[]>(coupon?.customerTypes ?? []);
  const [validDays, setValidDays] = useState(String(coupon?.validDays ?? 7));
  const [busy, setBusy] = useState(false);

  const fields = useMemo(() => ({
    kind,
    amount: kind === "shipping" ? 0 : Number(amount) || 0,
    threshold: gated === "gate" ? Number(threshold) || 0 : 0,
    productIds: scope === "some" ? productIds : [],
    customerTypes,
  }), [kind, amount, gated, threshold, scope, productIds, customerTypes]);

  async function save() {
    if (!title.trim()) return toast.error("名称要填，买家看到的，用英文");
    if (scope === "some" && !productIds.length) return toast.error("选了指定商品，至少挑一个");
    setBusy(true);
    const body = { title: title.trim(), ...fields, validDays: Number(validDays) };
    try {
      if (coupon) await apiRequestPatch(`/v1/store/coupons/${coupon.id}`, session, body);
      else await apiPost("/v1/store/coupons", session, body);
      toast.ok(coupon ? "已保存" : "已新建并启用");
      onSaved();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const toggleType = (type: string) => setCustomerTypes(customerTypes.includes(type) ? customerTypes.filter((item) => item !== type) : [...customerTypes, type]);

  return (
    <Dialog
      title={coupon ? "编辑优惠券" : "新建优惠券"}
      width={760}
      onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{coupon ? "保存" : "保存并启用"}</Button></>}
    >
      <div className="cpn-form">
        <span className="cpn-label">名称<HelpTip>买家看到的名字，用英文</HelpTip></span>
        <span><Input className="cpn-title" value={title} maxLength={60} placeholder="Loyal Buyer $8 Off" onChange={(event) => setTitle(event.target.value)} /></span>

        <span className="cpn-label">类型</span>
        <span><Segmented items={(Object.keys(COUPON_KIND_LABELS) as CouponKind[]).map((id) => ({ id, label: COUPON_KIND_LABELS[id] }))} value={kind} onChange={setKind} /></span>

        {kind !== "shipping" ? (
          <>
            <span className="cpn-label">面额</span>
            <span className="cpn-inline">
              减<Input className="cpn-num" type="number" min={kind === "amount" ? 0.01 : 1} max={kind === "amount" ? 1000 : 90} step={kind === "amount" ? 0.01 : 1} value={amount} onChange={(event) => setAmount(event.target.value)} />
              {kind === "amount" ? "美元" : <>%<small>{Number(amount) > 0 ? `即 ${couponFace({ kind, amount: Number(amount), threshold: 0 }).value}` : "10 即 9 折"}</small></>}
            </span>
          </>
        ) : null}

        <span className="cpn-label">使用门槛</span>
        <span className="cpn-inline">
          <Segmented items={[{ id: "none" as const, label: "无门槛" }, { id: "gate" as const, label: "满额可用" }]} value={gated} onChange={setGated} />
          {gated === "gate" ? <>满<Input className="cpn-num" type="number" min={0} step={0.01} value={threshold} onChange={(event) => setThreshold(event.target.value)} />美元</> : null}
        </span>

        <span className="cpn-label is-top">适用商品</span>
        <span className="cpn-stack">
          <Segmented items={[{ id: "all" as const, label: "全店商品" }, { id: "some" as const, label: "指定商品" }]} value={scope} onChange={setScope} />
          {scope === "some" ? <ChipSelect options={products.map((item) => ({ id: item.id, label: item.name }))} value={productIds} onChange={setProductIds} empty="店里还没有商品" /> : null}
        </span>

        <span className="cpn-label is-top">适用客户</span>
        <span className="opt-chips">
          <button type="button" className={customerTypes.length ? "opt-chip" : "opt-chip is-on"} onClick={() => setCustomerTypes([])}>不限</button>
          {CUSTOMER_TYPES.map((type) => (
            <button key={type} type="button" className={customerTypes.includes(type) ? "opt-chip is-on" : "opt-chip"} onClick={() => toggleType(type)}>{type}</button>
          ))}
        </span>

        <span className="cpn-label">有效期</span>
        <span className="cpn-inline">领取后<Input className="cpn-num" type="number" min={1} max={365} value={validDays} onChange={(event) => setValidDays(event.target.value)} />天</span>

        <p className="cpn-preview">买家收到的卡片：<b>{title.trim() || "（名称）"}</b> · {couponRuleText(fields)} · {couponScopeText(fields)} · {validDays || "?"} 天内有效</p>
      </div>
    </Dialog>
  );
}
