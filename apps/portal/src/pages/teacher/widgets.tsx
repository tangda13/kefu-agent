import { BarChart3, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { HelpTip } from "../../ui";

/* 教师端共享 UI：统一弹窗 / 成绩直方图 / 六维雷达 / 分数档位 */

export function TeacherDialog({
  title,
  subtitle,
  size,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  size?: "wide" | "xl" | "xxl";
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="tch-dialog-overlay" onClick={onClose}>
      <div
        className={size ? `tch-dialog ${size}` : "tch-dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div className="tt-dialog-title">
            <strong>{title}</strong>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        {children}
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export const SCORE_BUCKETS = ["<60", "60–70", "70–80", "80–90", "90+"];

export function Histogram({ distribution, emptyHint }: { distribution: number[]; emptyHint?: string }) {
  const total = distribution.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return (
      <div className="tt-empty">
        <BarChart3 size={26} aria-hidden="true" />
        <strong>暂无评分数据</strong>
        <p>{emptyHint ?? "学生完成实训、会话结束并评分后，成绩分布会实时汇总到这里。"}</p>
      </div>
    );
  }
  const max = Math.max(1, ...distribution);
  return (
    <div className="tt-hist">
      <div className="tt-hist-plot" role="img" aria-label="班级成绩分布直方图">
        {distribution.map((value, index) => (
          <div key={index} className="tt-hist-col">
            <span className={value > 0 ? "tt-hist-count" : "tt-hist-count zero"}>{value}</span>
            <i
              className={value > 0 ? undefined : "zero"}
              style={{ height: `${value > 0 ? Math.max(6, Math.round((value / max) * 148)) : 3}px` }}
            />
          </div>
        ))}
      </div>
      <div className="tt-hist-axis">
        {SCORE_BUCKETS.map((bucket) => (
          <span key={bucket}>{bucket}</span>
        ))}
      </div>
    </div>
  );
}

export interface RadarDim {
  id: string;
  label: string;
  value: number | null;
}

export function RadarChart({ dims }: { dims: RadarDim[] }) {
  const size = 360;
  const cx = size / 2;
  const cy = size / 2 + 2;
  const radius = 112;
  const count = Math.max(dims.length, 3);
  const angle = (index: number) => (Math.PI * 2 * index) / count - Math.PI / 2;
  const point = (index: number, ratio: number): [number, number] => [
    cx + Math.cos(angle(index)) * radius * ratio,
    cy + Math.sin(angle(index)) * radius * ratio,
  ];
  const ring = (ratio: number) => dims.map((_, index) => point(index, ratio).join(",")).join(" ");
  const shape = dims
    .map((dim, index) => point(index, Math.max(0.04, (dim.value ?? 0) / 100)).join(","))
    .join(" ");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="tt-radar" role="img" aria-label="六维能力雷达图">
      {[0.25, 0.5, 0.75].map((ratio) => (
        <polygon key={ratio} className="rec-radar-ring" points={ring(ratio)} />
      ))}
      <polygon className="rec-radar-ring outer" points={ring(1)} />
      {dims.map((dim, index) => {
        const [x, y] = point(index, 1);
        return <line key={dim.id} className="rec-radar-axis" x1={cx} y1={cy} x2={x} y2={y} />;
      })}
      <polygon className="rec-radar-shape avg" fill="rgba(0, 102, 204, 0.1)" points={shape} />
      {dims.map((dim, index) => {
        const [x, y] = point(index, Math.max(0.04, (dim.value ?? 0) / 100));
        return <circle key={dim.id} className="rec-radar-dot avg" cx={x} cy={y} r={3.4} />;
      })}
      {dims.map((dim, index) => {
        const [x, y] = point(index, 1.24);
        return (
          <text key={dim.id} x={x} y={y - 5} textAnchor="middle">
            <tspan className="rec-radar-label" x={x}>{dim.label}</tspan>
            <tspan className="rec-radar-value" x={x} dy={16}>{dim.value ?? "—"}</tspan>
          </text>
        );
      })}
    </svg>
  );
}

export function scoreBand(total: number): { cls: string; label: string } {
  if (total >= 85) return { cls: "good", label: "优秀" };
  if (total >= 70) return { cls: "fine", label: "良好" };
  if (total >= 60) return { cls: "warn", label: "及格" };
  return { cls: "risk", label: "待提高" };
}

export function formatIdle(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 0)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** 关键数字卡片（D-31）：标签 + 大数字 + 一行事实，右侧一个小图（仪表 / 圆环），或底部一条进度条 */
export function KpiCard({ label, help, value, sub, chart, bar }: { label: string; help: string; value: ReactNode | null; sub?: ReactNode; chart?: ReactNode; bar?: number }) {
  return (
    <div className="kpi-card">
      <span className="kpi-card-label">{label}<HelpTip>{help}</HelpTip></span>
      <div className="kpi-card-main">
        <span className="kpi-card-value">{value ?? <b className="is-dash">—</b>}</span>
        {sub ? <span className="kpi-card-sub">{sub}</span> : null}
      </div>
      {chart ? <span className="kpi-card-chart">{chart}</span> : null}
      {bar != null ? <span className="kpi-card-bar"><i style={{ width: `${Math.round(bar * 100)}%` }} /></span> : null}
    </div>
  );
}

/** 半圆仪表：满分 100，刻一道 60 分及格线；低于 60 画红色。value 为空只画灰色底圈 */
export function ScoreGauge({ value }: { value: number | null }) {
  const r = 40;
  const length = Math.PI * r;
  const angle = 0.6 * Math.PI;
  const mx = 52 - r * Math.cos(angle);
  const my = 50 - r * Math.sin(angle);
  return (
    <svg className="kpi-gauge" viewBox="0 0 104 60" aria-hidden="true">
      <path d="M12 50 A40 40 0 0 1 92 50" fill="none" stroke="var(--c-surface-hover)" strokeWidth={8} strokeLinecap="round" />
      {value != null ? <path d="M12 50 A40 40 0 0 1 92 50" fill="none" stroke={value < 60 ? "var(--c-danger)" : "var(--c-brand)"} strokeWidth={8} strokeLinecap="round" strokeDasharray={`${(length * Math.max(0, Math.min(100, value))) / 100} ${length}`} /> : null}
      <line x1={mx - 6 * Math.cos(angle)} y1={my - 6 * Math.sin(angle)} x2={mx + 7 * Math.cos(angle)} y2={my + 7 * Math.sin(angle)} stroke="var(--c-ink-2)" strokeWidth={2} />
      <text x={mx - 15} y={my - 6} fontSize={9} fill="var(--c-ink-3)">60</text>
    </svg>
  );
}

/** 圆环：百分比；value 为空只画灰色底圈 */
export function RateRing({ value, color = "var(--c-brand)" }: { value: number | null; color?: string }) {
  const r = 26;
  const length = 2 * Math.PI * r;
  return (
    <svg className="kpi-ring" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx={32} cy={32} r={r} fill="none" stroke="var(--c-surface-hover)" strokeWidth={8} />
      {value != null && value > 0 ? <circle cx={32} cy={32} r={r} fill="none" stroke={color} strokeWidth={8} strokeLinecap="round" strokeDasharray={`${(length * Math.min(100, value)) / 100} ${length}`} transform="rotate(-90 32 32)" /> : null}
    </svg>
  );
}

/** 图表没数据时盖在骨架上的提示卡：说清还差什么，可带一个去处 */
export function ChartEmptyNote({ title = "还没有评分", desc, action }: { title?: string; desc: string; action?: ReactNode }) {
  return <div className="chart-note"><b>{title}</b><span>{desc}</span>{action}</div>;
}

/** 成绩分布：五档竖条。没有数据时照常画出五档和坐标，柱子用斜纹占位，配一张提示卡（D-30） */
export function ScoreDistribution({ distribution, emptyNote }: { distribution: number[]; emptyNote?: ReactNode }) {
  const total = distribution.reduce((sum, value) => sum + value, 0);
  const max = Math.max(1, ...distribution);
  return (
    <div className={total ? "score-dist" : "score-dist is-empty"} role="img" aria-label="成绩分布">
      {distribution.map((value, index) => (
        <div key={index} className="score-dist-col">
          <span className="score-dist-count">{value} 人</span>
          <i style={{ height: total ? (value ? `${Math.max(4, Math.round((value / max) * 100))}%` : "2px") : undefined }} className={index === 0 ? "is-low" : undefined} />
          <span className="score-dist-label">{SCORE_BUCKETS[index]}</span>
        </div>
      ))}
      {total ? null : emptyNote ?? <ChartEmptyNote desc="学生完成接待、出了评分后，按分数段显示人数" />}
    </div>
  );
}

/** 六项能力横条：偏弱项标出来。没有数据时进度条用虚线占位，配一张提示卡 */
export function DimensionBars({ dims, weak, baseline, emptyNote }: { dims: RadarDim[]; weak?: Set<string>; baseline?: Record<string, number | null>; emptyNote?: ReactNode }) {
  const empty = dims.every((dim) => dim.value == null);
  return (
    <div className={empty ? "dim-bars is-empty" : "dim-bars"}>
      {dims.map((dim) => {
        const base = baseline?.[dim.id];
        return (
          <div key={dim.id} className={weak?.has(dim.id) ? "dim-bar is-weak" : "dim-bar"}>
            <span className="dim-bar-label">{dim.label}</span>
            <span className="dim-bar-track">
              {dim.value != null ? <i style={{ width: `${dim.value}%` }} /> : null}
              {base != null ? <b style={{ left: `${base}%` }} title={`训前 ${base}`} /> : null}
            </span>
            <strong>{dim.value ?? "—"}</strong>
            <em>{weak?.has(dim.id) ? "偏弱" : ""}</em>
          </div>
        );
      })}
      {empty ? emptyNote ?? <ChartEmptyNote desc="出了评分后显示每项的平均分" /> : null}
    </div>
  );
}

/** 截止时间写成人话并按紧急程度上色：已逾期 = 红，3 天内 = 橙 */
export function dueText(deadline: string | null, closed = false): { text: string; tone: "" | "warn" | "bad" } {
  if (!deadline) return { text: "不设截止", tone: "" };
  const end = new Date(deadline);
  const hours = (end.getTime() - Date.now()) / 3_600_000;
  const date = `${end.getMonth() + 1}/${end.getDate()}`;
  if (closed) return { text: `${date} 截止`, tone: "" };
  if (hours < 0) {
    const days = Math.ceil(-hours / 24);
    return { text: days <= 1 ? "已逾期" : `已逾期 ${days} 天`, tone: "bad" };
  }
  if (hours < 24) return { text: `今天 ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")} 截止`, tone: "warn" };
  if (hours < 72) return { text: `还剩 ${Math.ceil(hours / 24)} 天`, tone: "warn" };
  if (hours < 24 * 7) return { text: `还剩 ${Math.ceil(hours / 24)} 天`, tone: "" };
  return { text: `${date} 截止`, tone: "" };
}

/** 进度：完成人数 + 百分比 + 粗进度条 */
export function Progress({ done, total }: { done: number; total: number }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="prog">
      <div className="prog-top"><span><b>{done}</b> / {total} 人完成</span><span>{percent}%</span></div>
      <div className="prog-track"><i style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

/* 从总览跳到实训跟踪时指定打开哪个页签（页面切换不经过路由，用一个一次性的变量传过去） */
let nextTrackingTab: "live" | "replay" | null = null;
export function openTrackingTab(tab: "live" | "replay") {
  nextTrackingTab = tab;
}
/** 从别的页跳到“回放与评分”时，预先填好搜索词（如考核报表里点某个学生的“看回放”） */
let nextReplaySearch: string | null = null;
export function openReplayFor(keyword: string) {
  nextTrackingTab = "replay";
  nextReplaySearch = keyword;
}
export function takeReplaySearch(): string {
  const value = nextReplaySearch ?? "";
  nextReplaySearch = null;
  return value;
}
export function takeTrackingTab(): "live" | "replay" {
  const tab = nextTrackingTab ?? "live";
  nextTrackingTab = null;
  return tab;
}
