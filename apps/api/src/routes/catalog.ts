import type { FastifyInstance } from "fastify";
import {
  BUYER_ROLES,
  DECISION_STYLES,
  PERSONA_CONCERNS,
  PERSONA_CONCERN_MAX,
  personaDisplayName,
  BUSINESS_STAGES,
  CUSTOMER_TYPES,
  ORDER_KINDS,
  SCENARIO_CHANNELS,
  EMOTIONS,
  NATIONALITIES,
  PERSONALITIES,
  SCENARIO_SCRIPT_FIELDS,
  SUPPORTED_LANGUAGES,
} from "@cecs/contracts";
import { composePersonaWithRule, derivePersonaLegacy, filterPersonaTemplates, trainingScenarios, type PersonaRule } from "@cecs/domain";

/** 场景卡片按内置定义的顺序排（同一环节里由浅入深），老师新建的排在后面 */
const BUILTIN_SCENARIO_ORDER = trainingScenarios.map((item) => item.id);
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import type { LlmGateway } from "../llm/gateway";
import { buildMailComposeDraftMessages, buildMailReplyDraftMessages, mailDraftsSchema } from "../prompts/assist";
import { generateBuyerMailReply } from "../mail-reply";
import { buildPersonaDraftMessages, personaDraftSchema } from "../prompts/catalog";

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
  buyerRole?: string | null;
  decisionStyle?: string | null;
  concerns?: string[];
  note?: string | null;
}

/** 画像入参清洗（D-33）：结构化字段必填并校验；名称不填时用“决策风格 + 买家角色”；identity / preference 由结构化字段派生 */
function normalizePersona(body: PersonaBody): { problem: string | null; values: Required<Omit<PersonaBody, "id">> } {
  const concerns = Array.isArray(body.concerns) ? [...new Set(body.concerns.filter((item) => PERSONA_CONCERNS.includes(item as never)))] : [];
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 120) : "";
  const buyerRole = BUYER_ROLES.includes(body.buyerRole as never) ? (body.buyerRole as string) : null;
  const decisionStyle = DECISION_STYLES.includes(body.decisionStyle as never) ? (body.decisionStyle as string) : null;
  const legacy = derivePersonaLegacy({ buyerRole, concerns, note, identity: body.identity, preference: body.preference });
  const values = {
    name: (body.name?.trim() || personaDisplayName(decisionStyle, buyerRole)).slice(0, 30),
    nationality: body.nationality ?? "",
    identity: legacy.identity,
    personality: body.personality ?? "",
    emotion: body.emotion ?? "",
    language: body.language ?? "",
    preference: legacy.preference,
    customerType: body.customerType ?? "",
    enabled: body.enabled ?? true,
    buyerRole,
    decisionStyle,
    concerns,
    note,
  };
  let problem: string | null = null;
  if (!buyerRole) problem = "请选择买家角色";
  else if (!decisionStyle) problem = "请选择决策风格";
  else if (!CUSTOMER_TYPES.includes(values.customerType as never)) problem = "请选择客户价值层";
  else if (!concerns.length) problem = "至少选一个关注点";
  else if (concerns.length > PERSONA_CONCERN_MAX) problem = `关注点最多选 ${PERSONA_CONCERN_MAX} 个`;
  else if (!NATIONALITIES.includes(values.nationality as never)) problem = "国籍不在支持范围";
  else if (!PERSONALITIES.includes(values.personality as never)) problem = "性格不在支持范围";
  else if (!EMOTIONS.includes(values.emotion as never)) problem = "情绪不在支持范围";
  else if (!SUPPORTED_LANGUAGES.includes(values.language as never)) problem = "语言不在支持范围";
  return { problem, values };
}

const personaColumns = "name, nationality, identity, personality, emotion, language, preference, customer_type, enabled, buyer_role, decision_style, concerns, note";
const personaParams = (v: ReturnType<typeof normalizePersona>["values"]) => [
  v.name, v.nationality, v.identity, v.personality, v.emotion, v.language, v.preference, v.customerType, v.enabled, v.buyerRole, v.decisionStyle, JSON.stringify(v.concerns), v.note,
];

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
    buyerRole: (row.buyer_role as string | null) ?? null,
    decisionStyle: (row.decision_style as string | null) ?? null,
    concerns: (row.concerns as string[] | null) ?? [],
    note: (row.note as string | null) ?? null,
  };
}

/** 抽取用的模板形状（DB 行 → 领域对象） */
function personaRowToTemplate(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    identity: String(row.identity ?? ""),
    preference: String(row.preference ?? ""),
    customerType: String(row.customer_type ?? ""),
    nationality: row.nationality as string,
    personality: row.personality as string,
    emotion: row.emotion as string,
    language: row.language as string,
    buyerRole: (row.buyer_role as string | null) ?? null,
    decisionStyle: (row.decision_style as string | null) ?? null,
    concerns: (row.concerns as string[] | null) ?? [],
    note: (row.note as string | null) ?? null,
  };
}

/** 读取全部启用的画像模板（任务规则预览、开会话抽取共用） */
export async function loadEnabledPersonaTemplates(db: Db) {
  const result = await db.query("select * from persona_templates where enabled order by id");
  return result.rows.map(personaRowToTemplate);
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  gateway: LlmGateway,
): void {
  app.get(
    "/v1/catalog/scenarios",
    { preHandler: guard.requireRole() },
    async (request) => {
      /* 剧本只给 AI 买家和老师看：学生请求不返回 script；taskCount = 被几个未关闭的任务使用（场景卡片显示影响面） */
      const isStudent = request.user!.role === "student";
      const result = await db.query(
        `select s.id, s.name, s.stage, s.objective, s.default_language, s.enabled, s.script, s.channel, s.order_kind, s.customer_types,
                (select count(*) from tasks t where t.status <> 'closed' and t.scenario_ids ? s.id) as task_count
         from scenarios s
         order by array_position($1::text[], s.id) nulls last, s.id`,
        [BUILTIN_SCENARIO_ORDER],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        stage: row.stage,
        objective: row.objective,
        defaultLanguage: row.default_language,
        enabled: row.enabled,
        channel: row.channel ?? "chat",
        orderKind: row.order_kind ?? null,
        customerTypes: (row.customer_types as string[] | null) ?? [],
        script: isStudent ? null : row.script ?? null,
        taskCount: Number(row.task_count),
      }));
    },
  );

  // 启停场景 / 修改场景剧本（J5）。两项可分别提交
  // D6：复制一个场景再定制（内置场景本身也能改，复制是为了保留原版）
  app.post<{ Body: { fromId?: string; name?: string; stage?: string; objective?: string; channel?: string; orderKind?: string } }>(
    "/v1/catalog/scenarios",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      const id = `SC-${Date.now().toString(36).toUpperCase()}`;
      if (body.fromId) {
        const source = await db.query("select * from scenarios where id = $1", [body.fromId]);
        const row = source.rows[0];
        if (!row) {
          reply.code(404);
          return { code: "NOT_FOUND", message: "要复制的场景不存在。" };
        }
        const name = (body.name?.trim() || `${row.name}（副本）`).slice(0, 40);
        await db.query(
          `insert into scenarios (id, name, stage, objective, default_language, enabled, script, channel, order_kind, customer_types)
           values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9)`,
          [id, name, row.stage, row.objective, row.default_language, row.script ? JSON.stringify(row.script) : null, row.channel, row.order_kind, JSON.stringify(row.customer_types ?? [])],
        );
        await writeAudit(db, request.user!.sub, "scenario.copy", id, { from: row.id });
        return { id, name };
      }
      // D-32：从空白新建（剧本留空，老师在编辑抽屉里补）
      const name = body.name?.trim() ?? "";
      const objective = body.objective?.trim() ?? "";
      if (!name || name.length > 40) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "场景名称 1–40 个字。" };
      }
      if (!objective || objective.length > 300) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "训练目标 1–300 个字。" };
      }
      if (!BUSINESS_STAGES.includes(body.stage as never)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请选择业务环节。" };
      }
      const channel = SCENARIO_CHANNELS.includes(body.channel as never) ? body.channel : "chat";
      const orderKind = ORDER_KINDS.includes(body.orderKind as never) ? body.orderKind : null;
      await db.query(
        `insert into scenarios (id, name, stage, objective, default_language, enabled, channel, order_kind)
         values ($1, $2, $3, $4, 'en-US', true, $5, $6)`,
        [id, name, body.stage, objective, channel, orderKind],
      );
      await writeAudit(db, request.user!.sub, "scenario.create", id);
      return { id, name };
    },
  );

  app.patch<{ Params: { scenarioId: string }; Body: { enabled?: boolean; script?: Record<string, unknown>; name?: string; objective?: string; channel?: string; orderKind?: string | null; customerTypes?: string[] } }>(
    "/v1/catalog/scenarios/:scenarioId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const { scenarioId } = request.params;
      const { enabled, script } = request.body ?? {};
      const name = request.body?.name?.trim();
      const objective = request.body?.objective?.trim();
      const channel = request.body?.channel;
      const orderKind = request.body?.orderKind;
      const customerTypes = request.body?.customerTypes;
      if (customerTypes !== undefined && (!Array.isArray(customerTypes) || customerTypes.some((item) => !CUSTOMER_TYPES.includes(item as never)))) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "客户价值层无效。" };
      }
      if (channel !== undefined && !SCENARIO_CHANNELS.includes(channel as never)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "沟通方式无效。" };
      }
      if (orderKind !== undefined && orderKind !== null && !ORDER_KINDS.includes(orderKind as never)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "订单状态无效。" };
      }
      if (typeof enabled !== "boolean" && script === undefined && name === undefined && objective === undefined && channel === undefined && orderKind === undefined && customerTypes === undefined) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "没有要修改的内容。" };
      }
      if (name !== undefined && (!name || name.length > 40)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "场景名称 1–40 个字。" };
      }
      if (objective !== undefined && (!objective || objective.length > 300)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "训练目标 1–300 个字。" };
      }
      let cleanScript: Record<string, string> | null = null;
      if (script !== undefined) {
        if (!script || typeof script !== "object") {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "剧本格式不正确。" };
        }
        cleanScript = {};
        for (const { key, label } of SCENARIO_SCRIPT_FIELDS) {
          const value = script[key];
          if (value !== undefined && typeof value !== "string") {
            reply.code(400);
            return { code: "INVALID_INPUT", message: `「${label}」必须是文字。` };
          }
          if (typeof value === "string" && value.length > 500) {
            reply.code(400);
            return { code: "INVALID_INPUT", message: `「${label}」不能超过 500 字。` };
          }
          cleanScript[key] = (value ?? "").trim();
        }
      }
      const result = await db.query(
        `update scenarios set
           enabled = coalesce($1, enabled),
           script = case when $3 then $2::jsonb else script end,
           name = coalesce($5, name),
           objective = coalesce($6, objective),
           channel = coalesce($7, channel),
           order_kind = case when $9 then $8 else order_kind end,
           customer_types = coalesce($10::jsonb, customer_types)
         where id = $4 returning id`,
        [typeof enabled === "boolean" ? enabled : null, cleanScript ? JSON.stringify(cleanScript) : null, cleanScript !== null, scenarioId, name ?? null, objective ?? null, channel ?? null, orderKind ?? null, orderKind !== undefined, customerTypes ? JSON.stringify([...new Set(customerTypes)]) : null],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "场景不存在。" };
      }
      if (typeof enabled === "boolean") await writeAudit(db, request.user!.sub, "scenario.toggle", scenarioId, { enabled });
      if (cleanScript) await writeAudit(db, request.user!.sub, "scenario.script_update", scenarioId);
      if (name !== undefined || objective !== undefined || channel !== undefined || orderKind !== undefined || customerTypes !== undefined) {
        await writeAudit(db, request.user!.sub, "scenario.update", scenarioId, { name, objective, channel, orderKind, customerTypes });
      }
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
  app.post<{ Body: { templateId?: string; subject?: string; body?: string; recipient?: string; orderId?: string; conversationId?: string } }>(
    "/v1/mail/submissions",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const { templateId, subject, body, recipient, orderId, conversationId } = request.body ?? {};
      if (!templateId?.trim() || !subject?.trim() || !body?.trim()) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写模板、主题与正文。" };
      }
      /* 邮件任务（D-58）：发往这次任务的邮件会话，发出后会话结束、按六项评分、计入任务进度 */
      let mailConversation: { id: string; persona: Record<string, unknown> } | null = null;
      if (conversationId) {
        const owned = await db.query(
          "select id, persona from conversations where id = $1 and student_id = $2 and channel = 'mail' and status = 'active'",
          [conversationId, request.user!.sub],
        );
        if (!owned.rowCount) {
          reply.code(409);
          return { code: "MAIL_TASK_CLOSED", message: "这封任务邮件已经发出或任务已结束。" };
        }
        mailConversation = owned.rows[0] as { id: string; persona: Record<string, unknown> };
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
        `insert into mail_submissions (student_id, template_id, subject, body, violations, recipient, conversation_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning id, created_at`,
        [request.user!.sub, templateId, subject.trim(), body.trim(), JSON.stringify(violations), recipient?.trim() || null, mailConversation?.id ?? null],
      );
      if (mailConversation) {
        const persona = mailConversation.persona;
        await db.query(
          "insert into conversation_messages (conversation_id, sender, content, kind, payload) values ($1, 'student', $2, 'mail', $3)",
          [
            mailConversation.id,
            `Subject: ${subject.trim()}\n\n${body.trim()}`,
            JSON.stringify({
              subject: subject.trim(),
              body: body.trim(),
              to: recipient?.trim() || null,
              toName: persona.name ?? null,
              templateId: templateId.trim(),
              violations,
              submissionId: saved.rows[0].id,
            }),
          ],
        );
        await db.query(
          "update conversations set status = 'closed', closed_reason = 'mail_sent', closed_at = now() where id = $1 and status = 'active'",
          [mailConversation.id],
        );
        const { assessConversation } = await import("../assessment");
        void assessConversation(db, gateway, mailConversation.id).catch((error) => request.log.error(error, "mail assessment failed"));
      }
      void generateBuyerMailReply(
        db,
        gateway,
        {
          submissionId: saved.rows[0].id,
          orderId: typeof orderId === "string" && orderId.trim() ? orderId.trim() : null,
          conversationId: mailConversation?.id ?? null,
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
      if (!gateway.isConfigured("assist")) {
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
      const language = String(persona?.language ?? "en-US");
      let messages;
      if (mode === "reply") {
        messages = buildMailReplyDraftMessages({
          language,
          buyerBrief,
          orderBrief,
          originalSubject: originalSubject ?? "",
          originalBody: originalBody ?? "",
        });
      } else {
        const { emailTemplates } = await import("@cecs/domain");
        const template = emailTemplates.find((item) => item.id === templateId);
        messages = buildMailComposeDraftMessages({
          language,
          purpose: template ? `${template.name} - ${template.purpose}` : "customer outreach",
          buyerBrief,
          orderBrief,
          templateBody: template ? template.body : "(none)",
        });
      }
      try {
        const { data } = await gateway.completeJson("assist", messages, mailDraftsSchema);
        const versions = data.items.slice(0, 3).map((item) => ({
          subject: mode === "compose" ? item.subject?.trim() || null : null,
          body: item.body.trim(),
        }));
        return { versions };
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
        `select id, order_id, submission_id, from_name, from_email, subject, body, created_at
         from mail_replies where student_id = $1
         order by created_at desc limit 100`,
        [request.user!.sub],
      );
      return result.rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        submissionId: row.submission_id ?? null,
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
      /* conversationCount：这个画像被抽中过几次（画像卡片底部显示） */
      const result = await db.query(
        `select p.*, (select count(*) from conversations c where c.persona->>'sourceTemplateId' = p.id) as conversation_count
         from persona_templates p order by p.id`,
      );
      return result.rows.map((row) => ({ ...personaRowToJson(row), conversationCount: Number(row.conversation_count) }));
    },
  );

  const sampleView = (item: ReturnType<typeof composePersonaWithRule>) => ({
    name: item.name,
    gender: item.gender,
    avatarUrl: item.avatarUrl,
    templateName: item.templateName ?? "",
    nationality: item.nationality,
    language: item.language,
    personality: item.personality,
    emotion: item.emotion,
    customerType: item.customerType,
  });

  // 试抽（单个模板）：可选再套某个任务的随机规则，组合 3 个示例买家，不写库
  app.post<{ Params: { personaId: string }; Body: { taskId?: string } }>(
    "/v1/catalog/personas/:personaId/sample",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const result = await db.query("select * from persona_templates where id = $1", [request.params.personaId]);
      const row = result.rows[0];
      if (!row) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "画像不存在。" };
      }
      let rule: PersonaRule = {};
      const taskId = request.body?.taskId;
      if (taskId) {
        const user = request.user!;
        const task = await db.query(
          `select t.persona_rule from tasks t where t.id = $1 and ($2::boolean or t.created_by = $3 or exists (
             select 1 from task_classes tc join teacher_classes tcls on tcls.class_id = tc.class_id
             where tc.task_id = t.id and tcls.teacher_id = $3))`,
          [taskId, user.role === "admin", user.sub],
        );
        if (!task.rows[0]) {
          reply.code(404);
          return { code: "NOT_FOUND", message: "任务不存在。" };
        }
        // 单个模板试抽只套用“每次随机变化的”部分，人群范围不参与
        const { nationalityPool, personalityPool, emotionPool, languages } = (task.rows[0].persona_rule ?? {}) as PersonaRule;
        rule = { nationalityPool, personalityPool, emotionPool, languages };
      }
      const template = personaRowToTemplate(row);
      return { samples: Array.from({ length: 3 }, () => sampleView(composePersonaWithRule([template], rule))) };
    },
  );

  // D-33 新建任务里的画像规则预览：符合的模板数量、名称和 3 个试抽结果
  app.post<{ Body: { rule?: PersonaRule } }>(
    "/v1/catalog/personas/preview",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const rule = (request.body?.rule ?? {}) as PersonaRule;
      const templates = await loadEnabledPersonaTemplates(db);
      const matched = filterPersonaTemplates(templates, rule);
      return {
        matchCount: matched.length,
        matched: matched.map((item) => ({ id: item.id, name: item.name, customerType: item.customerType })),
        samples: matched.length ? Array.from({ length: 3 }, () => sampleView(composePersonaWithRule(templates, rule))) : [],
      };
    },
  );

  // AI 生成画像：按老师的一句话描述生成一个模板草稿（结构化字段），返回给表单，由老师确认后再保存
  app.post<{ Body: { description?: string } }>(
    "/v1/catalog/personas/generate",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      if (!gateway.isConfigured("assist")) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 服务。" };
      }
      const description = String(request.body?.description ?? "").slice(0, 300);
      const existing = await db.query("select name from persona_templates order by id");
      try {
        const { data } = await gateway.completeJson(
          "assist",
          buildPersonaDraftMessages({ description, existingNames: existing.rows.map((item) => String(item.name)) }),
          personaDraftSchema,
          { temperature: 0.9, maxTokens: 400 },
        );
        return { ...data, concerns: data.concerns.slice(0, PERSONA_CONCERN_MAX), name: personaDisplayName(data.decisionStyle, data.buyerRole) };
      } catch (error) {
        request.log.error(error, "persona generate failed");
        reply.code(502);
        return { code: "GENERATE_FAILED", message: "生成失败，请稍后重试或换个描述。" };
      }
    },
  );

  app.post<{ Body: PersonaBody }>(
    "/v1/catalog/personas",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      const { problem, values } = normalizePersona(body);
      if (problem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: problem };
      }
      const id = body.id?.trim() || `P-${Date.now().toString(36).toUpperCase()}`;
      try {
        const result = await db.query(
          `insert into persona_templates (id, ${personaColumns}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
          [id, ...personaParams(values)],
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
      const existing = await db.query("select * from persona_templates where id = $1", [personaId]);
      const current = existing.rows[0];
      if (!current) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "画像不存在。" };
      }
      const body = request.body ?? {};
      // 只改启停：旧结构的画像（还没选角色和风格）也能开关
      if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
        const result = await db.query("update persona_templates set enabled = $1 where id = $2 returning *", [body.enabled, personaId]);
        await writeAudit(db, request.user!.sub, "persona.toggle", personaId, { enabled: body.enabled });
        return personaRowToJson(result.rows[0]);
      }
      const merged: PersonaBody = { ...personaRowToJson(current), ...body } as PersonaBody;
      const { problem, values } = normalizePersona(merged);
      if (problem) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: problem };
      }
      const result = await db.query(
        `update persona_templates set (${personaColumns}) = ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) where id = $14 returning *`,
        [...personaParams(values), personaId],
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
      const result = await db.query("delete from persona_templates where id = $1 returning id", [personaId]);
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
        const { problem, values } = normalizePersona(body);
        if (problem) {
          failed.push({ index, reason: problem });
          continue;
        }
        const id = body.id?.trim() || `P-${Date.now().toString(36).toUpperCase()}-${index}`;
        try {
          await db.query(
            `insert into persona_templates (id, ${personaColumns}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [id, ...personaParams(values)],
          );
          created.push(id);
        } catch (error: unknown) {
          if ((error as { code?: string }).code === "23505") failed.push({ index, reason: "画像编号已存在" });
          else throw error;
        }
      }
      await writeAudit(db, request.user!.sub, "persona.import", undefined, { created: created.length, failed: failed.length });
      return { created, failed };
    },
  );
}
