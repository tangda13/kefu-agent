import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { teacherOwnsClass, writeAudit } from "../auth-context";
import { generateTemporaryPassword, hashPassword, passwordPolicyError } from "../security";
import { clearLoginFailures } from "../login-throttle";

interface ImportStudentRow {
  username?: string;
  displayName?: string;
  password?: string;
}

/** 给定 id 是否全部为教师账号（空数组为真） */
async function allTeachers(db: Db, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const result = await db.query<{ n: number }>(
    "select count(*)::int as n from users where id = any($1::uuid[]) and role = 'teacher'",
    [ids],
  );
  return result.rows[0]?.n === new Set(ids).size;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 连记录一起删之前先备份一次（D-86），备份失败就不删；测试换成假的，免得备份到开发库、按测试库的份数删掉开发备份 */
export type BackupBeforeDelete = (db: Db) => Promise<{ fileName: string }>;
const realBackup: BackupBeforeDelete = async (db) => (await import("./admin")).performBackup(db);

/** 确认文字：输入的学号 / 班级名和目标一致（不区分大小写、忽略首尾空格） */
const confirmed = (input: string | undefined, expected: string) =>
  Boolean(input) && input!.trim().toLowerCase() === expected.trim().toLowerCase();

interface StudentRow {
  id: string;
  username: string;
  display_name: string;
  status: "active" | "disabled";
  class_id: string | null;
}

async function loadStudent(db: Db, studentId: string): Promise<StudentRow | null> {
  if (!UUID_RE.test(studentId)) return null;
  const result = await db.query<StudentRow>(
    "select id, username, display_name, status, class_id from users where id = $1 and role = 'student'",
    [studentId],
  );
  return result.rows[0] ?? null;
}

/**
 * 学生进入某班（导入或转班）后补齐该班已下发的任务进度。
 * 原班任务中还没开始的进度删掉；已开始/已完成的保留，作为历史成绩。
 */
async function syncStudentTasks(db: Db, studentId: string, classId: string): Promise<void> {
  await db.query(
    `delete from task_progress tp
     where tp.student_id = $1 and tp.status = 'todo'
       and not exists (select 1 from task_classes tc where tc.task_id = tp.task_id and tc.class_id = $2)`,
    [studentId, classId],
  );
  await db.query(
    `insert into task_progress (task_id, student_id)
     select tc.task_id, $1 from task_classes tc where tc.class_id = $2
     on conflict do nothing`,
    [studentId, classId],
  );
}

export function registerClassRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  backup: BackupBeforeDelete = realBackup,
): void {
  const backupBeforeDelete = async () => (await backup(db)).fileName;

  // 管理端：新增教师账号（ADM-03 的阶段1最小集）
  app.post<{ Body: { username?: string; displayName?: string; password?: string } }>(
    "/v1/admin/teachers",
    { preHandler: guard.requireRole("admin") },
    async (request, reply) => {
      const { password } = request.body ?? {};
      const username = request.body?.username?.trim();
      const displayName = request.body?.displayName?.trim();
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

  /* 删除教师（D-87）：名下的班级（班主任、任课授权）、建的任务、发的公告、复核记录都转给接手教师，再删账号；
     名下什么都没有的直接删。不转交的话：班主任和任务引用会挡住删除，公告会被级联删掉，复核人会变空 */
  app.delete<{ Params: { teacherId: string }; Querystring: { successorId?: string } }>(
    "/v1/admin/teachers/:teacherId",
    { preHandler: guard.requireRole("admin") },
    async (request, reply) => {
      const { teacherId } = request.params;
      const successorId = request.query.successorId?.trim() || null;
      if (!UUID_RE.test(teacherId)) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "教师不存在。" };
      }
      const teacher = (await db.query<{ username: string; display_name: string }>(
        "select username, display_name from users where id = $1 and role = 'teacher'",
        [teacherId],
      )).rows[0];
      if (!teacher) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "教师不存在。" };
      }
      const owned = (await db.query<{ classes: number; tasks: number; notices: number }>(
        `select (select count(*)::int from classes where head_teacher_id = $1)
              + (select count(*)::int from teacher_classes where teacher_id = $1) as classes,
                (select count(*)::int from tasks where created_by = $1) as tasks,
                (select count(*)::int from announcements where publisher_id = $1) as notices`,
        [teacherId],
      )).rows[0]!;
      const hasWork = owned.classes + owned.tasks + owned.notices > 0;
      if (hasWork) {
        if (!successorId) {
          reply.code(409);
          return {
            code: "TEACHER_HAS_WORK",
            message: "该教师名下还有班级或任务，请选择接手的教师。",
            ...owned,
          };
        }
        const successor = UUID_RE.test(successorId) && successorId !== teacherId
          ? (await db.query("select 1 from users where id = $1 and role = 'teacher' and status = 'active'", [successorId])).rowCount
          : 0;
        if (!successor) {
          reply.code(400);
          return { code: "INVALID_SUCCESSOR", message: "接手的教师不存在或已停用。" };
        }
      }
      const client = await db.connect();
      try {
        await client.query("begin");
        if (hasWork) {
          await client.query("update classes set head_teacher_id = $2 where head_teacher_id = $1", [teacherId, successorId]);
          await client.query(
            `insert into teacher_classes (teacher_id, class_id)
             select $2, class_id from teacher_classes where teacher_id = $1
             on conflict do nothing`,
            [teacherId, successorId],
          );
          // 接手人成了班主任的班，不必再留一条任课授权（I5 口径：班主任只记在 classes 上）
          await client.query(
            "delete from teacher_classes tc using classes c where tc.class_id = c.id and tc.teacher_id = $1 and c.head_teacher_id = $1",
            [successorId],
          );
          await client.query("update tasks set created_by = $2 where created_by = $1", [teacherId, successorId]);
          await client.query("update announcements set publisher_id = $2 where publisher_id = $1", [teacherId, successorId]);
          await client.query("update assessments set reviewed_by = $2 where reviewed_by = $1", [teacherId, successorId]);
        }
        await client.query("delete from users where id = $1 and role = 'teacher'", [teacherId]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      guard.invalidateAccount(teacherId);
      await writeAudit(db, request.user!.sub, "admin.delete_teacher", teacherId, { username: teacher.username, successorId, ...owned });
      return { ok: true, transferred: hasWork ? owned : null };
    },
  );

  /* 建班：教师建班自己就是班主任；管理员建班可同时指定班主任（也可稍后在「班级与授权」里指定）。
     口径：班主任只记 classes.head_teacher_id，teacher_classes 只放授权任课教师（I5） */
  app.post<{ Body: { name?: string; headTeacherId?: string | null } }>(
    "/v1/classes",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { name } = request.body ?? {};
      if (!name?.trim()) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写班级名称。" };
      }
      const user = request.user!;
      const headTeacherId = user.role === "teacher" ? user.sub : request.body?.headTeacherId || null;
      if (headTeacherId && user.role === "admin" && !(await allTeachers(db, [headTeacherId]))) {
        reply.code(400);
        return { code: "INVALID_TEACHER", message: "指定的班主任不存在或不是教师账号。" };
      }
      try {
        const result = await db.query(
          `insert into classes (name, head_teacher_id) values ($1, $2) returning id, name, created_at`,
          [name.trim(), headTeacherId],
        );
        const created = result.rows[0];
        await writeAudit(db, user.sub, "class.create", created.id, { name, headTeacherId });
        return { id: created.id, name: created.name, headTeacherId, createdAt: created.created_at };
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

  /* 删除班级：空班级直接删；还有学生的，输入班级名确认后连学生和他们的实训记录一起删，删之前先自动备份（D-86） */
  app.delete<{ Params: { classId: string }; Querystring: { confirm?: string } }>(
    "/v1/classes/:classId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { classId } = request.params;
      const user = request.user!;
      if (!UUID_RE.test(classId)) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "班级不存在。" };
      }
      if (!(await teacherOwnsClass(db, user, classId))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该班级。" };
      }
      const klass = (await db.query<{ name: string; students: number }>(
        "select name, (select count(*)::int from users where class_id = $1 and role = 'student') as students from classes where id = $1",
        [classId],
      )).rows[0];
      if (!klass) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "班级不存在。" };
      }
      let backup: string | null = null;
      if (klass.students > 0) {
        if (!confirmed(request.query.confirm, klass.name)) {
          reply.code(409);
          return { code: "CLASS_NOT_EMPTY", message: `班级里还有 ${klass.students} 名学生，确认连学生和他们的实训记录一起删除，请输入班级名。`, students: klass.students };
        }
        try {
          backup = await backupBeforeDelete();
        } catch (error) {
          request.log.error(error, "backup before class delete failed");
          reply.code(503);
          return { code: "BACKUP_FAILED", message: "删除前自动备份没成功，这次没有删除，请稍后再试或联系管理员。" };
        }
      }
      const client = await db.connect();
      let removed: string[] = [];
      try {
        await client.query("begin");
        // 学生的会话、评分、邮件等都随账号级联删除
        removed = (await client.query<{ id: string }>("delete from users where class_id = $1 and role = 'student' returning id", [classId])).rows.map((row) => row.id);
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
      for (const id of removed) guard.invalidateAccount(id);
      await writeAudit(db, user.sub, "class.delete", classId, { name: klass.name, students: removed.length, backup });
      return { ok: true, students: removed.length, backup };
    },
  );

  /* 学生编辑（I8）：启用/停用、改姓名、转班，字段可单独传。
     停用后无法登录，会话数据保留；转班要求对原班和目标班都有授权 */
  app.patch<{ Params: { studentId: string }; Body: { status?: string; displayName?: string; classId?: string } }>(
    "/v1/students/:studentId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { studentId } = request.params;
      const user = request.user!;
      const { status, classId } = request.body ?? {};
      const displayName = request.body?.displayName?.trim();
      if (status !== undefined && status !== "active" && status !== "disabled") {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "状态只能是 active 或 disabled。" };
      }
      if (request.body?.displayName !== undefined && (!displayName || displayName.length > 50)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "姓名不能为空，且不超过 50 个字。" };
      }
      if (classId !== undefined && !UUID_RE.test(classId)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "目标班级不正确。" };
      }
      if (status === undefined && displayName === undefined && classId === undefined) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "没有要修改的内容。" };
      }
      const student = await loadStudent(db, studentId);
      if (!student) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "学生不存在。" };
      }
      if (!student.class_id || !(await teacherOwnsClass(db, user, student.class_id))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该学生。" };
      }
      const moving = classId !== undefined && classId !== student.class_id;
      if (moving) {
        const target = await db.query("select 1 from classes where id = $1", [classId]);
        if (!target.rowCount) {
          reply.code(404);
          return { code: "NOT_FOUND", message: "目标班级不存在。" };
        }
        if (!(await teacherOwnsClass(db, user, classId))) {
          reply.code(403);
          return { code: "FORBIDDEN", message: "您未被授权管理目标班级。" };
        }
      }
      await db.query(
        `update users set status = coalesce($1, status), display_name = coalesce($2, display_name),
                          class_id = coalesce($3, class_id), updated_at = now(),
                          group_name = case when $3::uuid is null then group_name else null end
         where id = $4`,
        [status ?? null, displayName ?? null, moving ? classId : null, studentId],
      );
      if (status === "disabled") {
        await db.query(
          "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
          [studentId],
        );
      }
      if (moving) await syncStudentTasks(db, studentId, classId!);
      guard.invalidateAccount(studentId);
      await writeAudit(db, user.sub, "student.update", studentId, {
        status,
        displayName,
        ...(moving ? { fromClassId: student.class_id, toClassId: classId } : {}),
      });
      return { id: studentId, status: status ?? student.status, displayName: displayName ?? student.display_name, classId: moving ? classId : student.class_id };
    },
  );

  /* 删除学生：没练过的直接删；有实训记录的，输入学号确认后连记录一起删，删之前先自动备份（D-86，原 I8 只允许停用） */
  app.delete<{ Params: { studentId: string }; Querystring: { confirm?: string } }>(
    "/v1/students/:studentId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { studentId } = request.params;
      const user = request.user!;
      const student = await loadStudent(db, studentId);
      if (!student) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "学生不存在。" };
      }
      if (!student.class_id || !(await teacherOwnsClass(db, user, student.class_id))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该学生。" };
      }
      const usage = await db.query<{ n: number }>(
        `select (select count(*) from conversations where student_id = $1)
              + (select count(*) from mail_submissions where student_id = $1)
              + (select count(*) from baseline_assessments where student_id = $1) as n`,
        [studentId],
      );
      const records = Number(usage.rows[0]?.n ?? 0);
      let backup: string | null = null;
      if (records > 0) {
        if (!confirmed(request.query.confirm, student.username)) {
          reply.code(409);
          return { code: "STUDENT_HAS_DATA", message: `该学生已有 ${records} 条实训记录，确认连记录一起删除，请输入学号。`, records };
        }
        try {
          backup = await backupBeforeDelete();
        } catch (error) {
          request.log.error(error, "backup before student delete failed");
          reply.code(503);
          return { code: "BACKUP_FAILED", message: "删除前自动备份没成功，这次没有删除，请稍后再试或联系管理员。" };
        }
      }
      // 会话、评分、邮件、话术等都随账号级联删除
      await db.query("delete from users where id = $1 and role = 'student'", [studentId]);
      guard.invalidateAccount(studentId);
      await writeAudit(db, user.sub, "student.delete", studentId, { username: student.username, classId: student.class_id, records, backup });
      return { ok: true, records, backup };
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
        `select c.id, c.name, c.head_teacher_id, c.created_at, h.display_name as head_teacher_name,
                (select count(*) from users u where u.class_id = c.id and u.role = 'student') as student_count,
                (select count(*) from users u where u.class_id = c.id and u.role = 'student' and u.status = 'active' and u.must_change_password) as pending_password_count,
                coalesce((select json_agg(json_build_object('id', t.id, 'displayName', t.display_name) order by t.display_name)
                          from teacher_classes tc join users t on t.id = tc.teacher_id
                          where tc.class_id = c.id), '[]') as teachers
         from classes c
         left join users h on h.id = c.head_teacher_id
         ${scopeFilter}
         order by c.created_at desc`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        headTeacherId: row.head_teacher_id,
        headTeacherName: row.head_teacher_name ?? null,
        teachers: row.teachers as Array<{ id: string; displayName: string }>,
        studentCount: Number(row.student_count),
        /* D-35：待改密的账号数（班级清单角标） */
        pendingPasswordCount: Number(row.pending_password_count ?? 0),
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
      // D8：名单带统计列。平均分按任务口径：先算每个任务的会话均分（取整成任务成绩，和考核报表 aggregateTaskCentric 一致），再对任务求平均（自由练习不计）
      const result = await db.query(
        `select u.id, u.username, u.display_name, u.status, u.must_change_password, u.created_at, u.group_name,
                (select count(*) from task_progress tp where tp.student_id = u.id) as tasks_total,
                (select count(*) from task_progress tp where tp.student_id = u.id and tp.status = 'done') as tasks_done,
                (select round(avg(t.score)) from (
                   select round(avg(a.total)) as score from assessments a join conversations c on c.id = a.conversation_id
                   where a.student_id = u.id and c.task_id is not null group by c.task_id
                 ) t) as average_score,
                (select max(m.created_at) from conversation_messages m join conversations c on c.id = m.conversation_id
                 where c.student_id = u.id and m.sender = 'student') as last_active_at
         from users u where u.class_id = $1 and u.role = 'student'
         order by u.username`,
        [classId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        status: row.status,
        mustChangePassword: row.must_change_password,
        createdAt: row.created_at,
        groupName: row.group_name ?? null,
        tasksTotal: Number(row.tasks_total),
        tasksDone: Number(row.tasks_done),
        averageScore: row.average_score == null ? null : Number(row.average_score),
        lastActiveAt: row.last_active_at ?? null,
      }));
    },
  );

  /* 参数 2.2.3（D-63）：学生详情里的参训任务——每个下发给他的任务的完成状态和成绩。
     成绩 = 这个任务下已评会话的均分，和考核报表的任务成绩同一口径 */
  app.get<{ Params: { studentId: string } }>(
    "/v1/students/:studentId/tasks",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const student = await loadStudent(db, request.params.studentId);
      if (!student) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "学生不存在。" };
      }
      if (!student.class_id || !(await teacherOwnsClass(db, request.user!, student.class_id))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该学生。" };
      }
      const result = await db.query(
        `select t.id, t.name, t.business_stage, t.status, t.start_at, t.deadline, tp.status as progress,
                (select round(avg(a.total)) from assessments a join conversations c on c.id = a.conversation_id
                 where a.student_id = tp.student_id and c.task_id = t.id) as score,
                (select count(*) from conversations c where c.task_id = t.id and c.student_id = tp.student_id)::int as conversations
         from task_progress tp join tasks t on t.id = tp.task_id
         where tp.student_id = $1
         order by t.created_at desc`,
        [student.id],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        businessStage: row.business_stage,
        taskStatus: row.status,
        startAt: row.start_at ?? null,
        deadline: row.deadline ?? null,
        progress: row.progress as "todo" | "in_progress" | "done",
        score: row.score == null ? null : Number(row.score),
        conversations: Number(row.conversations),
      }));
    },
  );

  // D8：把若干学生分到一个组（groupName 为空 = 移出分组）
  app.put<{ Params: { classId: string }; Body: { studentIds?: string[]; groupName?: string | null } }>(
    "/v1/classes/:classId/groups",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { classId } = request.params;
      if (!(await teacherOwnsClass(db, request.user!, classId))) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "您未被授权管理该班级。" };
      }
      const ids = Array.isArray(request.body?.studentIds) ? request.body!.studentIds.filter((id) => UUID_RE.test(id)) : [];
      const groupName = request.body?.groupName?.trim() || null;
      if (ids.length === 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请先选择学生。" };
      }
      if (groupName && groupName.length > 20) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "组名不超过 20 个字。" };
      }
      const result = await db.query(
        "update users set group_name = $1, updated_at = now() where class_id = $2 and role = 'student' and id = any($3::uuid[])",
        [groupName, classId, ids],
      );
      await writeAudit(db, request.user!.sub, "class.group", classId, { groupName, count: result.rowCount });
      return { updated: result.rowCount ?? 0 };
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
        const policyError = row.password ? passwordPolicyError(row.password) : null;
        if (policyError) {
          failed.push({ username, reason: policyError });
          continue;
        }
        const initialPassword = row.password ?? generateTemporaryPassword();
        const passwordHash = await hashPassword(initialPassword);
        try {
          const inserted = await db.query<{ id: string }>(
            `insert into users (username, password_hash, display_name, role, class_id, must_change_password)
             values ($1, $2, $3, 'student', $4, $5) returning id`,
            [username, passwordHash, displayName, classId, !row.password],
          );
          // 该班已下发的任务，新导入的学生也要看到
          await syncStudentTasks(db, inserted.rows[0]!.id, classId);
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
        "select id, username, class_id from users where id = $1 and role = 'student'",
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
      await clearLoginFailures(db, student.username);
      guard.invalidateAccount(studentId);
      await writeAudit(db, user.sub, "student.reset_password", studentId);
      return { temporaryPassword };
    },
  );

  /* 管理端：指定/更换班主任 + 授权任课教师（I4）。整体覆盖：teacherIds 即该班全部任课教师，
     班主任若也出现在 teacherIds 里会被剔除（口径见建班接口）。headTeacherId 传 null 表示暂不设班主任 */
  app.put<{ Params: { classId: string }; Body: { headTeacherId?: string | null; teacherIds?: string[] } }>(
    "/v1/admin/classes/:classId/teachers",
    { preHandler: guard.requireRole("admin") },
    async (request, reply) => {
      const { classId } = request.params;
      const headTeacherId = request.body?.headTeacherId || null;
      const rawIds = request.body?.teacherIds ?? [];
      if (!UUID_RE.test(classId) || !Array.isArray(rawIds) || ![headTeacherId, ...rawIds].every((id) => id === null || UUID_RE.test(String(id)))) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "参数格式不正确。" };
      }
      const teacherIds = [...new Set(rawIds)].filter((id) => id !== headTeacherId);
      if (!(await allTeachers(db, headTeacherId ? [headTeacherId, ...teacherIds] : teacherIds))) {
        reply.code(400);
        return { code: "INVALID_TEACHER", message: "所选账号中有不存在或不是教师的账号。" };
      }
      const client = await db.connect();
      try {
        await client.query("begin");
        const updated = await client.query(
          "update classes set head_teacher_id = $1 where id = $2",
          [headTeacherId, classId],
        );
        if (!updated.rowCount) {
          await client.query("rollback");
          reply.code(404);
          return { code: "NOT_FOUND", message: "班级不存在。" };
        }
        await client.query("delete from teacher_classes where class_id = $1", [classId]);
        if (teacherIds.length > 0) {
          await client.query(
            `insert into teacher_classes (teacher_id, class_id)
             select unnest($1::uuid[]), $2`,
            [teacherIds, classId],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await writeAudit(db, request.user!.sub, "class.assign_teachers", classId, { headTeacherId, teacherIds });
      return { id: classId, headTeacherId, teacherIds };
    },
  );
}
