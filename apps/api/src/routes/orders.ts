import type { FastifyInstance } from "fastify";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { toStudentPersonaView, ensurePersonaAvatar } from "@cecs/domain";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import type { LlmGateway } from "../llm/gateway";
import { buildReviewReplyMessages, buildSuggestionMessages, reviewReplySchema, suggestionsSchema } from "../prompts/assist";
import { loadStoreProfile } from "./store";

const SUGGESTION_TYPES = {
  payment_reminder: "礼貌催付：提醒买家完成付款，说明库存保留时间，不施压",
  logistics_update: "物流同步与安抚：同步当前物流节点，解释可能的延误并安抚情绪",
  review_reply:
    "评价回复：以英文回复买家对本订单的评价（评价内容与星级见订单 JSON 的 review 字段）；差评（3 星及以下）需表达歉意并给出具体补救方案，好评则真诚致谢并欢迎再次选购",
} as const;

type SuggestionType = keyof typeof SUGGESTION_TYPES;

export function registerOrderRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  gateway: LlmGateway,
): void {
  // 学生订单列表（来自实训会话生成的订单）
  app.get(
    "/v1/student/orders",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select o.*, c.persona, c.status as conversation_status
         from orders o
         join conversations c on c.id = o.conversation_id
         where o.student_id = $1
         order by o.created_at desc limit 50`,
        [user.sub],
      );
      return result.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        orderNo: row.order_no,
        status: row.status,
        conversationStatus: row.conversation_status,
        buyer: toStudentPersonaView(ensurePersonaAvatar(row.persona, row.conversation_id) as never),
        detail: row.payload,
        createdAt: row.created_at,
      }));
    },
  );

  // 全店评价累计（评价管理页数据源：不受订单列表 50 条上限约束，按评价时间倒序）
  app.get(
    "/v1/student/reviews",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select o.id, o.order_no, o.conversation_id, o.payload, c.persona, c.status as conversation_status
         from orders o
         join conversations c on c.id = o.conversation_id
         where o.student_id = $1
           and o.payload->'review' is not null
           and o.payload->'review' != 'null'::jsonb
         order by o.payload->'review'->>'at' desc
         limit 500`,
        [user.sub],
      );
      return result.rows.map((row) => {
        const payload = row.payload as Record<string, unknown>;
        return {
          orderId: row.id,
          conversationId: row.conversation_id,
          conversationStatus: row.conversation_status,
          orderNo: row.order_no,
          productName: payload.productName,
          productImage: payload.productImage ?? null,
          buyer: toStudentPersonaView(ensurePersonaAvatar(row.persona, row.conversation_id) as never),
          review: payload.review,
        };
      });
    },
  );

  // 我的记录：历史评分、评语与雷达聚合
  app.get(
    "/v1/student/assessments",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select a.*, c.persona, c.task_id, c.channel, c.service_rating, s.name as scenario_name, s.stage as scenario_stage,
                t.name as task_name, t.pass_score
         from assessments a
         join conversations c on c.id = a.conversation_id
         left join scenarios s on s.id = c.scenario_id
         left join tasks t on t.id = c.task_id
         where a.student_id = $1 order by a.created_at desc limit 50`,
        [user.sub],
      );
      const records = result.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        scenarioName: row.scenario_name ?? "通用会话",
        scenarioStage: row.scenario_stage ?? null,
        taskId: row.task_id ?? null,
        taskName: row.task_name ?? null,
        passScore: row.task_id == null ? null : Number(row.pass_score ?? 60),
        buyer: toStudentPersonaView(ensurePersonaAvatar(row.persona, row.conversation_id) as never),
        scores: row.scores,
        total: Number(row.total),
        comment: row.comment,
        /* C7：教师复核评语与 AI 评语分开展示 */
        teacherComment: row.teacher_comment ?? null,
        reviewed: row.reviewed_at != null,
        suggestions: row.suggestions,
        /* 自由练习（无任务归属）：保留 AI 反馈供学习，但不计入平均分与雷达 */
        practice: row.task_id == null,
        /* D-58：邮件任务的记录，复盘里看这封邮件 */
        channel: (row.channel ?? "chat") as "chat" | "mail",
        /* D-54：买家给这次服务打的星 */
        serviceRating: row.service_rating == null ? null : Number(row.service_rating),
        createdAt: row.created_at,
      }));
      const scored = records.filter((row) => !row.practice);
      // 各维度只在有分的记录里平均：老记录没有新增两项（D-46），不按 0 分算
      const radar: Record<string, number> = {};
      for (const dim of ASSESSMENT_DIMENSIONS) {
        const values = scored
          .map((item) => (item.scores as Record<string, number | undefined>)[dim.id])
          .filter((value): value is number => value != null && Number.isFinite(Number(value)));
        if (values.length) radar[dim.id] = Math.round(values.reduce((sum, value) => sum + Number(value), 0) / values.length);
      }
      return { records, radar, average: scored.length ? Math.round(scored.reduce((s, r) => s + r.total, 0) / scored.length) : null };
    },
  );

  // 订单操作：添加备注 / 修改收货地址（工作台订单页签的售前售后操作）
  app.patch<{
    Params: { orderId: string };
    Body: { remark?: string; address?: { recipient?: string; line1?: string; city?: string; country?: string; phone?: string } };
  }>(
    "/v1/orders/:orderId",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const { remark, address } = request.body ?? {};
      if (remark === undefined && address === undefined) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请提供备注或地址。" };
      }
      const patch: Record<string, unknown> = {};
      if (remark !== undefined) {
        if (typeof remark !== "string" || remark.length > 500) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "备注需为 500 字以内文本。" };
        }
        patch.remark = remark.trim() || null;
      }
      if (address !== undefined) {
        const fields = ["recipient", "line1", "city", "country", "phone"] as const;
        const next: Record<string, string> = {};
        for (const key of fields) {
          const value = address?.[key];
          if (typeof value !== "string" || !value.trim() || value.length > 120) {
            reply.code(400);
            return { code: "INVALID_INPUT", message: "地址各项均为必填（120 字以内）。" };
          }
          next[key] = value.trim();
        }
        patch.address = next;
      }
      const result = await db.query(
        `update orders set payload = payload || $1::jsonb
         where id = $2 and student_id = $3
         returning payload`,
        [JSON.stringify(patch), request.params.orderId, user.sub],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "订单不存在。" };
      }
      return { ok: true, detail: result.rows[0].payload };
    },
  );

  // AI 生成 ≥3 版本话术（催付/物流安抚/差评回复），供选择与二次编辑
  app.post<{ Params: { orderId: string }; Body: { type?: string } }>(
    "/v1/orders/:orderId/suggestions",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const type = request.body?.type as SuggestionType | undefined;
      if (!type || !(type in SUGGESTION_TYPES)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "话术类型无效。" };
      }
      const result = await db.query(
        `select o.payload, c.persona from orders o
         join conversations c on c.id = o.conversation_id
         where o.id = $1 and o.student_id = $2`,
        [request.params.orderId, user.sub],
      );
      const row = result.rows[0];
      if (!row) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "订单不存在。" };
      }
      if (!gateway.isConfigured("assist")) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 服务。" };
      }
      const persona = row.persona as Record<string, unknown>;
      const order = row.payload as Record<string, unknown>;
      try {
        if (type === "review_reply") {
          const store = await loadStoreProfile(db);
          const { data } = await gateway.completeJson(
            "assist",
            buildReviewReplyMessages({ persona, order, storeName: store.name, signature: store.signature }),
            reviewReplySchema,
          );
          const variants = data.items.slice(0, 3).map((item) => ({ angle: item.angle, text: item.en, zh: item.zh }));
          return { type, suggestions: variants.map((item) => item.text), variants };
        }
        const { data } = await gateway.completeJson(
          "assist",
          buildSuggestionMessages({ task: SUGGESTION_TYPES[type], persona, order }),
          suggestionsSchema,
        );
        const suggestions = data.items;
        return { type, suggestions: suggestions.slice(0, 3) };
      } catch (error) {
        request.log.error(error, "suggestion failed");
        reply.code(502);
        return { code: "SUGGESTION_FAILED", message: "话术生成失败，请稍后重试。" };
      }
    },
  );
}
