import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, resetDatabase, type Db } from "./db";
import { buildServer } from "./server";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://cecs:cecs_dev_2026@127.0.0.1:5434/cecs_test";

let db: Db;
let app: FastifyInstance;

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; mustChangePassword: boolean };
}

async function login(username: string, password: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function auth(session: Session) {
  return { authorization: `Bearer ${session.accessToken}` };
}

beforeAll(async () => {
  db = createPool(TEST_DATABASE_URL);
  await db.query("drop schema public cascade; create schema public;");
  app = await buildServer({
    db,
    logger: false,
    env: {
      jwtSecret: "test-secret",
      adminInitialPassword: "Admin#Test1",
    },
  });
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe("阶段1：认证", () => {
  it("管理员初始密码登录并强制改密", async () => {
    const session = await login("admin", "Admin#Test1");
    expect(session.user.mustChangePassword).toBe(true);

    const change = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: auth(session),
      payload: { currentPassword: "Admin#Test1", newPassword: "Admin#Prod9" },
    });
    expect(change.statusCode).toBe(200);

    const relogin = await login("admin", "Admin#Prod9");
    expect(relogin.user.mustChangePassword).toBe(false);
  });

  it("刷新令牌旋转：旧令牌二次使用被拒绝", async () => {
    const session = await login("admin", "Admin#Prod9");
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: session.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: session.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("未认证访问受保护接口返回 401", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/me" });
    expect(response.statusCode).toBe(401);
  });
});

describe("阶段1：教师建班、导入学生、下发任务的端到端链路", () => {
  let admin: Session;
  let teacher1: Session;
  let teacher2: Session;
  let classId: string;
  let studentTempPassword: string;
  let studentId: string;

  it("管理员创建两名教师", async () => {
    admin = await login("admin", "Admin#Prod9");
    for (const [username, displayName] of [
      ["teacher1", "王老师"],
      ["teacher2", "李老师"],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/teachers",
        headers: auth(admin),
        payload: { username, displayName, password: "Teach#2026" },
      });
      expect(response.statusCode).toBe(200);
    }
    teacher1 = await login("teacher1", "Teach#2026");
    teacher2 = await login("teacher2", "Teach#2026");
  });

  it("教师创建班级并批量导入学生", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/classes",
      headers: auth(teacher1),
      payload: { name: "跨境电商2501" },
    });
    expect(created.statusCode).toBe(200);
    classId = created.json().id;

    const imported = await app.inject({
      method: "POST",
      url: `/v1/classes/${classId}/students/import`,
      headers: auth(teacher1),
      payload: {
        students: [
          { username: "s2501001", displayName: "张三" },
          { username: "s2501002", displayName: "李四", password: "Stud#2026" },
          { username: "s2501001", displayName: "重复账号" },
        ],
      },
    });
    expect(imported.statusCode).toBe(200);
    const body = imported.json();
    expect(body.created).toHaveLength(2);
    expect(body.failed).toHaveLength(1);
    studentTempPassword = body.created[0].initialPassword;
    expect(studentTempPassword).toBeTruthy();

    const roster = await app.inject({
      method: "GET",
      url: `/v1/classes/${classId}/students`,
      headers: auth(teacher1),
    });
    expect(roster.json()).toHaveLength(2);
    studentId = roster.json()[0].id;
  });

  it("目录：8 个场景与 20 个画像已种子化", async () => {
    const scenarios = await app.inject({
      method: "GET",
      url: "/v1/catalog/scenarios",
      headers: auth(teacher1),
    });
    expect(scenarios.json()).toHaveLength(8);

    const personas = await app.inject({
      method: "GET",
      url: "/v1/catalog/personas",
      headers: auth(teacher1),
    });
    expect(personas.json().length).toBeGreaterThanOrEqual(20);
  });

  it("教师新建任务并下发到班级", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth(teacher1),
      payload: {
        name: "新品推广首训",
        businessStage: "pre_sale",
        scenarioIds: ["PRE-001", "PRE-002"],
        classIds: [classId],
        personaRule: { nationalityPool: ["美国", "德国"] },
        interactionMode: "text_voice",
        timeLimitMinutes: 30,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(Math.round(
      Object.values(response.json().scoringWeights as Record<string, number>)
        .reduce((a, b) => a + b, 0),
    )).toBe(100);

    const list = await app.inject({
      method: "GET",
      url: "/v1/tasks",
      headers: auth(teacher1),
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].studentTotal).toBe(2);
  });

  it("学生临时密码登录、强制改密后仅能看到本人任务", async () => {
    const first = await login("s2501001", studentTempPassword);
    expect(first.user.mustChangePassword).toBe(true);
    await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: auth(first),
      payload: {
        currentPassword: studentTempPassword,
        newPassword: "MyPass#01",
      },
    });
    const student = await login("s2501001", "MyPass#01");
    const tasks = await app.inject({
      method: "GET",
      url: "/v1/student/tasks",
      headers: auth(student),
    });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json()).toHaveLength(1);
    expect(tasks.json()[0].progressStatus).toBe("todo");

    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/classes",
      headers: auth(student),
      payload: { name: "越权班级" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("RBAC：未授权教师不可访问他人班级、学生与任务下发", async () => {
    const classes = await app.inject({
      method: "GET",
      url: "/v1/classes",
      headers: auth(teacher2),
    });
    expect(classes.json()).toHaveLength(0);

    const roster = await app.inject({
      method: "GET",
      url: `/v1/classes/${classId}/students`,
      headers: auth(teacher2),
    });
    expect(roster.statusCode).toBe(403);

    const reset = await app.inject({
      method: "POST",
      url: `/v1/students/${studentId}/reset-password`,
      headers: auth(teacher2),
    });
    expect(reset.statusCode).toBe(403);

    const task = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth(teacher2),
      payload: {
        name: "越权任务",
        businessStage: "pre_sale",
        scenarioIds: ["PRE-001"],
        classIds: [classId],
      },
    });
    expect(task.statusCode).toBe(403);
  });

  it("授权教师可重置学生密码，学生旧会话被吊销", async () => {
    const reset = await app.inject({
      method: "POST",
      url: `/v1/students/${studentId}/reset-password`,
      headers: auth(teacher1),
    });
    expect(reset.statusCode).toBe(200);
    const { temporaryPassword } = reset.json();
    expect(temporaryPassword).toHaveLength(8);
    const relogin = await login("s2501001", temporaryPassword);
    expect(relogin.user.mustChangePassword).toBe(true);
  });

  it("任务校验：评分权重必须覆盖 6 维且合计 100", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth(teacher1),
      payload: {
        name: "权重非法任务",
        businessStage: "pre_sale",
        scenarioIds: ["PRE-001"],
        classIds: [classId],
        scoringWeights: { compliance: 100 },
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("账号安全与班级授权（I1–I6）+ 学生状态上云（K1–K4）", () => {
  let admin: Session;
  let teacher1: Session;
  let teacher2: Session;
  let student2: Session;
  let teacher2Id: string;
  let teacher1Id: string;
  let student2Id: string;
  let student2OrderId: string;

  async function changePassword(session: Session, current: string, next: string) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: auth(session),
      payload: { currentPassword: current, newPassword: next },
    });
    expect(response.statusCode).toBe(200);
  }

  it("I2：待改密账号只能调用改密和 /me，其余接口 403", async () => {
    admin = await login("admin", "Admin#Prod9");
    teacher1 = await login("teacher1", "Teach#2026");
    const classes = await app.inject({ method: "GET", url: "/v1/classes", headers: auth(teacher1) });
    const classId = classes.json()[0].id;
    const students = await app.inject({ method: "GET", url: `/v1/classes/${classId}/students`, headers: auth(teacher1) });
    const s1 = students.json().find((s: { username: string }) => s.username === "s2501001");
    student2Id = students.json().find((s: { username: string }) => s.username === "s2501002").id;
    const reset = await app.inject({ method: "POST", url: `/v1/students/${s1.id}/reset-password`, headers: auth(teacher1) });
    const pending = await login("s2501001", reset.json().temporaryPassword);

    const blocked = await app.inject({ method: "GET", url: "/v1/student/tasks", headers: auth(pending) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("PASSWORD_CHANGE_REQUIRED");
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(pending) });
    expect(me.statusCode).toBe(200);
  });

  it("I1：连续输错 5 次锁定，正确密码也被拒；教师重置后解锁", async () => {
    for (let i = 0; i < 5; i += 1) {
      const wrong = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "s2501002", password: "bad-pass" } });
      expect(wrong.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "s2501002", password: "Stud#2026" } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("LOGIN_LOCKED");

    const reset = await app.inject({ method: "POST", url: `/v1/students/${student2Id}/reset-password`, headers: auth(teacher1) });
    const temp = reset.json().temporaryPassword as string;
    const unlocked = await login("s2501002", temp);
    await changePassword(unlocked, temp, "Stud#2027");
    student2 = await login("s2501002", "Stud#2027");
  });

  it("I3：管理员重置教师密码，教师旧令牌立即进入待改密状态", async () => {
    teacher2 = await login("teacher2", "Teach#2026");
    const teachers = await app.inject({ method: "GET", url: "/v1/admin/teachers", headers: auth(admin) });
    teacher2Id = teachers.json().find((t: { username: string }) => t.username === "teacher2").id;
    teacher1Id = teachers.json().find((t: { username: string }) => t.username === "teacher1").id;

    const reset = await app.inject({ method: "POST", url: `/v1/admin/teachers/${teacher2Id}/reset-password`, headers: auth(admin) });
    expect(reset.statusCode).toBe(200);
    const temp = reset.json().temporaryPassword as string;

    const stale = await app.inject({ method: "GET", url: "/v1/classes", headers: auth(teacher2) });
    expect(stale.json().code).toBe("PASSWORD_CHANGE_REQUIRED");

    const fresh = await login("teacher2", temp);
    expect(fresh.user.mustChangePassword).toBe(true);
    await changePassword(fresh, temp, "Teach#2027");
    teacher2 = await login("teacher2", "Teach#2027");

    const byTeacher = await app.inject({ method: "POST", url: `/v1/admin/teachers/${teacher1Id}/reset-password`, headers: auth(teacher2) });
    expect(byTeacher.statusCode).toBe(403);
  });

  it("I4/I5：管理员建班指定班主任并授权任课教师，班级数不再翻倍", async () => {
    const before = await app.inject({ method: "GET", url: "/v1/admin/teachers", headers: auth(admin) });
    expect(before.json().find((t: { id: string }) => t.id === teacher1Id).classCount).toBe(1);

    const created = await app.inject({ method: "POST", url: "/v1/classes", headers: auth(admin), payload: { name: "跨境电商2502" } });
    expect(created.statusCode).toBe(200);
    const classId = created.json().id as string;
    const invisible = await app.inject({ method: "GET", url: "/v1/classes", headers: auth(teacher2) });
    expect(invisible.json()).toHaveLength(0);

    const assign = await app.inject({
      method: "PUT",
      url: `/v1/admin/classes/${classId}/teachers`,
      headers: auth(admin),
      payload: { headTeacherId: teacher2Id, teacherIds: [teacher1Id, teacher2Id] },
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().teacherIds).toEqual([teacher1Id]);

    const visible = await app.inject({ method: "GET", url: "/v1/classes", headers: auth(teacher2) });
    expect(visible.json()).toHaveLength(1);
    expect(visible.json()[0].headTeacherName).toBe("李老师");
    expect(visible.json()[0].teachers).toEqual([{ id: teacher1Id, displayName: "王老师" }]);

    const after = await app.inject({ method: "GET", url: "/v1/admin/teachers", headers: auth(admin) });
    expect(after.json().find((t: { id: string }) => t.id === teacher1Id).classCount).toBe(2);
    expect(after.json().find((t: { id: string }) => t.id === teacher2Id).classCount).toBe(1);

    const notTeacher = await app.inject({
      method: "PUT",
      url: `/v1/admin/classes/${classId}/teachers`,
      headers: auth(admin),
      payload: { headTeacherId: student2Id, teacherIds: [] },
    });
    expect(notTeacher.statusCode).toBe(400);
  });

  it("I6：停用教师后已签发的访问令牌立即失效", async () => {
    const disable = await app.inject({
      method: "PATCH",
      url: `/v1/admin/teachers/${teacher1Id}`,
      headers: auth(admin),
      payload: { status: "disabled" },
    });
    expect(disable.statusCode).toBe(200);
    const rejected = await app.inject({ method: "GET", url: "/v1/classes", headers: auth(teacher1) });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().code).toBe("ACCOUNT_DISABLED");
    const refresh = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: teacher1.refreshToken } });
    expect(refresh.statusCode).toBe(401);

    await app.inject({ method: "PATCH", url: `/v1/admin/teachers/${teacher1Id}`, headers: auth(admin), payload: { status: "active" } });
    teacher1 = await login("teacher1", "Teach#2026");
  });

  it("K1：评价回复存云端，授权教师可查看", async () => {
    const order = await db.query(
      `insert into orders (student_id, order_no, status, product_name, total_amount, payload)
       values ($1, 'TEST-0001', 'delivered', '测试商品', 19.9, '{}') returning id`,
      [student2Id],
    );
    student2OrderId = order.rows[0].id as string;
    const saved = await app.inject({
      method: "POST",
      url: "/v1/student/review-replies",
      headers: auth(student2),
      payload: { orderId: student2OrderId, text: "Thanks for your feedback!" },
    });
    expect(saved.statusCode).toBe(200);
    const map = await app.inject({ method: "GET", url: "/v1/student/review-replies", headers: auth(student2) });
    expect(map.json()[student2OrderId].text).toBe("Thanks for your feedback!");

    const forTeacher = await app.inject({ method: "GET", url: `/v1/students/${student2Id}/review-replies`, headers: auth(teacher1) });
    expect(forTeacher.json()[0].orderNo).toBe("TEST-0001");
    const outsider = await app.inject({ method: "GET", url: `/v1/students/${student2Id}/review-replies`, headers: auth(teacher2) });
    expect(outsider.statusCode).toBe(403);

    const missing = await app.inject({
      method: "POST",
      url: "/v1/student/review-replies",
      headers: auth(student2),
      payload: { orderId: "00000000-0000-0000-0000-000000000000", text: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("K2：邮件草稿增改删", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/student/mail-drafts/d123",
      headers: auth(student2),
      payload: { to: "buyer@example.com", subject: "Hi", body: "Draft body", templateId: null },
    });
    expect(put.statusCode).toBe(200);
    await app.inject({
      method: "PUT",
      url: "/v1/student/mail-drafts/d123",
      headers: auth(student2),
      payload: { to: "buyer@example.com", subject: "Hi again", body: "Draft body 2" },
    });
    const list = await app.inject({ method: "GET", url: "/v1/student/mail-drafts", headers: auth(student2) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].subject).toBe("Hi again");
    await app.inject({ method: "DELETE", url: "/v1/student/mail-drafts/d123", headers: auth(student2) });
    const empty = await app.inject({ method: "GET", url: "/v1/student/mail-drafts", headers: auth(student2) });
    expect(empty.json()).toHaveLength(0);
  });

  it("K3/K4：已读标记按类型存云端", async () => {
    const mark = await app.inject({
      method: "POST",
      url: "/v1/me/read-marks",
      headers: auth(student2),
      payload: { kind: "mail", ids: ["seed-1", "db-2", "seed-1"] },
    });
    expect(mark.statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/v1/me/read-marks", headers: auth(student2), payload: { kind: "guidance", ids: ["g-1"] } });
    const mail = await app.inject({ method: "GET", url: "/v1/me/read-marks?kind=mail", headers: auth(student2) });
    expect(mail.json().sort()).toEqual(["db-2", "seed-1"]);
    const guidance = await app.inject({ method: "GET", url: "/v1/me/read-marks?kind=guidance", headers: auth(student2) });
    expect(guidance.json()).toEqual(["g-1"]);
    const bad = await app.inject({ method: "POST", url: "/v1/me/read-marks", headers: auth(student2), payload: { kind: "other", ids: [] } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("登录页签校验（I7）与学生编辑/转班/删除（I8）", () => {
  let teacher1: Session;
  let teacher2: Session;
  let class2501: string;
  let class2502: string;
  let newStudentId: string;

  async function userId(username: string): Promise<string> {
    const result = await db.query("select id from users where username = $1", [username]);
    return result.rows[0].id as string;
  }

  async function progressCount(studentId: string): Promise<number> {
    const result = await db.query("select count(*)::int as n from task_progress where student_id = $1", [studentId]);
    return result.rows[0].n as number;
  }

  it("I7：页签与角色不符时不签发令牌，返回真实角色", async () => {
    const id = await userId("s2501002");
    const before = await db.query("select count(*)::int as n from refresh_tokens where user_id = $1", [id]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "s2501002", password: "Stud#2027", expectedRole: "teacher" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("ROLE_MISMATCH");
    expect(response.json().actualRole).toBe("student");
    expect(response.json().accessToken).toBeUndefined();
    const after = await db.query("select count(*)::int as n from refresh_tokens where user_id = $1", [id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // 密码错时不泄露角色
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "s2501002", password: "wrong-pass", expectedRole: "teacher" },
    });
    expect(wrong.json().code).toBe("INVALID_CREDENTIALS");

    const matched = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "s2501002", password: "Stud#2027", expectedRole: "student" },
    });
    expect(matched.statusCode).toBe(200);
  });

  it("I8：导入自带密码执行密码策略；新导入学生补齐该班已有任务", async () => {
    teacher1 = await login("teacher1", "Teach#2026");
    teacher2 = await login("teacher2", "Teach#2027");
    const classes = await app.inject({ method: "GET", url: "/v1/classes", headers: auth(teacher1) });
    class2501 = classes.json().find((c: { name: string }) => c.name === "跨境电商2501").id;
    class2502 = classes.json().find((c: { name: string }) => c.name === "跨境电商2502").id;

    const imported = await app.inject({
      method: "POST",
      url: `/v1/classes/${class2501}/students/import`,
      headers: auth(teacher1),
      payload: {
        students: [
          { username: "s2501003", displayName: "王五" },
          { username: "s2501004", displayName: "赵六", password: "short" },
        ],
      },
    });
    expect(imported.json().created).toHaveLength(1);
    expect(imported.json().failed).toEqual([{ username: "s2501004", reason: "密码不少于 8 位" }]);
    newStudentId = await userId("s2501003");
    expect(await progressCount(newStudentId)).toBe(1);
  });

  it("I8：改姓名、转班（需两边都有授权），未开始的原班任务随之移除", async () => {
    const rename = await app.inject({
      method: "PATCH",
      url: `/v1/students/${newStudentId}`,
      headers: auth(teacher1),
      payload: { displayName: "王小五" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().displayName).toBe("王小五");

    const denied = await app.inject({
      method: "PATCH",
      url: `/v1/students/${newStudentId}`,
      headers: auth(teacher2),
      payload: { classId: class2502 },
    });
    expect(denied.statusCode).toBe(403);

    const moved = await app.inject({
      method: "PATCH",
      url: `/v1/students/${newStudentId}`,
      headers: auth(teacher1),
      payload: { classId: class2502 },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().classId).toBe(class2502);
    expect(await progressCount(newStudentId)).toBe(0);

    const roster = await app.inject({ method: "GET", url: `/v1/classes/${class2502}/students`, headers: auth(teacher2) });
    expect(roster.json().map((s: { displayName: string }) => s.displayName)).toEqual(["王小五"]);
  });

  it("I8：没有实训记录的学生可删除；有记录的只能停用", async () => {
    const removed = await app.inject({ method: "DELETE", url: `/v1/students/${newStudentId}`, headers: auth(teacher2) });
    expect(removed.statusCode).toBe(200);
    expect(await db.query("select 1 from users where id = $1", [newStudentId]).then((r) => r.rowCount)).toBe(0);

    const studentId = await userId("s2501002");
    await db.query(
      "insert into mail_submissions (student_id, template_id, subject, body) values ($1, 'MAIL-CUSTOM', 'Hi', 'Body')",
      [studentId],
    );
    const blocked = await app.inject({ method: "DELETE", url: `/v1/students/${studentId}`, headers: auth(teacher1) });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("STUDENT_HAS_DATA");
  });
});
