import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import {
  ApiError,
  fetchBaselineQuestions,
  submitBaseline,
  type BaselineQuestion,
  type BaselineResult,
  type Session,
} from "../../api/client";

const KIND_LABELS: Record<BaselineQuestion["kind"], string> = {
  single: "单选题",
  multi: "多选题",
  judge: "判断题",
  practical: "实操题",
};

function bandOf(score: number): { label: string; cls: string } {
  if (score >= 85) return { label: "优秀", cls: "good" };
  if (score >= 70) return { label: "良好", cls: "fine" };
  if (score >= 60) return { label: "合格", cls: "warn" };
  return { label: "待提升", cls: "risk" };
}

type AnswerMap = Record<string, string | string[]>;

function isAnswered(question: BaselineQuestion, answers: AnswerMap): boolean {
  const answer = answers[question.id];
  if (question.kind === "practical") return typeof answer === "string" && answer.trim().length >= 10;
  if (question.kind === "multi") return Array.isArray(answer) && answer.length > 0;
  return typeof answer === "string" && answer.length > 0;
}

/* 结果页评分环（亮面） */
function ResultRing({ value }: { value: number }) {
  const SIZE = 136;
  const STROKE = 9;
  const r = (SIZE - STROKE) / 2 - 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="bq-ring" role="img" aria-label={`总分 ${value}`}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <defs>
          <linearGradient id="bqRingGrad" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#0066cc" />
            <stop offset="100%" stopColor="#64d2ff" />
          </linearGradient>
        </defs>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={r} fill="none" stroke="#ececf0" strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          stroke="url(#bqRingGrad)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${(c * pct) / 100} ${c}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <strong>{value}</strong>
    </div>
  );
}

export function BaselineQuiz({ session, onClose, onCompleted }: {
  session: Session;
  onClose: () => void;
  onCompleted: (result: BaselineResult) => void;
}) {
  const [questions, setQuestions] = useState<BaselineQuestion[] | null>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BaselineResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchBaselineQuestions(session)
      .then((data) => setQuestions(data.questions))
      .catch(() => setError("测评题目加载失败，请关闭后重试。"));
  }, [session]);

  const question = questions?.[index] ?? null;
  const answeredCount = useMemo(
    () => (questions ?? []).filter((item) => isAnswered(item, answers)).length,
    [questions, answers],
  );
  const total = questions?.length ?? 0;
  const isLast = total > 0 && index === total - 1;

  const pick = (optionId: string) => {
    if (!question) return;
    if (question.kind === "multi") {
      const current = Array.isArray(answers[question.id]) ? (answers[question.id] as string[]) : [];
      const next = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
      setAnswers({ ...answers, [question.id]: next });
    } else {
      setAnswers({ ...answers, [question.id]: optionId });
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const graded = await submitBaseline(session, answers);
      setResult(graded);
      onCompleted(graded);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "提交失败，请检查网络后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    const band = bandOf(result.total);
    return (
      <div className="bq-overlay" onClick={onClose}>
        <div className="bq-modal result" role="dialog" aria-modal="true" aria-label="测评结果" onClick={(event) => event.stopPropagation()}>
          <div className="bq-result">
            <span className="bq-result-badge"><Check size={22} aria-hidden="true" /></span>
            <h2>初始测评完成</h2>
            <p className="bq-result-sub">这是你的六维能力基线，已写入能力档案。之后每次实训成绩都会与它对照，在「我的记录」中可以看到初始与当前能力的雷达对比。</p>
            <div className="bq-result-total">
              <ResultRing value={result.total} />
              <span className={`rec-band big ${band.cls}`}>{band.label}</span>
            </div>
            <div className="bq-result-rows">
              {ASSESSMENT_DIMENSIONS.map((dim) => {
                const score = result.scores[dim.id] ?? 0;
                const dimBand = bandOf(score);
                return (
                  <div key={dim.id} className="bq-result-row">
                    <span>{dim.label}</span>
                    <i className={`rec-bar ${dimBand.cls}`}><b style={{ width: `${score}%` }} /></i>
                    <strong>{score}</strong>
                    <span className={`rec-band ${dimBand.cls}`}>{dimBand.label}</span>
                  </div>
                );
              })}
            </div>
            <button className="primary-button" onClick={onClose}>开始实训之旅</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bq-overlay">
      <div className="bq-modal" role="dialog" aria-modal="true" aria-label="初始能力测评" onClick={(event) => event.stopPropagation()}>
        <aside className="bq-rail">
          <div className="bq-rail-head">
            <strong>初始能力测评</strong>
            <p>完成 10 道题，生成你的六维能力基线。之后每次实训都会与基线对照。</p>
          </div>
          <div className="bq-nav" role="group" aria-label="题目导航">
            {(questions ?? []).map((item, i) => {
              const done = isAnswered(item, answers);
              const cls = i === index ? "bq-cell current" : done ? "bq-cell done" : "bq-cell";
              return (
                <button key={item.id} type="button" className={cls} onClick={() => setIndex(i)} aria-label={`第 ${i + 1} 题${done ? "（已作答）" : ""}`}>
                  {done && i !== index ? <Check size={13} aria-hidden="true" /> : i + 1}
                </button>
              );
            })}
          </div>
          <div className="bq-rail-foot">
            <span>{answeredCount}/{total || "—"} 已作答</span>
            <small>中途退出不保存</small>
          </div>
        </aside>

        <div className="bq-main">
          <header className="bq-head">
            {question ? <span className="bq-kind">{KIND_LABELS[question.kind]}</span> : null}
            <span className="bq-step">第 {total ? index + 1 : "—"} 题 / 共 {total || 10} 题</span>
            <button className="icon-button" onClick={onClose} aria-label="退出测评"><X size={18} /></button>
          </header>
          <div className="bq-progress" aria-hidden="true"><b style={{ width: total ? `${(answeredCount / total) * 100}%` : "0%" }} /></div>

          <div className="bq-body">
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {!questions && !error ? <p className="muted bq-loading">加载测评题目…</p> : null}
            {question ? (
              <>
                <h3 className="bq-title">{question.title}</h3>
                {question.scenario || question.scenarioTranslation ? (
                  <div className="bq-scenario">
                    {question.scenario ? <p>{question.scenario}</p> : null}
                    {question.scenarioTranslation ? <small>{question.scenario ? "译：" : ""}{question.scenarioTranslation}</small> : null}
                  </div>
                ) : null}
                {question.kind === "practical" ? (
                  <>
                    <textarea
                      className="bq-textarea"
                      value={typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""}
                      onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
                      placeholder="Dear Emma, I'm so sorry to hear that…"
                      rows={7}
                    />
                    <p className="bq-textarea-hint">用英文作答，建议 3-5 句：称呼问候 → 致歉安抚 → 解决方案 → 处理时限。</p>
                  </>
                ) : (
                  <div className="bq-options" role={question.kind === "multi" ? "group" : "radiogroup"}>
                    {(question.options ?? []).map((option) => {
                      const answer = answers[question.id];
                      const on = question.kind === "multi"
                        ? Array.isArray(answer) && answer.includes(option.id)
                        : answer === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={on ? "bq-option on" : "bq-option"}
                          role={question.kind === "multi" ? "checkbox" : "radio"}
                          aria-checked={on}
                          onClick={() => pick(option.id)}
                        >
                          <i className={question.kind === "multi" ? "bq-mark square" : "bq-mark"} aria-hidden="true">
                            {on ? <Check size={11} /> : null}
                          </i>
                          <span className="bq-option-text">
                            <span>{option.text}</span>
                            {option.translation ? <small>{option.translation}</small> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : null}
          </div>

          <footer className="bq-foot">
            <button className="secondary-button" onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0}>
              <ChevronLeft size={16} /> 上一题
            </button>
            {isLast ? (
              <button className="primary-button" onClick={submit} disabled={!questions || answeredCount < total || submitting}>
                {submitting ? "评分中…" : "提交测评"}
              </button>
            ) : (
              <button className="primary-button" onClick={() => setIndex(index + 1)} disabled={!total}>
                下一题 <ChevronRight size={16} />
              </button>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
