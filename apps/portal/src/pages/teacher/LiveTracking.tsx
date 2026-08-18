import { AlertTriangle, Clock, MessageCircleMore, MonitorPlay, Search, Send, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import {
  ApiError,
  apiGet,
  apiPost,
  apiRequestPatch,
  assetUrl,
  type BuyerPublicView,
  type ConversationMessage,
  type Session,
} from "../../api/client";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import { formatIdle, scoreBand } from "./widgets";

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
  /** 挂起：学生已暂离（近 10 分钟无消息且超出买家等待 30 分钟介入窗口），不触发预警 */
  suspended: boolean;
  /** 预警：买家等待 3-30 分钟（学生大概率在线，介入有意义） */
  alert: boolean;
}

interface TeacherAssessment {
  id: string;
  conversationId: string;
  studentName: string;
  buyerName: string;
  scenarioName: string;
  scores: Record<string, number>;
  total: number;
  comment: string;
  suggestions: string[] | null;
  createdAt: string;
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

const SENDER_LABELS: Record<string, string> = { buyer: "买家", student: "学生", teacher: "教师" };

const KIND_MARKS: Record<string, string> = {
  product: "🛍 ",
  coupon: "🎟 ",
  order: "📦 ",
  invite: "🧾 ",
  image: "🖼 ",
  video: "🎬 ",
  file: "📎 ",
};

/* 常用指导语：教师自主介入的快捷入口 */
const GUIDANCE_PRESETS = [
  "先安抚客户情绪，再给出解决方案",
  "注意平台合规用语，避免绝对化承诺",
  "给出明确的物流 / 售后时间节点",
  "关注买家真实诉求，避免机械推销",
];

function MessageBubble({ message }: { message: ConversationMessage }) {
  if (message.sender === "teacher") {
    return <div className="rec-note">教师指导 · {message.content}</div>;
  }
  const mine = message.sender === "student";
  const audioUrl =
    message.kind === "voice" ? (message.payload as { audioUrl?: string } | null)?.audioUrl : undefined;
  const mark = message.kind === "voice" ? "🎤 " : KIND_MARKS[message.kind ?? "text"] ?? "";
  return (
    <div className={mine ? "rec-msg me" : "rec-msg"}>
      <div>
        <p className="rec-bubble">
          {mark}
          {message.content}
          {audioUrl ? (
            <button
              className="text-button"
              onClick={() => {
                const url = assetUrl(audioUrl);
                if (url) void new Audio(url).play();
              }}
            >
              播放
            </button>
          ) : null}
        </p>
        <small>
          {SENDER_LABELS[message.sender] ?? message.sender} · {new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
        </small>
      </div>
    </div>
  );
}

export function LiveTracking({ session }: { session: Session }) {
  const [tab, setTab] = useState<"live" | "replay">("live");
  const [items, setItems] = useState<TrackingItem[]>([]);
  const [railFilter, setRailFilter] = useState<"all" | "alert" | "suspended">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [intervention, setIntervention] = useState("");
  const [sending, setSending] = useState(false);

  const [assessments, setAssessments] = useState<TeacherAssessment[]>([]);
  const [replayQuery, setReplayQuery] = useState("");
  const [reviewing, setReviewing] = useState<TeacherAssessment | null>(null);
  const [reviewMessages, setReviewMessages] = useState<ConversationMessage[] | null>(null);
  const [reviewTotal, setReviewTotal] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");

  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  /* 会话列表：8 秒轮询（满足 ≤10 秒刷新红线） */
  useEffect(() => {
    if (tab !== "live") return;
    let cancelled = false;
    const tick = () => {
      apiGet<TrackingItem[]>("/v1/teacher/tracking", session)
        .then((rows) => {
          if (!cancelled) setItems(rows);
        })
        .catch((cause) => {
          if (!cancelled) setError(errorText(cause));
        });
    };
    tick();
    const timer = window.setInterval(tick, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tab, session]);

  /* 选中会话的消息流：随选择加载 + 同频自动刷新 */
  useEffect(() => {
    if (tab !== "live" || !selectedId) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      apiGet<ConversationMessage[]>(`/v1/teacher/conversations/${selectedId}/messages`, session)
        .then((rows) => {
          if (!cancelled) setMessages(rows);
        })
        .catch((cause) => {
          if (!cancelled) setError(errorText(cause));
        });
    };
    pinnedRef.current = true;
    load();
    const timer = window.setInterval(load, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tab, selectedId, session]);

  /* 新消息到达时，若视图停留在底部则自动跟随 */
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* 进行中 / 挂起分组：预警优先，其余按最后活动倒序 */
  const liveItems = useMemo(
    () =>
      items
        .filter((item) => !item.suspended)
        .sort(
          (a, b) =>
            Number(b.alert) - Number(a.alert) ||
            new Date(b.lastAt ?? b.startedAt).getTime() - new Date(a.lastAt ?? a.startedAt).getTime(),
        ),
    [items],
  );
  const suspendedItems = useMemo(
    () =>
      items
        .filter((item) => item.suspended)
        .sort((a, b) => new Date(b.lastAt ?? b.startedAt).getTime() - new Date(a.lastAt ?? a.startedAt).getTime()),
    [items],
  );
  const railItems =
    railFilter === "suspended"
      ? suspendedItems
      : railFilter === "alert"
        ? liveItems.filter((item) => item.alert)
        : liveItems;
  const alerts = liveItems.filter((item) => item.alert).length;
  const onlineStudents = new Set(liveItems.map((item) => item.username)).size;

  /* 首次载入自动选中第一个进行中会话（预警优先排序）；只有挂起会话时不自动选中 */
  useEffect(() => {
    if (tab !== "live") return;
    if (!selectedId && liveItems.length > 0) setSelectedId(liveItems[0]!.conversationId);
  }, [tab, liveItems, selectedId]);

  const selected = items.find((item) => item.conversationId === selectedId) ?? null;
  /* 会话结束后保留快照，头部信息与回放不消失 */
  const [snapshot, setSnapshot] = useState<TrackingItem | null>(null);
  useEffect(() => {
    if (selected) setSnapshot(selected);
  }, [selected]);
  const selectedClosed = selectedId != null && !selected;
  const view = selected ?? (selectedClosed && snapshot?.conversationId === selectedId ? snapshot : null);

  async function intervene() {
    if (!selectedId || !intervention.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      await apiPost(`/v1/teacher/conversations/${selectedId}/intervene`, session, {
        content: intervention.trim(),
      });
      setIntervention("");
      setNotice("指导已发送，学生会话中即时可见。");
      pinnedRef.current = true;
      const rows = await apiGet<ConversationMessage[]>(`/v1/teacher/conversations/${selectedId}/messages`, session);
      setMessages(rows);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSending(false);
    }
  }

  /* 回放与评分 */
  const loadAssessments = useCallback(() => {
    apiGet<TeacherAssessment[]>("/v1/teacher/assessments", session)
      .then(setAssessments)
      .catch((cause) => setError(errorText(cause)));
  }, [session]);

  useEffect(() => {
    if (tab !== "replay") return;
    loadAssessments();
  }, [tab, loadAssessments]);

  useEffect(() => {
    if (!reviewing) {
      setReviewMessages(null);
      return;
    }
    let cancelled = false;
    apiGet<ConversationMessage[]>(`/v1/teacher/conversations/${reviewing.conversationId}/messages`, session)
      .then((rows) => {
        if (!cancelled) setReviewMessages(rows);
      })
      .catch((cause) => {
        if (!cancelled) setReviewError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [reviewing, session]);

  function openReview(item: TeacherAssessment) {
    setReviewing(item);
    setReviewTotal(String(item.total));
    setReviewComment(item.comment ?? "");
    setReviewError("");
  }

  async function submitReview() {
    if (!reviewing || reviewBusy) return;
    const total = reviewTotal.trim() === "" ? undefined : Number(reviewTotal);
    if (total !== undefined && (!Number.isFinite(total) || total < 0 || total > 100)) {
      setReviewError("总分须在 0-100 之间。");
      return;
    }
    setReviewBusy(true);
    setReviewError("");
    try {
      await apiRequestPatch(`/v1/teacher/assessments/${reviewing.id}`, session, {
        total,
        comment: reviewComment.trim() || undefined,
      });
      setNotice(`已保存对 ${reviewing.studentName} 的复核，学生成绩同步更新。`);
      setReviewing(null);
      loadAssessments();
    } catch (cause) {
      setReviewError(errorText(cause));
    } finally {
      setReviewBusy(false);
    }
  }

  /* 会话卡：进行中/挂起共用。红色只留给真预警（买家等待 3-30 分钟）；挂起卡整体降饱和 */
  function renderSession(item: TrackingItem) {
    const waiting = item.lastSender === "buyer" && !item.suspended;
    const idleTone = item.alert ? "hot" : waiting && item.idleSeconds > 60 ? "warn" : "";
    const className = [
      "tt-session",
      item.conversationId === selectedId ? "active" : "",
      item.suspended ? "suspended" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button key={item.conversationId} className={className} onClick={() => setSelectedId(item.conversationId)}>
        <span className="tt-session-top">
          <span className="avatar small">{item.studentName.slice(0, 1)}</span>
          <span className="tt-session-name">
            <strong>{item.studentName}</strong>
            <small>{item.username}</small>
          </span>
          {item.practice ? <em className="tt-practice">练习</em> : null}
          {item.alert ? <em className="tt-flag">需介入</em> : null}
          <em className={idleTone ? `tt-idle ${idleTone}` : "tt-idle"}>
            {item.suspended ? `暂离 ${formatIdle(item.idleSeconds)}` : waiting ? `等 ${formatIdle(item.idleSeconds)}` : formatIdle(item.idleSeconds)}
          </em>
        </span>
        <span className="tt-session-mid">
          <span>{item.scenarioName} · {item.buyer.name}</span>
          {item.studentTurns > 0 ? (
            <>
              <i aria-hidden="true" />
              <em>第 {item.studentTurns} 轮</em>
            </>
          ) : null}
          {item.liveScore != null ? (
            <>
              <i aria-hidden="true" />
              <em className={item.liveScore < 60 ? "tt-score-chip low" : "tt-score-chip"}>{item.liveScore} 分</em>
            </>
          ) : null}
        </span>
        <span className={item.alert ? "tt-session-snippet waiting" : "tt-session-snippet"}>
          {item.lastContent
            ? `${SENDER_LABELS[item.lastSender ?? ""] ?? "系统"}：${item.lastContent}`
            : "会话刚开始，暂无消息"}
        </span>
      </button>
    );
  }

  const visibleAssessments = useMemo(() => {
    const keyword = replayQuery.trim().toLowerCase();
    if (!keyword) return assessments;
    return assessments.filter((item) =>
      `${item.studentName} ${item.scenarioName} ${item.buyerName}`.toLowerCase().includes(keyword),
    );
  }, [assessments, replayQuery]);

  return (
    <div className="page tracking-page">
      <PageHeader
        title="实训跟踪"
        description="左侧选择学生会话即可实时旁观对话；无论是否预警，都可以随时介入指导。"
        actions={
          tab === "live" ? (
            <span className="tt-live-indicator"><i aria-hidden="true" /> 实时监控中 · 8 秒自动刷新</span>
          ) : undefined
        }
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="segmented-tabs page-tabs">
        <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>实时监控<span>{items.length}</span></button>
        <button className={tab === "replay" ? "active" : ""} onClick={() => setTab("replay")}>回放与评分<span>{assessments.length}</span></button>
      </div>

      {tab === "live" ? (
        <>
          <section className="tt-stats">
            <article>
              <span className="tt-stat-icon"><UsersRound size={17} /></span>
              <div><strong>{onlineStudents}</strong><span>正在接待的学生</span></div>
            </article>
            <article>
              <span className="tt-stat-icon"><MessageCircleMore size={17} /></span>
              <div><strong>{liveItems.length}</strong><span>进行中会话</span></div>
            </article>
            <article className={alerts > 0 ? "alert" : ""}>
              <span className="tt-stat-icon"><AlertTriangle size={17} /></span>
              <div><strong>{alerts}</strong><span>待介入（买家等待 3-30 分钟）</span></div>
            </article>
            <article>
              <span className="tt-stat-icon"><Clock size={17} /></span>
              <div><strong>{suspendedItems.length}</strong><span>挂起会话（学生暂离）</span></div>
            </article>
          </section>

          <section className="panel tt-console">
            <aside className="tt-sessions">
              <div className="tt-sessions-head">
                <div className="rec-seg" role="group" aria-label="会话筛选">
                  <button className={railFilter === "all" ? "active" : ""} onClick={() => setRailFilter("all")}>进行中 {liveItems.length}</button>
                  <button className={railFilter === "alert" ? "active" : ""} onClick={() => setRailFilter("alert")}>需介入 {alerts}</button>
                  <button className={railFilter === "suspended" ? "active" : ""} onClick={() => setRailFilter("suspended")}>挂起 {suspendedItems.length}</button>
                </div>
              </div>
              <div className="tt-session-list">
                {railItems.map(renderSession)}
                {railItems.length === 0 ? (
                  <div className="tt-empty">
                    <MonitorPlay size={24} aria-hidden="true" />
                    <strong>
                      {railFilter === "suspended"
                        ? "暂无挂起会话"
                        : railFilter === "alert"
                          ? "没有待介入的会话"
                          : "当前没有进行中的会话"}
                    </strong>
                    <p>
                      {railFilter === "suspended"
                        ? "学生超过 30 分钟无消息往来的会话会归入挂起，不计预警。"
                        : railFilter === "alert"
                          ? "买家等待 3-30 分钟的进行中会话会自动标记为需介入。"
                          : "学生进入客服工作台开始接待后，会话会实时出现在这里。"}
                    </p>
                  </div>
                ) : null}
              </div>
            </aside>

            <div className="tt-viewer">
              {view ? (
                <>
                  <div className="tt-viewer-head">
                    <div className="tt-viewer-who">
                      <BuyerAvatar buyer={view.buyer} />
                      <div>
                        <div className="tt-viewer-title">
                          <strong>{view.studentName} × {view.buyer.name}</strong>
                          <span>{view.scenarioName}</span>
                        </div>
                        <div className="tt-viewer-meta">
                          {view.practice ? <em className="tt-practice">自由练习 · 不计入考核</em> : null}
                          {!selectedClosed && view.suspended ? <em className="tt-suspended-chip">挂起 · 学生暂离</em> : null}
                          {view.stage ? <em>{view.stage}</em> : null}
                          <em>{view.buyer.nationality}</em>
                          <em>{view.buyer.customerType}</em>
                          <span>开始于 {new Date(view.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                      </div>
                    </div>
                    <div className="tt-viewer-stats">
                      <div>
                        <strong className={view.liveScore != null && view.liveScore < 60 ? "low" : undefined}>
                          {view.liveScore ?? "—"}
                        </strong>
                        <span>实时得分</span>
                      </div>
                      {view.satisfaction != null ? (
                        <div><strong>{view.satisfaction}</strong><span>买家满意度</span></div>
                      ) : null}
                      <div><strong>{view.studentTurns}</strong><span>学生轮次</span></div>
                      <div>
                        <strong className={!selectedClosed && view.alert ? "low" : undefined}>
                          {selectedClosed ? "已结束" : formatIdle(view.idleSeconds)}
                        </strong>
                        <span>{selectedClosed ? "会话状态" : view.lastSender === "buyer" ? "买家等待" : "距上条消息"}</span>
                      </div>
                    </div>
                  </div>
                  {selectedClosed ? (
                    <div className="tt-closed-banner">
                      <AlertTriangle size={14} aria-hidden="true" />
                      该会话已结束。评分生成后可在「回放与评分」页签中查看完整回放并复核成绩。
                    </div>
                  ) : null}
                  <div
                    ref={bodyRef}
                    className="tt-viewer-body"
                    onScroll={(event) => {
                      const el = event.currentTarget;
                      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                    }}
                  >
                    {(messages ?? []).map((message) => <MessageBubble key={message.id} message={message} />)}
                    {messages === null ? <p className="muted" style={{ textAlign: "center" }}>加载对话…</p> : null}
                    {messages && messages.length === 0 ? <p className="muted" style={{ textAlign: "center" }}>会话刚开始，暂无消息。</p> : null}
                  </div>
                  {!selectedClosed ? (
                    <div className="tt-intervene">
                      <div className="tt-intervene-hints">
                        {GUIDANCE_PRESETS.map((preset) => (
                          <button key={preset} type="button" onClick={() => setIntervention(preset)}>{preset}</button>
                        ))}
                      </div>
                      <div className="tt-intervene-row">
                        <input
                          value={intervention}
                          onChange={(event) => setIntervention(event.target.value)}
                          placeholder="输入指导内容，回车发送，学生会话中即时可见（买家不受影响）"
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void intervene();
                          }}
                        />
                        <button className="primary-button compact" onClick={() => void intervene()} disabled={sending || !intervention.trim()}>
                          <Send size={14} /> {sending ? "发送中…" : "介入指导"}
                        </button>
                      </div>
                      <small>介入不打断买家对话；无论是否触发预警，都可以随时发送指导。</small>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="tt-viewer-empty">
                  <MonitorPlay size={28} aria-hidden="true" />
                  <strong>选择左侧会话开始监控</strong>
                  <p>点击左侧任一学生会话即可实时旁观对话内容，并随时发送介入指导。</p>
                </div>
              )}
            </div>
          </section>
        </>
      ) : (
        <section className="panel data-panel">
          <div className="tch-toolbar">
            <div className="tch-search">
              <Search size={14} aria-hidden="true" />
              <input
                value={replayQuery}
                placeholder="搜索学生、场景或买家"
                onChange={(event) => setReplayQuery(event.target.value)}
              />
            </div>
            <span className="tch-count">共 {visibleAssessments.length} 条评分记录</span>
          </div>
          <table>
            <thead><tr><th>学生</th><th>场景 / 买家</th><th>总分</th><th>AI 评语</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {visibleAssessments.map((item) => {
                const band = scoreBand(item.total);
                return (
                  <tr key={item.id}>
                    <td><strong>{item.studentName}</strong></td>
                    <td>{item.scenarioName}<small>{item.buyerName}</small></td>
                    <td>
                      <span className="tt-total-cell">
                        <strong>{item.total}</strong>
                        <em className={`rec-band ${band.cls}`}>{band.label}</em>
                      </span>
                    </td>
                    <td className="comment-cell">{item.comment || "—"}</td>
                    <td>{new Date(item.createdAt).toLocaleString("zh-CN")}</td>
                    <td className="tch-actions">
                      <button className="text-button" onClick={() => openReview(item)}>回放与复核</button>
                    </td>
                  </tr>
                );
              })}
              {visibleAssessments.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <span className="muted">
                      {assessments.length === 0 ? "暂无评分记录：学生完成实训、会话结束后自动生成。" : "没有匹配的评分记录。"}
                    </span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      )}

      {reviewing ? (
        <div className="rec-modal-overlay" onClick={() => setReviewing(null)}>
          <div className="rec-modal" role="dialog" aria-modal="true" aria-label="回放与复核" onClick={(event) => event.stopPropagation()}>
            <div className="rec-modal-head">
              <div className="rec-modal-title">
                <strong>回放与复核 · {reviewing.studentName}</strong>
                <p>{reviewing.scenarioName} · 买家 {reviewing.buyerName} · {new Date(reviewing.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <em className={`rec-band big ${scoreBand(reviewing.total).cls}`}>AI 评分 {reviewing.total}</em>
              <button className="secondary-button compact" onClick={() => setReviewing(null)}>关闭</button>
            </div>
            <div className="rec-modal-body tt-review-body">
              <div className="rec-chat">
                {(reviewMessages ?? []).map((message) => <MessageBubble key={message.id} message={message} />)}
                {reviewMessages === null ? <p className="muted rec-chat-hint">加载完整对话…</p> : null}
                {reviewMessages && reviewMessages.length === 0 ? <p className="muted rec-chat-hint">该会话没有消息记录。</p> : null}
              </div>
              <div className="rec-analysis">
                {reviewError ? <p className="form-error" role="alert">{reviewError}</p> : null}
                <div className="rec-side-title">六维评分</div>
                <div className="tt-dim-lines">
                  {ASSESSMENT_DIMENSIONS.map((dim) => {
                    const value = reviewing.scores?.[dim.id];
                    return (
                      <div key={dim.id} className="tt-dim-line">
                        <span>{dim.label}</span>
                        <span className="rec-bar"><b style={{ width: `${value ?? 0}%` }} /></span>
                        <strong>{value ?? "—"}</strong>
                      </div>
                    );
                  })}
                </div>
                {reviewing.comment ? (
                  <>
                    <div className="rec-side-title">AI 评语</div>
                    <div className="rec-quote">{reviewing.comment}</div>
                  </>
                ) : null}
                {reviewing.suggestions?.length ? (
                  <>
                    <div className="rec-side-title">AI 改进建议（学生端可见）</div>
                    <ol className="rec-tips">
                      {reviewing.suggestions.map((tip, index) => <li key={index}>{tip}</li>)}
                    </ol>
                  </>
                ) : null}
                <div className="rec-side-title">人工复核</div>
                <div className="tt-review-form">
                  <label>
                    总分（0-100，可依据回放自主调整）
                    <div className="tt-review-total">
                      <input type="number" min={0} max={100} value={reviewTotal} onChange={(event) => setReviewTotal(event.target.value)} />
                      <span className="muted" style={{ fontSize: 12 }}>AI 原始评分 {reviewing.total} 分</span>
                    </div>
                  </label>
                  <label>
                    复核评语（学生端可见）
                    <textarea rows={4} value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} />
                  </label>
                  <div className="tt-review-actions">
                    <button className="primary-button" onClick={() => void submitReview()} disabled={reviewBusy}>
                      {reviewBusy ? "保存中…" : "保存复核"}
                    </button>
                    <span className="muted">保存后学生端成绩同步更新，操作留存审计记录。</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
