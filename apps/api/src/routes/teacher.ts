import type { FastifyInstance } from "fastify";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { ensurePersonaAvatar, toStudentPersonaView } from "@cecs/domain";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";

/** 教师授权班级的学生 ID 子查询（管理员不限）；paramIndex 指定教师ID占位序号 */
function scopedStudentsSql(isAdmin: boolean, paramIndex = 1): string {
  return isAdmin
    ? "select id from users where role = 'student'"
    : `select u.id from users u where u.role = 'student' and u.class_id in (
         select class_id from teacher_classes where teacher_id = $${paramIndex}
         union select id from classes where head_teacher_id = $${paramIndex}
       )`;
}

export function registerTeacherRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
): void {
  // 数据总览：核心指标 + 成绩分布 + 能力薄弱项
  app.get(
    "/v1/teacher/overview",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const params = isAdmin ? [] : [user.sub];
      const students = scopedStudentsSql(isAdmin);

      const [heads, progress, scores, buckets, dims] = await Promise.all([
        db.query(
          `select
             (select count(distinct c.student_id) from conversations c where c.student_id in (${students})) as active_students,
             (select count(*) from users where role = 'student' and id in (${students})) as total_students,
             (select count(*) from conversation_messages m join conversations c on c.id = m.conversation_id
              where c.student_id in (${students})) as total_messages`,
          params,
        ),
        db.query(
          `select count(*) filter (where tp.status = 'done') as done, count(*) as total
           from task_progress tp where tp.student_id in (${students})`,
          params,
        ),
        db.query(
          `select round(avg(total)) as avg_total from assessments where student_id in (${students})`,
          params,
        ),
        db.query(
          `select width_bucket(total, array[60, 70, 80, 90]) as bucket, count(*) as n
           from assessments where student_id in (${students}) group by bucket`,
          params,
        ),
        db.query(
          `select scores from assessments where student_id in (${students}) order by created_at desc limit 200`,
          params,
        ),
      ]);

      const distribution = [0, 0, 0, 0, 0];
      for (const row of buckets.rows) distribution[Number(row.bucket)] = Number(row.n);

      const dimTotals: Record<string, { sum: number; n: number }> = {};
      for (const row of dims.rows) {
        for (const [key, value] of Object.entries(row.scores as Record<string, number>)) {
          dimTotals[key] = dimTotals[key] ?? { sum: 0, n: 0 };
          dimTotals[key]!.sum += Number(value);
          dimTotals[key]!.n += 1;
        }
      }
      const radar = ASSESSMENT_DIMENSIONS.map((dim) => ({
        id: dim.id,
        label: dim.label,
        value: dimTotals[dim.id]?.n ? Math.round(dimTotals[dim.id]!.sum / dimTotals[dim.id]!.n) : null,
      }));

      const head = heads.rows[0];
      const progressRow = progress.rows[0];
      return {
        activeStudents: Number(head.active_students),
        totalStudents: Number(head.total_students),
        totalMessages: Number(head.total_messages),
        completionRate:
          Number(progressRow.total) > 0
            ? Math.round((Number(progressRow.done) / Number(progressRow.total)) * 100)
            : null,
        averageScore: scores.rows[0]?.avg_total !== null ? Number(scores.rows[0].avg_total) : null,
        distribution,
        radar,
        weakDimensions: radar
          .filter((item) => item.value !== null)
          .sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
          .slice(0, 3),
      };
    },
  );

  // 实训跟踪：学生活跃会话（前端 8 秒轮询，满足 ≤10 秒刷新）
  app.get(
    "/v1/teacher/tracking",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const params = isAdmin ? [] : [user.sub];
      const result = await db.query(
        `select c.id, c.persona, c.state, c.created_at, u.display_name as student_name, u.username,
                s.name as scenario_name,
                (select count(*) from conversation_messages m where m.conversation_id = c.id and m.sender = 'student') as student_turns,
                lm.sender as last_sender, lm.created_at as last_at, lm.content as last_content
         from conversations c
         join users u on u.id = c.student_id
         left join scenarios s on s.id = c.scenario_id
         left join lateral (
           select sender, content, created_at from conversation_messages m
           where m.conversation_id = c.id order by m.created_at desc limit 1
         ) lm on true
         where c.status = 'active' and c.student_id in (${scopedStudentsSql(isAdmin)})
         order by coalesce(lm.created_at, c.created_at) desc limit 40`,
        params,
      );
      const now = Date.now();
      return result.rows.map((row) => {
        const lastAt = row.last_at ? new Date(row.last_at).getTime() : new Date(row.created_at).getTime();
        const idleSeconds = Math.round((now - lastAt) / 1000);
        return {
          conversationId: row.id,
          studentName: row.student_name,
          username: row.username,
          buyer: toStudentPersonaView(ensurePersonaAvatar(row.persona, row.id) as never),
          scenarioName: row.scenario_name ?? "通用会话",
          studentTurns: Number(row.student_turns),
          lastSender: row.last_sender,
          lastContent: row.last_content ?? "",
          lastAt: row.last_at ?? row.created_at,
          idleSeconds,
          liveScore: (row.state as { liveScore?: number } | null)?.liveScore ?? null,
          satisfaction: (row.state as { satisfaction?: number } | null)?.satisfaction ?? null,
          stage: (row.state as { stage?: string } | null)?.stage ?? null,
          startedAt: row.created_at,
          // 预警：买家消息超过 3 分钟未回复
          alert: row.last_sender === "buyer" && idleSeconds > 180,
        };
      });
    },
  );

  // 教师查看会话消息（回放/监控详情）
  app.get<{ Params: { conversationId: string } }>(
    "/v1/teacher/conversations/:conversationId/messages",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const owned = await db.query(
        `select 1 from conversations c where c.id = $1 and c.student_id in (${scopedStudentsSql(isAdmin, 2)})`,
        isAdmin ? [request.params.conversationId] : [request.params.conversationId, user.sub],
      );
      if (!owned.rowCount) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "无权查看该会话。" };
      }
      const result = await db.query(
        `select id, sender, content, kind, payload, created_at from conversation_messages
         where conversation_id = $1 order by created_at`,
        [request.params.conversationId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        sender: row.sender,
        content: row.content,
        kind: row.kind ?? "text",
        payload: row.payload ?? null,
        createdAt: row.created_at,
      }));
    },
  );

  // 一键介入：教师指导消息进入会话（学生可见，并作为 LLM 上下文）
  app.post<{ Params: { conversationId: string }; Body: { content?: string } }>(
    "/v1/teacher/conversations/:conversationId/intervene",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const content = request.body?.content?.trim();
      if (!content) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请输入指导内容。" };
      }
      const owned = await db.query(
        `select 1 from conversations c where c.id = $1 and c.status = 'active'
           and c.student_id in (${scopedStudentsSql(isAdmin, 2)})`,
        isAdmin ? [request.params.conversationId] : [request.params.conversationId, user.sub],
      );
      if (!owned.rowCount) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权介入。" };
      }
      await db.query(
        `insert into conversation_messages (conversation_id, sender, content)
         values ($1, 'teacher', $2)`,
        [request.params.conversationId, content],
      );
      await writeAudit(db, user.sub, "teacher.intervene", request.params.conversationId);
      return { ok: true };
    },
  );

  // 考核报表：按班级的成绩分布、全班雷达与学生排名
  app.get<{ Querystring: { classId?: string } }>(
    "/v1/teacher/reports",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const classId = request.query.classId?.trim() || null;
      const params: unknown[] = isAdmin ? [] : [user.sub];
      let classFilter = "";
      if (classId) {
        params.push(classId);
        classFilter = ` and u.class_id = $${params.length}`;
      }
      const result = await db.query(
        `select u.id, u.display_name, u.username, a.scores, a.total
         from assessments a
         join users u on u.id = a.student_id
         where a.student_id in (${scopedStudentsSql(isAdmin)})${classFilter}
         order by a.created_at desc`,
        params,
      );
      if (classId) {
        const allowed = await db.query(
          `select 1 from classes c where c.id = $1 ${isAdmin ? "" : `and c.id in (
             select class_id from teacher_classes where teacher_id = $2
             union select id from classes where head_teacher_id = $2)`}`,
          isAdmin ? [classId] : [classId, user.sub],
        );
        if (!allowed.rowCount) {
          reply.code(403);
          return { code: "FORBIDDEN", message: "无权查看该班级。" };
        }
      }

      const distribution = [0, 0, 0, 0, 0];
      const dimTotals: Record<string, { sum: number; n: number }> = {};
      const byStudent = new Map<string, {
        name: string; username: string; totals: number[]; dims: Record<string, { sum: number; n: number }>;
      }>();
      for (const row of result.rows) {
        const total = Number(row.total);
        const bucket = total < 60 ? 0 : total < 70 ? 1 : total < 80 ? 2 : total < 90 ? 3 : 4;
        distribution[bucket] = (distribution[bucket] ?? 0) + 1;
        const entry = byStudent.get(row.id) ?? {
          name: row.display_name as string,
          username: row.username as string,
          totals: [] as number[],
          dims: {} as Record<string, { sum: number; n: number }>,
        };
        entry.totals.push(total);
        for (const [key, value] of Object.entries(row.scores as Record<string, number>)) {
          dimTotals[key] = dimTotals[key] ?? { sum: 0, n: 0 };
          dimTotals[key]!.sum += Number(value);
          dimTotals[key]!.n += 1;
          entry.dims[key] = entry.dims[key] ?? { sum: 0, n: 0 };
          entry.dims[key]!.sum += Number(value);
          entry.dims[key]!.n += 1;
        }
        byStudent.set(row.id, entry);
      }
      const radar = ASSESSMENT_DIMENSIONS.map((dim) => ({
        id: dim.id,
        label: dim.label,
        value: dimTotals[dim.id]?.n ? Math.round(dimTotals[dim.id]!.sum / dimTotals[dim.id]!.n) : null,
      }));
      const ranking = [...byStudent.values()]
        .map((entry) => ({
          name: entry.name,
          username: entry.username,
          sessions: entry.totals.length,
          average: Math.round(entry.totals.reduce((a, b) => a + b, 0) / entry.totals.length),
          best: Math.max(...entry.totals),
          dims: Object.fromEntries(
            ASSESSMENT_DIMENSIONS.map((dim) => [
              dim.id,
              entry.dims[dim.id]?.n ? Math.round(entry.dims[dim.id]!.sum / entry.dims[dim.id]!.n) : null,
            ]),
          ),
        }))
        .sort((a, b) => b.average - a.average);
      return { distribution, radar, ranking, assessedCount: result.rowCount };
    },
  );

  // 评分列表（回放与复核）
  app.get(
    "/v1/teacher/assessments",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const params = isAdmin ? [] : [user.sub];
      const result = await db.query(
        `select a.*, u.display_name as student_name, c.persona, s.name as scenario_name
         from assessments a
         join users u on u.id = a.student_id
         join conversations c on c.id = a.conversation_id
         left join scenarios s on s.id = c.scenario_id
         where a.student_id in (${scopedStudentsSql(isAdmin)})
         order by a.created_at desc limit 100`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        studentName: row.student_name,
        buyerName: (row.persona as { name?: string })?.name ?? "-",
        scenarioName: row.scenario_name ?? "通用会话",
        scores: row.scores,
        total: Number(row.total),
        comment: row.comment,
        suggestions: row.suggestions,
        createdAt: row.created_at,
      }));
    },
  );

  // 人工复核：调整总分/评语
  app.patch<{ Params: { assessmentId: string }; Body: { total?: number; comment?: string } }>(
    "/v1/teacher/assessments/:assessmentId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const { total, comment } = request.body ?? {};
      if (total !== undefined && (!Number.isFinite(total) || total < 0 || total > 100)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "总分须在 0-100 之间。" };
      }
      const result = await db.query(
        `update assessments set
           total = coalesce($1, total),
           comment = coalesce($2, comment)
         where id = $3 and student_id in (${scopedStudentsSql(isAdmin, 4)})
         returning id, conversation_id, total`,
        isAdmin
          ? [total ?? null, comment ?? null, request.params.assessmentId]
          : [total ?? null, comment ?? null, request.params.assessmentId, user.sub],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "评分记录不存在或无权复核。" };
      }
      // 同步任务成绩
      const row = result.rows[0];
      await db.query(
        `update task_progress tp set score = $1, updated_at = now()
         from conversations c
         where c.id = $2 and tp.task_id = c.task_id and tp.student_id = c.student_id`,
        [row.total, row.conversation_id],
      );
      await writeAudit(db, user.sub, "assessment.review", request.params.assessmentId, { total, comment });
      return { ok: true };
    },
  );
}
