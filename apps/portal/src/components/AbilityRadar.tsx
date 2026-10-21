import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";

/* 能力雷达（D-46）：学生端我的记录、教师端考核报表（D-60 全班能力雷达）共用。 */

/** 能力雷达的维度，顺序即雷达上的顺序（D-46：八项） */
const DIMS = ASSESSMENT_DIMENSIONS;

/*
 * 能力雷达每一项的说明：定义 + 建议，按平台规范说明的口吻写（不用口语，不用对话）。
 * ASSESSMENT_DIMENSIONS.hint 是给评分模型的评分口径，不直接显示在界面上。
 */
export const DIM_DEFINITIONS: Record<string, string> = {
  professionalism: "考察开场问候、问题确认、结束语等环节的话术完整性，以及称谓、语气和礼仪是否符合专业客服标准与买家所在国的沟通习惯。",
  effectiveness: "考察对买家诉求的理解与回应：是否优先回应核心问题、表述是否清晰完整，信息不足时是否主动确认。",
  empathy: "考察识别买家负面情绪并进行安抚的能力，以及沟通过程中买家情绪的改善程度。",
  resolution: "考察解决方案的可执行性与完整性：处理方式、时限和步骤是否明确，问题是否最终闭环；售前环节同时考察是否推动成交。",
  knowledge: "考察所提供的商品规格、价格、物流时效及退换政策等信息与店铺资料是否一致，是否存在超出政策范围的承诺。",
  responsiveness: "考察对买家消息的响应速度，包括首次响应与平均响应时间，以及是否因等待过久导致买家催促或离开；由系统按消息时间计算。",
  grammar: "考察外语表达的拼写、语法与用词准确性。",
  compliance: "考察用语是否符合跨境电商平台规范，包括是否使用绝对化宣传用语、作出无法兑现的承诺或泄露买家隐私。",
};

/** 每一项的建议：最弱两项显示在雷达下方，悬停时与定义一起显示 */
export const DIM_TIPS: Record<string, string> = {
  professionalism: "按“问候—确认需求—提供方案—确认后续事项”的流程组织回复，结束前确认买家是否还有其他问题。",
  effectiveness: "优先回应买家最关注的问题，单条消息聚焦一个要点；信息不足时先确认订单号、用途或预算等关键信息。",
  empathy: "提出方案前先表达理解与歉意，如 “I completely understand how frustrating this is.”，再说明处理措施。",
  resolution: "给出具体可执行的方案（补发、退款或补偿）并明确时限；售前环节在解答疑问后适时引导下单。",
  knowledge: "回复前核对商品详情与店铺政策；无法确认的信息告知买家核实后答复，避免臆测或超范围承诺。",
  responsiveness: "买家消息到达后先简短确认再查询资料；同时接待多位买家时，优先回复等待时间最长的会话。",
  grammar: "使用简洁句式，发送前复核时态、主谓一致与拼写。",
  compliance: "避免使用 best、guarantee、100% 等绝对化表述，以客观、可验证的商品信息替代。",
};

/** 按容器实际像素画（不按比例缩放）：卡片被撑高时图跟着填满，字号不变 */
export function useBoxSize<T extends HTMLElement>(fallback: { w: number; h: number }) {
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

/* ---------- 能力雷达（D-46）：近期平均 + 训前测评，分数和较训前标在顶点旁，悬停看口径和建议 ---------- */

/** 按实际像素排版（不整体缩放）：文字始终 13px；窄的时候缩小半径、整体左移给右上角图例让位 */
/** 悬停说明的宽度，和 .ab-radar-tip 的 width 一致 */
const TIP_W = 300;

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

export function AbilityRadar({ values, base, valueLabel = "近期平均" }: {
  values: Record<string, number> | null;
  base: Record<string, number> | null;
  /** 实线的名字：学生端“近期平均”，教师端“全班平均” */
  valueLabel?: string;
}) {
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
    const ty = Math.abs(dx) <= 8 ? (dy < 0 ? "14px" : "calc(-100% - 14px)") : dy < -8 ? "6px" : dy > 8 ? "calc(-100% - 6px)" : "-50%";
    // 横向不出容器：卡片窄（教师端考核报表半栏）时，左右两侧的点放不下就贴着边
    const left = dx > 8 ? anchor.x - 14 - TIP_W : dx < -8 ? anchor.x + 14 : anchor.x - TIP_W / 2;
    return { left: Math.max(0, Math.min(box.w - TIP_W, left)), top: anchor.y, transform: `translateY(${ty})` };
  })();
  const hv = hovered ? valueOf(hovered.id) : null;
  const hb = hovered ? baseOf(hovered.id) : null;
  const hd = hv != null && hb != null ? hv - hb : null;
  return (
    <div ref={boxRef} className="ab-radar" onMouseLeave={() => setHover(null)}>
      <div className="ab-radar-legend">
        <span><i />{valueLabel}</span>
        <span><em />训前测评</span>
        <span><em className="is-pass" />60 分线</span>
      </div>
      <svg width={box.w} height={AB.h} viewBox={`0 0 ${box.w} ${AB.h}`} role="img" aria-label="能力雷达图">
        <defs>
          <linearGradient id="abRadarFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(29, 95, 209, 0.26)" />
            <stop offset="100%" stopColor="rgba(29, 95, 209, 0.06)" />
          </linearGradient>
        </defs>
        {[20, 40, 80, 100].map((value) => (
          <circle key={value} cx={cx} cy={cy} r={(r * value) / 100} className={value === 100 ? "ab-radar-ring is-outer" : "ab-radar-ring"} />
        ))}
        <circle cx={cx} cy={cy} r={r * 0.6} className="ab-radar-ring is-pass" />
        {DIMS.map((dim, i) => {
          const end = point(i, 100);
          return <line key={dim.id} x1={cx} y1={cy} x2={end.x} y2={end.y} className="ab-radar-axis" />;
        })}
        {/* 训前测评只测了原来六项：没分的轴断开 */}
        {DIMS.map((dim, i) => {
          const next = DIMS[(i + 1) % count]!;
          const a = baseOf(dim.id);
          const b = baseOf(next.id);
          if (a == null || b == null) return null;
          const p = point(i, a);
          const q = point((i + 1) % count, b);
          return <line key={dim.id} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="ab-radar-base" />;
        })}
        {present.length > 1 ? (
          <polygon
            points={present.map(({ i, v }) => { const p = point(i, v!); return `${p.x},${p.y}`; }).join(" ")}
            className="ab-radar-avg"
            fill="url(#abRadarFill)"
          />
        ) : null}
        {present.map(({ dim, i, v }) => {
          const p = point(i, v!);
          const cls = ["ab-radar-dot", v! < 60 ? "is-lo" : "", hover === i ? "is-hover" : ""].filter(Boolean).join(" ");
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
            <g key={dim.id} className="ab-radar-hit" onMouseEnter={() => setHover(i)}>
              <circle cx={hit.x} cy={hit.y} r={14} fill="transparent" />
              <text x={at.x} y={y} textAnchor={textAnchor} className="ab-radar-name">{dim.label}</text>
              <text x={at.x} y={y + 18} textAnchor={textAnchor}>
                <tspan className={v == null ? "ab-radar-val is-none" : v < 60 ? "ab-radar-val is-lo" : "ab-radar-val"}>{v ?? "—"}</tspan>
                {d != null ? <tspan dx={6} className={d < 0 ? "ab-radar-dl is-down" : "ab-radar-dl"}>{d >= 0 ? "↑" : "↓"}{Math.abs(d)} 较训前</tspan> : null}
              </text>
            </g>
          );
        })}
      </svg>
      {hovered && tipStyle ? (
        <div className="ab-radar-tip" style={tipStyle}>
          <div className="ab-radar-tip-h">
            {hovered.label}
            <b className={hv != null && hv < 60 ? "is-lo" : undefined}>{hv ?? "—"}</b>
            {hd != null ? (
              <span className={hd >= 0 ? "kpi-pill" : "kpi-pill is-down"}>
                {hd >= 0 ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}{Math.abs(hd)} 较训前
              </span>
            ) : null}
          </div>
          <div className="ab-radar-tip-k">定义</div>
          <p className="ab-radar-tip-d">{DIM_DEFINITIONS[hovered.id]}</p>
          <div className="ab-radar-tip-k">建议</div>
          <p className="ab-radar-tip-d">{DIM_TIPS[hovered.id]}</p>
        </div>
      ) : null}
    </div>
  );
}
