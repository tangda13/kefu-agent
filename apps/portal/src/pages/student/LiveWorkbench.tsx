import {
  BookText,
  Calculator,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Film,
  ImagePlus,
  Languages,
  ListTree,
  MapPin,
  Mic,
  Package2,
  Paperclip,
  Search,
  Send,
  ShoppingCart,
  Smile,
  StickyNote,
  TicketPercent,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUSINESS_STAGE_LABELS } from "@cecs/contracts";
import {
  ApiError,
  assetUrl,
  createConversation,
  fetchConversationMessages,
  fetchConversationOrders,
  fetchConversations,
  fetchPhrases,
  fetchStoreCoupons,
  fetchStoreProducts,
  fetchStudentTasks,
  fetchWorkbenchStats,
  postConversationMessage,
  recognizeAudio,
  requestMessageTts,
  streamAttachmentMessage,
  streamCardMessage,
  streamVoiceMessage,
  streamConversationOpening,
  streamConversationReply,
  translateMessage,
  updateOrder,
  type BuyerPublicView,
  type ConversationMessage,
  type ConversationOrder,
  type ConversationSummary,
  type OrderAddress,
  type Session,
  type StoreCoupon,
  type StoreProduct,
  type StudentTask,
  type WorkbenchStats,
} from "../../api/client";
import { OPEN_CONVERSATION_EVENT, OPEN_CONVERSATION_KEY } from "../../App";
import { WavRecorder } from "../../api/recorder";

type StatusTab = "all" | "unreplied" | "closed";
type AssignTab = "assigned" | "unassigned";
type PanelTab = "profile" | "order" | "product" | "coupon";
type ProductTab = "store" | "browsed";

const CUSTOMER_MAIN_TAG: Record<string, string> = {
  潜在意向客: "新客",
  复购老客: "老客户",
  粉丝客: "粉丝会员",
  沉睡客: "沉睡客",
};

const RETURN_LABELS: Record<string, string> = {
  requested: "待客户退货",
  returning: "退货运输中",
  refunded: "已退款",
};

/** 订单筛选键：售后中优先于物流状态 */
function orderFilterKey(detail: ConversationOrder["detail"]): string {
  return detail.returnStatus ? "after_sale" : detail.status;
}

function orderBadgeLabel(detail: ConversationOrder["detail"]): string {
  return detail.returnStatus ? "售后中" : detail.statusLabel;
}

const ORDER_FILTERS = [
  ["all", "全部"],
  ["pending_payment", "待付款"],
  ["paid", "待发货"],
  ["in_transit", "已发货"],
  ["delivered", "已送达"],
  ["after_sale", "售后中"],
  ["completed", "已完成"],
] as const;

const EMOJIS = [
  "😀", "😄", "😊", "🙂", "😉", "😍", "🤝", "👍",
  "🙏", "🎉", "✅", "❗", "❓", "💡", "📦", "🚚",
  "✈️", "💳", "🔥", "⭐", "😅", "😂", "🤔", "😐",
  "😢", "😮", "🙌", "👏", "💬", "🕐", "🌟", "❤️",
];

const AUTO_TRANSLATE_KEY = "cecs.autoTranslate";

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function listTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (date.toDateString() === new Date().toDateString()) return timeLabel(iso);
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function dateTimeLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function durationLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function fileSizeLabel(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

/** 稳定散列：买家浏览记录按会话种子确定，切换会话不变 */
function hashSeed(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

function BuyerAvatar({ buyer, size = "" }: { buyer: BuyerPublicView | null; size?: "" | "tiny" | "xl" }) {
  if (buyer?.avatarUrl) {
    return (
      <span className={`photo-avatar ${size}`.trim()}>
        <img src={buyer.avatarUrl} alt={`${buyer.name} 头像`} />
      </span>
    );
  }
  return <span className={`avatar ${size === "xl" ? "xl" : size === "tiny" ? "tiny" : ""}`.trim()}>{buyer?.name?.slice(0, 1) ?? "?"}</span>;
}

function mediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith("blob:") ? url : assetUrl(url) ?? undefined;
}

function MessageBody({ message, onPlayVoice }: { message: ConversationMessage; onPlayVoice?: (url: string) => void }) {
  if (message.kind === "voice" && message.payload) {
    const voice = message.payload as { audioUrl?: string; durationMs?: number; transcript?: string };
    const seconds = Math.max(1, Math.round((voice.durationMs ?? 0) / 1000));
    return (
      <div className="voice-bubble">
        <button
          className="voice-play"
          onClick={() => voice.audioUrl && onPlayVoice?.(voice.audioUrl)}
          disabled={!voice.audioUrl}
          aria-label="播放语音"
        >
          ▶ {seconds}″
        </button>
        {voice.transcript ? <small>{voice.transcript}</small> : null}
      </div>
    );
  }
  if (message.kind === "image" && message.payload) {
    const media = message.payload as { url?: string; name?: string };
    return <img className="msg-image" src={mediaUrl(media.url)} alt={media.name ?? "图片"} />;
  }
  if (message.kind === "video" && message.payload) {
    const media = message.payload as { url?: string };
    return <video className="msg-video" src={mediaUrl(media.url)} controls preload="metadata" />;
  }
  if (message.kind === "file" && message.payload) {
    const media = message.payload as { url?: string; name?: string; size?: number };
    return (
      <a className="msg-file" href={mediaUrl(media.url)} target="_blank" rel="noreferrer">
        <Paperclip size={16} />
        <span>
          <strong>{media.name ?? "附件"}</strong>
          <small>{media.size ? fileSizeLabel(media.size) : ""}</small>
        </span>
      </a>
    );
  }
  if (message.kind === "order" && message.payload) {
    const order = message.payload as {
      orderNo?: string;
      productName?: string;
      productSpec?: string;
      productImage?: string | null;
      quantity?: number;
      totalAmount?: number;
      currency?: string;
      statusLabel?: string;
      returnStatus?: string | null;
    };
    return (
      <div className="card-message order-card-message">
        {order.productImage ? (
          <img className="product-photo" src={assetUrl(order.productImage) ?? undefined} alt={order.productName} />
        ) : (
          <span className="product-thumb"><Package2 size={22} /></span>
        )}
        <div>
          <strong>{order.productName} ×{order.quantity ?? 1}</strong>
          <small>#{order.orderNo}</small>
          <em>{order.currency} {order.totalAmount} · {order.returnStatus ? "售后中" : order.statusLabel}</em>
        </div>
      </div>
    );
  }
  if ((message.kind === "product" || message.kind === "invite") && message.payload) {
    const product = message.payload as unknown as StoreProduct;
    return (
      <div className={message.kind === "invite" ? "card-message invite-card" : "card-message"}>
        {product.imageUrl ? (
          <img className="product-photo" src={assetUrl(product.imageUrl) ?? undefined} alt={product.name} />
        ) : (
          <span className="product-thumb" style={{ background: product.tone }}><Package2 size={22} /></span>
        )}
        <div>
          <strong>{product.name}</strong>
          <small>SKU {product.id} · {product.spec}</small>
          <em>USD {product.price}{message.kind === "product" ? ` · 已售 ${product.sales}` : ""}</em>
          {message.kind === "invite" ? <span className="invite-tag"><ShoppingCart size={11} /> 已邀请下单 · 点击卡片即可下单</span> : null}
        </div>
      </div>
    );
  }
  if (message.kind === "coupon" && message.payload) {
    const coupon = message.payload as unknown as StoreCoupon;
    return (
      <div className="card-message coupon">
        <span className="product-thumb coupon-thumb"><TicketPercent size={22} /></span>
        <div>
          <strong>{coupon.title}</strong>
          <small>{coupon.rule} · {coupon.scope}</small>
          <em>有效期 {coupon.validDays} 天</em>
        </div>
      </div>
    );
  }
  return <p>{message.content}</p>;
}

export function LiveWorkbench({ session, initialTaskId }: { session: Session; initialTaskId?: string | null }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [closedConversations, setClosedConversations] = useState<ConversationSummary[]>([]);
  const [tasks, setTasks] = useState<StudentTask[]>([]);
  const [stats, setStats] = useState<WorkbenchStats | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignTab, setAssignTab] = useState<AssignTab>("assigned");
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [searchText, setSearchText] = useState("");
  const [panelTab, setPanelTab] = useState<PanelTab>("profile");
  const [phrases, setPhrases] = useState<string[] | null>(null);
  const [showPhrases, setShowPhrases] = useState(false);
  const [phraseFilter, setPhraseFilter] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [coupons, setCoupons] = useState<StoreCoupon[]>([]);
  const [productTab, setProductTab] = useState<ProductTab>("store");
  const [autoTranslate, setAutoTranslate] = useState(() => localStorage.getItem(AUTO_TRANSLATE_KEY) === "1");
  // 买家结束的会话（本地即时标记，等待列表刷新）
  const [closedLocal, setClosedLocal] = useState<Set<string>>(new Set());
  // 可拖拽分栏宽度（localStorage 持久）
  const [railWidth, setRailWidth] = useState(() => {
    const value = Number(localStorage.getItem("cecs.ws.railW"));
    return value >= 200 && value <= 380 ? value : 252;
  });
  const [panelWidth, setPanelWidth] = useState(() => {
    const value = Number(localStorage.getItem("cecs.ws.panelW"));
    return value >= 280 && value <= 500 ? value : 328;
  });
  // 商品面板：规格属性 / 算价 展开
  const [specOpen, setSpecOpen] = useState<string | null>(null);
  const [calcOpen, setCalcOpen] = useState<string | null>(null);
  const [calcQty, setCalcQty] = useState(1);
  // 订单页签
  const [orders, setOrders] = useState<ConversationOrder[] | null>(null);
  const [orderFilter, setOrderFilter] = useState<string>("all");
  const [orderSearch, setOrderSearch] = useState("");
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [orderAction, setOrderAction] = useState<{ id: string; type: "remark" | "address" } | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");
  const [addressDraft, setAddressDraft] = useState<OrderAddress>({ recipient: "", line1: "", city: "", country: "", phone: "" });
  const [savingOrder, setSavingOrder] = useState(false);

  const startedForTask = useRef<string | null>(null);
  const openingRequested = useRef<Set<string>>(new Set());
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const autoTranslateRef = useRef(autoTranslate);
  autoTranslateRef.current = autoTranslate;
  const translatingRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const recorderRef = useRef<WavRecorder | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "recognizing">("idle");
  const [pendingVoice, setPendingVoice] = useState<{ blob: Blob; seconds: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const railWidthRef = useRef(railWidth);
  railWidthRef.current = railWidth;
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  // 学生连发批量窗口：发送后 2s 检测窗口，检测到打字则顺延；草稿滞留最多顺延 15s
  const replyTimers = useRef<Map<string, number>>(new Map());
  const replyDeadlines = useRef<Map<string, number>>(new Map());
  const inputRef = useRef("");
  inputRef.current = input;

  useEffect(() => {
    const timers = replyTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // 拖拽调整左右分栏宽度
  function startResize(side: "rail" | "panel", event: React.MouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "rail" ? railWidthRef.current : panelWidthRef.current;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      if (side === "rail") setRailWidth(Math.min(380, Math.max(200, startWidth + delta)));
      else setPanelWidth(Math.min(500, Math.max(280, startWidth - delta)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = "";
      localStorage.setItem("cecs.ws.railW", String(railWidthRef.current));
      localStorage.setItem("cecs.ws.panelW", String(panelWidthRef.current));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const pool = statusTab === "closed" ? closedConversations : conversations;
  const active = pool.find((item) => item.id === activeId)
    ?? conversations.find((item) => item.id === activeId)
    ?? closedConversations.find((item) => item.id === activeId)
    ?? null;

  const loadStats = useCallback(() => {
    fetchWorkbenchStats(session).then(setStats).catch(() => undefined);
  }, [session]);

  const loadConversations = useCallback(async () => {
    try {
      const [conversationList, taskList] = await Promise.all([
        fetchConversations(session),
        fetchStudentTasks(session),
      ]);
      setConversations(conversationList);
      setTasks(taskList);
      setActiveId((current) => current ?? conversationList[0]?.id ?? null);
      loadStats();
      return conversationList;
    } catch (cause) {
      setNotice(errorText(cause));
      return [];
    }
  }, [session, loadStats]);

  useEffect(() => {
    void loadConversations();
    fetchStoreProducts(session).then(setProducts).catch(() => undefined);
    fetchStoreCoupons(session).then(setCoupons).catch(() => undefined);
  }, [loadConversations, session]);

  useEffect(() => {
    if (statusTab !== "closed") return;
    fetchConversations(session, "closed").then(setClosedConversations).catch(() => undefined);
  }, [session, statusTab]);

  // 顶栏「消息」中的教师指导 → 跳转到对应会话
  useEffect(() => {
    const applyPending = () => {
      const id = sessionStorage.getItem(OPEN_CONVERSATION_KEY);
      if (!id) return;
      sessionStorage.removeItem(OPEN_CONVERSATION_KEY);
      setAssignTab("assigned");
      setStatusTab("all");
      setActiveId(id);
    };
    applyPending();
    window.addEventListener(OPEN_CONVERSATION_EVENT, applyPending);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, applyPending);
  }, []);

  useEffect(() => {
    if (!initialTaskId || startedForTask.current === initialTaskId) return;
    startedForTask.current = initialTaskId;
    void (async () => {
      const existing = conversations.find((item) => item.taskId === initialTaskId);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      await acceptIncoming(initialTaskId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTaskId, conversations]);

  useEffect(() => {
    if (!activeId) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    setMessages(null);
    fetchConversationMessages(session, activeId)
      .then((rows) => {
        if (cancelled) return;
        setMessages(
          autoTranslateRef.current
            ? rows.map((row) => (row.translation ? { ...row, showTranslation: true } : row))
            : rows,
        );
      })
      .catch((cause) => setNotice(errorText(cause)));
    return () => {
      cancelled = true;
    };
  }, [session, activeId]);

  // 当前买家的全部订单（关联订单 + 历史订单）
  useEffect(() => {
    if (!activeId) {
      setOrders(null);
      return;
    }
    let cancelled = false;
    setOrders(null);
    setExpandedOrder(null);
    setOrderAction(null);
    setOrderFilter("all");
    setOrderSearch("");
    fetchConversationOrders(session, activeId)
      .then((rows) => {
        if (!cancelled) setOrders(rows);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session, activeId]);

  // 买家进线后主动发起第一条消息
  useEffect(() => {
    if (!activeId || messages === null || messages.length > 0) return;
    if (active?.status === "closed") return;
    if (openingRequested.current.has(activeId)) return;
    openingRequested.current.add(activeId);
    const cid = activeId;
    setStreamingText("");
    const handlers = appendBuyerStream(cid);
    void streamConversationOpening(session, cid, {
      ...handlers,
      onError: (message) => {
        openingRequested.current.delete(cid);
        handlers.onError(message);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, activeId, messages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamingText]);

  // 自动翻译：开启后为最新买家消息补充译文（服务端缓存复用）
  const autoTranslateLatest = useCallback(async (cid: string) => {
    try {
      const rows = await fetchConversationMessages(session, cid);
      if (activeIdRef.current !== cid) return;
      const target = [...rows].reverse().find((row) => row.sender === "buyer" && (!row.kind || row.kind === "text"));
      const withShown = (list: ConversationMessage[]) =>
        list.map((row) => (row.translation ? { ...row, showTranslation: true } : row));
      if (!target) {
        setMessages(withShown(rows));
        return;
      }
      let translation = target.translation;
      if (!translation) translation = (await translateMessage(session, cid, target.id)).translation;
      if (activeIdRef.current !== cid) return;
      setMessages(
        withShown(rows).map((row) =>
          row.id === target.id ? { ...row, translation, showTranslation: true } : row,
        ),
      );
    } catch {
      /* 自动翻译失败静默，学生可手动点翻译 */
    }
  }, [session]);

  // 开启自动翻译后，为已加载的最新买家消息补译
  useEffect(() => {
    if (!autoTranslate || !activeId || !messages) return;
    const target = [...messages].reverse().find(
      (row) => row.sender === "buyer" && (!row.kind || row.kind === "text") && !row.translation,
    );
    if (!target || target.id.startsWith("buyer-") || target.id.startsWith("local-")) return;
    if (translatingRef.current.has(target.id)) return;
    translatingRef.current.add(target.id);
    translateMessage(session, activeId, target.id)
      .then(({ translation }) => {
        setMessages((current) =>
          (current ?? []).map((row) =>
            row.id === target.id ? { ...row, translation, showTranslation: true } : row,
          ),
        );
      })
      .catch(() => undefined)
      .finally(() => translatingRef.current.delete(target.id));
  }, [autoTranslate, activeId, messages, session]);

  function toggleAutoTranslate() {
    setAutoTranslate((value) => {
      const next = !value;
      localStorage.setItem(AUTO_TRANSLATE_KEY, next ? "1" : "0");
      return next;
    });
  }

  // 接入未分配的新客户（背后对应实训任务，界面不体现）
  async function acceptIncoming(taskId: string) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const created = await createConversation(session, { taskId });
      await loadConversations();
      setAssignTab("assigned");
      setStatusTab("all");
      setActiveId(created.id);
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function appendBuyerStream(cid: string) {
    let accumulated = "";
    let bubbleSeq = 0;
    const pushBubble = () => {
      const text = accumulated.trim();
      accumulated = "";
      if (!text || activeIdRef.current !== cid) return;
      bubbleSeq += 1;
      setMessages((current) => [
        ...(current ?? []),
        { id: `buyer-${Date.now()}-${bubbleSeq}`, sender: "buyer", content: text, createdAt: new Date().toISOString() },
      ]);
    };
    return {
      onDelta: (delta: string) => {
        accumulated += delta;
        if (activeIdRef.current === cid) setStreamingText(accumulated);
      },
      // 买家连发：当前气泡定格为一条消息，继续流式下一条
      onSplit: () => {
        pushBubble();
        if (activeIdRef.current === cid) setStreamingText("");
      },
      onDone: (_metrics: unknown, extra?: { closed?: boolean }) => {
        pushBubble();
        if (activeIdRef.current === cid) setStreamingText(null);
        // 买家离开：会话由客户结束（真实客服无权挂断），刷新列表并保留当前对话展示
        if (extra?.closed) {
          setClosedLocal((current) => new Set(current).add(cid));
          fetchConversations(session, "closed").then(setClosedConversations).catch(() => undefined);
        }
        void loadConversations();
        if (autoTranslateRef.current) void autoTranslateLatest(cid);
      },
      onError: (message: string) => {
        if (activeIdRef.current === cid) {
          setNotice(message);
          setStreamingText(null);
        }
      },
    };
  }

  // 学生连发批量窗口：发送后开 2s 检测窗口——继续打字或再次发送都重置窗口；
  // 窗口到期时若输入框仍有草稿（在思考）再顺延，但最多等 15s，防止弃稿导致买家永远不回。
  const REPLY_WINDOW_MS = 2000;
  const REPLY_MAX_WAIT_MS = 15_000;

  function armReplyTimer(cid: string, delay: number) {
    const timers = replyTimers.current;
    const existing = timers.get(cid);
    if (existing) window.clearTimeout(existing);
    timers.set(cid, window.setTimeout(() => fireReply(cid), delay));
  }

  function fireReply(cid: string) {
    const stillComposing = activeIdRef.current === cid && inputRef.current.trim().length > 0;
    const deadline = replyDeadlines.current.get(cid) ?? 0;
    if (stillComposing && Date.now() < deadline) {
      armReplyTimer(cid, REPLY_WINDOW_MS);
      return;
    }
    replyTimers.current.delete(cid);
    replyDeadlines.current.delete(cid);
    if (activeIdRef.current === cid) setStreamingText("");
    void streamConversationReply(session, cid, appendBuyerStream(cid));
  }

  function scheduleReply(cid: string) {
    replyDeadlines.current.set(cid, Date.now() + REPLY_MAX_WAIT_MS);
    armReplyTimer(cid, REPLY_WINDOW_MS);
  }

  // 打字检测：批量窗口内每次击键把窗口重置回 2s（还在输入 → 买家继续等）
  function noteTyping() {
    const cid = activeIdRef.current;
    if (cid && replyTimers.current.has(cid)) armReplyTimer(cid, REPLY_WINDOW_MS);
  }

  async function send() {
    const text = input.trim();
    if (!text || !activeId || busy || streamingText !== null) return;
    setInput("");
    const cid = activeId;
    setMessages((current) => [
      ...(current ?? []),
      { id: `local-${Date.now()}`, sender: "student", content: text, createdAt: new Date().toISOString() },
    ]);
    try {
      await postConversationMessage(session, cid, text);
      scheduleReply(cid);
    } catch (cause) {
      setNotice(errorText(cause));
    }
  }

  async function sendCard(type: "product" | "coupon" | "order" | "invite", refId: string) {
    if (!activeId || busy || streamingText !== null) return;
    const cid = activeId;
    let payload: Record<string, unknown> | undefined;
    if (type === "product" || type === "invite") payload = products.find((item) => item.id === refId) as unknown as Record<string, unknown>;
    else if (type === "coupon") payload = coupons.find((item) => item.id === refId) as unknown as Record<string, unknown>;
    else {
      const order = (orders ?? []).find((item) => item.id === refId);
      if (order) {
        payload = {
          orderNo: order.detail.orderNo,
          productName: order.detail.productName,
          productSpec: order.detail.productSpec,
          productImage: order.detail.productImage ?? null,
          quantity: order.detail.quantity,
          totalAmount: order.detail.totalAmount,
          currency: order.detail.currency,
          statusLabel: order.detail.statusLabel,
          returnStatus: order.detail.returnStatus ?? null,
        };
      }
    }
    setMessages((current) => [
      ...(current ?? []),
      {
        id: `local-${Date.now()}`,
        sender: "student",
        content: "",
        kind: type,
        payload: payload ?? null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setStreamingText("");
    await streamCardMessage(session, cid, type, refId, appendBuyerStream(cid));
  }

  async function sendAttachment(kind: "image" | "video" | "file", file: File) {
    if (!activeId || busy || streamingText !== null) return;
    const cid = activeId;
    const localUrl = URL.createObjectURL(file);
    const label = kind === "image" ? "[图片]" : kind === "video" ? "[视频]" : "[文件]";
    setMessages((current) => [
      ...(current ?? []),
      {
        id: `local-${Date.now()}`,
        sender: "student",
        content: label,
        kind,
        payload: { url: localUrl, name: file.name, size: file.size, mime: file.type },
        createdAt: new Date().toISOString(),
      },
    ]);
    setStreamingText("");
    await streamAttachmentMessage(session, cid, file, kind, appendBuyerStream(cid));
  }

  function onAttachmentChosen(kind: "image" | "video" | "file", event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void sendAttachment(kind, file);
  }

  async function toggleTranslation(message: ConversationMessage) {
    if (!activeId) return;
    if (message.translation) {
      setMessages((current) =>
        (current ?? []).map((item) =>
          item.id === message.id ? { ...item, showTranslation: !item.showTranslation } : item,
        ),
      );
      return;
    }
    try {
      let targetId = message.id;
      if (message.id.startsWith("buyer-") || message.id.startsWith("local-")) {
        const rows = await fetchConversationMessages(session, activeId);
        const target = [...rows]
          .reverse()
          .find((item) => item.sender === "buyer" && item.content === message.content);
        if (!target) {
          setMessages(rows);
          return;
        }
        targetId = target.id;
        setMessages(rows);
      }
      const { translation } = await translateMessage(session, activeId, targetId);
      setMessages((current) =>
        (current ?? []).map((item) =>
          item.id === targetId ? { ...item, translation, showTranslation: true } : item,
        ),
      );
    } catch (cause) {
      setNotice(errorText(cause));
    }
  }

  // 学生语音输入：按住说话 → 整段识别 → 文字进输入框（可修改后发送）
  async function startVoiceInput() {
    if (!activeId || voiceState !== "idle") return;
    try {
      const recorder = new WavRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setVoiceState("recording");
    } catch {
      setNotice("无法访问麦克风，请检查浏览器权限。");
    }
  }

  async function stopVoiceInput() {
    if (!activeId || voiceState !== "recording" || !recorderRef.current) return;
    try {
      const wav = await recorderRef.current.stop();
      recorderRef.current = null;
      if (wav.size < 8000) {
        setNotice("录音过短，请按住说话。");
        return;
      }
      // 录音完成，交由学生选择：直发语音 / 转文字 / 取消
      setPendingVoice({ blob: wav, seconds: Math.max(1, Math.round((wav.size - 44) / 32000)) });
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setVoiceState("idle");
    }
  }

  async function voiceToText() {
    if (!activeId || !pendingVoice) return;
    setVoiceState("recognizing");
    try {
      const { text } = await recognizeAudio(session, activeId, pendingVoice.blob);
      if (text.trim()) setInput((current) => (current ? `${current} ${text.trim()}` : text.trim()));
      else setNotice("未识别到有效语音，请重试。");
      setPendingVoice(null);
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setVoiceState("idle");
    }
  }

  async function sendVoice() {
    if (!activeId || !pendingVoice || streamingText !== null) return;
    const cid = activeId;
    const { blob, seconds } = pendingVoice;
    setPendingVoice(null);
    const localUrl = URL.createObjectURL(blob);
    setMessages((current) => [
      ...(current ?? []),
      {
        id: `local-${Date.now()}`,
        sender: "student",
        content: "[语音消息]",
        kind: "voice",
        payload: { audioUrl: localUrl, durationMs: seconds * 1000, transcript: "" },
        createdAt: new Date().toISOString(),
      },
    ]);
    setStreamingText("");
    await streamVoiceMessage(session, cid, blob, appendBuyerStream(cid));
  }

  function playVoice(url: string) {
    audioRef.current?.pause();
    const audio = new Audio(url.startsWith("blob:") ? url : assetUrl(url) ?? undefined);
    audioRef.current = audio;
    void audio.play();
  }

  // 买家消息语音播报（TTS 音频缓存复用）
  async function playTts(message: ConversationMessage) {
    if (!activeId) return;
    if (playingId === message.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    try {
      let targetId = message.id;
      if (message.id.startsWith("buyer-")) {
        const rows = await fetchConversationMessages(session, activeId);
        const target = [...rows].reverse().find((item) => item.sender === "buyer" && item.content === message.content);
        if (!target) return;
        targetId = target.id;
        setMessages(rows);
        message = target;
      }
      setPlayingId(message.id);
      const { audioUrl } = await requestMessageTts(session, activeId, targetId);
      audioRef.current?.pause();
      const audio = new Audio(assetUrl(audioUrl) ?? undefined);
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      await audio.play();
    } catch (cause) {
      setNotice(errorText(cause));
      setPlayingId(null);
    }
  }

  function openPhrasePanel() {
    setShowPhrases((value) => !value);
    setShowEmoji(false);
    if (phrases === null) {
      fetchPhrases(session).then(setPhrases).catch(() => setPhrases([]));
    }
  }

  // 订单操作：备注 / 改地址
  function openOrderAction(order: ConversationOrder, type: "remark" | "address") {
    setOrderAction({ id: order.id, type });
    if (type === "remark") setRemarkDraft(order.detail.remark ?? "");
    else
      setAddressDraft(
        order.detail.address ?? { recipient: active?.buyer.name ?? "", line1: "", city: "", country: "", phone: "" },
      );
  }

  async function saveOrderAction() {
    if (!orderAction) return;
    setSavingOrder(true);
    try {
      const patch =
        orderAction.type === "remark" ? { remark: remarkDraft } : { address: addressDraft };
      const { detail } = await updateOrder(session, orderAction.id, patch);
      setOrders((current) => (current ?? []).map((item) => (item.id === orderAction.id ? { ...item, detail } : item)));
      setOrderAction(null);
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setSavingOrder(false);
    }
  }

  function copyOrderNo(orderNo: string) {
    void navigator.clipboard?.writeText(orderNo).catch(() => undefined);
  }

  // 未分配 = 尚未接入的新客户进线（背后是待开始的实训任务）
  const incomingQueue = tasks.filter((task) => task.progressStatus === "todo");

  const visibleConversations = useMemo(() => {
    let list = pool;
    if (statusTab === "unreplied") list = list.filter((item) => item.unreplied);
    const query = searchText.trim().toLowerCase();
    if (query) list = list.filter((item) => item.buyer.name.toLowerCase().includes(query));
    return list;
  }, [pool, statusTab, searchText]);

  const visibleOrders = useMemo(() => {
    let list = orders ?? [];
    if (orderFilter !== "all") list = list.filter((item) => orderFilterKey(item.detail) === orderFilter);
    const query = orderSearch.trim().toLowerCase();
    if (query) list = list.filter((item) => item.detail.orderNo.toLowerCase().includes(query));
    return list;
  }, [orders, orderFilter, orderSearch]);

  // 买家浏览过的商品：按会话种子稳定抽取（同一会话内不变）
  const browsedProducts = useMemo(() => {
    if (!activeId || products.length === 0) return [];
    const count = 2 + (hashSeed(activeId) % 3);
    return [...products]
      .map((product) => ({ product, key: hashSeed(activeId + product.id) }))
      .sort((a, b) => a.key - b.key)
      .slice(0, Math.min(count, products.length))
      .map((entry) => entry.product);
  }, [activeId, products]);

  const buyer = active?.buyer ?? null;
  const isClosed = active?.status === "closed" || (activeId !== null && closedLocal.has(activeId));
  const mainTag = buyer ? CUSTOMER_MAIN_TAG[buyer.customerType] ?? buyer.customerType : "";
  const visibleMessages = (messages ?? []).filter((message) => message.sender !== "teacher");
  const composerDisabled = !active || isClosed || streamingText !== null;

  const kpiDetails: Array<[string, string]> = [
    ["12 小时响应率", stats?.twelveHourResponseRate != null ? `${stats.twelveHourResponseRate}%` : "—"],
    ["满意率", stats?.satisfactionRate != null ? `${stats.satisfactionRate}%` : "—"],
    ["平均响应时长", durationLabel(stats?.avgResponseSeconds)],
    ["今日接待人数", String(stats?.todayConversations ?? "—")],
    ["询单支付金额", `USD ${(stats?.inquiryPaidAmount ?? 0).toFixed(2)}`],
    ["付款人数", String(stats?.paidBuyers ?? "—")],
    ["询单转化率", stats?.conversionRate != null ? `${stats.conversionRate}%` : "—"],
  ];

  return (
    <div className="workbench-page">
      <header className="workbench-topline">
        <div className="kpi-strip">
          <div><span>今日接待</span><strong>{stats?.todayConversations ?? "—"}</strong></div>
          <div><span>平均响应时长</span><strong>{durationLabel(stats?.avgResponseSeconds)}</strong></div>
          <div className={stats && stats.unreplied > 0 ? "warn" : ""}><span>未回复</span><strong>{stats?.unreplied ?? "—"}</strong></div>
          <div><span>满意率</span><strong>{stats?.satisfactionRate != null ? `${stats.satisfactionRate}%` : "—"}</strong></div>
          <button className="text-button kpi-toggle" onClick={() => setStatsOpen((value) => !value)}>
            {statsOpen ? <>收起详情 <ChevronUp size={14} /></> : <>查看详情 <ChevronDown size={14} /></>}
          </button>
        </div>
      </header>
      {statsOpen ? (
        <div className="kpi-details">
          {kpiDetails.map(([label, value]) => (
            <div key={label}><span>{label}</span><strong>{value}</strong></div>
          ))}
        </div>
      ) : null}
      {notice ? <div className="provider-notice"><CircleAlert size={17} />{notice}</div> : null}
      <div
        className="workbench-grid"
        style={{ gridTemplateColumns: `${railWidth}px 6px minmax(360px, 1fr) 6px ${panelWidth}px` }}
      >
        <aside className="conversation-rail live">
          <div className="rail-controls">
            <div className="rail-search">
              <Search size={15} />
              <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索所有聊天记录…" aria-label="搜索会话" />
            </div>
            <div className="rail-tabs">
              <button className={assignTab === "assigned" ? "active" : ""} onClick={() => setAssignTab("assigned")}>
                已分配 <b className="count">{conversations.length}</b>
              </button>
              <button className={assignTab === "unassigned" ? "active" : ""} onClick={() => setAssignTab("unassigned")}>
                未分配 {incomingQueue.length > 0 ? <b>{incomingQueue.length}</b> : null}
              </button>
            </div>
            {assignTab === "assigned" ? (
              <div className="rail-tabs sub">
                {([["all", "全部"], ["unreplied", "未回复"], ["closed", "已关闭"]] as const).map(([id, label]) => (
                  <button key={id} className={statusTab === id ? "active" : ""} onClick={() => setStatusTab(id)}>
                    {label}
                    {id === "unreplied" && stats && stats.unreplied > 0 ? <b>{stats.unreplied}</b> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="buyer-list">
            {assignTab === "unassigned" ? (
              <>
                {incomingQueue.map((task) => (
                  <div key={task.id} className="incoming-card">
                    <span className="avatar">客</span>
                    <span className="buyer-meta">
                      <span><strong>新买家进线</strong><small>等待接入</small></span>
                      <p>客户正在等待客服接待…</p>
                      <span className="card-tags"><em>{BUSINESS_STAGE_LABELS[task.businessStage]}</em></span>
                    </span>
                    <button className="primary-button compact" disabled={busy} onClick={() => acceptIncoming(task.id)}>接入</button>
                  </div>
                ))}
                {incomingQueue.length === 0 ? <p className="muted rail-empty">暂无待接入的客户。</p> : null}
              </>
            ) : (
              <>
                {visibleConversations.map((item) => (
                  <button
                    key={item.id}
                    className={item.id === activeId ? "buyer-card active" : "buyer-card"}
                    onClick={() => setActiveId(item.id)}
                  >
                    <BuyerAvatar buyer={item.buyer} />
                    <span className="buyer-meta">
                      <span>
                        <strong>{item.buyer.name}</strong>
                        <small>{item.lastMessage ? listTimeLabel(item.lastMessage.createdAt) : listTimeLabel(item.createdAt)}</small>
                      </span>
                      <p>{item.lastMessage ? item.lastMessage.content : "客户已进线…"}</p>
                      <span className="card-tags">
                        {item.scenario?.stage ? <em>{BUSINESS_STAGE_LABELS[item.scenario.stage as never]}</em> : null}
                        <em className="type-tag">{CUSTOMER_MAIN_TAG[item.buyer.customerType] ?? item.buyer.customerType}</em>
                      </span>
                    </span>
                    {item.unreplied && statusTab !== "closed" ? <i className="unread-dot" aria-label="待回复" /> : null}
                  </button>
                ))}
                {visibleConversations.length === 0 ? <p className="muted rail-empty">暂无符合条件的会话。</p> : null}
              </>
            )}
          </div>
        </aside>

        <div className="col-resizer" role="separator" aria-label="拖动调整会话列表宽度" onMouseDown={(event) => startResize("rail", event)} />

        <section className="chat-stage">
          <div className="chat-head">
            <div className="chat-identity">
              <BuyerAvatar buyer={buyer} />
              <span>
                <strong>{buyer?.name ?? "请选择会话"}</strong>
                <p>{buyer ? `${buyer.nationality} · ${buyer.identity}` : "从左侧选择会话或接入新客户"}</p>
              </span>
              {active?.scenario?.stage ? (
                <span className="status-pill head-pill">{BUSINESS_STAGE_LABELS[active.scenario.stage as never]}</span>
              ) : null}
              {isClosed ? <span className="status-pill head-pill closed-pill">已结束</span> : null}
            </div>
          </div>
          <div className="message-list" ref={listRef}>
            {active && messages !== null ? (
              <div className="time-divider"><span>会话已分配给你</span></div>
            ) : null}
            {visibleMessages.map((message) => (
              <div key={message.id} className={`message ${message.sender}`}>
                {message.sender === "buyer" && <BuyerAvatar buyer={buyer} size="tiny" />}
                <div>
                  <MessageBody message={message} onPlayVoice={playVoice} />
                  {message.sender === "buyer" && (!message.kind || message.kind === "text") ? (
                    message.showTranslation && message.translation ? (
                      <div className="msg-translation">
                        <p>{message.translation}</p>
                        <button className="translate-link" onClick={() => void toggleTranslation(message)}>隐藏译文</button>
                      </div>
                    ) : (
                      <button className="translate-link" onClick={() => void toggleTranslation(message)}>
                        <Languages size={12} /> {message.translation ? "显示译文" : "翻译"}
                      </button>
                    )
                  ) : null}
                  {message.sender === "buyer" && (!message.kind || message.kind === "text") ? (
                    <button className="translate-link" onClick={() => void playTts(message)}>
                      <Volume2 size={12} /> {playingId === message.id ? "停止" : "播报"}
                    </button>
                  ) : null}
                  <span>
                    {timeLabel(message.createdAt)}
                    {message.sender === "student" ? <CheckCheck size={13} className="read-tick" /> : null}
                  </span>
                </div>
              </div>
            ))}
            {streamingText !== null && (
              <div className="message buyer">
                <BuyerAvatar buyer={buyer} size="tiny" />
                <div><p>{streamingText || "…"}</p><span>正在输入…</span></div>
              </div>
            )}
            {isClosed ? <div className="time-divider"><span>本次会话已结束 · 客户已离开</span></div> : null}
          </div>
          <div className="composer">
            {showPhrases ? (
              <div className="phrase-panel">
                <div className="phrase-head">
                  <input value={phraseFilter} onChange={(event) => setPhraseFilter(event.target.value)} placeholder="搜索快捷短语…" aria-label="搜索快捷短语" />
                  <button className="text-button" onClick={() => setShowPhrases(false)}>收起</button>
                </div>
                <div className="phrase-list">
                  {(phrases ?? [])
                    .filter((phrase) => phrase.toLowerCase().includes(phraseFilter.toLowerCase()))
                    .slice(0, 30)
                    .map((phrase) => (
                      <button key={phrase} onClick={() => { setInput((current) => (current ? `${current} ${phrase}` : phrase)); setShowPhrases(false); }}>
                        {phrase}
                      </button>
                    ))}
                  {phrases === null ? <p className="muted">加载中…</p> : null}
                </div>
              </div>
            ) : null}
            {showEmoji ? (
              <div className="emoji-panel" role="listbox" aria-label="选择表情">
                {EMOJIS.map((emoji) => (
                  <button key={emoji} onClick={() => { setInput((current) => current + emoji); setShowEmoji(false); }}>{emoji}</button>
                ))}
              </div>
            ) : null}
            {pendingVoice ? (
              <div className="voice-pending">
                <button className="voice-play" onClick={() => playVoice(URL.createObjectURL(pendingVoice.blob))}>▶ {pendingVoice.seconds}″</button>
                <button className="primary-button compact" disabled={voiceState === "recognizing"} onClick={() => void sendVoice()}>发送语音</button>
                <button className="secondary-button compact" disabled={voiceState === "recognizing"} onClick={() => void voiceToText()}>{voiceState === "recognizing" ? "识别中…" : "转文字"}</button>
                <button className="text-button" onClick={() => setPendingVoice(null)}>取消</button>
              </div>
            ) : null}
            <div className="composer-tools">
              <button onClick={() => { setShowEmoji((value) => !value); setShowPhrases(false); }} disabled={composerDisabled} title="发送表情"><Smile size={17} /></button>
              <button onClick={() => imageInputRef.current?.click()} disabled={composerDisabled} title="发送图片"><ImagePlus size={17} /></button>
              <button onClick={() => videoInputRef.current?.click()} disabled={composerDisabled} title="发送视频"><Film size={17} /></button>
              <button onClick={() => fileInputRef.current?.click()} disabled={composerDisabled} title="发送文件"><Paperclip size={17} /></button>
              <button onClick={openPhrasePanel} disabled={!active} title="快捷短语"><BookText size={17} /></button>
              <span className="tools-flex" />
              <button
                className={autoTranslate ? "auto-translate on" : "auto-translate"}
                onClick={toggleAutoTranslate}
                title="自动翻译买家消息"
              >
                <Languages size={15} /> 自动翻译<i className={autoTranslate ? "toggle on" : "toggle"} />
              </button>
              <span>{buyer?.language ?? ""}</span>
            </div>
            <input ref={imageInputRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => onAttachmentChosen("image", event)} />
            <input ref={videoInputRef} type="file" hidden accept="video/mp4,video/webm,video/quicktime" onChange={(event) => onAttachmentChosen("video", event)} />
            <input ref={fileInputRef} type="file" hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.zip,.txt,.csv" onChange={(event) => onAttachmentChosen("file", event)} />
            <textarea
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                noteTyping();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={!active ? "请先选择会话" : isClosed ? "会话已结束（客户已离开）" : "在此输入你的消息，Enter 发送，Shift + Enter 换行"}
              disabled={composerDisabled}
            />
            <div className="composer-actions">
              <button
                className={voiceState === "recording" ? "voice-button recording" : "voice-button"}
                disabled={!active || isClosed || voiceState === "recognizing"}
                onMouseDown={() => void startVoiceInput()}
                onMouseUp={() => void stopVoiceInput()}
                onMouseLeave={() => { if (voiceState === "recording") void stopVoiceInput(); }}
                onTouchStart={(event) => { event.preventDefault(); void startVoiceInput(); }}
                onTouchEnd={() => void stopVoiceInput()}
              >
                <Mic size={15} />
                {voiceState === "recording" ? "松开结束" : voiceState === "recognizing" ? "识别中…" : "按住说话"}
              </button>
              <span>{input.length} / 1000</span>
              <button className="primary-button compact" onClick={() => void send()} disabled={composerDisabled}>
                发送 <Send size={16} />
              </button>
            </div>
          </div>
        </section>

        <div className="col-resizer" role="separator" aria-label="拖动调整信息面板宽度" onMouseDown={(event) => startResize("panel", event)} />

        <aside className="context-panel">
          {buyer ? (
            <div className="panel-buyer-head">
              <BuyerAvatar buyer={buyer} />
              <span>
                <strong>{buyer.name}</strong>
                <span className="profile-tags inline"><span>{mainTag}</span><span>{buyer.language}</span></span>
              </span>
            </div>
          ) : null}
          <div className="context-tabs">
            {([["profile", "客户资料"], ["order", "订单"], ["product", "商品"], ["coupon", "优惠券"]] as const).map(([id, label]) => (
              <button key={id} className={panelTab === id ? "active" : ""} onClick={() => setPanelTab(id)}>
                {label}
                {id === "order" && orders && orders.length > 0 ? <b className="tab-count">{orders.length}</b> : null}
              </button>
            ))}
          </div>

          {panelTab === "profile" ? (
            buyer ? (
              <>
                <section className="buyer-profile">
                  <BuyerAvatar buyer={buyer} size="xl" />
                  <h2>{buyer.name}</h2>
                  <p>{buyer.nationality} · {buyer.identity}</p>
                  <div className="profile-tags"><span>{mainTag}</span><span>{buyer.language}</span></div>
                </section>
                <section className="context-block">
                  <div className="order-brief">
                    <div className="order-brief-row"><span>国籍</span><em>{buyer.nationality}</em></div>
                    <div className="order-brief-row"><span>身份</span><em>{buyer.identity}</em></div>
                    <div className="order-brief-row"><span>客户类型</span><em>{buyer.customerType}</em></div>
                    <div className="order-brief-row"><span>沟通语言</span><em>{buyer.language}</em></div>
                    <div className="order-brief-row"><span>72h 咨询</span><em>{active?.visits72h ?? 0} 条</em></div>
                    <div className="order-brief-row"><span>历史订单</span><em>{orders ? `${orders.length} 笔` : "—"}</em></div>
                  </div>
                </section>
              </>
            ) : (
              <p className="muted panel-empty">选择会话后展示客户资料。</p>
            )
          ) : null}

          {panelTab === "order" ? (
            <div className="order-pane">
              <div className="order-toolbar">
                <select value={orderFilter} onChange={(event) => setOrderFilter(event.target.value)} aria-label="订单状态筛选">
                  {ORDER_FILTERS.map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
                <div className="order-search">
                  <Search size={14} />
                  <input value={orderSearch} onChange={(event) => setOrderSearch(event.target.value)} placeholder="搜索订单ID" aria-label="搜索订单" />
                </div>
              </div>
              <div className="order-list">
                {visibleOrders.map((order) => {
                  const detail = order.detail;
                  const expanded = expandedOrder === order.id;
                  const action = orderAction?.id === order.id ? orderAction : null;
                  return (
                    <article key={order.id} className="order-item">
                      <header>
                        <div className="order-badges">
                          <em className={`order-state st-${orderFilterKey(detail)}`}>{orderBadgeLabel(detail)}</em>
                          {order.isPrimary ? <em className="order-state primary">本次咨询</em> : null}
                        </div>
                        <time>{dateTimeLabel(detail.placedAt)}</time>
                      </header>
                      <div className="order-no">
                        #{detail.orderNo}
                        <button className="icon-button copy-btn" title="复制订单号" onClick={() => copyOrderNo(detail.orderNo)}><Copy size={13} /></button>
                      </div>
                      <div className="order-ops">
                        <button className="primary-button compact" disabled={composerDisabled} onClick={() => void sendCard("order", order.id)}>发送订单</button>
                        <button className="secondary-button compact" onClick={() => setExpandedOrder(expanded ? null : order.id)}>{expanded ? "收起详情" : "订单详情"}</button>
                        <button className="secondary-button compact" onClick={() => openOrderAction(order, "remark")}><StickyNote size={13} /> 备注</button>
                        <button className="secondary-button compact" onClick={() => openOrderAction(order, "address")}><MapPin size={13} /> 改地址</button>
                      </div>
                      <div className="order-product">
                        {detail.productImage ? (
                          <img className="product-photo" src={assetUrl(detail.productImage) ?? undefined} alt={detail.productName} />
                        ) : (
                          <span className="product-thumb"><Package2 size={20} /></span>
                        )}
                        <div>
                          <strong>{detail.productName} <i>×{detail.quantity}</i></strong>
                          <small>{detail.productSpec}</small>
                        </div>
                      </div>
                      <footer className="order-total">
                        <span>{detail.quantity} 件商品</span>
                        <strong>{detail.currency} {detail.totalAmount}</strong>
                      </footer>
                      {detail.returnStatus ? (
                        <div className="order-return">
                          <span>退货/退款</span>
                          <em>{RETURN_LABELS[detail.returnStatus] ?? detail.returnStatus}</em>
                        </div>
                      ) : null}
                      {detail.remark ? <p className="order-remark"><StickyNote size={12} /> {detail.remark}</p> : null}
                      {expanded ? (
                        <div className="order-detail">
                          <div className="order-brief">
                            <div className="order-brief-row"><span>下单时间</span><em>{dateTimeLabel(detail.placedAt)}</em></div>
                            <div className="order-brief-row"><span>单价</span><em>{detail.currency} {detail.unitPrice}</em></div>
                            <div className="order-brief-row"><span>状态</span><em>{orderBadgeLabel(detail)}</em></div>
                          </div>
                          {detail.address ? (
                            <div className="order-brief">
                              <div className="order-brief-row"><span>收件人</span><em>{detail.address.recipient}</em></div>
                              <div className="order-brief-row"><span>地址</span><em>{detail.address.line1}, {detail.address.city}, {detail.address.country}</em></div>
                              <div className="order-brief-row"><span>电话</span><em>{detail.address.phone}</em></div>
                            </div>
                          ) : null}
                          {detail.logistics ? (
                            <div className="order-brief">
                              <div className="order-brief-row"><span>承运商</span><em>{detail.logistics.carrier}</em></div>
                              <div className="order-brief-row"><span>运单号</span><em>{detail.logistics.trackingNo}</em></div>
                              <div className="logi-nodes">
                                {detail.logistics.nodes.map((node) => (
                                  <span key={node.key} className={node.current ? "logi-node current" : node.done ? "logi-node done" : "logi-node"}>{node.label}</span>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          {detail.review ? (
                            <div className="order-brief">
                              <div className="order-brief-row"><span>买家评价</span><em>{detail.review.rating} 星</em></div>
                              <p className="review-text">{detail.review.content}</p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {action?.type === "remark" ? (
                        <div className="order-form">
                          <textarea value={remarkDraft} onChange={(event) => setRemarkDraft(event.target.value)} rows={2} placeholder="给这笔订单添加内部备注…" aria-label="订单备注" />
                          <div className="order-form-actions">
                            <button className="primary-button compact" disabled={savingOrder} onClick={() => void saveOrderAction()}>{savingOrder ? "保存中…" : "保存备注"}</button>
                            <button className="text-button" onClick={() => setOrderAction(null)}>取消</button>
                          </div>
                        </div>
                      ) : null}
                      {action?.type === "address" ? (
                        <div className="order-form">
                          <input value={addressDraft.recipient} onChange={(event) => setAddressDraft({ ...addressDraft, recipient: event.target.value })} placeholder="收件人" aria-label="收件人" />
                          <input value={addressDraft.line1} onChange={(event) => setAddressDraft({ ...addressDraft, line1: event.target.value })} placeholder="街道地址" aria-label="街道地址" />
                          <div className="order-form-row">
                            <input value={addressDraft.city} onChange={(event) => setAddressDraft({ ...addressDraft, city: event.target.value })} placeholder="城市" aria-label="城市" />
                            <input value={addressDraft.country} onChange={(event) => setAddressDraft({ ...addressDraft, country: event.target.value })} placeholder="国家" aria-label="国家" />
                          </div>
                          <input value={addressDraft.phone} onChange={(event) => setAddressDraft({ ...addressDraft, phone: event.target.value })} placeholder="联系电话" aria-label="联系电话" />
                          <div className="order-form-actions">
                            <button className="primary-button compact" disabled={savingOrder} onClick={() => void saveOrderAction()}>{savingOrder ? "保存中…" : "保存地址"}</button>
                            <button className="text-button" onClick={() => setOrderAction(null)}>取消</button>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {orders === null ? <p className="muted panel-empty">加载订单…</p> : null}
                {orders !== null && visibleOrders.length === 0 ? <p className="muted panel-empty">该客户暂无符合条件的订单。</p> : null}
              </div>
            </div>
          ) : null}

          {panelTab === "product" ? (
            <div className="product-pane">
              <div className="rail-tabs sub product-subtabs">
                <button className={productTab === "store" ? "active" : ""} onClick={() => setProductTab("store")}>全店商品</button>
                <button className={productTab === "browsed" ? "active" : ""} onClick={() => setProductTab("browsed")}>
                  买家浏览过{browsedProducts.length > 0 ? <b className="count">{browsedProducts.length}</b> : null}
                </button>
              </div>
              <div className="store-list">
                {(productTab === "store" ? products : browsedProducts).map((product) => {
                  const specParts = product.spec.split("/").map((part) => part.trim()).filter(Boolean);
                  const specExpanded = specOpen === product.id;
                  const calcExpanded = calcOpen === product.id;
                  const specText = `${product.name} — SKU ${product.id} · ${product.spec} · USD ${product.price} · In stock: ${product.stock}`;
                  const quoteText = `${product.name}: ${calcQty} × USD ${product.price} = USD ${(product.price * calcQty).toFixed(2)}`;
                  return (
                    <article key={product.id} className="store-card">
                      {product.imageUrl ? (
                        <img className="product-photo" src={assetUrl(product.imageUrl) ?? undefined} alt={product.name} />
                      ) : (
                        <span className="product-thumb" style={{ background: product.tone }}><Package2 size={22} /></span>
                      )}
                      <div>
                        <strong>{product.name}</strong>
                        <small>SKU {product.id} · {product.spec}</small>
                        <div className="store-meta">
                          <em>USD {product.price}</em>
                          <small>已售 {product.sales} · 库存 {product.stock}</small>
                        </div>
                      </div>
                      <div className="store-ops">
                        <button className="primary-button compact" disabled={composerDisabled} onClick={() => void sendCard("product", product.id)}>
                          发送商品
                        </button>
                        <button className="secondary-button compact" disabled={composerDisabled} onClick={() => void sendCard("invite", product.id)}>
                          <ShoppingCart size={13} /> 邀请下单
                        </button>
                        <button
                          className={specExpanded ? "secondary-button compact op-active" : "secondary-button compact"}
                          onClick={() => { setSpecOpen(specExpanded ? null : product.id); setCalcOpen(null); }}
                        >
                          <ListTree size={13} /> 规格属性
                        </button>
                        <button
                          className={calcExpanded ? "secondary-button compact op-active" : "secondary-button compact"}
                          onClick={() => { setCalcOpen(calcExpanded ? null : product.id); setSpecOpen(null); setCalcQty(1); }}
                        >
                          <Calculator size={13} /> 算价
                        </button>
                      </div>
                      {specExpanded ? (
                        <div className="store-expand">
                          <div className="order-brief">
                            <div className="order-brief-row"><span>SKU 编码</span><em>{product.id}</em></div>
                            {specParts.map((part, index) => (
                              <div className="order-brief-row" key={part}><span>规格 {index + 1}</span><em>{part}</em></div>
                            ))}
                            <div className="order-brief-row"><span>单价</span><em>USD {product.price}</em></div>
                            <div className="order-brief-row"><span>库存 / 已售</span><em>{product.stock} / {product.sales}</em></div>
                          </div>
                          <button
                            className="secondary-button compact"
                            disabled={!active || isClosed}
                            onClick={() => {
                              setInput((current) => (current ? `${current} ${specText}` : specText));
                              setSpecOpen(null);
                            }}
                          >
                            填入规格信息
                          </button>
                        </div>
                      ) : null}
                      {calcExpanded ? (
                        <div className="store-expand store-calc">
                          <label>
                            数量
                            <input
                              type="number"
                              min={1}
                              max={999}
                              value={calcQty}
                              onChange={(event) => setCalcQty(Math.max(1, Math.min(999, Number(event.target.value) || 1)))}
                              aria-label="数量"
                            />
                          </label>
                          <span className="calc-total">合计 <strong>USD {(product.price * calcQty).toFixed(2)}</strong></span>
                          <button
                            className="secondary-button compact"
                            disabled={!active || isClosed}
                            onClick={() => {
                              setInput((current) => (current ? `${current} ${quoteText}` : quoteText));
                              setCalcOpen(null);
                            }}
                          >
                            填入报价
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {productTab === "browsed" && browsedProducts.length === 0 ? (
                  <p className="muted panel-empty">暂无浏览记录。</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {panelTab === "coupon" ? (
            <div className="store-list">
              {coupons.map((coupon) => (
                <article key={coupon.id} className="store-card coupon-card">
                  <span className="product-thumb coupon-thumb"><TicketPercent size={22} /></span>
                  <div>
                    <strong>{coupon.title}</strong>
                    <small>{coupon.rule} · {coupon.scope}</small>
                    <em>有效期 {coupon.validDays} 天</em>
                  </div>
                  <button
                    className="secondary-button compact"
                    disabled={composerDisabled}
                    onClick={() => void sendCard("coupon", coupon.id)}
                  >
                    发送
                  </button>
                </article>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
