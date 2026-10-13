import { Copy, MapPin, NotebookPen, Package2, Search, Send, Truck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { assetUrl, updateOrder, type ConversationOrder, type OrderAddress, type Session } from "../../../api/client";
import { Button, Select } from "../../../ui";
import { ORDER_FILTERS, RETURN_LABELS, dateTimeLabel, errorMessage, orderBadgeLabel, orderFilterKey } from "./shared";

/* 右栏「订单」页签：筛选、搜索、发送订单卡、详情、备注、改地址 */

const EMPTY_ADDRESS: OrderAddress = { recipient: "", line1: "", city: "", country: "", phone: "" };

export function OrdersTab({ session, conversationId, buyerName, orders, setOrders, canSend, onSend, onError }: {
  session: Session;
  conversationId: string;
  buyerName: string;
  orders: ConversationOrder[] | null;
  setOrders: React.Dispatch<React.SetStateAction<ConversationOrder[] | null>>;
  canSend: boolean;
  onSend: (order: ConversationOrder) => void;
  onError: (message: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [action, setAction] = useState<{ id: string; type: "remark" | "address" } | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");
  const [addressDraft, setAddressDraft] = useState<OrderAddress>(EMPTY_ADDRESS);
  const [saving, setSaving] = useState(false);

  // 换会话重置筛选
  useEffect(() => {
    setFilter("all");
    setSearch("");
    setExpanded(null);
    setAction(null);
  }, [conversationId]);

  const visible = useMemo(() => {
    let list = orders ?? [];
    if (filter !== "all") list = list.filter((item) => orderFilterKey(item.detail) === filter);
    const query = search.trim().toLowerCase();
    if (query) list = list.filter((item) => item.detail.orderNo.toLowerCase().includes(query));
    return list;
  }, [orders, filter, search]);

  const openAction = (order: ConversationOrder, type: "remark" | "address") => {
    setAction({ id: order.id, type });
    if (type === "remark") setRemarkDraft(order.detail.remark ?? "");
    else setAddressDraft(order.detail.address ?? { ...EMPTY_ADDRESS, recipient: buyerName });
  };

  const save = async () => {
    if (!action) return;
    setSaving(true);
    try {
      const patch = action.type === "remark" ? { remark: remarkDraft } : { address: addressDraft };
      const { detail } = await updateOrder(session, action.id, patch);
      setOrders((current) => (current ?? []).map((item) => (item.id === action.id ? { ...item, detail } : item)));
      setAction(null);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wbk-orders">
      <div className="wbk-toolbar">
        <Select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="订单状态筛选">
          {ORDER_FILTERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Select>
        <label className="wbk-search is-small">
          <Search size={14} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索订单号" aria-label="搜索订单" />
        </label>
      </div>
      {visible.map((order) => {
        const detail = order.detail;
        const open = expanded === order.id;
        const form = action?.id === order.id ? action : null;
        const dim = detail.status === "completed" && !order.isPrimary;
        return (
          <article key={order.id} className={dim ? "wbk-oc is-dim" : "wbk-oc"}>
            <div className="wbk-oc-h">
              <b className="num">{detail.orderNo}</b>
              <button type="button" className="wbk-copy" title="复制订单号" aria-label="复制订单号" onClick={() => void navigator.clipboard?.writeText(detail.orderNo).catch(() => undefined)}><Copy size={13} /></button>

              <span className="wbk-oc-badges">
                {order.isPrimary ? <span className="wbk-tag is-brand">本次咨询</span> : null}
                <span className="wbk-tag">{orderBadgeLabel(detail)}</span>
              </span>
            </div>
            <div className="wbk-oc-it">
              {detail.productImage ? <img src={assetUrl(detail.productImage) ?? undefined} alt={detail.productName} /> : <span className="wbk-card-thumb"><Package2 size={20} /></span>}
              <div>
                <b>{detail.productName}</b>
                <span>{detail.productSpec} × {detail.quantity}</span>
              </div>
              <b className="num">{detail.currency === "USD" ? "$" : `${detail.currency} `}{detail.totalAmount}</b>
            </div>
            {detail.logistics ? (
              <div className="wbk-oc-lg">
                <Truck size={14} />
                <div>
                  {detail.logistics.carrier} · <span className="num">{detail.logistics.trackingNo}</span>
                  <br />
                  <span>{detail.logistics.nodes.find((node) => node.current)?.label ?? detail.statusLabel}</span>
                </div>
              </div>
            ) : null}
            {detail.returnStatus ? <div className="wbk-oc-lg"><span className="wbk-oc-lg-t">退货/退款</span><div>{RETURN_LABELS[detail.returnStatus] ?? detail.returnStatus}</div></div> : null}
            {detail.remark ? <div className="wbk-oc-lg"><NotebookPen size={14} /><div>备注：{detail.remark}</div></div> : null}
            <div className="wbk-oc-ft">
              <Button size="sm" icon={Send} disabled={!canSend} onClick={() => onSend(order)}>发送订单</Button>
              <Button size="sm" variant="ghost" onClick={() => setExpanded(open ? null : order.id)}>{open ? "收起" : "详情"}</Button>
              <Button size="sm" variant="ghost" onClick={() => openAction(order, "remark")}>备注</Button>
              <Button size="sm" variant="ghost" icon={MapPin} onClick={() => openAction(order, "address")}>改地址</Button>
            </div>
            {open ? (
              <dl className="wbk-oc-detail">
                <dt>下单时间</dt><dd>{dateTimeLabel(detail.placedAt)}</dd>
                <dt>单价</dt><dd className="num">{detail.currency} {detail.unitPrice}</dd>
                {detail.address ? <><dt>收件人</dt><dd>{detail.address.recipient}</dd><dt>地址</dt><dd>{detail.address.line1}, {detail.address.city}, {detail.address.country}</dd><dt>电话</dt><dd className="num">{detail.address.phone}</dd></> : null}
                {detail.logistics ? (
                  <>
                    <dt>物流节点</dt>
                    <dd className="wbk-nodes">
                      {detail.logistics.nodes.map((node) => <span key={node.key} className={node.current ? "is-cur" : node.done ? "is-done" : ""}>{node.label}</span>)}
                    </dd>
                  </>
                ) : null}
                {detail.review ? <><dt>买家评价</dt><dd>{detail.review.rating} 星 · {detail.review.content}</dd></> : null}
              </dl>
            ) : null}
            {form?.type === "remark" ? (
              <div className="wbk-form">
                <textarea value={remarkDraft} onChange={(event) => setRemarkDraft(event.target.value)} rows={2} placeholder="给这笔订单添加内部备注…" aria-label="订单备注" />
                <div><Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>保存备注</Button><Button size="sm" variant="ghost" onClick={() => setAction(null)}>取消</Button></div>
              </div>
            ) : null}
            {form?.type === "address" ? (
              <div className="wbk-form">
                <input value={addressDraft.recipient} onChange={(event) => setAddressDraft({ ...addressDraft, recipient: event.target.value })} placeholder="收件人" aria-label="收件人" />
                <input value={addressDraft.line1} onChange={(event) => setAddressDraft({ ...addressDraft, line1: event.target.value })} placeholder="街道地址" aria-label="街道地址" />
                <div className="wbk-form-row">
                  <input value={addressDraft.city} onChange={(event) => setAddressDraft({ ...addressDraft, city: event.target.value })} placeholder="城市" aria-label="城市" />
                  <input value={addressDraft.country} onChange={(event) => setAddressDraft({ ...addressDraft, country: event.target.value })} placeholder="国家" aria-label="国家" />
                </div>
                <input value={addressDraft.phone} onChange={(event) => setAddressDraft({ ...addressDraft, phone: event.target.value })} placeholder="联系电话" aria-label="联系电话" />
                <div><Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>保存地址</Button><Button size="sm" variant="ghost" onClick={() => setAction(null)}>取消</Button></div>
              </div>
            ) : null}
          </article>
        );
      })}
      {orders === null ? <p className="wbk-empty">加载订单…</p> : null}
      {orders !== null && visible.length === 0 ? <p className="wbk-empty">{orders.length === 0 ? "这位客户还没有订单。" : "没有符合条件的订单。"}</p> : null}
    </div>
  );
}
