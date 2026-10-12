import { ExternalLink, Package2, Reply, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../components/AppShell";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import { ReviewReply, loadReviewReplies, type StoredReply } from "../../components/ReviewReply";
import {
  ApiError,
  assetUrl,
  fetchStudentReviews,
  type Session,
  type StudentReview,
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

/** 时间范围：null=累计全部 */
const TIME_RANGES: ReadonlyArray<[string, string, number | null]> = [
  ["all", "全部时间", null],
  ["7d", "近 7 天", 7],
  ["30d", "近 30 天", 30],
  ["90d", "近 90 天", 90],
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

export function LiveReviews({
  session,
  onOpenOrder,
}: {
  session: Session;
  onOpenOrder?: (orderId: string) => void;
}) {
  const [records, setRecords] = useState<StudentReview[]>([]);
  const [filter, setFilter] = useState<GradeFilter>("all");
  const [rangeKey, setRangeKey] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, StoredReply>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      loadReviewReplies(session).then(setReplies).catch(() => undefined);
      setRecords(await fetchStudentReviews(session));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。");
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const range = TIME_RANGES.find(([key]) => key === rangeKey) ?? TIME_RANGES[0]!;
  const rangeLabel = range[2] === null ? "累计" : range[1];

  /** 先按时间范围过滤，统计与等级页签均基于该结果 */
  const inRange = useMemo(() => {
    const days = range[2];
    if (days === null) return records;
    const cutoff = Date.now() - days * 86_400_000;
    return records.filter((record) => new Date(record.review.at).getTime() >= cutoff);
  }, [records, range]);

  const stats = useMemo(() => {
    const total = inRange.length;
    const good = inRange.filter((record) => gradeOf(record.review.rating) === "good").length;
    const medium = inRange.filter((record) => gradeOf(record.review.rating) === "medium").length;
    const bad = inRange.filter((record) => gradeOf(record.review.rating) === "bad").length;
    const unreplied = inRange.filter(
      (record) => gradeOf(record.review.rating) !== "good" && !replies[record.orderId],
    ).length;
    const avg = total ? inRange.reduce((sum, record) => sum + record.review.rating, 0) / total : 0;
    return { total, good, medium, bad, avg, unreplied, goodRate: total ? Math.round((good / total) * 100) : 0 };
  }, [inRange, replies]);

  const filtered = filter === "all" ? inRange : inRange.filter((record) => gradeOf(record.review.rating) === filter);

  return (
    <div className="page">
      <PageHeader
        eyebrow="REVIEWS"
        title="评价管理"
        description="集中查看本店铺累计买家评价并回复买家，支持按时间与等级筛选；回复时可使用 AI 辅助。"
      />
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="rv-stats">
        <div className="rv-stat">
          <span>{rangeLabel}评价数</span>
          <strong>{stats.total}</strong>
          <small>平均 {stats.avg ? stats.avg.toFixed(1) : "—"} 星 · 累计 {records.length} 条</small>
        </div>
        <div className="rv-stat">
          <span>{rangeLabel}好评率</span>
          <strong className="good">{stats.total ? `${stats.goodRate}%` : "—"}</strong>
          <small>好评 {stats.good} 条</small>
        </div>
        <div className="rv-stat">
          <span>{rangeLabel}中评</span>
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
          <select
            className="rv-range-select"
            value={rangeKey}
            onChange={(event) => { setRangeKey(event.target.value); setExpandedId(null); }}
            aria-label="按时间筛选评价"
          >
            {TIME_RANGES.map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        {filtered.map((record) => {
          const review = record.review;
          const grade = gradeOf(review.rating);
          const meta = GRADE_META[grade];
          const replied = replies[record.orderId];
          const expanded = expandedId === record.orderId;
          return (
            <article key={record.orderId} className="rv-row">
              <div className="rv-row-main">
                <BuyerAvatar buyer={record.buyer} />
                <div className="rv-row-body">
                  <div className="rv-row-top">
                    <strong>{record.buyer.name}</strong>
                    <small>{record.buyer.nationality}</small>
                    <span className="review-stars">
                      {[1, 2, 3, 4, 5].map((value) => (
                        <Star
                          key={value}
                          size={14}
                          fill={value <= review.rating ? "#f2b01e" : "none"}
                          color={value <= review.rating ? "#f2b01e" : "#c6d2d8"}
                        />
                      ))}
                    </span>
                    <em className={`${meta.pill} rv-grade`}>{meta.label}</em>
                    {review.revised ? (
                      <em className="status-pill rv-grade" title={review.original?.content ?? undefined}>
                        已改评{typeof review.original?.rating === "number" ? ` · 原 ${review.original.rating} 星` : ""}
                      </em>
                    ) : null}
                    {replied ? <em className="status-pill green rv-grade">已回复</em> : null}
                    <small className="rv-time">{fmtDateTime(review.at)}</small>
                  </div>
                  <p className="rv-content">{review.content}</p>
                  {review.revised && review.original?.content ? (
                    <p className="rv-original muted">原评价：{review.original.content}</p>
                  ) : null}
                  {replied ? (
                    <div className="rv-replied">
                      <strong>商家回复</strong><small>{fmtDateTime(replied.at)}</small>
                      <p>{replied.text}</p>
                    </div>
                  ) : null}
                  <div className="rv-product">
                    {record.productImage ? (
                      <img src={assetUrl(record.productImage) ?? undefined} alt={record.productName} />
                    ) : (
                      <span className="rv-product-fallback"><Package2 size={14} /></span>
                    )}
                    <span>{record.productName}</span>
                    <small>订单号 {record.orderNo}</small>
                    {onOpenOrder ? (
                      <button className="text-button" onClick={() => onOpenOrder(record.orderId)}>
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
                        : !replied && grade !== "good"
                          ? "primary-button compact"
                          : "secondary-button compact"
                    }
                    onClick={() => setExpandedId(expanded ? null : record.orderId)}
                  >
                    <Reply size={13} /> {expanded ? "收起" : replied ? "再次回复" : "回复"}
                  </button>
                </div>
              </div>
              {expanded ? (
                <div className="rv-composer">
                  <ReviewReply
                    session={session}
                    orderId={record.orderId}
                    conversationId={record.conversationId}
                    conversationOpen={record.conversationStatus === "active"}
                    onSent={(text) => {
                      setReplies((prev) => ({ ...prev, [record.orderId]: { text, at: new Date().toISOString() } }));
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
            <strong>{inRange.length === 0 ? (records.length === 0 ? "暂无评价" : "该时间范围内暂无评价") : "该等级下暂无评价"}</strong>
            <p>{records.length === 0 ? "买家完成交易或结束服务对话后留下的评价会累计展示在这里。" : "调整时间范围或等级页签查看。"}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
