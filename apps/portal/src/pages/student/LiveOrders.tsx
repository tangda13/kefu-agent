import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BellRing,
  Check,
  CircleAlert,
  Copy,
  CreditCard,
  Home,
  Package2,
  PackageCheck,
  Plane,
  Search,
  ShieldCheck,
  Star,
  Truck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TabCount, fmtMonthDayTime, useBuyerTags } from "../../components/StoreHeader";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import { SuggestionComposer } from "../../components/SuggestionComposer";
import { ReviewReply, loadReviewReplies, type StoredReply } from "../../components/ReviewReply";
import {
  ApiError,
  assetUrl,
  fetchStudentOrders,
  type BuyerPublicView,
  type OrderAddress,
  type OrderInfo,
  type Session,
  type StudentOrder,
} from "../../api/client";
import { Button, HeaderTabs, MoreMenu, Tag } from "../../ui";
import "../../styles/student-store.css";

type DetailTab = "detail" | "logistics" | "review";

/** 评价管理页跳转过来时预打开的订单 */
export const OPEN_ORDER_KEY = "cecs.openOrder";

/** 时间范围：null=全部 */
const ORDER_RANGES: ReadonlyArray<[string, string, number | null]> = [
  ["all", "全部时间", null],
  ["7d", "近 7 天", 7],
  ["30d", "近 30 天", 30],
  ["90d", "近 90 天", 90],
];

const STATUS_TABS: ReadonlyArray<[string, string]> = [
  ["all", "全部"],
  ["pending_payment", "待付款"],
  ["paid", "待发货"],
  ["in_transit", "已发货"],
  ["delivered", "已送达"],
  ["completed", "已成功"],
];

const RETURN_LABELS: Record<string, string> = {
  requested: "待客户退货",
  returning: "退货运输中",
  refunded: "已退款",
};

/** 订单主状态推进度：买家下单为第 1 步 */
const STATUS_RANK: Record<string, number> = {
  pending_payment: 1,
  paid: 2,
  in_transit: 3,
  delivered: 4,
  completed: 5,
};

const HERO_TITLES: Record<string, string> = {
  pending_payment: "等待买家付款",
  paid: "买家已付款，等待商家发货",
  in_transit: "商家已发货，等待买家确认",
  delivered: "包裹已送达，等待买家确认收货",
  completed: "交易成功",
};

const NODE_ICONS: Record<string, LucideIcon> = {
  pickup: PackageCheck,
  domestic: Truck,
  linehaul: Plane,
  customs: ShieldCheck,
  delivery: Home,
};

/** 物流节点未开始时的占位文案 */
const NODE_PENDING: Record<string, string> = {
  pickup: "等待承运商揽收",
  domestic: "等待国内段运输",
  linehaul: "等待国际干线舱位",
  customs: "等待清关",
  delivery: "等待末端派送",
};

/** 目的国口岸与末端派送商（按买家国籍虚拟） */
const DEST_META: Record<string, { airport: string; city: string; lastMile: string }> = {
  美国: { airport: "洛杉矶国际机场", city: "洛杉矶", lastMile: "USPS" },
  英国: { airport: "伦敦希思罗机场", city: "伦敦", lastMile: "Royal Mail" },
  加拿大: { airport: "多伦多皮尔逊机场", city: "多伦多", lastMile: "Canada Post" },
  澳大利亚: { airport: "悉尼金斯福德机场", city: "悉尼", lastMile: "Australia Post" },
  德国: { airport: "法兰克福机场", city: "法兰克福", lastMile: "DHL Paket" },
  法国: { airport: "巴黎戴高乐机场", city: "巴黎", lastMile: "Colissimo" },
  西班牙: { airport: "马德里巴拉哈斯机场", city: "马德里", lastMile: "Correos" },
  意大利: { airport: "米兰马尔彭萨机场", city: "米兰", lastMile: "Poste Italiane" },
  日本: { airport: "东京成田机场", city: "东京", lastMile: "佐川急便" },
  巴西: { airport: "圣保罗瓜鲁柳斯机场", city: "圣保罗", lastMile: "Correios" },
};
const DEST_DEFAULT = { airport: "目的国口岸机场", city: "目的国", lastMile: "当地邮政" };
const ORIGINS = ["深圳", "广州", "义乌", "东莞"] as const;
const EXPORT_AIRPORTS = ["香港国际机场", "广州白云国际机场", "深圳宝安国际机场"] as const;

/** 收货邮编（按买家国籍格式虚拟，订单号稳定派生） */
function postalCode(nationality: string, orderNo: string): string {
  const seed = hashSeed(`postal:${orderNo}`);
  switch (nationality) {
    case "英国": return ["SW1A 1AA", "E1 6AN", "M1 1AE", "B33 8TH", "NW1 6XE"][seed % 5]!;
    case "加拿大": return ["M5V 2T6", "V6B 1A1", "H3B 4W8", "K1P 5G4"][seed % 4]!;
    case "澳大利亚": return String(2000 + (seed % 6999));
    case "日本": return `${100 + (seed % 899)}-${String(seed % 9999).padStart(4, "0")}`;
    case "巴西": return `${String(10000 + (seed % 89999))}-${String(100 + (seed % 899))}`;
    default: return String(10000 + (seed % 89999));
  }
}

/** 按国籍虚拟收货城市与电话区号（与后端地址簿同源口径） */
const CITY_POOL: Record<string, { country: string; cc: string; cities: string[] }> = {
  美国: { country: "United States", cc: "1", cities: ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX"] },
  英国: { country: "United Kingdom", cc: "44", cities: ["London", "Manchester", "Birmingham"] },
  加拿大: { country: "Canada", cc: "1", cities: ["Toronto, ON", "Vancouver, BC", "Montreal, QC"] },
  澳大利亚: { country: "Australia", cc: "61", cities: ["Sydney, NSW", "Melbourne, VIC", "Brisbane, QLD"] },
  德国: { country: "Germany", cc: "49", cities: ["Berlin", "Munich", "Hamburg"] },
  法国: { country: "France", cc: "33", cities: ["Paris", "Lyon", "Marseille"] },
  西班牙: { country: "Spain", cc: "34", cities: ["Madrid", "Barcelona", "Valencia"] },
  意大利: { country: "Italy", cc: "39", cities: ["Milan", "Rome", "Turin"] },
  日本: { country: "Japan", cc: "81", cities: ["Tokyo", "Osaka", "Nagoya"] },
  巴西: { country: "Brazil", cc: "55", cities: ["São Paulo", "Rio de Janeiro", "Curitiba"] },
};
const STREET_POOL = [
  "Maple Street", "Oak Avenue", "Cedar Lane", "Riverside Drive",
  "Hillcrest Road", "Park Boulevard", "Sunset Avenue", "Elm Street",
] as const;

/** 老订单 payload 缺收货地址时，按买家国籍与订单号稳定虚拟一套完整收件信息 */
function ensureAddress(info: OrderInfo, buyer: BuyerPublicView): OrderAddress {
  if (info.address) return info.address;
  const seed = hashSeed(`addr:${info.orderNo}`);
  const entry = CITY_POOL[buyer.nationality] ?? CITY_POOL["美国"]!;
  return {
    recipient: buyer.name,
    line1: `${100 + (seed % 899)} ${STREET_POOL[seed % STREET_POOL.length]}${seed % 5 < 2 ? `, Apt ${1 + (seed % 30)}` : ""}`,
    city: entry.cities[seed % entry.cities.length]!,
    country: entry.country,
    phone: `+${entry.cc} ••• •••• ${String(1000 + (seed % 9000))}`,
  };
}

interface TrackEvent {
  at: string | null;
  text: string;
  state: "done" | "current" | "pending";
}

interface TrackPhase {
  key: string;
  label: string;
  at: string | null;
  state: "done" | "current" | "pending";
  events: TrackEvent[];
}

/**
 * 由五个主节点推导细颗粒度物流轨迹（每个节点下 2-3 条扫描事件，
 * 城市/口岸/末端派送商按买家国籍与订单号稳定虚拟）。
 */
function buildTrackingEvents(info: OrderInfo, nationality: string, buyerCity: string): TrackPhase[] {
  const logistics = info.logistics;
  if (!logistics) return [];
  const seed = hashSeed(info.orderNo);
  const dest = DEST_META[nationality] ?? DEST_DEFAULT;
  const origin = ORIGINS[seed % ORIGINS.length]!;
  const exportAirport = EXPORT_AIRPORTS[seed % EXPORT_AIRPORTS.length]!;
  const nodes = logistics.nodes;
  const at = (key: string) => nodes.find((node) => node.key === key)?.at ?? null;
  const jitter = (index: number) => ((seed + index * 37) % 50) * 60_000;
  const shift = (iso: string, hours: number, index: number) =>
    new Date(new Date(iso).getTime() + hours * 3_600_000 + jitter(index)).toISOString();
  const mid = (a: string, b: string, ratio: number, index: number) => {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    return new Date(ta + (tb - ta) * ratio + jitter(index)).toISOString();
  };

  const t0 = at("pickup");
  const t1 = at("domestic");
  const t2 = at("linehaul");
  const t3 = at("customs");
  const t4 = at("delivery");

  return nodes.map((node) => {
    const state: TrackPhase["state"] = node.current ? "current" : node.done ? "done" : "pending";
    let events: TrackEvent[] = [];
    if (state === "pending" || !node.at) {
      events = [{ at: null, text: NODE_PENDING[node.key] ?? "待更新", state: "pending" }];
    } else if (node.key === "pickup" && t0) {
      events = [
        { at: shift(t0, -6, 0), text: `【${origin}】商家已发货，等待承运商揽收`, state: "done" },
        { at: t0, text: `【${origin}】${logistics.carrier} 已完成揽收`, state: "done" },
      ];
    } else if (node.key === "domestic" && t0 && t1) {
      events = [
        { at: mid(t0, t1, 0.35, 1), text: `【${origin}转运中心】快件已到达`, state: "done" },
        { at: mid(t0, t1, 0.6, 2), text: `【${origin}转运中心】快件已发出，下一站 ${exportAirport}`, state: "done" },
        { at: t1, text: `【${exportAirport}】抵达出口口岸，等待航空运输`, state: "done" },
      ];
    } else if (node.key === "linehaul" && t1 && t2) {
      events = [
        { at: mid(t1, t2, 0.3, 3), text: `【${exportAirport}】已交航空承运，等待装载`, state: "done" },
        { at: mid(t1, t2, 0.55, 4), text: `【${exportAirport}】国际航班已起飞`, state: "done" },
        { at: t2, text: `【${dest.airport}】航班抵达目的国`, state: "done" },
      ];
    } else if (node.key === "customs" && t2 && t3) {
      events = [
        { at: mid(t2, t3, 0.4, 5), text: `【${dest.city}】已递交进口清关申报`, state: "done" },
        { at: t3, text: `【${dest.city}】海关查验中，通常需 1-3 个工作日`, state: "done" },
      ];
      if (state === "done") {
        events.push({ at: shift(t3, 9, 6), text: `【${dest.city}】海关放行，快件离开口岸`, state: "done" });
      }
    } else if (node.key === "delivery" && t4) {
      events = [
        { at: shift(t4, -9, 7), text: `【${buyerCity}】已交接本地派送商 ${dest.lastMile}`, state: "done" },
        { at: shift(t4, -4, 8), text: `【${buyerCity}】快件派送中，请保持电话畅通`, state: "done" },
        { at: t4, text: `【${buyerCity}】包裹已签收，感谢您的等待`, state: "done" },
      ];
    }
    if (state === "current" && events.length > 0) {
      events[events.length - 1] = { ...events[events.length - 1]!, state: "current" };
    }
    return { key: node.key, label: node.label, at: node.at, state, events };
  });
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

/** 稳定散列：同一订单派生的展示数据（付款时间、流水号、邮箱域名等）保持不变 */
function hashSeed(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

function fmtMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtShort(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 剩余时长文案，如 "2 天 5 小时"、"6 小时" */
function fmtRemain(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.max(1, Math.floor((ms % 86_400_000) / 3_600_000));
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

/** 买家联系邮箱（展示用，按订单号稳定派生，局部打码贴近真实后台） */
function maskedEmail(name: string, seedText: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/(^\.+|\.+$)/g, "") || "customer";
  const domains = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com"];
  return `${slug.slice(0, 3)}***@${domains[hashSeed(seedText) % domains.length]}`;
}

/** 交易流水号（展示用，按订单号稳定派生） */
function txnNo(orderNo: string): string {
  const digits = orderNo.replace(/\D/g, "");
  const seed = String(hashSeed(`txn:${orderNo}`)).padStart(10, "0");
  return `${digits}${seed}`.slice(0, 24);
}

/** 已付款订单的付款时间（按订单号稳定派生） */
function paidAtIso(order: OrderInfo): string | null {
  if ((STATUS_RANK[order.status] ?? 1) < 2) return null;
  const placedMs = new Date(order.placedAt).getTime();
  return new Date(placedMs + (12 + (hashSeed(order.orderNo) % 105)) * 60_000).toISOString();
}

interface TimelineStep {
  key: string;
  label: string;
  time: string | null;
  hint: string | null;
  state: "done" | "current" | "pending";
}

/** 由订单状态与物流节点推导交易步骤条（买家下单→买家付款→商家发货→包裹送达→交易成功） */
function buildStatusSteps(order: OrderInfo): TimelineStep[] {
  const doneCount = STATUS_RANK[order.status] ?? 1;
  const seed = hashSeed(order.orderNo);
  const placedMs = new Date(order.placedAt).getTime();
  const pickupAt =
    order.logistics?.nodes.find((node) => node.key === "pickup")?.at ??
    new Date(placedMs + 2 * 86_400_000).toISOString();
  const deliveredAt =
    order.logistics?.nodes.find((node) => node.key === "delivery")?.at ??
    new Date(placedMs + 18 * 86_400_000).toISOString();
  const completedAt =
    order.review?.at ?? new Date(new Date(deliveredAt).getTime() + 3 * 86_400_000).toISOString();
  const eta = new Date(placedMs + (20 + (seed % 9)) * 86_400_000);

  const defs = [
    { key: "placed", label: "买家下单", time: order.placedAt, hint: "" },
    { key: "paid", label: "买家付款", time: paidAtIso(order), hint: "等待买家付款" },
    { key: "shipped", label: "商家发货", time: pickupAt, hint: "仓库拣货备货中" },
    { key: "delivered", label: "包裹送达", time: deliveredAt, hint: `预计 ${eta.getMonth() + 1}/${eta.getDate()} 送达` },
    { key: "completed", label: "交易成功", time: completedAt, hint: "待买家确认收货" },
  ];
  return defs.map((def, index) => {
    if (index < doneCount) return { key: def.key, label: def.label, time: def.time, hint: null, state: "done" as const };
    if (index === doneCount) return { key: def.key, label: def.label, time: null, hint: def.hint, state: "current" as const };
    return { key: def.key, label: def.label, time: null, hint: null, state: "pending" as const };
  });
}

/** 状态卡提示文案（倒计时按下单/送达时间派生） */
function heroNote(order: OrderInfo): string {
  const placedMs = new Date(order.placedAt).getTime();
  if (order.status === "pending_payment") {
    const remain = placedMs + 72 * 3_600_000 - Date.now();
    return remain > 0
      ? `买家还有 ${fmtRemain(remain)} 完成付款，超时后订单将自动关闭。可主动发起催付提醒。`
      : "订单已超过建议付款时限，建议尽快发起催付提醒，避免订单自动关闭。";
  }
  if (order.status === "paid") return "请在 48 小时内完成发货，避免发货超时影响店铺考核。";
  if (order.status === "in_transit") return "包裹正在跨境运输途中，可在「物流」页签主动向买家同步物流进展。";
  if (order.status === "delivered") {
    const deliveredAt = order.logistics?.nodes.find((node) => node.key === "delivery")?.at;
    const remain = deliveredAt ? new Date(deliveredAt).getTime() + 7 * 86_400_000 - Date.now() : 0;
    return remain > 0
      ? `买家还有 ${fmtRemain(remain)} 自动确认收货，届时货款将结算到店铺账户。`
      : "包裹已送达，等待买家确认收货后货款将结算到店铺账户。";
  }
  return "交易已完成，货款已结算。可在「评价」页签关注买家评价。";
}

function CopyButton({ text, onCopied }: { text: string; onCopied: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-button copy-button"
      title="复制"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          onCopied();
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

export function LiveOrders({ session }: { session: Session }) {
  const [orders, setOrders] = useState<StudentOrder[]>([]);
  const [detail, setDetail] = useState<{ id: string; tab: DetailTab } | null>(null);
  const [statusTab, setStatusTab] = useState("all");
  const [query, setQuery] = useState("");
  const [buyerFilter, setBuyerFilter] = useState("");
  const [rangeKey, setRangeKey] = useState("all");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [replies, setReplies] = useState<Record<string, StoredReply>>({});
  const buyerTags = useBuyerTags(session);

  const load = useCallback(async () => {
    try {
      loadReviewReplies(session).then(setReplies).catch(() => undefined);
      const list = await fetchStudentOrders(session);
      list.sort((a, b) => new Date(b.detail.placedAt).getTime() - new Date(a.detail.placedAt).getTime());
      setOrders(list);
      const pendingOpen = sessionStorage.getItem(OPEN_ORDER_KEY);
      if (pendingOpen) {
        sessionStorage.removeItem(OPEN_ORDER_KEY);
        if (list.some((item) => item.id === pendingOpen)) setDetail({ id: pendingOpen, tab: "review" });
      }
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: orders.length };
    for (const item of orders) map[item.detail.status] = (map[item.detail.status] ?? 0) + 1;
    return map;
  }, [orders]);

  /** 买家筛选项：订单里出现过的买家 */
  const buyers = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of orders) map.set(item.buyer.id, item.buyer.name);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [orders]);

  const filtered = useMemo(() => {
    let list = statusTab === "all" ? orders : orders.filter((item) => item.detail.status === statusTab);
    if (buyerFilter) list = list.filter((item) => item.buyer.id === buyerFilter);
    const days = ORDER_RANGES.find(([key]) => key === rangeKey)?.[2] ?? null;
    if (days !== null) {
      const cutoff = Date.now() - days * 86_400_000;
      list = list.filter((item) => new Date(item.detail.placedAt).getTime() >= cutoff);
    }
    const keyword = query.trim().toLowerCase();
    if (keyword) {
      list = list.filter((item) =>
        [item.orderNo, item.detail.productName, item.buyer.name, item.detail.logistics?.trackingNo ?? ""]
          .some((field) => field.toLowerCase().includes(keyword)),
      );
    }
    return list;
  }, [orders, statusTab, query, buyerFilter, rangeKey]);

  const active = detail ? orders.find((item) => item.id === detail.id) ?? null : null;

  function openDetail(id: string, tab: DetailTab = "detail") {
    setDetail({ id, tab });
    setNotice("");
    setError("");
  }

  /* ---------------- 列表视图 ---------------- */

  /** 状态列：标签 + 一行灰字事实。只有“待付款超过 24 小时”标橙，其余中性 */
  function statusCell(item: StudentOrder) {
    const info = item.detail;
    const now = Date.now();
    let tone: "neutral" | "warn" = "neutral";
    let sub = "";
    let subWarn = false;
    if (info.returnStatus) {
      sub = `售后：${RETURN_LABELS[info.returnStatus] ?? info.returnStatus}`;
    } else if (info.status === "pending_payment") {
      const hours = (now - new Date(info.placedAt).getTime()) / 3_600_000;
      if (hours > 24) {
        tone = "warn";
        subWarn = true;
        sub = hours >= 48 ? `已过 ${Math.floor(hours / 24)} 天未付` : "已超过 24 小时未付";
      }
    } else if (info.status === "in_transit" && info.logistics) {
      const node = info.logistics.nodes.find((entry) => entry.current) ?? info.logistics.nodes.filter((entry) => entry.done).pop();
      if (node) {
        const days = node.at ? Math.floor((now - new Date(node.at).getTime()) / 86_400_000) : 0;
        sub = days >= 1 ? `${node.label} · ${days} 天未更新` : node.label;
      }
    }
    return (
      <div className="od2-st">
        <Tag tone={tone}>{info.statusLabel}</Tag>
        {sub ? <small className={subWarn ? "sub-warn" : undefined}>{sub}</small> : null}
      </div>
    );
  }

  function actionsCell(item: StudentOrder) {
    const info = item.detail;
    const primary =
      info.status === "pending_payment"
        ? { label: "去催付", run: () => openDetail(item.id) }
        : info.status === "in_transit" && info.logistics
          ? { label: "查看物流", run: () => openDetail(item.id, "logistics") }
          : { label: "查看详情", run: () => openDetail(item.id) };
    const more = [
      primary.label !== "查看详情" ? { label: "查看详情", onClick: () => openDetail(item.id) } : null,
      info.logistics && primary.label !== "查看物流" ? { label: "查看物流", onClick: () => openDetail(item.id, "logistics") } : null,
      info.review ? { label: "查看评价", onClick: () => openDetail(item.id, "review") } : null,
      { label: "复制订单号", onClick: () => { void navigator.clipboard?.writeText(info.orderNo); setNotice("订单号已复制。"); } },
    ].filter((entry): entry is { label: string; onClick: () => void } => entry !== null);
    return (
      <div className="od2-ac">
        <Button size="sm" onClick={primary.run}>{primary.label}</Button>
        <MoreMenu items={more} />
      </div>
    );
  }

  function renderList() {
    return (
      <div className="od2">
        <div className="od2-bar">
          <label className="sx-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="订单号 / 运单号 / 商品 / 买家"
              aria-label="搜索订单"
            />
          </label>
          <select className="sx-select" value={buyerFilter} onChange={(event) => setBuyerFilter(event.target.value)} aria-label="按买家筛选">
            <option value="">买家：全部</option>
            {buyers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select className="sx-select" value={rangeKey} onChange={(event) => setRangeKey(event.target.value)} aria-label="按下单时间筛选">
            {ORDER_RANGES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <span className="end">共 {filtered.length} 笔</span>
        </div>

        <div className="od2-head">
          <span>商品</span><span>单价</span><span>数量</span><span>实收</span><span>状态</span><span>操作</span>
        </div>

        {filtered.map((item) => {
          const info = item.detail;
          const goods = Math.round(info.unitPrice * info.quantity * 100) / 100;
          const shipping = Math.max(0, Math.round((info.totalAmount - goods) * 100) / 100);
          const tag = buyerTags[item.buyer.id]?.join(" · ");
          return (
            <article key={item.id} className="od2-group">
              <header className="od2-g1">
                <span className="od2-buyer">
                  <span className="sx-av is-22"><BuyerAvatar buyer={item.buyer} /></span>
                  {item.buyer.name}
                  <small>{[item.buyer.nationality, tag].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="od2-no">{info.orderNo}</span>
                <CopyButton text={info.orderNo} onCopied={() => setNotice("订单号已复制。")} />
                <span>{fmtMonthDayTime(info.placedAt)}</span>
              </header>
              <div className="od2-row">
                <div className="od2-it">
                  {info.productImage ? (
                    <img src={assetUrl(info.productImage) ?? undefined} alt={info.productName} />
                  ) : (
                    <span className="blank"><Package2 size={20} /></span>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <button type="button" onClick={() => openDetail(item.id)}>{info.productName}</button>
                    <small>{info.productSpec}</small>
                  </div>
                </div>
                <span className="od2-num">{fmtMoney(info.unitPrice)}</span>
                <span className="od2-num">× {info.quantity}</span>
                <div className="od2-amt">
                  <b className="od2-num">{fmtMoney(info.totalAmount)}</b>
                  <small>含运费 {fmtMoney(shipping)}</small>
                </div>
                {statusCell(item)}
                {actionsCell(item)}
              </div>
            </article>
          );
        })}
        {filtered.length === 0 ? (
          <div className="sx-empty">
            <Package2 size={26} />
            <strong>{orders.length === 0 ? "暂无订单" : "没有符合条件的订单"}</strong>
            <p>{orders.length === 0 ? "接待售中、售后客户后，买家的订单会出现在这里。" : "换个状态页签、时间范围或关键词试试。"}</p>
          </div>
        ) : null}
      </div>
    );
  }

  /* ---------------- 详情视图 ---------------- */

  function renderDetail(current: StudentOrder) {
    const info = current.detail;
    const conversationOpen = current.conversationStatus === "active";
    const tab = detail?.tab ?? "detail";
    const steps = buildStatusSteps(info);
    return (
      <>
        <button className="text-button od-back" onClick={() => setDetail(null)}>
          <ArrowLeft size={14} /> 返回订单列表
        </button>
        <section className="panel od-detail-panel">
          <div className="od-status-hero">
            <div className="od-hero-top">
              <h2>订单状态：{HERO_TITLES[info.status] ?? info.statusLabel}</h2>
              <div className="segmented-tabs">
                {([["detail", "订单详情"], ["logistics", "物流"], ["review", "评价"]] as const).map(([id, label]) => (
                  <button key={id} className={tab === id ? "active" : ""} onClick={() => setDetail({ id: current.id, tab: id })}>{label}</button>
                ))}
              </div>
            </div>
            <div className="od-stepper">
              {steps.map((step, index) => (
                <div key={step.key} className={`od-step ${step.state}`}>
                  <span className="od-step-dot">{step.state === "done" ? <Check size={13} /> : index + 1}</span>
                  <strong>{step.label}</strong>
                  <small>{step.time ? fmtShort(step.time) : step.hint ?? "—"}</small>
                </div>
              ))}
            </div>
            <p className="od-hero-note"><CircleAlert size={13} /> {heroNote(info)}</p>
          </div>

          {tab === "detail" ? renderDetailTab(current, info, conversationOpen) : null}
          {tab === "logistics" ? renderLogisticsTab(current, info, conversationOpen) : null}
          {tab === "review" ? renderReviewTab(current, info, conversationOpen) : null}
        </section>
      </>
    );
  }

  function renderDetailTab(current: StudentOrder, info: OrderInfo, conversationOpen: boolean) {
    const goodsAmount = Math.round(info.unitPrice * info.quantity * 100) / 100;
    const shipping = Math.max(0, Math.round((info.totalAmount - goodsAmount) * 100) / 100);
    const paidAt = paidAtIso(info);
    const address = ensureAddress(info, current.buyer);
    return (
      <div className="order-detail-body">
        <div className="od-card">
          <div className="od-card-title"><CreditCard size={13} /> 订单信息</div>
          <div className="od-info-cols">
            <div className="od-info-col">
              <h4>交易信息</h4>
              <div className="od-info-row"><span>订单编号</span><em>{info.orderNo}<CopyButton text={info.orderNo} onCopied={() => setNotice("订单号已复制。")} /></em></div>
              <div className="od-info-row"><span>交易流水号</span><em>{txnNo(info.orderNo)}</em></div>
              <div className="od-info-row"><span>创建时间</span><em>{fmtDateTime(info.placedAt)}</em></div>
              <div className="od-info-row"><span>付款时间</span><em>{paidAt ? fmtDateTime(paidAt) : "—（买家未付款）"}</em></div>
              {info.remark ? <div className="od-info-row"><span>订单备注</span><em>{info.remark}</em></div> : null}
            </div>
            <div className="od-info-col">
              <h4>买家信息</h4>
              <div className="od-info-row"><span>昵称</span><em className="od-buyer-inline"><BuyerAvatar buyer={current.buyer} size="tiny" />{current.buyer.name}</em></div>
              <div className="od-info-row"><span>国家</span><em>{current.buyer.nationality}</em></div>
              <div className="od-info-row"><span>联系电话</span><em>{address.phone}</em></div>
              <div className="od-info-row"><span>邮件</span><em>{maskedEmail(current.buyer.name, info.orderNo)}</em></div>
            </div>
            <div className="od-info-col">
              <h4>物流信息</h4>
              <div className="od-info-row"><span>收货地址</span><em>{`${address.recipient}，${address.line1}，${address.city} ${postalCode(current.buyer.nationality, info.orderNo)}，${address.country}`}</em></div>
              <div className="od-info-row"><span>运送方式</span><em>国际快递（跨境直邮）</em></div>
              <div className="od-info-row"><span>物流公司</span><em>{info.logistics?.carrier ?? "待发货"}</em></div>
              <div className="od-info-row">
                <span>运单号</span>
                <em>
                  {info.logistics ? info.logistics.trackingNo : "—"}
                  {info.logistics ? <button className="text-button od-inline-link" onClick={() => setDetail({ id: current.id, tab: "logistics" })}>查看物流</button> : null}
                </em>
              </div>
            </div>
          </div>
        </div>

        <div className="od-card">
          <div className="od-card-title"><Package2 size={13} /> 商品信息</div>
          <div className="od-product">
            {info.productImage ? (
              <img className="od-thumb" src={assetUrl(info.productImage) ?? undefined} alt={info.productName} />
            ) : (
              <span className="od-thumb-fallback"><Package2 size={22} /></span>
            )}
            <div className="od-product-info">
              <strong>{info.productName}</strong>
              <small>规格：{info.productSpec}</small>
            </div>
            <div className="od-product-cols">
              <div><span>单价</span>{fmtMoney(info.unitPrice)}</div>
              <div><span>数量</span>× {info.quantity}</div>
              <div><span>小计</span>{fmtMoney(goodsAmount)}</div>
            </div>
          </div>
          <div className="amount-grid">
            <div className="amount-cell"><span>商品金额</span><em>{fmtMoney(goodsAmount)}</em></div>
            <div className="amount-cell"><span>运费</span><em>{shipping > 0 ? fmtMoney(shipping) : "免运费"}</em></div>
            <div className="amount-cell"><span>优惠</span><em>-$0.00</em></div>
            <div className="amount-cell total"><span>实收款（{info.currency}）</span><em>{fmtMoney(info.totalAmount)}</em></div>
          </div>
        </div>

        {info.status === "pending_payment" ? (
          <SuggestionComposer
            session={session}
            orderId={current.id}
            conversationId={current.conversationId}
            conversationOpen={conversationOpen}
            type="payment_reminder"
            icon={BellRing}
            title="催付提醒"
            hint="买家已下单但尚未付款。AI 将结合订单状态与买家资料，生成 3 版催付话术供你选择与编辑，发出去是一张付款提醒卡片。"
            buttonLabel="礼貌催付"
            onSent={(delivered) => setNotice(delivered === "live" ? "付款提醒已发到聊天里，可到客服工作台查看买家回复。" : "付款提醒已发给买家；买家回复后会出现在客服工作台的接待中。")}
          />
        ) : null}
      </div>
    );
  }

  function renderLogisticsTab(current: StudentOrder, info: OrderInfo, conversationOpen: boolean) {
    const address = ensureAddress(info, current.buyer);
    const dest = DEST_META[current.buyer.nationality] ?? DEST_DEFAULT;
    const recipientCard = (
      <div className="od-card">
        <div className="od-card-title"><Home size={13} /> 收件信息</div>
        <div className="od-info-row"><span>收件人</span><em>{address.recipient}</em></div>
        <div className="od-info-row"><span>联系电话</span><em>{address.phone}</em></div>
        <div className="od-info-row"><span>收货地址</span><em>{`${address.line1}, ${address.city} ${postalCode(current.buyer.nationality, info.orderNo)}, ${address.country}`}</em></div>
        <div className="od-info-row"><span>末端派送</span><em>{info.logistics ? `${dest.lastMile}（本地派送商）` : "待发货后分配"}</em></div>
      </div>
    );
    if (!info.logistics) {
      return (
        <div className="order-detail-body">
          {recipientCard}
          <div className="order-empty">
            <Truck size={26} />
            <strong>订单尚未发货</strong>
            <p>买家完成付款、仓库发出包裹后，这里会展示跨境物流全链路轨迹。</p>
          </div>
        </div>
      );
    }
    const nodes = info.logistics.nodes;
    const currentNode = nodes.find((node) => node.current) ?? nodes[nodes.length - 1];
    const phases = buildTrackingEvents(info, current.buyer.nationality, address.city);
    return (
      <div className="order-detail-body">
        <div className="od-two-col">
          <div className="od-card">
            <div className="od-card-title"><Truck size={13} /> 承运信息</div>
            <div className="od-info-row"><span>承运商</span><em>{info.logistics.carrier}</em></div>
            <div className="od-info-row">
              <span>运单号</span>
              <em className="tracking-no">{info.logistics.trackingNo}<CopyButton text={info.logistics.trackingNo} onCopied={() => setNotice("运单号已复制。")} /></em>
            </div>
            <div className="od-info-row"><span>当前节点</span><em><em className="status-pill">{currentNode?.label ?? "—"}</em></em></div>
            <div className="od-info-row"><span>发出地</span><em>中国 · {ORIGINS[hashSeed(info.orderNo) % ORIGINS.length]}</em></div>
          </div>
          {recipientCard}
        </div>

        <div className="od-card">
          <div className="od-card-title"><Plane size={13} /> 跨境物流全链路</div>
          <div className="logi-timeline">
            {phases.map((phase) => {
              const NodeIcon = NODE_ICONS[phase.key] ?? Truck;
              return (
                <div key={phase.key} className={`logi-row ${phase.state}`}>
                  <span className="logi-dot"><NodeIcon size={13} /></span>
                  <div className="logi-info">
                    <strong>{phase.label}</strong>
                    <small>{phase.at ? fmtShort(phase.at) : "待更新"}</small>
                    <div className="logi-events">
                      {phase.events.map((event, index) => (
                        <div key={index} className={`logi-event ${event.state}`}>
                          <small>{event.at ? fmtShort(event.at) : ""}</small>
                          <p>{event.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <SuggestionComposer
          session={session}
          orderId={current.id}
          conversationId={current.conversationId}
          conversationOpen={conversationOpen}
          type="logistics_update"
          icon={Truck}
          title="物流同步"
          hint="AI 将根据当前物流节点与买家资料，生成 3 版物流通知或安抚话术，发出去是一张物流通知卡片。"
          buttonLabel="物流同步"
          onSent={(delivered) => setNotice(delivered === "live" ? "物流通知已发到聊天里，可到客服工作台查看买家回复。" : "物流通知已发给买家；买家回复后会出现在客服工作台的接待中。")}
        />
      </div>
    );
  }

  function renderReviewTab(current: StudentOrder, info: OrderInfo, conversationOpen: boolean) {
    if (!info.review) {
      return (
        <div className="order-detail-body">
          <div className="order-empty">
            <Star size={26} />
            <strong>买家尚未评价</strong>
            <p>订单完成后买家可能留下评价，全店评价可在「评价」页集中查看与处理。</p>
          </div>
        </div>
      );
    }
    const negative = info.review.rating <= 3;
    const replied = replies[current.id];
    return (
      <div className="order-detail-body">
        {/* 评价页签不套卡片：评价、商家回复、回复框一路往下排（同评价页） */}
        <div className="od-rv">
          <div className="review-head">
            <BuyerAvatar buyer={current.buyer} />
            <div>
              <strong>{current.buyer.name}</strong>
              <div className="review-stars">
                {[1, 2, 3, 4, 5].map((value) => (
                  <Star
                    key={value}
                    size={15}
                    fill={value <= info.review!.rating ? "#f2b01e" : "none"}
                    color={value <= info.review!.rating ? "#f2b01e" : "#c6d2d8"}
                  />
                ))}
                <small>{fmtDateTime(info.review.at)}</small>
              </div>
            </div>
            <span className="review-flag">
              {info.review.revised ? (
                <em className="status-pill" title={info.review.original?.content ?? undefined}>
                  已改评{typeof info.review.original?.rating === "number" ? ` · 原 ${info.review.original.rating} 星` : ""}
                </em>
              ) : null}
              <em className={negative ? "status-pill warn-pill" : "status-pill green"}>
                {negative ? "差评" : "好评"}
              </em>
            </span>
          </div>
          <p className="review-content">{info.review.content}</p>
          {info.review.revised && info.review.original?.content ? (
            <p className="rv-original muted">原评价：{info.review.original.content}</p>
          ) : null}
          {replied ? (
            <div className="rv3-reply">
              <div className="h"><b>商家回复</b><span className="muted">{fmtDateTime(replied.at)}</span></div>
              <p>{replied.text}</p>
            </div>
          ) : null}
          <ReviewReply
            session={session}
            orderId={current.id}
            conversationId={current.conversationId}
            conversationOpen={conversationOpen}
            buyerLanguage={current.buyer.language}
            onSent={(text) => {
              setReplies((prev) => ({ ...prev, [current.id]: { text, at: new Date().toISOString() } }));
              setNotice("回复已发布。");
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="sx-root">
      <HeaderTabs
        value={statusTab}
        onChange={(next) => { setStatusTab(next); setDetail(null); }}
        items={STATUS_TABS.map(([value, label]) => ({
          id: value,
          label: <>{label}{counts[value] ? <TabCount n={counts[value]!} /> : null}</>,
        }))}
      />
      {notice ? <p className="sx-notice" role="status">{notice}</p> : null}
      {error ? <p className="sx-error" role="alert">{error}</p> : null}
      {active ? <div className="od2-detail">{renderDetail(active)}</div> : renderList()}
    </div>
  );
}
