import { Check, Plus } from "lucide-react";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { useEffect, useMemo, useState } from "react";
import { apiGet, fetchClasses, fetchTeacherTasks, type ClassSummary, type Session, type TeacherTask } from "../../api/client";
import { Bench, Board, BoardLink, Button, HelpTip } from "../../ui";
import { TaskRow } from "./TaskRow";
import { ChartEmptyNote, DimensionBars, KpiCard, RateRing, ScoreDistribution, ScoreGauge, WeekBars, weakestIds } from "./widgets";

interface Overview {
  activeStudents: number;
  totalStudents: number;
  weekActive: number;
  totalConversations: number;
  weekDaily: number[];
  todayIndex: number;
  completion: { done: number; required: number; rate: number | null };
  averageScore: number | null;
  scoredStudents: number;
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 11 ? "上午好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
}

/* 数据总览（D-59，设计稿 docs/design/p17-params-teacher 第三节）：顶部参数四项（参训人数、任务完成率、平均分、对话总数），
   然后是进行中的任务、成绩分布、各项能力。固定看全部任务；按班级、按任务看去考核报表。
   待复核、买家在等、快截止不在这里提醒：分别在“回放与评分”页签数字、侧栏“实训跟踪”角标和实时监控、实训任务列表里。 */
export function LiveOverview({ session, onNavigate }: { session: Session; onNavigate?: (page: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [tasks, setTasks] = useState<TeacherTask[] | null>(null);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const go = (page: string) => onNavigate?.(page);

  useEffect(() => {
    fetchTeacherTasks(session).then(setTasks).catch(() => setTasks([]));
    fetchClasses(session).then(setClasses).catch(() => undefined);
    apiGet<Overview>("/v1/teacher/overview", session).then(setData).catch(() => undefined);
  }, [session]);

  const ongoing = useMemo(
    () => (tasks ?? []).filter((task) => task.status !== "closed").sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")),
    [tasks],
  );
  const studentCount = classes.reduce((sum, item) => sum + item.studentCount, 0);
  const hasScores = (data?.scoredStudents ?? 0) > 0;
  const starting = tasks !== null && tasks.length === 0;
  const weekTotal = (data?.weekDaily ?? []).reduce((sum, n) => sum + n, 0);

  return (
    <Bench>
      <div className="greet">
        <h2>{greeting()}，{session.user.displayName}</h2>
        <span>
          {classes.map((item) => item.name).join("、") || "还没有班级"}
          {data && data.weekActive > 0 ? ` · 本周 ${data.weekActive} 人练过` : ""}
        </span>
      </div>

      <div className="kpi-cards">
        <KpiCard
          label="参训人数"
          help="至少接待过一次买家（含自由练习、邮件任务）的学生 / 班级名单里在用的学生。"
          value={data && data.totalStudents > 0 ? <><b>{data.activeStudents}</b><small>/ {data.totalStudents} 人</small></> : null}
          bar={data && data.totalStudents > 0 ? data.activeStudents / data.totalStudents : 0}
        />
        <KpiCard
          label="任务完成率"
          help="每个学生的每个任务算一次：已完成的次数 / 应完成的次数（已下发的任务 × 名单里在用的学生）。"
          value={data?.completion.rate != null ? <b>{data.completion.rate}%</b> : null}
          sub={data && data.completion.required > 0 ? `已完成 ${data.completion.done} / ${data.completion.required} 人次` : undefined}
          chart={<RateRing value={data?.completion.rate ?? null} />}
        />
        <KpiCard
          label="平均分"
          help="每个学生先算综合成绩（各任务成绩的平均），再求全班平均，和考核报表同一个算法；自由练习不计入。"
          value={data?.averageScore != null ? <><b>{data.averageScore}</b><small>/ 100</small></> : null}
          sub={hasScores ? `${data!.scoredStudents} 人有成绩` : undefined}
          chart={<ScoreGauge value={data?.averageScore ?? null} />}
        />
        <KpiCard
          label="对话总数"
          help="全班学生的“累计对话”加起来：学生回过话的聊天接待，含自由练习，不含邮件。柱子是本周每天的次数，蓝色是今天。"
          value={<><b className={data && data.totalConversations > 0 ? undefined : "is-dash"}>{data?.totalConversations ?? 0}</b><small>次</small></>}
          sub={data && data.totalConversations > 0 ? `本周 ${weekTotal} 次` : undefined}
          chart={<WeekBars daily={data?.weekDaily ?? [0, 0, 0, 0, 0, 0, 0]} today={data?.todayIndex ?? (new Date().getDay() + 6) % 7} />}
        />
      </div>

      {/* 开课三步（设计稿 docs/design/p23-start-guides）：下发第一个任务后整块换成“进行中的任务”，所以第二、三步不会出现做完状态 */}
      {starting ? (
        <Board className="ov-start">
          <header className="ov-start-head"><h3>开课三步</h3><span className="board-count">{studentCount ? 1 : 0} / 3</span></header>
          <div className="ov-steps">
            <div className={studentCount ? "ov-step is-done" : "ov-step is-cur"}>
              <span className="ov-step-no">{studentCount ? <Check size={15} strokeWidth={3} aria-hidden="true" /> : 1}</span>
              <b>导入学生名单</b>
              <p>{studentCount ? `已导入 ${studentCount} 人` : "粘贴“学号,姓名”名单，自动生成初始密码"}</p>
              {studentCount
                ? <BoardLink onClick={() => go("classes")}>查看名单</BoardLink>
                : <Button variant="primary" onClick={() => go("classes")}>去导入</Button>}
            </div>
            <div className={studentCount ? "ov-step is-cur" : "ov-step"}>
              <span className="ov-step-no">2</span>
              <b>下发第一个任务</b>
              <p>选班级和场景，几分钟就能配好</p>
              <Button variant={studentCount ? "primary" : "secondary"} icon={Plus} onClick={() => go("assignments")}>新建任务</Button>
            </div>
            <div className="ov-step">
              <span className="ov-step-no">3</span>
              <b>看学生练习</b>
              <p>学生接待时可以旁观对话、随时发指导</p>
              <Button onClick={() => go("tracking")}>去实训跟踪</Button>
            </div>
          </div>
        </Board>
      ) : null}

      {ongoing.length ? (
        <Board title="进行中的任务" count={ongoing.length} extra={<BoardLink onClick={() => go("assignments")}>全部任务</BoardLink>}>
          {ongoing.slice(0, 5).map((task) => <TaskRow key={task.id} task={task} onOpen={() => go("assignments")} />)}
        </Board>
      ) : null}

      {!starting ? (
        <div className="duo">
          <Board title="成绩分布" count={`${data?.scoredStudents ?? 0} 人有成绩`} extra={<BoardLink onClick={() => go("reports")}>看报表</BoardLink>}>
            <ScoreDistribution
              distribution={data?.distribution ?? [0, 0, 0, 0, 0]}
              emptyNote={<ChartEmptyNote desc="学生完成接待后出现" action={<BoardLink onClick={() => go("assignments")}>去看任务</BoardLink>} />}
            />
          </Board>
          <Board title={<>各项能力<HelpTip>全班每一项的平均分，红色是最弱的两项，同分的一起标</HelpTip></>} extra={<BoardLink onClick={() => go("reports")}>看报表</BoardLink>}>
            <DimensionBars
              dims={data?.radar?.length ? data.radar : ASSESSMENT_DIMENSIONS.map((dim) => ({ id: dim.id, label: dim.label, value: null }))}
              weak={hasScores ? weakestIds(data!.radar) : undefined}
              emptyNote={<ChartEmptyNote desc="学生完成接待后出现" />}
            />
          </Board>
        </div>
      ) : null}
    </Bench>
  );
}
