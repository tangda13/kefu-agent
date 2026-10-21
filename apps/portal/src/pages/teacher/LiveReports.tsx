import { ArrowDown, ArrowUp, Download, FileSpreadsheet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { ApiError, apiGet, fetchClassStudents, fetchClasses, fetchTeacherTasks, type ClassStudent, type ClassSummary, type Session, type TeacherTask } from "../../api/client";
import { AbilityRadar } from "../../components/AbilityRadar";
import { Bench, Board, Button, Callout, DataTable, FilterChips, HelpTip, Select, toast } from "../../ui";
import { ChartEmptyNote, openReplayFor, ScoreDistribution, SCORE_BUCKETS, takeReportTask } from "./widgets";

interface RankingEntry {
  name: string;
  username: string;
  tasks: number;
  sessions: number;
  average: number;
  best: number;
  baseline: number | null;
  dims: Record<string, number | null>;
  /** 买家服务评价 4–5 星占比（D-60，只算任务里的聊天接待）；没有评价为 null */
  satisfaction: { rated: number; rate: number } | null;
}

interface ReportData {
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
  baselineRadar: Array<{ id: string; label: string; value: number | null }>;
  baselineCount: number;
  ranking: RankingEntry[];
  assessedCount: number;
  studentCount: number;
}

/* D-60：“需要关注的学生”并进成绩排名，名字后面写原因；还没有成绩的学生排在最后 */
type Reason = "low" | "down" | "none";
const REASONS: Array<{ id: Reason; label: string; tone: "danger" | "warn" }> = [
  { id: "low", label: "低于 60 分", tone: "danger" },
  { id: "down", label: "比训前退步", tone: "danger" },
  { id: "none", label: "还没有成绩", tone: "warn" },
];

interface RankRow {
  key: string;
  rank: number | null;
  name: string;
  username: string;
  reasons: Reason[];
  entry: RankingEntry | null;
  /** 还没有成绩的学生：最近练习、从没登录过 */
  lastActiveAt: string | null;
  neverLoggedIn: boolean;
}

function weakest(dims: Record<string, number | null>): { label: string; value: number } | null {
  const worst = ASSESSMENT_DIMENSIONS.map((dim) => ({ label: dim.label, value: dims[dim.id] })).filter((dim) => dim.value != null).sort((a, b) => a.value! - b.value!)[0];
  return worst ? { label: worst.label, value: worst.value! } : null;
}

function noScoreText(row: RankRow): string {
  if (row.lastActiveAt) return "练过，还没有评分";
  return row.neverLoggedIn ? "从没登录过" : "还没练过";
}

const reasonLabel = (reason: Reason) => REASONS.find((item) => item.id === reason)!.label;

const RANK_COLUMNS = (byTask: boolean, onNavigate?: (page: string) => void) => [
  { key: "rank", title: "#", width: 48, render: (row: RankRow) => <span className="num muted">{row.rank ?? "—"}</span> },
  {
    key: "name", title: "学生",
    render: (row: RankRow) => (
      <>
        <span className="cell-title">{row.name}{row.reasons.map((reason) => <span key={reason} className={`ui-tag is-${REASONS.find((item) => item.id === reason)!.tone} rank-reason`}>{reasonLabel(reason)}</span>)}</span>
        <span className="cell-meta">{row.username}</span>
      </>
    ),
  },
  {
    key: "avg", title: byTask ? "成绩" : "综合成绩", width: 100, align: "right" as const,
    render: (row: RankRow) => row.entry ? <span className={row.entry.average < 60 ? "strong-num is-bad" : "strong-num"}>{row.entry.average}</span> : <span className="faint">—</span>,
  },
  {
    key: "gain", title: "较训前", width: 90, align: "right" as const,
    render: (row: RankRow) => {
      if (!row.entry || row.entry.baseline == null) return <span className="faint">—</span>;
      const diff = row.entry.average - row.entry.baseline;
      return <span className={diff > 0 ? "delta is-up" : diff < 0 ? "delta is-down" : "delta"}>{diff > 0 ? `+${diff}` : diff === 0 ? "持平" : diff}</span>;
    },
  },
  {
    key: "satisfaction", title: "满意率", width: 100, align: "right" as const,
    render: (row: RankRow) => row.entry?.satisfaction
      ? <span className="rank-sat"><b>{row.entry.satisfaction.rate}%</b><small>{row.entry.satisfaction.rated} 次评价</small></span>
      : <span className="faint">—</span>,
  },
  { key: "count", title: "任务 / 接待", width: 110, align: "right" as const, render: (row: RankRow) => <span className="num">{row.entry ? `${row.entry.tasks} / ${row.entry.sessions}` : "0 / 0"}</span> },
  {
    key: "weak", title: "最弱一项", width: 170,
    render: (row: RankRow) => {
      if (!row.entry) return <span className="rank-none">{noScoreText(row)}</span>;
      const worst = weakest(row.entry.dims);
      return worst ? <span>{worst.label} <span className={worst.value < 60 ? "strong-num is-bad" : "muted"}>{worst.value}</span></span> : <span className="faint">—</span>;
    },
  },
  {
    key: "ops", title: "", width: 90, align: "right" as const,
    render: (row: RankRow) => row.entry
      ? <Button size="sm" variant="ghost" onClick={() => { openReplayFor(row.name); onNavigate?.("tracking"); }}>看回放</Button>
      : <Button size="sm" variant="ghost" onClick={() => onNavigate?.("classes")}>去班级</Button>,
  },
];

/* 考核报表（D-60，设计稿 docs/design/p17-params-teacher 第四节）：按参数只放成绩分布、全班能力雷达、成绩排名，支持导出 Excel / PDF。
   口径：任务 = 考核单位。任务成绩 = 会话均分；综合成绩 = 任务均分；一人一个样本；自由练习不计入 */
export function LiveReports({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classId, setClassId] = useState<string>("");
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [taskId, setTaskId] = useState<string>(() => takeReportTask());
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");
  const [roster, setRoster] = useState<ClassStudent[]>([]);
  const [filter, setFilter] = useState<"all" | Reason>("all");

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

  const rows = useMemo<RankRow[]>(() => {
    const ranking = data?.ranking ?? [];
    const scored = new Set(ranking.map((row) => row.username));
    return [
      ...ranking.map((entry, index): RankRow => ({
        key: entry.username,
        rank: index + 1,
        name: entry.name,
        username: entry.username,
        reasons: [
          ...(entry.average < 60 ? ["low" as const] : []),
          ...(entry.baseline != null && entry.average < entry.baseline ? ["down" as const] : []),
        ],
        entry,
        lastActiveAt: null,
        neverLoggedIn: false,
      })),
      ...roster
        .filter((student) => student.status === "active" && !scored.has(student.username))
        .map((student): RankRow => ({
          key: student.username,
          rank: null,
          name: student.displayName,
          username: student.username,
          reasons: ["none"],
          entry: null,
          lastActiveAt: student.lastActiveAt,
          neverLoggedIn: student.mustChangePassword && !student.lastActiveAt,
        })),
    ];
  }, [data, roster]);

  const counts = useMemo(() => {
    const result = { low: 0, down: 0, none: 0 } as Record<Reason, number>;
    rows.forEach((row) => row.reasons.forEach((reason) => { result[reason] += 1; }));
    return result;
  }, [rows]);
  const shown = filter === "all" ? rows : rows.filter((row) => row.reasons.includes(filter));

  const className = classes.find((item) => item.id === classId)?.name ?? "全部班级";
  const taskName = tasks.find((task) => task.id === taskId)?.name ?? null;

  function exportExcel() {
    if (!data) return;
    const sheetRows = rows.map((row) => ({
      排名: row.rank ?? "—",
      姓名: row.name,
      账号: row.username,
      关注原因: row.reasons.map(reasonLabel).join("、") || "—",
      已评任务: row.entry?.tasks ?? 0,
      已评会话: row.entry?.sessions ?? 0,
      初始测评: row.entry?.baseline ?? "—",
      综合成绩: row.entry?.average ?? "—",
      较初始提升: row.entry && row.entry.baseline != null ? row.entry.average - row.entry.baseline : "—",
      最高任务分: row.entry?.best ?? "—",
      满意率: row.entry?.satisfaction ? `${row.entry.satisfaction.rate}%` : "—",
      评价次数: row.entry?.satisfaction?.rated ?? 0,
      ...Object.fromEntries(ASSESSMENT_DIMENSIONS.map((dim) => [dim.label, row.entry?.dims[dim.id] ?? "—"])),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sheetRows), "成绩排名");
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(SCORE_BUCKETS.map((label, index) => ({ 分数段: label, 人数: data.distribution[index] ?? 0 }))),
      "成绩分布",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(data.radar.map((dim) => ({ 能力维度: dim.label, 平均分: dim.value ?? "—" }))),
      "能力雷达",
    );
    XLSX.writeFile(workbook, `考核报表-${className}-${new Date().toLocaleDateString("zh-CN")}.xlsx`);
  }

  /* 一分两率：平均分（较训前）、及格率、优良率，都从成绩分布算 */
  const summary = useMemo(() => {
    if (!data) return null;
    const total = data.distribution.reduce((sum, value) => sum + value, 0);
    const good = (data.distribution[3] ?? 0) + (data.distribution[4] ?? 0);
    const pass = total - (data.distribution[0] ?? 0);
    const withBaseline = data.ranking.filter((row) => row.baseline != null);
    return {
      average: data.ranking.length ? Math.round(data.ranking.reduce((sum, row) => sum + row.average, 0) / data.ranking.length) : null,
      gain: withBaseline.length ? Math.round(withBaseline.reduce((sum, row) => sum + row.average - row.baseline!, 0) / withBaseline.length) : null,
      passRate: total > 0 ? Math.round((pass / total) * 100) : null,
      goodRate: total > 0 ? Math.round((good / total) * 100) : null,
      pass,
      good,
    };
  }, [data]);

  const radarValues = useMemo(() => {
    const scored = (data?.radar ?? []).filter((dim) => dim.value != null);
    return scored.length ? Object.fromEntries(scored.map((dim) => [dim.id, dim.value!])) : null;
  }, [data]);
  const baseline = useMemo(() => {
    if (!data?.baselineCount) return null;
    return Object.fromEntries(data.baselineRadar.filter((dim) => dim.value != null).map((dim) => [dim.id, dim.value!]));
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
          <Button variant="ghost" icon={FileSpreadsheet} disabled={!rows.length} onClick={exportExcel}>导出 Excel</Button>
          <Button variant="primary" icon={Download} disabled={!data} onClick={() => void exportPdf()}>导出 PDF</Button>
        </div>
      </div>
      <h1 className="print-only report-title">{className} · {taskName ?? "全部任务综合"} · 考核报表</h1>
      {error ? <Callout tone="danger" title="读取失败">{error}</Callout> : null}

      <div className="duo">
        <Board title={<>成绩分布<HelpTip>每个学生一个综合成绩（各任务成绩的平均），按分数段统计人数；虚线是全班平均分</HelpTip></>} count={hasData ? `${data!.studentCount} 人` : undefined}>
          <dl className="dist-stats">
            <div>
              <dt>{taskId ? "任务平均分" : "平均分"}<HelpTip>每个学生先算综合成绩，再求全班平均；自由练习不计入。“较训前”是做过训前测评的学生，综合成绩比训前测评总分高多少的平均</HelpTip></dt>
              <dd>
                {summary?.average != null ? summary.average : <span className="is-dash">—</span>}
                {summary?.average != null && summary.gain != null ? (
                  <span className={summary.gain < 0 ? "kpi-pill is-down" : "kpi-pill"}>{summary.gain < 0 ? <ArrowDown size={12} /> : <ArrowUp size={12} />}{Math.abs(summary.gain)} 较训前</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>及格率<HelpTip>综合成绩 60 分及以上的学生，占有成绩学生的比例</HelpTip></dt>
              <dd>{summary?.passRate != null ? <>{summary.passRate}%<small>{summary.pass} 人</small></> : <span className="is-dash">—</span>}</dd>
            </div>
            <div>
              <dt>优良率<HelpTip>综合成绩 80 分及以上的学生，占有成绩学生的比例</HelpTip></dt>
              <dd>{summary?.goodRate != null ? <>{summary.goodRate}%<small>{summary.good} 人</small></> : <span className="is-dash">—</span>}</dd>
            </div>
          </dl>
          <ScoreDistribution distribution={data?.distribution ?? [0, 0, 0, 0, 0]} average={summary?.average ?? null} emptyNote={<ChartEmptyNote desc="学生完成接待后出现" />} />
        </Board>
        <Board
          title={<>全班能力雷达<HelpTip>{data?.baselineCount ? "全班每一项的平均分；虚线是训前测评。悬停看每一项的定义和建议" : "全班每一项的平均分。悬停看每一项的定义和建议"}</HelpTip></>}
          count={hasData ? `${data!.studentCount} 人的平均` : undefined}
        >
          <AbilityRadar values={radarValues} base={baseline} valueLabel="全班平均" />
        </Board>
      </div>

      <Board
        title={<>成绩排名<HelpTip>{taskId ? "按这个任务的成绩排" : "按综合成绩排"}；名字后面是需要关注的原因，红色数字就是原因所在的那一格；还没有成绩的学生排在最后。满意率只算任务里的接待。完整的各项分数在“导出 Excel”里</HelpTip></>}
        extra={rows.length ? (
          <FilterChips
            value={filter}
            onChange={setFilter}
            items={[{ id: "all" as const, label: "全部", count: rows.length }, ...REASONS.map((item) => ({ id: item.id, label: item.label, count: counts[item.id] }))]}
          />
        ) : undefined}
      >
        {rows.length ? (
          <DataTable rows={shown} rowKey={(row) => row.key} columns={RANK_COLUMNS(Boolean(taskId), onNavigate)} empty="这一类没有学生" />
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
