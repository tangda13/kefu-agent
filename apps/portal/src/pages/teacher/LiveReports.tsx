import { Download, FileSpreadsheet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { PageHeader } from "../../components/AppShell";
import { ApiError, apiGet, fetchClasses, type ClassSummary, type Session } from "../../api/client";

interface ReportData {
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
  ranking: Array<{
    name: string;
    username: string;
    sessions: number;
    average: number;
    best: number;
    dims: Record<string, number | null>;
  }>;
  assessedCount: number;
}

const BUCKETS = ["<60", "60–70", "70–80", "80–90", "90+"];

export function LiveReports({ session }: { session: Session }) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [classId, setClassId] = useState<string>("");
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchClasses(session).then(setClasses).catch(() => undefined);
  }, [session]);

  const load = useCallback(() => {
    apiGet<ReportData>(`/v1/teacher/reports${classId ? `?classId=${classId}` : ""}`, session)
      .then(setData)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "无法连接服务器。"));
  }, [session, classId]);

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
      已评会话: row.sessions,
      平均分: row.average,
      最高分: row.best,
      ...Object.fromEntries(ASSESSMENT_DIMENSIONS.map((dim) => [dim.label, row.dims[dim.id] ?? "—"])),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "成绩排名");
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        BUCKETS.map((label, index) => ({ 分数段: label, 人次: data.distribution[index] ?? 0 })),
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

  const maxBucket = Math.max(1, ...(data?.distribution ?? [1]));

  return (
    <div className="page report-page">
      <PageHeader
        eyebrow="ASSESSMENT REPORT"
        title="考核报表"
        description="班级成绩分布、六维能力雷达与学生成绩排名。"
        actions={
          <>
            <select className="report-class-select" value={classId} onChange={(event) => setClassId(event.target.value)}>
              <option value="">全部班级</option>
              {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
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
      <div className="classes-layout print-block">
        <section className="panel">
          <div className="panel-heading"><div><h2>班级成绩分布</h2><p>共 {data?.assessedCount ?? 0} 次评分</p></div></div>
          <div className="large-bars">
            {(data?.distribution ?? [0, 0, 0, 0, 0]).map((value, index) => (
              <div key={index}>
                <span>{value}</span>
                <i style={{ height: `${Math.round((value / maxBucket) * 140) + 4}px` }} />
                <small>{BUCKETS[index]}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>全班能力雷达</h2><p>六个评分维度平均值</p></div></div>
          <div className="dimension-list">
            {(data?.radar ?? []).map((dim) => (
              <div key={dim.id}>
                <span>{dim.label}</span>
                <i><b style={{ width: `${dim.value ?? 0}%` }} /></i>
                <strong>{dim.value ?? "—"}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel data-panel print-block">
        <div className="panel-heading"><div><h2>学生成绩排名</h2><p>按平均分排序（含六维均值）</p></div></div>
        <table>
          <thead>
            <tr>
              <th>排名</th><th>学生</th><th>已评会话</th><th>平均分</th><th>最高分</th>
              {ASSESSMENT_DIMENSIONS.map((dim) => <th key={dim.id}>{dim.label.slice(0, 4)}</th>)}
            </tr>
          </thead>
          <tbody>
            {(data?.ranking ?? []).map((row, index) => (
              <tr key={row.username}>
                <td><span className={`rank-number rank-${Math.min(index + 1, 4)}`}>{index + 1}</span></td>
                <td><strong>{row.name}</strong><small>{row.username}</small></td>
                <td>{row.sessions}</td>
                <td><strong className={row.average >= 80 ? "state-done" : ""}>{row.average}</strong></td>
                <td>{row.best}</td>
                {ASSESSMENT_DIMENSIONS.map((dim) => <td key={dim.id}>{row.dims[dim.id] ?? "—"}</td>)}
              </tr>
            ))}
            {data && data.ranking.length === 0 ? (
              <tr><td colSpan={11}><span className="muted">暂无评分数据：学生完成实训并结束会话后自动生成。</span></td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
