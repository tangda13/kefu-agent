import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import {
  baselinePublicQuestions,
  gradeBaseline,
  validateBaselineAnswers,
  type BaselineAnswer,
} from "../baseline";

export function registerBaselineRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
): void {
  /* 测评状态：任务大厅横幅据此决定是否引导初始测评 */
  app.get(
    "/v1/student/baseline",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        "select scores, total, created_at from baseline_assessments where student_id = $1",
        [user.sub],
      );
      const row = result.rows[0];
      return {
        completed: Boolean(row),
        result: row
          ? { scores: row.scores, total: row.total, createdAt: row.created_at }
          : null,
      };
    },
  );

  /* 题目公开视图（不含答案） */
  app.get(
    "/v1/student/baseline/questions",
    { preHandler: guard.requireRole("student") },
    async () => ({ questions: baselinePublicQuestions() }),
  );

  app.post<{ Body: { answers?: Record<string, unknown> } }>(
    "/v1/student/baseline/submit",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const answers = request.body?.answers ?? {};
      const problem = validateBaselineAnswers(answers);
      if (problem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: problem };
      }
      const graded = gradeBaseline(answers as Record<string, BaselineAnswer>);
      const inserted = await db.query(
        `insert into baseline_assessments (student_id, answers, scores, total)
         values ($1, $2, $3, $4)
         on conflict (student_id) do nothing
         returning created_at`,
        [user.sub, JSON.stringify(answers), JSON.stringify(graded.scores), graded.total],
      );
      if (inserted.rows.length === 0) {
        reply.code(409);
        return { code: "ALREADY_COMPLETED", message: "初始测评已完成，不能重复提交。" };
      }
      await writeAudit(db, user.sub, "baseline.submit", user.sub, { total: graded.total });
      return {
        scores: graded.scores,
        total: graded.total,
        createdAt: inserted.rows[0].created_at,
      };
    },
  );
}
