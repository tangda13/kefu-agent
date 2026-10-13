import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ConversationSummary, type StoreProfile } from "../../../api/client";
import { Av, CustomerTagChip, shortDate, timeLabel } from "./shared";

/* 右栏顶部客户资料：头像 + 名字 + 国家·身份·语言；系统标签（只读）；关键数字；客户备注（可编辑） */

function noteStamp(iso: string | null | undefined): string {
  if (!iso) return "你";
  const at = new Date(iso);
  const minutes = (Date.now() - at.getTime()) / 60_000;
  if (minutes < 1) return "你 · 刚刚";
  if (at.toDateString() === new Date().toDateString()) return `你 · ${timeLabel(iso)}`;
  return `你 · ${shortDate(iso)}`;
}

export function CustomerCard({ conversation, tiers, onSaveNote }: {
  conversation: ConversationSummary;
  tiers: StoreProfile["tiers"] | null;
  onSaveNote: (note: string) => Promise<void>;
}) {
  const { buyer } = conversation;
  const stats = conversation.orderStats;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const skipBlur = useRef(false);

  // 换会话时放弃没写完的草稿
  useEffect(() => {
    setEditing(false);
  }, [conversation.id]);

  const start = () => {
    skipBlur.current = false;
    setDraft(conversation.buyerNote ?? "");
    setEditing(true);
  };
  const commit = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    setEditing(false);
    const next = draft.trim();
    if (next !== (conversation.buyerNote ?? "").trim()) void onSaveNote(next);
  };


  return (
    <div className="wbk-cust">
      <div className="wbk-who">
        <Av buyer={buyer} size={40} />
        <div style={{ minWidth: 0 }}>
          <b>{buyer.name}</b>
          {/* 只放客户基本信息：客户标签 + 国家（画像身份、语言代码属于训练设定，不显示） */}
          <div className="wbk-systags">
            {(conversation.customerTags ?? []).map((tag) => <CustomerTagChip key={tag} tag={tag} />)}
            <small>{buyer.nationality}</small>
          </div>
        </div>
      </div>
      <dl className="wbk-kv">
        <dt>历史订单</dt>
        <dd>{stats ? (stats.count > 0 ? <><span className="num">{stats.count}</span> 笔 · USD <span className="num">{stats.total.toFixed(2)}</span></> : "暂无成交") : "—"}</dd>
        <dt>最近下单</dt>
        <dd>{stats?.lastPlacedAt ? shortDate(stats.lastPlacedAt) : "—"}</dd>
        <dt>72 小时咨询</dt>
        <dd><span className="num">{conversation.visits72h ?? 0}</span> 次</dd>
      </dl>
      <div className={editing ? "wbk-note is-editing" : "wbk-note"}>
        <div className="wbk-note-t">客户备注{!editing ? <button type="button" aria-label="编辑客户备注" onClick={start}><Pencil size={13} /></button> : null}</div>
        {editing ? (
          <textarea
            autoFocus
            rows={3}
            maxLength={500}
            value={draft}
            aria-label="客户备注"
            placeholder="记下这位客户的情况，下次接待能看到"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                (event.target as HTMLTextAreaElement).blur();
              }
              if (event.key === "Escape") {
                skipBlur.current = true;
                setEditing(false);
              }
            }}
          />
        ) : (
          <button type="button" className="wbk-note-body" onClick={start}>
            {conversation.buyerNote ? <p>{conversation.buyerNote}</p> : <p className="is-empty">添加备注</p>}
          </button>
        )}
        {conversation.buyerNote && !editing ? <small>{noteStamp(conversation.buyerNoteAt)}</small> : null}
      </div>
    </div>
  );
}
