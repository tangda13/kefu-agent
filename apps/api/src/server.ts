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
import { createConversationProvider, SwappableConversationProvider } from "./conversation-provider";
import { getSetting, type LlmSettings } from "./settings";
import { loadEnv, type ApiEnv } from "./env";
import { createPool, migrate, type Db } from "./db";
import { seedAdmin, seedCatalog, seedContentTerms, seedStoreProducts } from "./seed";
import { createAuthGuard } from "./auth-context";
import { registerAuthRoutes } from "./routes/auth";
import { registerClassRoutes } from "./routes/classes";
import { registerCatalogRoutes } from "./routes/catalog";
import { registerTaskRoutes } from "./routes/tasks";
import { registerConversationRoutes } from "./routes/conversations";
import { registerOrderRoutes } from "./routes/orders";
import { registerBaselineRoutes } from "./routes/baseline";
import { registerAnnouncementRoutes } from "./routes/announcements";
import { registerTeacherRoutes } from "./routes/teacher";
import { registerAdminRoutes } from "./routes/admin";

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

  const app = Fastify({ logger: options.logger ?? true });
  const guard = createAuthGuard(env.jwtSecret);
  // LLM 配置：DB 设置优先（管理端可热切换），回退 env
  const savedLlm = await getSetting<LlmSettings>(db, "llm").catch(() => null);
  const conversationProvider = new SwappableConversationProvider(
    createConversationProvider(
      savedLlm
        ? { llmBaseUrl: savedLlm.baseUrl, llmApiKey: savedLlm.apiKey, llmModel: savedLlm.model }
        : env,
    ),
  );

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
  await app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: "/uploads/",
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
  registerCatalogRoutes(app, db, guard, conversationProvider);
  registerTaskRoutes(app, db, guard);
  registerConversationRoutes(app, db, guard, conversationProvider);
  registerOrderRoutes(app, db, guard, conversationProvider);
  registerBaselineRoutes(app, db, guard);
  registerAnnouncementRoutes(app, db, guard);
  registerTeacherRoutes(app, db, guard);
  registerAdminRoutes(app, db, guard, conversationProvider);

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
