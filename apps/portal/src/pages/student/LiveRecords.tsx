import { ChartLine, MessageSquareDashed, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ASSESSMENT_DIMENSIONS, type ReceptionStats } from "@cecs/contracts";
import { BuyerAvatar } from "../../components/BuyerAvatar";
import { AbilityRadar, DIM_TIPS, useBoxSize } from "../../components/AbilityRadar";
import {
  ApiError,
  apiGet,
  fetchBaselineStatus,
  fetchConversationMessages,
  fetchMailReplies,
  type BaselineResult,
  type BuyerPublicView,
  type ConversationMessage,
  type Session,
} from "../../api/client";
import { Bench, Board, Button, FilterChips, HelpTip, Segmented } from "../../ui";
import { RecordKpis } from "./StudentKpis";
import { MessageBody, ServiceRatingLine, isCardKind, mediaUrl } from "./workbench/shared";
import "../../styles/student-workbench.css";
import "../../styles/student-learn.css";
import { ReceptionGrid } from "../../components/ReceptionStats";

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
  /** 邮件任务（D-58）：复盘里看这封邮件；不评客户情绪安抚、消息响应时效 */
  channel?: "chat" | "mail";
  /** 买家服务评价 1–5 星（D-54） */
  serviceRating?: number | null;
  /** 复盘“本次接待”（D-61）；邮件记录为空 */
  reception?: ReceptionStats | null;
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

/* ---------- 复盘消息渲染：和工作台用同一个消息体（商品卡、订单卡、语音、图片、工具卡片），回放看到的和当时一样 ---------- */

function ReplayBody({ message, onPlayVoice }: { message: ConversationMessage; onPlayVoice: (url: string) => void }) {
  if (!message.kind || message.kind === "text") return <p className="rec-bubble">{message.content}</p>;
  // 卡片类不套气泡；语音在气泡里（播放条 + 转写）
  return isCardKind(message)
    ? <div className="rec-rich"><MessageBody message={message} onPlayVoice={onPlayVoice} /></div>
    : <div className="rec-bubble"><MessageBody message={message} onPlayVoice={onPlayVoice} /></div>;
}

/** 邮件任务复盘（D-58）：左边是这封邮件，买家回了信就接在下面 */
function MailReplay({ messages, replyText }: { messages: ConversationMessage[] | null; replyText: { at: string; body: string } | null }) {
  const mail = messages?.find((message) => message.kind === "mail")?.payload as
    | { subject?: string; body?: string; to?: string | null; toName?: string | null; violations?: string[] }
    | undefined;
  if (messages === null) return <p className="muted rec-chat-hint">加载邮件…</p>;
  if (!mail) return <p className="muted rec-chat-hint">这封邮件没有可显示的内容。</p>;
  const violations = mail.violations ?? [];
  return (
    <div className="rec-mail">
      <dl className="rec-mail-kv">
        <dt>收件人</dt><dd>{mail.toName ?? "—"}{mail.to ? <span className="muted"> &lt;{mail.to}&gt;</span> : null}</dd>
      </dl>
      <h4>{mail.subject}</h4>
      <div className="rec-mail-body">{mail.body}</div>
      {violations.length > 0
        ? <p className="rec-mail-chk is-bad"><ShieldAlert size={14} aria-hidden="true" />发送时检测到违规用语：{violations.join("、")}</p>
        : <p className="rec-mail-chk"><ShieldCheck size={14} aria-hidden="true" />发送时检测：没有违规用语</p>}
      {replyText ? (
        <div className="rec-mail-reply">
          <b>买家回信 · {new Date(replyText.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</b>
          <p>{replyText.body}</p>
        </div>
      ) : null}
    </div>
  );
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

/* ---------- 成绩走势：任务接待的分数折线，虚线是达标线，低于达标线的点标红 ---------- */

const TREND = { left: 32, right: 16, top: 16, bottom: 28, min: 20 };

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
  /** 邮件复盘：这封邮件的买家回信 */
  const [mailReply, setMailReply] = useState<{ at: string; body: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playVoice = (url: string) => {
    audioRef.current?.pause();
    const audio = new Audio(mediaUrl(url));
    audioRef.current = audio;
    void audio.play();
  };
  useEffect(() => () => audioRef.current?.pause(), []);
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
    setReplay(null);
    setMailReply(null);
    fetchConversationMessages(session, active.conversationId)
      .then((rows) => {
        setReplay(rows);
        const submissionId = rows.find((row) => row.kind === "mail")?.payload?.submissionId;
        if (active.channel === "mail" && typeof submissionId === "string") {
          fetchMailReplies(session)
            .then((replies) => {
              const hit = replies.find((item) => item.submissionId === submissionId);
              if (hit) setMailReply({ at: hit.createdAt, body: hit.body });
            })
            .catch(() => undefined);
        }
      })
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
      <RecordKpis session={session} />

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
                <b>{record.taskName ?? "自由练习"}{record.channel === "mail" ? <span className="sl-tag is-mail">邮件</span> : null}</b>
                <div className="sl-rr-m2">
                  {record.scenarioName} · {record.channel === "mail" ? `发给 ${record.buyer.name}` : record.buyer.name} · {rowTime(record.createdAt)}
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
              {active.channel === "mail" ? (
                <div className="rec-chat">
                  <div className="rec-chat-day">邮件</div>
                  <MailReplay messages={replay} replyText={mailReply} />
                </div>
              ) : (
              <div className="rec-chat">
                <div className="rec-chat-day">对话回放{replay ? ` · ${replay.length} 条消息` : ""}</div>
                {(replay ?? []).map((message) =>
                  message.sender === "teacher" ? (
                    <div key={message.id} className="rec-note">教师指导 · {message.content}</div>
                  ) : (
                    <div key={message.id} className={message.sender === "student" ? "rec-msg me" : "rec-msg"}>
                      {message.sender === "buyer" ? <BuyerAvatar buyer={active.buyer} size="tiny" /> : null}
                      <div>
                        <ReplayBody message={message} onPlayVoice={playVoice} />
                        <small>{message.sender === "student" ? "我 · " : ""}{timeOf(message.createdAt)}</small>
                      </div>
                    </div>
                  ),
                )}
                {replay && replay.length > 0 && active.serviceRating ? <ServiceRatingLine stars={active.serviceRating} /> : null}
                {replay === null ? <p className="muted rec-chat-hint">加载对话…</p> : null}
                {replay?.length === 0 ? <p className="muted rec-chat-hint">该会话没有可显示的消息。</p> : null}
              </div>
              )}
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
                {active.reception ? (
                  <>
                    <h3 className="rec-side-title">本次接待<HelpTip>这一次接待的数据。工作台顶栏和上面四张卡里的满意率、平均响应时长、3 分钟回复率、累计对话，就是每一次加起来的，自由练习也算在内；分数类的数字只算任务。</HelpTip></h3>
                    <ReceptionGrid stats={active.reception} />
                  </>
                ) : null}
                <h3 className="rec-side-title">各项得分 · 对比平均</h3>
                <div className="rec-dim-rows">
                  {DIMS.map((dim) => {
                    const score = active.scores[dim.id];
                    if (score == null) {
                      // 邮件不评客户情绪安抚、消息响应时效（D-58）；老记录没有新增两项（D-46）
                      const na = active.channel === "mail";
                      return (
                        <div key={dim.id} className={na ? "rec-dim-row is-na" : "rec-dim-row"}>
                          <span>{dim.label}</span>
                          <i className="rec-bar" />
                          <strong className="muted">—</strong>
                          <span className="muted">{na ? "不适用" : ""}</span>
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
