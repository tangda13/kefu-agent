import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, resetDatabase, type Db } from "./db";
import { buildServer } from "./server";
import { hashRefreshToken } from "./security";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://cecs:cecs_dev_2026@127.0.0.1:5434/cecs_test";

let db: Db;
let app: FastifyInstance;
/** 删学生 / 班级前的自动备份（D-86）在测试里只计数 */
let backups = 0;

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
    backupBeforeDelete: async () => {
      backups += 1;
      return { fileName: `backup-test-${backups}.sql` };
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

  const refresh = (refreshToken: string) => app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken } });
  /** 让这张刷新令牌“换掉”的时间往前推，模拟宽限已过 */
  const ageRotation = (refreshToken: string, seconds: number) =>
    db.query("update refresh_tokens set rotated_at = rotated_at - make_interval(secs => $2) where token_hash = $1", [hashRefreshToken(refreshToken), seconds]);

  it("刷新令牌旋转：换掉的旧令牌 60 秒内还能再续一次（响应丢了、两个页签同时续期），过了宽限被拒绝", async () => {
    const session = await login("admin", "Admin#Prod9");
    const first = await refresh(session.refreshToken);
    expect(first.statusCode).toBe(200);
    // 宽限内：再拿旧令牌续期照样成功，拿到的是另一张新令牌，两张都能用
    const replay = await refresh(session.refreshToken);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().refreshToken).not.toBe(first.json().refreshToken);
    expect((await refresh(first.json().refreshToken)).statusCode).toBe(200);
    // 宽限过了：旧令牌被拒绝
    await ageRotation(session.refreshToken, 61);
    expect((await refresh(session.refreshToken)).statusCode).toBe(401);
    // 新令牌续出来的访问令牌照常能用
    const fresh = (await refresh(replay.json().refreshToken)).json();
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: auth(fresh) })).statusCode).toBe(200);
  });

  it("登出、改密之后，宽限里的旧令牌也续不出新登录", async () => {
    const session = await login("admin", "Admin#Prod9");
    const next = (await refresh(session.refreshToken)).json();
    await app.inject({ method: "POST", url: "/v1/auth/logout", payload: { refreshToken: next.refreshToken } });
    expect((await refresh(next.refreshToken)).statusCode).toBe(401);
    expect((await refresh(session.refreshToken)).statusCode).toBe(401);

    // 改密：所有令牌作废，包括刚换掉的
    const again = await login("admin", "Admin#Prod9");
    const renewed = (await refresh(again.refreshToken)).json();
    const changed = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: auth(renewed),
      payload: { currentPassword: "Admin#Prod9", newPassword: "Admin#Prod8" },
    });
    expect(changed.statusCode).toBe(200);
    expect((await refresh(again.refreshToken)).statusCode).toBe(401);
    expect((await refresh(renewed.refreshToken)).statusCode).toBe(401);
    // 改回来，后面的用例还用原密码
    const back = await login("admin", "Admin#Prod8");
    expect((await app.inject({ method: "POST", url: "/v1/auth/change-password", headers: auth(back), payload: { currentPassword: "Admin#Prod8", newPassword: "Admin#Prod9" } })).statusCode).toBe(200);
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
    // D-65：类目按类目树存；老的十个类目对到树上；只写末级名按名字找；商家编码保存
    expect(row.category).toBe("服装 > 男装");
    const dress = await app.inject({
      method: "POST", url: "/v1/store/products", headers: auth(teacher1),
      payload: { name: "Wrap Dress", price: 29.9, category: "连衣裙", details: { options: [{ name: "尺码", values: ["S"] }], skus: [{ values: { 尺码: "S" }, price: 29.9, stock: 3, code: "WD-S" }] } },
    });
    const dressRow = (await app.inject({ method: "GET", url: "/v1/store/products?all=1", headers: auth(teacher1) })).json().find((item: { id: string }) => item.id === dress.json().id);
    expect(dressRow.category).toBe("服装 > 女装 > 连衣裙");
    expect(dressRow.details.skus[0].code).toBe("WD-S");
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

  it("任务校验：评分权重必须覆盖全部维度且合计 100", async () => {
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

  it("I8：没有实训记录的学生直接删；有记录的不带确认删不掉（D-86 起输入学号可连记录一起删）", async () => {
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

  it("D-78：账号不区分大小写——只差大小写的导入算已存在，登录大小写随意", async () => {
    const imported = await app.inject({
      method: "POST",
      url: `/v1/classes/${class2501}/students/import`,
      headers: auth(teacher1),
      payload: { students: [{ username: "S2501002", displayName: "重名" }] },
    });
    expect(imported.json()).toEqual({ created: [], failed: [{ username: "S2501002", reason: "账号已存在" }] });

    const upper = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: " S2501002 ", password: "Stud#2027", expectedRole: "student" },
    });
    expect(upper.statusCode).toBe(200);
    expect(upper.json().user.username).toBe("s2501002");
  });
});

describe("删除教师、学生、班级（D-86 连记录删先备份 / D-87 教师删时转交）", () => {
  let admin: Session;
  let teacherA: Session;
  const ids: Record<string, string> = {};
  let classA = "";
  let classB = "";

  async function idOf(username: string): Promise<string> {
    return (await db.query("select id from users where username = $1", [username])).rows[0].id as string;
  }

  beforeAll(async () => {
    admin = await login("admin", "Admin#Prod9");
    for (const [username, displayName] of [["delt1", "张老师"], ["delt2", "赵老师"], ["delt3", "钱老师"], ["delt4", "孙老师"]] as const) {
      const created = await app.inject({ method: "POST", url: "/v1/admin/teachers", headers: auth(admin), payload: { username, displayName, password: "Teach#2026" } });
      expect(created.statusCode).toBe(200);
      ids[username] = await idOf(username);
    }
    await app.inject({ method: "PATCH", url: `/v1/admin/teachers/${ids.delt3}`, headers: auth(admin), payload: { status: "disabled" } });
    teacherA = await login("delt1", "Teach#2026");
    classA = (await app.inject({ method: "POST", url: "/v1/classes", headers: auth(teacherA), payload: { name: "删除测试A" } })).json().id;
    const imported = await app.inject({
      method: "POST",
      url: `/v1/classes/${classA}/students/import`,
      headers: auth(teacherA),
      payload: { students: [{ username: "sd001", displayName: "删一", password: "Stud#2026" }, { username: "sd002", displayName: "删二", password: "Stud#2026" }] },
    });
    expect(imported.json().created).toHaveLength(2);
    // 班级 B：班主任是 delt2，delt1 只是任课授权；delt1 还建了一个任务、发了一条公告
    classB = (await app.inject({ method: "POST", url: "/v1/classes", headers: auth(admin), payload: { name: "删除测试B" } })).json().id;
    await db.query("update classes set head_teacher_id = $2 where id = $1", [classB, ids.delt2]);
    await db.query("insert into teacher_classes (teacher_id, class_id) values ($1, $2)", [ids.delt1, classB]);
    await db.query("insert into tasks (name, business_stage, created_by) values ('删除测试任务', 'pre_sale', $1)", [ids.delt1]);
    await db.query("insert into announcements (publisher_id, class_id, title, content) values ($1, $2, '通知', '内容')", [ids.delt1, classA]);
  });

  it("D-87：名下有班级 / 任务的教师要选接手人；转交后班主任、任课授权、任务、公告都归接手人", async () => {
    const byTeacher = await app.inject({ method: "DELETE", url: `/v1/admin/teachers/${ids.delt1}`, headers: auth(teacherA) });
    expect(byTeacher.statusCode).toBe(403);

    const needSuccessor = await app.inject({ method: "DELETE", url: `/v1/admin/teachers/${ids.delt1}`, headers: auth(admin) });
    expect(needSuccessor.statusCode).toBe(409);
    expect(needSuccessor.json()).toMatchObject({ code: "TEACHER_HAS_WORK", classes: 2, tasks: 1, notices: 1 });

    for (const bad of [ids.delt1, ids.delt3, "not-a-uuid"]) {
      const rejected = await app.inject({ method: "DELETE", url: `/v1/admin/teachers/${ids.delt1}?successorId=${bad}`, headers: auth(admin) });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe("INVALID_SUCCESSOR");
    }

    const done = await app.inject({ method: "DELETE", url: `/v1/admin/teachers/${ids.delt1}?successorId=${ids.delt2}`, headers: auth(admin) });
    expect(done.statusCode).toBe(200);
    expect(await db.query("select 1 from users where id = $1", [ids.delt1]).then((r) => r.rowCount)).toBe(0);
    expect((await db.query("select head_teacher_id from classes where id = $1", [classA])).rows[0].head_teacher_id).toBe(ids.delt2);
    // delt2 本来就是 B 的班主任，不再多一条任课授权
    expect(await db.query("select 1 from teacher_classes where teacher_id = $1", [ids.delt2]).then((r) => r.rowCount)).toBe(0);
    expect((await db.query("select created_by from tasks where name = '删除测试任务'")).rows[0].created_by).toBe(ids.delt2);
    expect((await db.query("select publisher_id from announcements where class_id = $1", [classA])).rows[0].publisher_id).toBe(ids.delt2);
    expect(backups).toBe(0);

    const old = await app.inject({ method: "GET", url: "/v1/me", headers: auth(teacherA) });
    expect(old.statusCode).toBe(401);

    // 名下什么都没有的直接删
    const empty = await app.inject({ method: "DELETE", url: `/v1/admin/teachers/${ids.delt3}`, headers: auth(admin) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().transferred).toBeNull();
  });

  it("D-86：有实训记录的学生输入学号（不分大小写）才连记录一起删，删之前先备份", async () => {
    const teacher = await login("delt2", "Teach#2026");
    const sd001 = await idOf("sd001");
    await db.query("insert into mail_submissions (student_id, template_id, subject, body) values ($1, 'MAIL-CUSTOM', 'Hi', 'Body')", [sd001]);

    const ask = await app.inject({ method: "DELETE", url: `/v1/students/${sd001}`, headers: auth(teacher) });
    expect(ask.statusCode).toBe(409);
    expect(ask.json()).toMatchObject({ code: "STUDENT_HAS_DATA", records: 1 });
    const wrong = await app.inject({ method: "DELETE", url: `/v1/students/${sd001}?confirm=sd002`, headers: auth(teacher) });
    expect(wrong.statusCode).toBe(409);
    expect(backups).toBe(0);

    const done = await app.inject({ method: "DELETE", url: `/v1/students/${sd001}?confirm=%20SD001%20`, headers: auth(teacher) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ records: 1, backup: "backup-test-1.sql" });
    expect(backups).toBe(1);
    expect(await db.query("select 1 from mail_submissions where student_id = $1", [sd001]).then((r) => r.rowCount)).toBe(0);
  });

  it("D-86：还有学生的班级输入班级名才删，学生和他们的记录一起删，删之前先备份；空班级直接删", async () => {
    const teacher = await login("delt2", "Teach#2026");
    const student = await login("sd002", "Stud#2026");
    const outsider = await login("delt4", "Teach#2026");
    expect((await app.inject({ method: "DELETE", url: `/v1/classes/${classA}?confirm=${encodeURIComponent("删除测试A")}`, headers: auth(outsider) })).statusCode).toBe(403);

    const ask = await app.inject({ method: "DELETE", url: `/v1/classes/${classA}`, headers: auth(teacher) });
    expect(ask.statusCode).toBe(409);
    expect(ask.json()).toMatchObject({ code: "CLASS_NOT_EMPTY", students: 1 });

    const done = await app.inject({ method: "DELETE", url: `/v1/classes/${classA}?confirm=${encodeURIComponent("删除测试A")}`, headers: auth(teacher) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ students: 1, backup: "backup-test-2.sql" });
    expect(backups).toBe(2);
    expect(await db.query("select 1 from users where username = 'sd002'").then((r) => r.rowCount)).toBe(0);
    expect(await db.query("select 1 from classes where id = $1", [classA]).then((r) => r.rowCount)).toBe(0);
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: auth(student) })).statusCode).toBe(401);

    const emptyClass = await app.inject({ method: "DELETE", url: `/v1/classes/${classB}`, headers: auth(admin) });
    expect(emptyClass.statusCode).toBe(200);
    expect(backups).toBe(2);
    expect((await app.inject({ method: "DELETE", url: "/v1/classes/not-a-uuid", headers: auth(admin) })).statusCode).toBe(404);
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
    expect(view).toMatchObject({ apiKeyMasked: "sk****78", baseUrl: `${upstreamBase}/ok/v1`, testStatus: "untested", isDefault: false });
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
    expect(list.json().profiles[0]).toMatchObject({ model: "deepseek-v4-pro", testStatus: "untested", apiKeyMasked: "sk****78" });

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

  it("告警：主模型切到备用后带“重新测试”；重新测试通过、或之后再次成功回复，提醒自动消失（不等 24 小时）", async () => {
    type Alert = { title: string; page: string; tab?: string; action?: { kind: string; profileId: string } };
    const failoverAlert = async () =>
      ((await app.inject({ method: "GET", url: "/v1/admin/alerts", headers: auth(admin) })).json() as Alert[])
        .find((item) => item.action?.kind === "test-profile" && item.action.profileId === profileId);
    const failover = () =>
      db.query("insert into audit_log (action, target, detail, created_at) values ('llm.failover', $1, '{}', now() + interval '1 second')", [profileId]);

    await failover();
    const alert = await failoverAlert();
    expect(alert).toMatchObject({ page: "providers", tab: "models" });
    expect(alert!.title).toContain("已自动切到备用模型");

    // 重新测试通过：提醒消失（测试时间晚于切换时间）
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const tested = await app.inject({ method: "POST", url: `/v1/admin/llm/profiles/${profileId}/test`, headers: auth(admin) });
    expect(tested.json().ok).toBe(true);
    expect(await failoverAlert()).toBeUndefined();

    // 又切了一次，之后这个模型成功回复过：同样消失
    await failover();
    expect(await failoverAlert()).toBeDefined();
    const usage = await db.query(
      `insert into llm_usage (profile_id, profile_name, model, purpose, outcome, created_at)
       values ($1, 'x', 'm', 'dialogue', 'success', now() + interval '2 seconds') returning id`,
      [profileId],
    );
    expect(await failoverAlert()).toBeUndefined();
    // 清掉造的数据，免得影响后面按用途统计用量的用例
    await db.query("delete from llm_usage where id = $1", [usage.rows[0].id]);
    await db.query("delete from audit_log where action = 'llm.failover' and target = $1", [profileId]);
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

  it("D-77：换默认时单独指定的用途可一起跟随；备用撞上新默认就主备对调", async () => {
    const second = await app.inject({ method: "POST", url: "/v1/admin/llm/profiles", headers: auth(admin), payload: profilePayload({ name: "总网关" }) });
    const secondId = second.json().id as string;
    expect((await app.inject({ method: "POST", url: `/v1/admin/llm/profiles/${secondId}/test`, headers: auth(admin) })).json().ok).toBe(true);
    const original = (await app.inject({ method: "GET", url: "/v1/admin/llm", headers: auth(admin) })).json().routing;
    expect(original.routes.director.profileId).toBe(profileId);
    await app.inject({
      method: "PUT",
      url: "/v1/admin/llm/routing",
      headers: auth(admin),
      payload: { ...original, routes: { ...original.routes, dialogue: { ...original.routes.dialogue, profileId, fallbackProfileId: secondId } } },
    });

    const followed = await app.inject({ method: "PUT", url: "/v1/admin/llm/default", headers: auth(admin), payload: { profileId: secondId, followRouting: true } });
    expect(followed.statusCode).toBe(200);
    expect(followed.json().routing.routes.dialogue).toMatchObject({ profileId: null, fallbackProfileId: profileId });
    expect(followed.json().routing.routes.director).toMatchObject({ profileId: null, fallbackProfileId: null });

    // 换回来、只改默认：对话跟随默认，备用正好是新默认，换成原来的主模型
    await app.inject({ method: "PUT", url: "/v1/admin/llm/default", headers: auth(admin), payload: { profileId } });
    const saved = (await app.inject({ method: "GET", url: "/v1/admin/llm", headers: auth(admin) })).json();
    expect(saved.routing.routes.dialogue).toMatchObject({ profileId: null, fallbackProfileId: secondId });
    expect(saved.profiles.find((item: { isDefault: boolean }) => item.isDefault).id).toBe(profileId);

    await app.inject({ method: "PUT", url: "/v1/admin/llm/routing", headers: auth(admin), payload: original });
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/llm/profiles/${secondId}`, headers: auth(admin) })).statusCode).toBe(200);
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
    expect(view.json().voice).toMatchObject({ vendor: "doubao", apiKeyMasked: "vo****56", ttsPricePer10kChars: 3 });
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
        // 结构化输出请求（观察员）返回 JSON，其余返回买家台词；多给的 directive / memory 是旧版字段，应被丢弃
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

  it("售前会话：买家拿到在售商品；开场与回复按 ||| 拆条落库；观察员 JSON 更新会话状态但不回写买家", async () => {
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
    expect(state).toMatchObject({ satisfaction: 71, emotion: "平静", stage: "方案协商", studentTurns: 1 });
    expect(state.memory).toBeUndefined();
    expect(state.directive).toBeUndefined();

    // D-50：评估结果只给教师端和评分，下一轮买家提示词里不出现情绪分数、指令或备忘录
    const nextTurn = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: auth(student),
      payload: { content: "It ships in 2 days." },
    });
    expect(nextTurn.body).toContain('"type":"done"');
    const buyerSystem = (requests.filter((body) => !body.response_format).at(-1) as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(buyerSystem).not.toContain("Director");
    expect(buyerSystem).not.toContain("satisfaction");
    expect(buyerSystem).not.toContain("方案协商");

    const metric = (await db.query("select provider, model, outcome, first_char_at >= received_at as ordered from conversation_metrics where conversation_id = $1", [conversationId])).rows;
    expect(metric).toHaveLength(3);
    expect(metric.every((row) => row.provider === "对话测试" && row.model === "fake-model" && row.outcome === "success" && row.ordered)).toBe(true);
    // 学生发言计数在评估前就原子加 1（L2），等观察员第二次写完再数调用
    await waitFor(async () => (await db.query("select state from conversations where id = $1", [conversationId])).rows[0].state.turnCount === 2);
    expect((await db.query("select state from conversations where id = $1", [conversationId])).rows[0].state.studentTurns).toBe(2);
    const usage = (await db.query("select purpose, count(*)::int as n from llm_usage where conversation_id = $1 group by purpose order by purpose", [conversationId])).rows;
    expect(usage).toEqual([{ purpose: "dialogue", n: 3 }, { purpose: "director", n: 2 }]);
  });
});

describe("后台任务可靠性（L1 / L2 / L4）", () => {
  // 假网关：按用途返回结果，记调用次数；不碰真实模型
  const info = { profileId: null, profileName: "假模型", model: "fake", fallback: false };
  const scored = {
    scores: { professionalism: 80, effectiveness: 78, empathy: 76, resolution: 74, knowledge: 72, grammar: 85, compliance: 90 },
    comment: "整体不错",
    suggestions: ["先确认订单号"],
  };
  function fakeGateway(handler: (purpose: string) => Promise<unknown>) {
    const calls: string[] = [];
    const gateway = {
      isConfigured: () => true,
      directorEveryNTurns: 1,
      complete: async (purpose: string) => {
        calls.push(purpose);
        return { text: "ok", info };
      },
      completeJson: async (purpose: string) => {
        calls.push(purpose);
        return { data: await handler(purpose), info };
      },
    };
    return { gateway: gateway as unknown as import("./llm/gateway").LlmGateway, calls };
  }
  const quietLog = { error: () => undefined, info: () => undefined, warn: () => undefined };
  let studentId = "";
  let taskId = "";
  let student: Session;
  let admin: Session;

  beforeAll(async () => {
    const { hashPassword } = await import("./security");
    await db.query(
      `insert into users (username, display_name, role, password_hash, must_change_password)
       values ('s-bg', '补漏测试学生', 'student', $1, false) on conflict do nothing`,
      [await hashPassword("Student#Bg01")],
    );
    studentId = (await db.query("select id from users where username = 's-bg'")).rows[0].id;
    taskId = (await db.query("select id from tasks order by created_at limit 1")).rows[0].id;
    student = await login("s-bg", "Student#Bg01");
    admin = await login("admin", "Admin#Prod9");
  });

  /** 一次已经结束 10 分钟的任务接待：学生说了 2 轮 */
  async function closedTaskConversation(reason = "student_ended", state: Record<string, unknown> = {}): Promise<string> {
    const created = await db.query(
      `insert into conversations (student_id, task_id, scenario_id, persona, state, status, closed_reason, closed_at, created_at)
       values ($1, $2, 'AFTER-001', '{"name":"Emma"}', $3, 'closed', $4, now() - interval '10 minutes', now() - interval '20 minutes') returning id`,
      [studentId, taskId, JSON.stringify(state), reason],
    );
    const id = created.rows[0].id as string;
    const lines = [["buyer", "My mat arrived torn."], ["student", "Sorry! Could you share a photo?"], ["buyer", "Sure, here."], ["student", "We will send a replacement."]];
    for (const [index, [sender, content]] of lines.entries()) {
      await db.query(
        `insert into conversation_messages (conversation_id, sender, content, created_at)
         values ($1, $2, $3, now() - interval '19 minutes' + make_interval(secs => $4))`,
        [id, sender, content, index * 30],
      );
    }
    return id;
  }
  const attempts = async (id: string) => Number((await db.query("select assess_attempts from conversations where id = $1", [id])).rows[0].assess_attempts);
  const hasScore = async (id: string) => Boolean((await db.query("select 1 from assessments where conversation_id = $1", [id])).rowCount);

  it("L1：评分出错退避重试；补漏捡回没出分的接待，试满 3 次进告警，管理员一键重新评分", async () => {
    const { assessConversation } = await import("./assessment");
    const { sweepBackgroundJobs } = await import("./lifecycle");
    const id = await closedTaskConversation();
    let fail = true;
    const { gateway, calls } = fakeGateway(async () => {
      if (fail) throw new Error("upstream down");
      return scored;
    });

    // 一次评分 = 首次 + 进程内重试 2 次
    await expect(assessConversation(db, gateway, id)).rejects.toThrow("upstream down");
    expect(calls).toHaveLength(3);
    expect(await attempts(id)).toBe(1);

    // 没出分时学生、教师看到“评分中”
    const records = (await app.inject({ method: "GET", url: "/v1/student/assessments", headers: auth(student) })).json();
    expect(records.pending).toEqual([expect.objectContaining({ conversationId: id, buyerName: "Emma", failed: false })]);
    const teacherPending = (await app.inject({ method: "GET", url: "/v1/teacher/pending-scores", headers: auth(admin) })).json();
    expect(teacherPending.find((row: { conversationId: string }) => row.conversationId === id)).toMatchObject({ failed: false });

    // 补漏再跑两轮仍失败；试满 3 次后不再自动补
    await sweepBackgroundJobs(db, gateway, quietLog);
    await sweepBackgroundJobs(db, gateway, quietLog);
    expect(await attempts(id)).toBe(3);
    calls.length = 0;
    await sweepBackgroundJobs(db, gateway, quietLog);
    expect(calls).toHaveLength(0);

    // 进系统总览告警，带“重新评分”；学生那边显示暂未评分
    const alerts = (await app.inject({ method: "GET", url: "/v1/admin/alerts", headers: auth(admin) })).json() as Array<{ title: string; action?: { kind: string } }>;
    expect(alerts.find((item) => item.action?.kind === "retry-assessments")?.title).toBe("1 次接待自动评分失败");
    const failedRecords = (await app.inject({ method: "GET", url: "/v1/student/assessments", headers: auth(student) })).json();
    expect(failedRecords.pending[0]).toMatchObject({ conversationId: id, failed: true });

    // 管理员重新评分：次数清零、告警消失
    const retried = await app.inject({ method: "POST", url: "/v1/admin/assessments/retry", headers: auth(admin) });
    expect(retried.json()).toEqual({ count: 1 });
    const afterRetry = (await app.inject({ method: "GET", url: "/v1/admin/alerts", headers: auth(admin) })).json() as Array<{ action?: { kind: string } }>;
    expect(afterRetry.some((item) => item.action?.kind === "retry-assessments")).toBe(false);

    // 模型恢复后评分写入（后台那次重评用的是测试服务器的网关，可能还在跑，等它结束再评）
    fail = false;
    for (let i = 0; i < 40 && !(await hasScore(id)); i += 1) {
      await assessConversation(db, gateway, id).catch(() => new Promise((resolve) => setTimeout(resolve, 50)));
    }
    expect(await hasScore(id)).toBe(true);
    const done = (await app.inject({ method: "GET", url: "/v1/student/assessments", headers: auth(student) })).json();
    expect(done.pending).toEqual([]);
    expect(done.records.find((row: { conversationId: string }) => row.conversationId === id)).toBeDefined();
  });

  it("L1：买家留评补漏——学生结束后没写成的评价补上，跑完记下不再重复", async () => {
    const { sweepBackgroundJobs } = await import("./lifecycle");
    const id = await closedTaskConversation("buyer_left", { satisfaction: 90 });
    await db.query(
      `insert into orders (conversation_id, student_id, order_no, status, product_name, total_amount, payload, is_primary)
       values ($1, $2, 'PO-BG-1', 'delivered', 'Yoga Mat', 29.9, '{"status":"delivered","productName":"Yoga Mat"}', true)`,
      [id, studentId],
    );
    const { gateway, calls } = fakeGateway(async (purpose) => (purpose === "assist" ? { content: "Great service, fast replacement!" } : scored));
    await sweepBackgroundJobs(db, gateway, quietLog);
    const order = (await db.query("select payload from orders where conversation_id = $1", [id])).rows[0].payload;
    expect(order.review).toMatchObject({ rating: 5, content: "Great service, fast replacement!" });
    expect((await db.query("select review_done_at from conversations where id = $1", [id])).rows[0].review_done_at).not.toBeNull();
    expect(await hasScore(id)).toBe(true);

    calls.length = 0;
    await sweepBackgroundJobs(db, gateway, quietLog);
    expect(calls).toHaveLength(0);
  });

  it("L2：同一会话的观察员串行，学生发言计数不丢；评估期间催促写进去的满意度不被覆盖", async () => {
    const { runDirector, updateSessionState } = await import("./director");
    const created = await db.query(
      `insert into conversations (student_id, scenario_id, persona, state, status)
       values ($1, 'AFTER-001', '{"name":"Emma"}', '{"satisfactions":[60]}', 'active') returning id`,
      [studentId],
    );
    const id = created.rows[0].id as string;
    await db.query("insert into conversation_messages (conversation_id, sender, content) values ($1, 'buyer', 'Hi'), ($1, 'student', 'Hello!')", [id]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    let maxRunning = 0;
    const { gateway, calls } = fakeGateway(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running -= 1;
      return { turnScore: 80, satisfaction: 75, emotion: "平静", stage: "方案协商" };
    });

    // 学生连发两条：第二轮到的时候第一次还没评完
    const first = runDirector(db, gateway, id);
    const second = runDirector(db, gateway, id);
    for (let i = 0; i < 40 && calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    // 评估期间催促写了一个满意度点
    await updateSessionState(db, id, (current) => ({ satisfactions: [...(current.satisfactions ?? []), 40] }));
    release();
    await Promise.all([first, second]);

    expect(calls).toEqual(["director", "director"]);
    expect(maxRunning).toBe(1);
    const state = (await db.query("select state from conversations where id = $1", [id])).rows[0].state;
    expect(state).toMatchObject({ studentTurns: 2, turnCount: 2, satisfaction: 75, satisfactions: [60, 40, 75, 75] });
  });

  it("L4：API 重启时停在“运行中”的验收标成已中断，可以重新运行", async () => {
    const { closeInterruptedAcceptance, getAcceptanceRunState } = await import("./acceptance");
    const { setSetting } = await import("./settings");
    await setSetting(db, "acceptance_run", { running: true, done: 37, total: 100, startedAt: new Date().toISOString() });
    expect(await closeInterruptedAcceptance(db)).toBe(true);
    expect(await getAcceptanceRunState(db)).toMatchObject({ running: false, interrupted: true, done: 37, total: 100 });
    expect(await closeInterruptedAcceptance(db)).toBe(false);
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

describe("学生、教师只能用客户端登录（A3 / D-83）与跨域收紧（F）", () => {
  let strict: FastifyInstance;
  const desktopUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Electron/43.1.0 Safari/537.36 CecsDesktop/0.1.0";
  const browserUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

  beforeAll(async () => {
    // 同一个测试库再起一个按生产配置的实例：只认客户端、不放行跨域
    strict = await buildServer({
      db,
      logger: false,
      env: { jwtSecret: "test-secret", adminInitialPassword: "Admin#Test1", llmBaseUrl: "", llmApiKey: "", llmModel: "", ttsApiKey: "", desktopOnly: true, corsOrigins: false },
    });
  });
  afterAll(async () => {
    await strict.close();
  });

  const loginWith = (username: string, password: string, userAgent: string) =>
    strict.inject({ method: "POST", url: "/v1/auth/login", headers: { "user-agent": userAgent }, payload: { username, password } });

  it("浏览器登录教师账号被拒、不签发令牌；客户端可以登录；管理员浏览器照常登录", async () => {
    const fromBrowser = await loginWith("teacher1", "Teach#2026", browserUa);
    expect(fromBrowser.statusCode).toBe(403);
    expect(fromBrowser.json()).toMatchObject({ code: "CLIENT_REQUIRED", message: "教师账号请在客户端登录。" });
    expect(fromBrowser.json().accessToken).toBeUndefined();

    const fromClient = await loginWith("teacher1", "Teach#2026", desktopUa);
    expect(fromClient.statusCode).toBe(200);

    const admin = await loginWith("admin", "Admin#Prod9", browserUa);
    expect(admin.statusCode).toBe(200);
  });

  it("密码错时照常报账号或密码错误，不提示要用客户端", async () => {
    const wrong = await loginWith("teacher1", "wrong-pass", browserUa);
    expect(wrong.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("跨域请求拿不到放行头（页面和接口同源，不需要跨域）", async () => {
    const response = await strict.inject({ method: "GET", url: "/v1/public/brand", headers: { origin: "https://evil.example" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
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
    // 音色 ID 中间允许空格（阿里云 Ono Anna），但不能有斜杠等字符
    const bad = await app.inject({ method: "POST", url: "/v1/admin/voice/preview", headers: auth(admin), payload: { speaker: "x/y" } });
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

describe("学生端改版：店铺资料、系统客户标签与客服标记（C2）、关键数字（C1）、截止拦截（D1）", () => {
  let teacher: Session;
  let student: Session;
  beforeAll(async () => {
    teacher = await login("teacher1", "Teach#2026");
    const id = (await db.query("select id from users where username = 's2501001'")).rows[0].id;
    const reset = await app.inject({ method: "POST", url: `/v1/students/${id}/reset-password`, headers: auth(teacher) });
    const pending = await login("s2501001", reset.json().temporaryPassword);
    await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: auth(pending),
      payload: { currentPassword: reset.json().temporaryPassword, newPassword: "Redo#2026" },
    });
    student = await login("s2501001", "Redo#2026");
  });

  it("店铺资料：默认值、老师可改、学生只读、非法邮箱被拒", async () => {
    const initial = await app.inject({ method: "GET", url: "/v1/store/profile", headers: auth(student) });
    expect(initial.json()).toMatchObject({ name: "Aurora Mart", supportEmail: "support@auroramart.com", tiers: { bigOrderSingle: 100 } });
    const denied = await app.inject({ method: "PUT", url: "/v1/store/profile", headers: auth(student), payload: { name: "X" } });
    expect(denied.statusCode).toBe(403);
    const bad = await app.inject({ method: "PUT", url: "/v1/store/profile", headers: auth(teacher), payload: { supportEmail: "not-mail" } });
    expect(bad.statusCode).toBe(400);
    const saved = await app.inject({ method: "PUT", url: "/v1/store/profile", headers: auth(teacher), payload: { name: "Nova Shop", tiers: { dormantDays: 120 } } });
    expect(saved.json()).toMatchObject({ name: "Nova Shop", tiers: { dormantDays: 120, bigOrderSingle: 100 } });
  });

  it("会话带系统客户标签和预填咨询原因；学生可确认原因、标待跟进、写备注", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "IN-002" } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    const list = (await app.inject({ method: "GET", url: "/v1/conversations", headers: auth(student) })).json() as Array<Record<string, unknown>>;
    const row = list.find((item) => item.id === id)!;
    expect(Array.isArray(row.customerTags)).toBe(true);
    expect((row.customerTags as string[]).length).toBeGreaterThan(0);
    expect(row.contactReasonSuggested).toBe("清关问题");
    expect(row.contactReason).toBeNull();
    const invalid = await app.inject({ method: "PATCH", url: `/v1/conversations/${id}/service-meta`, headers: auth(student), payload: { contactReason: "随便写" } });
    expect(invalid.statusCode).toBe(400);
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/conversations/${id}/service-meta`,
      headers: auth(student),
      payload: { contactReason: "物流查询", followUp: true, buyerNote: "周五出差，着急" },
    });
    expect(patched.json()).toMatchObject({ contactReason: "物流查询", followUp: true, buyerNote: "周五出差，着急" });
    const persona = (await db.query("select persona from conversations where id = $1", [id])).rows[0].persona;
    expect(persona.storeName).toBe("Nova Shop");
  });

  it("D-96 会话未读：买家消息计未读，学生看过清零，之后再来的重新计；只能标自己的会话", async () => {
    const id = (await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "IN-002" } })).json().id as string;
    const unread = async () =>
      ((await app.inject({ method: "GET", url: "/v1/conversations", headers: auth(student) })).json() as Array<Record<string, unknown>>)
        .find((item) => item.id === id)!.unreadCount;
    expect(await unread()).toBe(0);
    await db.query("insert into conversation_messages (conversation_id, sender, content) values ($1, 'buyer', 'Hi'), ($1, 'buyer', 'Anyone there?')", [id]);
    expect(await unread()).toBe(2);
    expect((await app.inject({ method: "POST", url: `/v1/conversations/${id}/read`, headers: auth(student) })).statusCode).toBe(200);
    expect(await unread()).toBe(0);
    // 客服自己的消息不算；之后买家再发的重新计（时间往后拨一秒，免得和已读时间落在同一时刻）
    await db.query(
      `insert into conversation_messages (conversation_id, sender, content, created_at)
       values ($1, 'student', 'Hello!', now() + interval '1 second'), ($1, 'buyer', 'Where is my parcel?', now() + interval '1 second')`,
      [id],
    );
    expect(await unread()).toBe(1);
    const missing = await app.inject({ method: "POST", url: "/v1/conversations/00000000-0000-4000-8000-000000000000/read", headers: auth(student) });
    expect(missing.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/conversations/${id}/read`, headers: auth(teacher) })).statusCode).toBe(403);
  });

  it("关键数字：已完成任务、班级排名、累计对话", async () => {
    const summary = await app.inject({ method: "GET", url: "/v1/student/summary", headers: auth(student) });
    expect(summary.statusCode).toBe(200);
    const body = summary.json();
    expect(body.tasks.total).toBeGreaterThanOrEqual(0);
    expect(body.rank.classSize).toBeGreaterThan(0);
    expect(body.conversations).toHaveProperty("rounds");
    expect(body.weekDaily).toHaveLength(7);
    expect(body.weekDaily.reduce((a: number, b: number) => a + b, 0)).toBe(body.weekConversations);
    expect(body.weekPractice).toBeLessThanOrEqual(body.weekConversations);
  });

  it("译文存库：同一段文字第二次直接读库，不再调用模型", async () => {
    const { createHash } = await import("node:crypto");
    const text = "Package arrived with a part missing.";
    await db.query("insert into text_translations (text_hash, source, translation) values ($1, $2, $3)", [
      createHash("sha256").update(text).digest("hex"), text, "包裹到了但少了一个部件。",
    ]);
    const hit = await app.inject({ method: "POST", url: "/v1/translate", headers: auth(student), payload: { text } });
    expect(hit.json()).toMatchObject({ translation: "包裹到了但少了一个部件。", cached: true });
  });

  it("过了截止时间的任务不能再进线", async () => {
    const studentId = (await db.query("select id from users where username = 's2501001'")).rows[0].id;
    const adminId = (await db.query("select id from users where username = 'admin'")).rows[0].id;
    const task = await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by, deadline)
       values ('已截止', 'in_sale', '["IN-002"]', 'text', '{}', 'published', $1, now() - interval '1 hour') returning id`,
      [adminId],
    );
    await db.query("insert into task_progress (task_id, student_id) values ($1, $2)", [task.rows[0].id, studentId]);
    const blocked = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { taskId: task.rows[0].id } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("TASK_CLOSED");
  });
});

describe("买家耐心（D-40）", () => {
  const log = { error: () => undefined, info: () => undefined, warn: () => undefined };
  const fakeGateway = (configured: boolean) => {
    let calls = 0;
    const gateway = {
      isConfigured: (purpose: string) => configured && purpose === "dialogue",
      complete: async () => ({ text: `Hello? Anyone there? (${++calls})`, info: {} }),
    } as unknown as import("./llm/gateway").LlmGateway;
    return { gateway, calls: () => calls };
  };
  const setup = async (lastBuyerMinutesAgo: number, persona: Record<string, unknown> = { personality: "理性谨慎", emotion: "平静", language: "en-US" }) => {
    const student = (await db.query("select id from users where role = 'student' limit 1")).rows[0].id;
    const conv = await db.query(
      `insert into conversations (student_id, scenario_id, status, persona) values ($1, 'AFTER-001', 'active', $2) returning id`,
      [student, JSON.stringify(persona)],
    );
    const id = conv.rows[0].id as string;
    await db.query(
      `insert into conversation_messages (conversation_id, sender, content, created_at) values ($1, 'buyer', 'Where is my order?', now() - ($2::float * interval '1 minute'))`,
      [id, lastBuyerMinutesAgo],
    );
    return id;
  };
  const messageCount = async (id: string) => Number((await db.query("select count(*) from conversation_messages where conversation_id = $1", [id])).rows[0].count);

  it("模型未配置时不催也不离开", async () => {
    const { sweepBuyerPatience } = await import("./nudge");
    const id = await setup(30);
    const { gateway } = fakeGateway(false);
    expect(await sweepBuyerPatience(db, gateway, log)).toBe(0);
    expect(await messageCount(id)).toBe(1);
    expect((await db.query("select status from conversations where id = $1", [id])).rows[0].status).toBe("active");
    await db.query("update conversations set status = 'closed' where id = $1", [id]); // 不影响后面的用例
  });

  it("等待够久才催；催过不重复；客服回复后清零；最后离开并关闭", async () => {
    const { sweepBuyerPatience } = await import("./nudge");
    const { gateway, calls } = fakeGateway(true);
    const fresh = await setup(1);
    const waiting = await setup(3);
    await sweepBuyerPatience(db, gateway, log);
    expect(await messageCount(fresh)).toBe(1);
    expect(await messageCount(waiting)).toBe(2);
    const state = (await db.query("select state from conversations where id = $1", [waiting])).rows[0].state;
    expect(state.nudge.count).toBe(1);
    expect(state.satisfaction).toBe(52);
    // 再扫一次：还没到第 2 次，不会重复催
    const before = calls();
    await sweepBuyerPatience(db, gateway, log);
    expect(calls()).toBe(before);

    // 客服回复：最后一条是学生，不再催
    await db.query("insert into conversation_messages (conversation_id, sender, content) values ($1, 'student', 'Checking now')", [waiting]);
    await sweepBuyerPatience(db, gateway, log);
    expect(await messageCount(waiting)).toBe(3);

    // 第 3 阶段：等了很久且已催过 2 次 -> 离开
    const left = await setup(12);
    await db.query("update conversations set state = $2 where id = $1", [left, JSON.stringify({ nudge: { baseAt: new Date(Date.now() - 12 * 60_000).toISOString(), count: 2, lastMessageId: (await db.query("select id from conversation_messages where conversation_id = $1", [left])).rows[0].id } })]);
    await sweepBuyerPatience(db, gateway, log);
    expect((await db.query("select status, closed_reason from conversations where id = $1", [left])).rows[0]).toMatchObject({ status: "closed", closed_reason: "buyer_left" });
  });

  it("焦虑买家等待时间减半", async () => {
    const { sweepBuyerPatience } = await import("./nudge");
    const { gateway } = fakeGateway(true);
    const anxious = await setup(1.5, { personality: "直接高效", emotion: "焦虑", language: "en-US" });
    const easygoing = await setup(1.5, { personality: "友好健谈", emotion: "平静", language: "en-US" });
    await sweepBuyerPatience(db, gateway, log);
    expect(await messageCount(anxious)).toBe(2);
    expect(await messageCount(easygoing)).toBe(1);
  });
});

describe("参数核对 · 学生端（D-53 关键数字、D-54 服务评价、D-56 工具卡片跟进、D-58 邮件任务）", () => {
  let upstream: Server;
  let student: Session;
  let studentId: string;
  const requests: Array<{ messages: Array<{ role: string; content: string }>; response_format?: unknown }> = [];
  /** 下一条买家台词（假上游按它回） */
  let nextReply = "ok";

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        // 结构化输出（观察员、评分、邮件评分）共用一份 JSON，各自只取自己的字段
        const text = body.response_format
          ? JSON.stringify({
              turnScore: 80, satisfaction: 88, emotion: "平静", stage: "方案协商",
              scores: { professionalism: 81, effectiveness: 78, empathy: 75, resolution: 72, knowledge: 80, grammar: 85, compliance: 95 },
              comment: "主题清楚", suggestions: ["正文再短一点"],
            })
          : nextReply;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: text } }] })}\n\n` +
            `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n",
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const { createSecretSealer } = await import("./llm/secret");
    await db.query("update llm_profiles set is_default = false");
    await db.query(
      `insert into llm_profiles (name, base_url, api_key_enc, model, json_mode, is_default, test_status)
       values ('参数核对测试', $1, $2, 'fake-model', true, true, 'ok')`,
      [`${base}/v1`, createSecretSealer("test-secret").seal("sk-param")],
    );
    await db.query("delete from app_settings where key = 'llm_routing'");
    const admin = await login("admin", "Admin#Prod9");
    expect((await app.inject({ method: "PUT", url: "/v1/admin/llm/routing", headers: auth(admin), payload: { directorEveryNTurns: 1 } })).statusCode).toBe(200);
    const { hashPassword } = await import("./security");
    await db.query(
      `insert into users (username, display_name, role, password_hash, must_change_password)
       values ('s-param', '参数核对学生', 'student', $1, false) on conflict (username) do nothing`,
      [await hashPassword("Student#Param1")],
    );
    student = await login("s-param", "Student#Param1");
    studentId = (await db.query("select id from users where username = 's-param'")).rows[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function waitFor(check: () => Promise<boolean>, tries = 100) {
    for (let i = 0; i < tries; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const conversationRow = async (id: string) => (await db.query("select * from conversations where id = $1", [id])).rows[0];

  it("D-54：结束接待按满意度打星（不是消息），满意率按 4–5 星算；D-53：平均响应时长", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "AFTER-001" } });
    const id = created.json().id as string;
    await db.query(
      `insert into conversation_messages (conversation_id, sender, content, created_at) values
         ($1, 'buyer', 'It arrived broken', now() - interval '90 seconds'),
         ($1, 'student', 'So sorry, sending a new one today', now() - interval '60 seconds')`,
      [id],
    );
    await db.query("update conversations set state = coalesce(state, '{}'::jsonb) || jsonb_build_object('satisfaction', 88) where id = $1", [id]);
    expect((await app.inject({ method: "POST", url: `/v1/conversations/${id}/close`, headers: auth(student) })).statusCode).toBe(200);
    expect((await conversationRow(id)).service_rating).toBe(5);
    expect(Number((await db.query("select count(*) from conversation_messages where conversation_id = $1", [id])).rows[0].count)).toBe(2);
    const closed = (await app.inject({ method: "GET", url: "/v1/conversations?status=closed", headers: auth(student) })).json() as Array<Record<string, unknown>>;
    expect(closed.find((item) => item.id === id)).toMatchObject({ serviceRating: 5 });

    const summary = (await app.inject({ method: "GET", url: "/v1/student/summary", headers: auth(student) })).json();
    expect(summary.rating).toMatchObject({ total: 1, satisfied: 1, rate: 100, counts: [1, 0, 0, 0, 0] });
    expect(summary.response.turns).toBe(1);
    expect(summary.response.avgSeconds).toBe(30);
    const stats = (await app.inject({ method: "GET", url: "/v1/student/workbench-stats", headers: auth(student) })).json();
    expect(stats.satisfactionRate).toBe(100);
  });

  it("D-61：复盘“本次接待”和我的记录、工作台顶栏同一套算法（3 分钟回复率、单轮封顶、买家等太久离开）", async () => {
    const task = await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by)
       values ('D-61 接待指标', 'after_sale', '["AFTER-001"]', 'text', '{}', 'published', (select id from users where username = 'admin')) returning id`,
    );
    const conversation = await db.query(
      `insert into conversations (task_id, student_id, scenario_id, status, closed_reason, service_rating, created_at, closed_at)
       values ($1, $2, 'AFTER-001', 'closed', 'buyer_left', 4, now() - interval '20 minutes', now() - interval '2 minutes') returning id`,
      [task.rows[0].id, studentId],
    );
    const id = conversation.rows[0].id as string;
    // 第 1 轮 60 秒回（达标）；第 2 轮 300 秒回（没达标）；第 3 轮一直没回，等了 8 分钟买家离开（计入、没达标）
    await db.query(
      `insert into conversation_messages (conversation_id, sender, content, created_at) values
         ($1, 'buyer', 'Hi', now() - interval '20 minutes'),
         ($1, 'student', 'Hello', now() - interval '19 minutes'),
         ($1, 'buyer', 'Any update?', now() - interval '18 minutes'),
         ($1, 'teacher', '先安抚', now() - interval '16 minutes'),
         ($1, 'student', 'Checking now', now() - interval '13 minutes'),
         ($1, 'buyer', 'Hello?', now() - interval '10 minutes')`,
      [id],
    );
    await db.query(
      `insert into assessments (conversation_id, student_id, scores, total, comment) values ($1, $2, $3, 60, '响应偏慢')`,
      [id, studentId, JSON.stringify({ professionalism: 60, effectiveness: 60, empathy: 60, resolution: 60, grammar: 60, compliance: 60 })],
    );
    const expected = { rating: 4, avgReplySec: 180, replyWithin: { within: 1, counted: 3 }, rounds: 2, durationSec: 1080, endReason: "left_waiting" };

    // 限时到由后台巡检关闭，关闭时间晚：接待时长按最后一条消息算（20 分钟进线，15 分钟前最后一条 → 5 分钟）
    const swept = await db.query(
      `insert into conversations (task_id, student_id, scenario_id, status, closed_reason, created_at, closed_at)
       values ($1, $2, 'AFTER-001', 'closed', 'timeout', now() - interval '20 minutes', now()) returning id`,
      [task.rows[0].id, studentId],
    );
    await db.query("insert into conversation_messages (conversation_id, sender, content, created_at) values ($1, 'student', 'Hello', now() - interval '15 minutes')", [swept.rows[0].id]);
    await db.query(`insert into assessments (conversation_id, student_id, scores, total, comment) values ($1, $2, '{}', 50, '超时')`, [swept.rows[0].id, studentId]);

    const records = (await app.inject({ method: "GET", url: "/v1/student/assessments", headers: auth(student) })).json();
    expect(records.records.find((item: { conversationId: string }) => item.conversationId === id).reception).toEqual(expected);
    expect(records.records.find((item: { conversationId: string }) => item.conversationId === swept.rows[0].id).reception).toMatchObject({ durationSec: 300, endReason: "timeout", rounds: 1 });
    const admin = await login("admin", "Admin#Prod9");
    const reviews = (await app.inject({ method: "GET", url: "/v1/teacher/assessments", headers: auth(admin) })).json() as Array<{ conversationId: string; reception: unknown }>;
    expect(reviews.find((item) => item.conversationId === id)!.reception).toEqual(expected);

    // 总数 = 上一条用例的那次接待（30 秒回，达标）+ 这一次：(30 + 60 + 300) / 3 = 130 秒；3 分钟回复率 2 / 4
    const summary = (await app.inject({ method: "GET", url: "/v1/student/summary", headers: auth(student) })).json();
    expect(summary.response).toMatchObject({ avgSeconds: 130, turns: 3, withinRate: 50 });
    const stats = (await app.inject({ method: "GET", url: "/v1/student/workbench-stats", headers: auth(student) })).json();
    expect(stats).not.toHaveProperty("twelveHourResponseRate");
    expect(stats.replyWithinRate).toBeGreaterThanOrEqual(0);
  });

  it("D-66：优惠券由教师端配置；学生只看得到启用的券；停用的发不出去；券卡片带门槛和适用客户，存快照", async () => {
    const admin = await login("admin", "Admin#Prod9");
    const listAll = (await app.inject({ method: "GET", url: "/v1/store/coupons", headers: auth(admin) })).json() as Array<{ id: string; rule: string; scope: string }>;
    expect(listAll.find((item) => item.id === "CPN-001")).toMatchObject({ rule: "满 $30 减 $5", scope: "全店商品 · 仅潜在意向客" });
    const bad = await app.inject({ method: "POST", url: "/v1/store/coupons", headers: auth(admin), payload: { title: "Too Much", kind: "percent", amount: 95, threshold: 0, validDays: 3 } });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST", url: "/v1/store/coupons", headers: auth(admin),
      payload: { title: "VIP $10 Off", kind: "amount", amount: 10, threshold: 60, customerTypes: ["粉丝客"], validDays: 14 },
    });
    expect(created.statusCode).toBe(200);
    const vip = created.json().id as string;
    expect((await app.inject({ method: "PATCH", url: "/v1/store/coupons/CPN-002", headers: auth(admin), payload: { enabled: false } })).statusCode).toBe(200);

    const seen = (await app.inject({ method: "GET", url: "/v1/store/coupons", headers: auth(student) })).json() as Array<{ id: string; rule: string; scope: string }>;
    expect(seen.some((item) => item.id === "CPN-002")).toBe(false);
    expect(seen.find((item) => item.id === vip)).toMatchObject({ rule: "满 $60 减 $10", scope: "全店商品 · 仅粉丝客" });

    const conversation = (await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "AFTER-001" } })).json().id as string;
    const off = await app.inject({ method: "POST", url: `/v1/conversations/${conversation}/cards`, headers: auth(student), payload: { type: "coupon", refId: "CPN-002" } });
    expect(off.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/v1/conversations/${conversation}/cards`, headers: auth(student), payload: { type: "coupon", refId: vip } })).statusCode).toBe(200);
    const sent = (await db.query("select content, payload from conversation_messages where conversation_id = $1 and kind = 'coupon'", [conversation])).rows[0];
    expect(sent.content).toContain("仅粉丝客");
    // 删券不影响已经发出去的卡片
    expect((await app.inject({ method: "DELETE", url: `/v1/store/coupons/${vip}`, headers: auth(admin) })).statusCode).toBe(200);
    expect((await db.query("select payload from conversation_messages where conversation_id = $1 and kind = 'coupon'", [conversation])).rows[0].payload).toMatchObject({ title: "VIP $10 Off", rule: "满 $60 减 $10" });
    await app.inject({ method: "PATCH", url: "/v1/store/coupons/CPN-002", headers: auth(admin), payload: { enabled: true } });
  });

  it("D-56：会话结束后发物流通知卡片，买家回复后跟进，客服回满 3 轮自动结束，不改原结束原因和星级", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "IN-002" } });
    const id = created.json().id as string;
    await db.query("insert into conversation_messages (conversation_id, sender, content) values ($1, 'buyer', 'Where is my parcel?')", [id]);
    await app.inject({ method: "POST", url: `/v1/conversations/${id}/close`, headers: auth(student) });
    const before = await conversationRow(id);
    expect(before).toMatchObject({ status: "closed", closed_reason: "student_ended" });
    const order = (await db.query("select id, payload from orders where conversation_id = $1 and payload->'logistics' <> 'null'::jsonb order by is_primary desc limit 1", [id])).rows[0];
    expect(order).toBeTruthy();

    // 付款提醒只给待付款订单
    const wrong = await app.inject({ method: "POST", url: `/v1/orders/${order.id}/tool-cards`, headers: auth(student), payload: { kind: "payment_reminder", text: "Please pay" } });
    expect(wrong.json().code).toBe("TOOL_NOT_APPLICABLE");

    nextReply = "Thanks! When will it arrive?";
    const sent = await app.inject({ method: "POST", url: `/v1/orders/${order.id}/tool-cards`, headers: auth(student), payload: { kind: "logistics_update", text: "Your parcel is in customs now." } });
    expect(sent.json()).toMatchObject({ delivered: "closed", conversationId: id });
    await waitFor(async () => (await conversationRow(id)).status === "active");
    const reopened = await conversationRow(id);
    expect(reopened.tool_followup).toMatchObject({ kind: "logistics_update", orderId: order.id });
    expect(reopened.tool_followup.startedAt).toBeTruthy();
    expect(reopened.closed_reason).toBe("student_ended");
    const card = (await db.query("select kind, payload from conversation_messages where conversation_id = $1 and kind = 'logistics_update'", [id])).rows[0];
    expect(card.payload).toMatchObject({ text: "Your parcel is in customs now.", trackingNo: expect.any(String) });
    const list = (await app.inject({ method: "GET", url: "/v1/conversations", headers: auth(student) })).json() as Array<Record<string, unknown>>;
    expect(list.find((item) => item.id === id)).toMatchObject({ toolFollowUp: { kind: "logistics_update" } });

    // 跟进期间同一订单不能再发同一种卡片
    const again = await app.inject({ method: "POST", url: `/v1/orders/${order.id}/tool-cards`, headers: auth(student), payload: { kind: "logistics_update", text: "Again" } });
    expect(again.json().code).toBe("TOOL_FOLLOWUP_OPEN");

    nextReply = "ok";
    for (const text of ["About 3 days.", "It is already in Germany.", "Anything else?"]) {
      const reply = await app.inject({ method: "POST", url: `/v1/conversations/${id}/messages`, headers: auth(student), payload: { content: text } });
      expect(reply.body).toContain('"type":"done"');
    }
    const lastBuyerPrompt = requests.filter((body) => !body.response_format).at(-1)!.messages[0]!.content;
    expect(lastBuyerPrompt).toContain("FOLLOW-UP");
    expect(lastBuyerPrompt).toContain("Wrap up in THIS reply");
    const after = await conversationRow(id);
    expect(after).toMatchObject({ status: "closed", closed_reason: "student_ended", service_rating: before.service_rating });
    expect(after.tool_followup.endReason).toBe("turn_limit");
  });

  it("D-58：邮件类场景只在任务里按邮件下发；发出后结束、评六项、计入任务进度；模板 8 个", async () => {
    const templates = (await app.inject({ method: "GET", url: "/v1/catalog/mail-templates", headers: auth(student) })).json();
    expect(templates).toHaveLength(8);
    const practice = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "PRE-006" } });
    expect(practice.json().code).toBe("MAIL_SCENARIO_NEEDS_TASK");

    const adminId = (await db.query("select id from users where username = 'admin'")).rows[0].id;
    const task = await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by)
       values ('新品推广邮件', 'pre_sale', '["PRE-006"]', 'text', '{}', 'published', $1) returning id`,
      [adminId],
    );
    const taskId = task.rows[0].id as string;
    await db.query("insert into task_progress (task_id, student_id) values ($1, $2)", [taskId, studentId]);
    const tasks = (await app.inject({ method: "GET", url: "/v1/student/tasks", headers: auth(student) })).json() as Array<{ id: string; scenarios: Array<{ channel: string }> }>;
    expect(tasks.find((item) => item.id === taskId)!.scenarios[0]!.channel).toBe("mail");

    const opened = (await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { taskId, scenarioId: "PRE-006" } })).json();
    expect(opened).toMatchObject({ channel: "mail", mail: { templateId: "MAIL-001" } });
    expect(opened.mail.to).toContain("@");
    const reopened = (await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { taskId, scenarioId: "PRE-006" } })).json();
    expect(reopened.id).toBe(opened.id);
    const chats = (await app.inject({ method: "GET", url: "/v1/conversations", headers: auth(student) })).json() as Array<{ id: string }>;
    expect(chats.some((item) => item.id === opened.id)).toBe(false);

    const sent = await app.inject({
      method: "POST",
      url: "/v1/mail/submissions",
      headers: auth(student),
      payload: { templateId: "MAIL-001", subject: "Just landed", body: "Hi, our new lamp is here.", recipient: opened.mail.to, conversationId: opened.id },
    });
    expect(sent.statusCode).toBe(200);
    expect(await conversationRow(opened.id)).toMatchObject({ status: "closed", closed_reason: "mail_sent", channel: "mail" });
    await waitFor(async () => (await db.query("select 1 from assessments where conversation_id = $1", [opened.id])).rowCount === 1);
    const assessment = (await db.query("select scores, prompt_version from assessments where conversation_id = $1", [opened.id])).rows[0];
    expect(Object.keys(assessment.scores).sort()).toEqual(["compliance", "effectiveness", "grammar", "knowledge", "professionalism", "resolution"]);
    expect(assessment.prompt_version).toContain("#mail");
    expect((await db.query("select status from task_progress where task_id = $1 and student_id = $2", [taskId, studentId])).rows[0].status).toBe("done");
    const records = (await app.inject({ method: "GET", url: "/v1/student/assessments", headers: auth(student) })).json();
    expect(records.records.find((item: { conversationId: string }) => item.conversationId === opened.id)).toMatchObject({ channel: "mail", reception: null });
    const resend = await app.inject({
      method: "POST",
      url: "/v1/mail/submissions",
      headers: auth(student),
      payload: { templateId: "MAIL-001", subject: "Again", body: "Again", conversationId: opened.id },
    });
    expect(resend.json().code).toBe("MAIL_TASK_CLOSED");
  });
});

describe("参数核对 · 教师端（D-59 数据总览、D-60 考核报表、D-63 学生详情、D-64 实训跟踪）", () => {
  it("参训人数、任务完成率只算在用的学生；对话总数 = 学生回过话的聊天接待（含练习、不含邮件）；平均分和报表同口径", async () => {
    const { hashPassword } = await import("./security");
    const klass = (await db.query("insert into classes (name) values ('D59测试班') returning id")).rows[0].id as string;
    const addUser = async (username: string, role: string, status = "active") =>
      (await db.query(
        `insert into users (username, display_name, role, password_hash, class_id, status) values ($1, $1, $2, $3, $4, $5) returning id`,
        [username, role, await hashPassword("Teach#D59x"), role === "student" ? klass : null, status],
      )).rows[0].id as string;
    const teacherId = await addUser("t-d59", "teacher");
    await db.query("insert into teacher_classes (teacher_id, class_id) values ($1, $2)", [teacherId, klass]);
    const [a, b, gone] = [await addUser("s-d59-a", "student"), await addUser("s-d59-b", "student"), await addUser("s-d59-c", "student", "disabled")];
    const task = (await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by)
       values ('D-59 总览', 'after_sale', '["AFTER-001"]', 'text', '{}', 'published', $1) returning id`,
      [teacherId],
    )).rows[0].id as string;
    await db.query("insert into task_progress (task_id, student_id, status) values ($1, $2, 'done'), ($1, $3, 'todo'), ($1, $4, 'done')", [task, a, b, gone]);
    const conversation = async (studentId: string, taskId: string | null, channel: string, senders: string[]) => {
      const id = (await db.query(
        "insert into conversations (task_id, student_id, scenario_id, channel, status) values ($1, $2, 'AFTER-001', $3, 'closed') returning id",
        [taskId, studentId, channel],
      )).rows[0].id as string;
      for (const sender of senders) await db.query("insert into conversation_messages (conversation_id, sender, content) values ($1, $2, 'x')", [id, sender]);
      return id;
    };
    const scored = await conversation(a, task, "chat", ["buyer", "student"]);
    await conversation(a, null, "chat", ["buyer", "student"]); // 自由练习：算对话
    await conversation(a, task, "chat", ["buyer"]); // 学生一句没回：不算
    await conversation(b, task, "mail", ["student"]); // 邮件：参训算、对话不算
    await conversation(gone, task, "chat", ["buyer", "student"]); // 停用的学生：对话照算（历史不消失），参训人数不算
    await db.query(
      "insert into assessments (conversation_id, student_id, scores, total, comment) values ($1, $2, $3, 70, '-')",
      [scored, a, JSON.stringify({ professionalism: 70, effectiveness: 70, empathy: 70, resolution: 70, grammar: 70, compliance: 70 })],
    );

    const teacher = await login("t-d59", "Teach#D59x");
    const body = (await app.inject({ method: "GET", url: "/v1/teacher/overview", headers: auth(teacher) })).json();
    expect(body).toMatchObject({
      activeStudents: 2,
      totalStudents: 2,
      weekActive: 2,
      totalConversations: 3,
      completion: { done: 1, required: 2, rate: 50 },
      averageScore: 70,
      scoredStudents: 1,
      distribution: [0, 0, 1, 0, 0],
    });
    expect(body.weekDaily[body.todayIndex]).toBe(3);
    expect(body).not.toHaveProperty("weakDimensions");

    // D-60：排名表的满意率只算任务里的聊天接待（5 星 + 3 星 → 50%），自由练习的星级不算
    await db.query("update conversations set service_rating = 5 where id = $1", [scored]);
    const other = await conversation(a, task, "chat", ["buyer", "student"]);
    await db.query("update conversations set service_rating = 3 where id = $1", [other]);
    const practice = await conversation(a, null, "chat", ["buyer", "student"]);
    await db.query("update conversations set service_rating = 5 where id = $1", [practice]);
    const report = (await app.inject({ method: "GET", url: `/v1/teacher/reports?classId=${klass}`, headers: auth(teacher) })).json();
    expect(report.ranking).toHaveLength(1);
    expect(report.ranking[0]).toMatchObject({ username: "s-d59-a", average: 70, satisfaction: { rated: 2, rate: 50 } });

    // D-63：学生详情里的参训任务；别的老师看不了
    const detail = (await app.inject({ method: "GET", url: `/v1/students/${a}/tasks`, headers: auth(teacher) })).json();
    expect(detail).toEqual([expect.objectContaining({ id: task, name: "D-59 总览", progress: "done", score: 70, conversations: 3 })]);
    const outsiderId = await addUser("t-d63-other", "teacher");
    expect(outsiderId).toBeTruthy();
    const outsider = await login("t-d63-other", "Teach#D59x");
    expect((await app.inject({ method: "GET", url: `/v1/students/${a}/tasks`, headers: auth(outsider) })).statusCode).toBe(403);

    // 名单平均分和考核报表同一口径：第二个任务两次 46、47 → 任务成绩 47，综合 (70 + 47) / 2 = 58.5 → 59（不先取整会算成 58）
    const second = (await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by)
       values ('D-63 口径', 'after_sale', '["AFTER-001"]', 'text', '{}', 'published', $1) returning id`,
      [teacherId],
    )).rows[0].id as string;
    await db.query("insert into task_progress (task_id, student_id, status) values ($1, $2, 'done')", [second, a]);
    for (const total of [46, 47]) {
      const id = await conversation(a, second, "chat", ["buyer", "student"]);
      await db.query("insert into assessments (conversation_id, student_id, scores, total, comment) values ($1, $2, '{}', $3, '-')", [id, a, total]);
    }
    const rosterRow = ((await app.inject({ method: "GET", url: `/v1/classes/${klass}/students`, headers: auth(teacher) })).json() as Array<{ username: string; averageScore: number }>)
      .find((row) => row.username === "s-d59-a")!;
    const reportRow = (await app.inject({ method: "GET", url: `/v1/teacher/reports?classId=${klass}`, headers: auth(teacher) })).json().ranking[0];
    expect(reportRow.average).toBe(59);
    expect(rosterRow.averageScore).toBe(reportRow.average);

    // D-64：买家满意度低于 40 也算需介入；带任务限时；回放带买家头像
    await db.query("update tasks set time_limit_minutes = 30 where id = $1", [task]);
    const live = (await db.query(
      `insert into conversations (task_id, student_id, scenario_id, channel, status, state)
       values ($1, $2, 'AFTER-001', 'chat', 'active', '{"satisfaction": 32}') returning id`,
      [task, a],
    )).rows[0].id as string;
    await db.query("insert into conversation_messages (conversation_id, sender, content) values ($1, 'buyer', 'Broken again'), ($1, 'student', 'Sorry to hear that')", [live]);
    const tracking = (await app.inject({ method: "GET", url: "/v1/teacher/tracking", headers: auth(teacher) })).json() as Array<Record<string, unknown>>;
    expect(tracking.find((item) => item.conversationId === live)).toMatchObject({ alert: true, alertReasons: ["unhappy"], satisfaction: 32, timeLimitMinutes: 30 });
    // 头像按会话 id 抽，可能是照片也可能是首字母，所以只看买家信息带上了
    const reviews = (await app.inject({ method: "GET", url: "/v1/teacher/assessments", headers: auth(teacher) })).json() as Array<{ buyer?: { avatarKind?: string } }>;
    expect(reviews[0]!.buyer?.avatarKind).toBeTruthy();
  });
});

describe("买家什么时候离开：两本账（D-90）", () => {
  let upstream: Server;
  let student: Session;
  const requests: Array<{ messages: Array<{ role: string; content: string }>; response_format?: unknown }> = [];
  /** 假上游按顺序回买家台词；观察员一律回这个满意度 */
  const replies: string[] = [];
  let observerSatisfaction = 90;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        // 结构化输出（观察员、评分）共用一份 JSON，各取各的字段
        const text = body.response_format
          ? JSON.stringify({ turnScore: 70, satisfaction: observerSatisfaction, emotion: "平静", stage: "方案协商", scores: { professionalism: 60 }, comment: "买家因客服两次夸大宣传失望离开。" })
          : replies.shift() ?? "ok";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: text } }] })}\n\n` +
            `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n",
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const { createSecretSealer } = await import("./llm/secret");
    await db.query("update llm_profiles set is_default = false");
    await db.query(
      `insert into llm_profiles (name, base_url, api_key_enc, model, json_mode, is_default, test_status)
       values ('两本账测试', $1, $2, 'fake-model', true, true, 'ok')`,
      [`${base}/v1`, createSecretSealer("test-secret").seal("sk-ledger")],
    );
    await db.query("delete from app_settings where key = 'llm_routing'");
    const admin = await login("admin", "Admin#Prod9");
    expect((await app.inject({ method: "PUT", url: "/v1/admin/llm/routing", headers: auth(admin), payload: { directorEveryNTurns: 1 } })).statusCode).toBe(200);
    const { hashPassword } = await import("./security");
    await db.query(
      `insert into users (username, display_name, role, password_hash, must_change_password)
       values ('s-ledger', '两本账学生', 'student', $1, false) on conflict (username) do nothing`,
      [await hashPassword("Student#Ledger1")],
    );
    student = await login("s-ledger", "Student#Ledger1");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  /** 开一个售前会话，账换成固定的（免得画像随机影响能忍几次） */
  async function open(ledger: Record<string, unknown>) {
    const created = await app.inject({ method: "POST", url: "/v1/conversations", headers: auth(student), payload: { scenarioId: "PRE-001" } });
    const id = created.json().id as string;
    await db.query("update conversations set buyer_ledger = $2 where id = $1", [id, JSON.stringify({ version: 1, extrasLeft: 0, judgements: [], mustLeave: null, exit: null, ...ledger })]);
    return id;
  }
  const say = (id: string, content: string) => app.inject({ method: "POST", url: `/v1/conversations/${id}/messages`, headers: auth(student), payload: { content } });
  const row = async (id: string) => (await db.query("select status, closed_reason, service_rating, buyer_ledger from conversations where id = $1", [id])).rows[0];
  const buyerLines = async (id: string) =>
    (await db.query("select content from conversation_messages where conversation_id = $1 and sender = 'buyer' order by created_at, id", [id])).rows.map((item) => item.content as string);

  it("答差两次就走：判断不外发、不落库；该走没走下一条一定收尾；失望离开最多 2 星；评分依据和复盘标注", async () => {
    observerSatisfaction = 90;
    const id = await open({
      items: [{ no: 1, kind: "main", text: "确认手表适不适合自己", status: "open", misses: 0 }],
      patience: { start: 2, left: 2 },
      silentLeave: false,
    });
    // 挂到一个任务上，结束后才会评分
    const adminId = (await db.query("select id from users where username = 'admin'")).rows[0].id;
    const taskId = (await db.query(
      `insert into tasks (name, business_stage, scenario_ids, interaction_mode, scoring_weights, status, created_by)
       values ('D-90 评分依据', 'pre_sale', '["PRE-001"]', 'text', '{}', 'published', $1) returning id`,
      [adminId],
    )).rows[0].id;
    await db.query("update conversations set task_id = $2 where id = $1", [id, taskId]);
    replies.push("<<reply=none ask=1>>Hi! Is the heart-rate reading accurate?");
    const opening = await app.inject({ method: "POST", url: `/v1/conversations/${id}/opening`, headers: auth(student) });
    expect(opening.body).toContain("heart-rate");
    expect(opening.body).not.toContain("<<");

    // 判断存在这一轮的第一条消息上（标准写法），接口不返回
    expect((await db.query("select buyer_note from conversation_messages where conversation_id = $1 and sender = 'buyer'", [id])).rows[0].buyer_note).toBe("reply=none ask=1 leave=no");
    const listed = (await app.inject({ method: "GET", url: `/v1/conversations/${id}/messages`, headers: auth(student) })).body;
    expect(listed).not.toContain("reply=");

    replies.push("<<reply=bad/exaggerate ask=1>>Is it certified or not? I want a straight answer.");
    await say(id, "It reaches medical-grade accuracy!");
    // 下一轮给买家看的聊天记录里，开场那条带着判断
    const secondTurn = requests.filter((body) => !body.response_format).at(-1)!.messages;
    expect(secondTurn.find((item) => item.role === "assistant")!.content).toBe("<<reply=none ask=1 leave=no>>Hi! Is the heart-rate reading accurate?");
    let ledger = (await row(id)).buyer_ledger;
    expect(ledger.patience.left).toBe(1);
    const lastStudent = (await db.query("select id from conversation_messages where conversation_id = $1 and sender = 'student' order by created_at desc limit 1", [id])).rows[0].id;
    expect(ledger.judgements[0]).toMatchObject({ turn: 1, verdict: "bad", fault: "exaggerate", patienceLeft: 1, messageId: lastStudent });

    // 第二次夸大：耐心用完，可这条没写告别 → 记下“该走了”，会话还开着
    replies.push("<<reply=bad/exaggerate>>That's exactly the kind of claim that puts me off.");
    await say(id, "Not a medical device, but medical-grade accuracy.");
    ledger = (await row(id)).buyer_ledger;
    expect(ledger).toMatchObject({ patience: { left: 0 }, mustLeave: "disappointed" });
    expect((await row(id)).status).toBe("active");

    // 下一条提示词里写明该走了；这条不管说了什么都算告别
    replies.push("<<reply=ok>>Never mind.");
    const closing = await say(id, "Sorry, let me check.");
    expect(closing.body).toContain('"closed":true');
    const buyerPrompt = requests.filter((body) => !body.response_format).at(-1)!.messages[0]!.content;
    expect(buyerPrompt).toContain("You have made up your mind to leave");
    const closed = await row(id);
    expect(closed).toMatchObject({ status: "closed", closed_reason: "buyer_left" });
    expect(closed.buyer_ledger.exit).toMatchObject({ outcome: "disappointed", fault: "exaggerate" });
    // 观察员给了 90 分（本来 5 星），失望离开最多 2 星
    expect(closed.service_rating).toBe(2);
    expect(await buyerLines(id)).toEqual([
      "Hi! Is the heart-rate reading accurate?",
      "Is it certified or not? I want a straight answer.",
      "That's exactly the kind of claim that puts me off.",
      "Never mind.",
    ]);

    // 复盘标注：两次夸大宣传的那两条，后一条“随后离开”；答一般的那条不标
    const studentIds = (await db.query("select id from conversation_messages where conversation_id = $1 and sender = 'student' order by created_at, id", [id])).rows.map((item) => item.id as string);
    const { loadReceptionStats } = await import("./reception-stats");
    expect((await loadReceptionStats(db, [id])).get(id)!.complaints).toEqual([
      { messageId: studentIds[0], severe: false, faults: ["exaggerate"], last: false },
      { messageId: studentIds[1], severe: false, faults: ["exaggerate"], last: true },
    ]);
    // 评分依据：买家怎么走的、哪几句让他不满，评语第一句据此写（结束方式不在复盘里另开一行）
    for (let i = 0; i < 60 && !(await db.query("select 1 from assessments where conversation_id = $1", [id])).rowCount; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const assessed = requests.find((body) => body.response_format && body.messages.some((item) => item.content.includes("买家怎么走的：买家失望离开")));
    expect(assessed!.messages[1]!.content).toContain(
      "客观依据——买家怎么走的：买家失望离开（耐心用完）。让买家不满的客服回复共 2 条：「It reaches medical-grade accuracy!」（夸大宣传）；「Not a medical device, but medical-grade accuracy.」（夸大宣传，买家随后离开）",
    );
    const evidence = (await db.query("select evidence from assessments where conversation_id = $1", [id])).rows[0].evidence;
    expect(evidence.buyerExit.summary).toBe("买家失望离开（耐心用完）");
  });

  it("事情都办成的买家默默离开：不落消息、再发也不回；2 分钟后巡检按买家离开结束，至少 4 星", async () => {
    observerSatisfaction = 30;
    const id = await open({
      items: [{ no: 1, kind: "main", text: "有没有 M 码", status: "open", misses: 0 }],
      patience: { start: 2, left: 2 },
      silentLeave: true,
    });
    replies.push("<<reply=none ask=1>>Do you have it in M?");
    await app.inject({ method: "POST", url: `/v1/conversations/${id}/opening`, headers: auth(student) });
    replies.push("<<reply=good done=1 leave=silent>>Thanks!");
    const silent = await say(id, "Yes, M is in stock and ships today.");
    expect(silent.body).toContain('"type":"done"');
    expect(silent.body).not.toContain("Thanks");
    expect(await buyerLines(id)).toEqual(["Do you have it in M?"]);
    expect((await row(id)).buyer_ledger.exit).toMatchObject({ outcome: "settled", silent: true });
    expect((await row(id)).status).toBe("active");
    // 默默走了以后学生再发，买家不再回（也不再调模型）
    const before = requests.filter((body) => !body.response_format).length;
    const again = await say(id, "Anything else I can help with?");
    expect(again.body).toContain('"type":"done"');
    expect(requests.filter((body) => !body.response_format).length).toBe(before);

    const { sweepConversations } = await import("./lifecycle");
    const gateway = { isConfigured: () => false } as unknown as import("./llm/gateway").LlmGateway;
    await sweepConversations(db, gateway);
    expect((await row(id)).status).toBe("active");
    await db.query(
      "update conversations set buyer_ledger = jsonb_set(buyer_ledger, '{exit,at}', to_jsonb((now() - interval '3 minutes')::text)) where id = $1",
      [id],
    );
    await sweepConversations(db, gateway);
    const closed = await row(id);
    expect(closed).toMatchObject({ status: "closed", closed_reason: "buyer_left" });
    // 观察员只给了 30 分（本来 2 星），事情都办成至少 4 星
    expect(closed.service_rating).toBe(4);
  });

  it("被晾到催了一次耐心减 1；等不到回复离开算失望离开", async () => {
    const { sweepBuyerPatience } = await import("./nudge");
    const log = { error: () => undefined, info: () => undefined, warn: () => undefined };
    const gateway = {
      isConfigured: (purpose: string) => purpose === "dialogue",
      complete: async () => ({ text: "Hello? Anyone there?", info: {} }),
    } as unknown as import("./llm/gateway").LlmGateway;
    const studentId = (await db.query("select id from users where username = 's-ledger'")).rows[0].id;
    const ledger = {
      version: 1,
      items: [{ no: 1, kind: "main", text: "退款", status: "open", misses: 0 }],
      extrasLeft: 0,
      patience: { start: 3, left: 3 },
      silentLeave: false,
      judgements: [],
    };
    const make = async (minutesAgo: number) => {
      const id = (await db.query(
        `insert into conversations (student_id, scenario_id, status, persona, buyer_ledger) values ($1, 'AFTER-001', 'active', $2, $3) returning id`,
        [studentId, JSON.stringify({ personality: "理性谨慎", emotion: "平静", language: "en-US" }), JSON.stringify(ledger)],
      )).rows[0].id as string;
      await db.query(
        "insert into conversation_messages (conversation_id, sender, content, created_at) values ($1, 'buyer', 'Where is my refund?', now() - ($2::float * interval '1 minute'))",
        [id, minutesAgo],
      );
      return id;
    };
    const waiting = await make(3);
    await sweepBuyerPatience(db, gateway, log);
    expect((await row(waiting)).buyer_ledger.patience.left).toBe(2);
    expect((await row(waiting)).buyer_ledger.judgements[0]).toMatchObject({ verdict: "bad", fault: "slow" });

    const leaving = await make(13);
    const firstId = (await db.query("select id from conversation_messages where conversation_id = $1", [leaving])).rows[0].id;
    await db.query("update conversations set state = $2 where id = $1", [leaving, JSON.stringify({ satisfaction: 90, nudge: { baseAt: new Date(Date.now() - 13 * 60_000).toISOString(), count: 2, lastMessageId: firstId } })]);
    await sweepBuyerPatience(db, gateway, log);
    const left = await row(leaving);
    expect(left).toMatchObject({ status: "closed", closed_reason: "buyer_left" });
    expect(left.buyer_ledger.exit).toMatchObject({ outcome: "disappointed", fault: "slow" });
    expect(left.service_rating).toBe(2);
  });
});
