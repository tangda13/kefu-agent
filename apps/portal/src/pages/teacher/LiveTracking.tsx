import { AlertTriangle, Eye, MessageCircleMore, Radio, Send, UserRoundCheck, UsersRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

interface TrackingItem {
  conversationId: string;
  studentName: string;
  username: string;
  buyer: BuyerPublicView;
  scenarioName: string;
  studentTurns: number;
  lastSender: string | null;
  lastContent: string;
  idleSeconds: number;
  liveScore: number | null;
  satisfaction: number | null;
  stage: string | null;
  startedAt: string;
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
  createdAt: string;
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

export function LiveTracking({ session }: { session: Session }) {
  const [tab, setTab] = useState<"live" | "replay">("live");
  const [items, setItems] = useState<TrackingItem[]>([]);
  const [assessments, setAssessments] = useState<TeacherAssessment[]>([]);
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [intervention, setIntervention] = useState("");
  const [reviewing, setReviewing] = useState<TeacherAssessment | null>(null);
  const [reviewTotal, setReviewTotal] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const timerRef = useRef<number | null>(null);

  const loadTracking = useCallback(() => {
    apiGet<TrackingItem[]>("/v1/teacher/tracking", session)
      .then(setItems)
      .catch((cause) => setError(errorText(cause)));
  }, [session]);

  // 8 秒轮询（满足 ≤10 秒刷新红线）
  useEffect(() => {
    if (tab !== "live") return;
    loadTracking();
    timerRef.current = window.setInterval(loadTracking, 8000);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [tab, loadTracking]);

  useEffect(() => {
    if (tab !== "replay") return;
    apiGet<TeacherAssessment[]>("/v1/teacher/assessments", session)
      .then(setAssessments)
      .catch((cause) => setError(errorText(cause)));
  }, [tab, session]);

  useEffect(() => {
    if (!viewing) {
      setMessages(null);
      return;
    }
    apiGet<ConversationMessage[]>(`/v1/teacher/conversations/${viewing.id}/messages`, session)
      .then(setMessages)
      .catch((cause) => setError(errorText(cause)));
  }, [viewing, session]);

  async function intervene() {
    if (!viewing || !intervention.trim()) return;
    try {
      await apiPost(`/v1/teacher/conversations/${viewing.id}/intervene`, session, {
        content: intervention.trim(),
      });
      setIntervention("");
      setNotice("指导已发送，学生会话中即时可见。");
      const rows = await apiGet<ConversationMessage[]>(`/v1/teacher/conversations/${viewing.id}/messages`, session);
      setMessages(rows);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function submitReview() {
    if (!reviewing) return;
    const total = reviewTotal.trim() === "" ? undefined : Number(reviewTotal);
    if (total !== undefined && (!Number.isFinite(total) || total < 0 || total > 100)) {
      setError("总分须在 0-100 之间。");
      return;
    }
    try {
      await apiRequestPatch(`/v1/teacher/assessments/${reviewing.id}`, session, {
        total,
        comment: reviewComment.trim() || undefined,
      });
      setNotice("复核已保存，学生成绩同步更新。");
      setReviewing(null);
      const rows = await apiGet<TeacherAssessment[]>("/v1/teacher/assessments", session);
      setAssessments(rows);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const alerts = items.filter((item) => item.alert).length;

  return (
    <div className="page tracking-page">
      <PageHeader
        eyebrow="LIVE TRAINING"
        title="实训跟踪"
        description="实时查看学生会话、轮次与等待时长；支持一键介入与回放复核。"
        actions={<span className="live-indicator"><Radio size={16} /> 实时监控 · 8 秒刷新</span>}
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="segmented-tabs page-tabs">
        <button className={tab === "live" ? "active" : ""} onClick={() => { setTab("live"); setViewing(null); }}>实时监控<span>{items.length}</span></button>
        <button className={tab === "replay" ? "active" : ""} onClick={() => { setTab("replay"); setViewing(null); }}>回放与评分<span>{assessments.length}</span></button>
      </div>

      {tab === "live" ? (
        <>
          <section className="tracking-metrics">
            <article><UsersRound size={20} /><span><strong>{new Set(items.map((item) => item.username)).size}</strong>在线学生</span></article>
            <article><MessageCircleMore size={20} /><span><strong>{items.length}</strong>进行中会话</span></article>
            <article className={alerts > 0 ? "alert" : ""}><AlertTriangle size={20} /><span><strong>{alerts}</strong>待介入预警</span></article>
          </section>
          <div className="student-live-grid">
            {items.map((item) => (
              <article className={item.alert ? "live-card warning" : "live-card"} key={item.conversationId}>
                <div>
                  <span className="avatar small">{item.studentName.slice(0, 1)}</span>
                  <span><strong>{item.studentName}</strong><small>{item.username}</small></span>
                  <em>{item.alert ? "需介入" : "进行中"}</em>
                </div>
                <dl>
                  <div><dt>场景</dt><dd>{item.scenarioName}</dd></div>
                  <div><dt>买家 / 阶段</dt><dd>{item.buyer.name}{item.stage ? ` · ${item.stage}` : ""}</dd></div>
                  <div><dt>实时得分</dt><dd>{item.liveScore != null ? <strong className={item.liveScore < 60 ? "state-warning" : ""}>{item.liveScore}</strong> : "—"}</dd></div>
                  <div><dt>轮次 / 等待</dt><dd>第 {item.studentTurns} 轮 · {item.idleSeconds >= 60 ? `${Math.floor(item.idleSeconds / 60)}分` : `${item.idleSeconds}秒`}</dd></div>
                </dl>
                <button
                  className={item.alert ? "danger-button" : "secondary-button compact"}
                  onClick={() => setViewing({ id: item.conversationId, title: `${item.studentName} × ${item.buyer.name}` })}
                >
                  {item.alert ? <><UserRoundCheck size={15} /> 介入指导</> : <><Eye size={15} /> 查看会话</>}
                </button>
              </article>
            ))}
            {items.length === 0 ? <p className="muted">当前没有进行中的学生会话。</p> : null}
          </div>
        </>
      ) : (
        <section className="panel data-panel">
          <table>
            <thead><tr><th>学生</th><th>场景 / 买家</th><th>总分</th><th>AI 评语</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {assessments.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.studentName}</strong></td>
                  <td>{item.scenarioName}<small>{item.buyerName}</small></td>
                  <td><strong className={item.total >= 80 ? "state-done" : ""}>{item.total}</strong></td>
                  <td className="comment-cell">{item.comment || "—"}</td>
                  <td>{new Date(item.createdAt).toLocaleString("zh-CN")}</td>
                  <td>
                    <button className="text-button" onClick={() => setViewing({ id: item.conversationId, title: `${item.studentName} 对话回放` })}>回放</button>
                    <button className="text-button" onClick={() => { setReviewing(item); setReviewTotal(String(item.total)); setReviewComment(item.comment); }}>复核</button>
                  </td>
                </tr>
              ))}
              {assessments.length === 0 ? <tr><td colSpan={6}><span className="muted">暂无评分记录。</span></td></tr> : null}
            </tbody>
          </table>
        </section>
      )}

      {reviewing ? (
        <section className="panel creation-form">
          <div className="panel-heading"><div><h2>人工复核 · {reviewing.studentName}</h2><p>调整后学生端成绩同步更新，操作留存审计</p></div></div>
          <div className="form-grid">
            <label>总分（0-100）<input type="number" min={0} max={100} value={reviewTotal} onChange={(event) => setReviewTotal(event.target.value)} /></label>
          </div>
          <label className="mail-field">评语
            <textarea rows={3} value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} />
          </label>
          <div className="form-actions">
            <button className="secondary-button" onClick={() => setReviewing(null)}>取消</button>
            <button className="primary-button" onClick={() => void submitReview()}>保存复核</button>
          </div>
        </section>
      ) : null}

      {viewing ? (
        <section className="panel replay-panel">
          <div className="panel-heading">
            <div><h2>{viewing.title}</h2><p>完整对话记录（含语音转写与卡片）</p></div>
            <button className="text-button" onClick={() => setViewing(null)}>关闭</button>
          </div>
          <div className="replay-list">
            {(messages ?? []).map((message) => (
              <div key={message.id} className={`replay-line ${message.sender}`}>
                <em>{message.sender === "buyer" ? "买家" : message.sender === "student" ? "学生" : "教师"}</em>
                <p>
                  {message.kind === "voice" ? "🎤 " : message.kind === "product" ? "🛍 " : message.kind === "coupon" ? "🎟 " : ""}
                  {message.content}
                  {message.kind === "voice" && (message.payload as { audioUrl?: string })?.audioUrl ? (
                    <button className="text-button" onClick={() => { const url = assetUrl((message.payload as { audioUrl?: string }).audioUrl!); if (url) void new Audio(url).play(); }}>播放</button>
                  ) : null}
                </p>
              </div>
            ))}
            {messages === null ? <p className="muted">加载对话…</p> : null}
          </div>
          <div className="intervene-bar">
            <input
              value={intervention}
              onChange={(event) => setIntervention(event.target.value)}
              placeholder="输入指导内容，直接进入学生会话（如：注意先安抚客户情绪，再说明物流节点）"
              onKeyDown={(event) => { if (event.key === "Enter") void intervene(); }}
            />
            <button className="primary-button compact" onClick={() => void intervene()} disabled={!intervention.trim()}>
              <Send size={14} /> 介入指导
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
