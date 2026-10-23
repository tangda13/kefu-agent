import type { FastifyInstance } from "fastify";
import { ASSESSMENT_DIMENSIONS, BUSINESS_STAGES } from "@cecs/contracts";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { teacherOwnsClass, writeAudit } from "../auth-context";
import { DEFAULT_ARRIVAL_INTERVAL_MINUTES, averageReplySec, filterPersonaTemplates, replyWithinRate, type PersonaRule } from "@cecs/domain";
import { loadReceptionTimings, sumReplySummaries } from "../reception-stats";
import { ratingSummary } from "../service-rating";
import { loadEnabledPersonaTemplates } from "./catalog";
import type { LlmGateway } from "../llm/gateway";
import { sweepConversations } from "../lifecycle";
import { aggregateTaskCentric, type AssessedRow } from "./teacher";

interface CreateTaskBody {
  name?: string;
  businessStage?: string;
  scenarioIds?: string[];
  classIds?: string[];
  personaRule?: Record<string, unknown>;
  interactionMode?: string;
  timeLimitMinutes?: number;
  startAt?: string;
  deadline?: string;
  scoringWeights?: Record<string, number>;
  completionRule?: string;
  requiredCount?: number | null;
  passScore?: number | null;
  arrivalMode?: string;
  arrivalIntervalMinutes?: number | null;
}

const INTERACTION_MODES = ["text", "voice", "text_voice"] as const;
const COMPLETION_RULES = ["all_scenarios", "conversation_count"] as const;
const ARRIVAL_MODES = ["sequential", "interval", "all_at_once"] as const;

/* 接待节奏校验：interval 模式必须给 1-120 分钟的间隔 */
function validateArrivalPolicy(mode: string, intervalMinutes: number | null | undefined): string | null {
  if (!ARRIVAL_MODES.includes(mode as never)) return "接待节奏无效";
  if (mode === "interval") {
    if (!Number.isInteger(intervalMinutes) || (intervalMinutes as number) < 1 || (intervalMinutes as number) > 120) {
      return "进线间隔须为 1-120 的整数分钟";
    }
  }
  return null;
}

/* 完成标准校验：规则枚举 + 按次数时次数 1-50 + 达标线 0-100（空 = 不设线） */
function validateCompletionRule(
  rule: string,
  requiredCount: number | null | undefined,
  passScore: number | null | undefined,
): string | null {
  if (!COMPLETION_RULES.includes(rule as never)) return "完成规则无效";
  if (rule === "conversation_count") {
    if (!Number.isInteger(requiredCount) || (requiredCount as number) < 1 || (requiredCount as number) > 50) {
      return "完成会话次数须为 1-50 的整数";
    }
  }
  if (passScore !== undefined && passScore !== null) {
    if (!Number.isInteger(passScore) || passScore < 0 || passScore > 100) return "达标分数线须为 0-100 的整数";
  }
  return null;
}
const DIMENSION_IDS: readonly string[] = ASSESSMENT_DIMENSIONS.map(
  (item) => item.id,
);

/** 均衡权重：除不尽的余数从前往后各加 1（与教师端“均衡”预设一致） */
function defaultScoringWeights(): Record<string, number> {
  const base = Math.floor(100 / DIMENSION_IDS.length);
  const rest = 100 - base * DIMENSION_IDS.length;
  return Object.fromEntries(DIMENSION_IDS.map((id, index) => [id, base + (index < rest ? 1 : 0)]));
}

function validateScoringWeights(
  weights: Record<string, number>,
): string | null {
  const keys = Object.keys(weights);
  if (keys.length < DIMENSION_IDS.length) return `评分权重须覆盖全部 ${DIMENSION_IDS.length} 个维度`;
  for (const key of keys) {
    if (!DIMENSION_IDS.includes(key)) return `未知评分维度：${key}`;
    const value = weights[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `维度 ${key} 的权重无效`;
    }
  }
  const total = keys.reduce((sum, key) => sum + (weights[key] ?? 0), 0);
  if (Math.round(total) !== 100) return "评分权重合计必须为 100";
  return null;
}

export function registerTaskRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  gateway?: LlmGateway,
): void {
  app.post<{ Body: CreateTaskBody }>(
    "/v1/tasks",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const body = request.body ?? {};
      const name = body.name?.trim();
      if (!name) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写任务名称。" };
      }
      if (!BUSINESS_STAGES.includes(body.businessStage as never)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "业务环节无效。" };
      }
      const interactionMode = body.interactionMode ?? "text_voice";
      if (!INTERACTION_MODES.includes(interactionMode as never)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "交互模式无效。" };
      }
      const scenarioIds = body.scenarioIds ?? [];
      if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请至少选择一个实训场景。" };
      }
      const scenarioCheck = await db.query(
        "select id from scenarios where id = any($1) and enabled",
        [scenarioIds],
      );
      if (scenarioCheck.rowCount !== scenarioIds.length) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "包含不存在或未启用的场景。" };
      }
      const classIds = body.classIds ?? [];
      if (!Array.isArray(classIds) || classIds.length === 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请至少选择一个下发班级。" };
      }
      for (const classId of classIds) {
        if (!(await teacherOwnsClass(db, user, classId))) {
          reply.code(403);
          return { code: "FORBIDDEN", message: "包含未授权的班级。" };
        }
      }
      const scoringWeights = body.scoringWeights ?? defaultScoringWeights();
      const weightProblem = validateScoringWeights(scoringWeights);
      if (weightProblem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: weightProblem };
      }
      const timeLimit = body.timeLimitMinutes;
      if (
        timeLimit !== undefined &&
        (!Number.isInteger(timeLimit) || timeLimit <= 0)
      ) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "限时必须为正整数分钟。" };
      }
      /* 定时开放：start_at 之前学生不可进入；须早于截止时间 */
      if (
        body.startAt &&
        body.deadline &&
        new Date(body.startAt).getTime() >= new Date(body.deadline).getTime()
      ) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "开始时间必须早于截止时间。" };
      }
      const completionRule = body.completionRule ?? "all_scenarios";
      const requiredCount = completionRule === "conversation_count" ? body.requiredCount ?? 1 : null;
      const passScore = body.passScore ?? null;
      const ruleProblem = validateCompletionRule(completionRule, requiredCount, passScore);
      if (ruleProblem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: ruleProblem };
      }
      const arrivalMode = body.arrivalMode ?? "sequential";
      const arrivalIntervalMinutes = arrivalMode === "interval" ? body.arrivalIntervalMinutes ?? DEFAULT_ARRIVAL_INTERVAL_MINUTES : null;
      const arrivalProblem = validateArrivalPolicy(arrivalMode, arrivalIntervalMinutes);
      if (arrivalProblem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: arrivalProblem };
      }

      // D-33：买家范围里至少要有一个启用的画像，否则学生一开始接待就会失败
      if (filterPersonaTemplates(await loadEnabledPersonaTemplates(db), (body.personaRule ?? {}) as PersonaRule).length === 0) {
        reply.code(400);
        return { code: "NO_MATCHING_PERSONA", message: "买家范围里没有可用的画像，请放宽条件或先启用画像。" };
      }

      const client = await db.connect();
      try {
        await client.query("begin");
        const taskResult = await client.query(
          `insert into tasks
             (name, business_stage, scenario_ids, persona_rule, interaction_mode,
              time_limit_minutes, start_at, deadline, scoring_weights, created_by,
              completion_rule, required_count, pass_score, arrival_mode, arrival_interval_minutes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           returning id, created_at`,
          [
            name,
            body.businessStage,
            JSON.stringify(scenarioIds),
            JSON.stringify(body.personaRule ?? {}),
            interactionMode,
            timeLimit ?? null,
            body.startAt ?? null,
            body.deadline ?? null,
            JSON.stringify(scoringWeights),
            user.sub,
            completionRule,
            requiredCount,
            passScore,
            arrivalMode,
            arrivalIntervalMinutes,
          ],
        );
        const taskId = taskResult.rows[0].id as string;
        for (const classId of classIds) {
          await client.query(
            "insert into task_classes (task_id, class_id) values ($1, $2)",
            [taskId, classId],
          );
        }
        await client.query(
          `insert into task_progress (task_id, student_id)
           select $1, u.id from users u
           where u.role = 'student' and u.status = 'active' and u.class_id = any($2)
           on conflict do nothing`,
          [taskId, classIds],
        );
        await client.query("commit");
        await writeAudit(db, user.sub, "task.create", taskId, {
          name,
          classIds,
        });
        return {
          id: taskId,
          name,
          businessStage: body.businessStage,
          scenarioIds,
          classIds,
          interactionMode,
          timeLimitMinutes: timeLimit ?? null,
          startAt: body.startAt ?? null,
          deadline: body.deadline ?? null,
          scoringWeights,
          completionRule,
          requiredCount,
          passScore,
          arrivalMode,
          arrivalIntervalMinutes,
          createdAt: taskResult.rows[0].created_at,
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  /* 编辑任务：名称/开始时间/截止/限时/状态/完成标准/接待节奏。仅创建者或管理员 */
  app.patch<{ Params: { taskId: string }; Body: { name?: string; startAt?: string | null; deadline?: string | null; timeLimitMinutes?: number | null; status?: string; completionRule?: string; requiredCount?: number | null; passScore?: number | null; arrivalMode?: string; arrivalIntervalMinutes?: number | null } }>(
    "/v1/tasks/:taskId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const { taskId } = request.params;
      const existing = await db.query("select * from tasks where id = $1", [taskId]);
      const current = existing.rows[0];
      if (!current) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "任务不存在。" };
      }
      if (user.role !== "admin" && current.created_by !== user.sub) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "只有任务创建者可以修改该任务。" };
      }
      const body = request.body ?? {};
      if (body.name !== undefined && !body.name.trim()) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "任务名称不能为空。" };
      }
      if (body.status !== undefined && !["published", "closed"].includes(body.status)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "任务状态无效。" };
      }
      if (
        body.timeLimitMinutes !== undefined &&
        body.timeLimitMinutes !== null &&
        (!Number.isInteger(body.timeLimitMinutes) || body.timeLimitMinutes <= 0)
      ) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "限时必须为正整数分钟。" };
      }
      const merged = {
        name: body.name?.trim() ?? current.name,
        startAt: body.startAt === undefined ? current.start_at : body.startAt,
        deadline: body.deadline === undefined ? current.deadline : body.deadline,
        timeLimit: body.timeLimitMinutes === undefined ? current.time_limit_minutes : body.timeLimitMinutes,
        status: body.status ?? current.status,
        completionRule: body.completionRule ?? current.completion_rule ?? "all_scenarios",
        requiredCount: body.requiredCount === undefined ? current.required_count : body.requiredCount,
        passScore: body.passScore === undefined ? current.pass_score : body.passScore,
        arrivalMode: body.arrivalMode ?? current.arrival_mode ?? "sequential",
        arrivalIntervalMinutes:
          body.arrivalIntervalMinutes === undefined ? current.arrival_interval_minutes : body.arrivalIntervalMinutes,
      };
      if (merged.completionRule === "conversation_count" && merged.requiredCount == null) merged.requiredCount = 1;
      if (merged.completionRule === "all_scenarios") merged.requiredCount = null;
      const ruleProblem = validateCompletionRule(merged.completionRule, merged.requiredCount, merged.passScore);
      if (ruleProblem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: ruleProblem };
      }
      if (merged.arrivalMode === "interval" && merged.arrivalIntervalMinutes == null) merged.arrivalIntervalMinutes = DEFAULT_ARRIVAL_INTERVAL_MINUTES;
      if (merged.arrivalMode !== "interval") merged.arrivalIntervalMinutes = null;
      const arrivalProblem = validateArrivalPolicy(merged.arrivalMode, merged.arrivalIntervalMinutes);
      if (arrivalProblem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: arrivalProblem };
      }
      if (
        merged.startAt &&
        merged.deadline &&
        new Date(merged.startAt).getTime() >= new Date(merged.deadline).getTime()
      ) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "开始时间必须早于截止时间。" };
      }
      const result = await db.query(
        `update tasks set name = $1, start_at = $2, deadline = $3, time_limit_minutes = $4, status = $5,
           completion_rule = $6, required_count = $7, pass_score = $8, arrival_mode = $9, arrival_interval_minutes = $10
         where id = $11
         returning id, name, start_at, deadline, time_limit_minutes, status, completion_rule, required_count, pass_score, arrival_mode, arrival_interval_minutes`,
        [merged.name, merged.startAt, merged.deadline, merged.timeLimit, merged.status, merged.completionRule, merged.requiredCount, merged.passScore, merged.arrivalMode, merged.arrivalIntervalMinutes, taskId],
      );
      await writeAudit(db, user.sub, "task.update", taskId, { status: merged.status });
      // D-36：结束任务（或改了截止 / 限时）时立即结束任务里还没完成的接待
      if (gateway) void sweepConversations(db, gateway, { taskId }).catch(() => undefined);
      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        startAt: row.start_at,
        deadline: row.deadline,
        timeLimitMinutes: row.time_limit_minutes,
        status: row.status,
        completionRule: row.completion_rule,
        requiredCount: row.required_count,
        passScore: row.pass_score,
        arrivalMode: row.arrival_mode,
        arrivalIntervalMinutes: row.arrival_interval_minutes,
      };
    },
  );

  /* 删除任务：连带清理下发关系与学生进度。仅创建者或管理员 */
  app.delete<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const { taskId } = request.params;
      const existing = await db.query("select created_by from tasks where id = $1", [taskId]);
      const current = existing.rows[0];
      if (!current) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "任务不存在。" };
      }
      if (user.role !== "admin" && current.created_by !== user.sub) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "只有任务创建者可以删除该任务。" };
      }
      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query("delete from task_progress where task_id = $1", [taskId]);
        await client.query("delete from task_classes where task_id = $1", [taskId]);
        await client.query("delete from tasks where id = $1", [taskId]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await writeAudit(db, user.sub, "task.delete", taskId);
      return { ok: true };
    },
  );

  app.get(
    "/v1/tasks",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const user = request.user!;
      const scopeFilter =
        user.role === "admin"
          ? ""
          : `where t.created_by = $1 or exists (
               select 1 from task_classes tc
               join teacher_classes tcls on tcls.class_id = tc.class_id
               where tc.task_id = t.id and tcls.teacher_id = $1
             )`;
      const params = user.role === "admin" ? [] : [user.sub];
      const result = await db.query(
        `select t.*,
           coalesce((select json_agg(json_build_object('id', c.id, 'name', c.name))
             from task_classes tc join classes c on c.id = tc.class_id
             where tc.task_id = t.id), '[]'::json) as classes,
           (select count(*) from task_progress tp where tp.task_id = t.id) as student_total,
           (select count(*) from task_progress tp where tp.task_id = t.id and tp.status = 'done') as student_done,
           (select round(avg(tp.score)) from task_progress tp where tp.task_id = t.id and tp.score is not null) as average_score
         from tasks t ${scopeFilter}
         order by t.created_at desc`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        businessStage: row.business_stage,
        scenarioIds: row.scenario_ids,
        personaRule: row.persona_rule,
        interactionMode: row.interaction_mode,
        timeLimitMinutes: row.time_limit_minutes,
        startAt: row.start_at,
        deadline: row.deadline,
        scoringWeights: row.scoring_weights,
        status: row.status,
        completionRule: row.completion_rule ?? "all_scenarios",
        requiredCount: row.required_count,
        passScore: row.pass_score,
        arrivalMode: row.arrival_mode ?? "sequential",
        arrivalIntervalMinutes: row.arrival_interval_minutes,
        classes: row.classes,
        studentTotal: Number(row.student_total),
        studentDone: Number(row.student_done),
        averageScore: row.average_score == null ? null : Number(row.average_score),
        createdAt: row.created_at,
      }));
    },
  );

  /* 学生关键数字：任务大厅四项（D-52：已完成任务、平均分、班级排名、累计对话）+ 我的记录四项（D-53：本周接待、达标率、平均响应时长、满意率） */
  app.get(
    "/v1/student/summary",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const [tasks, me, assessed, talk, baseline] = await Promise.all([
        db.query(
          `select count(*)::int as total, count(*) filter (where tp.status = 'done')::int as done
           from task_progress tp join tasks t on t.id = tp.task_id
           where tp.student_id = $1 and t.status = 'published'`,
          [user.sub],
        ),
        db.query("select class_id from users where id = $1", [user.sub]),
        db.query(
          `select a.student_id, a.total, a.scores, c.task_id, a.created_at
           from assessments a
           join conversations c on c.id = a.conversation_id
           join users u on u.id = a.student_id
           where c.task_id is not null and u.status = 'active'
             and u.class_id is not distinct from (select class_id from users where id = $1)`,
          [user.sub],
        ),
        db.query(
          `select count(distinct c.id)::int as conversations,
                  count(distinct c.id) filter (where c.task_id is null)::int as practice,
                  count(m.id)::int as rounds
           from conversations c
           join conversation_messages m on m.conversation_id = c.id and m.sender = 'student'
           where c.student_id = $1 and c.channel = 'chat'`,
          [user.sub],
        ),
        db.query("select total from baseline_assessments where student_id = $1", [user.sub]),
      ]);
      /* 平均响应时长（D-53）、3 分钟回复率（D-61）：全部聊天接待（含练习），和复盘“本次接待”同一套算法（单轮封顶 10 分钟） */
      const chatIds = await db.query("select id from conversations where student_id = $1 and channel = 'chat'", [user.sub]);
      const replies = sumReplySummaries((await loadReceptionTimings(db, chatIds.rows.map((row) => row.id as string))).values());
      /* 满意率（D-54）：买家服务评价 4–5 星的占比，全部接待 */
      const rating = await ratingSummary(db, user.sub, "and c.channel = 'chat'");
      /* 达标率：任务接待里达到该任务达标线（没设按 60）的次数占比；本周练习：本周开始的接待次数（含自由练习） */
      const [pass, week] = await Promise.all([
        db.query(
          `select count(*)::int as assessed, count(*) filter (where a.total >= coalesce(t.pass_score, 60))::int as passed
           from assessments a join conversations c on c.id = a.conversation_id join tasks t on t.id = c.task_id
           where a.student_id = $1`,
          [user.sub],
        ),
        db.query(
          `select (created_at::date - date_trunc('week', now())::date)::int as d, count(*)::int as n,
                  count(*) filter (where task_id is null)::int as practice
           from conversations where student_id = $1 and channel = 'chat' and created_at >= date_trunc('week', now())
           group by 1`,
          [user.sub],
        ),
      ]);
      /* 周一到周日每天的接待次数（含自由练习） */
      const weekDaily = [0, 0, 0, 0, 0, 0, 0];
      let weekPractice = 0;
      for (const row of week.rows) {
        if (row.d >= 0 && row.d < 7) weekDaily[row.d] = Number(row.n);
        weekPractice += Number(row.practice);
      }
      const classId = me.rows[0]?.class_id ?? null;
      const classSize = classId
        ? Number((await db.query("select count(*)::int as n from users where class_id = $1 and role = 'student' and status = 'active'", [classId])).rows[0]?.n ?? 0)
        : 1;
      const rankOf = (rows: AssessedRow[]) => {
        const ranking = [...aggregateTaskCentric(rows).byStudent.entries()].sort((a, b) => b[1].composite - a[1].composite);
        const index = ranking.findIndex(([studentId]) => studentId === user.sub);
        return { position: index >= 0 ? index + 1 : null, composite: index >= 0 ? ranking[index]![1].composite : null };
      };
      const rows = assessed.rows as Array<AssessedRow & { created_at: string }>;
      const now = rankOf(rows);
      const weekAgo = Date.now() - 7 * 86400_000;
      const before = rankOf(rows.filter((row) => new Date(row.created_at).getTime() < weekAgo));
      return {
        tasks: { done: Number(tasks.rows[0]?.done ?? 0), total: Number(tasks.rows[0]?.total ?? 0) },
        average: now.composite,
        baseline: baseline.rows[0] ? Number(baseline.rows[0].total) : null,
        rank: {
          position: now.position,
          classSize,
          /* 正数 = 名次上升 */
          change: now.position != null && before.position != null ? before.position - now.position : null,
        },
        pass: { assessed: Number(pass.rows[0]?.assessed ?? 0), passed: Number(pass.rows[0]?.passed ?? 0) },
        weekConversations: weekDaily.reduce((sum, n) => sum + n, 0),
        weekDaily,
        /* 今天是本周第几天（0 = 周一），和 weekDaily 用同一个时区算，前端高亮用 */
        todayIndex: Number((await db.query("select (current_date - date_trunc('week', now())::date)::int as d")).rows[0]?.d ?? 0),
        weekPractice,
        conversations: {
          total: Number(talk.rows[0]?.conversations ?? 0),
          practice: Number(talk.rows[0]?.practice ?? 0),
          rounds: Number(talk.rows[0]?.rounds ?? 0),
        },
        response: {
          avgSeconds: averageReplySec(replies),
          turns: replies.replied,
          withinRate: replyWithinRate(replies),
        },
        rating,
      };
    },
  );

  app.get(
    "/v1/student/tasks",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select t.id, t.name, t.business_stage, t.scenario_ids, t.interaction_mode,
                t.time_limit_minutes, t.start_at, t.deadline, t.scoring_weights, t.created_at,
                t.completion_rule, t.required_count, t.pass_score, t.arrival_mode, t.arrival_interval_minutes,
                tp.status as progress_status, tp.score,
                coalesce((
                  select json_agg(s.name order by s.name)
                  from scenarios s
                  where s.id::text in (select jsonb_array_elements_text(t.scenario_ids))
                ), '[]'::json) as scenario_names,
                coalesce((
                  select json_agg(json_build_object('id', s.id, 'name', s.name, 'channel', coalesce(s.channel, 'chat')))
                  from scenarios s
                  where s.id::text in (select jsonb_array_elements_text(t.scenario_ids))
                ), '[]'::json) as scenarios,
                coalesce((
                  select json_agg(distinct c.scenario_id)
                  from conversations c
                  where c.task_id = t.id and c.student_id = $1 and c.scenario_id is not null
                ), '[]'::json) as started_scenario_ids,
                (select count(*)::int from conversations c
                 where c.task_id = t.id and c.student_id = $1) as conversation_count,
                (select max(a.created_at) from assessments a join conversations c on c.id = a.conversation_id
                 where c.task_id = t.id and a.student_id = $1) as completed_at,
                coalesce((select bool_and(a.reviewed_at is not null) from assessments a join conversations c on c.id = a.conversation_id
                 where c.task_id = t.id and a.student_id = $1), false) as reviewed,
                (select u.display_name from users u where u.id = t.created_by) as teacher_name,
                (select count(*)::int from assessments a join conversations c on c.id = a.conversation_id
                 where c.task_id = t.id and a.student_id = $1) as assessed_count,
                (select count(distinct c.scenario_id)::int from assessments a join conversations c on c.id = a.conversation_id
                 where c.task_id = t.id and a.student_id = $1
                   and c.scenario_id::text in (select jsonb_array_elements_text(t.scenario_ids))) as covered_scenarios
         from task_progress tp
         join tasks t on t.id = tp.task_id
         where tp.student_id = $1 and t.status = 'published'
         order by t.created_at desc`,
        [user.sub],
      );
      const now = Date.now();
      return result.rows.map((row) => {
        const completionRule = (row.completion_rule ?? "all_scenarios") as string;
        const scenarioIds = (row.scenario_ids ?? []) as string[];
        /* 进度：按规则给出「已完成/需完成」，前端直接展示 n/m */
        const requiredTotal =
          completionRule === "conversation_count" ? Math.max(1, Number(row.required_count) || 1) : scenarioIds.length;
        const progressDone =
          completionRule === "conversation_count" ? Number(row.assessed_count) : Number(row.covered_scenarios);
        const score = row.score === null ? null : Number(row.score);
        return {
          id: row.id,
          name: row.name,
          businessStage: row.business_stage,
          scenarioIds,
          scenarioNames: row.scenario_names,
          scenarios: row.scenarios,
          interactionMode: row.interaction_mode,
          timeLimitMinutes: row.time_limit_minutes,
          startAt: row.start_at,
          deadline: row.deadline,
          scoringWeights: row.scoring_weights,
          progressStatus: row.progress_status,
          score,
          completionRule,
          requiredCount: row.required_count,
          passScore: row.pass_score ?? 60,
          arrivalMode: row.arrival_mode ?? "sequential",
          arrivalIntervalMinutes: row.arrival_interval_minutes,
          progressDone: Math.min(progressDone, requiredTotal),
          requiredTotal,
          conversationCount: Number(row.conversation_count),
          startedScenarioIds: row.started_scenario_ids,
          /* 达标：任务完成后按达标线判定，老师没设达标线时按 60 分。未完成为 null */
          qualified: row.progress_status === "done" ? score !== null && score >= Number(row.pass_score ?? 60) : null,
          /* 定时开放：未到开始时间的任务学生可见但不可进入（服务端在创建会话时同样拦截） */
          locked: row.start_at != null && new Date(row.start_at).getTime() > now,
          createdAt: row.created_at,
          /* 完成时间取该任务最后一次评分时间；reviewed = 评分均经老师复核 */
          completedAt: row.progress_status === "done" ? row.completed_at : null,
          reviewed: row.progress_status === "done" && row.reviewed === true,
          teacherName: row.teacher_name ?? null,
        };
      });
    },
  );
}
