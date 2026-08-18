import { CheckCircle2, GraduationCap, MessageCircleMore, Radar, Sparkles, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { MetricCard, PageHeader } from "../../components/AppShell";
import { ApiError, apiGet, fetchTeacherTasks, type Session, type TeacherTask } from "../../api/client";
import { Histogram, RadarChart } from "./widgets";

interface Overview {
  activeStudents: number;
  totalStudents: number;
  totalMessages: number;
  completionRate: number | null;
  averageScore: number | null;
  scoredStudents: number;
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
  weakDimensions: Array<{ id: string; label: string; value: number | null }>;
}

/* 口径：任务 = 考核单位。任务成绩 = 任务下已评会话均分；
   「全部任务综合」= 每名学生各任务成绩的平均，一人一个样本；自由练习不参与统计。 */
export function LiveOverview({ session }: { session: Session }) {
  const [data, setData] = useState<Overview | null>(null);
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetchTeacherTasks(session).then(setTasks).catch(() => undefined);
  }, [session]);

  useEffect(() => {
    apiGet<Overview>(`/v1/teacher/overview${taskId ? `?taskId=${taskId}` : ""}`, session)
      .then(setData)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "无法连接服务器。"));
  }, [session, taskId]);

  const radar = data?.radar ?? [];
  const hasRadar = radar.some((dim) => dim.value != null);
  const weakIds = new Set((data?.weakDimensions ?? []).map((dim) => dim.id));
  const taskName = tasks.find((task) => task.id === taskId)?.name ?? null;
  const scopeLabel = taskId
    ? `任务「${taskName ?? "已选任务"}」：每名学生一个任务成绩`
    : "全部任务综合：每名学生 = 各任务成绩的平均分";

  return (
    <div className="page">
      <PageHeader
        title="数据总览"
        description="授权班级的参训、完成与能力全貌；成绩统计以任务为考核单位，一人一个样本。"
        actions={
          <select className="report-class-select" value={taskId} onChange={(event) => setTaskId(event.target.value)} aria-label="考核范围">
            <option value="">全部任务（综合成绩）</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.name}{task.status === "closed" ? "（已结束）" : ""}
              </option>
            ))}
          </select>
        }
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="metric-grid four">
        <MetricCard
          label="参训人数"
          value={data ? `${data.activeStudents}` : "—"}
          trend={data ? `班级共 ${data.totalStudents} 人，${data.activeStudents} 人已开始实训` : ""}
          icon={UsersRound}
        />
        <MetricCard
          label="任务完成率"
          value={data?.completionRate != null ? String(data.completionRate) : "—"}
          suffix={data?.completionRate != null ? "%" : ""}
          trend={data?.completionRate != null ? "按已下发任务的学生进度统计" : "下发任务后开始统计"}
          icon={CheckCircle2}
          tone="green"
        />
        <MetricCard
          label={taskId ? "任务平均分" : "综合平均分"}
          value={data?.averageScore != null ? String(data.averageScore) : "—"}
          trend={
            data?.averageScore != null
              ? `${data.scoredStudents} 名学生计入 · 每人等权`
              : "学生完成任务并评分后生成"
          }
          icon={GraduationCap}
          tone="amber"
        />
        <MetricCard
          label="对话总数"
          value={data ? String(data.totalMessages) : "—"}
          trend="全部实训会话消息累计（含自由练习）"
          icon={MessageCircleMore}
          tone="coral"
        />
      </section>

      <div className="tt-overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>班级成绩分布</h2>
              <p>{scopeLabel}{data && data.scoredStudents > 0 ? ` · 共 ${data.scoredStudents} 人` : ""}</p>
            </div>
          </div>
          <Histogram
            distribution={data?.distribution ?? [0, 0, 0, 0, 0]}
            emptyHint={taskId ? "该任务还没有学生完成评分；学生完成任务会话并评分后汇总到这里。" : "学生完成实训任务并评分后，班级成绩分布会实时汇总到这里（自由练习不计入）。"}
          />
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>全班能力雷达</h2>
              <p>六个评分维度按学生平均，薄弱项自动标记</p>
            </div>
          </div>
          {hasRadar ? (
            <>
              <div className="tt-radar-split">
                <div><RadarChart dims={radar} /></div>
                <div className="tt-dim-rows">
                  {radar.map((dim) => (
                    <div key={dim.id} className="tt-dim-row">
                      <span>{dim.label}</span>
                      <span className={weakIds.has(dim.id) ? "rec-bar warn" : "rec-bar"}>
                        <b style={{ width: `${dim.value ?? 0}%` }} />
                      </span>
                      <strong>{dim.value ?? "—"}</strong>
                      {weakIds.has(dim.id)
                        ? <em className="rec-band warn">薄弱</em>
                        : <em className="rec-band tt-dim-pad">—</em>}
                    </div>
                  ))}
                </div>
              </div>
              {data && data.weakDimensions.length > 0 ? (
                <div className="insight-note tt-panel-foot">
                  <Sparkles size={17} />
                  <p>
                    能力薄弱项：{data.weakDimensions.map((dim) => `${dim.label}（${dim.value}）`).join("、")}。
                    建议在「实训任务」中针对性提高对应维度权重，并增加相关场景训练。
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="tt-empty">
              <Radar size={26} aria-hidden="true" />
              <strong>暂无能力数据</strong>
              <p>学生完成实训任务并产生六维评分后，这里会汇总全班能力雷达与薄弱项分析。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
