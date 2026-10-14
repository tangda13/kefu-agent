import { AlarmClock, Check, ChevronRight, ClipboardCheck, MessageCircleWarning, Plus, type LucideIcon } from "lucide-react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { useEffect, useMemo, useState } from "react";
import { apiGet, fetchClasses, fetchTeacherTasks, type ClassSummary, type Session, type TeacherTask } from "../../api/client";
import { Bench, Board, BoardLink, Button, HelpTip, Select } from "../../ui";
import { TaskRow } from "./TaskRow";
import { ChartEmptyNote, DimensionBars, dueText, formatIdle, openTrackingTab, ScoreDistribution } from "./widgets";

/**
 * 待办卡片（D-31）：图标块 + 名称 + 大数字 + 一句事实，整张卡可点。
 * 为 0 时不写“都处理完了”：图标块变灰并带绿色小勾，第三行换成有用的背景（本周复核了几份、几人在接待、下一个截止）。
 */
function TodoCard({ icon: Icon, tone, label, help, count, unit, fact, action, onOpen }: {
  icon: LucideIcon; tone: "bad" | "warn" | "plain" | "zero"; label: string; help: string; count: number; unit: string; fact: string; action: string; onOpen: () => void;
}) {
  return (
    <div className={`todo-card is-${tone}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}>
      <span className="todo-card-icon"><Icon size={22} />{tone === "zero" ? <span className="badge-ok"><Check size={10} strokeWidth={3} /></span> : null}</span>
      <div className="todo-card-main">
        <span className="todo-card-label">{label}<HelpTip>{help}</HelpTip></span>
        <span className="todo-card-num"><b>{count}</b><small>{unit}</small></span>
        <span className="todo-card-fact">{fact}</span>
      </div>
      <span className="todo-card-go">{action}<ChevronRight size={14} /></span>
    </div>
  );
}

interface Overview {
  activeStudents: number;
  totalStudents: number;
  weekActive: number;
  totalConversations: number;
  scoredStudents: number;
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
  weakDimensions: Array<{ id: string; label: string; value: number | null }>;
}
interface TrackingBrief { alert: boolean; suspended: boolean; idleSeconds: number; studentName: string }
interface AssessmentBrief { id: string; total: number; reviewedAt: string | null; practice: boolean; studentName: string; scenarioName: string }

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 11 ? "上午好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
}

/* 数据总览（D-27 工作台）：第一块只回答“现在要我处理什么”，然后是进行中的任务，最后才是成绩。
   口径：任务 = 考核单位，学生成绩 = 各任务成绩的平均，自由练习不计入。 */
export function LiveOverview({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [tasks, setTasks] = useState<TeacherTask[] | null>(null);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [tracking, setTracking] = useState<TrackingBrief[]>([]);
  const [assessments, setAssessments] = useState<AssessmentBrief[]>([]);
  const [taskId, setTaskId] = useState("");
  const go = (page: string) => onNavigate?.(page);

  useEffect(() => {
    fetchTeacherTasks(session).then(setTasks).catch(() => setTasks([]));
    fetchClasses(session).then(setClasses).catch(() => undefined);
    apiGet<TrackingBrief[]>("/v1/teacher/tracking", session).then(setTracking).catch(() => undefined);
    apiGet<AssessmentBrief[]>("/v1/teacher/assessments", session).then(setAssessments).catch(() => undefined);
  }, [session]);
  useEffect(() => {
    apiGet<Overview>(`/v1/teacher/overview${taskId ? `?taskId=${taskId}` : ""}`, session).then(setData).catch(() => undefined);
  }, [session, taskId]);

  const ongoing = useMemo(
    () => (tasks ?? []).filter((task) => task.status !== "closed").sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")),
    [tasks],
  );
  const pending = assessments.filter((item) => !item.reviewedAt && !item.practice);
  const lowPending = pending.filter((item) => item.total < 60);
  const waiting = tracking.filter((item) => item.alert).sort((a, b) => b.idleSeconds - a.idleSeconds);
  const urgent = ongoing.find((task) => task.deadline && new Date(task.deadline).getTime() > Date.now() && task.studentDone < task.studentTotal);
  const studentCount = classes.reduce((sum, item) => sum + item.studentCount, 0);
  const weekAgo = Date.now() - 7 * 86400000;
  const weekReviewed = assessments.filter((item) => item.reviewedAt && new Date(item.reviewedAt).getTime() >= weekAgo).length;
  const receiving = tracking.filter((item) => !item.suspended).length;
  const nextDue = ongoing.find((task) => task.deadline && new Date(task.deadline).getTime() > Date.now());
  const hasScores = (data?.scoredStudents ?? 0) > 0;
  const starting = tasks !== null && tasks.length === 0;

  return (
    <Bench>
      <div className="greet">
        <h2>{greeting()}，{session.user.displayName}</h2>
        <span>
          {classes.map((item) => item.name).join("、") || "还没有班级"} · {studentCount} 人
          {data && data.weekActive > 0 ? ` · 本周 ${data.weekActive} 人练过` : ""}
        </span>
      </div>

      {starting ? (
        <Board title="开课三步">
          <div className="trio">
            <div className="step">
              <span className={studentCount ? "steps-no is-done" : "steps-no"}>{studentCount ? "✓" : "1"}</span>
              <b>导入学生名单</b>
              <p>{studentCount ? `已导入 ${studentCount} 人。` : "按“学号,姓名”粘贴全班名单，系统自动生成初始密码。"}</p>
              <Button variant={studentCount ? "ghost" : "primary"} onClick={() => go("classes")}>{studentCount ? "查看名单" : "去导入"}</Button>
            </div>
            <div className="step">
              <span className="steps-no">2</span>
              <b>下发第一个任务</b>
              <p>选班级和场景，几分钟就能配好。建议先用“一位接一位”的进线方式。</p>
              <Button variant={studentCount ? "primary" : "secondary"} icon={Plus} onClick={() => go("assignments")}>新建任务</Button>
            </div>
            <div className="step">
              <span className="steps-no">3</span>
              <b>看学生练习</b>
              <p>学生开始接待后，可以在实训跟踪里旁观对话，随时发指导。</p>
              <Button onClick={() => go("tracking")}>去实训跟踪</Button>
            </div>
          </div>
        </Board>
      ) : (
        <div className="todo-cards">
          <TodoCard
            icon={ClipboardCheck}
            tone={pending.length ? (lowPending.length ? "bad" : "warn") : "zero"}
            label="待复核的评分"
            help="学生每完成一次任务里的接待，AI 评分会先到这里等你看一眼"
            count={pending.length}
            unit="份"
            fact={lowPending.length ? `其中 ${lowPending.length} 份低于 60 分（${lowPending[0]!.studentName} · ${lowPending[0]!.scenarioName}）`
              : pending.length ? `最早一份来自 ${pending[pending.length - 1]!.studentName}`
                : weekReviewed ? `本周已复核 ${weekReviewed} 份` : "本周还没有新评分"}
            action={pending.length ? "去复核" : "回放与评分"}
            onOpen={() => { openTrackingTab("replay"); go("tracking"); }}
          />
          <TodoCard
            icon={MessageCircleWarning}
            tone={waiting.length ? "warn" : "zero"}
            label="买家在等回复"
            help="买家发来消息后 3 分钟以上没人回，会算在这里"
            count={waiting.length}
            unit="位学生"
            fact={waiting.length ? `${waiting[0]!.studentName} 已经让买家等了 ${formatIdle(waiting[0]!.idleSeconds)}` : receiving ? `现在 ${receiving} 人在接待` : "现在没人在接待"}
            action={waiting.length ? "去看看" : "实时监控"}
            onOpen={() => { openTrackingTab("live"); go("tracking"); }}
          />
          <TodoCard
            icon={AlarmClock}
            tone={urgent ? (dueText(urgent.deadline).tone ? "warn" : "plain") : "zero"}
            label="快截止还没做完"
            help="设了截止时间、还有学生没完成的任务"
            count={urgent ? urgent.studentTotal - urgent.studentDone : 0}
            unit={urgent ? "人" : "个任务"}
            fact={urgent ? `「${urgent.name}」${dueText(urgent.deadline).text}`
              : nextDue ? `下一个截止：「${nextDue.name}」${dueText(nextDue.deadline).text}`
                : ongoing.length ? `进行中的 ${ongoing.length} 个任务都没设截止` : "现在没有进行中的任务"}
            action={urgent ? "看名单" : "全部任务"}
            onOpen={() => go("assignments")}
          />
        </div>
      )}

      {ongoing.length ? (
        <Board title="进行中的任务" count={ongoing.length} extra={<BoardLink onClick={() => go("assignments")}>全部任务</BoardLink>}>
          {ongoing.slice(0, 5).map((task) => <TaskRow key={task.id} task={task} onOpen={() => go("assignments")} />)}
        </Board>
      ) : null}

      {!starting ? (
        <div className="duo">
          <Board
            title="成绩分布"
            count={`${data?.scoredStudents ?? 0} 人有成绩`}
            extra={
              <Select className="toolbar-select board-select" value={taskId} onChange={(event) => setTaskId(event.target.value)} aria-label="统计范围">
                <option value="">全部任务综合</option>
                {(tasks ?? []).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
              </Select>
            }
          >
            <ScoreDistribution
              distribution={data?.distribution ?? [0, 0, 0, 0, 0]}
              emptyNote={<ChartEmptyNote desc="学生完成接待后出现" action={<BoardLink onClick={() => go("assignments")}>去看任务</BoardLink>} />}
            />
          </Board>
          <Board title={<>各项能力<HelpTip>全班每一项的平均分，红色是最弱的两项</HelpTip></>} extra={<BoardLink onClick={() => go("reports")}>看报表</BoardLink>}>
            <DimensionBars
              dims={data?.radar?.length ? data.radar : ASSESSMENT_DIMENSIONS.map((dim) => ({ id: dim.id, label: dim.label, value: null }))}
              weak={hasScores ? new Set(data!.weakDimensions.slice(0, 2).map((dim) => dim.id)) : undefined}
              emptyNote={<ChartEmptyNote desc="学生完成接待后出现" />}
            />
          </Board>
        </div>
      ) : null}
    </Bench>
  );
}
