import { GraduationCap, MessageCircleMore, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { MetricCard, PageHeader } from "../../components/AppShell";
import {
  ApiError,
  apiGet,
  fetchConversationMessages,
  type BuyerPublicView,
  type ConversationMessage,
  type Session,
} from "../../api/client";

interface AssessmentRecord {
  id: string;
  conversationId: string;
  scenarioName: string;
  buyer: BuyerPublicView;
  scores: Record<string, number>;
  total: number;
  comment: string;
  suggestions: string[];
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

export function LiveRecords({ session }: { session: Session }) {
  const [data, setData] = useState<AssessmentData | null>(null);
  const [active, setActive] = useState<AssessmentRecord | null>(null);
  const [replay, setReplay] = useState<ConversationMessage[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<AssessmentData>("/v1/student/assessments", session)
      .then(setData)
      .catch((cause) => setError(errorText(cause)));
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

  const records = data?.records ?? [];

  return (
    <div className="page">
      <PageHeader eyebrow="MY RECORDS" title="我的记录" description="六维能力分析、历史成绩与对话复盘。会话结束后自动评分。" />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <section className="metric-grid four">
        <MetricCard label="已评分会话" value={String(records.length)} trend="完成实训并结束会话后生成" icon={MessageCircleMore} tone="green" />
        <MetricCard label="平均分" value={data?.average != null ? String(data.average) : "—"} trend="六维平均" icon={GraduationCap} />
        <MetricCard label="最高分" value={records.length ? String(Math.max(...records.map((r) => r.total))) : "—"} trend="单次会话" icon={Sparkles} tone="amber" />
        <MetricCard label="最近成绩" value={records[0] ? String(records[0].total) : "—"} trend={records[0]?.scenarioName ?? "—"} icon={GraduationCap} tone="coral" />
      </section>

      <div className="classes-layout">
        <section className="panel">
          <div className="panel-heading"><div><h2>能力雷达</h2><p>{records.length ? `${records.length} 次评分平均值` : "暂无数据"}</p></div></div>
          <div className="dimension-list">
            {ASSESSMENT_DIMENSIONS.map((dim) => {
              const value = data?.radar?.[dim.id] ?? 0;
              return (
                <div key={dim.id}>
                  <span>{dim.label}</span>
                  <i><b style={{ width: `${value}%` }} /></i>
                  <strong>{records.length ? value : "—"}</strong>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel data-panel">
          <div className="panel-heading"><div><h2>历史成绩</h2><p>点击查看评语与对话复盘</p></div></div>
          <table>
            <thead><tr><th>场景</th><th>买家</th><th>总分</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td><strong>{record.scenarioName}</strong></td>
                  <td>{record.buyer.name}</td>
                  <td><strong className={record.total >= 80 ? "state-done" : ""}>{record.total}</strong></td>
                  <td>{new Date(record.createdAt).toLocaleString("zh-CN")}</td>
                  <td><button className="text-button" onClick={() => setActive(active?.id === record.id ? null : record)}>{active?.id === record.id ? "收起" : "复盘"}</button></td>
                </tr>
              ))}
              {records.length === 0 ? (
                <tr><td colSpan={5}><span className="muted">暂无评分记录：完成一次对话并在工作台点击「结束会话」后，系统会自动评分。</span></td></tr>
              ) : null}
            </tbody>
          </table>

          {active ? (
            <div className="replay-zone">
              <div className="context-title"><span><Sparkles size={15} /> AI 评语</span><em>总分 {active.total}</em></div>
              <p className="review-text">{active.comment || "（无评语）"}</p>
              <div className="chip-row">
                {ASSESSMENT_DIMENSIONS.map((dim) => (
                  <span key={dim.id} className="chip">{dim.label} {active.scores[dim.id] ?? "—"}</span>
                ))}
              </div>
              {active.suggestions?.length ? (
                <ul className="hint-list">
                  {active.suggestions.map((tip, index) => <li key={index}>{tip}</li>)}
                </ul>
              ) : null}
              <div className="context-title"><span>对话复盘</span></div>
              <div className="replay-list">
                {(replay ?? []).map((message) => (
                  <div key={message.id} className={`replay-line ${message.sender}`}>
                    <em>{message.sender === "buyer" ? active.buyer.name : message.sender === "student" ? "我" : "教师"}</em>
                    <p>{message.content}</p>
                  </div>
                ))}
                {replay === null ? <p className="muted">加载对话…</p> : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
