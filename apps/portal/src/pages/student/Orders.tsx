import { Bot, Box, ChevronRight, CircleCheck, Clock3, Headphones, MapPin, MessageSquareText, PackageCheck, Send, Sparkles, Star, Truck } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../../components/AppShell";
import { buyers, logisticsTimeline, orderTimeline } from "../../data/demo";

const tabs = ["订单详情", "物流", "评价"] as const;
const suggestions = {
  "订单详情": [
    "Hi Jessica, your order is reserved and ready for payment. Please let me know if you need any help completing it.",
    "Hello Jessica, a quick reminder that order #AMZ-20581 is awaiting payment. I’m here if you have any questions.",
    "Your items are currently reserved. You can complete the payment when convenient, and I’ll follow the next step for you.",
  ],
  "物流": [
    "Your parcel has left the international transit center and is moving to the destination country. I’ll keep you updated.",
    "The latest tracking shows the shipment is in international transit. Customs timing may vary, but there is no action needed now.",
    "Good news—your order is moving normally through the international route. We will notify you as soon as customs processing starts.",
  ],
  "评价": [
    "Dear Jessica, I’m sorry the delivery was slow and the item arrived damaged. We’d like to offer a replacement or a refund after verification.",
    "Thank you for sharing this. Your experience is not what we expect, and we would appreciate the chance to resolve the damage promptly.",
    "We understand your frustration. Please send a photo of the item and package, and we will review the fastest available solution.",
  ],
} as const;

export function Orders() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("订单详情");
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState<string>(suggestions[tab][0]);

  function changeTab(next: (typeof tabs)[number]) {
    setTab(next);
    setSelected(0);
    setDraft(suggestions[next][0]);
  }

  return <div className="page orders-page">
    <PageHeader eyebrow="ORDER PRACTICE" title="订单管理" description="在订单、物流与评价信息中完成主动服务训练。" actions={<button className="secondary-button"><Clock3 size={17} /> 查看操作记录</button>} />
    <div className="orders-layout">
      <aside className="panel order-list-panel"><div className="panel-heading compact-heading"><div><h2>订单列表</h2><p>共 12 笔</p></div><button className="filter-button">全部订单</button></div><div className="order-buyers">{buyers.map((buyer, index) => <button key={buyer.id} className={index === 0 ? "order-buyer active" : "order-buyer"}><span className="photo-avatar"><img src={buyer.avatar} alt="" /></span><span><strong>{buyer.name}</strong><small>{buyer.order}</small><em>{index === 0 ? "待发货" : index === 1 ? "运输中" : "已完成"}</em></span><span><b>{buyer.price}</b><ChevronRight size={15} /></span></button>)}</div></aside>
      <section className="panel order-detail-panel">
        <div className="order-hero"><div className="order-person"><span className="photo-avatar"><img src={buyers[0]!.avatar} alt="" /></span><span><h2>{buyers[0]!.name}</h2><p>🇺🇸 美国 · jessica.miller@example.com</p></span></div><div><span>订单号</span><strong>#AMZ-20581</strong></div><div><span>订单金额</span><strong>$59.90</strong></div><span className="status-pill amber">待发货</span></div>
        <div className="detail-tabs">{tabs.map((item) => <button className={tab === item ? "active" : ""} onClick={() => changeTab(item)} key={item}>{item}</button>)}</div>
        <div className="tab-content">
          {tab === "订单详情" && <OrderDetail />}
          {tab === "物流" && <Logistics />}
          {tab === "评价" && <Review />}
        </div>
        <section className="ai-assist"><div className="assist-heading"><div><span className="assist-icon"><Bot size={20} /></span><span><h3>AI {tab === "订单详情" ? "催付" : tab === "物流" ? "物流通知" : "差评回复"}建议</h3><p>实时生成 3 个版本，可选择后二次编辑</p></span></div><span className="model-pill"><Sparkles size={14} /> LLM 生成</span></div><div className="suggestion-grid">{suggestions[tab].map((text, index) => <button key={text} className={selected === index ? "suggestion active" : "suggestion"} onClick={() => { setSelected(index); setDraft(text); }}><span>版本 {index + 1}</span><p>{text}</p><i>{selected === index && <CircleCheck size={16} />}</i></button>)}</div><div className="assist-editor"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} /><div><span>{draft.length} / 1000</span><button className="primary-button compact"><Send size={16} /> 发送给买家</button></div></div></section>
      </section>
    </div>
  </div>;
}

function OrderDetail() {
  return <div className="order-info-grid"><section><h3>商品信息</h3><div className="product-line"><span className="product-thumb large"><Headphones size={34} /></span><span><strong>Wireless Earbuds Pro</strong><p>White / Standard · SKU WEPRO-WH</p><small>数量 1</small></span><b>$59.90</b></div><dl><div><dt>收货国家</dt><dd>United States</dd></div><div><dt>配送方式</dt><dd>Standard Shipping</dd></div><div><dt>买家留言</dt><dd>Please deliver before July 25.</dd></div></dl></section><section><h3>订单状态</h3><div className="vertical-timeline">{orderTimeline.map((item) => <div className={item.done ? "done" : ""} key={item.label}><i>{item.done && <CircleCheck size={14} />}</i><span><strong>{item.label}</strong><small>{item.date}</small></span></div>)}</div></section></div>;
}

function Logistics() {
  return <div className="logistics-view"><div className="tracking-summary"><span className="product-thumb large"><Truck size={32} /></span><div><span>国际标准物流</span><strong>YT938204715CN</strong><p><MapPin size={15} /> 目的地：New York, United States</p></div><em>运输中</em></div><div className="logistics-timeline">{logisticsTimeline.map((item) => <div className={item.state} key={item.label}><i>{item.state === "done" ? <PackageCheck size={16} /> : item.state === "active" ? <Truck size={16} /> : <Box size={16} />}</i><span><strong>{item.label}</strong><p>{item.detail}</p></span><time>{item.time}</time></div>)}</div></div>;
}

function Review() {
  return <div className="review-view"><div className="review-card"><div><span className="photo-avatar"><img src={buyers[0]!.avatar} alt="" /></span><span><strong>{buyers[0]!.name}</strong><div className="stars"><Star size={17} fill="currentColor" /><Star size={17} /><Star size={17} /><Star size={17} /><Star size={17} /></div></span><time>2026-07-13 10:42</time></div><blockquote>Delivery was slow and the left earbud arrived damaged. I expected better packaging.</blockquote><span className="negative-tag"><MessageSquareText size={14} /> 需挽回</span></div><div className="review-guidance"><h3>处理建议</h3><ol><li>先明确承认客户的不佳体验</li><li>避免辩解物流或包装原因</li><li>给出退款/补发选项与所需材料</li></ol></div></div>;
}
