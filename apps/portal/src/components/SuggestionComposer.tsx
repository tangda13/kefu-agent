import type { LucideIcon } from "lucide-react";
import { CircleAlert, RefreshCw, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  ApiError,
  fetchOrderSuggestions,
  streamConversationMessage,
  type Session,
} from "../api/client";

export type SuggestionType = "payment_reminder" | "logistics_update" | "review_reply";

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

/**
 * AI 话术工作区：主动发起 → 实时生成 3 版话术 → 选择 → 二次编辑 → 发送给买家。
 * 订单详情（催付）、物流（同步安抚）、评价（差评挽回）三处共用。
 */
export function SuggestionComposer({
  session,
  orderId,
  conversationId,
  conversationOpen,
  type,
  icon: ActionIcon,
  title,
  hint,
  buttonLabel,
  onSent,
}: {
  session: Session;
  orderId: string;
  conversationId: string;
  conversationOpen: boolean;
  type: SuggestionType;
  icon: LucideIcon;
  title: string;
  hint: string;
  buttonLabel: string;
  onSent?: () => void;
}) {
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready">("idle");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError("");
    setPhase("loading");
    setSuggestions(null);
    setDraft("");
    try {
      const result = await fetchOrderSuggestions(session, orderId, type);
      setSuggestions(result.suggestions.slice(0, 3));
      setPhase("ready");
    } catch (cause) {
      setError(errorText(cause));
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await streamConversationMessage(session, conversationId, draft.trim(), {
        onDelta: () => undefined,
        onDone: () => undefined,
        onError: (message) => setError(message),
      });
      setPhase("idle");
      setSuggestions(null);
      setDraft("");
      onSent?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (phase === "idle") {
    return (
      <div className="ai-action-bar">
        <span className="ai-action-icon"><ActionIcon size={16} /></span>
        <p><strong>{title}</strong>{hint}</p>
        {error ? <span className="composer-error"><CircleAlert size={13} /> {error}</span> : null}
        <button className="primary-button compact" disabled={busy} onClick={() => void generate()}>
          <Sparkles size={13} /> {buttonLabel}
        </button>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="ai-action-bar generating">
        <span className="ai-action-icon"><Sparkles size={16} /></span>
        <p>AI 正在结合订单状态与买家资料生成 3 版话术…</p>
      </div>
    );
  }

  return (
    <div className="ai-composer">
      <div className="ai-composer-head">
        <Sparkles size={15} />
        <strong>{title} · 选择一个版本，可二次编辑后发送</strong>
        <button className="text-button" disabled={busy} onClick={() => void generate()}>
          <RefreshCw size={13} /> 重新生成
        </button>
      </div>
      <div className="suggestion-list">
        {(suggestions ?? []).map((text, index) => (
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
      <textarea
        className="suggestion-editor"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="选择上方任一版本话术，可在此二次编辑后发送…"
      />
      <div className="form-actions">
        <button
          className="primary-button compact"
          disabled={busy || !draft.trim() || !conversationOpen}
          onClick={() => void send()}
        >
          <Send size={14} /> 发送给买家
        </button>
        {!conversationOpen ? <span className="muted"><CircleAlert size={13} /> 关联会话已结束，无法发送</span> : null}
        {error ? <span className="composer-error"><CircleAlert size={13} /> {error}</span> : null}
      </div>
    </div>
  );
}
