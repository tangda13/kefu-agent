import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
      // 测试不读 .env 里的真实厂商配置，模型调用全部打到本地假上游
      llmBaseUrl: "",
      llmApiKey: "",
      llmModel: "",
      ttsApiKey: "",
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

  it("目录：24 个场景与 40 个画像已种子化", async () => {
    const scenarios = await app.inject({
      method: "GET",
      url: "/v1/catalog/scenarios",
      headers: auth(teacher1),
    });
    expect(scenarios.json()).toHaveLength(24);
    expect(scenarios.json().find((item: { id: string }) => item.id === "PRE-002").channel).toBe("mail");

    const personas = await app.inject({
      method: "GET",
      url: "/v1/catalog/personas",
      headers: auth(teacher1),
    });
    expect(personas.json().length).toBeGreaterThanOrEqual(40);
  });

  it("个人中心：/v1/me 返回所带班级与最近登录，能改自己的姓名", async () => {
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(teacher1) });
    expect(me.statusCode).toBe(200);
    expect(Array.isArray(me.json().classes)).toBe(true);
    expect(Array.isArray(me.json().recentLogins)).toBe(true);
    const bad = await app.inject({ method: "PATCH", url: "/v1/me", headers: auth(teacher1), payload: { displayName: "  " } });
    expect(bad.statusCode).toBe(400);
    const original = me.json().displayName;
    const renamed = await app.inject({ method: "PATCH", url: "/v1/me", headers: auth(teacher1), payload: { displayName: "改名测试" } });
    expect(renamed.json()).toMatchObject({ ok: true, displayName: "改名测试" });
    await app.inject({ method: "PATCH", url: "/v1/me", headers: auth(teacher1), payload: { displayName: original } });
  });

  it("个人中心：上传、移除头像，登录返回头像", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
    const boundary = "----cecsavatar";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: "POST", url: "/v1/me/avatar", headers: { ...auth(teacher1), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode).toBe(200);
    expect(up.json().avatarUrl).toMatch(/^\/uploads\/avatars\//);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(teacher1) });
    expect(me.json().avatarUrl).toBe(up.json().avatarUrl);
    const removed = await app.inject({ method: "DELETE", url: "/v1/me/avatar", headers: auth(teacher1) });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v1/me", headers: auth(teacher1) });
    expect(after.json().avatarUrl).toBeNull();
  });

  it("D-32：空白新建场景、修改沟通方式和订单状态", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/catalog/scenarios",
      headers: auth(teacher1),
      payload: { stage: "after_sale", name: "退款进度查询", objective: "说明退款到账时间", channel: "chat", orderKind: "delivered" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    const bad = await app.inject({ method: "POST", url: "/v1/catalog/scenarios", headers: auth(teacher1), payload: { stage: "x", name: "a", objective: "b" } });
    expect(bad.statusCode).toBe(400);
    const patched = await app.inject({ method: "PATCH", url: `/v1/catalog/scenarios/${id}`, headers: auth(teacher1), payload: { channel: "mail", orderKind: null } });
    expect(patched.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/v1/catalog/scenarios", headers: auth(teacher1) });
    const row = list.json().find((item: { id: string }) => item.id === id);
    expect(row).toMatchObject({ channel: "mail", orderKind: null, stage: "after_sale" });
  });

  it("D-32/D-33：画像试抽返回 3 个随机买家，模板字段作为默认值", async () => {
    const result = await app.inject({ method: "POST", url: "/v1/catalog/personas/P-002/sample", headers: auth(teacher1), payload: {} });
    expect(result.statusCode).toBe(200);
    const samples = result.json().samples;
    expect(samples).toHaveLength(3);
    for (const item of samples) {
      expect(item.nationality).toBe("日本");
      expect(item.customerType).toBe("潜在意向客");
      expect(item.templateName).toBe("选择困难型个人消费者");
      expect(item.name).toBeTruthy();
    }
  });

  it("D-33：画像结构化字段、名称自动生成、人群范围预览与下发校验", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/catalog/personas", headers: auth(teacher1),
      payload: { nationality: "美国", language: "en-US", personality: "直接高效", emotion: "期待", customerType: "沉睡客", concerns: ["价格优惠"] } });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/v1/catalog/personas", headers: auth(teacher1),
      payload: { buyerRole: "企业采购", decisionStyle: "冲动下单型", customerType: "沉睡客", concerns: ["发票交期", "不存在"], note: "预算年底才批",
        nationality: "美国", language: "en-US", personality: "直接高效", emotion: "期待" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "冲动下单型企业采购", identity: "企业采购", concerns: ["发票交期"] });
    const preview = await app.inject({ method: "POST", url: "/v1/catalog/personas/preview", headers: auth(teacher1),
      payload: { rule: { customerTypes: ["沉睡客"], buyerRoles: ["企业采购"], emotionPool: ["不满"] } } });
    expect(preview.json().matchCount).toBe(1);
    for (const sample of preview.json().samples) expect(sample).toMatchObject({ templateName: "冲动下单型企业采购", customerType: "沉睡客", emotion: "不满" });
    const none = await app.inject({ method: "POST", url: "/v1/catalog/personas/preview", headers: auth(teacher1), payload: { rule: { templateIds: ["NOPE"] } } });
    expect(none.json()).toMatchObject({ matchCount: 0, samples: [] });
  });

  it("D-32：商品详情入库、规格摘要和总库存按规格计算", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/store/products",
      headers: auth(teacher1),
      payload: {
        name: "Linen Shirt",
        price: 25,
        category: "男装",
        details: {
          options: [{ name: "颜色", values: ["White", "Navy"] }, { name: "尺码", values: ["M", "L"] }],
          skus: [
            { values: { 颜色: "White", 尺码: "M" }, price: 25, stock: 10 },
            { values: { 颜色: "Navy", 尺码: "L", 不存在: "x" }, price: 26, stock: 5 },
          ],
          bullets: ["a", "b", "c"],
          specs: [{ name: "材质", value: "亚麻" }],
          shipping: { shipsFrom: "中国广州", handlingDays: 2, methods: [{ region: "美国", method: "标准运输", days: "7–12 个工作日", fee: 0 }] },
          afterSale: { returnPolicy: "30 天无理由退换" },
        },
        images: ["https://evil.example/x.png"],
      },
    });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/v1/store/products?all=1", headers: auth(teacher1) });
    const row = list.json().find((item: { id: string }) => item.id === created.json().id);
    expect(row.spec).toBe("颜色 2 × 尺码 2");
    expect(row.stock).toBe(15);
    expect(row.images).toEqual([]);
    expect(row.details.skus[1].values).toEqual({ 颜色: "Navy", 尺码: "L" });
    const library = await app.inject({ method: "GET", url: "/v1/store/library", headers: auth(teacher1) });
    expect(library.statusCode).toBe(200);
    const extract = await app.inject({ method: "POST", url: "/v1/store/products/extract", headers: auth(teacher1), payload: { text: "short" } });
    expect(extract.statusCode).toBe(400);
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

  it("场景剧本不给学生；场景返回被几个任务在用；公告已读人数按学生看到计", async () => {
    const student = await login("s2501001", "MyPass#01");
    const forStudent = await app.inject({ method: "GET", url: "/v1/catalog/scenarios", headers: auth(student) });
    expect(forStudent.json().every((row: { script: unknown }) => row.script === null)).toBe(true);
    const forTeacher = await app.inject({ method: "GET", url: "/v1/catalog/scenarios", headers: auth(teacher1) });
    const pre1 = forTeacher.json().find((row: { id: string }) => row.id === "PRE-001");
    expect(pre1.taskCount).toBe(1);

    await app.inject({ method: "POST", url: "/v1/announcements", headers: auth(teacher1), payload: { title: "周四改到 302 机房", content: "请提前 5 分钟到", classIds: [classId], days: 7 } });
    const before = (await app.inject({ method: "GET", url: "/v1/announcements", headers: auth(teacher1) })).json()[0];
    expect(before).toMatchObject({ recipientCount: 2, readCount: 0 });
    const seen = await app.inject({ method: "GET", url: "/v1/student/announcements", headers: auth(student) });
    const marked = await app.inject({ method: "POST", url: "/v1/me/read-marks", headers: auth(student), payload: { kind: "notice", ids: seen.json().map((row: { id: string }) => row.id) } });
    expect(marked.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/v1/announcements", headers: auth(teacher1) })).json()[0];
    expect(after.readCount).toBe(1);

    const today = await app.inject({ method: "GET", url: "/v1/teacher/tracking/today", headers: auth(teacher1) });
    expect(today.json()).toMatchObject({ studentTotal: 2, pendingReviews: 0 });
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

describe("模型网关管理（G1–G7）+ 验收统计口径（B2）", () => {
  let admin: Session;
  let upstream: Server;
  let upstreamBase = "";
  const bodies: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  let profileId = "";
  let badProfileId = "";

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        bodies.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: raw ? JSON.parse(raw) : {} });
        if ((req.url ?? "").startsWith("/bad")) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
          return;
        }
        const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
          `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          chunk({ content: "hey, my order " }) +
            chunk({ content: "arrived broken" }) +
            chunk({}, { finish_reason: "stop" }) +
            `data: ${JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 } })}\n\n` +
            "data: [DONE]\n\n",
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    admin = await login("admin", "Admin#Prod9");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const profilePayload = (overrides: Record<string, unknown> = {}) => ({
    name: "DeepSeek 官方",
    presetKey: "deepseek",
    baseUrl: `${upstreamBase}/ok/v1/`,
    apiKey: "sk-abcd12345678",
    model: "deepseek-flash",
    extraBody: { thinking: { type: "disabled" } },
    jsonMode: true,
    priceInput: 2,
    priceOutput: 8,
    ...overrides,
  });

  it("G1：新建档案，Key 加密存储、界面打码，地址去尾斜杠", async () => {
    const empty = await app.inject({ method: "GET", url: "/v1/admin/llm", headers: auth(admin) });
    expect(empty.json().profiles).toEqual([]);

    const reserved = await app.inject({
      method: "POST",
      url: "/v1/admin/llm/profiles",
      headers: auth(admin),
      payload: profilePayload({ extraBody: { model: "x" } }),
    });
    expect(reserved.statusCode).toBe(400);

    const created = await app.inject({ method: "POST", url: "/v1/admin/llm/profiles", headers: auth(admin), payload: profilePayload() });
    expect(created.statusCode).toBe(200);
    profileId = created.json().id;
    const list = await app.inject({ method: "GET", url: "/v1/admin/llm", headers: auth(admin) });
    const view = list.json().profiles[0];
    expect(view).toMatchObject({ apiKeyMasked: "sk-a****5678", baseUrl: `${upstreamBase}/ok/v1`, testStatus: "untested", isDefault: false });
    const stored = await db.query("select api_key_enc from llm_profiles where id = $1", [profileId]);
    expect(stored.rows[0].api_key_enc).not.toContain("abcd1234");
  });

  it("G4：未测试不能设为默认；测试通过后可以，请求体带上 extraBody", async () => {
    const early = await app.inject({ method: "PUT", url: "/v1/admin/llm/default", headers: auth(admin), payload: { profileId } });
    expect(early.statusCode).toBe(409);

    const tested = await app.inject({ method: "POST", url: `/v1/admin/llm/profiles/${profileId}/test`, headers: auth(admin) });
    expect(tested.json()).toMatchObject({ ok: true, sample: "hey, my order arrived broken" });
    expect(typeof tested.json().ttftMs).toBe("number");
    const sent = bodies.at(-1)!;
    expect(sent.url).toBe("/ok/v1/chat/completions");
    expect(sent.auth).toBe("Bearer sk-abcd12345678");
    expect(sent.body.thinking).toEqual({ type: "disabled" });

    const ok = await app.inject({ method: "PUT", url: "/v1/admin/llm/default", headers: auth(admin), payload: { profileId } });
    expect(ok.statusCode).toBe(200);
    const system = await app.inject({ method: "GET", url: "/v1/admin/system", headers: auth(admin) });
    const llmService = (system.json().services as Array<{ key: string; status: string; detail: string }>).find((item) => item.key === "llm");
    expect(llmService?.detail).toContain("DeepSeek 官方");
  });

  it("G4：改了模型后测试状态重置；草稿测试沿用已存 Key", async () => {
    const updated = await app.inject({
      method: "PUT",
      url: `/v1/admin/llm/profiles/${profileId}`,
      headers: auth(admin),
      payload: profilePayload({ apiKey: "", model: "deepseek-v4-pro" }),
    });
    expect(updated.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/v1/admin/llm", headers: auth(admin) });
    expect(list.json().profiles[0]).toMatchObject({ model: "deepseek-v4-pro", testStatus: "untested", apiKeyMasked: "sk-a****5678" });

    const draft = await app.inject({
      method: "POST",
      url: "/v1/admin/llm/test",
      headers: auth(admin),
      payload: { ...profilePayload({ apiKey: "" }), id: profileId },
    });
    expect(draft.json().ok).toBe(true);
    expect(bodies.at(-1)!.auth).toBe("Bearer sk-abcd12345678");
    await app.inject({ method: "POST", url: `/v1/admin/llm/profiles/${profileId}/test`, headers: auth(admin) });
  });

  it("G3/G5：测试失败的档案不能分配给用途；用途路由与导演频率可保存", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/v1/admin/llm/profiles",
      headers: auth(admin),
      payload: profilePayload({ name: "坏网关", baseUrl: `${upstreamBase}/bad/v1`, extraBody: {} }),
    });
    badProfileId = bad.json().id;
    const failed = await app.inject({ method: "POST", url: `/v1/admin/llm/profiles/${badProfileId}/test`, headers: auth(admin) });
    expect(failed.json().ok).toBe(false);
    expect(failed.json().error).toContain("Authentication Fails");

    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/admin/llm/routing",
      headers: auth(admin),
      payload: { routes: { dialogue: { profileId, fallbackProfileId: badProfileId, temperature: 0.8, maxTokens: 400 } } },
    });
    expect(rejected.statusCode).toBe(409);

    const saved = await app.inject({
      method: "PUT",
      url: "/v1/admin/llm/routing",
      headers: auth(admin),
      payload: { routes: { director: { profileId, fallbackProfileId: null, temperature: 0.3, maxTokens: 500 } }, directorEveryNTurns: 3 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().directorEveryNTurns).toBe(3);
    expect(saved.json().routes.director.profileId).toBe(profileId);
    expect(saved.json().routes.assessment.profileId).toBeNull();

    const removeDefault = await app.inject({ method: "DELETE", url: `/v1/admin/llm/profiles/${profileId}`, headers: auth(admin) });
    expect(removeDefault.statusCode).toBe(409);
    const removeBad = await app.inject({ method: "DELETE", url: `/v1/admin/llm/profiles/${badProfileId}`, headers: auth(admin) });
    expect(removeBad.statusCode).toBe(200);
  });

  it("B2/G6：验收测试计入全部请求，失败算进分母；可导出 CSV；用量按用途计费", async () => {
    const started = await app.inject({ method: "POST", url: "/v1/admin/acceptance/run", headers: auth(admin), payload: { samples: 2 } });
    expect(started.statusCode).toBe(200);
    let report: { run?: { running: boolean }; llm: Record<string, unknown> } | null = null;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await app.inject({ method: "GET", url: "/v1/admin/acceptance", headers: auth(admin) });
      report = response.json();
      if (report && report.run && !report.run.running) break;
    }
    expect(report!.llm).toMatchObject({ totalRequests: 2, validRequests: 2, errorRequests: 0 });
    // 买家提示词带上了场景剧本
    const acceptanceBody = bodies.at(-1)!.body as { messages: Array<{ content: string }> };
    expect(acceptanceBody.messages[0]!.content).toContain("Hidden information");

    const conversationId = (await db.query("select conversation_id from conversation_metrics limit 1")).rows[0].conversation_id;
    await db.query(
      "insert into conversation_metrics (conversation_id, received_at, provider, model, outcome) values ($1, now(), 'x', 'x', 'timeout')",
      [conversationId],
    );
    const withFailure = await app.inject({ method: "GET", url: "/v1/admin/acceptance", headers: auth(admin) });
    expect(withFailure.json().llm).toMatchObject({ totalRequests: 3, timeoutRequests: 1 });
    expect(withFailure.json().llm.ttftRate3s).toBeCloseTo(2 / 3);
    expect(withFailure.json().llm.recentFailures[0].outcome).toBe("timeout");

    const csv = await app.inject({ method: "GET", url: "/v1/admin/acceptance.csv", headers: auth(admin) });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.startsWith("﻿请求ID,")).toBe(true);
    expect(csv.body.trim().split("\r\n")).toHaveLength(4);

    const usage = await app.inject({ method: "GET", url: "/v1/admin/llm/usage", headers: auth(admin) });
    const dialogue = usage.json().byPurpose.find((row: { purpose: string }) => row.purpose === "dialogue");
    expect(dialogue.calls).toBe(2);
    expect(dialogue.cost).toBeCloseTo(((900 * 2 + 20 * 8) / 1_000_000) * 2);
  });

  it("G7/G6：语音 Key 加密存储；额度按金额计算", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/admin/providers",
      headers: auth(admin),
      payload: { voice: { apiKey: "volc-key-123456", ttsPricePer10kChars: 3 }, quota: { monthlyBudgetYuan: 100, warnPercent: 80 } },
    });
    expect(saved.statusCode).toBe(200);
    const stored = await db.query("select value from app_settings where key = 'voice'");
    expect(JSON.stringify(stored.rows[0].value)).not.toContain("volc-key");
    const view = await app.inject({ method: "GET", url: "/v1/admin/providers", headers: auth(admin) });
    expect(view.json().voice).toMatchObject({ vendor: "doubao", apiKeyMasked: "volc****3456", ttsPricePer10kChars: 3 });
    expect(view.json().quota).toMatchObject({ monthlyBudgetYuan: 100, alert: false });
    expect(view.json().usage.llmCost).toBeGreaterThan(0);
  });

  it("J5：内置场景已种子化剧本", async () => {
    const result = await db.query("select count(*)::int as n from scenarios where script is not null");
    expect(result.rows[0].n).toBe(24);
  });
});

describe("实训对话走模型网关（J1/J4/J5/J6 + B2）", () => {
  let upstream: Server;
  let student: Session;
  const requests: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push(body);
        // 结构化输出请求（导演）返回 JSON，其余返回买家台词
        const text = body.response_format
          ? JSON.stringify({ turnScore: 82, satisfaction: 71, emotion: "平静", stage: "方案协商", directive: "追问退款到账时间", memory: "客服同意补发配件", resolved: false })
          : "hmm ok ||| when will it arrive?";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: text } }] })}\n\n` +
            `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n",
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    // 默认档案指向本地假上游（直接写库，绕过管理端测试流程）
    const { createSecretSealer } = await import("./llm/secret");
    const sealer = createSecretSealer("test-secret");
    await db.query("update llm_profiles set is_default = false");
    await db.query(
      `insert into llm_profiles (name, base_url, api_key_enc, model, json_mode, is_default, test_status)
       values ('对话测试', $1, $2, 'fake-model', true, true, 'ok')`,
      [`${upstreamBase}/v1`, sealer.seal("sk-conv")],
    );
    await db.query("delete from app_settings where key = 'llm_routing'");
    const admin = await login("admin", "Admin#Prod9");
    // 触发网关 reload：保存一次路由（导演每轮运行）
    const routed = await app.inject({ method: "PUT", url: "/v1/admin/llm/routing", headers: auth(admin), payload: { directorEveryNTurns: 1 } });
    expect(routed.statusCode).toBe(200);

    const { hashPassword } = await import("./security");
    await db.query(
      `insert into users (username, display_name, role, password_hash, must_change_password)
       values ('s-conv', '对话测试学生', 'student', $1, false) on conflict (username) do nothing`,
      [await hashPassword("Student#Conv1")],
    );
    student = await login("s-conv", "Student#Conv1");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 40; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("售前会话：买家拿到在售商品；开场与回复按 ||| 拆条落库；导演 JSON 更新会话状态", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "PRE-001" } });
    expect(created.statusCode).toBe(200);
    const conversationId = created.json().id ?? created.json().conversation?.id;
    const persona = (await db.query("select persona from conversations where id = $1", [conversationId])).rows[0].persona;
    expect(persona.interestedProduct?.name).toBeTruthy();

    const opening = await app.inject({ method: "POST", url: `/v1/conversations/${conversationId}/opening`, headers: auth(student) });
    expect(opening.body).toContain('"type":"done"');
    const firstRequest = requests.at(-1) as { messages: Array<{ role: string; content: string }> };
    expect(firstRequest.messages[0]!.content).toContain("The product you are interested in");
    expect(firstRequest.messages[0]!.content).toContain("Hidden information");

    const replied = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: auth(student),
      payload: { content: "Hi! It is our foldable yoga mat, 6mm TPE." },
    });
    expect(replied.body).toContain('"type":"split"');
    const buyerRows = await db.query("select content from conversation_messages where conversation_id = $1 and sender = 'buyer' order by created_at", [conversationId]);
    expect(buyerRows.rows.map((row) => row.content)).toEqual(["hmm ok", "when will it arrive?", "hmm ok", "when will it arrive?"]);

    await waitFor(async () => (await db.query("select state from conversations where id = $1", [conversationId])).rows[0].state.stage === "方案协商");
    const state = (await db.query("select state from conversations where id = $1", [conversationId])).rows[0].state;
    expect(state).toMatchObject({ satisfaction: 71, emotion: "平静", stage: "方案协商", memory: "客服同意补发配件", studentTurns: 1 });

    const metric = (await db.query("select provider, model, outcome, first_char_at >= received_at as ordered from conversation_metrics where conversation_id = $1", [conversationId])).rows;
    expect(metric).toHaveLength(2);
    expect(metric.every((row) => row.provider === "对话测试" && row.model === "fake-model" && row.outcome === "success" && row.ordered)).toBe(true);
    const usage = (await db.query("select purpose, count(*)::int as n from llm_usage where conversation_id = $1 group by purpose order by purpose", [conversationId])).rows;
    expect(usage).toEqual([{ purpose: "dialogue", n: 2 }, { purpose: "director", n: 1 }]);
  });
});

describe("品牌可替换（H6 / D-21）", () => {
  it("未设置时返回初始名称；管理员可改名称与标识；登录前可读取；非法输入被拒", async () => {
    const initial = await app.inject({ method: "GET", url: "/v1/public/brand" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ name: "跨境电商客服AI实训平台", logo: null });

    const anonymous = await app.inject({ method: "PUT", url: "/v1/admin/brand", payload: { name: "X" } });
    expect(anonymous.statusCode).toBe(401);

    const admin = await login("admin", "Admin#Prod9");
    const logo = `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`;
    const saved = await app.inject({ method: "PUT", url: "/v1/admin/brand", headers: auth(admin), payload: { name: "  某职院客服实训  ", logo } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ name: "某职院客服实训", logo });

    const publicRead = await app.inject({ method: "GET", url: "/v1/public/brand" });
    expect(publicRead.json()).toEqual({ name: "某职院客服实训", logo });

    const badType = await app.inject({ method: "PUT", url: "/v1/admin/brand", headers: auth(admin), payload: { logo: "data:text/html;base64,PGgxPg==" } });
    expect(badType.statusCode).toBe(400);
    const tooBig = await app.inject({ method: "PUT", url: "/v1/admin/brand", headers: auth(admin), payload: { logo: `data:image/png;base64,${Buffer.alloc(300 * 1024).toString("base64")}` } });
    expect(tooBig.statusCode).toBe(400);
    const emptyName = await app.inject({ method: "PUT", url: "/v1/admin/brand", headers: auth(admin), payload: { name: "   " } });
    expect(emptyName.statusCode).toBe(400);

    // 恢复内置图标：只清标识，名称保留
    const reset = await app.inject({ method: "PUT", url: "/v1/admin/brand", headers: auth(admin), payload: { logo: null } });
    expect(reset.json()).toEqual({ name: "某职院客服实训", logo: null });
  });
});

describe("管理端系统总览与内容库（E4–E6）", () => {
  it("系统总览实时检测服务并逐条列出告警；内容库可启停、批量导入，导入去重", async () => {
    const admin = await login("admin", "Admin#Prod9");
    const system = await app.inject({ method: "GET", url: "/v1/admin/system", headers: auth(admin) });
    expect(system.statusCode).toBe(200);
    const body = system.json();
    expect(body.services.map((item: { key: string }) => item.key)).toEqual(["database", "llm", "voice", "backup"]);
    expect(body.services[0].status).toBe("ok");
    expect(body.version.schema).toMatch(/^[0-9]{3}_/);
    expect(Array.isArray(body.alerts)).toBe(true);
    const alerts = await app.inject({ method: "GET", url: "/v1/admin/alerts", headers: auth(admin) });
    expect(alerts.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/v1/admin/content?kind=forbidden", headers: auth(admin) });
    const terms = list.json() as Array<{ id: number; text: string; enabled: boolean }>;
    expect(terms.length).toBeGreaterThanOrEqual(120);

    const disabled = await app.inject({ method: "PATCH", url: `/v1/admin/content/${terms[0]!.id}`, headers: auth(admin), payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/v1/admin/content?kind=forbidden", headers: auth(admin) })).json() as Array<{ id: number; enabled: boolean }>;
    expect(after.find((item) => item.id === terms[0]!.id)?.enabled).toBe(false);

    const imported = await app.inject({
      method: "POST", url: "/v1/admin/content/import", headers: auth(admin),
      payload: { kind: "forbidden", texts: ["导入测试词A", "导入测试词A", " ", terms[1]!.text, "导入测试词B"] },
    });
    expect(imported.json()).toEqual({ added: 2, skipped: 1 });
  });

  it("备份保留份数可设置并有上下限；音色列表随厂商返回，非法音色 ID 试听被拒", async () => {
    const admin = await login("admin", "Admin#Prod9");
    const initial = (await app.inject({ method: "GET", url: "/v1/admin/backup-schedule", headers: auth(admin) })).json();
    expect(initial.keep).toBe(14);
    expect(initial.keepOptions).toContain(30);
    const saved = await app.inject({ method: "PUT", url: "/v1/admin/backup-schedule", headers: auth(admin), payload: { keep: 30 } });
    expect(saved.json().keep).toBe(30);
    const clamped = await app.inject({ method: "PUT", url: "/v1/admin/backup-schedule", headers: auth(admin), payload: { keep: 1 } });
    expect(clamped.json().keep).toBe(3);

    const providers = (await app.inject({ method: "GET", url: "/v1/admin/providers", headers: auth(admin) })).json();
    const speakers = providers.voice.vendors[0].speakers as Array<{ id: string; gender: string }>;
    expect(speakers.some((item) => item.gender === "female")).toBe(true);
    expect(speakers.some((item) => item.gender === "male")).toBe(true);
    const bad = await app.inject({ method: "POST", url: "/v1/admin/voice/preview", headers: auth(admin), payload: { speaker: "x y" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("P4 教师端：分组与名单统计（D8）、逐维度复核（D9/C7）、场景复制与编辑（D6）", () => {
  it("分组、统计列、逐维度复核按权重重算、教师评语单独返回给学生、场景可复制和改名", async () => {
    const admin = await login("admin", "Admin#Prod9");
    const created = await app.inject({ method: "POST", url: "/v1/classes", headers: auth(admin), payload: { name: "P4测试班" } });
    const classId = created.json().id as string;
    const imported = await app.inject({
      method: "POST", url: `/v1/classes/${classId}/students/import`, headers: auth(admin),
      payload: { students: [{ username: "s-p4-a", displayName: "甲", password: "Student#P4a1" }, { username: "s-p4-b", displayName: "乙", password: "Student#P4b1" }] },
    });
    expect(imported.json().created).toHaveLength(2);
    const roster = (await app.inject({ method: "GET", url: `/v1/classes/${classId}/students`, headers: auth(admin) })).json() as Array<{ id: string; username: string }>;
    const a = roster.find((row) => row.username === "s-p4-a")!;

    const grouped = await app.inject({ method: "PUT", url: `/v1/classes/${classId}/groups`, headers: auth(admin), payload: { studentIds: [a.id], groupName: "第一组" } });
    expect(grouped.json().updated).toBe(1);

    // 造一个带权重的任务和一条 AI 评分：沟通有效性占 100%
    const task = await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by)
       values ('P4复核', 'after_sale', '["AFTER-001"]', 'text', $1, 'published', (select id from users where username = 'admin')) returning id`,
      [JSON.stringify({ effectiveness: 100 })],
    );
    const conversation = await db.query(
      "insert into conversations (task_id, student_id, scenario_id, status) values ($1, $2, 'AFTER-001', 'closed') returning id",
      [task.rows[0].id, a.id],
    );
    const assessment = await db.query(
      `insert into assessments (conversation_id, student_id, scores, total, comment)
       values ($1, $2, $3, 70, 'AI 评语') returning id`,
      [conversation.rows[0].id, a.id, JSON.stringify({ compliance: 70, grammar: 70, professionalism: 70, effectiveness: 70, empathy: 70, resolution: 70 })],
    );

    const after = (await app.inject({ method: "GET", url: `/v1/classes/${classId}/students`, headers: auth(admin) })).json() as Array<{ username: string; groupName: string | null; averageScore: number | null }>;
    const rowA = after.find((row) => row.username === "s-p4-a")!;
    expect(rowA.groupName).toBe("第一组");
    expect(rowA.averageScore).toBe(70);

    const bad = await app.inject({ method: "PATCH", url: `/v1/teacher/assessments/${assessment.rows[0].id}`, headers: auth(admin), payload: { scores: { effectiveness: 120 } } });
    expect(bad.statusCode).toBe(400);
    const reviewed = await app.inject({
      method: "PATCH", url: `/v1/teacher/assessments/${assessment.rows[0].id}`, headers: auth(admin),
      payload: { scores: { effectiveness: 90 }, teacherComment: "沟通到位" },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().total).toBe(90);
    const saved = await db.query("select total, ai_total, comment, teacher_comment from assessments where id = $1", [assessment.rows[0].id]);
    expect(Number(saved.rows[0].total)).toBe(90);
    expect(Number(saved.rows[0].ai_total)).toBe(70);
    expect(saved.rows[0].comment).toBe("AI 评语");
    expect(saved.rows[0].teacher_comment).toBe("沟通到位");

    const student = await login("s-p4-a", "Student#P4a1");
    const records = (await app.inject({ method: "GET", url: "/v1/student/assessments", headers: auth(student) })).json();
    const record = (records.records ?? records)[0];
    expect(record.comment).toBe("AI 评语");
    expect(record.teacherComment).toBe("沟通到位");

    const copied = await app.inject({ method: "POST", url: "/v1/catalog/scenarios", headers: auth(admin), payload: { fromId: "AFTER-001" } });
    expect(copied.statusCode).toBe(200);
    const renamed = await app.inject({ method: "PATCH", url: `/v1/catalog/scenarios/${copied.json().id}`, headers: auth(admin), payload: { name: "改过的场景", objective: "新的目标" } });
    expect(renamed.statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: "/v1/catalog/scenarios", headers: auth(admin) })).json() as Array<{ id: string; name: string; script: unknown }>;
    const copy = list.find((row) => row.id === copied.json().id)!;
    expect(copy.name).toBe("改过的场景");
    expect(copy.script).not.toBeNull();
  });
});

describe("接待生命周期（D-36）", () => {
  it("2 小时没发言、任务结束、超时自动结束；自由练习不进实训跟踪", async () => {
    const { sweepConversations } = await import("./lifecycle");
    const gateway = { isConfigured: () => false } as unknown as import("./llm/gateway").LlmGateway;
    const student = (await db.query("select id from users where role = 'student' limit 1")).rows[0].id;
    const adminId = (await db.query("select id from users where username = 'admin'")).rows[0].id;
    const task = await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by, time_limit_minutes)
       values ('生命周期', 'after_sale', '["AFTER-001"]', 'text', '{}', 'published', $1, 30) returning id`,
      [adminId],
    );
    const taskId = task.rows[0].id;
    const make = async (minutesAgo: number, withTask: boolean) => (await db.query(
      `insert into conversations (task_id, student_id, scenario_id, status, created_at) values ($1, $2, 'AFTER-001', 'active', now() - make_interval(mins => $3)) returning id`,
      [withTask ? taskId : null, student, minutesAgo],
    )).rows[0].id as string;
    const fresh = await make(5, true);
    const timedOut = await make(40, true);
    const practiceIdle = await make(180, false);
    await sweepConversations(db, gateway);
    const status = async (id: string) => (await db.query("select status, closed_reason from conversations where id = $1", [id])).rows[0];
    expect(await status(fresh)).toMatchObject({ status: "active" });
    expect(await status(timedOut)).toMatchObject({ status: "closed", closed_reason: "timeout" });
    expect(await status(practiceIdle)).toMatchObject({ status: "closed", closed_reason: "abandoned" });
    await db.query("update tasks set status = 'closed' where id = $1", [taskId]);
    await sweepConversations(db, gateway, { taskId });
    expect(await status(fresh)).toMatchObject({ status: "closed", closed_reason: "task_closed" });
  });
});
