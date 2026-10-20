import { Languages, PackageSearch, Package2, Reply, Search, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import { ReviewReply, loadReviewReplies, type StoredReply } from "../../components/ReviewReply";
import { TabCount, fmtMonthDay, ZhTranslation } from "../../components/StoreHeader";
import {
  ApiError,
  assetUrl,
  fetchStoreProfile,
  fetchStudentOrders,
  fetchStudentReviews,
  type Session,
  type StoreProfile,
  type StudentOrder,
  type StudentReview,
} from "../../api/client";
import { HeaderTabs, MoreMenu } from "../../ui";
import "../../styles/student-store.css";

type Grade = "good" | "medium" | "bad";
type Tab = "all" | Grade;
/** 回复状态：普通筛选项，不当成待办（电商平台没有“必须回复评价”的逻辑） */
type ReplyFilter = "all" | "unreplied" | "replied";
type Sort = "latest" | "lowest" | "highest";

/** 时间范围：null=累计全部 */
const TIME_RANGES: ReadonlyArray<[string, string, number | null]> = [
  ["all", "全部时间", null],
  ["7d", "近 7 天", 7],
  ["30d", "近 30 天", 30],
  ["90d", "近 90 天", 90],
];

/** 4-5 星好评、3 星中评、1-2 星差评 */
function gradeOf(rating: number): Grade {
  if (rating >= 4) return "good";
  if (rating === 3) return "medium";
  return "bad";
}

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <span className="sx-stars" aria-label={`${rating} 星`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          size={size}
          fill={value <= Math.round(rating) ? "#f2b01e" : "none"}
          color={value <= Math.round(rating) ? "#f2b01e" : "#c6d2d8"}
        />
      ))}
    </span>
  );
}

/**
 * 评价（第二版，对比稿 p12-student“评价 · 第二版”）：照亚马逊商品页的评价区做成评价流。
 * 左侧评分概览（平均分、5→1 星占比，点一行筛这一星），右侧每条评价完整展开，
 * 商家回复缩进显示在评价下面，“回复”就地展开回复框。
 */
export function LiveReviews({
  session,
  onOpenOrder,
  onOpenConversation,
}: {
  session: Session;
  onOpenOrder?: (orderId: string) => void;
  /** 联系买家：跳到客服工作台的这位买家会话 */
  onOpenConversation?: (conversationId: string) => void;
}) {
  const [records, setRecords] = useState<StudentReview[]>([]);
  const [orders, setOrders] = useState<Record<string, StudentOrder>>({});
  const [store, setStore] = useState<StoreProfile | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [starFilter, setStarFilter] = useState<number | null>(null);
  const [rangeKey, setRangeKey] = useState("all");
  const [sort, setSort] = useState<Sort>("latest");
  const [replyFilter, setReplyFilter] = useState<ReplyFilter>("all");
  const [query, setQuery] = useState("");
  const [replies, setReplies] = useState<Record<string, StoredReply>>({});
  /** 正在回复 / 编辑回复的评价（订单 id） */
  const [composing, setComposing] = useState<{ orderId: string; edit: boolean } | null>(null);
  const [translated, setTranslated] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      loadReviewReplies(session).then(setReplies).catch(() => undefined);
      fetchStoreProfile(session).then(setStore).catch(() => undefined);
      fetchStudentOrders(session)
        .then((list) => setOrders(Object.fromEntries(list.map((item) => [item.id, item]))))
        .catch(() => undefined);
      setRecords(await fetchStudentReviews(session));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const range = TIME_RANGES.find(([key]) => key === rangeKey) ?? TIME_RANGES[0]!;
  const inRange = useMemo(() => {
    const days = range[2];
    if (days === null) return records;
    const cutoff = Date.now() - days * 86_400_000;
    return records.filter((record) => new Date(record.review.at).getTime() >= cutoff);
  }, [records, range]);


  const stats = useMemo(() => {
    const total = inRange.length;
    const count = (grade: Grade) => inRange.filter((record) => gradeOf(record.review.rating) === grade).length;
    const byStar = [5, 4, 3, 2, 1].map((star) => ({
      star,
      n: inRange.filter((record) => record.review.rating === star).length,
    }));
    return {
      total,
      good: count("good"),
      medium: count("medium"),
      bad: count("bad"),
      replied: inRange.filter((record) => replies[record.orderId]).length,
      avg: total ? inRange.reduce((sum, record) => sum + record.review.rating, 0) / total : 0,
      byStar,
    };
  }, [inRange, replies]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = inRange.filter((record) => {
      if (replyFilter === "unreplied" && replies[record.orderId]) return false;
      if (replyFilter === "replied" && !replies[record.orderId]) return false;
      if ((tab === "good" || tab === "medium" || tab === "bad") && gradeOf(record.review.rating) !== tab) return false;
      if (starFilter !== null && record.review.rating !== starFilter) return false;
      if (!keyword) return true;
      return [record.buyer.name, record.productName, record.orderNo, record.review.content]
        .some((field) => field.toLowerCase().includes(keyword));
    });
    const time = (record: StudentReview) => new Date(record.review.at).getTime();
    return [...list].sort((a, b) =>
      sort === "lowest" ? a.review.rating - b.review.rating || time(b) - time(a)
      : sort === "highest" ? b.review.rating - a.review.rating || time(b) - time(a)
      : time(b) - time(a),
    );
  }, [inRange, tab, starFilter, replyFilter, query, sort, replies]);

  const storeName = store?.name ?? "店铺";

  return (
    <div className="sx-root">
      <HeaderTabs
        value={tab}
        onChange={(next) => { setTab(next); setStarFilter(null); }}
        items={[
          { id: "all", label: <>全部<TabCount n={stats.total} /></> },
          { id: "bad", label: <>差评<TabCount n={stats.bad} /></> },
          { id: "medium", label: <>中评<TabCount n={stats.medium} /></> },
          { id: "good", label: <>好评<TabCount n={stats.good} /></> },
        ]}
      />
      {error ? <p className="sx-error" role="alert">{error}</p> : null}

      <div className="rv3">
        <aside className="rv3-sum">
          <h3>买家评价</h3>
          <div className="rv3-avg">
            <Stars rating={stats.avg} size={18} />
            <b className="num">{stats.total ? stats.avg.toFixed(1) : "—"}</b>
            <span>满分 5 星</span>
          </div>
          <div className="rv3-n">共 {stats.total} 条评价</div>
          <div className="rv3-hist">
            {stats.byStar.map(({ star, n }) => {
              const pct = stats.total ? Math.round((n / stats.total) * 100) : 0;
              return (
                <button
                  key={star}
                  type="button"
                  className={starFilter === star ? "is-on" : undefined}
                  disabled={n === 0}
                  onClick={() => { setStarFilter(starFilter === star ? null : star); setTab("all"); }}
                >
                  <span>{star} 星</span>
                  <i><em style={{ width: `${pct}%` }} /></i>
                  <span className="num">{pct}%</span>
                </button>
              );
            })}
          </div>
          <div className="rv3-side-f">
            <span>好评率 <b className="num">{stats.total ? Math.round((stats.good / stats.total) * 100) : 0}%</b></span>
            <span>已回复 <b className="num">{stats.replied}</b> / {stats.total}</span>
          </div>
        </aside>

        <section className="rv3-list">
          <div className="rv3-tool">
            <label className="sx-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索买家、商品或订单号"
                aria-label="搜索评价"
              />
            </label>
            <select className="sx-select" value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="排序">
              <option value="latest">最新</option>
              <option value="lowest">评分最低</option>
              <option value="highest">评分最高</option>
            </select>
            <select className="sx-select" value={replyFilter} onChange={(event) => setReplyFilter(event.target.value as ReplyFilter)} aria-label="回复状态">
              <option value="all">全部回复状态</option>
              <option value="unreplied">未回复</option>
              <option value="replied">已回复</option>
            </select>
            <select className="sx-select" value={rangeKey} onChange={(event) => setRangeKey(event.target.value)} aria-label="按时间筛选评价">
              {TIME_RANGES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            {starFilter !== null ? (
              <button type="button" className="rv3-chip" onClick={() => setStarFilter(null)}>{starFilter} 星 ×</button>
            ) : null}
            <span className="rv3-count">{filtered.length} 条</span>
          </div>

          {filtered.map((record) => renderReview(record))}
          {filtered.length === 0 ? (
            <div className="sx-empty">
              <Star size={26} />
              <strong>{records.length === 0 ? "暂无评价" : "没有符合条件的评价"}</strong>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );

  function renderReview(record: StudentReview) {
    const review = record.review;
    const info = orders[record.orderId]?.detail;
    const replied = replies[record.orderId];
    const open = composing?.orderId === record.orderId;
    const showZh = translated.has(record.orderId);
    const toggleZh = () =>
      setTranslated((prev) => {
        const next = new Set(prev);
        if (next.has(record.orderId)) next.delete(record.orderId);
        else next.add(record.orderId);
        return next;
      });
    const menu = [
      ...(onOpenConversation ? [{ label: "联系买家", onClick: () => onOpenConversation(record.conversationId) }] : []),
      { label: "复制订单号", onClick: () => void navigator.clipboard?.writeText(record.orderNo).catch(() => undefined) },
    ];
    return (
      <article key={record.orderId} className="rv3-item">
        <div className="rv3-who">
          <span className="sx-av"><BuyerAvatar buyer={record.buyer} /></span>
          <b>{record.buyer.name}</b>
        </div>
        <div className="rv3-line">
          <Stars rating={review.rating} />
          <span>{fmtMonthDay(review.at)} · {record.buyer.nationality}</span>
          {review.revised && typeof review.original?.rating === "number" ? (
            <span className="rv3-revised">已改评 {review.original.rating}→{review.rating} 星</span>
          ) : null}
        </div>
        <div className="rv3-prod">
          {record.productImage ? <img src={assetUrl(record.productImage) ?? undefined} alt="" /> : <span className="blank"><Package2 size={12} /></span>}
          <span>{record.productName}</span>
          {info?.productSpec ? <span className="muted">· {info.productSpec} ·</span> : <span className="muted">·</span>}
          <span className="rv3-vp">已购买</span>
        </div>
        <p className="rv3-text">{review.content}</p>
        {showZh ? <ZhTranslation session={session} text={review.content} className="rv3-zh" /> : null}
        {review.revised && review.original?.content ? (
          <p className="rv3-orig">改评前：{review.original.content}</p>
        ) : null}

        {/* 操作紧跟评价正文；商家回复和回复框在操作下面展开 */}
        <div className="rv3-acts">
          {!replied ? (
            <button type="button" className={open ? "is-strong is-on" : "is-strong"} onClick={() => setComposing(open ? null : { orderId: record.orderId, edit: false })}>
              <Reply size={14} />回复
            </button>
          ) : null}
          <button type="button" onClick={toggleZh}><Languages size={14} />{showZh ? "收起译文" : "查看译文"}</button>
          {onOpenOrder ? (
            <button type="button" onClick={() => onOpenOrder(record.orderId)}><PackageSearch size={14} />查看订单</button>
          ) : null}
          <MoreMenu items={menu} />
        </div>
        {replied && !(open && composing?.edit) ? (
          <div className="rv3-reply">
            <div className="h">
              <span className="rv3-smark">{store?.logoUrl ? <img src={store.logoUrl} alt="" /> : storeName.trim()[0]?.toUpperCase()}</span>
              <b>{storeName} 的回复</b>
              <span className="muted">{fmtMonthDay(replied.at)}</span>
              <button type="button" className="rv3-edit" onClick={() => setComposing({ orderId: record.orderId, edit: true })}>编辑</button>
            </div>
            <p>{replied.text}</p>
          </div>
        ) : null}

        {open ? (
          <ReviewReply
            session={session}
            orderId={record.orderId}
            conversationId={record.conversationId}
            conversationOpen={record.conversationStatus === "active" && !composing?.edit}
            buyerName={record.buyer.name}
            buyerLanguage={record.buyer.language}
            initialText={composing?.edit ? replied?.text ?? "" : ""}
            onCancel={() => setComposing(null)}
            onSent={(text) => {
              setReplies((prev) => ({ ...prev, [record.orderId]: { text, at: new Date().toISOString() } }));
              setComposing(null);
            }}
          />
        ) : null}

      </article>
    );
  }
}
