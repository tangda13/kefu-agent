import { Archive, Clock, Download, Lightbulb, List, Lock, MonitorPlay, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import {
  ApiError, apiGet, apiPost, apiRequestPatch, assetUrl,
  type BuyerPublicView, type ConversationMessage, type Session,
} from "../../api/client";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import {
  Bench, Board, Button, Drawer, Empty, Field, FilterChips, HeaderTabs, Input, MoreMenu, SearchBox, Tag, Textarea, Toolbar, toast,
} from "../../ui";
import { formatIdle, takeReplaySearch, takeTrackingTab } from "./widgets";

interface TrackingItem {
  conversationId: string;
  studentName: string;
  username: string;
  buyer: BuyerPublicView;
  scenarioName: string;
  studentTurns: number;
  lastSender: string | null;
  lastContent: string;
  lastAt: string;
  idleSeconds: number;
  liveScore: number | null;
  satisfaction: number | null;
  stage: string | null;
  startedAt: string;
  /** 自由练习（无任务）会话：可监控可介入，但不计入考核统计 */
  practice: boolean;
  /** 暂离：近 10 分钟无消息，且不在买家等待 30 分钟内的介入窗口 */
  suspended: boolean;
  /** 需介入：买家等待 3–30 分钟 */
  alert: boolean;
  /** 超过 1 天没有任何消息：收进“已中断”一行，不再提醒 */
  stale?: boolean;
  /* “现场”面板：只给老师看的买家性格、当前情绪、走势和场景剧本 */
  personality?: string | null;
  emotion?: string | null;
  satisfactionTrend?: number[];
  scoreTrend?: number[];
  objective?: string | null;
  buyerGoal?: string | null;
  bottomLine?: string | null;
}

const LANGUAGE_NAMES: Record<string, string> = { "en-US": "英语", "es-ES": "西班牙语", "fr-FR": "法语" };

interface TeacherAssessment {
  id: string;
  conversationId: string;
  studentName: string;
  username: string;
  buyerName: string;
  scenarioName: string;
  taskName: string | null;
  scores: Record<string, number>;
  total: number;
  comment: string;
  suggestions: string[] | null;
  aiScores: Record<string, number> | null;
  aiTotal: number | null;
  teacherComment: string | null;
  reviewedAt: string | null;
  practice: boolean;
  weights: Record<string, number>;
  createdAt: string;
}

const errorText = (cause: unknown) => (cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
const SENDER_LABELS: Record<string, string> = { buyer: "买家", student: "学生", teacher: "老师" };
const KIND_LABELS: Record<string, string> = { product: "[商品卡片]", coupon: "[优惠券]", order: "[订单]", invite: "[邀评]", image: "[图片]", video: "[视频]", file: "[文件]", voice: "[语音]" };
const time = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/* 常用指导语：一键填入，老师可以再改 */
const GUIDANCE_PRESETS = [
  "先安抚买家情绪，再给解决方案",
  "注意合规用语，不要做绝对化承诺",
  "给出明确的物流 / 售后时间",
  "先弄清买家真正想要什么",
];

/** 与服务端 weightedTotal 一致：有任务权重按权重，否则六项等权 */
function previewTotal(scores: Record<string, number>, weights: Record<string, number>): number {
  const ids = ASSESSMENT_DIMENSIONS.map((dim) => dim.id);
  const weightOf = (id: string) => (Number(weights[id]) > 0 ? Number(weights[id]) : 0);
  const sum = ids.reduce((acc, id) => acc + weightOf(id), 0);
  return sum > 0
    ? Math.round(ids.reduce((acc, id) => acc + (scores[id] ?? 0) * weightOf(id), 0) / sum)
    : Math.round(ids.reduce((acc, id) => acc + (scores[id] ?? 0), 0) / ids.length);
}

function StudentMark({ name }: { name: string }) {
  return <span className="mon-stu" aria-hidden="true">{name.slice(0, 1)}</span>;
}

/** 消息气泡：买家在左（带头像），学生在右（品牌色），老师指导是插在时间线里的橙色提示条 */
function MessageBubble({ message, buyer, studentName }: { message: ConversationMessage; buyer?: BuyerPublicView | null; studentName?: string }) {
  if (message.sender === "teacher") {
    return <div className="mon-guide"><Lightbulb size={14} />老师指导：{message.content} · {time(message.createdAt)}</div>;
  }
  const audioUrl = message.kind === "voice" ? (message.payload as { audioUrl?: string } | null)?.audioUrl : undefined;
  const mark = KIND_LABELS[message.kind ?? ""];
  const mine = message.sender === "student";
  return (
    <div className={mine ? "mon-msg is-me" : "mon-msg"}>
      {mine ? <StudentMark name={studentName ?? "学"} /> : <BuyerAvatar buyer={buyer ?? null} size="tiny" />}
      <div>
        <p>
          {mark ? <span className="chat-kind">{mark}</span> : null}
          {message.content}
          {audioUrl ? <button type="button" className="chat-play" onClick={() => { const url = assetUrl(audioUrl); if (url) void new Audio(url).play(); }}>播放</button> : null}
        </p>
        <small>{mine ? studentName ?? "学生" : SENDER_LABELS[message.sender] ?? message.sender} · {time(message.createdAt)}</small>
      </div>
    </div>
  );
}

export function LiveTracking({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [tab, setTab] = useState<"live" | "replay">(takeTrackingTab);
  const [items, setItems] = useState<TrackingItem[]>([]);
  const [assessments, setAssessments] = useState<TeacherAssessment[]>([]);

  /* 会话列表 8 秒轮询（参数要求 ≤10 秒刷新）；切到回放页也保持，页签上的数字才是准的 */
  useEffect(() => {
    let cancelled = false;
    const tick = () => apiGet<TrackingItem[]>("/v1/teacher/tracking", session).then((rows) => { if (!cancelled) setItems(rows); }).catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [session]);

  const loadAssessments = useCallback(
    () => apiGet<TeacherAssessment[]>("/v1/teacher/assessments", session).then(setAssessments).catch((cause) => toast.error(errorText(cause))),
    [session],
  );
  useEffect(() => { void loadAssessments(); }, [loadAssessments]);

  const live = items.filter((item) => !item.suspended).length;
  const pending = assessments.filter((item) => !item.reviewedAt).length;

  return (
    <>
      <HeaderTabs
        items={[
          { id: "live", label: "实时监控", count: live },
          { id: "replay", label: "回放与评分", count: pending || undefined },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "live"
        ? <LiveConsole session={session} items={items} onReplay={() => setTab("replay")} onNavigate={onNavigate} />
        : <Replay session={session} rows={assessments} reload={loadAssessments} />}
    </>
  );
}

// ---------- 实时监控 ----------

/** 满意度走势：两轮以上才画 */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const width = 240;
  const height = 40;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * width},${height - 4 - (Math.max(0, Math.min(100, value)) / 100) * (height - 8)}`);
  const down = values[values.length - 1]! < values[0]!;
  const color = down ? "var(--c-danger)" : "var(--c-brand)";
  return (
    <svg className="mon-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`0,${height} ${points.join(" ")} ${width},${height}`} fill={down ? "var(--c-danger-wash)" : "var(--c-brand-soft)"} stroke="none" />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const EMOTION_TONE: Record<string, "danger" | "warn" | "neutral"> = { 愤怒: "danger", 不满: "danger", 焦虑: "warn", 犹豫: "warn" };

interface TrackingToday { activeToday: number; pendingReviews: number; notPracticedToday: number; studentTotal: number }

function LiveConsole({ session, items, onReplay, onNavigate }: { session: Session; items: TrackingItem[]; onReplay: () => void; onNavigate?: (page: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [snapshot, setSnapshot] = useState<TrackingItem | null>(null);
  const [showStale, setShowStale] = useState(false);
  const [today, setToday] = useState<TrackingToday | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);

  /* 按紧急程度分组：需介入（买家等 3–30 分钟）→ 进行中 → 暂离；超过 1 天没动的收进“已中断”一行 */
  const byRecent = (a: TrackingItem, b: TrackingItem) => new Date(b.lastAt ?? b.startedAt).getTime() - new Date(a.lastAt ?? a.startedAt).getTime();
  const groups = useMemo(() => {
    const active = items.filter((item) => !item.suspended);
    return {
      alert: active.filter((item) => item.alert).sort((a, b) => b.idleSeconds - a.idleSeconds),
      going: active.filter((item) => !item.alert).sort(byRecent),
      away: items.filter((item) => item.suspended && !item.stale).sort(byRecent),
      stale: items.filter((item) => item.suspended && item.stale).sort(byRecent),
    };
  }, [items]);
  const students = new Set([...groups.alert, ...groups.going].map((item) => item.username)).size;
  const hasCurrent = groups.alert.length + groups.going.length + groups.away.length > 0;

  useEffect(() => {
    if (selectedId) return;
    const first = groups.alert[0] ?? groups.going[0] ?? groups.away[0];
    if (first) setSelectedId(first.conversationId);
  }, [groups, selectedId]);

  useEffect(() => {
    if (hasCurrent) return;
    apiGet<TrackingToday>("/v1/teacher/tracking/today", session).then(setToday).catch(() => undefined);
  }, [hasCurrent, session]);

  const selected = items.find((item) => item.conversationId === selectedId) ?? null;
  useEffect(() => { if (selected) setSnapshot(selected); }, [selected]);
  const closed = selectedId != null && !selected;
  const view = selected ?? (closed && snapshot?.conversationId === selectedId ? snapshot : null);

  const loadMessages = useCallback(async () => {
    if (!selectedId) return;
    try {
      setMessages(await apiGet<ConversationMessage[]>(`/v1/teacher/conversations/${selectedId}/messages`, session));
    } catch {
      /* 轮询失败下次再试 */
    }
  }, [selectedId, session]);
  useEffect(() => {
    setMessages(null);
    if (!selectedId) return;
    pinnedRef.current = true;
    void loadMessages();
    const timer = window.setInterval(() => void loadMessages(), 8000);
    return () => window.clearInterval(timer);
  }, [selectedId, loadMessages]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send() {
    if (!selectedId || !draft.trim() || sending) return;
    setSending(true);
    try {
      await apiPost(`/v1/teacher/conversations/${selectedId}/intervene`, session, { content: draft.trim() });
      setDraft("");
      pinnedRef.current = true;
      await loadMessages();
      toast.ok("已发给学生，买家看不到");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSending(false);
    }
  }

  const queueItem = (item: TrackingItem) => {
    const waiting = item.lastSender === "buyer";
    const wait = item.suspended ? formatIdle(item.idleSeconds)
      : waiting && item.idleSeconds >= 60 ? `等 ${formatIdle(item.idleSeconds)}`
        : item.idleSeconds < 60 ? "刚刚" : `${formatIdle(item.idleSeconds)}前`;
    const waitCls = item.alert ? "is-bad" : waiting && item.idleSeconds >= 60 && !item.suspended ? "is-warn" : "";
    return (
      <button
        key={item.conversationId}
        type="button"
        className={item.conversationId === selectedId ? "mon-qi is-on" : "mon-qi"}
        onClick={() => setSelectedId(item.conversationId)}
      >
        <BuyerAvatar buyer={item.buyer} />
        <span className="mon-qi-main">
          <span className="mon-qi-name">{item.studentName}{item.practice ? <small>练习</small> : null}</span>
          <span className="mon-qi-meta">{item.buyer.name} · {item.scenarioName}</span>
        </span>
        <span className="mon-qi-side">
          <span className={`mon-qi-wait ${waitCls}`}>{wait}</span>
          <span className="mon-qi-score">得分 <b className={item.liveScore != null && item.liveScore < 60 ? "is-bad" : undefined}>{item.liveScore ?? "—"}</b></span>
        </span>
      </button>
    );
  };

  if (!hasCurrent && !view) {
    return (
      <div className="mon-empty">
        <div className="mon-empty-box">
          <div className="mon-empty-icon"><MonitorPlay size={28} /></div>
          <h3>现在没有学生在接待</h3>
          <p>学生打开客服工作台开始接待后，会话会出现在这里，你可以旁观并随时发指导。</p>
          {today ? (
            <div className="board mon-today">
              <div><small>今天接待过</small><b>{today.activeToday}<span> 人</span></b><button type="button" className="board-link" onClick={() => onNavigate?.("classes")}>看名单 →</button></div>
              <div><small>等你复核</small><b className={today.pendingReviews ? "is-bad" : undefined}>{today.pendingReviews}<span> 份</span></b><button type="button" className="board-link" onClick={onReplay}>去复核 →</button></div>
              <div><small>今天还没练</small><b className={today.notPracticedToday ? "is-warn" : undefined}>{today.notPracticedToday}<span> 人</span></b><button type="button" className="board-link" onClick={() => onNavigate?.("classes")}>看是谁 →</button></div>
            </div>
          ) : null}
          {groups.stale.length ? <p className="mon-empty-note">另有 {groups.stale.length} 个会话超过 1 天没动，已经不再提醒。</p> : null}
        </div>
      </div>
    );
  }

  /* 已用时：开始到最后一条消息（暂离的会话不再累计） */
  const elapsed = view ? Math.max(1, Math.round((new Date(view.lastAt ?? view.startedAt).getTime() - new Date(view.startedAt).getTime()) / 60000)) : 0;
  const trend = view?.satisfactionTrend ?? [];
  const emotionTone = view?.emotion ? EMOTION_TONE[view.emotion] ?? "neutral" : "neutral";

  return (
    <div className="mon">
      <aside className="mon-queue">
        <div className="mon-queue-head"><span className="mon-dot" />{students} 人在接待<span>每 8 秒刷新</span></div>
        <div className="mon-queue-list">
          {groups.alert.length ? <div className="mon-grp is-bad">需介入<span>{groups.alert.length} · 买家在等回复</span></div> : null}
          {groups.alert.map(queueItem)}
          {groups.going.length ? <div className="mon-grp">进行中<span>{groups.going.length}</span></div> : null}
          {groups.going.map(queueItem)}
          {groups.away.length ? <div className="mon-grp">暂离<span>{groups.away.length} · 10 分钟以上没动</span></div> : null}
          {groups.away.map(queueItem)}
          {groups.stale.length ? (
            <>
              <button type="button" className="mon-fold" onClick={() => setShowStale((value) => !value)}>
                <Archive size={14} />已中断 {groups.stale.length} 个 · 超过 1 天没动<span>{showStale ? "收起" : "展开"}</span>
              </button>
              {showStale ? groups.stale.map(queueItem) : null}
            </>
          ) : null}
        </div>
      </aside>

      <section className="mon-conv">
        {view ? (
          <>
            <header className="mon-conv-head">
              <b>{view.studentName}</b>
              <span>正在接待 {view.buyer.name} · {view.scenarioName} · {new Date(view.startedAt).toDateString() === new Date().toDateString() ? time(view.startedAt) : new Date(view.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 开始</span>
              <span className="mon-conv-state">
                {view.practice ? <Tag>自由练习，不计成绩</Tag> : null}
                {closed ? <Tag>已结束</Tag>
                  : view.alert ? <Tag tone="danger">买家等了 {formatIdle(view.idleSeconds)}</Tag>
                    : view.suspended ? <Tag>暂离 {formatIdle(view.idleSeconds)}</Tag>
                      : view.lastSender === "buyer" && view.idleSeconds >= 60 ? <Tag tone="warn">买家等了 {formatIdle(view.idleSeconds)}</Tag> : null}
              </span>
            </header>
            {closed ? <div className="console-closed">这个会话已经结束。评分出来后，可以在「回放与评分」里看完整对话并复核。</div> : null}
            <div
              ref={bodyRef}
              className="mon-msgs"
              onScroll={(event) => {
                const el = event.currentTarget;
                pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
            >
              {messages === null ? <p className="console-hint">正在读取对话…</p> : messages.length === 0 ? <p className="console-hint">刚开始，还没有消息</p>
                : messages.map((message) => <MessageBubble key={message.id} message={message} buyer={view.buyer} studentName={view.studentName} />)}
              {!closed && !view.suspended && view.lastSender === "buyer" && view.idleSeconds >= 60 ? (
                <div className="mon-typing">学生还没有回复 · {formatIdle(view.idleSeconds)}</div>
              ) : null}
            </div>
            {closed ? (
              <footer className="mon-ended"><span>这次接待已经结束</span><button type="button" className="board-link" onClick={onReplay}>去回放与评分复核 →</button></footer>
            ) : (
              /* 指导输入（D-30）：一个整体的输入框——发给谁 / 写什么 / 常用指导 + 发送；学生暂离时上方提示 */
              <footer className="mon-compose">
                {view.suspended ? (
                  <div className="mon-away"><Clock size={14} />{view.studentName}已暂离 {formatIdle(view.idleSeconds)}，指导会在他回到工作台后看到</div>
                ) : null}
                <div className="mon-box">
                  <div className="mon-box-who"><Lightbulb size={14} />发给 <b>{view.studentName}</b> · 只有学生能看到，买家看不到</div>
                  <textarea
                    ref={inputRef}
                    rows={2}
                    maxLength={300}
                    value={draft}
                    placeholder="写一条指导，比如：先安抚买家，再问清少了哪一件"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="mon-box-bar">
                    <MoreMenu
                      trigger={<><List size={14} />常用指导</>}
                      triggerClassName="mon-quick"
                      items={GUIDANCE_PRESETS.map((preset) => ({ label: preset, onClick: () => { setDraft(preset); inputRef.current?.focus(); } }))}
                    />
                    <span className="mon-keys">Enter 发送 · Shift + Enter 换行</span>
                    <Button variant="primary" size="sm" icon={Send} loading={sending} disabled={!draft.trim()} onClick={() => void send()}>发送指导</Button>
                  </div>
                </div>
              </footer>
            )}
          </>
        ) : (
          <div className="console-blank"><MonitorPlay size={28} /><p>从左边选一个会话旁观</p></div>
        )}
      </section>

      <aside className="mon-panel">
        {view ? (
          <>
            <div className="mon-pb">
              <h5>现场</h5>
              <div className="mon-figs">
                <div><small>实时得分</small><b className={view.liveScore != null && view.liveScore < 60 ? "is-bad" : undefined}>{view.liveScore ?? "—"}</b></div>
                <div><small>买家满意度</small><b className={view.satisfaction != null && view.satisfaction < 40 ? "is-bad" : view.satisfaction != null && view.satisfaction < 60 ? "is-warn" : undefined}>{view.satisfaction ?? "—"}{view.satisfaction != null ? <span>/ 100</span> : null}</b></div>
                <div><small>轮次</small><b>{view.studentTurns}</b></div>
                <div><small>已用时</small><b>{elapsed < 60 ? elapsed : elapsed < 1440 ? Math.floor(elapsed / 60) : Math.floor(elapsed / 1440)}<span>{elapsed < 60 ? "分钟" : elapsed < 1440 ? "小时" : "天"}</span></b></div>
              </div>
              {trend.length >= 2 ? (
                <>
                  <span className="mon-cap">满意度走势 · 从 {trend[0]} {trend[trend.length - 1]! < trend[0]! ? "降到" : "升到"} {trend[trend.length - 1]}</span>
                  <Sparkline values={trend} />
                </>
              ) : <span className="mon-cap">满意度走势在第 2 轮之后出现</span>}
            </div>
            <div className="mon-pb">
              <h5>买家</h5>
              <div className="mon-buyer">
                <BuyerAvatar buyer={view.buyer} />
                <div><b>{view.buyer.name}</b><span>{view.buyer.nationality} · {LANGUAGE_NAMES[view.buyer.language] ?? view.buyer.language} · {view.buyer.customerType}</span></div>
              </div>
              <dl className="mon-kv">
                {view.personality ? <><dt>性格</dt><dd>{view.personality}</dd></> : null}
                {view.emotion ? <><dt>当前情绪</dt><dd><Tag tone={emotionTone}>{view.emotion}</Tag></dd></> : null}
                {view.stage ? <><dt>对话阶段</dt><dd>{view.stage}</dd></> : null}
                <dt>身份</dt><dd>{view.buyer.identity}</dd>
              </dl>
            </div>
            {view.objective || view.buyerGoal || view.bottomLine ? (
              <div className="mon-pb">
                <h5>场景目标<span className="mon-lock"><Lock size={12} />只有老师能看到</span></h5>
                <div className="mon-goal">
                  {view.objective ? <p><b>学生要做到：</b>{view.objective}</p> : null}
                  {view.buyerGoal ? <p><b>买家想要：</b>{view.buyerGoal}</p> : null}
                  {view.bottomLine ? <p><b>买家底线：</b>{view.bottomLine}</p> : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </aside>
    </div>
  );
}

// ---------- 回放与评分 ----------

function Replay({ session, rows, reload }: { session: Session; rows: TeacherAssessment[]; reload: () => Promise<unknown> }) {
  const [keyword, setKeyword] = useState(takeReplaySearch);
  const [filter, setFilter] = useState<"pending" | "low" | "reviewed" | "all">(() => (keyword ? "all" : "pending"));
  const [reviewing, setReviewing] = useState<TeacherAssessment | null>(null);

  const visible = useMemo(() => {
    const word = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "pending" && row.reviewedAt) return false;
      if (filter === "reviewed" && !row.reviewedAt) return false;
      if (filter === "low" && row.total >= 60) return false;
      return !word || `${row.studentName} ${row.username} ${row.scenarioName} ${row.buyerName} ${row.taskName ?? ""}`.toLowerCase().includes(word);
    });
  }, [rows, keyword, filter]);
  const reviewedCount = rows.filter((row) => row.reviewedAt).length;
  const when = (iso: string) => {
    const date = new Date(iso);
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
    const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return days === 0 ? `今天 ${clock}` : days === 1 ? `昨天 ${clock}` : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <Bench>
      <Toolbar>
        <FilterChips
          items={[
            { id: "pending", label: "待复核", count: rows.length - reviewedCount },
            { id: "low", label: "低于 60 分", count: rows.filter((row) => row.total < 60).length },
            { id: "reviewed", label: "已复核", count: reviewedCount },
            { id: "all", label: "全部", count: rows.length },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索学生、任务或场景" />
      </Toolbar>
      <Board>
        {visible.length === 0 ? (
          <p className="board-quiet">{rows.length === 0 ? "还没有评分。学生结束一次接待后，AI 会自动评分并出现在这里。" : filter === "pending" ? "都复核过了" : "没有符合条件的记录"}</p>
        ) : (
          <>
            <div className="rv-row is-head"><span>总分</span><span>学生 · 评语</span><span>六项能力</span><span>时间</span><span /></div>
            {visible.map((row) => {
              const band = row.total < 60 ? "is-bad" : row.total >= 80 ? "is-good" : "";
              return (
                <div key={row.id} className="rv-row" role="button" tabIndex={0} onClick={() => setReviewing(row)} onKeyDown={(event) => { if (event.key === "Enter") setReviewing(row); }}>
                  <span className={`rv-score ${band}`}><b>{row.total}</b><small>{row.reviewedAt ? "已复核" : "AI 评分"}</small></span>
                  <span className="rv-main">
                    <span className="rv-who"><b>{row.studentName}</b>{row.practice ? <Tag>练习</Tag> : null}<span>{row.taskName ? `${row.taskName} · ` : ""}{row.scenarioName} · 买家 {row.buyerName}</span></span>
                    <span className="rv-comment">{row.teacherComment || row.comment || "—"}</span>
                  </span>
                  <span className="rv-dims" title={ASSESSMENT_DIMENSIONS.map((dim) => `${dim.label} ${row.scores?.[dim.id] ?? "—"}`).join("　")}>
                    {ASSESSMENT_DIMENSIONS.map((dim) => {
                      const value = Number(row.scores?.[dim.id] ?? 0);
                      return <i key={dim.id} className={value < 60 ? "is-low" : undefined} style={{ height: `${Math.max(12, ((value - 30) / 70) * 100)}%` }} />;
                    })}
                  </span>
                  <span className="rv-time">{when(row.createdAt)}</span>
                  <span className="rv-op">
                    <Button size="sm" variant={row.reviewedAt ? "ghost" : undefined} onClick={(event) => { event.stopPropagation(); setReviewing(row); }}>{row.reviewedAt ? "查看" : "复核"}</Button>
                  </span>
                </div>
              );
            })}
          </>
        )}
      </Board>
      {reviewing ? (
        <ReviewDrawer
          session={session}
          item={reviewing}
          onClose={() => setReviewing(null)}
          onSaved={() => { setReviewing(null); void reload(); }}
        />
      ) : null}
    </Bench>
  );
}

function ReviewDrawer({ session, item, onClose, onSaved }: { session: Session; item: TeacherAssessment; onClose: () => void; onSaved: () => void }) {
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [scores, setScores] = useState<Record<string, string>>(() => Object.fromEntries(ASSESSMENT_DIMENSIONS.map((dim) => [dim.id, String(item.scores?.[dim.id] ?? "")])));
  const [comment, setComment] = useState(item.teacherComment ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<ConversationMessage[]>(`/v1/teacher/conversations/${item.conversationId}/messages`, session).then(setMessages).catch((cause) => toast.error(errorText(cause)));
  }, [item.conversationId, session]);

  const numeric = Object.fromEntries(Object.entries(scores).map(([id, value]) => [id, Number(value)]));
  const invalid = ASSESSMENT_DIMENSIONS.find((dim) => scores[dim.id] === "" || !Number.isFinite(numeric[dim.id]) || numeric[dim.id]! < 0 || numeric[dim.id]! > 100);
  const total = invalid ? null : previewTotal(numeric, item.weights);
  const aiScores = item.aiScores ?? item.scores;
  const aiTotal = item.aiTotal ?? item.total;

  async function save() {
    if (invalid) return toast.error(`「${invalid.label}」要填 0–100`);
    setBusy(true);
    try {
      await apiRequestPatch(`/v1/teacher/assessments/${item.id}`, session, { scores: numeric, teacherComment: comment.trim() });
      toast.ok("已保存，学生那边的成绩同步更新");
      onSaved();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function exportReplay() {
    const lines = [
      `${item.studentName}（${item.username}）· ${item.taskName ?? "自由练习"} · ${item.scenarioName}`,
      `买家：${item.buyerName}　时间：${new Date(item.createdAt).toLocaleString("zh-CN")}`,
      "",
      "【对话】",
      ...(messages ?? []).map((message) => `${time(message.createdAt)} ${SENDER_LABELS[message.sender] ?? message.sender}：${KIND_LABELS[message.kind ?? ""] ?? ""}${message.content}`),
      "",
      `【评分】总分 ${item.total}${item.reviewedAt ? `（AI 原始 ${aiTotal}）` : ""}`,
      ...ASSESSMENT_DIMENSIONS.map((dim) => `${dim.label}：${item.scores?.[dim.id] ?? "—"}`),
      "",
      `【AI 评语】${item.comment || "—"}`,
      ...(item.teacherComment ? [`【老师评语】${item.teacherComment}`] : []),
    ];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `回放-${item.studentName}-${item.scenarioName}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <Drawer
      title={`${item.studentName} · ${item.scenarioName}`}
      width={1040}
      flush
      onClose={onClose}
      footer={
        <>
          <Button icon={Download} variant="ghost" disabled={!messages} onClick={exportReplay}>导出回放</Button>
          <span className="drawer-spacer" />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>保存复核</Button>
        </>
      }
    >
      <div className="review">
        <div className="review-chat">
          <p className="review-chat-meta">{item.taskName ?? "自由练习"} · 买家 {item.buyerName} · {new Date(item.createdAt).toLocaleString("zh-CN")}</p>
          {messages === null ? <p className="console-hint">正在读取对话…</p> : messages.length === 0 ? <Empty>这次接待没有消息</Empty> : messages.map((message) => <MessageBubble key={message.id} message={message} studentName={item.studentName} />)}
        </div>
        <div className="review-side">
          <div className="review-total">
            <span>总分</span>
            <strong>{total ?? "—"}</strong>
            <em>{total != null && total !== aiTotal ? `AI 原始 ${aiTotal}` : "AI 评分"}{Object.values(item.weights ?? {}).some((value) => value > 0) ? " · 按任务权重计算" : " · 六项等权"}</em>
          </div>
          <div className="review-dims">
            {ASSESSMENT_DIMENSIONS.map((dim) => {
              const changed = scores[dim.id] !== String(aiScores?.[dim.id] ?? "");
              return (
                <label key={dim.id} className="review-dim">
                  <span>{dim.label}{item.weights?.[dim.id] ? <small>{item.weights[dim.id]}%</small> : null}</span>
                  <input
                    type="range" min={0} max={100}
                    value={Number(scores[dim.id]) || 0}
                    onChange={(event) => setScores((current) => ({ ...current, [dim.id]: event.target.value }))}
                  />
                  <Input
                    className="num-input review-dim-input"
                    type="number" min={0} max={100}
                    value={scores[dim.id]}
                    onChange={(event) => setScores((current) => ({ ...current, [dim.id]: event.target.value }))}
                  />
                  <em>{changed ? `AI ${aiScores?.[dim.id] ?? "—"}` : ""}</em>
                </label>
              );
            })}
          </div>
          <div className="review-block">
            <h4>AI 评语</h4>
            <p>{item.comment || "—"}</p>
            {item.suggestions?.length ? (
              <ol>{item.suggestions.map((tip, index) => <li key={index}>{tip}</li>)}</ol>
            ) : null}
          </div>
          <Field label="老师评语" hint="学生在「我的记录」里会看到，和 AI 评语分开显示">
            <Textarea rows={4} maxLength={500} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="写给学生的话，可以不填" />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}
