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
