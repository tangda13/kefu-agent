import { ChevronDown, ChevronUp, CircleAlert, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  fetchForbiddenTerms,
  fetchOrderSuggestions,
  fetchReviewReplies,
  migrateLocalOnce,
  saveReviewReplyRecord,
  streamConversationMessage,
  type ReviewReplyRecord,
  type Session,
} from "../api/client";
import { Button } from "../ui";
import "../styles/student-store.css";

/** 已发送的评价回复（云端保存，供列表展示"商家回复"，教师端可查看） */
export type StoredReply = ReviewReplyRecord;

/** 读取各订单最近一次回复；顺带把旧版本存在本机的记录迁到云端 */
export async function loadReviewReplies(session: Session): Promise<Record<string, StoredReply>> {
  await migrateLocalOnce<Record<string, StoredReply>>(`cecs.reviewReplies.${session.user.id}`, async (map) => {
    for (const [orderId, reply] of Object.entries(map)) {
      await saveReviewReplyRecord(session, orderId, reply.text, reply.at).catch((cause) => {
        // 订单已不存在的旧记录直接丢弃
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
      });
    }
  });
  return fetchReviewReplies(session);
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

/** 一版回复：angle 是切入角度，text 是买家语言的回复，zh 是中文对照 */
interface Variant {
  angle: string;
  text: string;
  zh: string;
}

const MAX_LENGTH = 1000;

/**
 * 评价回复区：先点“AI 帮写”拿三版买家语言的回复（带中文对照），
 * 选一版填进下方编辑框再改，也可以直接自己写；发送沿用原有逻辑（发进关联会话并保存回复记录）。
 */
export function ReviewReply({
  session,
  orderId,
  conversationId,
  conversationOpen,
  onSent,
  buyerName,
  initialText = "",
  onCancel,
}: {
  session: Session;
  orderId: string;
  conversationId: string;
  conversationOpen: boolean;
  onSent: (text: string) => void;
  /** 评价流里就地展开时：标题写“回复 xx”，带取消；编辑已发布的回复时传入原文 */
  buyerName?: string;
  initialText?: string;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initialText);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  /** 选中一版后自动收起成一行，可再展开换版本 */
  const [folded, setFolded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [terms, setTerms] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    fetchForbiddenTerms(session).then((list) => { if (alive) setTerms(list); }).catch(() => undefined);
    return () => { alive = false; };
  }, [session]);

  // 实时违规词检测（前端本地扫描）
  const hits = useMemo(() => {
    const lower = draft.toLowerCase();
    return terms.filter((term) => lower.includes(term.toLowerCase()));
  }, [draft, terms]);

  async function assist() {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await fetchOrderSuggestions(session, orderId, "review_reply");
      const list: Variant[] = result.variants?.length
        ? result.variants.slice(0, 3)
        : result.suggestions.slice(0, 3).map((text, index) => ({ angle: `版本 ${index + 1}`, text, zh: "" }));
      setVariants(list);
      setPicked(null);
      setFolded(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  function pick(index: number) {
    setPicked(index);
    setDraft(variants[index]?.text ?? "");
    setFolded(true);
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      if (conversationOpen) {
        // 会话还在：回复同时发进会话，买家会看到并可能改评
        await streamConversationMessage(session, conversationId, text, {
          onDelta: () => undefined,
          onDone: () => undefined,
          onError: (message) => setError(message),
        });
        await saveReviewReplyRecord(session, orderId, text).catch(() => undefined);
      } else {
        // 会话已结束：照真实店铺的做法，作为公开回复显示在评价下面
        await saveReviewReplyRecord(session, orderId, text);
      }
      setDraft("");
      setVariants([]);
      setPicked(null);
      onSent(text);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rr">
      <div className="rr-h">
        <b>{buyerName ? `回复 ${buyerName}` : "回复买家"}</b>
        <span>公开显示在评价下面</span>
        <button type="button" className="rr-ai" disabled={loading} onClick={() => void assist()}>
          <Sparkles size={14} />{loading ? "正在写…" : variants.length ? "重新生成" : "AI 帮写"}
        </button>
      </div>
      {variants.length > 0 ? (
        <button type="button" className="rr-fold" onClick={() => setFolded((value) => !value)} aria-expanded={!folded}>
          AI 草稿 {variants.length} 版{picked !== null ? ` · 已填入「${variants[picked]?.angle}」` : ""}
          <span>{folded ? <><ChevronDown size={13} />展开</> : <><ChevronUp size={13} />收起</>}</span>
        </button>
      ) : null}
      {variants.length > 0 && !folded ? (
        <div className="rr-vers" role="radiogroup" aria-label="三版参考回复">
          {variants.map((variant, index) => (
            <button
              key={`${index}-${variant.angle}`}
              type="button"
              role="radio"
              aria-checked={picked === index}
              className={picked === index ? "rr-ver is-on" : "rr-ver"}
              onClick={() => pick(index)}
            >
              <span className="rb" />
              <span className="k">{variant.angle}</span>
              <span className="tx">
                <span className="en">{variant.text}</span>
                {variant.zh ? <span className="zh">{variant.zh}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="rr-box">
      <textarea
        className="rr-input"
        value={draft}
        maxLength={MAX_LENGTH}
        onChange={(event) => { setDraft(event.target.value); setPicked(null); }}
        placeholder="用买家的语言回复，也可以点“AI 帮写”选一版再改"
        aria-label="回复内容"
      />
      <div className="rr-ft">
        {hits.length === 0 ? (
          <span className="sx-ok-line"><ShieldCheck size={14} />没有违规用语</span>
        ) : (
          <span className="sx-bad-line"><ShieldAlert size={14} />含违规用语：{hits.join("、")}</span>
        )}
        <span className="num">{draft.length} / {MAX_LENGTH}</span>
        {error ? <span className="sx-bad-line"><CircleAlert size={13} />{error}</span> : null}
        <span className="r">
          {onCancel ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
          ) : draft ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft(""); setPicked(null); }}>清空</Button>
          ) : null}
          <Button variant="primary" size="sm" loading={busy} disabled={!draft.trim()} onClick={() => void send()}>发布回复</Button>
        </span>
      </div>
      </div>
    </div>
  );
}
