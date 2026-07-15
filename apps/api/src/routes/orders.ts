import type { FastifyInstance } from "fastify";
import { toStudentPersonaView, ensurePersonaAvatar } from "@cecs/domain";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import type { ConversationProvider } from "../conversation-provider";

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
  provider: ConversationProvider,
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

  // 我的记录：历史评分、评语与雷达聚合
  app.get(
    "/v1/student/assessments",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select a.*, c.persona, s.name as scenario_name
         from assessments a
         join conversations c on c.id = a.conversation_id
         left join scenarios s on s.id = c.scenario_id
         where a.student_id = $1 order by a.created_at desc limit 50`,
        [user.sub],
      );
      const records = result.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        scenarioName: row.scenario_name ?? "通用会话",
        buyer: toStudentPersonaView(ensurePersonaAvatar(row.persona, row.conversation_id) as never),
        scores: row.scores,
        total: Number(row.total),
        comment: row.comment,
        suggestions: row.suggestions,
        createdAt: row.created_at,
      }));
      const radar: Record<string, number> = {};
      if (records.length > 0) {
        for (const key of Object.keys(records[0]!.scores as Record<string, number>)) {
          radar[key] = Math.round(
            records.reduce((sum, item) => sum + Number((item.scores as Record<string, number>)[key] ?? 0), 0) /
              records.length,
          );
        }
      }
      return { records, radar, average: records.length ? Math.round(records.reduce((s, r) => s + r.total, 0) / records.length) : null };
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
      if (provider.providerId === "unconfigured") {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 服务。" };
      }
      const persona = row.persona as Record<string, unknown>;
      const order = row.payload as Record<string, unknown>;
      try {
        const raw = await provider.complete(
          "You are a cross-border e-commerce customer service coach. Generate exactly 3 alternative reply drafts the agent can send to the buyer. " +
            `Task: ${SUGGESTION_TYPES[type]}. Write in the buyer's language (${persona.language ?? "en-US"}). ` +
            "Each draft: 1-3 sentences, professional, no forbidden absolute claims (e.g. 'best', '100% guaranteed'). " +
            'Return ONLY a JSON array of 3 strings, e.g. ["...","...","..."].',
          `Buyer profile: ${JSON.stringify({ name: persona.name, nationality: persona.nationality, customerType: persona.customerType })}\nOrder: ${JSON.stringify(order)}`,
        );
        let suggestions: string[] = [];
        try {
          const match = raw.match(/\[[\s\S]*\]/);
          suggestions = match ? JSON.parse(match[0]) : [];
        } catch {
          suggestions = [];
        }
        if (!Array.isArray(suggestions) || suggestions.length < 3) {
          suggestions = raw
            .split(/\n+/)
            .map((line) => line.replace(/^\s*[\d\-.、)]+\s*/, "").trim())
            .filter((line) => line.length > 15)
            .slice(0, 3);
        }
        if (suggestions.length < 3) {
          reply.code(502);
          return { code: "SUGGESTION_FAILED", message: "话术生成不完整，请重试。" };
        }
        return { type, suggestions: suggestions.slice(0, 3) };
      } catch (error) {
        request.log.error(error, "suggestion failed");
        reply.code(502);
        return { code: "SUGGESTION_FAILED", message: "话术生成失败，请稍后重试。" };
      }
    },
  );
}
