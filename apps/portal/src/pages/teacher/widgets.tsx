import { BarChart3, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

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
  return `${Math.floor(seconds / 3600)} 小时+`;
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
