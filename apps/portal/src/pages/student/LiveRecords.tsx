import { ArrowDown, ArrowUp, ChartLine, MessageSquareDashed, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  /** 自由练习：保留 AI 反馈供复盘，但不计入平均分/走势/六项聚合 */
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

/** 六项能力的显示顺序（同设计稿，和合同里的顺序不同） */
const DIM_ORDER = ["professionalism", "effectiveness", "empathy", "resolution", "grammar", "compliance"];
const DIMS = DIM_ORDER.map((id) => ASSESSMENT_DIMENSIONS.find((dim) => dim.id === id)!).filter(Boolean);

/** 最弱两项下面的一行建议 */
const DIM_TIPS: Record<string, string> = {
  professionalism: "按“问候、确认问题、给方案、约定下一步”的顺序组织回复",
  effectiveness: "先回应买家最关心的问题，再补充说明；一条消息只讲一件事",
  empathy: "买家不满时先共情再给方案：I completely understand… / I'm so sorry…",
  resolution: "给出能执行的方案（补发 / 退款 / 折扣），写清时限和步骤",
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

const RADAR = { w: 560, h: 480, cx: 280, cy: 240, r: 168 };

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
  const dims = ASSESSMENT_DIMENSIONS;
  const count = dims.length;
  const polygon = (scores: Record<string, number>) =>
    dims.map((dim, i) => { const p = radarPoint(i, count, scores[dim.id] ?? 0); return `${p.x},${p.y}`; }).join(" ");
  return (
    <div className={compact ? "rec-radar compact" : "rec-radar"}>
      <svg viewBox={`0 0 ${RADAR.w} ${RADAR.h}`} role="img" aria-label="六项能力雷达图">
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

/* ---------- 六项能力：一条横条 ---------- */

function AbilityRow({ name, value, base, tip }: { name: string; value: number | null; base: number | null; tip?: string }) {
  const delta = value != null && base != null ? value - base : null;
  const low = value != null && value < 60;
  return (
    <div className="sl-abr">
      <span className="sl-abr-nm">{name}</span>
      <div className={value == null ? "sl-abr-bt is-empty" : "sl-abr-bt"}>
        {value != null ? <i className={low ? "is-lo" : undefined} style={{ width: `${value}%` }} /> : null}
        {base != null ? <em style={{ left: `${base}%` }} title={`训前测评 ${base}`} /> : null}
      </div>
      <span className={low ? "sl-abr-val is-lo" : "sl-abr-val"}>{value ?? <span className="sl-abr-dash">—</span>}</span>
      {delta != null ? (
        <span className={delta >= 0 ? "kpi-pill" : "kpi-pill is-down"}>
          {delta >= 0 ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}{Math.abs(delta)} 较训前
        </span>
      ) : <span />}
      {tip ? <div className="sl-abr-tip">{tip}</div> : null}
    </div>
  );
}

/* ---------- 成绩走势：任务接待的分数折线，虚线是达标线，低于达标线的点标红 ---------- */

const TREND = { w: 320, h: 235, left: 26, right: 14, top: 12, bottom: 24, min: 20 };

function TrendChart({ chrono, passLine, onPick }: { chrono: AssessmentRecord[]; passLine: number; onPick: (record: AssessmentRecord) => void }) {
  const plotW = TREND.w - TREND.left - TREND.right;
  const plotH = TREND.h - TREND.top - TREND.bottom;
  const x = (i: number) => (chrono.length <= 1 ? TREND.left + plotW / 2 : TREND.left + (plotW * i) / (chrono.length - 1));
  const y = (value: number) => TREND.top + plotH * (1 - (Math.max(TREND.min, Math.min(100, value)) - TREND.min) / (100 - TREND.min));
  const labelAt = chrono.length <= 6 ? chrono.map((_, i) => i) : [...new Set([0, 1, 2, 3, 4, 5].map((t) => Math.round(((chrono.length - 1) * t) / 5)))];
  const empty = chrono.length === 0;
  const placeholder = [0, 1, 2, 3, 4, 5].map((i) => `${TREND.left + (plotW * i) / 5},${y(60)}`).join(" ");
  return (
    <svg className="sl-trend-svg" viewBox={`0 0 ${TREND.w} ${TREND.h}`} role="img" aria-label="成绩走势">
      {[40, 60, 80, 100].map((value) => (
        <g key={value}>
          <line x1={TREND.left - 4} x2={TREND.w - TREND.right} y1={y(value)} y2={y(value)} stroke="#eef1f5" />
          <text x={0} y={y(value) + 3.5} fontSize={10} fill="#9aa3b0">{value}</text>
        </g>
      ))}
      <line x1={TREND.left - 4} x2={TREND.w - TREND.right} y1={y(passLine)} y2={y(passLine)} stroke="var(--c-ink)" strokeDasharray="3 3" />
      <text x={TREND.w - TREND.right} y={y(passLine) - 4} fontSize={10} fill="var(--c-ink-2)" textAnchor="end">达标线 {passLine}</text>
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
              r={3.5}
              fill="#fff"
              stroke={record.passScore != null && record.total < record.passScore ? "var(--c-danger)" : "var(--c-brand)"}
              strokeWidth={2}
              onClick={() => onPick(record)}
            >
              <title>{record.total} 分 · {record.taskName ?? record.scenarioName} · {dateLabel(record.createdAt)}</title>
            </circle>
          ))}
          {labelAt.map((i) => (
            <text key={chrono[i]!.id} x={x(i)} y={TREND.h - 6} fontSize={10} fill="#9aa3b0" textAnchor={i === 0 ? "start" : i === chrono.length - 1 ? "end" : "middle"}>{dateLabel(chrono[i]!.createdAt)}</text>
          ))}
        </>
      )}
    </svg>
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

export function LiveRecords({ session, onOpenHall }: { session: Session; onOpenHall?: () => void }) {
  const [data, setData] = useState<AssessmentData | null>(null);
  const [active, setActive] = useState<AssessmentRecord | null>(null);
  const [replay, setReplay] = useState<ConversationMessage[] | null>(null);
  const [range, setRange] = useState<RangeKey>("all");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [error, setError] = useState("");
  const [baseline, setBaseline] = useState<BaselineResult | null>(null);

  useEffect(() => {
    apiGet<AssessmentData>("/v1/student/assessments", session)
      .then(setData)
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
  /* 计分口径：自由练习只在记录里展示，走势和六项能力只统计任务接待 */
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
      out[dim.id] = Math.round(scoped.reduce((sum, record) => sum + (record.scores[dim.id] ?? 0), 0) / scoped.length);
    }
    return out;
  }, [scoped]);

  /* 最弱的两项（低于 75 才给建议） */
  const weakIds = useMemo(() => {
    if (!scoped.length) return new Set<string>();
    return new Set(
      [...DIMS]
        .map((dim) => ({ id: dim.id, value: scopedAverage[dim.id] ?? 0 }))
        .filter((item) => item.value < 75)
        .sort((a, b) => a.value - b.value)
        .slice(0, 2)
        .map((item) => item.id),
    );
  }, [scoped, scopedAverage]);

  const passLine = chrono.length ? (chrono[chrono.length - 1]!.passScore ?? 60) : 60;

  const taskCount = records.filter((record) => !record.practice).length;
  const practiceCount = records.length - taskCount;
  const teacherCount = records.filter((record) => record.teacherComment).length;
  const visibleRecords = records.filter((record) =>
    filter === "task" ? !record.practice : filter === "practice" ? !!record.practice : filter === "teacher" ? !!record.teacherComment : true,
  );

  const abilityCount = scoped.length
    ? `${scoped.length} 次接待的平均`
    : baseline ? `训前测评 ${baseline.total} 分` : "";
  const noData = scoped.length === 0;

  const legend = (
    <div className="sl-legend">
      <span><i />近期平均</span>
      <span><em />训前测评</span>
    </div>
  );

  return (
    <Bench className="sl-page">
      {error ? <p className="sl-form-error" role="alert">{error}</p> : null}
      <StudentKpis session={session} />

      <div className="sl-two">
        <Board
          className="sl-rel"
          title="六项能力"
          count={abilityCount || undefined}
          extra={
            <>
              {scoredRecords.length ? <Segmented<RangeKey> items={RANGE_OPTIONS} value={range} onChange={setRange} /> : null}
              {legend}
            </>
          }
        >
          <div className="sl-ab">
            {DIMS.map((dim) => (
              <AbilityRow
                key={dim.id}
                name={dim.label}
                value={noData ? null : scopedAverage[dim.id] ?? null}
                base={baseline?.scores[dim.id] ?? null}
                tip={!noData && weakIds.has(dim.id) ? DIM_TIPS[dim.id] : undefined}
              />
            ))}
          </div>
          {noData ? (
            <div className="sl-hint">
              <MessageSquareDashed size={18} aria-hidden="true" />
              {scoredRecords.length ? "这段时间没有任务接待，换个时间范围看看" : "完成第一次接待后，这里出现你的六项能力"}
              <HelpTip>蓝条是接待成绩的平均，黑竖线是训前测评，两者对比就是你的进步；低于 60 分的蓝条会变红。</HelpTip>
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
        title="成绩记录"
        count={records.length}
        extra={
          records.length ? (
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
              <div className="sl-mini" aria-label="六项得分">
                {DIMS.map((dim) => {
                  const score = record.scores[dim.id] ?? 0;
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
                <h3 className="rec-side-title">六项得分 · 对比平均</h3>
                <div className="rec-dim-rows">
                  {DIMS.map((dim) => {
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
    </Bench>
  );
}
