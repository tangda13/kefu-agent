import { ChevronRight, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import {
  ApiError,
  apiGet,
  fetchBaselineStatus,
  fetchConversationMessages,
  type BuyerPublicView,
  type ConversationMessage,
  type Session,
} from "../../api/client";

interface AssessmentRecord {
  id: string;
  conversationId: string;
  scenarioName: string;
  buyer: BuyerPublicView;
  scores: Record<string, number>;
  total: number;
  comment: string;
  suggestions: string[];
  /** 自由练习：保留 AI 反馈供复盘，但不计入平均分/走势/六维聚合 */
  practice?: boolean;
  createdAt: string;
}

interface AssessmentData {
  records: AssessmentRecord[];
  radar: Record<string, number>;
  average: number | null;
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "无法连接服务器，请稍后重试。";
}

/* ---------- 分数档位（状态色 + 文字标签，不单靠颜色传达） ---------- */

function bandOf(score: number): { label: string; cls: string } {
  if (score >= 85) return { label: "优秀", cls: "good" };
  if (score >= 70) return { label: "良好", cls: "fine" };
  if (score >= 60) return { label: "合格", cls: "warn" };
  return { label: "待提升", cls: "risk" };
}

/* ---------- 六维改进建议（≥75 巩固建议，<75 改进建议） ---------- */

const DIMENSION_ADVICE: Record<string, { strong: string; weak: string }> = {
  compliance: {
    weak: "避免 best、guarantee、100% 等绝对化承诺，涉及退款与物流时效时按平台规则表述，发送前留意合规提示。",
    strong: "合规表现稳定，继续保持规范表述，促销与质保话术中依旧避免绝对化承诺。",
  },
  grammar: {
    weak: "语法与拼写错误会削弱专业感：多用短句、发送前通读一遍，注意时态一致；没把握的表达优先使用快捷短语。",
    strong: "语法基础扎实，可尝试更丰富的句式与更地道的表达，让回复更自然。",
  },
  professionalism: {
    weak: "按「问候 → 确认问题 → 给出方案 → 约定下一步」组织回复，多参考快捷短语库的标准话术，保持礼貌称呼与统一语气。",
    strong: "话术专业规范，可在标准结构上加入个性化细节，让服务更有温度。",
  },
  effectiveness: {
    weak: "先直接回应客户核心问题再补充说明，每条消息聚焦一个要点，减少客户往返追问。",
    strong: "沟通高效清晰，继续保持「先结论、后细节」的表达习惯。",
  },
  empathy: {
    weak: "面对不满先共情再解释：用 I completely understand / I'm so sorry 开场，确认感受后再给方案，避免直接反驳。",
    strong: "情绪安抚到位，保持对情绪信号的敏感，在客户不满升级前主动安抚。",
  },
  resolution: {
    weak: "给出可执行的方案（补发 / 退款 / 折扣）并明确时限与步骤，主动跟进直至客户确认，避免只解释不解决。",
    strong: "问题解决能力强，可在方案中提供多个选项，让客户更有选择感。",
  },
};

/* ---------- 综合分环形仪表（Hero 区） ---------- */

const RING = { size: 158, stroke: 9 };

function ScoreRing({ value }: { value: number | null }) {
  const r = (RING.size - RING.stroke) / 2 - 2;
  const c = 2 * Math.PI * r;
  const pct = value != null ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="rec-ring" role="img" aria-label={value != null ? `综合平均分 ${value}` : "暂无综合评分"}>
      <svg width={RING.size} height={RING.size} viewBox={`0 0 ${RING.size} ${RING.size}`} aria-hidden="true">
        <defs>
          <linearGradient id="recRingGrad" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0a84ff" />
            <stop offset="100%" stopColor="#64d2ff" />
          </linearGradient>
        </defs>
        <circle cx={RING.size / 2} cy={RING.size / 2} r={r} className="rec-ring-track" strokeWidth={RING.stroke} />
        <circle
          cx={RING.size / 2}
          cy={RING.size / 2}
          r={r}
          className="rec-ring-meter"
          stroke="url(#recRingGrad)"
          strokeWidth={RING.stroke}
          strokeLinecap="round"
          strokeDasharray={`${(c * pct) / 100} ${c}`}
          transform={`rotate(-90 ${RING.size / 2} ${RING.size / 2})`}
        />
      </svg>
      <div className="rec-ring-center">
        <strong>{value ?? "—"}</strong>
        <span>{value != null ? "综合平均分" : "暂无评分"}</span>
      </div>
    </div>
  );
}

/* ---------- 能力雷达图（SVG，六维，平均 vs 单次对比） ---------- */

const RADAR = { w: 560, h: 480, cx: 280, cy: 240, r: 168 };

function radarPoint(index: number, count: number, value: number) {
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  const radius = (RADAR.r * Math.max(0, Math.min(100, value))) / 100;
  return { x: RADAR.cx + radius * Math.cos(angle), y: RADAR.cy + radius * Math.sin(angle) };
}

function RadarChart({ average, averageName, selected, selectedName, compact, gradientId }: {
  average: Record<string, number>;
  averageName?: string;
  selected?: Record<string, number> | null;
  selectedName?: string;
  compact?: boolean;
  gradientId: string;
}) {
  const dims = ASSESSMENT_DIMENSIONS;
  const count = dims.length;
  const polygon = (scores: Record<string, number>) =>
    dims.map((dim, i) => { const p = radarPoint(i, count, scores[dim.id] ?? 0); return `${p.x},${p.y}`; }).join(" ");
  return (
    <div className={compact ? "rec-radar compact" : "rec-radar"}>
      <svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} role="img" aria-label="六维能力雷达图">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(0, 102, 204, 0.24)" />
            <stop offset="100%" stopColor="rgba(0, 102, 204, 0.04)" />
          </linearGradient>
        </defs>
        {[20, 40, 60, 80, 100].map((value) => (
          <circle
            key={value}
            cx={RADAR.cx}
            cy={RADAR.cy}
            r={(RADAR.r * value) / 100}
            className={value === 100 ? "rec-radar-ring outer" : "rec-radar-ring"}
          />
        ))}
        {dims.map((dim, i) => {
          const tip = radarPoint(i, count, 100);
          return <line key={dim.id} x1={RADAR.cx} y1={RADAR.cy} x2={tip.x} y2={tip.y} className="rec-radar-axis" />;
        })}
        <polygon points={polygon(average)} className="rec-radar-shape avg" fill={`url(#${gradientId})`} />
        {selected ? <polygon points={polygon(selected)} className="rec-radar-shape sel" /> : null}
        {dims.map((dim, i) => {
          const p = radarPoint(i, count, average[dim.id] ?? 0);
          return <circle key={dim.id} cx={p.x} cy={p.y} r={3.2} className="rec-radar-dot avg" />;
        })}
        {selected
          ? dims.map((dim, i) => {
              const p = radarPoint(i, count, selected[dim.id] ?? 0);
              return <circle key={dim.id} cx={p.x} cy={p.y} r={3.2} className="rec-radar-dot sel" />;
            })
          : null}
        {dims.map((dim, i) => {
          const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
          const lx = RADAR.cx + (RADAR.r + 18) * Math.cos(angle);
          const ly = RADAR.cy + (RADAR.r + 18) * Math.sin(angle);
          const dx = Math.cos(angle);
          const anchor = Math.abs(dx) < 0.3 ? "middle" : dx > 0 ? "start" : "end";
          const dy = Math.sin(angle) > 0.3 ? 10 : Math.sin(angle) < -0.3 ? -2 : 4;
          return (
            <text key={dim.id} x={lx} y={ly + dy} textAnchor={anchor} className="rec-radar-label">
              {dim.label} <tspan className="rec-radar-value">{average[dim.id] ?? "—"}</tspan>
            </text>
          );
        })}
      </svg>
      {selected ? (
        <div className="rec-legend">
          <span><i className="rec-dot avg" /> {averageName ?? "全部会话平均"}</span>
          <span><i className="rec-dot sel" /> {selectedName ?? "本次会话"}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- 成绩趋势图（平滑曲线 + 渐变面积 + 悬停提示，点击圆点打开复盘） ---------- */

const TREND = { w: 1120, h: 230, left: 48, right: 20, top: 18, bottom: 36, inset: 18 };

type Pt = { x: number; y: number };

/* Catmull-Rom 转三次贝塞尔，控制点钳制在绘图区内避免过冲 */
function curvePath(pts: Pt[], yMin: number, yMax: number): string {
  if (pts.length < 2) return "";
  const clampY = (v: number) => Math.max(yMin, Math.min(yMax, v));
  const d = [`M ${pts[0]!.x},${pts[0]!.y}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    d.push(`C ${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`);
  }
  return d.join(" ");
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function TrendChart({ chrono, activeId, onPick }: {
  chrono: AssessmentRecord[];
  activeId: string | null;
  onPick: (record: AssessmentRecord) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const plotW = TREND.w - TREND.left - TREND.right - TREND.inset * 2;
  const plotH = TREND.h - TREND.top - TREND.bottom;
  const x = (i: number) => (chrono.length <= 1 ? TREND.left + TREND.inset + plotW / 2 : TREND.left + TREND.inset + (plotW * i) / (chrono.length - 1));
  const y = (value: number) => TREND.top + plotH * (1 - Math.max(0, Math.min(100, value)) / 100);
  const baseY = TREND.top + plotH;
  const pts = chrono.map((record, i) => ({ x: x(i), y: y(record.total) }));
  const lineD = curvePath(pts, TREND.top, baseY);
  const areaD = lineD ? `${lineD} L ${pts[pts.length - 1]!.x},${baseY} L ${pts[0]!.x},${baseY} Z` : "";
  const xLabelIndexes = chrono.length <= 4
    ? chrono.map((_, i) => i)
    : [...new Set([0, 0.25, 0.5, 0.75, 1].map((t) => Math.round((chrono.length - 1) * t)))];
  const hovered = hover !== null ? chrono[hover] : null;
  return (
    <div className="rec-trend">
      <div className="rec-trend-stage">
        <svg viewBox={`0 0 ${TREND.w} ${TREND.h}`} role="img" aria-label="历史总分趋势图" onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="recTrendFill" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(0, 102, 204, 0.16)" />
              <stop offset="100%" stopColor="rgba(0, 102, 204, 0)" />
            </linearGradient>
          </defs>
          {[0, 20, 40, 60, 100].map((value) => (
            <g key={value}>
              <line x1={TREND.left} y1={y(value)} x2={TREND.w - TREND.right} y2={y(value)} className="rec-grid-line" />
              <text x={TREND.left - 8} y={y(value) + 3.5} textAnchor="end" className="rec-axis-text">{value}</text>
            </g>
          ))}
          <line x1={TREND.left} y1={y(80)} x2={TREND.w - TREND.right} y2={y(80)} className="rec-grid-line pass" />
          <text x={TREND.left - 8} y={y(80) + 3.5} textAnchor="end" className="rec-axis-text halo">达标 80</text>
          {areaD ? <path d={areaD} fill="url(#recTrendFill)" /> : null}
          {lineD ? <path d={lineD} className="rec-trend-line" /> : null}
          {hover !== null ? <line x1={x(hover)} y1={TREND.top} x2={x(hover)} y2={baseY} className="rec-guide" /> : null}
          {chrono.map((record, i) => (
            <g key={record.id}>
              <circle
                cx={x(i)}
                cy={y(record.total)}
                r={13}
                className="rec-trend-hit"
                onMouseEnter={() => setHover(i)}
                onClick={() => onPick(record)}
              />
              <circle cx={x(i)} cy={y(record.total)} r={hover === i ? 5 : 3.8} className={record.id === activeId ? "rec-trend-dot active" : "rec-trend-dot"} />
            </g>
          ))}
          {xLabelIndexes.map((i) => (
            <text
              key={chrono[i]!.id}
              x={x(i)}
              y={TREND.h - 10}
              textAnchor="middle"
              className="rec-axis-text"
            >
              {dateLabel(chrono[i]!.createdAt)} {timeOf(chrono[i]!.createdAt)}
            </text>
          ))}
        </svg>
        {hovered ? (() => {
          const leftPct = (x(hover!) / TREND.w) * 100;
          const topPct = (y(hovered.total) / TREND.h) * 100;
          const edge = leftPct > 78 ? " edge-right" : leftPct < 16 ? " edge-left" : "";
          const below = topPct < 28 ? " below" : "";
          return (
            <div className={`rec-tip${edge}${below}`} style={{ left: `${leftPct}%`, top: `${topPct}%` }}>
              <strong>{hovered.total} 分</strong>
              <span>{hovered.scenarioName} · {dateLabel(hovered.createdAt)} {timeOf(hovered.createdAt)}</span>
            </div>
          );
        })() : null}
      </div>
      <p className="rec-trend-hint">按时间先后排列 · 点击圆点打开该次复盘</p>
    </div>
  );
}

/* ---------- 维度迷你趋势线 ---------- */

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 76;
  const H = 26;
  const P = 3;
  const min = Math.min(...values);
  const span = (Math.max(...values) - min) || 1;
  const points = values.map((value, i) =>
    `${P + ((W - 2 * P) * i) / (values.length - 1)},${H - P - ((H - 2 * P) * (value - min)) / span}`,
  );
  const [lx, ly] = points[points.length - 1]!.split(",").map(Number);
  return (
    <svg className="rec-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={points.join(" ")} />
      <circle cx={lx} cy={ly} r={2.2} />
    </svg>
  );
}

/* ---------- 复盘消息渲染（非文本消息显示类型标记） ---------- */

const KIND_LABELS: Record<string, string> = {
  product: "商品卡片",
  coupon: "优惠券",
  voice: "语音消息",
  order: "订单卡片",
  invite: "下单邀请",
  image: "图片",
  video: "视频",
  file: "文件",
};

function replayText(message: ConversationMessage): string {
  if (message.kind && message.kind !== "text") return `【${KIND_LABELS[message.kind] ?? "消息"}】`;
  return message.content;
}

/* ---------- 六维评估时间范围筛选 ---------- */

type RangeKey = "all" | "d7" | "d30" | "custom";

const RANGE_OPTIONS: { id: RangeKey; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "d7", label: "近 7 天" },
  { id: "d30", label: "近 30 天" },
  { id: "custom", label: "自定义" },
];

function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* ---------- 页面 ---------- */

export function LiveRecords({ session }: { session: Session }) {
  const [data, setData] = useState<AssessmentData | null>(null);
  const [active, setActive] = useState<AssessmentRecord | null>(null);
  const [replay, setReplay] = useState<ConversationMessage[] | null>(null);
  const [range, setRange] = useState<RangeKey>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [error, setError] = useState("");

  const [baselineScores, setBaselineScores] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    apiGet<AssessmentData>("/v1/student/assessments", session)
      .then(setData)
      .catch((cause) => setError(errorText(cause)));
    fetchBaselineStatus(session)
      .then((status) => setBaselineScores(status.completed && status.result ? status.result.scores : null))
      .catch(() => undefined);
  }, [session]);

  useEffect(() => {
    if (!active) {
      setReplay(null);
      return;
    }
    fetchConversationMessages(session, active.conversationId)
      .then(setReplay)
      .catch(() => setReplay([]));
  }, [session, active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const records = data?.records ?? [];
  const radar = data?.radar ?? {};
  const average = data?.average ?? null;
  /* 计分口径：自由练习记录仅在列表展示（带「练习」标），所有聚合指标只统计任务会话 */
  const scoredRecords = useMemo(() => records.filter((record) => !record.practice), [records]);
  const latest = scoredRecords[0] ?? null;
  const previous = scoredRecords[1] ?? null;
  const chrono = useMemo(() => [...scoredRecords].reverse(), [scoredRecords]);

  const best = scoredRecords.length ? Math.max(...scoredRecords.map((r) => r.total)) : null;
  const passCount = scoredRecords.filter((r) => r.total >= 80).length;
  const passRate = scoredRecords.length ? Math.round((passCount / scoredRecords.length) * 100) : null;
  const delta = latest && previous ? latest.total - previous.total : null;
  const avgBand = average != null ? bandOf(average) : null;

  /* 六维评估：按时间范围筛选后重新计算平均（scoredRecords 为最新在前） */
  const scoped = useMemo(() => {
    if (range === "all") return scoredRecords;
    if (range === "custom") {
      const fromTs = customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
      const toTs = customTo ? new Date(`${customTo}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
      return scoredRecords.filter((record) => {
        const ts = new Date(record.createdAt).getTime();
        return ts >= fromTs && ts <= toTs;
      });
    }
    const cutoff = Date.now() - (range === "d7" ? 7 : 30) * 86400000;
    return scoredRecords.filter((record) => new Date(record.createdAt).getTime() >= cutoff);
  }, [scoredRecords, range, customFrom, customTo]);
  const scopedChrono = useMemo(() => [...scoped].reverse(), [scoped]);
  const scopedRadar = useMemo(() => {
    const out: Record<string, number> = {};
    if (!scoped.length) return out;
    for (const dim of ASSESSMENT_DIMENSIONS) {
      out[dim.id] = Math.round(scoped.reduce((sum, record) => sum + (record.scores[dim.id] ?? 0), 0) / scoped.length);
    }
    return out;
  }, [scoped]);
  const isScoped = range !== "all";
  const scopedLabel = range === "custom"
    ? `${customFrom || "最早"} 至 ${customTo || "今天"}`
    : RANGE_OPTIONS.find((option) => option.id === range)!.label;

  const pickRange = (next: RangeKey) => {
    if (next === "custom" && !customFrom && !customTo) {
      const earliest = chrono[0];
      setCustomFrom(earliest ? isoDay(new Date(earliest.createdAt)) : "");
      setCustomTo(isoDay(new Date()));
    }
    setRange(next);
  };

  const heroStats = [
    { label: "已评分会话", value: records.length ? String(records.length) : "—", sub: "结束会话后自动评分" },
    { label: "最高分", value: best != null ? String(best) : "—", sub: "单场最佳成绩" },
    { label: "达标率", value: passRate != null ? `${passRate}%` : "—", sub: records.length ? `${passCount}/${records.length} 场达到 80 分` : "达标线 80 分" },
    { label: "最近成绩", value: latest ? String(latest.total) : "—", sub: latest ? `${latest.scenarioName} · ${dateLabel(latest.createdAt)}` : "暂无记录" },
  ];

  return (
    <div className="page rec-page">
      <PageHeader eyebrow="MY RECORDS" title="我的记录" description="会话结束后系统自动评分，教师可人工复核。点击任意记录查看完整复盘。" />
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <section className="rec-hero" aria-label="能力档案概览">
        <div className="rec-hero-main">
          <ScoreRing value={average} />
          <div className="rec-hero-copy">
            <span className="rec-hero-kicker">PERFORMANCE PROFILE</span>
            <h2>{avgBand ? `综合能力表现${avgBand.label}` : "能力档案尚未生成"}</h2>
            <p>
              {latest
                ? `基于 ${records.length} 次已评分会话的六维综合评估 · 最近一次「${latest.scenarioName}」${latest.total} 分`
                : "完成第一次实训会话后，这里会展示你的综合评分、六维雷达与成绩趋势。"}
            </p>
            <div className="rec-hero-chips">
              {avgBand ? <span className={`rec-band ${avgBand.cls}`}>{avgBand.label}</span> : null}
              {delta != null ? (
                <span className={delta > 0 ? "rec-chip up" : delta < 0 ? "rec-chip down" : "rec-chip"}>
                  {delta > 0 ? `较上一场 +${delta} 分` : delta < 0 ? `较上一场 ${delta} 分` : "与上一场持平"}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="rec-hero-stats">
          {heroStats.map((stat) => (
            <div key={stat.label}>
              <span className="label">{stat.label}</span>
              <strong>{stat.value}</strong>
              <span className="sub">{stat.sub}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel rec-section">
        <div className="panel-heading">
          <div>
            <h2>六维能力评估</h2>
            <p>
              {records.length
                ? `${isScoped ? `${scopedLabel} · ${scoped.length} 次评分平均` : `${records.length} 次评分的六维平均值`}${baselineScores ? "，虚线为初始测评基线" : isScoped ? "，虚线为全部会话平均" : " · 附针对性改进建议"}`
                : baselineScores
                  ? "已完成初始测评 · 完成实训会话后开始记录当前能力"
                  : "暂无数据"}
            </p>
          </div>
          {records.length ? (
            <div className="rec-filter">
              {range === "custom" ? (
                <div className="rec-dates">
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(event) => setCustomFrom(event.target.value)}
                    aria-label="开始日期"
                  />
                  <span aria-hidden="true">至</span>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(event) => setCustomTo(event.target.value)}
                    aria-label="结束日期"
                  />
                </div>
              ) : null}
              <div className="rec-seg" role="group" aria-label="评估时间范围">
                {RANGE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={option.id === range ? "active" : ""}
                    aria-pressed={option.id === range}
                    onClick={() => pickRange(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {records.length === 0 && !baselineScores ? (
          <div className="rec-empty">
            <Sparkles size={22} aria-hidden="true" />
            <strong>暂无评估数据</strong>
            完成一次对话并结束会话后，系统会从违规用语合规、语法准确性、话术规范、沟通有效性、客户情绪安抚、问题解决六个维度自动评分，生成你的能力雷达。
          </div>
        ) : records.length > 0 && scoped.length === 0 ? (
          <div className="rec-empty">
            <Sparkles size={22} aria-hidden="true" />
            <strong>{scopedLabel}内暂无评分记录</strong>
            换一个时间范围，或完成一次新的实训会话后再来看看。
          </div>
        ) : (() => {
          const hasRecords = records.length > 0;
          const displayRadar = hasRecords ? scopedRadar : baselineScores!;
          return (
            <div className="rec-ability">
              <div className="rec-ability-radar">
                <RadarChart
                  average={displayRadar}
                  averageName={hasRecords ? (isScoped ? `${scopedLabel}平均` : "当前能力") : "初始能力"}
                  selected={hasRecords ? (baselineScores ?? (isScoped ? radar : null)) : null}
                  selectedName={baselineScores ? "初始能力" : "全部平均"}
                  gradientId="recRadarMain"
                />
              </div>
              <div className="rec-dims">
                {ASSESSMENT_DIMENSIONS.map((dim) => {
                  const avg = displayRadar[dim.id] ?? 0;
                  const band = bandOf(avg);
                  const advice = DIMENSION_ADVICE[dim.id]!;
                  const scopedLatest = hasRecords ? scoped[0] ?? null : null;
                  const base = baselineScores?.[dim.id];
                  const diffBase = base != null ? avg - base : null;
                  const diffAll = avg - (radar[dim.id] ?? 0);
                  return (
                    <article key={dim.id} className="rec-dim-item">
                      <div className="rec-dim-main">
                        <div className="rec-dim-title">
                          <strong>{dim.label}</strong>
                          <span className={`rec-band ${band.cls}`}>{band.label}</span>
                          {hasRecords && diffBase != null ? (
                            <span
                              className={diffBase > 0 ? "rec-delta up" : diffBase < 0 ? "rec-delta down" : "rec-delta"}
                              title="当前平均分与初始测评基线的差值"
                            >
                              {diffBase > 0 ? `+${diffBase}` : diffBase < 0 ? String(diffBase) : "±0"} 较初始
                            </span>
                          ) : hasRecords && isScoped ? (
                            <span
                              className={diffAll > 0 ? "rec-delta up" : diffAll < 0 ? "rec-delta down" : "rec-delta"}
                              title="该时间范围平均分与全部会话平均分的差值"
                            >
                              {diffAll > 0 ? `+${diffAll}` : diffAll < 0 ? String(diffAll) : "±0"} vs 全部
                            </span>
                          ) : null}
                        </div>
                        <p title={avg >= 75 ? advice.strong : advice.weak}>{avg >= 75 ? advice.strong : advice.weak}</p>
                      </div>
                      <div className="rec-dim-side">
                        <div className="rec-dim-score">
                          {hasRecords ? <Sparkline values={scopedChrono.map((record) => record.scores[dim.id] ?? 0)} /> : null}
                          <strong>{avg}</strong>
                          <small>/100</small>
                        </div>
                        <i className={`rec-bar ${band.cls}`}><b style={{ width: `${avg}%` }} /></i>
                        {scopedLatest ? (
                          <span className="rec-dim-last">最近一次 {scopedLatest.scores[dim.id] ?? "—"}</span>
                        ) : !hasRecords ? (
                          <span className="rec-dim-last">初始测评成绩</span>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </section>

      <section className="panel rec-section">
        <div className="panel-heading">
          <div><h2>成绩趋势</h2><p>{records.length ? "历史总分变化与 80 分达标线" : "暂无数据"}</p></div>
        </div>
        {records.length ? (
          <TrendChart chrono={chrono} activeId={active?.id ?? null} onPick={setActive} />
        ) : (
          <div className="rec-empty">
            <Sparkles size={22} aria-hidden="true" />
            <strong>还没有成绩记录</strong>
            去任务大厅领取一个实训任务，完成后回来查看趋势。
          </div>
        )}
      </section>

      <section className="panel rec-history">
        <div className="panel-heading">
          <div><h2>历史成绩与教师评语</h2><p>点击任意记录查看评语、六维得分与完整对话复盘</p></div>
          {records.length ? <span className="rec-count">{records.length} 条记录</span> : null}
        </div>
        {records.length ? (
          <div className="rec-list" role="list">
            <div className="rec-list-head" aria-hidden="true">
              <span>会话场景</span>
              <span>总分</span>
              <span>档位</span>
              <span>完成时间</span>
              <span />
            </div>
            {records.map((record) => {
              const band = bandOf(record.total);
              return (
                <button key={record.id} type="button" className="rec-row" role="listitem" onClick={() => setActive(record)}>
                  <span className="rec-row-main">
                    <BuyerAvatar buyer={record.buyer} size="tiny" />
                    <span className="rec-row-title">
                      <strong>{record.scenarioName}{record.practice ? <em className="rec-practice-tag">练习 · 不计分</em> : null}</strong>
                      <small>{record.buyer.name} · {record.buyer.nationality}</small>
                    </span>
                  </span>
                  <span className="rec-row-score">
                    <strong>{record.total}</strong>
                    <i className={`rec-bar ${band.cls}`}><b style={{ width: `${record.total}%` }} /></i>
                  </span>
                  <span><span className={`rec-band ${band.cls}`}>{band.label}</span></span>
                  <span className="rec-row-time">
                    {new Date(record.createdAt).toLocaleDateString("zh-CN")}
                    <small>{timeOf(record.createdAt)}</small>
                  </span>
                  <span className="rec-row-open">复盘 <ChevronRight size={14} aria-hidden="true" /></span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rec-empty">
            <Sparkles size={22} aria-hidden="true" />
            <strong>暂无评分记录</strong>
            完成一次对话并在工作台点击「结束会话」后，系统会自动评分并生成复盘。
          </div>
        )}
      </section>

      {active ? (
        <div className="rec-modal-overlay" onClick={() => setActive(null)}>
          <div className="rec-modal" role="dialog" aria-modal="true" aria-label="对话复盘" onClick={(event) => event.stopPropagation()}>
            <header className="rec-modal-head">
              <BuyerAvatar buyer={active.buyer} />
              <div className="rec-modal-title">
                <strong>{active.scenarioName}</strong>
                <p>{active.buyer.name} · {active.buyer.nationality} · {new Date(active.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              <span className={`rec-band big ${bandOf(active.total).cls}`}>总分 {active.total} · {bandOf(active.total).label}</span>
              <button className="icon-button" onClick={() => setActive(null)} aria-label="关闭复盘"><X size={18} /></button>
            </header>
            <div className="rec-modal-body">
              <div className="rec-chat">
                <div className="rec-chat-day">对话回放{replay ? ` · ${replay.length} 条消息` : ""}</div>
                {(replay ?? []).map((message) =>
                  message.sender === "teacher" ? (
                    <div key={message.id} className="rec-note">教师指导 · {message.content}</div>
                  ) : (
                    <div key={message.id} className={message.sender === "student" ? "rec-msg me" : "rec-msg"}>
                      {message.sender === "buyer" ? <BuyerAvatar buyer={active.buyer} size="tiny" /> : null}
                      <div>
                        <p className="rec-bubble">{replayText(message)}</p>
                        <small>{message.sender === "student" ? "我 · " : ""}{timeOf(message.createdAt)}</small>
                      </div>
                    </div>
                  ),
                )}
                {replay === null ? <p className="muted rec-chat-hint">加载对话…</p> : null}
                {replay?.length === 0 ? <p className="muted rec-chat-hint">该会话没有可显示的消息。</p> : null}
              </div>
              <aside className="rec-analysis">
                <h3 className="rec-side-title">能力对比</h3>
                <RadarChart average={radar} selected={active.scores} selectedName="本次会话" compact gradientId="recRadarSide" />
                <h3 className="rec-side-title">AI 评语</h3>
                <div className="rec-quote">{active.comment || "（暂无评语）"}</div>
                <small className="rec-source">评语由 AI 自动生成，教师可人工复核调整总分与评语</small>
                <h3 className="rec-side-title">六维得分 · 对比平均</h3>
                <div className="rec-dim-rows">
                  {ASSESSMENT_DIMENSIONS.map((dim) => {
                    const score = active.scores[dim.id] ?? 0;
                    const diff = score - (radar[dim.id] ?? 0);
                    return (
                      <div key={dim.id} className="rec-dim-row">
                        <span>{dim.label}</span>
                        <i className={`rec-bar ${bandOf(score).cls}`}><b style={{ width: `${score}%` }} /></i>
                        <strong>{score}</strong>
                        <span
                          className={diff > 0 ? "rec-delta up" : diff < 0 ? "rec-delta down" : "rec-delta"}
                          title="与全部会话平均分的差值"
                        >
                          {diff > 0 ? `+${diff}` : diff < 0 ? String(diff) : "±0"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {active.suggestions?.length ? (
                  <>
                    <h3 className="rec-side-title">改进建议</h3>
                    <ol className="rec-tips">
                      {active.suggestions.map((tip, index) => <li key={index}>{tip}</li>)}
                    </ol>
                  </>
                ) : null}
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
