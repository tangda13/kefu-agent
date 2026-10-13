import { useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Languages } from "lucide-react";
import { fetchConversations, translateText, type Session } from "../api/client";
import { ShellSlotContext } from "../ui";

/** 店铺后台页顶栏右侧的附加内容（小字统计、主按钮），渲染进外壳顶栏的页签槽位末尾 */
export function HeaderExtra({ children }: { children: ReactNode }) {
  const slot = useContext(ShellSlotContext);
  if (!slot) return null;
  return createPortal(<div className="sx-head-extra">{children}</div>, slot);
}

/** 页签上的数字：红色表示待处理 */
export function TabCount({ n, red }: { n: number; red?: boolean }) {
  return <span className={red && n > 0 ? "sx-tab-n is-red" : "sx-tab-n"}>{n}</span>;
}

/** 买家的系统客户标签（粉丝、大订单客户等，由接待会话数据携带）：买家 id → 标签列表；取不到时为空 */
export function useBuyerTags(session: Session): Record<string, string[]> {
  const [tags, setTags] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let alive = true;
    Promise.all([fetchConversations(session, "active"), fetchConversations(session, "closed")])
      .then(([active, closed]) => {
        if (!alive) return;
        const map: Record<string, string[]> = {};
        for (const row of [...closed, ...active]) {
          if (row.customerTags?.length) map[row.buyer.id] = row.customerTags;
        }
        setTags(map);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [session]);
  return tags;
}

/** 10 月 12 日 */
export function fmtMonthDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 10 月 12 日 10:13 */
export function fmtMonthDayTime(iso: string): string {
  const d = new Date(iso);
  return `${fmtMonthDay(iso)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 外文正文下方的中文译文（评价、邮件）：进页面自动翻译，同一段文字只请求一次 */
const zhCache = new Map<string, string>();
export function ZhTranslation({ session, text, className }: { session: Session; text: string; className?: string }) {
  const [zh, setZh] = useState<string | null>(() => zhCache.get(text) ?? null);
  useEffect(() => {
    const cached = zhCache.get(text);
    if (cached) {
      setZh(cached);
      return;
    }
    setZh(null);
    if (!text.trim() || /^[\s\u3000-\u9fff\uff00-\uffef\p{P}\d]+$/u.test(text)) return;
    let alive = true;
    void translateText(session, text)
      .then((value) => {
        zhCache.set(text, value);
        if (alive) setZh(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session, text]);
  if (!zh) return null;
  return (
    <div className={className ? `sx-zh ${className}` : "sx-zh"}>
      <span className="sx-zh-k"><Languages size={13} />中文译文</span>
      {zh}
    </div>
  );
}
