import { CheckCircle2, GraduationCap, MessageCircleMore, Sparkles, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { MetricCard, PageHeader } from "../../components/AppShell";
import { ApiError, apiGet, type Session } from "../../api/client";

interface Overview {
  activeStudents: number;
  totalStudents: number;
  totalMessages: number;
  completionRate: number | null;
  averageScore: number | null;
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
  weakDimensions: Array<{ id: string; label: string; value: number | null }>;
}

const BUCKETS = ["<60", "60–70", "70–80", "80–90", "90+"];

export function LiveOverview({ session }: { session: Session }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<Overview>("/v1/teacher/overview", session)
      .then(setData)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "无法连接服务器。"));
  }, [session]);

  const maxBucket = Math.max(1, ...(data?.distribution ?? [1]));

  return (
    <div className="page">
      <PageHeader eyebrow="TEACHING OVERVIEW" title="数据总览" description="授权班级的参训、完成与能力全貌（实时数据）。" />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="metric-grid four">
        <MetricCard label="参训人数" value={data ? `${data.activeStudents}` : "—"} trend={data ? `班级共 ${data.totalStudents} 人` : ""} icon={UsersRound} />
        <MetricCard label="任务完成率" value={data?.completionRate != null ? String(data.completionRate) : "—"} suffix={data?.completionRate != null ? "%" : ""} trend="按任务进度统计" icon={CheckCircle2} tone="green" />
        <MetricCard label="平均分" value={data?.averageScore != null ? String(data.averageScore) : "—"} trend="六维评分平均" icon={GraduationCap} tone="amber" />
        <MetricCard label="对话总数" value={data ? String(data.totalMessages) : "—"} trend="全部实训消息" icon={MessageCircleMore} tone="coral" />
      </section>

      <div className="classes-layout">
        <section className="panel">
          <div className="panel-heading"><div><h2>班级成绩分布</h2><p>已评分会话的总分分布</p></div></div>
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
          {data && data.weakDimensions.length > 0 ? (
            <div className="insight-note">
              <Sparkles size={17} />
              <p>能力薄弱项：{data.weakDimensions.map((dim) => `${dim.label}（${dim.value}）`).join("、")}。建议针对性增加对应场景训练。</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
