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

interface AssessedRow {
  student_id: string;
  total: string | number;
  scores: Record<string, number>;
  task_id: string;
}

interface StudentAggregate {
  /** 已评会话数（过程数据量） */
  sessions: number;
  /** 每个任务的最终成绩（任务下已评会话均分） */
  taskFinals: Map<string, number>;
  /** 综合成绩 = 各任务最终成绩的平均 */
  composite: number;
  /** 六维均值：先按任务求维度均值，再跨任务平均（每任务等权） */
  dims: Record<string, number | null>;
}

/** 任务口径聚合：任务成绩 = 会话均分；学生综合 = 任务均分；班级统计一人一个样本 */
function aggregateTaskCentric(rows: AssessedRow[]): {
  byStudent: Map<string, StudentAggregate>;
  distribution: number[];
  radar: Array<{ id: string; label: string; value: number | null }>;
  averageScore: number | null;
  studentCount: number;
} {
  const dimIds = ASSESSMENT_DIMENSIONS.map((dim) => dim.id);
  const byStudentTask = new Map<string, { totals: number[]; dims: Record<string, { sum: number; n: number }> }>();
  const sessionsByStudent = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.student_id}|${row.task_id}`;
    const entry = byStudentTask.get(key) ?? { totals: [], dims: {} };
    entry.totals.push(Number(row.total));
    for (const [dim, value] of Object.entries(row.scores ?? {})) {
      entry.dims[dim] = entry.dims[dim] ?? { sum: 0, n: 0 };
      entry.dims[dim]!.sum += Number(value);
      entry.dims[dim]!.n += 1;
    }
    byStudentTask.set(key, entry);
    sessionsByStudent.set(row.student_id, (sessionsByStudent.get(row.student_id) ?? 0) + 1);
  }

  const perStudent = new Map<string, { finals: Map<string, number>; dimAcc: Record<string, { sum: number; n: number }> }>();
  for (const [key, entry] of byStudentTask) {
    const [studentId, taskId] = key.split("|") as [string, string];
    const final = Math.round(entry.totals.reduce((sum, value) => sum + value, 0) / entry.totals.length);
    const bucket =
      perStudent.get(studentId) ??
      { finals: new Map<string, number>(), dimAcc: {} as Record<string, { sum: number; n: number }> };
    bucket.finals.set(taskId, final);
    for (const dim of dimIds) {
      const acc = entry.dims[dim];
      if (!acc || acc.n === 0) continue;
      bucket.dimAcc[dim] = bucket.dimAcc[dim] ?? { sum: 0, n: 0 };
      bucket.dimAcc[dim]!.sum += acc.sum / acc.n;
      bucket.dimAcc[dim]!.n += 1;
    }
    perStudent.set(studentId, bucket);
  }

  const byStudent = new Map<string, StudentAggregate>();
  const distribution = [0, 0, 0, 0, 0];
  const radarAcc: Record<string, { sum: number; n: number }> = {};
  for (const [studentId, bucket] of perStudent) {
    const finals = [...bucket.finals.values()];
    const composite = Math.round(finals.reduce((sum, value) => sum + value, 0) / finals.length);
    const dims: Record<string, number | null> = {};
    for (const dim of dimIds) {
      const acc = bucket.dimAcc[dim];
      dims[dim] = acc && acc.n > 0 ? Math.round(acc.sum / acc.n) : null;
      if (dims[dim] != null) {
        radarAcc[dim] = radarAcc[dim] ?? { sum: 0, n: 0 };
        radarAcc[dim]!.sum += dims[dim]!;
        radarAcc[dim]!.n += 1;
      }
    }
    byStudent.set(studentId, {
      sessions: sessionsByStudent.get(studentId) ?? 0,
      taskFinals: bucket.finals,
      composite,
      dims,
    });
    const slot = composite < 60 ? 0 : composite < 70 ? 1 : composite < 80 ? 2 : composite < 90 ? 3 : 4;
    distribution[slot] = (distribution[slot] ?? 0) + 1;
  }

  const radar = ASSESSMENT_DIMENSIONS.map((dim) => ({
    id: dim.id,
    label: dim.label,
    value: radarAcc[dim.id]?.n ? Math.round(radarAcc[dim.id]!.sum / radarAcc[dim.id]!.n) : null,
  }));
  const composites = [...byStudent.values()].map((entry) => entry.composite);
  return {
    byStudent,
    distribution,
    radar,
    averageScore: composites.length
      ? Math.round(composites.reduce((sum, value) => sum + value, 0) / composites.length)
      : null,
    studentCount: byStudent.size,
  };
}

export function registerTeacherRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
): void {
  // 数据总览：核心指标 + 成绩分布 + 能力薄弱项
  // 口径：任务 = 考核单位。会话评分是过程数据；任务成绩 = 任务下已评会话均分；
  // 「全部任务综合」= 每名学生各任务成绩的平均（一人一个样本）；可按 taskId 查看单个任务。
  // 自由练习（无任务会话）不评分，天然不进入统计。
  app.get<{ Querystring: { taskId?: string } }>(
    "/v1/teacher/overview",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const baseParams = isAdmin ? [] : [user.sub];
      const students = scopedStudentsSql(isAdmin);
      const taskId = request.query.taskId?.trim() || null;
      const statParams: unknown[] = [...baseParams];
      let taskFilter = "";
      if (taskId) {
        statParams.push(taskId);
        taskFilter = ` and c.task_id = $${statParams.length}`;
      }

      const [heads, progress, assessed] = await Promise.all([
        db.query(
          `select
             (select count(distinct c.student_id) from conversations c where c.student_id in (${students})) as active_students,
             (select count(*) from users where role = 'student' and id in (${students})) as total_students,
             (select count(*) from conversation_messages m join conversations c on c.id = m.conversation_id
              where c.student_id in (${students})) as total_messages`,
          baseParams,
        ),
        db.query(
          `select count(*) filter (where tp.status = 'done') as done, count(*) as total
           from task_progress tp where tp.student_id in (${students})`,
          baseParams,
        ),
        db.query(
          `select a.student_id, a.total, a.scores, c.task_id
           from assessments a join conversations c on c.id = a.conversation_id
           where a.student_id in (${students}) and c.task_id is not null${taskFilter}`,
          statParams,
        ),
      ]);

      const stats = aggregateTaskCentric(assessed.rows as AssessedRow[]);

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
        averageScore: stats.averageScore,
        scoredStudents: stats.studentCount,
        distribution: stats.distribution,
        radar: stats.radar,
        weakDimensions: stats.radar
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
        `select c.id, c.persona, c.state, c.created_at, c.task_id, u.display_name as student_name, u.username,
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
        /* 挂起 = 学生已暂离的会话：近 10 分钟无任何消息，且不在"买家等待 30 分钟内"的可介入窗口。
           挂起会话不触发预警（学生不在线，介入无意义），前端折叠分组展示 */
        const suspended = !(idleSeconds < 600 || (row.last_sender === "buyer" && idleSeconds < 1800));
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
          // 自由练习（无任务）会话：可监控可介入，但不参与考核统计
          practice: !row.task_id,
          suspended,
          // 预警窗口：买家等待 3-30 分钟（学生大概率在线，介入有意义）
          alert: row.last_sender === "buyer" && idleSeconds >= 180 && idleSeconds < 1800,
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

  // 考核报表：任务口径（任务成绩 = 会话均分；学生综合 = 任务均分），支持班级 + 任务双筛选
  app.get<{ Querystring: { classId?: string; taskId?: string } }>(
    "/v1/teacher/reports",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const isAdmin = user.role === "admin";
      const classId = request.query.classId?.trim() || null;
      const taskId = request.query.taskId?.trim() || null;

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

      const params: unknown[] = isAdmin ? [] : [user.sub];
      let classFilter = "";
      if (classId) {
        params.push(classId);
        classFilter = ` and u.class_id = $${params.length}`;
      }
      /* 基线查询参数只到班级筛选为止（不含任务），先固化再追加任务参数 */
      const baselineParams = [...params];
      let taskFilter = "";
      if (taskId) {
        params.push(taskId);
        taskFilter = ` and c.task_id = $${params.length}`;
      }

      const result = await db.query(
        `select u.id as student_id, u.display_name, u.username, a.scores, a.total, c.task_id
         from assessments a
         join users u on u.id = a.student_id
         join conversations c on c.id = a.conversation_id
         where a.student_id in (${scopedStudentsSql(isAdmin)})${classFilter}
           and c.task_id is not null${taskFilter}
         order by a.created_at desc`,
        params,
      );

      /* 初始测评基线：用于训前 vs 当前对比 */
      const baselineResult = await db.query(
        `select b.student_id, b.scores, b.total
         from baseline_assessments b
         join users u on u.id = b.student_id
         where b.student_id in (${scopedStudentsSql(isAdmin)})${classFilter}`,
        baselineParams,
      );
      const baselineByStudent = new Map<string, number>();
      const baselineDims: Record<string, { sum: number; n: number }> = {};
      for (const row of baselineResult.rows) {
        baselineByStudent.set(row.student_id as string, Number(row.total));
        for (const [key, value] of Object.entries(row.scores as Record<string, number>)) {
          baselineDims[key] = baselineDims[key] ?? { sum: 0, n: 0 };
          baselineDims[key]!.sum += Number(value);
          baselineDims[key]!.n += 1;
        }
      }
      const baselineRadar = ASSESSMENT_DIMENSIONS.map((dim) => ({
        id: dim.id,
        label: dim.label,
        value: baselineDims[dim.id]?.n ? Math.round(baselineDims[dim.id]!.sum / baselineDims[dim.id]!.n) : null,
      }));

      const stats = aggregateTaskCentric(result.rows as AssessedRow[]);
      const names = new Map<string, { name: string; username: string }>();
      for (const row of result.rows) {
        if (!names.has(row.student_id as string)) {
          names.set(row.student_id as string, {
            name: row.display_name as string,
            username: row.username as string,
          });
        }
      }
      const ranking = [...stats.byStudent.entries()]
        .map(([studentId, entry]) => ({
          name: names.get(studentId)?.name ?? "-",
          username: names.get(studentId)?.username ?? "-",
          tasks: entry.taskFinals.size,
          sessions: entry.sessions,
          average: entry.composite,
          best: Math.max(...entry.taskFinals.values()),
          baseline: baselineByStudent.get(studentId) ?? null,
          dims: entry.dims,
        }))
        .sort((a, b) => b.average - a.average);

      return {
        distribution: stats.distribution,
        radar: stats.radar,
        baselineRadar,
        baselineCount: baselineResult.rowCount,
        ranking,
        assessedCount: result.rowCount,
        studentCount: stats.studentCount,
      };
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
      // 同步任务成绩：任务成绩 = 该任务下所有已评会话的均分，复核改分后重算
      const row = result.rows[0];
      await db.query(
        `update task_progress tp set score = sub.avg_total, updated_at = now()
         from conversations c,
           lateral (
             select round(avg(a.total))::int as avg_total
             from assessments a join conversations c2 on c2.id = a.conversation_id
             where c2.task_id = c.task_id and a.student_id = c.student_id
           ) sub
         where c.id = $1 and tp.task_id = c.task_id and tp.student_id = c.student_id`,
        [row.conversation_id],
      );
      await writeAudit(db, user.sub, "assessment.review", request.params.assessmentId, { total, comment });
      return { ok: true };
    },
  );
}
