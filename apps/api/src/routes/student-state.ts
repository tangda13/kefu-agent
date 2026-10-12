import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { teacherOwnsClass } from "../auth-context";

/**
 * 学生端状态上云（K1–K4）：评价回复记录、邮件草稿、已读标记。
 * 以前存在客户端 localStorage，换机器即丢失，教师也看不到；现在全部以云端为准。
 */

const READ_KINDS = new Set(["mail", "guidance"]);
const MAX_DRAFTS = 50;
const MAX_TEXT = 20_000;

interface ReplyRow {
  order_id: string;
  text: string;
  created_at: string;
}

/** 每个订单取最近一次回复，组装成 { orderId: { text, at } } */
function latestByOrder(rows: ReplyRow[]): Record<string, { text: string; at: string }> {
  const map: Record<string, { text: string; at: string }> = {};
  for (const row of rows) {
    if (!map[row.order_id]) map[row.order_id] = { text: row.text, at: row.created_at };
  }
  return map;
}

export function registerStudentStateRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
): void {
  /* ---------- K1 评价回复记录 ---------- */

  app.get("/v1/student/review-replies", { preHandler: guard.requireRole("student") }, async (request) => {
    const result = await db.query<ReplyRow>(
      `select order_id, text, created_at from review_replies
       where student_id = $1 order by created_at desc`,
      [request.user!.sub],
    );
    return latestByOrder(result.rows);
  });

  app.post<{ Body: { orderId?: string; text?: string; at?: string } }>(
    "/v1/student/review-replies",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const { orderId } = request.body ?? {};
      const text = request.body?.text?.trim();
      if (!orderId || !text || text.length > MAX_TEXT) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "回复内容不能为空。" };
      }
      // at 仅供旧版本机记录迁移时保留原时间；不得晚于当前时间
      const at = request.body?.at && !Number.isNaN(Date.parse(request.body.at)) && Date.parse(request.body.at) <= Date.now()
        ? request.body.at
        : null;
      const result = await db.query<{ created_at: string }>(
        `insert into review_replies (student_id, order_id, text, created_at)
         select $1, o.id, $3, coalesce($4::timestamptz, now())
         from orders o where o.id::text = $2 and o.student_id = $1
         returning created_at`,
        [request.user!.sub, orderId, text, at],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "订单不存在。" };
      }
      return { orderId, text, at: result.rows[0]!.created_at };
    },
  );

  // 教师查看某学生的评价回复（授权班级内）
  app.get<{ Params: { studentId: string } }>(
    "/v1/students/:studentId/review-replies",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const student = await db.query<{ class_id: string | null }>(
        "select class_id from users where id::text = $1 and role = 'student'",
        [request.params.studentId],
      );
      const classId = student.rows[0]?.class_id;
      if (!classId || !(await teacherOwnsClass(db, request.user!, classId))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权查看该学生。" };
      }
      const result = await db.query<ReplyRow & { order_no: string }>(
        `select r.order_id, r.text, r.created_at, o.order_no
         from review_replies r join orders o on o.id = r.order_id
         where r.student_id = $1 order by r.created_at desc limit 200`,
        [request.params.studentId],
      );
      return result.rows.map((row) => ({
        orderId: row.order_id,
        orderNo: row.order_no,
        text: row.text,
        at: row.created_at,
      }));
    },
  );

  /* ---------- K2 邮件草稿 ---------- */

  app.get("/v1/student/mail-drafts", { preHandler: guard.requireRole("student") }, async (request) => {
    const result = await db.query(
      `select id, recipient, subject, body, template_id, saved_at from mail_drafts
       where student_id = $1 order by saved_at desc limit ${MAX_DRAFTS}`,
      [request.user!.sub],
    );
    return result.rows.map((row) => ({
      id: row.id,
      to: row.recipient,
      subject: row.subject,
      body: row.body,
      templateId: row.template_id,
      savedAt: row.saved_at,
    }));
  });

  app.put<{
    Params: { draftId: string };
    Body: { to?: string; subject?: string; body?: string; templateId?: string | null; savedAt?: string };
  }>(
    "/v1/student/mail-drafts/:draftId",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const { draftId } = request.params;
      const { to = "", subject = "", body = "", templateId = null } = request.body ?? {};
      if (!/^[\w-]{1,64}$/.test(draftId) || [to, subject, body].some((field) => typeof field !== "string" || field.length > MAX_TEXT)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "草稿内容不正确。" };
      }
      const savedAt = request.body?.savedAt && !Number.isNaN(Date.parse(request.body.savedAt)) && Date.parse(request.body.savedAt) <= Date.now()
        ? request.body.savedAt
        : null;
      const result = await db.query<{ saved_at: string }>(
        `insert into mail_drafts (student_id, id, recipient, subject, body, template_id, saved_at)
         values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
         on conflict (student_id, id) do update set
           recipient = excluded.recipient, subject = excluded.subject, body = excluded.body,
           template_id = excluded.template_id, saved_at = excluded.saved_at
         returning saved_at`,
        [request.user!.sub, draftId, to, subject, body, templateId, savedAt],
      );
      // 只保留最近 MAX_DRAFTS 份
      await db.query(
        `delete from mail_drafts where student_id = $1 and id not in (
           select id from mail_drafts where student_id = $1 order by saved_at desc limit ${MAX_DRAFTS}
         )`,
        [request.user!.sub],
      );
      return { id: draftId, to, subject, body, templateId, savedAt: result.rows[0]!.saved_at };
    },
  );

  app.delete<{ Params: { draftId: string } }>(
    "/v1/student/mail-drafts/:draftId",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      await db.query("delete from mail_drafts where student_id = $1 and id = $2", [
        request.user!.sub,
        request.params.draftId,
      ]);
      return { ok: true };
    },
  );

  /* ---------- K3/K4 已读标记（邮件 / 教师指导） ---------- */

  app.get<{ Querystring: { kind?: string } }>(
    "/v1/me/read-marks",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const kind = request.query.kind ?? "";
      if (!READ_KINDS.has(kind)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "kind 只能是 mail 或 guidance。" };
      }
      const result = await db.query<{ item_id: string }>(
        "select item_id from read_marks where user_id = $1 and kind = $2",
        [request.user!.sub, kind],
      );
      return result.rows.map((row) => row.item_id);
    },
  );

  app.post<{ Body: { kind?: string; ids?: string[] } }>(
    "/v1/me/read-marks",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const kind = request.body?.kind ?? "";
      const ids = request.body?.ids;
      if (
        !READ_KINDS.has(kind) ||
        !Array.isArray(ids) ||
        ids.length > 500 ||
        ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)
      ) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "已读标记参数不正确。" };
      }
      if (ids.length > 0) {
        await db.query(
          `insert into read_marks (user_id, kind, item_id)
           select $1, $2, unnest($3::text[])
           on conflict do nothing`,
          [request.user!.sub, kind, [...new Set(ids)]],
        );
      }
      return { ok: true };
    },
  );
}
