import { ChevronUp, CircleAlert, RefreshCw, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  ApiError,
  fetchOrderSuggestions,
  streamConversationMessage,
  type Session,
} from "../api/client";

/** 已发送的评价回复（本地留存，供列表展示"商家回复"） */
export interface StoredReply {
  text: string;
  at: string;
}

const storeKey = (userId: string) => `cecs.reviewReplies.${userId}`;

export function loadReviewReplies(userId: string): Record<string, StoredReply> {
  try {
    return JSON.parse(localStorage.getItem(storeKey(userId)) ?? "{}") as Record<string, StoredReply>;
  } catch {
    return {};
  }
}

export function saveReviewReply(userId: string, orderId: string, text: string): Record<string, StoredReply> {
  const next = { ...loadReviewReplies(userId), [orderId]: { text, at: new Date().toISOString() } };
  localStorage.setItem(storeKey(userId), JSON.stringify(next));
  return next;
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

/**
 * 评价回复框：以人工回复为主（textarea 直接编写），
 * 「AI 辅助」按钮按需展开建议面板（实时生成 3 版参考话术，点选填入可再编辑）。
 */
export function ReviewReply({
  session,
  orderId,
  conversationId,
  conversationOpen,
  onSent,
}: {
  session: Session;
  orderId: string;
  conversationId: string;
  conversationOpen: boolean;
  onSent: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<"closed" | "loading" | "open">("closed");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function assist() {
    if (busy) return;
    setBusy(true);
    setError("");
    setPanel("loading");
    try {
      const result = await fetchOrderSuggestions(session, orderId, "review_reply");
      setSuggestions(result.suggestions.slice(0, 3));
      setPanel("open");
    } catch (cause) {
      setError(errorText(cause));
      setPanel("closed");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      await streamConversationMessage(session, conversationId, text, {
        onDelta: () => undefined,
        onDone: () => undefined,
        onError: (message) => setError(message),
      });
      setDraft("");
      setPanel("closed");
      onSent(text);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rv-reply">
      {panel !== "closed" ? (
        <div className="rv-assist-panel">
          <div className="ai-composer-head">
            <Sparkles size={14} />
            <strong>AI 辅助 · 选择一版填入回复框，可再编辑</strong>
            {panel === "open" ? (
              <>
                <button className="text-button" disabled={busy} onClick={() => void assist()}>
                  <RefreshCw size={13} /> 重新生成
                </button>
                <button className="text-button" onClick={() => setPanel("closed")}>
                  <ChevronUp size={13} /> 收起
                </button>
              </>
            ) : null}
          </div>
          {panel === "loading" ? (
            <p className="muted rv-assist-loading">AI 正在结合评价内容与买家资料生成 3 版参考回复…</p>
          ) : (
            <div className="suggestion-list">
              {suggestions.map((text, index) => (
                <button
                  key={index}
                  className={draft === text ? "suggestion-card active" : "suggestion-card"}
                  onClick={() => setDraft(text)}
                >
                  <em>版本 {index + 1}</em>
                  <p>{text}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
      <textarea
        className="suggestion-editor"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="以英文回复买家评价；也可点「AI 辅助」生成参考话术后再编辑…"
      />
      <div className="rv-reply-actions">
        <button className="secondary-button compact" disabled={busy} onClick={() => void assist()}>
          <Sparkles size={13} /> AI 辅助
        </button>
        <button
          className="primary-button compact"
          disabled={busy || !draft.trim() || !conversationOpen}
          onClick={() => void send()}
        >
          <Send size={13} /> 回复买家
        </button>
        {!conversationOpen ? <span className="muted"><CircleAlert size={13} /> 关联会话已结束，无法发送</span> : null}
        {error ? <span className="composer-error"><CircleAlert size={13} /> {error}</span> : null}
      </div>
    </div>
  );
}
