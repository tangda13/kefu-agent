import type { FastifyInstance } from "fastify";
import {
  CUSTOMER_TYPES,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  SUPPORTED_LANGUAGES,
} from "@cecs/contracts";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import type { ConversationProvider } from "../conversation-provider";
import { generateBuyerMailReply } from "../mail-reply";

interface PersonaBody {
  id?: string;
  name?: string;
  nationality?: string;
  identity?: string;
  personality?: string;
  emotion?: string;
  language?: string;
  preference?: string;
  customerType?: string;
  enabled?: boolean;
}

function validatePersona(body: PersonaBody): string | null {
  if (!body.name?.trim()) return "缺少买家姓名";
  if (!body.identity?.trim()) return "缺少买家身份";
  if (!body.preference?.trim()) return "缺少消费偏好";
  if (!NATIONALITIES.includes(body.nationality as never)) return "国籍不在支持范围";
  if (!PERSONALITIES.includes(body.personality as never)) return "性格不在支持范围";
  if (!EMOTIONS.includes(body.emotion as never)) return "情绪不在支持范围";
  if (!SUPPORTED_LANGUAGES.includes(body.language as never)) return "语言不在支持范围";
  if (!CUSTOMER_TYPES.includes(body.customerType as never)) return "客户类型不在支持范围";
  return null;
}

function personaRowToJson(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    nationality: row.nationality,
    identity: row.identity,
    personality: row.personality,
    emotion: row.emotion,
    language: row.language,
    preference: row.preference,
    customerType: row.customer_type,
    enabled: row.enabled,
  };
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  provider: ConversationProvider,
): void {
  app.get(
    "/v1/catalog/scenarios",
    { preHandler: guard.requireRole() },
    async () => {
      const result = await db.query(
        "select id, name, stage, objective, default_language, enabled from scenarios order by id",
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        stage: row.stage,
        objective: row.objective,
        defaultLanguage: row.default_language,
        enabled: row.enabled,
      }));
    },
  );

  app.patch<{ Params: { scenarioId: string }; Body: { enabled?: boolean } }>(
    "/v1/catalog/scenarios/:scenarioId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { scenarioId } = request.params;
      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "缺少启用状态。" };
      }
      const result = await db.query(
        "update scenarios set enabled = $1 where id = $2 returning id",
        [enabled, scenarioId],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "场景不存在。" };
      }
      await writeAudit(db, request.user!.sub, "scenario.toggle", scenarioId, { enabled });
      return { ok: true };
    },
  );

  // 标准话术库（学生端“常用话术”引用；阶段4改为管理端 DB 维护）
  app.get(
    "/v1/catalog/phrases",
    { preHandler: guard.requireRole() },
    async () => {
      const result = await db.query(
        "select text from content_terms where kind = 'phrase' and enabled order by id",
      );
      return result.rows.map((row) => row.text);
    },
  );

  // 个人快捷短语：工作台自建，仅本人可见
  app.get(
    "/v1/catalog/my-phrases",
    { preHandler: guard.requireRole() },
    async (request) => {
      const result = await db.query(
        "select id, text from student_phrases where student_id = $1 order by created_at desc",
        [request.user!.sub],
      );
      return result.rows.map((row) => ({ id: row.id, text: row.text }));
    },
  );

  app.post<{ Body: { text?: string } }>(
    "/v1/catalog/my-phrases",
    { preHandler: guard.requireRole() },
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "短语内容不能为空。" };
      }
      if (text.length > 200) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "短语内容不能超过 200 字。" };
      }
      const dup = await db.query(
        "select id from student_phrases where student_id = $1 and text = $2",
        [request.user!.sub, text],
      );
      if (dup.rowCount) {
        reply.code(409);
        return { code: "DUPLICATE", message: "该短语已存在。" };
      }
      const result = await db.query(
        "insert into student_phrases (student_id, text) values ($1, $2) returning id, text",
        [request.user!.sub, text],
      );
      return { id: result.rows[0].id, text: result.rows[0].text };
    },
  );

  app.delete<{ Params: { phraseId: string } }>(
    "/v1/catalog/my-phrases/:phraseId",
    { preHandler: guard.requireRole() },
    async (request, reply) => {
      const result = await db.query(
        "delete from student_phrases where id = $1 and student_id = $2 returning id",
        [request.params.phraseId, request.user!.sub],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "短语不存在。" };
      }
      return { ok: true };
    },
  );

  // 店铺商品（DB 维护，教师端场景配置可增删改启停 CFG-05）
  app.get<{ Querystring: { all?: string } }>(
    "/v1/store/products",
    { preHandler: guard.requireRole() },
    async (request) => {
      const showAll = request.query.all === "1" && request.user!.role !== "student";
      const result = await db.query(
        `select * from store_products ${showAll ? "" : "where enabled"} order by id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        spec: row.spec,
        price: Number(row.price),
        sales: row.sales,
        stock: row.stock,
        tone: row.tone,
        enabled: row.enabled,
        imageUrl: row.image_url ?? null,
      }));
    },
  );

  // 商品主图上传（multipart 单文件）
  app.post<{ Params: { productId: string } }>(
    "/v1/store/products/:productId/image",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const exists = await db.query("select 1 from store_products where id = $1", [request.params.productId]);
      if (!exists.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "商品不存在。" };
      }
      const file = await request.file();
      if (!file || !/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请上传 png/jpg/webp 图片。" };
      }
      const path = await import("node:path");
      const { createWriteStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const ext = file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "jpg";
      const fileName = `${request.params.productId}-${Date.now()}.${ext}`;
      const target = path.resolve(process.cwd(), "uploads", "products", fileName);
      await pipeline(file.file, createWriteStream(target));
      const imageUrl = `/uploads/products/${fileName}`;
      await db.query("update store_products set image_url = $1 where id = $2", [imageUrl, request.params.productId]);
      await writeAudit(db, request.user!.sub, "product.image", request.params.productId);
      return { ok: true, imageUrl };
    },
  );

  app.post<{ Body: { id?: string; name?: string; spec?: string; price?: number; sales?: number; stock?: number; tone?: string } }>(
    "/v1/store/products",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      if (!body.name?.trim() || !body.spec?.trim() || typeof body.price !== "number" || body.price <= 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写商品名称、规格与正数价格。" };
      }
      const id = body.id?.trim() || `SKU-${Date.now().toString(36).toUpperCase()}`;
      try {
        await db.query(
          `insert into store_products (id, name, spec, price, sales, stock, tone)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, body.name.trim(), body.spec.trim(), body.price, body.sales ?? 0, body.stock ?? 0, body.tone ?? "#2f6f8f"],
        );
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "23505") {
          reply.code(409);
          return { code: "PRODUCT_EXISTS", message: "商品编号已存在。" };
        }
        throw error;
      }
      await writeAudit(db, request.user!.sub, "product.create", id);
      return { ok: true, id };
    },
  );

  app.patch<{ Params: { productId: string }; Body: Record<string, unknown> }>(
    "/v1/store/products/:productId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      const result = await db.query(
        `update store_products set
           name = coalesce($1, name), spec = coalesce($2, spec), price = coalesce($3, price),
           sales = coalesce($4, sales), stock = coalesce($5, stock), enabled = coalesce($6, enabled)
         where id = $7 returning id`,
        [body.name ?? null, body.spec ?? null, body.price ?? null, body.sales ?? null, body.stock ?? null, body.enabled ?? null, request.params.productId],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "商品不存在。" };
      }
      await writeAudit(db, request.user!.sub, "product.update", request.params.productId);
      return { ok: true };
    },
  );

  app.delete<{ Params: { productId: string } }>(
    "/v1/store/products/:productId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const result = await db.query("delete from store_products where id = $1 returning id", [request.params.productId]);
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "商品不存在。" };
      }
      await writeAudit(db, request.user!.sub, "product.delete", request.params.productId);
      return { ok: true };
    },
  );
  // 邮件模板与违规词库（前端实时检测用）
  app.get(
    "/v1/catalog/mail-templates",
    { preHandler: guard.requireRole() },
    async () => {
      const { emailTemplates } = await import("@cecs/domain");
      return emailTemplates;
    },
  );
  app.get(
    "/v1/catalog/forbidden-terms",
    { preHandler: guard.requireRole() },
    async () => {
      const result = await db.query(
        "select text from content_terms where kind = 'forbidden' and enabled order by id",
      );
      return result.rows.map((row) => row.text);
    },
  );

  // 邮件实训提交（服务端复核违规词后落库；词库与前端同源读 DB，DB 为空回退内置词库；
  // 关联到买家订单时，异步生成买家 AI 回信）
  app.post<{ Body: { templateId?: string; subject?: string; body?: string; recipient?: string; orderId?: string } }>(
    "/v1/mail/submissions",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const { templateId, subject, body, recipient, orderId } = request.body ?? {};
      if (!templateId?.trim() || !subject?.trim() || !body?.trim()) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写模板、主题与正文。" };
      }
      if (recipient !== undefined && (typeof recipient !== "string" || recipient.length > 200)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "收件人格式无效。" };
      }
      const termRows = await db.query(
        "select text from content_terms where kind = 'forbidden' and enabled order by id",
      );
      let terms: string[] = termRows.rows.map((row) => row.text);
      if (terms.length === 0) {
        const { forbiddenTerms } = await import("@cecs/domain");
        terms = [...forbiddenTerms];
      }
      const haystack = `${subject}\n${body}`.toLowerCase();
      const violations = terms.filter((term) => haystack.includes(term.toLowerCase()));
      const saved = await db.query(
        `insert into mail_submissions (student_id, template_id, subject, body, violations, recipient)
         values ($1, $2, $3, $4, $5, $6) returning id, created_at`,
        [request.user!.sub, templateId, subject.trim(), body.trim(), JSON.stringify(violations), recipient?.trim() || null],
      );
      void generateBuyerMailReply(
        db,
        provider,
        {
          submissionId: saved.rows[0].id,
          orderId: typeof orderId === "string" && orderId.trim() ? orderId.trim() : null,
          studentId: request.user!.sub,
          subject: subject.trim(),
          body: body.trim(),
          templateId: templateId.trim(),
        },
        request.log,
      ).catch((error) => request.log.error(error, "buyer mail reply failed"));
      return {
        id: saved.rows[0].id,
        violations,
        compliant: violations.length === 0,
        createdAt: saved.rows[0].created_at,
      };
    },
  );

  // AI 辅助写信：实时生成 3 版邮件草稿（回信按来信与买家资料，主动信按模板个性化）
  app.post<{
    Body: { mode?: string; orderId?: string; templateId?: string; originalSubject?: string; originalBody?: string };
  }>(
    "/v1/mail/assist",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const { mode, orderId, templateId, originalSubject, originalBody } = request.body ?? {};
      if (mode !== "reply" && mode !== "compose") {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "辅助模式无效。" };
      }
      if (provider.providerId === "unconfigured") {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 服务。" };
      }
      let persona: Record<string, unknown> | null = null;
      let order: Record<string, unknown> | null = null;
      if (typeof orderId === "string" && orderId.trim()) {
        const result = await db.query(
          `select o.payload, c.persona from orders o
           join conversations c on c.id = o.conversation_id
           where o.id = $1 and o.student_id = $2`,
          [orderId.trim(), request.user!.sub],
        );
        if (result.rows[0]) {
          persona = result.rows[0].persona as Record<string, unknown>;
          order = result.rows[0].payload as Record<string, unknown>;
        }
      }
      const buyerBrief = persona
        ? JSON.stringify({ name: persona.name, nationality: persona.nationality, customerType: persona.customerType, language: persona.language })
        : "unknown buyer";
      const orderBrief = order
        ? JSON.stringify({ orderNo: order.orderNo, product: order.productName, status: order.statusLabel, total: order.totalAmount })
        : "no linked order";
      let system: string;
      let user: string;
      if (mode === "reply") {
        system =
          "You are a cross-border e-commerce customer service coach. Draft exactly 3 alternative reply EMAILS the agent can send to the buyer, " +
          "with distinct strategies: (1) solution-focused, (2) empathy-first, (3) brief and efficient. " +
          `Write in the buyer's language (${persona?.language ?? "en-US"}). Each 2-5 sentences plus a short sign-off, professional, ` +
          "no absolute marketing claims (e.g. 'best', '100% guaranteed'). " +
          'Return ONLY a JSON array of 3 objects: [{"body":"..."},{"body":"..."},{"body":"..."}].';
        user = `Buyer profile: ${buyerBrief}\nOrder: ${orderBrief}\nBuyer's email:\nSubject: ${originalSubject ?? ""}\n\n${originalBody ?? ""}`;
      } else {
        const { emailTemplates } = await import("@cecs/domain");
        const template = emailTemplates.find((item) => item.id === templateId);
        system =
          "You are a cross-border e-commerce customer service coach. Draft exactly 3 alternative outreach EMAILS (subject + body) " +
          `for the purpose: ${template ? `${template.name} - ${template.purpose}` : "customer outreach"}. ` +
          `Personalize for the recipient. Write in the buyer's language (${persona?.language ?? "en-US"}). ` +
          "Each body 3-6 sentences with greeting and sign-off, professional, no absolute marketing claims. " +
          'Return ONLY a JSON array of 3 objects: [{"subject":"...","body":"..."}, ...].';
        user = `Buyer profile: ${buyerBrief}\nOrder history: ${orderBrief}\nReference template:\n${template ? template.body : "(none)"}`;
      }
      try {
        const raw = await provider.complete(system, user);
        let versions: Array<{ subject: string | null; body: string }> = [];
        try {
          const match = raw.match(/\[[\s\S]*\]/);
          const parsed = match ? (JSON.parse(match[0]) as Array<{ subject?: string; body?: string }>) : [];
          versions = parsed
            .filter((item) => typeof item?.body === "string" && item.body.trim().length > 0)
            .map((item) => ({ subject: mode === "compose" ? item.subject?.trim() || null : null, body: item.body!.trim() }));
        } catch {
          versions = [];
        }
        if (versions.length < 3) {
          versions = raw
            .split(/\n{2,}/)
            .map((block) => block.replace(/^\s*[\d\-.、)]+\s*/, "").trim())
            .filter((block) => block.length > 30)
            .slice(0, 3)
            .map((body) => ({ subject: null, body }));
        }
        if (versions.length < 3) {
          reply.code(502);
          return { code: "ASSIST_FAILED", message: "草稿生成不完整，请重试。" };
        }
        return { versions: versions.slice(0, 3) };
      } catch (error) {
        request.log.error(error, "mail assist failed");
        reply.code(502);
        return { code: "ASSIST_FAILED", message: "草稿生成失败，请稍后重试。" };
      }
    },
  );

  // 买家 AI 回信列表（学生本人收件箱增量）
  app.get(
    "/v1/mail/replies",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const result = await db.query(
        `select id, order_id, from_name, from_email, subject, body, created_at
         from mail_replies where student_id = $1
         order by created_at desc limit 100`,
        [request.user!.sub],
      );
      return result.rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        fromName: row.from_name,
        fromEmail: row.from_email,
        subject: row.subject,
        body: row.body,
        createdAt: row.created_at,
      }));
    },
  );

  // 已发送邮件列表（学生本人）
  app.get(
    "/v1/mail/submissions",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const result = await db.query(
        `select id, template_id, recipient, subject, body, violations, created_at
         from mail_submissions where student_id = $1
         order by created_at desc limit 100`,
        [request.user!.sub],
      );
      return result.rows.map((row) => ({
        id: row.id,
        templateId: row.template_id,
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
        violations: row.violations,
        compliant: (row.violations as string[]).length === 0,
        createdAt: row.created_at,
      }));
    },
  );

  app.get(
    "/v1/store/coupons",
    { preHandler: guard.requireRole() },
    async () => {
      const { storeCoupons } = await import("@cecs/domain");
      return storeCoupons;
    },
  );

  app.get(
    "/v1/catalog/personas",
    { preHandler: guard.requireRole("teacher", "admin") },
    async () => {
      const result = await db.query(
        "select * from persona_templates order by id",
      );
      return result.rows.map(personaRowToJson);
    },
  );

  app.post<{ Body: PersonaBody }>(
    "/v1/catalog/personas",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      const problem = validatePersona(body);
      if (problem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: problem };
      }
      const id = body.id?.trim() || `P-${Date.now().toString(36).toUpperCase()}`;
      try {
        const result = await db.query(
          `insert into persona_templates
             (id, name, nationality, identity, personality, emotion, language, preference, customer_type, enabled)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning *`,
          [
            id,
            body.name!.trim(),
            body.nationality,
            body.identity!.trim(),
            body.personality,
            body.emotion,
            body.language,
            body.preference!.trim(),
            body.customerType,
            body.enabled ?? true,
          ],
        );
        await writeAudit(db, request.user!.sub, "persona.create", id);
        return personaRowToJson(result.rows[0]);
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "23505") {
          reply.code(409);
          return { code: "PERSONA_EXISTS", message: "画像编号已存在。" };
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { personaId: string }; Body: PersonaBody }>(
    "/v1/catalog/personas/:personaId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { personaId } = request.params;
      const existing = await db.query(
        "select * from persona_templates where id = $1",
        [personaId],
      );
      const current = existing.rows[0];
      if (!current) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "画像不存在。" };
      }
      const merged: PersonaBody = {
        name: request.body?.name ?? current.name,
        nationality: request.body?.nationality ?? current.nationality,
        identity: request.body?.identity ?? current.identity,
        personality: request.body?.personality ?? current.personality,
        emotion: request.body?.emotion ?? current.emotion,
        language: request.body?.language ?? current.language,
        preference: request.body?.preference ?? current.preference,
        customerType: request.body?.customerType ?? current.customer_type,
        enabled: request.body?.enabled ?? current.enabled,
      };
      const problem = validatePersona(merged);
      if (problem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: problem };
      }
      const result = await db.query(
        `update persona_templates
         set name = $1, nationality = $2, identity = $3, personality = $4, emotion = $5,
             language = $6, preference = $7, customer_type = $8, enabled = $9
         where id = $10
         returning *`,
        [
          merged.name!.trim(),
          merged.nationality,
          merged.identity!.trim(),
          merged.personality,
          merged.emotion,
          merged.language,
          merged.preference!.trim(),
          merged.customerType,
          merged.enabled,
          personaId,
        ],
      );
      await writeAudit(db, request.user!.sub, "persona.update", personaId);
      return personaRowToJson(result.rows[0]);
    },
  );

  app.delete<{ Params: { personaId: string } }>(
    "/v1/catalog/personas/:personaId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { personaId } = request.params;
      const result = await db.query(
        "delete from persona_templates where id = $1 returning id",
        [personaId],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "画像不存在。" };
      }
      await writeAudit(db, request.user!.sub, "persona.delete", personaId);
      return { ok: true };
    },
  );

  app.post<{ Body: { personas?: PersonaBody[] } }>(
    "/v1/catalog/personas/import",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const rows = request.body?.personas ?? [];
      if (!Array.isArray(rows) || rows.length === 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "导入内容为空。" };
      }
      const created: string[] = [];
      const failed: Array<{ index: number; reason: string }> = [];
      for (const [index, body] of rows.entries()) {
        const problem = validatePersona(body);
        if (problem) {
          failed.push({ index, reason: problem });
          continue;
        }
        const id = body.id?.trim() || `P-${Date.now().toString(36).toUpperCase()}-${index}`;
        try {
          await db.query(
            `insert into persona_templates
               (id, name, nationality, identity, personality, emotion, language, preference, customer_type, enabled)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              id,
              body.name!.trim(),
              body.nationality,
              body.identity!.trim(),
              body.personality,
              body.emotion,
              body.language,
              body.preference!.trim(),
              body.customerType,
              body.enabled ?? true,
            ],
          );
          created.push(id);
        } catch (error: unknown) {
          if ((error as { code?: string }).code === "23505") {
            failed.push({ index, reason: "画像编号已存在" });
          } else {
            throw error;
          }
        }
      }
      await writeAudit(db, request.user!.sub, "persona.import", undefined, {
        created: created.length,
        failed: failed.length,
      });
      return { created, failed };
    },
  );
}
