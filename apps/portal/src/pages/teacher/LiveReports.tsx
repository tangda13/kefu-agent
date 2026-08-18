import { Download, FileSpreadsheet, GraduationCap, ListChecks, Trophy, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { MetricCard, PageHeader } from "../../components/AppShell";
import { ApiError, apiGet, fetchClasses, fetchTeacherTasks, type ClassSummary, type Session, type TeacherTask } from "../../api/client";
import { Histogram, scoreBand, SCORE_BUCKETS } from "./widgets";

interface ReportData {
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
  baselineRadar: Array<{ id: string; label: string; value: number | null }>;
  baselineCount: number;
  ranking: Array<{
    name: string;
    username: string;
    tasks: number;
    sessions: number;
    average: number;
    best: number;
    baseline: number | null;
    dims: Record<string, number | null>;
  }>;
  assessedCount: number;
  studentCount: number;
}

/* 口径：任务 = 考核单位。任务成绩 = 会话均分；综合成绩 = 任务均分；一人一个样本 */
export function LiveReports({ session }: { session: Session }) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classId, setClassId] = useState<string>("");
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [taskId, setTaskId] = useState<string>("");
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchClasses(session).then(setClasses).catch(() => undefined);
    fetchTeacherTasks(session).then(setTasks).catch(() => undefined);
  }, [session]);

  const load = useCallback(() => {
    const query = new URLSearchParams();
    if (classId) query.set("classId", classId);
    if (taskId) query.set("taskId", taskId);
    const suffix = query.toString();
    apiGet<ReportData>(`/v1/teacher/reports${suffix ? `?${suffix}` : ""}`, session)
      .then(setData)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "无法连接服务器。"));
  }, [session, classId, taskId]);

  useEffect(() => {
    load();
  }, [load]);

  function exportExcel() {
    if (!data) return;
    const className = classes.find((item) => item.id === classId)?.name ?? "全部班级";
    const rows = data.ranking.map((row, index) => ({
      排名: index + 1,
      姓名: row.name,
      账号: row.username,
      已评任务: row.tasks,
      已评会话: row.sessions,
      初始测评: row.baseline ?? "—",
      综合成绩: row.average,
      较初始提升: row.baseline != null ? row.average - row.baseline : "—",
      最高任务分: row.best,
      ...Object.fromEntries(ASSESSMENT_DIMENSIONS.map((dim) => [dim.label, row.dims[dim.id] ?? "—"])),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "成绩排名");
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        SCORE_BUCKETS.map((label, index) => ({ 分数段: label, 人次: data.distribution[index] ?? 0 })),
      ),
      "成绩分布",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(data.radar.map((dim) => ({ 能力维度: dim.label, 平均分: dim.value ?? "—" }))),
      "能力雷达",
    );
    XLSX.writeFile(workbook, `考核报表-${className}-${new Date().toLocaleDateString("zh-CN")}.xlsx`);
  }

  const summary = useMemo(() => {
    if (!data) return null;
    const total = data.distribution.reduce((sum, value) => sum + value, 0);
    const good = (data.distribution[3] ?? 0) + (data.distribution[4] ?? 0);
    const pass = total - (data.distribution[0] ?? 0);
    return {
      assessed: data.assessedCount,
      students: data.studentCount,
      average: data.ranking.length
        ? Math.round(data.ranking.reduce((sum, row) => sum + row.average, 0) / data.ranking.length)
        : null,
      passRate: total > 0 ? Math.round((pass / total) * 100) : null,
      goodRate: total > 0 ? Math.round((good / total) * 100) : null,
    };
  }, [data]);

  return (
    <div className="page report-page">
      <PageHeader
        title="考核报表"
        description="以任务为考核单位：任务成绩 = 会话均分，综合成绩 = 各任务成绩平均；自由练习不计入。"
        actions={
          <>
            <select className="report-class-select" value={classId} onChange={(event) => setClassId(event.target.value)} aria-label="班级筛选">
              <option value="">全部班级</option>
              {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <select className="report-class-select" value={taskId} onChange={(event) => setTaskId(event.target.value)} aria-label="任务筛选">
              <option value="">全部任务（综合成绩）</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name}{task.status === "closed" ? "（已结束）" : ""}
                </option>
              ))}
            </select>
            <button className="secondary-button" onClick={exportExcel} disabled={!data || data.ranking.length === 0}>
              <FileSpreadsheet size={16} /> 导出 Excel
            </button>
            <button className="primary-button" onClick={() => window.print()} disabled={!data}>
              <Download size={16} /> 导出 PDF
            </button>
          </>
        }
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <section className="metric-grid four print-block">
        <MetricCard
          label="参评学生"
          value={summary ? String(summary.students) : "—"}
          trend="至少完成一个任务评分的学生"
          icon={UsersRound}
        />
        <MetricCard
          label="已评会话"
          value={summary ? String(summary.assessed) : "—"}
          trend="过程数据：任务下的会话评分次数"
          icon={ListChecks}
          tone="green"
        />
        <MetricCard
          label={taskId ? "任务平均分" : "综合平均分"}
          value={summary?.average != null ? String(summary.average) : "—"}
          trend="按学生平均（每人等权）"
          icon={GraduationCap}
          tone="amber"
        />
        <MetricCard
          label="及格率 / 优良率"
          value={summary?.passRate != null ? `${summary.passRate}%` : "—"}
          trend={summary?.goodRate != null ? `80 分以上学生占 ${summary.goodRate}%` : "暂无评分数据"}
          icon={Trophy}
          tone="coral"
        />
      </section>

      <div className="tt-overview-grid print-block">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>班级成绩分布</h2>
              <p>{taskId ? "该任务成绩分布" : "综合成绩分布"} · 每名学生计一个成绩 · 共 {data?.studentCount ?? 0} 人</p>
            </div>
          </div>
          <Histogram
            distribution={data?.distribution ?? [0, 0, 0, 0, 0]}
            emptyHint="学生完成实训任务并评分后，成绩分布会汇总到这里（自由练习不计入）。"
          />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>全班能力对比</h2>
              <p>
                {data && data.baselineCount > 0
                  ? `训前基线（${data.baselineCount} 人已测评） vs 当前六维平均`
                  : "六个评分维度平均值（学生完成初始测评后显示训前对比）"}
              </p>
            </div>
          </div>
          <div className="tch-cmp">
            {(data?.radar ?? []).map((dim) => {
              const base = data?.baselineRadar.find((item) => item.id === dim.id)?.value ?? null;
              const diff = dim.value != null && base != null ? dim.value - base : null;
              return (
                <div key={dim.id} className="tch-cmp-row">
                  <span className="tch-cmp-label">{dim.label}</span>
                  <div className="tch-cmp-bars">
                    <i className="cur"><b style={{ width: `${dim.value ?? 0}%` }} /></i>
                    {base != null ? <i className="base"><b style={{ width: `${base}%` }} /></i> : null}
                  </div>
                  <strong>{dim.value ?? "—"}</strong>
                  <small>{base != null ? `初始 ${base}` : "—"}</small>
                  {diff != null ? (
                    <span className={diff > 0 ? "rec-delta up" : diff < 0 ? "rec-delta down" : "rec-delta"}>
                      {diff > 0 ? `+${diff}` : diff < 0 ? String(diff) : "±0"}
                    </span>
                  ) : <span className="rec-delta tch-cmp-empty">—</span>}
                </div>
              );
            })}
          </div>
          {data && data.baselineCount > 0 ? (
            <div className="tch-cmp-legend"><span><i className="cur" /> 当前平均</span><span><i className="base" /> 初始测评基线</span></div>
          ) : null}
        </section>
      </div>

      <section className="panel data-panel print-block">
        <div className="panel-heading">
          <div>
            <h2>学生成绩排名</h2>
            <p>{taskId ? "按该任务成绩排序" : "按综合成绩排序（综合 = 各任务成绩平均）"} · 含六维均值与训前对比</p>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>排名</th><th>学生</th><th>任务</th><th>会话</th><th>初始</th><th>{taskId ? "任务成绩" : "综合成绩"}</th><th>提升</th><th>最高任务分</th>
              {ASSESSMENT_DIMENSIONS.map((dim) => <th key={dim.id}>{dim.label.slice(0, 4)}</th>)}
            </tr>
          </thead>
          <tbody>
            {(data?.ranking ?? []).map((row, index) => {
              const gain = row.baseline != null ? row.average - row.baseline : null;
              const band = scoreBand(row.average);
              return (
                <tr key={row.username}>
                  <td><span className={`rank-number rank-${Math.min(index + 1, 4)}`}>{index + 1}</span></td>
                  <td>
                    <span className="student-cell">
                      <span className="avatar small">{row.name[0]}</span>
                      <span><strong>{row.name}</strong><small>{row.username}</small></span>
                    </span>
                  </td>
                  <td>{row.tasks}</td>
                  <td>{row.sessions}</td>
                  <td>{row.baseline ?? "—"}</td>
                  <td>
                    <span className="tt-total-cell">
                      <strong>{row.average}</strong>
                      <em className={`rec-band ${band.cls}`}>{band.label}</em>
                    </span>
                  </td>
                  <td>
                    {gain != null ? (
                      <span className={gain > 0 ? "rec-delta up" : gain < 0 ? "rec-delta down" : "rec-delta"}>
                        {gain > 0 ? `+${gain}` : gain < 0 ? String(gain) : "±0"}
                      </span>
                    ) : "—"}
                  </td>
                  <td>{row.best}</td>
                  {ASSESSMENT_DIMENSIONS.map((dim) => <td key={dim.id}>{row.dims[dim.id] ?? "—"}</td>)}
                </tr>
              );
            })}
            {data && data.ranking.length === 0 ? (
              <tr><td colSpan={14}><span className="muted">暂无评分数据：学生完成实训任务、会话结束并评分后自动生成（自由练习不计入）。</span></td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
