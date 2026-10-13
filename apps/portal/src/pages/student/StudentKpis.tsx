import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchStudentSummary, type Session, type StudentSummary } from "../../api/client";
import { KpiCard, RateRing, ScoreGauge } from "../teacher/widgets";
import "../../styles/student-learn.css";

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

/** 学生端“学习区”两页共用的四张关键数字卡（C1）：任务进度、平均分、班级排名、累计对话 */
export function StudentKpis({ session }: { session?: Session | null }) {
  const [summary, setSummary] = useState<StudentSummary | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchStudentSummary(session)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [session]);

  const tasks = summary?.tasks;
  const hasTasks = !!tasks && tasks.total > 0;
  const average = summary?.average ?? null;
  const baseline = summary?.baseline ?? null;
  const rank = summary?.rank;
  const convo = summary?.conversations;
  const taskConvo = convo ? convo.total - convo.practice : 0;

  return (
    <div className="kpi-cards sl-kpis">
      <KpiCard
        label="已完成任务"
        help="老师下发给你的任务里，已经完成的个数。每个任务要接待完要求的场景才算完成。"
        value={hasTasks ? <><b>{tasks!.done}</b><small>/ {tasks!.total}</small></> : null}
        sub={hasTasks ? (tasks!.done >= tasks!.total ? "任务都做完了" : `还有 ${tasks!.total - tasks!.done} 个要完成`) : "老师下发后显示"}
        bar={hasTasks ? tasks!.done / tasks!.total : 0}
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
        value={rank?.position != null ? <><b>第 {rank.position}</b><small>/ {rank.classSize}</small></> : null}
        sub={rank?.position != null ? (rank.change != null ? <DeltaPill value={rank.change} label="较上周" /> : undefined) : rank ? `${rank.classSize} 人` : undefined}
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
