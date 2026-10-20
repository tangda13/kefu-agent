import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchStudentSummary, type Session, type StudentSummary } from "../../api/client";
import { KpiCard, RateRing, ScoreGauge } from "../teacher/widgets";
import "../../styles/student-learn.css";

/* 学生学习区的两排关键数字（设计稿 docs/design/p15-params-student）：
   - 任务大厅（D-52，参数原文四项）：已完成任务、平均分、班级排名、累计对话
   - 我的记录（D-53）：本周接待、达标率、平均响应时长、满意率 */

/** 变化胶囊：正数绿色上箭头，负数红色下箭头 */
function DeltaPill({ value, label }: { value: number; label: string }) {
  const Icon = value >= 0 ? ArrowUp : ArrowDown;
  return (
    <>
      <span className={value >= 0 ? "kpi-pill" : "kpi-pill is-down"}><Icon size={12} aria-hidden="true" />{Math.abs(value)}</span>
      {label}
    </>
  );
}

/** 班级排名小柱图：名次越靠前，高亮的柱越靠右；没有名次时全灰 */
function RankBars({ position, total }: { position: number | null; total: number }) {
  const bars = 9;
  const hit = position == null || total <= 0 ? -1 : Math.min(bars - 1, Math.floor((1 - position / total) * bars));
  return (
    <svg className="sl-rank" viewBox="0 0 92 52" aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => {
        const height = 10 + index * 4.5;
        return <rect key={index} x={index * 10 + 1} y={50 - height} width={7} height={height} rx={1.5} fill={index === hit ? "var(--c-brand)" : "#e6ebf2"} />;
      })}
    </svg>
  );
}

const WEEK_LABELS = "一二三四五六日";

/** 本周七天柱图：今天高亮，没有接待的日子画一道灰线 */
function WeekBars({ daily, today }: { daily: number[]; today: number }) {
  const max = Math.max(1, ...daily);
  return (
    <svg className="sl-week" viewBox="0 0 126 58" aria-hidden="true">
      {daily.map((count, index) => {
        const height = count ? 6 + Math.round((count / max) * 30) : 2;
        const isToday = index === today;
        return (
          <g key={index}>
            <rect x={index * 18 + 2} y={40 - height} width={11} height={height} rx={2} fill={isToday ? "var(--c-brand)" : count ? "#bfd2f3" : "#e3e7ee"}>
              <title>周{WEEK_LABELS[index]} {count} 次</title>
            </rect>
            <text x={index * 18 + 7.5} y={55} fontSize={10} textAnchor="middle" fill={isToday ? "var(--c-brand-ink)" : "#9aa3b0"}>{WEEK_LABELS[index]}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** 响应时长刻度条：45 秒内（满分区）、2 分钟起偏慢；黑色三角是平均值 */
function ResponseBar({ seconds }: { seconds: number | null }) {
  const width = 132;
  const max = 180;
  const x = (value: number) => Math.min(width, (value / max) * width);
  return (
    <svg className="sl-resp" viewBox={`0 0 ${width} 44`} aria-hidden="true">
      <rect x={0} y={16} width={x(45) - 1} height={8} rx={2} fill="#cfe9da" />
      <rect x={x(45) + 1} y={16} width={x(120) - x(45) - 2} height={8} fill="#f6e3c3" />
      <rect x={x(120) + 1} y={16} width={width - x(120) - 1} height={8} rx={2} fill="#f5d2cf" />
      {seconds != null ? <path d={`M${x(seconds).toFixed(1)} 13 l-5 -8 h10 z`} fill="var(--c-ink)" /> : null}
      <text x={x(45)} y={38} fontSize={10} textAnchor="middle" fill="#9aa3b0">45 秒</text>
      <text x={x(120)} y={38} fontSize={10} textAnchor="middle" fill="#9aa3b0">2 分</text>
    </svg>
  );
}

/** 星级分布：5 星到 1 星各一条，算满意的 4、5 星用品牌蓝 */
function StarHistogram({ counts }: { counts: number[] | null }) {
  const max = Math.max(1, ...(counts ?? [0]));
  return (
    <svg className="sl-stars" viewBox="0 0 112 60" aria-hidden="true">
      {[5, 4, 3, 2, 1].map((star, index) => {
        const count = counts ? counts[index] ?? 0 : 0;
        const y = index * 12;
        const width = counts ? Math.round((count / max) * 70) : 0;
        return (
          <g key={star}>
            <text x={0} y={y + 9} fontSize={10} fill="var(--c-ink-3)">{star}</text>
            <text x={8} y={y + 9} fontSize={9} fill="#f2b01e">★</text>
            <rect x={20} y={y + 2} width={70} height={7} rx={2} fill="#edf0f4" />
            {width ? <rect x={20} y={y + 2} width={width} height={7} rx={2} fill={star >= 4 ? "var(--c-brand)" : "#c3cad5"} /> : null}
            {counts ? <text x={96} y={y + 9} fontSize={10} fill="#9aa3b0">{count}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

function durationText(seconds: number): { value: number; unit: string } {
  return seconds < 120 ? { value: seconds, unit: "秒" } : { value: Math.round(seconds / 60), unit: "分钟" };
}

function useSummary(session?: Session | null): StudentSummary | null {
  const [summary, setSummary] = useState<StudentSummary | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchStudentSummary(session)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [session]);
  return summary;
}

/** 任务大厅四张卡（D-52）：已完成任务、平均分、班级排名、累计对话 */
export function HallKpis({ session }: { session?: Session | null }) {
  const summary = useSummary(session);
  const tasks = summary?.tasks;
  const average = summary?.average ?? null;
  const baseline = summary?.baseline ?? null;
  const rank = summary?.rank;
  const convo = summary?.conversations;
  const taskConvo = convo ? convo.total - convo.practice : 0;
  return (
    <div className="kpi-cards sl-kpis sl-hall-kpis">
      <KpiCard
        label="已完成任务"
        help="老师下发给你的任务里，已经完成的个数。"
        value={tasks && tasks.total > 0 ? <><b>{tasks.done}</b><small>/ {tasks.total}</small></> : null}
        bar={tasks && tasks.total > 0 ? tasks.done / tasks.total : 0}
      />
      <KpiCard
        label="平均分"
        help="只算任务接待的综合分，自由练习不计入。“较训前”是和训前测评总分的差。"
        value={average != null ? <><b>{average}</b><small>/ 100</small></> : null}
        sub={average != null && baseline != null ? <DeltaPill value={average - baseline} label="较训前" /> : undefined}
        chart={<ScoreGauge value={average} />}
      />
      <KpiCard
        label="班级排名"
        help="按任务接待的平均分在班里排名。“较上周”是名次的变化，向上的箭头表示名次上升。"
        value={rank?.position != null ? <><b>第 {rank.position}</b><small>/ {rank.classSize}</small></> : rank ? <><b className="is-dash">—</b><small>/ {rank.classSize}</small></> : null}
        sub={rank?.position != null && rank.change != null ? <DeltaPill value={rank.change} label="较上周" /> : undefined}
        chart={<RankBars position={rank?.position ?? null} total={rank?.classSize ?? 0} />}
      />
      <KpiCard
        label="累计对话"
        help="你接待过的买家会话总数，圆环是其中任务接待所占的比例，其余是自由练习。"
        value={<><b className={convo && convo.total > 0 ? undefined : "is-dash"}>{convo?.total ?? 0}</b><small>次</small></>}
        sub={convo && convo.total > 0 ? `共 ${convo.rounds} 轮 · 其中练习 ${convo.practice} 次` : undefined}
        chart={<RateRing value={convo && convo.total > 0 ? Math.round((taskConvo / convo.total) * 100) : null} color="var(--c-cat-2)" />}
      />
    </div>
  );
}

/** 我的记录四张卡（D-53）：本周接待、达标率、平均响应时长、满意率 */
export function RecordKpis({ session }: { session?: Session | null }) {
  const summary = useSummary(session);
  const pass = summary?.pass;
  const passRate = pass && pass.assessed > 0 ? Math.round((pass.passed / pass.assessed) * 100) : null;
  const daily = summary?.weekDaily ?? [0, 0, 0, 0, 0, 0, 0];
  const today = summary?.todayIndex ?? (new Date().getDay() + 6) % 7;
  const week = summary?.weekConversations ?? 0;
  const response = summary?.response;
  const avg = response?.avgSeconds != null ? durationText(response.avgSeconds) : null;
  const first = response?.firstSeconds != null ? durationText(response.firstSeconds) : null;
  const rating = summary?.rating;
  return (
    <div className="kpi-cards sl-kpis sl-record-kpis">
      <KpiCard
        label="本周接待"
        help="本周（周一起）接待的买家次数，含自由练习；柱子是每天的次数，蓝色是今天。"
        value={<><b className={week > 0 ? undefined : "is-dash"}>{week}</b><small>次</small></>}
        sub={summary && summary.weekPractice > 0 ? `其中练习 ${summary.weekPractice} 次` : undefined}
        chart={<WeekBars daily={daily} today={today} />}
      />
      <KpiCard
        label="达标率"
        help="任务接待里分数达到该任务达标线（老师没设时按 60 分）的次数占比，自由练习不计入。"
        value={passRate != null ? <b>{passRate}%</b> : null}
        sub={pass && pass.assessed > 0 ? `${pass.assessed} 次任务接待 ${pass.passed} 次达标` : undefined}
        chart={<RateRing value={passRate} color="var(--c-ok)" />}
      />
      <KpiCard
        label="平均响应时长"
        help="买家发消息后到你回复的平均等待时间，统计全部接待（含自由练习）。45 秒内最好，超过 2 分钟买家会开始催；一次等了 10 分钟以上的按 10 分钟算（买家这时早已离开）。"
        value={avg ? <><b>{avg.value}</b><small>{avg.unit}</small></> : null}
        sub={first ? `首次响应平均 ${first.value} ${first.unit}` : undefined}
        chart={<ResponseBar seconds={response?.avgSeconds ?? null} />}
      />
      <KpiCard
        label="满意率"
        help="接待结束时，买家给服务打 4 星或 5 星的次数占比，统计全部接待（含自由练习）。"
        value={rating && rating.rate != null ? <b>{rating.rate}%</b> : null}
        sub={rating && rating.total > 0 ? <><span className="sl-star-mark">★</span>{rating.average} · {rating.total} 次评价</> : undefined}
        chart={<StarHistogram counts={rating && rating.total > 0 ? rating.counts : null} />}
      />
    </div>
  );
}
