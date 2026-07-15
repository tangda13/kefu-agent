import type { FastifyInstance } from "fastify";
import { ASSESSMENT_DIMENSIONS, BUSINESS_STAGES } from "@cecs/contracts";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { teacherOwnsClass, writeAudit } from "../auth-context";

interface CreateTaskBody {
  name?: string;
  businessStage?: string;
  scenarioIds?: string[];
  classIds?: string[];
  personaRule?: Record<string, unknown>;
  interactionMode?: string;
  timeLimitMinutes?: number;
  deadline?: string;
  scoringWeights?: Record<string, number>;
}

const INTERACTION_MODES = ["text", "voice", "text_voice"] as const;
const DIMENSION_IDS: readonly string[] = ASSESSMENT_DIMENSIONS.map(
  (item) => item.id,
);

function defaultScoringWeights(): Record<string, number> {
  const weight = Math.floor(100 / DIMENSION_IDS.length);
  const weights: Record<string, number> = {};
  for (const id of DIMENSION_IDS) weights[id] = weight;
  const assigned = weight * DIMENSION_IDS.length;
  const firstId = DIMENSION_IDS[0]!;
  weights[firstId] = (weights[firstId] ?? 0) + (100 - assigned);
  return weights;
}

function validateScoringWeights(
  weights: Record<string, number>,
): string | null {
  const keys = Object.keys(weights);
  if (keys.length < DIMENSION_IDS.length) return "评分维度不得少于 6 个";
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

      const client = await db.connect();
      try {
        await client.query("begin");
        const taskResult = await client.query(
          `insert into tasks
             (name, business_stage, scenario_ids, persona_rule, interaction_mode,
              time_limit_minutes, deadline, scoring_weights, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning id, created_at`,
          [
            name,
            body.businessStage,
            JSON.stringify(scenarioIds),
            JSON.stringify(body.personaRule ?? {}),
            interactionMode,
            timeLimit ?? null,
            body.deadline ?? null,
            JSON.stringify(scoringWeights),
            user.sub,
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
          deadline: body.deadline ?? null,
          scoringWeights,
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
           (select count(*) from task_progress tp where tp.task_id = t.id and tp.status = 'done') as student_done
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
        deadline: row.deadline,
        scoringWeights: row.scoring_weights,
        status: row.status,
        classes: row.classes,
        studentTotal: Number(row.student_total),
        studentDone: Number(row.student_done),
        createdAt: row.created_at,
      }));
    },
  );

  app.get(
    "/v1/student/tasks",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select t.id, t.name, t.business_stage, t.scenario_ids, t.interaction_mode,
                t.time_limit_minutes, t.deadline, t.created_at,
                tp.status as progress_status, tp.score
         from task_progress tp
         join tasks t on t.id = tp.task_id
         where tp.student_id = $1 and t.status = 'published'
         order by t.created_at desc`,
        [user.sub],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        businessStage: row.business_stage,
        scenarioIds: row.scenario_ids,
        interactionMode: row.interaction_mode,
        timeLimitMinutes: row.time_limit_minutes,
        deadline: row.deadline,
        progressStatus: row.progress_status,
        score: row.score === null ? null : Number(row.score),
        createdAt: row.created_at,
      }));
    },
  );
}
