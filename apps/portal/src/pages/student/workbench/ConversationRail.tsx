import { Clock3, Search, Users } from "lucide-react";
import { useMemo } from "react";
import { type ConversationSummary } from "../../../api/client";
import { Segmented } from "../../../ui";
import { Av, CustomerTagChip, clockLabel, listTimeLabel, useNow } from "./shared";

/* 会话列表（C3）：搜索 + 接待中 / 最近联系；接待中按“等你回复 → 已回复”分组 */

export type RailTab = "current" | "recent";

interface Props {
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  search: string;
  onSearch: (value: string) => void;
  /** 接待中（已过滤掉本地已结束的） */
  active: ConversationSummary[];
  /** 本次刚结束、还留在列表里的会话 */
  justEnded: ConversationSummary[];
  /** 最近联系（已结束） */
  recent: ConversationSummary[];
  activeId: string | null;
  /** 买家正在输入的会话 */
  typingId: string | null;
  onPick: (id: string) => void;
  /** 列表底部的排队信息（按进线节奏），没有就不显示 */
  queueInfo: { text: string; avatars?: number } | null;
}

function matches(item: ConversationSummary, query: string): boolean {
  if (!query) return true;
  return item.buyer.name.toLowerCase().includes(query) || (item.lastMessage?.content ?? "").toLowerCase().includes(query);
}

export function ConversationRail({ tab, onTab, search, onSearch, active, justEnded, recent, activeId, typingId, onPick, queueInfo }: Props) {
  const now = useNow(1000);
  const query = search.trim().toLowerCase();

  const { waiting, replied } = useMemo(() => {
    const list = active.filter((item) => matches(item, query));
    const waitingList = list
      .filter((item) => item.unreplied)
      .sort((a, b) => new Date(a.lastMessage?.createdAt ?? a.createdAt).getTime() - new Date(b.lastMessage?.createdAt ?? b.createdAt).getTime());
    const repliedList = list
      .filter((item) => !item.unreplied)
      .sort((a, b) => new Date(b.lastMessage?.createdAt ?? b.createdAt).getTime() - new Date(a.lastMessage?.createdAt ?? a.createdAt).getTime());
    return { waiting: waitingList, replied: repliedList };
  }, [active, query]);
  const ended = justEnded.filter((item) => matches(item, query));
  const recentList = recent.filter((item) => matches(item, query));

  const renderItem = (item: ConversationSummary, kind: "waiting" | "replied" | "ended" | "recent") => {
    const typing = typingId === item.id;
    const lastAt = item.lastMessage?.createdAt ?? item.createdAt;
    const waitedSeconds = Math.max(0, Math.floor((now - new Date(lastAt).getTime()) / 1000));
    const wTone = waitedSeconds > 60 ? "is-red" : waitedSeconds > 30 ? "is-orange" : "";
    return (
      <button key={item.id} type="button" className={item.id === activeId ? "wbk-qi is-on" : "wbk-qi"} onClick={() => onPick(item.id)}>
        <Av buyer={item.buyer} size={40} />
        <span className="wbk-qi-main">
          <span className="wbk-qi-l1">
            <b>{item.buyer.name}</b>
            {kind === "waiting" ? (
              <span className={`wbk-wait ${wTone}`} title="买家这条消息已经等了多久"><Clock3 size={12} />{clockLabel(waitedSeconds)}</span>
            ) : (
              <span className="wbk-wait is-gray">{listTimeLabel(lastAt)}</span>
            )}
          </span>
          <span className={typing ? "wbk-qi-l2 is-typing" : "wbk-qi-l2"}>
            {typing ? "对方正在输入…" : item.lastMessage ? item.lastMessage.content : "买家刚进线…"}
          </span>
          {item.customerTags && item.customerTags.length > 0 ? (
            <span className="wbk-qi-l3">
              {item.customerTags.map((tag) => <CustomerTagChip key={tag} tag={tag} small />)}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <aside className="wbk-ql">
      <div className="wbk-ql-top">
        <label className="wbk-search">
          <Search size={15} />
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索买家或聊天内容" aria-label="搜索会话" />
        </label>
        <Segmented
          className="wbk-seg"
          value={tab}
          onChange={onTab}
          items={[
            { id: "current", label: "接待中", count: active.length },
            { id: "recent", label: "最近联系", count: recent.length },
          ]}
        />
      </div>
      <div className="wbk-ql-list">
        {tab === "current" ? (
          <>
            {waiting.length > 0 ? <p className="wbk-qg is-red">等你回复 · {waiting.length}</p> : null}
            {waiting.map((item) => renderItem(item, "waiting"))}
            {replied.length > 0 ? <p className="wbk-qg">已回复 · {replied.length}</p> : null}
            {replied.map((item) => renderItem(item, "replied"))}
            {ended.length > 0 ? <p className="wbk-qg">刚结束 · {ended.length}</p> : null}
            {ended.map((item) => renderItem(item, "ended"))}
            {waiting.length + replied.length + ended.length === 0 ? (
              <p className="wbk-ql-empty">{query ? "没有找到匹配的会话" : null}</p>
            ) : null}
          </>
        ) : (
          <>
            {recentList.map((item) => renderItem(item, "recent"))}
            {recentList.length === 0 ? <p className="wbk-ql-empty">{query ? "没有找到匹配的会话。" : "还没有接待过买家。"}</p> : null}
          </>
        )}
      </div>
      {tab === "current" && queueInfo ? (
        <div className="wbk-queue"><Users size={15} />{queueInfo.text}</div>
      ) : null}
    </aside>
  );
}
