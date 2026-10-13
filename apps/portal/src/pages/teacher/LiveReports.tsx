import { ArrowDown, ArrowUp, Download, FileSpreadsheet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { ApiError, apiGet, fetchClassStudents, fetchClasses, fetchTeacherTasks, type ClassStudent, type ClassSummary, type Session, type TeacherTask } from "../../api/client";
import { Bench, Board, Button, Callout, DataTable, HelpTip, Select, toast } from "../../ui";
import { AttentionBoard } from "./AttentionBoard";
import { ChartEmptyNote, DimensionBars, KpiCard, RateRing, ScoreDistribution, ScoreGauge, SCORE_BUCKETS, takeReportTask } from "./widgets";


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

const RANK_COLUMNS = (ranking: ReportData["ranking"], byTask: boolean) => [
  { key: "rank", title: "#", width: 48, render: (row: ReportData["ranking"][number]) => <span className="num muted">{ranking.indexOf(row) + 1}</span> },
  { key: "name", title: "学生", render: (row: ReportData["ranking"][number]) => <><span className="cell-title">{row.name}</span><span className="cell-meta">{row.username}</span></> },
  { key: "avg", title: byTask ? "成绩" : "综合成绩", width: 100, align: "right" as const, render: (row: ReportData["ranking"][number]) => <span className={row.average < 60 ? "strong-num is-bad" : "strong-num"}>{row.average}</span> },
  {
    key: "gain", title: "较训前", width: 90, align: "right" as const,
    render: (row: ReportData["ranking"][number]) => {
      if (row.baseline == null) return <span className="faint">—</span>;
      const diff = row.average - row.baseline;
      return <span className={diff > 0 ? "delta is-up" : diff < 0 ? "delta is-down" : "delta"}>{diff > 0 ? `+${diff}` : diff === 0 ? "持平" : diff}</span>;
    },
  },
  { key: "count", title: "任务 / 接待", width: 110, align: "right" as const, render: (row: ReportData["ranking"][number]) => <span className="num">{row.tasks} / {row.sessions}</span> },
  {
    key: "weak", title: "最弱一项", width: 160,
    render: (row: ReportData["ranking"][number]) => {
      const worst = ASSESSMENT_DIMENSIONS.map((dim) => ({ label: dim.label, value: row.dims[dim.id] })).filter((dim) => dim.value != null).sort((a, b) => a.value! - b.value!)[0];
      return worst ? <span>{worst.label} <span className={worst.value! < 60 ? "strong-num is-bad" : "muted"}>{worst.value}</span></span> : <span className="faint">—</span>;
    },
  },
];

/* 口径：任务 = 考核单位。任务成绩 = 会话均分；综合成绩 = 任务均分；一人一个样本 */
export function LiveReports({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classId, setClassId] = useState<string>("");
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [taskId, setTaskId] = useState<string>(() => takeReportTask());
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [roster, setRoster] = useState<ClassStudent[]>([]);

  /* 名单：用来找“还没有成绩”的学生 */
  useEffect(() => {
    const ids = classId ? [classId] : classes.map((item) => item.id);
    if (!ids.length) return setRoster([]);
    Promise.all(ids.map((id) => fetchClassStudents(session, id))).then((lists) => setRoster(lists.flat())).catch(() => setRoster([]));
  }, [session, classId, classes]);

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
      average: data.ranking.length ? Math.round(data.ranking.reduce((sum, row) => sum + row.average, 0) / data.ranking.length) : null,
      passRate: total > 0 ? Math.round((pass / total) * 100) : null,
      goodRate: total > 0 ? Math.round((good / total) * 100) : null,
    };
  }, [data]);

  const className = classes.find((item) => item.id === classId)?.name ?? "全部班级";
  const taskName = tasks.find((task) => task.id === taskId)?.name ?? null;
  const baseline = useMemo(() => Object.fromEntries((data?.baselineRadar ?? []).map((dim) => [dim.id, dim.value])), [data]);
  const weak = useMemo(() => {
    const scored = (data?.radar ?? []).filter((dim) => dim.value != null).sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
    return new Set(scored.slice(0, 2).map((dim) => dim.id));
  }, [data]);

  /* D10：客户端里直接存成 PDF 文件；浏览器里退回系统打印（可选“另存为 PDF”） */
  async function exportPdf() {
    const fileName = `考核报表-${className}${taskName ? `-${taskName}` : ""}-${new Date().toLocaleDateString("zh-CN").replace(/\//g, "-")}`;
    if (window.desktopRuntime?.savePdf) {
      try {
        const result = await window.desktopRuntime.savePdf({ fileName, landscape: true });
        if (result.ok) toast.ok(`已保存到 ${result.filePath}`);
      } catch {
        toast.error("导出失败，请重试");
      }
      return;
    }
    window.print();
  }

  const hasData = Boolean(data && data.ranking.length > 0);

  const withBaseline = (data?.ranking ?? []).filter((row) => row.baseline != null);
  const gain = withBaseline.length ? Math.round(withBaseline.reduce((sum, row) => sum + row.average - row.baseline!, 0) / withBaseline.length) : null;
  const activeRoster = roster.filter((row) => row.status === "active").length;
  const scoredCount = data?.studentCount ?? 0;
  const passCount = data ? data.distribution.reduce((sum, value) => sum + value, 0) - (data.distribution[0] ?? 0) : 0;
  const goodCount = data ? (data.distribution[3] ?? 0) + (data.distribution[4] ?? 0) : 0;

  return (
    <Bench className="report-sheet">
      <div className="bench-bar">
        <Select className="toolbar-select" value={classId} onChange={(event) => setClassId(event.target.value)} aria-label="班级">
          <option value="">全部班级</option>
          {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <Select className="toolbar-select" value={taskId} onChange={(event) => setTaskId(event.target.value)} aria-label="任务">
          <option value="">全部任务综合</option>
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.name}{task.status === "closed" ? "（已结束）" : ""}</option>)}
        </Select>
        <div className="bench-bar-end">
          <Button variant="ghost" icon={FileSpreadsheet} disabled={!hasData} onClick={exportExcel}>导出 Excel</Button>
          <Button variant="primary" icon={Download} disabled={!data} onClick={() => void exportPdf()}>导出 PDF</Button>
        </div>
      </div>
      <h1 className="print-only report-title">{className} · {taskName ?? "全部任务综合"} · 考核报表</h1>
      {error ? <Callout tone="danger" title="读取失败">{error}</Callout> : null}

      {/* 关键数字卡片（D-31）：每个数配一个一眼能读懂的小图；没数据时只画灰色底圈 */}
      <div className="kpi-cards">
        <KpiCard
          label={taskId ? "任务平均分" : "平均分"}
          help="每个学生先算一个综合成绩（各任务成绩的平均），再求全班平均；自由练习不计入"
          value={summary?.average != null ? <><b>{summary.average}</b><small>/ 100</small></> : null}
          sub={summary?.average != null && gain != null ? <><span className={gain < 0 ? "kpi-pill is-down" : "kpi-pill"}>{gain < 0 ? <ArrowDown size={12} /> : <ArrowUp size={12} />}{Math.abs(gain)}</span>较训前</> : null}
          chart={<ScoreGauge value={summary?.average ?? null} />}
        />
        <KpiCard
          label="及格率"
          help="综合成绩 60 分及以上的学生，占有成绩学生的比例"
          value={summary?.passRate != null ? <b>{summary.passRate}%</b> : null}
          sub={summary?.passRate != null ? `${scoredCount} 人里 ${passCount} 人及格` : null}
          chart={<RateRing value={summary?.passRate ?? null} />}
        />
        <KpiCard
          label="优良率"
          help="综合成绩 80 分及以上的学生，占有成绩学生的比例"
          value={summary?.goodRate != null ? <b>{summary.goodRate}%</b> : null}
          sub={summary?.goodRate != null ? `${goodCount} 人 80 分以上` : null}
          chart={<RateRing value={summary?.goodRate ?? null} color="var(--c-cat-2)" />}
        />
        <KpiCard
          label="参评学生"
          help="已经有成绩的学生 / 班里在用的学生"
          value={<><b>{scoredCount}</b><small>/ {activeRoster} 人</small></>}
          bar={activeRoster ? scoredCount / activeRoster : 0}
        />
      </div>

      <AttentionBoard
        ranking={data?.ranking ?? []}
        roster={roster}
        hasBaseline={Boolean(data?.baselineCount)}
        scopeName={className}
        onNavigate={onNavigate}
      />

      <div className="duo">
        <Board title={<>成绩分布<HelpTip>每个学生一个综合成绩，按分数段统计人数</HelpTip></>} count={hasData ? `${data!.studentCount} 人` : undefined}>
          <ScoreDistribution distribution={data?.distribution ?? [0, 0, 0, 0, 0]} emptyNote={<ChartEmptyNote desc="学生完成接待后出现" />} />
        </Board>
        <Board title={<>六项能力<HelpTip>{data?.baselineCount ? "全班每一项的平均分，红色是最弱的两项；竖线是训前测评" : "全班每一项的平均分，红色是最弱的两项"}</HelpTip></>}>
          <DimensionBars
            dims={data?.radar?.length ? data.radar : ASSESSMENT_DIMENSIONS.map((dim) => ({ id: dim.id, label: dim.label, value: null }))}
            weak={hasData ? weak : undefined}
            baseline={data?.baselineCount ? baseline : undefined}
            emptyNote={<ChartEmptyNote desc="学生完成接待后出现" />}
          />
        </Board>
      </div>
      <Board title={<>成绩排名<HelpTip>{taskId ? "按这个任务的成绩排" : "按综合成绩排"}；完整的六项分数在“导出 Excel”里</HelpTip></>}>
        {hasData ? (
          <DataTable
            rows={data!.ranking}
            rowKey={(row) => row.username}
            columns={RANK_COLUMNS(data!.ranking, Boolean(taskId))}
          />
        ) : (
          <div className="rank-ghost">
            <div className="rank-ghost-head"><span>名次</span><span>学生</span><span>综合成绩</span><span>较训前</span><span>最弱一项</span></div>
            {[0, 1, 2].map((index) => <div key={index} className="rank-ghost-row"><i style={{ width: 24 }} /><i style={{ width: 120 }} /><i style={{ width: 40 }} /><i style={{ width: 36 }} /><i style={{ width: 100 }} /></div>)}
            <ChartEmptyNote desc="学生完成接待后出现" />
          </div>
        )}
      </Board>
    </Bench>
  );
}
