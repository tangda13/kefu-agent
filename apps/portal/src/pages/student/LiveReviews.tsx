import { ExternalLink, Package2, Reply, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../components/AppShell";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import { ReviewReply, loadReviewReplies, saveReviewReply, type StoredReply } from "../../components/ReviewReply";
import {
  ApiError,
  assetUrl,
  fetchStudentOrders,
  type Session,
  type StudentOrder,
} from "../../api/client";

type Grade = "good" | "medium" | "bad";
type GradeFilter = "all" | Grade;

const GRADE_META: Record<Grade, { label: string; pill: string }> = {
  good: { label: "好评", pill: "status-pill green" },
  medium: { label: "中评", pill: "status-pill amber" },
  bad: { label: "差评", pill: "status-pill warn-pill" },
};

const FILTERS: ReadonlyArray<[GradeFilter, string]> = [
  ["all", "全部评价"],
  ["good", "好评"],
  ["medium", "中评"],
  ["bad", "差评"],
];

/** 淘宝口径：4-5 星好评、3 星中评、1-2 星差评 */
function gradeOf(rating: number): Grade {
  if (rating >= 4) return "good";
  if (rating === 3) return "medium";
  return "bad";
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface ReviewEntry {
  order: StudentOrder;
  rating: number;
  content: string;
  at: string;
  grade: Grade;
}

export function LiveReviews({
  session,
  onOpenOrder,
}: {
  session: Session;
  onOpenOrder?: (orderId: string) => void;
}) {
  const [orders, setOrders] = useState<StudentOrder[]>([]);
  const [filter, setFilter] = useState<GradeFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, StoredReply>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setReplies(loadReviewReplies(session.user.id));
      setOrders(await fetchStudentOrders(session));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const reviews = useMemo<ReviewEntry[]>(() => {
    return orders
      .filter((order) => order.detail.review)
      .map((order) => ({
        order,
        rating: order.detail.review!.rating,
        content: order.detail.review!.content,
        at: order.detail.review!.at,
        grade: gradeOf(order.detail.review!.rating),
      }))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [orders]);

  const stats = useMemo(() => {
    const total = reviews.length;
    const good = reviews.filter((entry) => entry.grade === "good").length;
    const medium = reviews.filter((entry) => entry.grade === "medium").length;
    const bad = reviews.filter((entry) => entry.grade === "bad").length;
    const unreplied = reviews.filter((entry) => entry.grade !== "good" && !replies[entry.order.id]).length;
    const avg = total ? reviews.reduce((sum, entry) => sum + entry.rating, 0) / total : 0;
    return { total, good, medium, bad, avg, unreplied, goodRate: total ? Math.round((good / total) * 100) : 0 };
  }, [reviews, replies]);

  const filtered = filter === "all" ? reviews : reviews.filter((entry) => entry.grade === filter);

  return (
    <div className="page">
      <PageHeader
        eyebrow="REVIEWS"
        title="评价管理"
        description="集中查看本店铺全部买家评价并回复买家，回复时可使用 AI 辅助生成参考话术。"
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="rv-stats">
        <div className="rv-stat">
          <span>评价总数</span>
          <strong>{stats.total}</strong>
          <small>平均 {stats.avg ? stats.avg.toFixed(1) : "—"} 星</small>
        </div>
        <div className="rv-stat">
          <span>好评率</span>
          <strong className="good">{stats.total ? `${stats.goodRate}%` : "—"}</strong>
          <small>好评 {stats.good} 条</small>
        </div>
        <div className="rv-stat">
          <span>中评</span>
          <strong className="medium">{stats.medium}</strong>
          <small>3 星评价</small>
        </div>
        <div className="rv-stat">
          <span>待回复中差评</span>
          <strong className="bad">{stats.unreplied}</strong>
          <small>差评共 {stats.bad} 条，建议优先回复</small>
        </div>
      </div>

      <section className="panel rv-panel">
        <div className="od-status-tabs" role="tablist" aria-label="按评价等级筛选">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? "od-status-tab active" : "od-status-tab"}
              onClick={() => { setFilter(value); setExpandedId(null); }}
            >
              {label}
              {value === "all" ? (stats.total ? <span>{stats.total}</span> : null) : null}
              {value === "good" ? (stats.good ? <span>{stats.good}</span> : null) : null}
              {value === "medium" ? (stats.medium ? <span>{stats.medium}</span> : null) : null}
              {value === "bad" ? (stats.bad ? <span>{stats.bad}</span> : null) : null}
            </button>
          ))}
        </div>

        {filtered.map((entry) => {
          const info = entry.order.detail;
          const meta = GRADE_META[entry.grade];
          const replied = replies[entry.order.id];
          const expanded = expandedId === entry.order.id;
          return (
            <article key={entry.order.id} className="rv-row">
              <div className="rv-row-main">
                <BuyerAvatar buyer={entry.order.buyer} />
                <div className="rv-row-body">
                  <div className="rv-row-top">
                    <strong>{entry.order.buyer.name}</strong>
                    <small>{entry.order.buyer.nationality}</small>
                    <span className="review-stars">
                      {[1, 2, 3, 4, 5].map((value) => (
                        <Star
                          key={value}
                          size={14}
                          fill={value <= entry.rating ? "#f2b01e" : "none"}
                          color={value <= entry.rating ? "#f2b01e" : "#c6d2d8"}
                        />
                      ))}
                    </span>
                    <em className={`${meta.pill} rv-grade`}>{meta.label}</em>
                    {replied ? <em className="status-pill green rv-grade">已回复</em> : null}
                    <small className="rv-time">{fmtDateTime(entry.at)}</small>
                  </div>
                  <p className="rv-content">{entry.content}</p>
                  {replied ? (
                    <div className="rv-replied">
                      <strong>商家回复</strong><small>{fmtDateTime(replied.at)}</small>
                      <p>{replied.text}</p>
                    </div>
                  ) : null}
                  <div className="rv-product">
                    {info.productImage ? (
                      <img src={assetUrl(info.productImage) ?? undefined} alt={info.productName} />
                    ) : (
                      <span className="rv-product-fallback"><Package2 size={14} /></span>
                    )}
                    <span>{info.productName}</span>
                    <small>订单号 {info.orderNo}</small>
                    {onOpenOrder ? (
                      <button className="text-button" onClick={() => onOpenOrder(entry.order.id)}>
                        <ExternalLink size={12} /> 查看订单
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="rv-row-ops">
                  <button
                    className={
                      expanded
                        ? "secondary-button compact"
                        : !replied && entry.grade !== "good"
                          ? "primary-button compact"
                          : "secondary-button compact"
                    }
                    onClick={() => setExpandedId(expanded ? null : entry.order.id)}
                  >
                    <Reply size={13} /> {expanded ? "收起" : replied ? "再次回复" : "回复"}
                  </button>
                </div>
              </div>
              {expanded ? (
                <div className="rv-composer">
                  <ReviewReply
                    session={session}
                    orderId={entry.order.id}
                    conversationId={entry.order.conversationId}
                    conversationOpen={entry.order.conversationStatus === "active"}
                    onSent={(text) => {
                      setReplies(saveReviewReply(session.user.id, entry.order.id, text));
                      setExpandedId(null);
                      setNotice("回复已发送给买家，可到客服工作台查看买家回应。");
                    }}
                  />
                </div>
              ) : null}
            </article>
          );
        })}

        {filtered.length === 0 ? (
          <div className="order-empty">
            <Star size={26} />
            <strong>{reviews.length === 0 ? "暂无评价" : "该等级下暂无评价"}</strong>
            <p>{reviews.length === 0 ? "买家完成交易后留下的评价会集中展示在这里。" : "切换其他等级页签查看。"}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
