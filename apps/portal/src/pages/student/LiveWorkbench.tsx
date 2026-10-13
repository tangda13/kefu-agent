import {
  CircleAlert,
  CheckCheck,
  Film,
  ImagePlus,
  Languages,
  Lock,
  Mail,
  MessageSquareText,
  Mic,
  Paperclip,
  SendHorizontal,
  Smile,
  TicketPercent,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  apiGet,
  assetUrl,
  closeConversation,
  createConversation,
  createMyPhrase,
  deleteMyPhrase,
  fetchConversationMessages,
  fetchConversationOrders,
  fetchConversations,
  fetchMyPhrases,
  fetchPhrases,
  fetchStoreCoupons,
  fetchStoreProducts,
  fetchStoreProfile,
  fetchStudentTasks,
  fetchWorkbenchStats,
  postConversationMessage,
  recognizeAudio,
  requestMessageTts,
  saveServiceMeta,
  streamAttachmentMessage,
  streamCardMessage,
  streamVoiceMessage,
  streamConversationOpening,
  streamConversationReply,
  translateMessage,
  type ConversationMessage,
  type ConversationOrder,
  type ConversationSummary,
  type MyPhrase,
  type ServiceMeta,
  type Session,
  type StoreCoupon,
  type StoreProduct,
  type StoreProfile,
  type StudentTask,
  type WorkbenchStats,
} from "../../api/client";
import { OPEN_CONVERSATION_EVENT, OPEN_CONVERSATION_KEY } from "../../App";
import { WavRecorder } from "../../api/recorder";
import { Button, Confirm, Dialog, Switch, Tabs, Textarea, toast } from "../../ui";
import "../../styles/student-workbench.css";
import { ConversationRail, type RailTab } from "./workbench/ConversationRail";
import { CustomerCard } from "./workbench/CustomerCard";
import { EndCard } from "./workbench/EndCard";
import { EndButton, FollowUpToggle, ReasonPicker } from "./workbench/HeadControls";
import { OrdersTab } from "./workbench/OrdersTab";
import { ProductDrawer } from "./workbench/ProductDrawer";
import { ProductsTab } from "./workbench/ProductsTab";
import { ShiftBar } from "./workbench/ShiftBar";
import { Av, MessageBody, errorMessage, goToPage, hashSeed, isCardKind, timeLabel } from "./workbench/shared";

type PanelTab = "order" | "product" | "coupon";

const EMOJIS = [
  // 微笑问候
  "😀", "😃", "😄", "😁", "😊", "🙂", "😉", "😍",
  "🥰", "🤗", "😎", "😇", "😌", "🤩", "🙃", "😘",
  // 情绪安抚
  "😅", "😂", "🤣", "🤔", "😐", "😮", "😢", "😥",
  "🥺", "😓", "😞", "🙁", "😳", "😴", "🤯", "😱",
  // 手势互动
  "👍", "👌", "🙏", "🤝", "👏", "🙌", "💪", "✌️",
  "👋", "🤞", "👀", "❤️", "💖", "💯", "💬", "🕐",
  // 电商物流
  "📦", "🚚", "✈️", "🛒", "🎁", "💳", "💰", "🧾",
  "🏷️", "📮", "⏰", "📅", "🔔", "📞", "✉️", "🔍",
  // 状态提示
  "✅", "❌", "❗", "❓", "💡", "🔥", "⭐", "🌟",
  "✨", "🎉", "🎊", "🚀", "☀️", "🌈", "⚠️", "🙈",
];

const AUTO_TRANSLATE_KEY = "cecs.autoTranslate";
const AUTO_PLAY_KEY = "cecs.autoPlay";
/** 同时接待的上限（默认 3 位） */
const MAX_CONCURRENT = 3;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* 偏好存不了也不影响使用 */
  }
}

/** 重新拉到的消息和本地状态合并：译文展开状态按（发送方 + 内容）沿用 */
function mergeRows(current: ConversationMessage[] | null, rows: ConversationMessage[]): ConversationMessage[] {
  const shown = new Map((current ?? []).filter((item) => item.showTranslation).map((item) => [`${item.sender}|${item.content}`, true]));
  return rows.map((row) => (shown.has(`${row.sender}|${row.content}`) ? { ...row, showTranslation: true } : row));
}

/** 任务下一位要进线的场景；ok=false 表示没有可进线的了 */
function pendingScenario(task: StudentTask): { ok: boolean; scenarioId?: string } {
  const list = task.scenarios ?? [];
  const started = new Set((task.startedScenarioIds ?? []).filter(Boolean));
  if (task.completionRule === "conversation_count") {
    if ((task.conversationCount ?? 0) >= task.requiredTotal) return { ok: false };
    const unstarted = list.find((item) => !started.has(item.id));
    const fallback = list.length ? list[Math.floor(Math.random() * list.length)] : undefined;
    return { ok: true, scenarioId: (unstarted ?? fallback)?.id };
  }
  const unstarted = list.filter((item) => !started.has(item.id));
  if (list.length === 0 || unstarted.length === 0) return { ok: false };
  return { ok: true, scenarioId: unstarted[0]!.id };
}

export function LiveWorkbench({ session, initialTaskId }: { session: Session; initialTaskId?: string | null }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [closedConversations, setClosedConversations] = useState<ConversationSummary[]>([]);
  /* 本次接待中刚结束的会话：继续留在“接待中”列表底部的“刚结束”里，切到别的会话后才收走 */
  const [justEnded, setJustEnded] = useState<ConversationSummary[]>([]);
  const [closedReasonLocal, setClosedReasonLocal] = useState<Record<string, string>>({});
  const [closedAtLocal, setClosedAtLocal] = useState<Record<string, number>>({});
  const [translateFailed, setTranslateFailed] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<StudentTask[]>([]);
  const [stats, setStats] = useState<WorkbenchStats | null>(null);
  const [tiers, setTiers] = useState<StoreProfile["tiers"] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>("current");
  /* 任务隔离：会话/进线按任务过滤。"all" 全部 | "practice" 自由练习 | 任务 id 聚焦该任务 */
  const [taskFilter, setTaskFilter] = useState<string>("all");
  /** 客服状态：挂起时暂停进线（不存本机，打开工作台默认在线） */
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(true);
  onlineRef.current = online;
  const [dataReady, setDataReady] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [panelTab, setPanelTab] = useState<PanelTab>("order");
  const [phrases, setPhrases] = useState<string[] | null>(null);
  const [showPhrases, setShowPhrases] = useState(false);
  const [phraseFilter, setPhraseFilter] = useState("");
  // 个人快捷短语（自建，存服务端）
  const [myPhrases, setMyPhrases] = useState<MyPhrase[] | null>(null);
  const [newPhraseOpen, setNewPhraseOpen] = useState(false);
  const [newPhraseText, setNewPhraseText] = useState("");
  const [phraseSaving, setPhraseSaving] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [coupons, setCoupons] = useState<StoreCoupon[]>([]);
  const [detailProduct, setDetailProduct] = useState<StoreProduct | null>(null);
  const [autoTranslate, setAutoTranslate] = useState(() => readFlag(AUTO_TRANSLATE_KEY));
  const [autoPlay, setAutoPlay] = useState(() => readFlag(AUTO_PLAY_KEY));
  // 已结束的会话（本地即时标记，等待列表刷新）
  const [closedLocal, setClosedLocal] = useState<Set<string>>(new Set());
  const [endConfirm, setEndConfirm] = useState(false);
  const [ending, setEnding] = useState(false);
  const [orders, setOrders] = useState<ConversationOrder[] | null>(null);

  const startedForTask = useRef<string | null>(null);
  const openingRequested = useRef<Set<string>>(new Set());
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const autoTranslateRef = useRef(autoTranslate);
  autoTranslateRef.current = autoTranslate;
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const railTabRef = useRef(railTab);
  railTabRef.current = railTab;
  const closedIdsRef = useRef<Set<string>>(new Set());
  closedIdsRef.current = new Set(closedConversations.map((item) => item.id));
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 学生连发批量窗口：发送后 2s 检测窗口，检测到打字则顺延；草稿滞留最多顺延 15s
  const replyTimers = useRef<Map<string, number>>(new Map());
  const replyDeadlines = useRef<Map<string, number>>(new Map());
  const inputRef = useRef("");
  inputRef.current = input;
  const messagesCidRef = useRef<string | null>(null);

  useEffect(() => {
    const timers = replyTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // 表情/快捷短语面板：点击面板（及其开关按钮）以外的任意位置收起
  const emojiPanelRef = useRef<HTMLDivElement | null>(null);
  const phrasePanelRef = useRef<HTMLDivElement | null>(null);
  const emojiButtonRef = useRef<HTMLButtonElement | null>(null);
  const phraseButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!showEmoji && !showPhrases) return;
    if (newPhraseOpen) return; // 新建短语弹窗打开时，点击弹窗不应收起短语面板
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (emojiPanelRef.current?.contains(target) || emojiButtonRef.current?.contains(target)) return;
      if (phrasePanelRef.current?.contains(target) || phraseButtonRef.current?.contains(target)) return;
      setShowEmoji(false);
      setShowPhrases(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showEmoji, showPhrases, newPhraseOpen]);

  const allKnown = useMemo(() => [...conversations, ...justEnded, ...closedConversations], [conversations, justEnded, closedConversations]);
  const active = allKnown.find((item) => item.id === activeId) ?? null;
  const isClosed = active?.status === "closed" || (activeId !== null && closedLocal.has(activeId)) || (activeId !== null && closedIdsRef.current.has(activeId));
  const closedReason = activeId ? closedReasonLocal[activeId] ?? active?.closedReason ?? null : null;
  const buyer = active?.buyer ?? null;

  /* 更新某条会话的本地副本（咨询原因、待跟进、备注） */
  const patchConversation = useCallback((id: string, patch: Partial<ConversationSummary>) => {
    const apply = (list: ConversationSummary[]) => list.map((item) => (item.id === id ? { ...item, ...patch } : item));
    setConversations(apply);
    setClosedConversations(apply);
    setJustEnded(apply);
  }, []);

  const loadStats = useCallback(() => {
    fetchWorkbenchStats(session).then(setStats).catch(() => undefined);
  }, [session]);

  const loadClosed = useCallback(() => {
    return fetchConversations(session, "closed")
      .then((rows) => {
        setClosedConversations(rows);
        return rows;
      })
      .catch(() => [] as ConversationSummary[]);
  }, [session]);

  const markEnded = useCallback((cid: string, reason: string) => {
    setClosedLocal((current) => new Set(current).add(cid));
    setClosedReasonLocal((current) => ({ ...current, [cid]: reason }));
    setClosedAtLocal((current) => ({ ...current, [cid]: Date.now() }));
    setJustEnded((list) => {
      if (list.some((item) => item.id === cid)) return list;
      const base = conversations.find((item) => item.id === cid);
      return base ? [...list, { ...base, status: "closed", closedReason: reason }] : list;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  const loadConversations = useCallback(async () => {
    try {
      const [conversationList, taskList] = await Promise.all([
        fetchConversations(session),
        fetchStudentTasks(session),
      ]);
      setConversations(conversationList);
      setTasks(taskList);
      setActiveId((current) => current ?? conversationList[0]?.id ?? null);
      setDataReady(true);
      loadStats();
      // 正在看的会话从“进行中”里消失了（超时被服务端结束 / 买家离开）：补进“刚结束”
      const current = activeIdRef.current;
      if (current && railTabRef.current === "current" && !conversationList.some((item) => item.id === current) && !closedIdsRef.current.has(current)) {
        void loadClosed().then((rows) => {
          const hit = rows.find((item) => item.id === current);
          if (hit) {
            setJustEnded((list) => (list.some((item) => item.id === current) ? list : [...list, hit]));
            setClosedLocal((set) => new Set(set).add(current));
          }
        });
      }
      return conversationList;
    } catch (cause) {
      setNotice(errorMessage(cause));
      return [];
    }
  }, [session, loadStats, loadClosed]);

  useEffect(() => {
    void loadConversations();
    void loadClosed();
    fetchStoreProducts(session).then(setProducts).catch(() => undefined);
    fetchStoreCoupons(session).then(setCoupons).catch(() => undefined);
    fetchStoreProfile(session).then((profile) => setTiers(profile.tiers)).catch(() => undefined);
  }, [loadConversations, loadClosed, session]);

  // 列表 20 秒校一次：服务端到点结束的会话、新进线的会话都能及时反映
  useEffect(() => {
    const timer = window.setInterval(() => void loadConversations(), 20_000);
    return () => window.clearInterval(timer);
  }, [loadConversations]);

  useEffect(() => {
    if (railTab === "recent") void loadClosed();
  }, [railTab, loadClosed]);

  // 顶栏「消息」中的教师指导 → 跳转到对应会话
  useEffect(() => {
    const applyPending = () => {
      const id = sessionStorage.getItem(OPEN_CONVERSATION_KEY);
      if (!id) return;
      sessionStorage.removeItem(OPEN_CONVERSATION_KEY);
      setRailTab("current");
      setTaskFilter("all"); // 目标会话可能属于其他任务/练习，跳转时退出任务聚焦以免列表中不可见
      setActiveId(id);
    };
    applyPending();
    window.addEventListener(OPEN_CONVERSATION_EVENT, applyPending);
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, applyPending);
  }, []);

  /* 从任务大厅进入 = 任务聚焦模式：会话列表/进线队列只显示该任务（等数据加载完再决策，避免重复建会话）。
     已有活跃会话则续接；否则按任务待接入的场景创建首个会话 */
  useEffect(() => {
    if (!initialTaskId || !dataReady || startedForTask.current === initialTaskId) return;
    startedForTask.current = initialTaskId;
    void (async () => {
      const existing = conversations.find((item) => item.taskId === initialTaskId);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const task = tasks.find((item) => item.id === initialTaskId);
      const started = new Set((task?.startedScenarioIds ?? []).filter(Boolean));
      const firstUnstarted = (task?.scenarios ?? []).find((scenario) => !started.has(scenario.id))?.id;
      await acceptIncoming(initialTaskId, firstUnstarted);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTaskId, dataReady, conversations, tasks]);

  useEffect(() => {
    if (!activeId) {
      messagesCidRef.current = null;
      setMessages(null);
      return;
    }
    let cancelled = false;
    messagesCidRef.current = null;
    setMessages(null);
    setPendingVoice(null);
    fetchConversationMessages(session, activeId)
      .then((rows) => {
        if (cancelled) return;
        messagesCidRef.current = activeId;
        setMessages(rows);
      })
      .catch((cause) => setNotice(errorMessage(cause)));
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
    if (!activeId || messages === null || messages.length > 0 || messagesCidRef.current !== activeId) return;
    if (isClosed) return;
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
  }, [messages, streamingText, isClosed]);

  // ---------- 买家消息翻译 ----------

  const autoTranslateLatest = useCallback(async (cid: string) => {
    try {
      const rows = await fetchConversationMessages(session, cid);
      if (activeIdRef.current !== cid) return;
      const target = [...rows].reverse().find((row) => row.sender === "buyer" && (!row.kind || row.kind === "text"));
      if (!target) {
        setMessages((current) => mergeRows(current, rows));
        return;
      }
      let translation = target.translation;
      if (!translation) translation = (await translateMessage(session, cid, target.id)).translation;
      if (activeIdRef.current !== cid) return;
      setMessages((current) => mergeRows(current, rows).map((row) => (row.id === target.id ? { ...row, translation } : row)));
    } catch {
      /* 自动翻译失败静默，学生可手动点翻译 */
    }
  }, [session]);

  // 开启自动翻译后，为已加载的买家消息补译（同时最多 4 条在途，服务端缓存复用）
  const translateMissing = useCallback((cid: string, rows: ConversationMessage[]) => {
    const targets = rows.filter(
      (row) => row.sender === "buyer" && (!row.kind || row.kind === "text") && !row.translation
        && !row.id.startsWith("buyer-") && !row.id.startsWith("local-") && !translatingRef.current.has(row.id),
    );
    for (const target of targets.slice(-4)) {
      if (translatingRef.current.size >= 4) break;
      translatingRef.current.add(target.id);
      translateMessage(session, cid, target.id)
        .then(({ translation }) => {
          setMessages((current) => (current ?? []).map((row) => (row.id === target.id ? { ...row, translation } : row)));
          setTranslateFailed((set) => { const next = new Set(set); next.delete(target.id); return next; });
        })
        .catch(() => setTranslateFailed((set) => new Set(set).add(target.id)))
        .finally(() => translatingRef.current.delete(target.id));
    }
  }, [session]);

  useEffect(() => {
    if (!autoTranslate || !activeId || !messages || messagesCidRef.current !== activeId) return;
    const pendingIds = messages.filter((row) => translateFailed.has(row.id));
    translateMissing(activeId, messages.filter((row) => !pendingIds.includes(row)));
  }, [autoTranslate, activeId, messages, translateMissing, translateFailed]);

  function toggleAutoTranslate(next: boolean) {
    setAutoTranslate(next);
    writeFlag(AUTO_TRANSLATE_KEY, next);
  }

  function toggleAutoPlay(next: boolean) {
    setAutoPlay(next);
    writeFlag(AUTO_PLAY_KEY, next);
    if (!next) stopSpeaking();
  }

  // ---------- 买家消息播报（TTS 音频缓存复用） ----------

  const ttsToken = useRef(0);
  const ttsQueue = useRef<ConversationMessage[]>([]);
  const ttsRunning = useRef(false);
  const ttsResolve = useRef<(() => void) | null>(null);

  function stopSpeaking() {
    ttsToken.current += 1;
    ttsQueue.current = [];
    audioRef.current?.pause();
    ttsResolve.current?.();
    ttsResolve.current = null;
    setPlayingId(null);
  }

  /** 播报一条买家消息，播完（或被打断）才返回 */
  async function speak(message: ConversationMessage, cid: string): Promise<void> {
    const token = ++ttsToken.current;
    try {
      let target = message;
      if (message.id.startsWith("buyer-")) {
        // 本地气泡还没拿到服务端 id：稍等落库后按内容找回
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const rows = await fetchConversationMessages(session, cid);
          const found = [...rows].reverse().find((item) => item.sender === "buyer" && item.content === message.content);
          if (found) {
            target = found;
            if (activeIdRef.current === cid) setMessages((current) => mergeRows(current, rows));
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
        }
        if (target === message) return;
      }
      if (token !== ttsToken.current) return;
      setPlayingId(target.id);
      const { audioUrl } = await requestMessageTts(session, cid, target.id);
      if (token !== ttsToken.current) return;
      audioRef.current?.pause();
      const audio = new Audio(assetUrl(audioUrl) ?? undefined);
      audioRef.current = audio;
      await new Promise<void>((resolve) => {
        ttsResolve.current = resolve;
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
    } catch (cause) {
      if (token === ttsToken.current) setNotice(errorMessage(cause));
    } finally {
      if (token === ttsToken.current) setPlayingId(null);
    }
  }

  async function runTtsQueue(cid: string) {
    if (ttsRunning.current) return;
    ttsRunning.current = true;
    try {
      while (ttsQueue.current.length > 0 && autoPlayRef.current && activeIdRef.current === cid) {
        const next = ttsQueue.current.shift()!;
        await speak(next, cid);
      }
    } finally {
      ttsRunning.current = false;
    }
  }

  async function playTts(message: ConversationMessage) {
    if (!activeId) return;
    if (playingId === message.id) {
      stopSpeaking();
      return;
    }
    stopSpeaking();
    await speak(message, activeId);
  }

  // 自动播报：会话加载完成后，新到的买家文字消息排队播报（历史消息不播）
  const seenBuyerTexts = useRef<{ cid: string | null; count: number }>({ cid: null, count: 0 });
  useEffect(() => {
    if (!activeId || messages === null || messagesCidRef.current !== activeId) return;
    const texts = messages.filter((row) => row.sender === "buyer" && (!row.kind || row.kind === "text"));
    const seen = seenBuyerTexts.current;
    if (seen.cid !== activeId) {
      ttsQueue.current = [];
      seenBuyerTexts.current = { cid: activeId, count: texts.length };
      return;
    }
    if (texts.length > seen.count) {
      const fresh = texts.slice(seen.count);
      seenBuyerTexts.current = { cid: activeId, count: texts.length };
      if (autoPlayRef.current && !isClosed) {
        ttsQueue.current.push(...fresh);
        void runTtsQueue(activeId);
      }
    } else {
      seenBuyerTexts.current = { cid: activeId, count: texts.length };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeId]);

  // 切换会话时打断正在播的语音
  useEffect(() => {
    return () => stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ---------- 进线 / 流式回复 ----------

  // 任务入口创建首位买家会话（不传场景时服务端取任务首个场景）。
  // 共享自动进线的任务级锁，避免与调度器在同一窗口内重复创建
  async function acceptIncoming(taskId: string, scenarioId?: string) {
    if (busy || arrivalBusyRef.current.has(taskId)) return;
    setBusy(true);
    arrivalBusyRef.current.add(taskId);
    setNotice("");
    try {
      const created = await createConversation(session, scenarioId ? { taskId, scenarioId } : { taskId });
      await loadConversations();
      setRailTab("current");
      setActiveId(created.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "TASK_CLOSED") closedTasksRef.current.add(taskId);
      setNotice(errorMessage(cause));
    } finally {
      arrivalBusyRef.current.delete(taskId);
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
          markEnded(cid, "buyer_left");
          void loadClosed();
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
    if (!text || !activeId || busy || streamingText !== null || !canType) return;
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
      setNotice(errorMessage(cause));
    }
  }

  async function sendCard(type: "product" | "coupon" | "order" | "invite", refId: string, orderPayload?: Record<string, unknown>) {
    if (!activeId || busy || streamingText !== null) return;
    const cid = activeId;
    let payload: Record<string, unknown> | undefined = orderPayload;
    if (type === "product" || type === "invite") payload = products.find((item) => item.id === refId) as unknown as Record<string, unknown>;
    else if (type === "coupon") payload = coupons.find((item) => item.id === refId) as unknown as Record<string, unknown>;
    setMessages((current) => [
      ...(current ?? []),
      { id: `local-${Date.now()}`, sender: "student", content: "", kind: type, payload: payload ?? null, createdAt: new Date().toISOString() },
    ]);
    setStreamingText("");
    await streamCardMessage(session, cid, type, refId, appendBuyerStream(cid));
  }

  function sendOrderCard(order: ConversationOrder) {
    void sendCard("order", order.id, {
      orderNo: order.detail.orderNo,
      productName: order.detail.productName,
      productSpec: order.detail.productSpec,
      productImage: order.detail.productImage ?? null,
      quantity: order.detail.quantity,
      totalAmount: order.detail.totalAmount,
      currency: order.detail.currency,
      statusLabel: order.detail.statusLabel,
      returnStatus: order.detail.returnStatus ?? null,
    });
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
      setMessages((current) => (current ?? []).map((item) => (item.id === message.id ? { ...item, showTranslation: !item.showTranslation } : item)));
      return;
    }
    try {
      let targetId = message.id;
      if (message.id.startsWith("buyer-") || message.id.startsWith("local-")) {
        const rows = await fetchConversationMessages(session, activeId);
        const target = [...rows].reverse().find((item) => item.sender === "buyer" && item.content === message.content);
        if (!target) {
          setMessages((current) => mergeRows(current, rows));
          return;
        }
        targetId = target.id;
        setMessages((current) => mergeRows(current, rows));
      }
      const { translation } = await translateMessage(session, activeId, targetId);
      setMessages((current) => (current ?? []).map((item) => (item.id === targetId ? { ...item, translation, showTranslation: true } : item)));
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }

  // ---------- 语音输入 ----------

  // 学生语音输入：按住说话 → 整段识别 → 文字进输入框（可修改后发送）；只能语音时松手直接发送
  async function startVoiceInput() {
    if (!activeId || voiceState !== "idle" || isClosed) return;
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
      const seconds = Math.max(1, Math.round((wav.size - 44) / 32000));
      if (mode === "voice") void sendVoice({ blob: wav, seconds });
      else setPendingVoice({ blob: wav, seconds });
    } catch (cause) {
      setNotice(errorMessage(cause));
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
      setNotice(errorMessage(cause));
    } finally {
      setVoiceState("idle");
    }
  }

  async function sendVoice(voice: { blob: Blob; seconds: number } | null = pendingVoice) {
    if (!activeId || !voice || streamingText !== null) return;
    const cid = activeId;
    const { blob, seconds } = voice;
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

  // ---------- 快捷短语 ----------

  function openPhrasePanel() {
    setShowPhrases((value) => !value);
    setShowEmoji(false);
    if (phrases === null) fetchPhrases(session).then(setPhrases).catch(() => setPhrases([]));
    if (myPhrases === null) fetchMyPhrases(session).then(setMyPhrases).catch(() => setMyPhrases([]));
  }

  async function saveNewPhrase() {
    const text = newPhraseText.trim();
    if (!text || phraseSaving) return;
    setPhraseSaving(true);
    try {
      const created = await createMyPhrase(session, text);
      setMyPhrases((current) => [created, ...(current ?? [])]);
      setNewPhraseText("");
      setNewPhraseOpen(false);
      setPhraseFilter("");
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setPhraseSaving(false);
    }
  }

  async function removeMyPhrase(phraseId: string) {
    setMyPhrases((current) => (current ?? []).filter((item) => item.id !== phraseId));
    try {
      await deleteMyPhrase(session, phraseId);
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }

  // ---------- 客服标记（咨询原因 / 待跟进 / 客户备注）与结束接待 ----------

  async function saveMeta(patch: { contactReason?: string | null; followUp?: boolean; buyerNote?: string | null }) {
    if (!activeId) return;
    const cid = activeId;
    const before = active;
    // 先在界面上生效，失败再退回
    patchConversation(cid, {
      ...(patch.contactReason !== undefined ? { contactReason: patch.contactReason } : {}),
      ...(patch.followUp !== undefined ? { followUp: patch.followUp } : {}),
      ...(patch.buyerNote !== undefined ? { buyerNote: patch.buyerNote, buyerNoteAt: new Date().toISOString() } : {}),
    });
    try {
      const saved: ServiceMeta = await saveServiceMeta(session, cid, patch);
      patchConversation(cid, {
        contactReason: saved.contactReason,
        contactReasonSuggested: saved.contactReasonSuggested,
        followUp: saved.followUp,
        buyerNote: saved.buyerNote,
        buyerNoteAt: saved.buyerNoteAt,
      });
    } catch (cause) {
      if (before) {
        patchConversation(cid, {
          contactReason: before.contactReason,
          followUp: before.followUp,
          buyerNote: before.buyerNote,
          buyerNoteAt: before.buyerNoteAt,
        });
      }
      toast.error(errorMessage(cause));
    }
  }

  async function endConversation() {
    if (!activeId) return;
    const cid = activeId;
    setEnding(true);
    try {
      await closeConversation(session, cid);
      const timer = replyTimers.current.get(cid);
      if (timer) window.clearTimeout(timer);
      replyTimers.current.delete(cid);
      markEnded(cid, "student_ended");
      setStreamingText(null);
      setEndConfirm(false);
      void loadClosed();
      void loadConversations();
    } catch (cause) {
      setEndConfirm(false);
      setNotice(errorMessage(cause));
    } finally {
      setEnding(false);
    }
  }

  // 本场时间到：服务端每分钟扫一次超时会话，这里隔一会儿多刷几次让界面跟上
  function refreshAfterTimeUp() {
    void loadConversations();
    void loadClosed();
    [10_000, 30_000, 65_000].forEach((delay) =>
      window.setTimeout(() => {
        void loadConversations();
        void loadClosed();
      }, delay),
    );
  }

  /* 买家自动进线（取代手动「接入」，真实客服没有"放客户进来"的动作）：
     已进入(in_progress)的任务按教师配置的接待节奏自动进线：
     - sequential 依次进线：该任务没有进行中的会话时，下一位隔 3-8 秒进线
     - interval 固定间隔：距该任务最近一次进线超过 N 分钟即再进一位（可并发堆积）
     - all_at_once 同时进线：还有待进线场景就逐个补齐（每位隔几秒，模拟陆续涌入）
     同时接待上限 3 位；任务已截止/关闭（TASK_CLOSED）后不再进线。
     待开始(todo)的任务仍由任务大厅「开始任务」触发首位买家；仅工作台打开时调度（在岗才有客户进线） */
  const arrivalBusyRef = useRef<Set<string>>(new Set());
  const arrivalNotBeforeRef = useRef<Map<string, number>>(new Map());
  const closedTasksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!dataReady) return;
    const openList = conversations.filter((item) => !closedLocal.has(item.id));
    const activeOfTask = (taskId: string) => openList.filter((item) => item.taskId === taskId).length;
    const nextScenario = pendingScenario;
    const arrive = async (task: StudentTask, scenarioId?: string) => {
      if (arrivalBusyRef.current.has(task.id)) return;
      arrivalBusyRef.current.add(task.id);
      try {
        const created = await createConversation(session, scenarioId ? { taskId: task.id, scenarioId } : { taskId: task.id });
        // 后台生成买家开场消息（不抢当前聊天焦点），落库后列表出现未读红点与等待时长
        openingRequested.current.add(created.id);
        void streamConversationOpening(session, created.id, {
          onDelta: () => undefined,
          onDone: () => {
            void loadConversations();
            // 学生已提前点开这条会话：同步把刚生成的开场消息刷进聊天区
            if (activeIdRef.current === created.id) {
              fetchConversationMessages(session, created.id)
                .then((rows) => {
                  if (activeIdRef.current === created.id) setMessages(rows);
                })
                .catch(() => undefined);
            }
          },
          onError: () => {
            openingRequested.current.delete(created.id);
          },
        });
        await loadConversations();
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === "TASK_CLOSED") {
          // 任务已截止或被关闭：不再进线，提示一次
          closedTasksRef.current.add(task.id);
          toast.error(cause.message);
        } else {
          /* 创建失败（如场景被停用）：退避 60 秒再试，避免每个周期反复冲击服务器 */
          arrivalNotBeforeRef.current.set(task.id, Date.now() + 60_000);
        }
      } finally {
        arrivalBusyRef.current.delete(task.id);
      }
    };
    const evaluate = () => {
      if (!onlineRef.current) return;
      for (const task of tasks) {
        if (task.locked || task.progressStatus !== "in_progress") continue;
        if (closedTasksRef.current.has(task.id)) continue;
        if (task.deadline && Date.now() > new Date(task.deadline).getTime()) continue;
        if (openList.length >= MAX_CONCURRENT) {
          arrivalNotBeforeRef.current.delete(task.id);
          continue;
        }
        const next = nextScenario(task);
        if (!next.ok) {
          arrivalNotBeforeRef.current.delete(task.id);
          continue;
        }
        const mode = task.arrivalMode ?? "sequential";
        let ready: boolean;
        if (mode === "all_at_once") {
          ready = true;
        } else if (mode === "interval") {
          const interval = Math.max(1, task.arrivalIntervalMinutes ?? 5) * 60_000;
          const lastArrival = conversations
            .filter((item) => item.taskId === task.id)
            .reduce((max, item) => Math.max(max, new Date(item.createdAt).getTime()), 0);
          ready = lastArrival === 0 || Date.now() - lastArrival >= interval;
        } else {
          ready = activeOfTask(task.id) === 0;
        }
        if (!ready) {
          arrivalNotBeforeRef.current.delete(task.id);
          continue;
        }
        // 条件满足后随机延迟 3-8 秒再进线，模拟真实进线的不规律感
        const notBefore = arrivalNotBeforeRef.current.get(task.id);
        if (notBefore === undefined) {
          arrivalNotBeforeRef.current.set(task.id, Date.now() + 3000 + Math.random() * 5000);
          continue;
        }
        if (Date.now() < notBefore) continue;
        arrivalNotBeforeRef.current.delete(task.id);
        void arrive(task, next.scenarioId);
      }
    };
    evaluate();
    const timer = setInterval(evaluate, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady, tasks, conversations, closedLocal, session]);

  // ---------- 派生数据 ----------

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const inProgressTasks = useMemo(() => tasks.filter((task) => !task.locked && task.progressStatus === "in_progress"), [tasks]);

  const visibleActive = useMemo(() => {
    let list = conversations.filter((item) => !closedLocal.has(item.id));
    if (taskFilter === "practice") list = list.filter((item) => !item.taskId);
    else if (taskFilter !== "all") list = list.filter((item) => item.taskId === taskFilter);
    return list;
  }, [conversations, closedLocal, taskFilter]);
  const visibleRecent = useMemo(() => {
    const ids = new Set(conversations.map((item) => item.id));
    let list = closedConversations.filter((item) => !ids.has(item.id));
    if (taskFilter === "practice") list = list.filter((item) => !item.taskId);
    else if (taskFilter !== "all") list = list.filter((item) => item.taskId === taskFilter);
    return list;
  }, [closedConversations, conversations, taskFilter]);

  // 本场信息栏：聚焦哪个任务、倒计时从哪场会话开始算
  const activeOpen = active && !isClosed ? active : null;
  const filterTask = taskFilter !== "all" && taskFilter !== "practice" ? taskById.get(taskFilter) ?? null : null;
  const focusTask: StudentTask | null = activeOpen
    ? (activeOpen.taskId ? taskById.get(activeOpen.taskId) ?? null : null)
    : filterTask ?? inProgressTasks[0] ?? null;
  const timingConv = useMemo(() => {
    if (!focusTask) return null;
    if (activeOpen && activeOpen.taskId === focusTask.id) return activeOpen;
    const list = conversations.filter((item) => item.taskId === focusTask.id && !closedLocal.has(item.id));
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
  }, [focusTask, activeOpen, conversations, closedLocal]);

  // 当前会话所属任务的交流方式
  const mode = (active?.taskId ? taskById.get(active.taskId)?.interactionMode : null) ?? "text_voice";
  const canType = mode !== "voice";
  const canVoice = mode !== "text";

  // 列表底部排队信息（按进线节奏）
  const queueInfo = useMemo(() => {
    const task = focusTask;
    if (!task || task.progressStatus !== "in_progress") return null;
    const openOfTask = conversations.filter((item) => item.taskId === task.id && !closedLocal.has(item.id));
    const left = pendingScenario(task).ok ? Math.max(0, task.requiredTotal - task.progressDone - openOfTask.length) : 0;
    const remainTotal = Math.max(0, task.requiredTotal - task.progressDone);
    if (left <= 0) return remainTotal > 0 ? { text: "排队中 0 人" } : null;
    return { text: `排队中 ${left} 人` };
  }, [focusTask, conversations, closedLocal]);

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

  const visibleMessages = (messages ?? []).filter((message) => message.sender !== "teacher");
  const composerDisabled = !active || isClosed || streamingText !== null;

  const phraseQuery = phraseFilter.trim().toLowerCase();
  const visibleMyPhrases = (myPhrases ?? []).filter((item) => item.text.toLowerCase().includes(phraseQuery));
  const visibleLibraryPhrases = (phrases ?? []).filter((phrase) => phrase.toLowerCase().includes(phraseQuery)).slice(0, 30);

  function insertPhrase(text: string) {
    setInput((current) => (current ? `${current} ${text}` : text));
    setShowPhrases(false);
    textareaRef.current?.focus();
  }

  function appendToInput(text: string) {
    setInput((current) => (current ? `${current} ${text}` : text));
    textareaRef.current?.focus();
  }

  function pickConversation(id: string) {
    setActiveId(id);
    setJustEnded((list) => list.filter((item) => item.id === id));
  }

  const closedNotice =
    closedReason === "student_ended" ? "会话已结束，不能再发消息。"
    : closedReason === "timeout" ? "会话已超时结束，不能再发消息。"
    : "这位买家已离开，不能再发消息。";

  const panelTabs = [
    { id: "order" as const, label: "订单", count: orders && orders.length > 0 ? orders.length : undefined },
    { id: "product" as const, label: "商品" },
    { id: "coupon" as const, label: "优惠券", count: coupons.length > 0 ? coupons.length : undefined },
  ];

  return (
    <div className="wbk">
      <ShiftBar
        task={focusTask}
        online={online}
        onToggleOnline={() => setOnline((value) => !value)}
        startedAt={timingConv ? new Date(timingConv.createdAt).getTime() : null}
        timerKey={timingConv?.id ?? null}
        stats={stats}
        onTimeUp={refreshAfterTimeUp}
      />

      <ConversationRail
        tab={railTab}
        onTab={setRailTab}
        search={searchText}
        onSearch={setSearchText}
        active={visibleActive}
        justEnded={justEnded}
        recent={visibleRecent}
        activeId={activeId}
        typingId={streamingText !== null ? activeId : null}
        onPick={pickConversation}
        queueInfo={queueInfo}
      />

      <section className="wbk-chat">
        {notice ? (
          <div className="wbk-notice" role="alert">
            <CircleAlert size={16} />
            <span>{notice}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={14} /></button>
          </div>
        ) : null}
        <div className="wbk-ch">
          {buyer ? <Av buyer={buyer} size={34} /> : null}
          <div className="wbk-ch-who">
            <b title={buyer?.name}>{buyer?.name ?? ""}</b>
            <div className="wbk-sub">{buyer ? buyer.nationality : ""}</div>
          </div>
          {active ? (
            <div className="wbk-ch-end">
              <ReasonPicker conversation={active} disabled={isClosed} onPick={(reason) => void saveMeta({ contactReason: reason })} />
              <FollowUpToggle on={Boolean(active.followUp)} onToggle={() => void saveMeta({ followUp: !active.followUp })} />
              {isClosed ? <span className="wbk-tag is-closed">已结束</span> : <EndButton onClick={() => setEndConfirm(true)} />}
            </div>
          ) : null}
        </div>

        <div className="wbk-msgs" ref={listRef}>
          {active && messages !== null ? <span className="wbk-sys">{timeLabel(active.createdAt)} 会话已分配给你</span> : null}
          {visibleMessages.map((message) => {
            const mine = message.sender === "student";
            const text = !message.kind || message.kind === "text";
            const translated = !mine && text && Boolean(message.translation) && (autoTranslate || message.showTranslation);
            const failed = translateFailed.has(message.id);
            const pending = !mine && text && autoTranslate && !message.translation && !failed;
            const playing = playingId === message.id;
            return (
              <div key={message.id} className={mine ? "wbk-m is-me" : "wbk-m"}>
                {!mine ? <Av buyer={buyer} size={30} /> : null}
                <div className="wbk-mbody">
                  <div className={isCardKind(message) ? "wbk-bub is-card" : "wbk-bub"}>
                    <MessageBody message={message} onPlayVoice={playVoice} />
                    {translated ? <div className="wbk-tr">{message.translation}</div> : null}
                    {pending ? <div className="wbk-tr is-pending">翻译中…</div> : null}
                    {!mine && text && autoTranslate && failed && !message.translation ? <div className="wbk-tr is-pending">翻译没成功，<button type="button" onClick={() => { setTranslateFailed((set) => { const next = new Set(set); next.delete(message.id); return next; }); }}>重试</button></div> : null}
                  </div>
                  <div className="wbk-mt">
                    {!mine && text ? (
                      <button type="button" className={playing ? "is-playing" : ""} onClick={() => void playTts(message)} title={playing ? "停止播报" : "播报这条消息"}>
                        <Volume2 size={12} />{playing ? "播报中" : "播报"}
                      </button>
                    ) : null}
                    {!mine && text && !autoTranslate ? (
                      <button type="button" onClick={() => void toggleTranslation(message)}>
                        <Languages size={12} />{message.translation ? (message.showTranslation ? "隐藏译文" : "显示译文") : "翻译"}
                      </button>
                    ) : null}
                    <time>{timeLabel(message.createdAt)}</time>
                    {mine ? <CheckCheck size={13} className="wbk-tick" /> : null}
                  </div>
                </div>
              </div>
            );
          })}
          {streamingText !== null ? (
            <div className="wbk-m">
              <Av buyer={buyer} size={30} />
              <div className="wbk-mbody">
                <div className="wbk-bub">{streamingText || "…"}</div>
                <div className="wbk-mt"><span className="is-typing">对方正在输入…</span></div>
              </div>
            </div>
          ) : null}
          {isClosed && messages !== null && active ? (
            <>
              <EndCard
                conversation={active}
                messages={messages}
                closedReason={closedReason}
                endedAt={closedAtLocal[active.id] ?? null}
              />
            </>
          ) : null}
          {!active && dataReady ? <p className="wbk-chat-empty">暂无会话</p> : null}
        </div>

        {isClosed ? (
          <div className="wbk-closed-bar">
            <Lock size={16} />{closedNotice}
            <Button size="sm" variant="ghost" icon={Mail} className="wbk-closed-mail" onClick={() => goToPage("mail", "邮件")}>发邮件跟进</Button>
          </div>
        ) : (
          <div className={mode === "voice" ? "wbk-composer is-voice" : "wbk-composer"}>
            {showPhrases ? (
              <div className="wbk-panel wbk-phrase" ref={phrasePanelRef}>
                <div className="wbk-phrase-head">
                  <input value={phraseFilter} onChange={(event) => setPhraseFilter(event.target.value)} placeholder="搜索快捷短语…" aria-label="搜索快捷短语" />
                  <Button size="sm" variant="text" onClick={() => {
                    if (!newPhraseOpen && !newPhraseText.trim() && input.trim()) setNewPhraseText(input.trim());
                    setNewPhraseOpen(!newPhraseOpen);
                  }}>+ 新建</Button>
                  <Button size="sm" variant="text" onClick={() => setShowPhrases(false)}>收起</Button>
                </div>
                <div className="wbk-phrase-list">
                  {visibleMyPhrases.length > 0 ? <p className="wbk-phrase-group">我的短语</p> : null}
                  {visibleMyPhrases.map((item) => (
                    <div className="wbk-phrase-row" key={item.id}>
                      <button type="button" onClick={() => insertPhrase(item.text)}>{item.text}</button>
                      <button type="button" className="is-del" title="删除该短语" aria-label="删除该短语" onClick={() => void removeMyPhrase(item.id)}>×</button>
                    </div>
                  ))}
                  {visibleMyPhrases.length > 0 && visibleLibraryPhrases.length > 0 ? <p className="wbk-phrase-group">标准话术</p> : null}
                  {visibleLibraryPhrases.map((phrase) => (
                    <div className="wbk-phrase-row" key={phrase}><button type="button" onClick={() => insertPhrase(phrase)}>{phrase}</button></div>
                  ))}
                  {phrases !== null && myPhrases !== null && phraseQuery && visibleMyPhrases.length === 0 && visibleLibraryPhrases.length === 0 ? (
                    <div className="wbk-phrase-empty">
                      <p>没有找到包含“{phraseFilter.trim()}”的短语</p>
                      <Button size="sm" variant="text" onClick={() => { setNewPhraseText(phraseFilter.trim()); setNewPhraseOpen(true); }}>+ 将它保存为新短语</Button>
                    </div>
                  ) : null}
                  {phrases === null || myPhrases === null ? <p className="wbk-phrase-group">加载中…</p> : null}
                </div>
              </div>
            ) : null}
            {showEmoji ? (
              <div className="wbk-panel wbk-emoji" ref={emojiPanelRef} role="listbox" aria-label="选择表情">
                {EMOJIS.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => { setInput((current) => current + emoji); setShowEmoji(false); }}>{emoji}</button>
                ))}
              </div>
            ) : null}
            {pendingVoice ? (
              <div className="wbk-voice-pending">
                <button type="button" className="wbk-voice-play" onClick={() => playVoice(URL.createObjectURL(pendingVoice.blob))}>▶ {pendingVoice.seconds}″</button>
                <Button size="sm" variant="primary" disabled={voiceState === "recognizing"} onClick={() => void sendVoice()}>发送语音</Button>
                <Button size="sm" disabled={voiceState === "recognizing"} onClick={() => void voiceToText()}>{voiceState === "recognizing" ? "识别中…" : "转文字"}</Button>
                <Button size="sm" variant="text" onClick={() => setPendingVoice(null)}>取消</Button>
              </div>
            ) : null}
            <div className="wbk-tools">
              <button ref={emojiButtonRef} type="button" onClick={() => { setShowEmoji((value) => !value); setShowPhrases(false); }} disabled={composerDisabled || !canType} title="发送表情" aria-label="发送表情"><Smile size={18} /></button>
              <button type="button" onClick={() => imageInputRef.current?.click()} disabled={composerDisabled} title="发送图片" aria-label="发送图片"><ImagePlus size={18} /></button>
              <button type="button" onClick={() => videoInputRef.current?.click()} disabled={composerDisabled} title="发送视频" aria-label="发送视频"><Film size={18} /></button>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={composerDisabled} title="发送文件" aria-label="发送文件"><Paperclip size={18} /></button>
              <button ref={phraseButtonRef} type="button" className="wbk-phrase-btn" onClick={openPhrasePanel} disabled={!active || !canType}><MessageSquareText size={16} />快捷短语</button>
              <div className="wbk-toggles">
                <label><Languages size={15} />自动翻译<Switch checked={autoTranslate} onChange={toggleAutoTranslate} label="自动翻译" /></label>
                <label><Volume2 size={15} />自动播报<Switch checked={autoPlay} onChange={toggleAutoPlay} label="自动播报" /></label>
              </div>
            </div>
            <input ref={imageInputRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => onAttachmentChosen("image", event)} />
            <input ref={videoInputRef} type="file" hidden accept="video/mp4,video/webm,video/quicktime" onChange={(event) => onAttachmentChosen("video", event)} />
            <input ref={fileInputRef} type="file" hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.zip,.txt,.csv" onChange={(event) => onAttachmentChosen("file", event)} />
            {/* 只能语音时不放被禁用的文字框，也不解释：输入区只有“按住说话” */}
            {canType ? (
            <textarea
              ref={textareaRef}
              className="wbk-ta"
              value={input}
              maxLength={1000}
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
              placeholder="输入消息，Enter 发送"
              disabled={composerDisabled}
            />
            ) : null}
            <div className="wbk-bt">
              {canVoice ? (
                <button
                  type="button"
                  className={voiceState === "recording" ? "wbk-ptt is-recording" : "wbk-ptt"}
                  disabled={!active || isClosed || voiceState === "recognizing" || streamingText !== null}
                  onMouseDown={() => void startVoiceInput()}
                  onMouseUp={() => void stopVoiceInput()}
                  onMouseLeave={() => { if (voiceState === "recording") void stopVoiceInput(); }}
                  onTouchStart={(event) => { event.preventDefault(); void startVoiceInput(); }}
                  onTouchEnd={() => void stopVoiceInput()}
                >
                  <Mic size={15} />
                  {voiceState === "recording" ? "松开结束" : voiceState === "recognizing" ? "识别中…" : "按住说话"}
                </button>
              ) : null}
              {canType ? (
                <>
                  <span className="wbk-cnt num">{input.length} / 1000</span>
                  <Button variant="primary" size="sm" onClick={() => void send()} disabled={composerDisabled || !input.trim()}>
                    发送 <SendHorizontal size={15} />
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <aside className="wbk-rp">
        {active ? (
          <CustomerCard conversation={active} tiers={tiers} onSaveNote={(note) => saveMeta({ buyerNote: note })} />
        ) : (
          null
        )}
        <Tabs items={panelTabs} value={panelTab} onChange={setPanelTab} className="wbk-rtabs" />
        <div className="wbk-rbody">
          {panelTab === "order" ? (
            active ? (
              <OrdersTab
                session={session}
                conversationId={active.id}
                buyerName={active.buyer.name}
                orders={orders}
                setOrders={setOrders}
                canSend={!composerDisabled}
                onSend={sendOrderCard}
                onError={setNotice}
              />
            ) : null
          ) : null}
          {panelTab === "product" ? (
            <ProductsTab
              products={products}
              browsed={browsedProducts}
              canSend={!composerDisabled}
              canFill={Boolean(active) && !isClosed && canType}
              onSend={(type, id) => void sendCard(type, id)}
              onFill={appendToInput}
              onDetail={setDetailProduct}
            />
          ) : null}
          {panelTab === "coupon" ? (
            <div className="wbk-coupons">
              {coupons.map((coupon) => (
                <article key={coupon.id} className="wbk-pc">
                  <span className="wbk-card-thumb is-coupon is-lg"><TicketPercent size={22} /></span>
                  <div className="wbk-pc-main">
                    <b>{coupon.title}</b>
                    <div className="wbk-pc-m">{coupon.rule} · {coupon.scope}</div>
                    <div className="wbk-pc-m">有效期 {coupon.validDays} 天</div>
                    <div className="wbk-pc-ac"><Button size="sm" disabled={composerDisabled} onClick={() => void sendCard("coupon", coupon.id)}>发送</Button></div>
                  </div>
                </article>
              ))}
              {coupons.length === 0 ? <p className="wbk-empty">店里暂时没有可发的优惠券。</p> : null}
            </div>
          ) : null}
        </div>
      </aside>

      {detailProduct ? (
        <ProductDrawer
          product={detailProduct}
          canSend={!composerDisabled}
          canFill={Boolean(active) && !isClosed && canType}
          onClose={() => setDetailProduct(null)}
          onQuote={appendToInput}
          onSend={(type) => {
            void sendCard(type, detailProduct.id);
            setDetailProduct(null);
          }}
        />
      ) : null}

      {endConfirm ? (
        <Confirm title="结束会话？" confirmText="结束会话" danger busy={ending} onConfirm={() => void endConversation()} onClose={() => setEndConfirm(false)}>
          结束后不能再给这位买家发消息。
        </Confirm>
      ) : null}

      {newPhraseOpen ? (
        <Dialog
          title="新建快捷短语"
          onClose={() => setNewPhraseOpen(false)}
          footer={
            <>
              <Button onClick={() => { setNewPhraseOpen(false); setNewPhraseText(""); }}>取消</Button>
              <Button variant="primary" disabled={!newPhraseText.trim()} loading={phraseSaving} onClick={() => void saveNewPhrase()}>保存</Button>
            </>
          }
        >
          <Textarea
            value={newPhraseText}
            onChange={(event) => setNewPhraseText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void saveNewPhrase();
              }
            }}
            placeholder="例如：Thanks for your patience, let me check that for you."
            maxLength={200}
            rows={3}
            autoFocus
            aria-label="短语内容"
          />
          <p className="wbk-dialog-hint">保存后出现在快捷短语面板的“我的短语”里，仅自己可见 · {newPhraseText.length} / 200</p>
        </Dialog>
      ) : null}
    </div>
  );
}
