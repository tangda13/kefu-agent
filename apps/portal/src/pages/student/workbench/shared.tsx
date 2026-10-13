import { Package2, Paperclip, ShoppingCart, TicketPercent } from "lucide-react";
import { useEffect, useState } from "react";
import { DefaultSilhouette, buyerInitial, initialTone } from "../../../components/BuyerAvatar";
import {
  ApiError,
  assetUrl,
  type BuyerPublicView,
  type ConversationMessage,
  type ConversationOrder,
  type CustomerTag,
  type StoreCoupon,
  type StoreProduct,
} from "../../../api/client";

/* 工作台共用的小件：头像、时间格式、系统客户标签、消息体 */

export function errorMessage(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

/** 每 interval 毫秒刷新一次的“现在”，只让用到它的组件重绘 */
export function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return now;
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function listTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (date.toDateString() === new Date().toDateString()) return timeLabel(iso);
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/** 10 月 2 日 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function dateTimeLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function durationLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h} 时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/** m:ss（等待时长、倒计时） */
export function clockLabel(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(m >= 100 ? 3 : 2, "0")}:${String(s).padStart(2, "0")}`;
}

function fileSizeLabel(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

/** 稳定散列：买家浏览记录按会话种子确定，切换会话不变 */
export function hashSeed(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) | 0;
  return Math.abs(value);
}

export function mediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith("blob:") ? url : assetUrl(url) ?? undefined;
}

export function Av({ buyer, size = 40 }: { buyer: BuyerPublicView | null; size?: number }) {
  const tone = !buyer?.avatarUrl && buyer?.avatarKind === "initial" ? initialTone(buyer.name) : undefined;
  return (
    <span className="wbk-av" style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)), ...tone }}>
      {buyer?.avatarUrl ? <img src={buyer.avatarUrl} alt={`${buyer.name} 头像`} /> : buyer?.avatarKind === "default" ? <DefaultSilhouette /> : buyerInitial(buyer)}
    </span>
  );
}

/* ---------- 系统客户标签（D-38：只读，按订单规则生成） ---------- */

const TAG_CLASS: Record<CustomerTag, string> = {
  粉丝: "is-fan",
  大订单客户: "is-big",
  普通客户: "",
  沉睡客户: "",
  新客: "",
};

export function CustomerTagChip({ tag, small }: { tag: CustomerTag; small?: boolean }) {
  return <span className={["wbk-tag", TAG_CLASS[tag] ?? "", small ? "is-small" : ""].filter(Boolean).join(" ")}>{tag}</span>;
}

/* ---------- 订单筛选 ---------- */

export const ORDER_FILTERS = [
  ["all", "全部"],
  ["pending_payment", "待付款"],
  ["paid", "待发货"],
  ["in_transit", "已发货"],
  ["delivered", "已送达"],
  ["after_sale", "售后中"],
  ["completed", "已完成"],
] as const;

export const RETURN_LABELS: Record<string, string> = {
  requested: "待客户退货",
  returning: "退货运输中",
  refunded: "已退款",
};

/** 订单筛选键：售后中优先于物流状态 */
export function orderFilterKey(detail: ConversationOrder["detail"]): string {
  return detail.returnStatus ? "after_sale" : detail.status;
}

export function orderBadgeLabel(detail: ConversationOrder["detail"]): string {
  return detail.returnStatus ? "售后中" : detail.statusLabel;
}

/* ---------- 跳到别的页面（外壳侧栏没有对外的跳转接口，按名称点导航项；同时广播事件，外壳以后可直接监听） ---------- */

export const NAVIGATE_EVENT = "cecs:navigate";
export function goToPage(page: "records" | "mail", _label: string, hint?: { key: string; value: string }): void {
  if (hint) {
    try {
      sessionStorage.setItem(hint.key, hint.value);
    } catch {
      /* 存不了就不带定位 */
    }
  }
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { page } }));
}

/* ---------- 消息气泡里的内容 ---------- */

export function isCardKind(message: ConversationMessage): boolean {
  return ["order", "product", "invite", "coupon", "image", "video", "file"].includes(message.kind ?? "");
}

export function MessageBody({ message, onPlayVoice }: { message: ConversationMessage; onPlayVoice?: (url: string) => void }) {
  if (message.kind === "voice" && message.payload) {
    const voice = message.payload as { audioUrl?: string; durationMs?: number; transcript?: string };
    const seconds = Math.max(1, Math.round((voice.durationMs ?? 0) / 1000));
    return (
      <div className="wbk-voice">
        <button type="button" className="wbk-voice-play" onClick={() => voice.audioUrl && onPlayVoice?.(voice.audioUrl)} disabled={!voice.audioUrl} aria-label="播放语音">
          <span aria-hidden="true">▶</span>
          <span className="wbk-wave" aria-hidden="true">{[8, 14, 10, 18, 12, 16, 9, 14].map((h, index) => <i key={index} style={{ height: h }} />)}</span>
          <span className="num">{seconds}″</span>
        </button>
        {voice.transcript ? <small>{voice.transcript}</small> : null}
      </div>
    );
  }
  if (message.kind === "image" && message.payload) {
    const media = message.payload as { url?: string; name?: string };
    return <img className="wbk-msg-image" src={mediaUrl(media.url)} alt={media.name ?? "图片"} />;
  }
  if (message.kind === "video" && message.payload) {
    const media = message.payload as { url?: string };
    return <video className="wbk-msg-image" src={mediaUrl(media.url)} controls preload="metadata" />;
  }
  if (message.kind === "file" && message.payload) {
    const media = message.payload as { url?: string; name?: string; size?: number };
    return (
      <a className="wbk-card wbk-card-file" href={mediaUrl(media.url)} target="_blank" rel="noreferrer">
        <span className="wbk-card-thumb"><Paperclip size={18} /></span>
        <span>
          <b>{media.name ?? "附件"}</b>
          <small>{media.size ? fileSizeLabel(media.size) : ""}</small>
        </span>
      </a>
    );
  }
  if (message.kind === "order" && message.payload) {
    const order = message.payload as {
      orderNo?: string; productName?: string; productImage?: string | null; quantity?: number;
      totalAmount?: number; currency?: string; statusLabel?: string; returnStatus?: string | null;
    };
    return (
      <div className="wbk-card">
        {order.productImage ? <img src={assetUrl(order.productImage) ?? undefined} alt={order.productName} /> : <span className="wbk-card-thumb"><Package2 size={20} /></span>}
        <span>
          <b>{order.productName} ×{order.quantity ?? 1}</b>
          <small className="num">#{order.orderNo}</small>
          <em className="num">{order.currency} {order.totalAmount} · {order.returnStatus ? "售后中" : order.statusLabel}</em>
        </span>
      </div>
    );
  }
  if ((message.kind === "product" || message.kind === "invite") && message.payload) {
    const product = message.payload as unknown as StoreProduct;
    return (
      <div className="wbk-card">
        {product.imageUrl ? <img src={assetUrl(product.imageUrl) ?? undefined} alt={product.name} /> : <span className="wbk-card-thumb" style={{ background: product.tone }}><Package2 size={20} /></span>}
        <span>
          <b>{product.name}</b>
          <small>SKU {product.id} · {product.spec}</small>
          <em className="num">USD {product.price}{message.kind === "product" ? ` · 已售 ${product.sales}` : ""}</em>
          {message.kind === "invite" ? <span className="wbk-card-tag"><ShoppingCart size={11} /> 已邀请下单</span> : null}
        </span>
      </div>
    );
  }
  if (message.kind === "coupon" && message.payload) {
    const coupon = message.payload as unknown as StoreCoupon;
    return (
      <div className="wbk-card">
        <span className="wbk-card-thumb is-coupon"><TicketPercent size={20} /></span>
        <span>
          <b>{coupon.title}</b>
          <small>{coupon.rule} · {coupon.scope}</small>
          <em>有效期 {coupon.validDays} 天</em>
        </span>
      </div>
    );
  }
  return <>{message.content}</>;
}
