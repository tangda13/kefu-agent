import { ArrowDown, ArrowUp, ChartLine, MessageSquareDashed, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import {
  ApiError,
  apiGet,
  fetchBaselineStatus,
  fetchConversationMessages,
  type BaselineResult,
  type BuyerPublicView,
  type ConversationMessage,
  type Session,
} from "../../api/client";
import { Bench, Board, Button, FilterChips, HelpTip, Segmented } from "../../ui";
import { StudentKpis } from "./StudentKpis";
import "../../styles/student-learn.css";

interface AssessmentRecord {
  id: string;
  conversationId: string;
  scenarioName: string;
  scenarioStage: string | null;
  taskId: string | null;
  /** 任务名；自由练习为空 */
  taskName: string | null;
  /** 达标线；自由练习为空 */
  passScore: number | null;
  buyer: BuyerPublicView;
  scores: Record<string, number>;
  total: number;
  comment: string;
  teacherComment: string | null;
  reviewed: boolean;
  suggestions: string[];
  /** 自由练习：保留 AI 反馈供复盘，但不计入平均分/走势/能力雷达 */
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

/** 能力雷达的维度，顺序即雷达上的顺序（D-46：八项） */
const DIMS = ASSESSMENT_DIMENSIONS;

/** 每一项的一句建议：最弱两项显示在雷达下方，其余悬停查看 */
const DIM_TIPS: Record<string, string> = {
  professionalism: "按“问候、确认问题、给方案、约定下一步”的顺序组织回复",
  effectiveness: "先回应买家最关心的问题，再补充说明；一条消息只讲一件事",
  empathy: "买家不满时先共情再给方案：I completely understand… / I'm so sorry…",
  resolution: "给出能执行的方案（补发 / 退款 / 折扣），写清时限和步骤",
  knowledge: "回答规格、时效、退换政策前先查商品详情；拿不准先说会核实后回复",
  responsiveness: "买家进线先回一句确认再去查资料；同时接待几位时先回等得最久的",
  grammar: "多用短句，发送前通读一遍，注意时态一致",
  compliance: "避免 best、guarantee、100% 这类绝对化说法",
};

/* ---------- 复盘弹窗用：分数档位、雷达图 ---------- */

function bandOf(score: number): { label: string; cls: string } {
  if (score >= 85) return { label: "优秀", cls: "good" };
  if (score >= 70) return { label: "良好", cls: "fine" };
  if (score >= 60) return { label: "合格", cls: "warn" };
  return { label: "待提升", cls: "risk" };
}

const RADAR = { w: 640, h: 480, cx: 320, cy: 240, r: 168 };

function radarPoint(index: number, count: number, value: number) {
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  const radius = (RADAR.r * Math.max(0, Math.min(100, value))) / 100;
  return { x: RADAR.cx + radius * Math.cos(angle), y: RADAR.cy + radius * Math.sin(angle) };
}

function RadarChart({ average, selected, selectedName, compact, gradientId }: {
  average: Record<string, number>;
  selected?: Record<string, number> | null;
  selectedName?: string;
  compact?: boolean;
  gradientId: string;
}) {
  const dims = DIMS;
  const count = dims.length;
  /* 老记录没有新增两项（D-46）：缺分的维度跳过，不按 0 分画 */
  const polygon = (scores: Record<string, number>) =>
    dims.flatMap((dim, i) => {
      if (scores[dim.id] == null) return [];
      const p = radarPoint(i, count, scores[dim.id]!);
      return [`${p.x},${p.y}`];
    }).join(" ");
  return (
    <div className={compact ? "rec-radar compact" : "rec-radar"}>
      <svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} role="img" aria-label="能力雷达图">
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
          if (average[dim.id] == null) return null;
          const p = radarPoint(i, count, average[dim.id]!);
          return <circle key={dim.id} cx={p.x} cy={p.y} r={3.2} className="rec-radar-dot avg" />;
        })}
        {selected
          ? dims.map((dim, i) => {
              if (selected[dim.id] == null) return null;
              const p = radarPoint(i, count, selected[dim.id]!);
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
          <span><i className="rec-dot avg" /> 全部会话平均</span>
          <span><i className="rec-dot sel" /> {selectedName ?? "本次会话"}</span>
        </div>
      ) : null}
    </div>
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

/* ---------- 时间 ---------- */

function dateLabel(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 记录时间：今天写“今天 16:40”，其余写“10 月 13 日” */
function rowTime(iso: string): string {
  const date = new Date(iso);
  if (date.toDateString() === new Date().toDateString()) return `今天 ${timeOf(iso)}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 分数块颜色：低于达标线红，80 分以上绿，其余中性 */
function scoreTone(record: AssessmentRecord): "lo" | "hi" | "mid" {
  if (record.passScore != null && record.total < record.passScore) return "lo";
  return record.total >= 80 ? "hi" : "mid";
}

/* ---------- 能力雷达（D-46）：近期平均 + 训前测评，分数和较训前标在顶点旁，悬停看口径和建议 ---------- */

/** 按实际像素排版（不整体缩放）：文字始终 13px；窄的时候缩小半径、整体左移给右上角图例让位 */
const AB = { h: 340, gap: 16, labelW: 96, legendW: 92, maxR: 112, minR: 56 };

function radarLayout(w: number) {
  const cy = AB.h / 2;
  for (let r = AB.maxR; r > AB.minR; r -= 2) {
    const reach = r + AB.gap + AB.labelW;
    // 右上那个顶点的标签不能压到图例
    const cx = Math.min(w / 2, w - AB.legendW - AB.labelW - Math.SQRT1_2 * (r + AB.gap));
    if (cx - reach >= 0 && cx + reach <= w) return { cx, cy, r };
  }
  return { cx: w / 2, cy, r: AB.minR };
}

function AbilityRadar({ values, base }: { values: Record<string, number> | null; base: Record<string, number> | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, box] = useBoxSize<HTMLDivElement>({ w: 600, h: AB.h });
  const { cx, cy, r } = radarLayout(box.w);
  const count = DIMS.length;
  const point = (index: number, value: number, radius: number = r) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    const k = (radius * Math.max(0, Math.min(100, value))) / 100;
    return { x: cx + k * Math.cos(angle), y: cy + k * Math.sin(angle) };
  };
  const valueOf = (id: string) => values?.[id] ?? null;
  const baseOf = (id: string) => base?.[id] ?? null;
  const present = DIMS.map((dim, i) => ({ dim, i, v: valueOf(dim.id) })).filter((item) => item.v != null);
  const hovered = hover != null ? DIMS[hover]! : null;
  const anchor = hover != null ? point(hover, valueOf(DIMS[hover]!.id) ?? 100) : null;
  // 浮层放在点的外侧
  const tipStyle = (() => {
    if (!anchor) return undefined;
    const dx = anchor.x - cx;
    const dy = anchor.y - cy;
    const tx = dx > 8 ? "calc(-100% - 14px)" : dx < -8 ? "14px" : "-50%";
    const ty = Math.abs(dx) <= 8 ? (dy < 0 ? "14px" : "calc(-100% - 14px)") : dy < -8 ? "6px" : dy > 8 ? "calc(-100% - 6px)" : "-50%";
    return { left: anchor.x, top: anchor.y, transform: `translate(${tx}, ${ty})` };
  })();
  const hv = hovered ? valueOf(hovered.id) : null;
  const hb = hovered ? baseOf(hovered.id) : null;
  const hd = hv != null && hb != null ? hv - hb : null;
  return (
    <div ref={boxRef} className="sl-radar" onMouseLeave={() => setHover(null)}>
      <div className="sl-radar-legend">
        <span><i />近期平均</span>
        <span><em />训前测评</span>
        <span><em className="is-pass" />60 分线</span>
      </div>
      <svg width={box.w} height={AB.h} viewBox={`0 0 ${box.w} ${AB.h}`} role="img" aria-label="能力雷达图">
        <defs>
          <linearGradient id="slRadarFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(29, 95, 209, 0.26)" />
            <stop offset="100%" stopColor="rgba(29, 95, 209, 0.06)" />
          </linearGradient>
        </defs>
        {[20, 40, 80, 100].map((value) => (
          <circle key={value} cx={cx} cy={cy} r={(r * value) / 100} className={value === 100 ? "sl-radar-ring is-outer" : "sl-radar-ring"} />
        ))}
        <circle cx={cx} cy={cy} r={r * 0.6} className="sl-radar-ring is-pass" />
        {DIMS.map((dim, i) => {
          const end = point(i, 100);
          return <line key={dim.id} x1={cx} y1={cy} x2={end.x} y2={end.y} className="sl-radar-axis" />;
        })}
        {/* 训前测评只测了原来六项：没分的轴断开 */}
        {DIMS.map((dim, i) => {
          const next = DIMS[(i + 1) % count]!;
          const a = baseOf(dim.id);
          const b = baseOf(next.id);
          if (a == null || b == null) return null;
          const p = point(i, a);
          const q = point((i + 1) % count, b);
          return <line key={dim.id} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="sl-radar-base" />;
        })}
        {present.length > 1 ? (
          <polygon
            points={present.map(({ i, v }) => { const p = point(i, v!); return `${p.x},${p.y}`; }).join(" ")}
            className="sl-radar-avg"
            fill="url(#slRadarFill)"
          />
        ) : null}
        {present.map(({ dim, i, v }) => {
          const p = point(i, v!);
          const cls = ["sl-radar-dot", v! < 60 ? "is-lo" : "", hover === i ? "is-hover" : ""].filter(Boolean).join(" ");
          return <circle key={dim.id} cx={p.x} cy={p.y} r={hover === i ? 6 : 3.5} className={cls} />;
        })}
        {DIMS.map((dim, i) => {
          const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          const at = point(i, 100, r + AB.gap);
          const textAnchor = Math.abs(dx) < 0.3 ? "middle" : dx > 0 ? "start" : "end";
          const y = at.y + (dy > 0.3 ? 12 : dy < -0.3 ? -18 : -6);
          const v = valueOf(dim.id);
          const b = baseOf(dim.id);
          const d = v != null && b != null ? v - b : null;
          const hit = point(i, v ?? 100);
          return (
            <g key={dim.id} className="sl-radar-hit" onMouseEnter={() => setHover(i)}>
              <circle cx={hit.x} cy={hit.y} r={14} fill="transparent" />
              <text x={at.x} y={y} textAnchor={textAnchor} className="sl-radar-name">{dim.label}</text>
              <text x={at.x} y={y + 18} textAnchor={textAnchor}>
                <tspan className={v == null ? "sl-radar-val is-none" : v < 60 ? "sl-radar-val is-lo" : "sl-radar-val"}>{v ?? "—"}</tspan>
                {d != null ? <tspan dx={6} className={d < 0 ? "sl-radar-dl is-down" : "sl-radar-dl"}>{d >= 0 ? "↑" : "↓"}{Math.abs(d)} 较训前</tspan> : null}
              </text>
            </g>
          );
        })}
      </svg>
      {hovered && tipStyle ? (
        <div className="sl-radar-tip" style={tipStyle}>
          <div className="sl-radar-tip-h">
            {hovered.label}
            <b className={hv != null && hv < 60 ? "is-lo" : undefined}>{hv ?? "—"}</b>
            {hd != null ? (
              <span className={hd >= 0 ? "kpi-pill" : "kpi-pill is-down"}>
                {hd >= 0 ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}{Math.abs(hd)} 较训前
              </span>
            ) : null}
          </div>
          <div className="sl-radar-tip-k">看什么</div>
          <div>{hovered.hint}</div>
          <div className="sl-radar-tip-k">建议</div>
          <div>{DIM_TIPS[hovered.id]}</div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- 成绩走势：任务接待的分数折线，虚线是达标线，低于达标线的点标红 ---------- */

const TREND = { left: 32, right: 16, top: 16, bottom: 28, min: 20 };

/** 按容器实际像素画（不按比例缩放）：卡片被左边能力雷达撑高时，折线跟着填满，字号不变 */
function useBoxSize<T extends HTMLElement>(fallback: { w: number; h: number }) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function TrendChart({ chrono, passLine, onPick }: { chrono: AssessmentRecord[]; passLine: number; onPick: (record: AssessmentRecord) => void }) {
  const [boxRef, box] = useBoxSize<HTMLDivElement>({ w: 520, h: 300 });
  const T = { ...TREND, w: box.w, h: box.h };
  const plotW = T.w - T.left - T.right;
  const plotH = T.h - T.top - T.bottom;
  const x = (i: number) => (chrono.length <= 1 ? T.left + plotW / 2 : T.left + (plotW * i) / (chrono.length - 1));
  const y = (value: number) => T.top + plotH * (1 - (Math.max(T.min, Math.min(100, value)) - T.min) / (100 - T.min));
  const labelAt = chrono.length <= 6 ? chrono.map((_, i) => i) : [...new Set([0, 1, 2, 3, 4, 5].map((t) => Math.round(((chrono.length - 1) * t) / 5)))];
  const empty = chrono.length === 0;
  const placeholder = [0, 1, 2, 3, 4, 5].map((i) => `${T.left + (plotW * i) / 5},${y(60)}`).join(" ");
  return (
    <div ref={boxRef} className="sl-trend-box">
      <svg className="sl-trend-svg" width={T.w} height={T.h} viewBox={`0 0 ${T.w} ${T.h}`} role="img" aria-label="成绩走势">
        {[40, 60, 80, 100].map((value) => (
          <g key={value}>
            <line x1={T.left - 4} x2={T.w - T.right} y1={y(value)} y2={y(value)} stroke="#eef1f5" />
            <text x={0} y={y(value) + 4} fontSize={12} fill="#9aa3b0">{value}</text>
          </g>
        ))}
        <line x1={T.left - 4} x2={T.w - T.right} y1={y(passLine)} y2={y(passLine)} stroke="var(--c-ink)" strokeDasharray="4 4" />
        <text x={T.w - T.right} y={y(passLine) - 6} fontSize={12} fill="var(--c-ink-2)" textAnchor="end">达标线 {passLine}</text>
        {empty ? (
          <polyline points={placeholder} fill="none" stroke="#dfe4ea" strokeWidth={2} strokeDasharray="4 4" />
        ) : (
          <>
            <polyline points={chrono.map((record, i) => `${x(i)},${y(record.total)}`).join(" ")} fill="none" stroke="var(--c-brand)" strokeWidth={2} />
            {chrono.map((record, i) => (
              <circle
                key={record.id}
                className="sl-trend-dot"
                cx={x(i)}
                cy={y(record.total)}
                r={5}
                fill="#fff"
                stroke={record.passScore != null && record.total < record.passScore ? "var(--c-danger)" : "var(--c-brand)"}
                strokeWidth={2}
                onClick={() => onPick(record)}
              >
                <title>{record.total} 分 · {record.taskName ?? record.scenarioName} · {dateLabel(record.createdAt)}</title>
              </circle>
            ))}
            {labelAt.map((i) => (
              <text key={chrono[i]!.id} x={x(i)} y={T.h - 6} fontSize={12} fill="#9aa3b0" textAnchor={i === 0 ? "start" : i === chrono.length - 1 ? "end" : "middle"}>{dateLabel(chrono[i]!.createdAt)}</text>
            ))}
          </>
        )}
      </svg>
    </div>
  );
}

/* ---------- 页面 ---------- */

type RangeKey = "all" | "d7" | "d30";
type ListFilter = "all" | "task" | "practice" | "teacher";

const RANGE_OPTIONS: { id: RangeKey; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "d7", label: "近 7 天" },
  { id: "d30", label: "近 30 天" },
];

export const RECORD_TASK_KEY = "cecs.recordTask";

export function LiveRecords({ session, onOpenHall }: { session: Session; onOpenHall?: () => void }) {
  const [data, setData] = useState<AssessmentData | null>(null);
  const [active, setActive] = useState<AssessmentRecord | null>(null);
  const [replay, setReplay] = useState<ConversationMessage[] | null>(null);
  const [range, setRange] = useState<RangeKey>("all");
  const [filter, setFilter] = useState<ListFilter>("all");
  /** 从任务大厅“看复盘”进来：只看这个任务的记录，并直接打开最近一次复盘 */
  const [taskFocus, setTaskFocus] = useState<string | null>(() => {
    try {
      const id = sessionStorage.getItem(RECORD_TASK_KEY);
      sessionStorage.removeItem(RECORD_TASK_KEY);
      return id;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState("");
  const [baseline, setBaseline] = useState<BaselineResult | null>(null);

  useEffect(() => {
    apiGet<AssessmentData>("/v1/student/assessments", session)
      .then((loaded) => {
        setData(loaded);
        const latest = taskFocus ? loaded.records.find((record) => record.taskId === taskFocus) : null;
        if (latest) setActive(latest);
      })
      .catch((cause) => setError(errorText(cause)));
    fetchBaselineStatus(session)
      .then((status) => setBaseline(status.completed && status.result ? status.result : null))
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
  /* 计分口径：自由练习只在记录里展示，走势和能力雷达只统计任务接待 */
  const scoredRecords = useMemo(() => records.filter((record) => !record.practice), [records]);
  const chrono = useMemo(() => [...scoredRecords].reverse(), [scoredRecords]);

  const scoped = useMemo(() => {
    if (range === "all") return scoredRecords;
    const cutoff = Date.now() - (range === "d7" ? 7 : 30) * 86400000;
    return scoredRecords.filter((record) => new Date(record.createdAt).getTime() >= cutoff);
  }, [scoredRecords, range]);
  const scopedAverage = useMemo(() => {
    const out: Record<string, number> = {};
    if (!scoped.length) return out;
    for (const dim of DIMS) {
      // 只在有分的记录里平均：老记录没有新增两项（D-46）
      const values = scoped.map((record) => record.scores[dim.id]).filter((value): value is number => value != null);
      if (values.length) out[dim.id] = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    }
    return out;
  }, [scoped]);

  /* 最弱的两项（低于 75 才给建议），显示在雷达下方 */
  const weakDims = useMemo(() => {
    if (!scoped.length) return [];
    return DIMS
      .filter((dim) => scopedAverage[dim.id] != null && scopedAverage[dim.id]! < 75)
      .sort((a, b) => scopedAverage[a.id]! - scopedAverage[b.id]!)
      .slice(0, 2);
  }, [scoped, scopedAverage]);

  const passLine = chrono.length ? (chrono[chrono.length - 1]!.passScore ?? 60) : 60;

  const taskCount = records.filter((record) => !record.practice).length;
  const practiceCount = records.length - taskCount;
  const teacherCount = records.filter((record) => record.teacherComment).length;
  const focusName = taskFocus ? records.find((record) => record.taskId === taskFocus)?.taskName ?? null : null;
  const visibleRecords = records.filter((record) => (taskFocus ? record.taskId === taskFocus : true)).filter((record) =>
    filter === "task" ? !record.practice : filter === "practice" ? !!record.practice : filter === "teacher" ? !!record.teacherComment : true,
  );

  const abilityCount = scoped.length
    ? `${scoped.length} 次接待的平均`
    : baseline ? `训前测评 ${baseline.total} 分` : "";
  const noData = scoped.length === 0;

  return (
    <Bench className="sl-page">
      {error ? <p className="sl-form-error" role="alert">{error}</p> : null}
      <StudentKpis session={session} />

      <div className="sl-two">
        <Board
          className="sl-rel"
          title="能力雷达"
          count={abilityCount || undefined}
          extra={scoredRecords.length ? <Segmented<RangeKey> items={RANGE_OPTIONS} value={range} onChange={setRange} /> : undefined}
        >
          <AbilityRadar values={noData ? null : scopedAverage} base={baseline?.scores ?? null} />
          {noData ? (
            <div className="sl-hint is-below">
              <MessageSquareDashed size={18} aria-hidden="true" />
              {scoredRecords.length ? "这段时间没有任务接待，换个时间范围看看" : "完成第一次接待后，这里出现你的能力雷达"}
              <HelpTip>蓝色是接待成绩的平均，灰色虚线是训前测评，两者对比就是你的进步；低于 60 分的标红。鼠标停在某一项上可以看评分口径和建议。</HelpTip>
            </div>
          ) : weakDims.length ? (
            <div className="sl-radar-weak">
              {weakDims.map((dim) => <div key={dim.id}><b>{dim.label}</b>{DIM_TIPS[dim.id]}</div>)}
            </div>
          ) : null}
        </Board>

        <Board
          className="sl-rel"
          title="成绩走势"
          count="任务接待"
          extra={<HelpTip>每个点是一次任务接待的综合分，虚线是达标线，低于达标线的点标红。点一个点可以打开那次复盘。</HelpTip>}
        >
          <div className="sl-trend"><TrendChart chrono={chrono} passLine={passLine} onPick={setActive} /></div>
          {chrono.length === 0 ? (
            <div className="sl-hint is-low"><ChartLine size={18} aria-hidden="true" />每次任务接待出分后连成线</div>
          ) : null}
        </Board>
      </div>

      <Board
        title={focusName ? <>成绩记录 · {focusName}<button type="button" className="sl-focus-clear" onClick={() => setTaskFocus(null)}>看全部</button></> : "成绩记录"}
        count={focusName ? visibleRecords.length : records.length}
        extra={
          records.length && !focusName ? (
            <FilterChips<ListFilter>
              value={filter}
              onChange={setFilter}
              items={[
                { id: "all", label: "全部" },
                { id: "task", label: "任务", count: taskCount },
                { id: "practice", label: "练习", count: practiceCount },
                { id: "teacher", label: "有老师评语", count: teacherCount },
              ]}
            />
          ) : undefined
        }
      >
        {records.length === 0 ? (
          <div className="sl-empty-line">
            <div>
              <b>还没有记录</b>
              <div className="sl-muted">完成任务里的接待或自由练习后，每一次都会在这里留一份复盘。</div>
            </div>
            {onOpenHall ? <Button className="sl-empty-act" onClick={onOpenHall}>去任务大厅</Button> : null}
          </div>
        ) : visibleRecords.length === 0 ? (
          <p className="sl-quiet">这一类下面还没有记录。</p>
        ) : (
          visibleRecords.map((record) => (
            <div key={record.id} className={record.practice ? "sl-rr is-practice" : "sl-rr"} onClick={() => setActive(record)}>
              <span className={`sl-sc is-${record.practice ? "practice" : scoreTone(record)}`}>
                {record.practice ? "练习" : <>{record.total}<small>分</small></>}
              </span>
              <div className="sl-rr-name">
                <b>{record.taskName ?? "自由练习"}</b>
                <div className="sl-rr-m2">
                  {record.scenarioName} · {record.buyer.name} · {rowTime(record.createdAt)}
                  {record.reviewed ? <span className="sl-tag">已复核</span> : null}
                </div>
              </div>
              <div className="sl-mini" aria-label="各项得分">
                {DIMS.map((dim) => {
                  const score = record.scores[dim.id];
                  if (score == null) return <i key={dim.id} className="is-none" title={`${dim.label} —`} />;
                  return <i key={dim.id} className={score < 60 ? "is-lo" : undefined} style={{ height: `${score * 0.34}px` }} title={`${dim.label} ${score}`} />;
                })}
              </div>
              <div className="sl-cm">
                <div><span className="sl-who is-ai">AI</span><span className="sl-cm-x">{record.comment || "暂无评语"}</span></div>
                {record.teacherComment ? <div className="is-teacher"><span className="sl-who is-t">老师</span><span className="sl-cm-x">{record.teacherComment}</span></div> : null}
              </div>
              <Button size="sm" onClick={(event) => { event.stopPropagation(); setActive(record); }}>复盘</Button>
            </div>
          ))
        )}
      </Board>

      {active ? (
        <div className="rec-modal-overlay" onClick={() => setActive(null)}>
          <div className="rec-modal" role="dialog" aria-modal="true" aria-label="对话复盘" onClick={(event) => event.stopPropagation()}>
            <header className="rec-modal-head">
              <BuyerAvatar buyer={active.buyer} />
              <div className="rec-modal-title">
                <strong>{active.taskName ? `${active.taskName} · ${active.scenarioName}` : active.scenarioName}</strong>
                <p>{active.buyer.name} · {active.buyer.nationality} · {new Date(active.createdAt).toLocaleString("zh-CN")}</p>
              </div>
              {active.practice ? (
                <span className="rec-band big warn">练习 · 不计分 · {active.total} 分</span>
              ) : (
                <span className={`rec-band big ${active.passScore != null && active.total < active.passScore ? "risk" : bandOf(active.total).cls}`}>
                  总分 {active.total}{active.passScore != null ? ` · ${active.total >= active.passScore ? "达标" : "未达标"}（达标线 ${active.passScore}）` : ""}
                </span>
              )}
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
                {active.teacherComment ? (
                  <>
                    <h3 className="rec-side-title">老师评语{active.reviewed ? " · 已复核" : ""}</h3>
                    <div className="rec-quote sl-teacher-quote">{active.teacherComment}</div>
                  </>
                ) : null}
                <h3 className="rec-side-title">各项得分 · 对比平均</h3>
                <div className="rec-dim-rows">
                  {DIMS.map((dim) => {
                    const score = active.scores[dim.id];
                    if (score == null) {
                      return (
                        <div key={dim.id} className="rec-dim-row">
                          <span>{dim.label}</span>
                          <i className="rec-bar" />
                          <strong className="muted">—</strong>
                          <span />
                        </div>
                      );
                    }
                    const average = radar[dim.id];
                    const diff = average == null ? null : score - average;
                    return (
                      <div key={dim.id} className="rec-dim-row">
                        <span>{dim.label}</span>
                        <i className={`rec-bar ${bandOf(score).cls}`}><b style={{ width: `${score}%` }} /></i>
                        <strong>{score}</strong>
                        {diff == null ? <span /> : (
                          <span
                            className={diff > 0 ? "rec-delta up" : diff < 0 ? "rec-delta down" : "rec-delta"}
                            title="与全部会话平均分的差值"
                          >
                            {diff > 0 ? `+${diff}` : diff < 0 ? String(diff) : "±0"}
                          </span>
                        )}
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
    </Bench>
  );
}
