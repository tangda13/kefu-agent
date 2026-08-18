import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { teacherOwnsClass, writeAudit } from "../auth-context";
import { generateTemporaryPassword, hashPassword } from "../security";

interface ImportStudentRow {
  username?: string;
  displayName?: string;
  password?: string;
}

export function registerClassRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
): void {
  // 管理端：新增教师账号（ADM-03 的阶段1最小集）
  app.post<{ Body: { username?: string; displayName?: string; password?: string } }>(
    "/v1/admin/teachers",
    { preHandler: guard.requireRole("admin") },
    async (request, reply) => {
      const { username, displayName, password } = request.body ?? {};
      if (!username || !displayName) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写教师账号与姓名。" };
      }
      const initialPassword = password ?? generateTemporaryPassword();
      const passwordHash = await hashPassword(initialPassword);
      try {
        const result = await db.query(
          `insert into users (username, password_hash, display_name, role, must_change_password)
           values ($1, $2, $3, 'teacher', $4)
           returning id`,
          [username, passwordHash, displayName, !password],
        );
        await writeAudit(db, request.user!.sub, "admin.create_teacher", username);
        return {
          id: result.rows[0].id,
          username,
          displayName,
          initialPassword: password ? undefined : initialPassword,
        };
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "23505") {
          reply.code(409);
          return { code: "USERNAME_TAKEN", message: "该账号已存在。" };
        }
        throw error;
      }
    },
  );

  app.post<{ Body: { name?: string } }>(
    "/v1/classes",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { name } = request.body ?? {};
      if (!name?.trim()) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写班级名称。" };
      }
      const user = request.user!;
      const headTeacherId = user.role === "teacher" ? user.sub : null;
      try {
        const result = await db.query(
          `insert into classes (name, head_teacher_id) values ($1, $2) returning id, name, created_at`,
          [name.trim(), headTeacherId],
        );
        const created = result.rows[0];
        if (user.role === "teacher") {
          await db.query(
            "insert into teacher_classes (teacher_id, class_id) values ($1, $2) on conflict do nothing",
            [user.sub, created.id],
          );
        }
        await writeAudit(db, user.sub, "class.create", created.id, { name });
        return { id: created.id, name: created.name, createdAt: created.created_at };
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "23505") {
          reply.code(409);
          return { code: "CLASS_EXISTS", message: "同名班级已存在。" };
        }
        throw error;
      }
    },
  );

  /* 班级改名：仅授权教师或管理员 */
  app.patch<{ Params: { classId: string }; Body: { name?: string } }>(
    "/v1/classes/:classId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { classId } = request.params;
      const user = request.user!;
      const name = request.body?.name?.trim();
      if (!name) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写班级名称。" };
      }
      if (!(await teacherOwnsClass(db, user, classId))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该班级。" };
      }
      try {
        const result = await db.query(
          "update classes set name = $1 where id = $2 returning id, name",
          [name, classId],
        );
        if (!result.rowCount) {
          reply.code(404);
          return { code: "NOT_FOUND", message: "班级不存在。" };
        }
        await writeAudit(db, user.sub, "class.rename", classId, { name });
        return { id: classId, name };
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "23505") {
          reply.code(409);
          return { code: "CLASS_EXISTS", message: "同名班级已存在。" };
        }
        throw error;
      }
    },
  );

  /* 删除班级：仅允许删除没有学生的空班级，避免误删教学数据 */
  app.delete<{ Params: { classId: string } }>(
    "/v1/classes/:classId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { classId } = request.params;
      const user = request.user!;
      if (!(await teacherOwnsClass(db, user, classId))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该班级。" };
      }
      const students = await db.query(
        "select count(*)::int as n from users where class_id = $1 and role = 'student'",
        [classId],
      );
      if (students.rows[0].n > 0) {
        reply.code(409);
        return { code: "CLASS_NOT_EMPTY", message: "班级内仍有学生，请先转移或清空学生后再删除。" };
      }
      const client = await db.connect();
      try {
        await client.query("begin");
        await client.query("delete from task_classes where class_id = $1", [classId]);
        await client.query("delete from teacher_classes where class_id = $1", [classId]);
        await client.query("delete from announcements where class_id = $1", [classId]);
        await client.query("delete from classes where id = $1", [classId]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await writeAudit(db, user.sub, "class.delete", classId);
      return { ok: true };
    },
  );

  /* 学生禁用/启用：禁用后无法登录（登录校验 status），会话数据保留 */
  app.patch<{ Params: { studentId: string }; Body: { status?: string } }>(
    "/v1/students/:studentId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { studentId } = request.params;
      const user = request.user!;
      const status = request.body?.status;
      if (status !== "active" && status !== "disabled") {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "状态只能是 active 或 disabled。" };
      }
      const result = await db.query(
        "select id, class_id from users where id = $1 and role = 'student'",
        [studentId],
      );
      const student = result.rows[0];
      if (!student) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "学生不存在。" };
      }
      if (!student.class_id || !(await teacherOwnsClass(db, user, student.class_id))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该学生。" };
      }
      await db.query("update users set status = $1, updated_at = now() where id = $2", [status, studentId]);
      if (status === "disabled") {
        await db.query(
          "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
          [studentId],
        );
      }
      await writeAudit(db, user.sub, "student.status", studentId, { status });
      return { id: studentId, status };
    },
  );

  app.get(
    "/v1/classes",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const user = request.user!;
      const scopeFilter =
        user.role === "admin"
          ? ""
          : `where c.id in (
               select class_id from teacher_classes where teacher_id = $1
               union
               select id from classes where head_teacher_id = $1
             )`;
      const params = user.role === "admin" ? [] : [user.sub];
      const result = await db.query(
        `select c.id, c.name, c.head_teacher_id, c.created_at,
                (select count(*) from users u where u.class_id = c.id and u.role = 'student') as student_count
         from classes c ${scopeFilter}
         order by c.created_at desc`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        headTeacherId: row.head_teacher_id,
        studentCount: Number(row.student_count),
        createdAt: row.created_at,
      }));
    },
  );

  app.get<{ Params: { classId: string } }>(
    "/v1/classes/:classId/students",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { classId } = request.params;
      if (!(await teacherOwnsClass(db, request.user!, classId))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该班级。" };
      }
      const result = await db.query(
        `select id, username, display_name, status, must_change_password, created_at
         from users where class_id = $1 and role = 'student'
         order by username`,
        [classId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        status: row.status,
        mustChangePassword: row.must_change_password,
        createdAt: row.created_at,
      }));
    },
  );

  app.post<{ Params: { classId: string }; Body: { students?: ImportStudentRow[] } }>(
    "/v1/classes/:classId/students/import",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { classId } = request.params;
      const user = request.user!;
      if (!(await teacherOwnsClass(db, user, classId))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该班级。" };
      }
      const rows = request.body?.students ?? [];
      if (!Array.isArray(rows) || rows.length === 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "导入名单为空。" };
      }
      const created: Array<{ username: string; displayName: string; initialPassword?: string }> = [];
      const failed: Array<{ username: string; reason: string }> = [];
      for (const row of rows) {
        const username = row.username?.trim();
        const displayName = row.displayName?.trim();
        if (!username || !displayName) {
          failed.push({ username: username ?? "", reason: "缺少账号或姓名" });
          continue;
        }
        const initialPassword = row.password ?? generateTemporaryPassword();
        const passwordHash = await hashPassword(initialPassword);
        try {
          await db.query(
            `insert into users (username, password_hash, display_name, role, class_id, must_change_password)
             values ($1, $2, $3, 'student', $4, $5)`,
            [username, passwordHash, displayName, classId, !row.password],
          );
          created.push({
            username,
            displayName,
            initialPassword: row.password ? undefined : initialPassword,
          });
        } catch (error: unknown) {
          if ((error as { code?: string }).code === "23505") {
            failed.push({ username, reason: "账号已存在" });
          } else {
            throw error;
          }
        }
      }
      await writeAudit(db, user.sub, "class.import_students", classId, {
        created: created.length,
        failed: failed.length,
      });
      return { created, failed };
    },
  );

  app.post<{ Params: { studentId: string } }>(
    "/v1/students/:studentId/reset-password",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { studentId } = request.params;
      const user = request.user!;
      const result = await db.query(
        "select id, class_id from users where id = $1 and role = 'student'",
        [studentId],
      );
      const student = result.rows[0];
      if (!student) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "学生不存在。" };
      }
      if (
        !student.class_id ||
        !(await teacherOwnsClass(db, user, student.class_id))
      ) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该学生。" };
      }
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      await db.query(
        `update users set password_hash = $1, must_change_password = true, updated_at = now()
         where id = $2`,
        [passwordHash, studentId],
      );
      await db.query(
        "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
        [studentId],
      );
      await writeAudit(db, user.sub, "student.reset_password", studentId);
      return { temporaryPassword };
    },
  );
}
