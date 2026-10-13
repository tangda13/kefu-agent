import path from "node:path";
import { mkdirSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { ACCEPTANCE_THRESHOLDS } from "@cecs/contracts";
import {
  emailTemplates,
  forbiddenTerms,
  personaTemplates,
  standardPhrases,
  trainingScenarios,
} from "@cecs/domain";
import { getSetting } from "./settings";
import { LlmGateway } from "./llm/gateway";
import { bootstrapProfiles } from "./llm/profiles";
import { createSecretSealer } from "./llm/secret";
import { VoiceService } from "./voice/service";
import { loadEnv, type ApiEnv } from "./env";
import { createPool, migrate, type Db } from "./db";
import { seedAdmin, seedCatalog, seedContentTerms, seedStoreProducts } from "./seed";
import { createAuthGuard } from "./auth-context";
import { registerAuthRoutes } from "./routes/auth";
import { registerClassRoutes } from "./routes/classes";
import { registerCatalogRoutes } from "./routes/catalog";
import { registerProductRoutes } from "./routes/products";
import { registerTaskRoutes } from "./routes/tasks";
import { registerConversationRoutes } from "./routes/conversations";
import { registerOrderRoutes } from "./routes/orders";
import { registerBaselineRoutes } from "./routes/baseline";
import { registerAnnouncementRoutes } from "./routes/announcements";
import { registerTeacherRoutes } from "./routes/teacher";
import { registerAdminRoutes } from "./routes/admin";
import { registerAdminLlmRoutes } from "./routes/admin-llm";
import { registerStudentStateRoutes } from "./routes/student-state";
import { registerBrandRoutes } from "./routes/brand";
import { registerStoreRoutes } from "./routes/store";

export interface BuildServerOptions {
  env?: Partial<ApiEnv>;
  db?: Db;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const env = loadEnv(options.env);
  const db = options.db ?? createPool(env.databaseUrl);
  await migrate(db);
  await seedCatalog(db);
  await seedStoreProducts(db);
  await seedContentTerms(db);
  await seedAdmin(db, env.adminInitialPassword);

  // 开发脚本（dev.cmd / admin.cmd）设置 LOG_PRETTY=1：日志转成一行一条的可读格式；生产保持 JSON 便于采集
  const logger =
    options.logger ??
    (process.env.LOG_PRETTY === "1"
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname", singleLine: true } } }
      : true);
  const app = Fastify({ logger, trustProxy: env.trustProxy });
  const guard = createAuthGuard(env.jwtSecret, db);
  // 模型网关：档案与用途路由存 DB，管理端修改后 reload() 热生效；首次启动把旧配置导入为默认档案
  if (!env.settingsEncryptionKey && process.env.NODE_ENV === "production") {
    app.log.warn("SETTINGS_ENCRYPTION_KEY 未设置，厂商 API Key 用 JWT_SECRET 派生的密钥加密；轮换 JWT_SECRET 后需重新填写 Key");
  }
  const sealer = createSecretSealer(env.settingsEncryptionKey || env.jwtSecret);
  await bootstrapProfiles(db, sealer, env, app.log);
  const gateway = new LlmGateway(db, sealer, app.log);
  await gateway.reload();
  const voice = new VoiceService(db, sealer, env);

  app.decorateRequest("receivedAt", 0);
  app.addHook("onRequest", async (request) => {
    request.receivedAt = Date.now();
  });

  // 允许无请求体的 POST（如重置密码），空 body 按 {} 处理
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      if (body === "" || body === undefined) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  // 显式放行全部使用中的方法：默认配置不含 PATCH/DELETE，浏览器预检会拦截（教师复核、管理端删除、订单操作均依赖）
  await app.register(cors, {
    origin: env.corsOrigins,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  });
  const uploadsRoot = path.resolve(process.cwd(), "uploads");
  mkdirSync(path.join(uploadsRoot, "products"), { recursive: true });
  mkdirSync(path.join(uploadsRoot, "avatars"), { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: "/uploads/",
    decorateReply: false,
  });
  // 内置商品库图片（D-32）：随代码发布，上架时商品直接引用 /library/<编号>.jpg
  const libraryRoot = path.resolve(process.cwd(), "assets", "product-library");
  mkdirSync(libraryRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: libraryRoot,
    prefix: "/library/",
    decorateReply: false,
  });

  app.addHook("onClose", async () => {
    if (!options.db) await db.end();
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "cecs-cloud-api",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  }));

  app.get("/v1/product/capabilities", async () => ({
    acceptance: ACCEPTANCE_THRESHOLDS,
    catalogs: {
      scenarios: trainingScenarios.length,
      personas: personaTemplates.length,
      emailTemplates: emailTemplates.length,
      forbiddenTerms: forbiddenTerms.length,
      standardPhrases: standardPhrases.length,
    },
  }));

  registerAuthRoutes(app, db, env, guard);
  registerClassRoutes(app, db, guard);
  registerCatalogRoutes(app, db, guard, gateway);
  registerProductRoutes(app, db, guard, gateway);
  registerTaskRoutes(app, db, guard, gateway);
  registerConversationRoutes(app, db, guard, gateway, voice);
  registerOrderRoutes(app, db, guard, gateway);
  registerBaselineRoutes(app, db, guard);
  registerAnnouncementRoutes(app, db, guard);
  registerTeacherRoutes(app, db, guard);
  registerAdminRoutes(app, db, guard, gateway, voice);
  registerAdminLlmRoutes(app, db, guard, gateway, sealer);
  registerStudentStateRoutes(app, db, guard);
  registerBrandRoutes(app, db, guard);
  registerStoreRoutes(app, db, guard);

  // D-36 接待自动结束：每分钟扫描一次（超时、2 小时无人发言、任务结束 / 过截止）
  if (process.env.NODE_ENV !== "test") {
    const { sweepConversations } = await import("./lifecycle");
    const sweeper = setInterval(() => {
      sweepConversations(db, gateway).then((count) => { if (count) app.log.info({ closed: count }, "conversations auto-closed"); })
        .catch((error) => app.log.error(error, "conversation sweep failed"));
    }, 60 * 1000);
    app.addHook("onClose", async () => clearInterval(sweeper));
    // D-40 买家耐心：每 30 秒扫描一次，客服久不回复时买家催促 / 离开（模型未配置时不动作）
    const { sweepBuyerPatience } = await import("./nudge");
    const patience = setInterval(() => {
      sweepBuyerPatience(db, gateway, app.log).catch((error) => app.log.error(error, "buyer patience sweep failed"));
    }, 30 * 1000);
    app.addHook("onClose", async () => clearInterval(patience));
  }

  // 定时备份调度：每 10 分钟检查一次（到达设定小时且当日未备份则执行）
  if (process.env.NODE_ENV !== "test") {
    const timer = setInterval(async () => {
      try {
        const schedule = (await getSetting<{ enabled?: boolean; hour?: number; lastDate?: string }>(db, "backupSchedule")) ?? {};
        if (!schedule.enabled) return;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        if (now.getHours() === Number(schedule.hour ?? 2) && schedule.lastDate !== today) {
          const { performBackup } = await import("./routes/admin");
          const result = await performBackup(db);
          const { setSetting } = await import("./settings");
          await setSetting(db, "backupSchedule", { ...schedule, lastDate: today });
          app.log.info({ backup: result }, "scheduled backup done");
        }
      } catch (error) {
        app.log.error(error, "scheduled backup failed");
      }
    }, 10 * 60 * 1000);
    app.addHook("onClose", async () => clearInterval(timer));
  }

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const env = loadEnv();
  buildServer()
    .then((app) => app.listen({ port: env.port, host: "0.0.0.0" }))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
