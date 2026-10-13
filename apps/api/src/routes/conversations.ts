import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BusinessStage, OrderKind, ScenarioScript } from "@cecs/contracts";
import {
  buyerHistoryOrderCount,
  composePersonaWithRule,
  NoMatchingPersonaError,
  ensurePersonaAvatar,
  generateBuyerOrderHistory,
  generateOrderForScenario,
  productFactSheet,
  storeCoupons,
  toStudentPersonaView,
  type OrderInfo,
} from "@cecs/domain";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import type { CallInfo, LlmGateway } from "../llm/gateway";
import type { VoiceService } from "../voice/service";
import { buildBuyerMessages } from "../prompts/buyer";
import { loadEnabledPersonaTemplates } from "./catalog";
import { buildTranslationMessages } from "../prompts/assist";

interface ConversationRow {
  id: string;
  task_id: string | null;
  student_id: string;
  scenario_id: string | null;
  persona: Record<string, unknown>;
  state?: Record<string, unknown> | null;
  status: string;
  created_at: string;
}

const STREAM_TIMEOUT_MS = 60_000;

/** 买家离场标记：模型在告别消息末尾输出，服务端剥离并自动结束会话 */
const END_MARK = "[END_OF_SERVICE]";
/** 买家连发分隔符：一轮回复拆成多条短消息（拟真聊天节奏） */
const SPLIT_MARK = "|||";

async function loadOrder(db: Db, conversationId: string): Promise<OrderInfo | null> {
  const result = await db.query(
    "select payload from orders where conversation_id = $1 and is_primary",
    [conversationId],
  );
  return (result.rows[0]?.payload as OrderInfo | undefined) ?? null;
}

async function loadScene(db: Db, scenarioId: string | null): Promise<{ prompt: string; script: ScenarioScript | null }> {
  const fallback = { prompt: "General customer service conversation.", script: null };
  if (!scenarioId) return fallback;
  const result = await db.query(
    "select name, objective, script from scenarios where id = $1",
    [scenarioId],
  );
  const scenario = result.rows[0];
  return scenario
    ? { prompt: `${scenario.name}：${scenario.objective}`, script: (scenario.script as ScenarioScript | null) ?? null }
    : fallback;
}

/** 以 SSE 流式输出一轮买家回复，落库消息与验收指标 */
async function streamBuyerTurn(options: {
  db: Db;
  gateway: LlmGateway;
  request: FastifyRequest;
  reply: FastifyReply;
  conversation: ConversationRow;
  history: Array<{ role: "buyer" | "student" | "teacher"; content: string }>;
}): Promise<void> {
  const { db, gateway, request, reply, conversation, history } = options;
  // B2：首字耗时从收到请求那一刻算起（含查库、组装上下文），不是从调用模型时算
  const receivedAt = new Date(request.receivedAt);
  const scene = await loadScene(db, conversation.scenario_id);
  const order = await loadOrder(db, conversation.id);

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": String(request.headers.origin ?? "*"),
    "access-control-allow-credentials": "true",
  });
  const send = (payload: Record<string, unknown>) => {
    raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let firstCharAt: Date | null = null;
  let buyerReply = "";
  let emittedChars = 0;
  let emissionEnded = false;
  let outcome: "success" | "timeout" | "error" = "success";
  let timedOut = false as boolean;
  const abort = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, STREAM_TIMEOUT_MS);

  // 流式外发：扣留尾部（防止把标记流给前端）；|||→split 事件（买家连发），END→停止外发
  const emitSafeDelta = (finalFlush = false) => {
    if (emissionEnded) return;
    for (;;) {
      const endIdx = buyerReply.indexOf(END_MARK, emittedChars);
      const splitIdx = buyerReply.indexOf(SPLIT_MARK, emittedChars);
      let token: "end" | "split" | null = null;
      let tokenIdx = -1;
      if (endIdx >= 0 && (splitIdx < 0 || endIdx < splitIdx)) {
        token = "end";
        tokenIdx = endIdx;
      } else if (splitIdx >= 0) {
        token = "split";
        tokenIdx = splitIdx;
      }
      if (token) {
        if (tokenIdx > emittedChars) send({ type: "delta", text: buyerReply.slice(emittedChars, tokenIdx) });
        if (token === "end") {
          emittedChars = buyerReply.length;
          emissionEnded = true;
          return;
        }
        send({ type: "split" });
        emittedChars = tokenIdx + SPLIT_MARK.length;
        continue;
      }
      const safeEnd = finalFlush ? buyerReply.length : Math.max(emittedChars, buyerReply.length - END_MARK.length + 1);
      if (safeEnd > emittedChars) {
        send({ type: "delta", text: buyerReply.slice(emittedChars, safeEnd) });
        emittedChars = safeEnd;
      }
      return;
    }
  };

  // 网关容错：尚未输出正文时，网关会自动改用备用档案；这里再兜底重试一次（应对瞬时故障）
  let callInfo: CallInfo | null = null;
  const messages = buildBuyerMessages({
    scenePrompt: scene.prompt,
    script: scene.script,
    personaSnapshot: conversation.persona,
    orderSnapshot: order ? (order as unknown as Record<string, unknown>) : {},
    sessionState: (conversation.state ?? {}) as never,
    history,
  });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const stream = gateway.stream("dialogue", messages, {
        signal: abort.signal,
        conversationId: conversation.id,
        onInfo: (info) => {
          callInfo = info;
        },
      });
      for await (const text of stream) {
        if (!firstCharAt) {
          firstCharAt = new Date();
          send({ type: "start", ttftMs: firstCharAt.getTime() - receivedAt.getTime() });
        }
        buyerReply += text;
        emitSafeDelta();
      }
      outcome = "success";
      break;
    } catch (error) {
      outcome = timedOut ? "timeout" : "error";
      request.log.error({ err: error, attempt }, "llm stream failed");
      if (timedOut || buyerReply.length > 0 || attempt === 2) break;
    }
  }
  clearTimeout(timer);

  // 剥离离场标记；买家离开 = 会话由买家结束（客服无权挂断）
  const markIdx = buyerReply.indexOf(END_MARK);
  const buyerLeft = markIdx >= 0;
  if (buyerLeft) {
    buyerReply = (buyerReply.slice(0, markIdx) + buyerReply.slice(markIdx + END_MARK.length)).trimEnd();
  }
  emitSafeDelta(true);

  // 按 ||| 拆成多条短消息分行落库（拟真买家连发；回放/教师端同样逐条展示）
  const segments = buyerReply
    .split(SPLIT_MARK)
    .map((part) => part.trim())
    .filter(Boolean);
  const totalChars = segments.reduce((sum, part) => sum + part.length, 0);

  const completedAt = new Date();
  let buyerMessageId: string | null = null;
  for (const segment of segments) {
    const saved = await db.query(
      `insert into conversation_messages (conversation_id, sender, content)
       values ($1, 'buyer', $2) returning id`,
      [conversation.id, segment],
    );
    buyerMessageId = saved.rows[0].id;
  }
  if (segments.length === 0 && outcome === "success") {
    outcome = "error";
  }
  await db.query(
    `insert into conversation_metrics
       (conversation_id, received_at, first_char_at, completed_at, valid_chars, provider, model, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      conversation.id,
      receivedAt,
      firstCharAt,
      completedAt,
      totalChars,
      (callInfo as CallInfo | null)?.profileName ?? gateway.describe("dialogue")?.profileName ?? "unconfigured",
      (callInfo as CallInfo | null)?.model ?? gateway.describe("dialogue")?.model ?? "unconfigured",
      outcome,
    ],
  );

  // 买家离开：自动结束会话并触发六维评分（真实规则：只有客户会主动断开）
  let conversationClosed = false;
  if (buyerLeft && outcome === "success") {
    const closed = await db.query(
      "update conversations set status = 'closed', closed_reason = 'buyer_left', closed_at = now() where id = $1 and status = 'active' returning id",
      [conversation.id],
    );
    if (closed.rowCount) {
      conversationClosed = true;
      const { assessConversation } = await import("../assessment");
      void assessConversation(db, gateway, conversation.id).catch((error) =>
        request.log.error(error, "assessment failed"),
      );
      // 闭环评价：买家按本次服务结果留评/改评（异步，不阻塞）
      const { generateBuyerReview } = await import("../review-gen");
      void generateBuyerReview(db, gateway, conversation.id, request.log).catch((error) =>
        request.log.error(error, "buyer review failed"),
      );
    }
  }

  // 轻量Agent导演：异步评估学生表现、推演买家状态并更新记忆（不阻塞响应）
  if (outcome === "success" && !conversationClosed && history.some((item) => item.role === "student")) {
    void import("../director")
      .then(({ runDirector }) => runDirector(db, gateway, conversation.id))
      .catch((error) => request.log.error(error, "director failed"));
  }

  const durationSeconds = firstCharAt
    ? Math.max((completedAt.getTime() - firstCharAt.getTime()) / 1000, 0.001)
    : 0;
  send({
    type: outcome === "success" ? "done" : "error",
    messageId: buyerMessageId,
    closed: conversationClosed,
    metrics: {
      ttftMs: firstCharAt ? firstCharAt.getTime() - receivedAt.getTime() : null,
      validChars: totalChars,
      charsPerSecond: firstCharAt ? Math.round(totalChars / durationSeconds) : 0,
      outcome,
    },
  });
  raw.end();
}

export function registerConversationRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  gateway: LlmGateway,
  voice: VoiceService,
): void {
  app.post<{ Body: { taskId?: string; scenarioId?: string } }>(
    "/v1/conversations",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const { taskId, scenarioId } = request.body ?? {};
      let resolvedScenarioId = scenarioId ?? null;

      let personaRule: Record<string, unknown> = {};
      if (taskId) {
        const progress = await db.query(
          `select t.scenario_ids, t.persona_rule, t.start_at from task_progress tp
           join tasks t on t.id = tp.task_id
           where tp.task_id = $1 and tp.student_id = $2`,
          [taskId, user.sub],
        );
        const row = progress.rows[0];
        if (!row) {
          reply.code(403);
          return { code: "FORBIDDEN", message: "该任务未下发给你。" };
        }
        /* 定时开放：未到开始时间不可进入（前端置灰 + 服务端双重拦截）。
           不在消息里拼具体时间：服务器时区未必与学生一致，开放时间由前端本地化展示 */
        if (row.start_at && new Date(row.start_at).getTime() > Date.now()) {
          reply.code(403);
          return { code: "TASK_NOT_STARTED", message: "该任务还未到开放时间，请在任务列表标注的开放时间后进入。" };
        }
        personaRule = (row.persona_rule ?? {}) as Record<string, unknown>;
        const ids = row.scenario_ids as string[];
        if (!resolvedScenarioId) resolvedScenarioId = ids[0] ?? null;
        else if (!ids.includes(resolvedScenarioId)) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "所选场景不属于该任务。" };
        }
        await db.query(
          `update task_progress set status = 'in_progress', updated_at = now()
           where task_id = $1 and student_id = $2 and status = 'todo'`,
          [taskId, user.sub],
        );
      }

      let scenario: { id: string; name: string; objective: string; stage: BusinessStage; orderKind: OrderKind | null } | null = null;
      if (resolvedScenarioId) {
        const result = await db.query(
          "select id, name, objective, stage, order_kind as \"orderKind\" from scenarios where id = $1 and enabled",
          [resolvedScenarioId],
        );
        scenario = result.rows[0] ?? null;
        if (!scenario) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "场景不存在或未启用。" };
        }
      }

      // 服务端生成画像快照（D-33）：按任务规则先筛人群范围，再随机沟通方式和姓名；没有符合的画像时拒绝开始
      let persona: ReturnType<typeof composePersonaWithRule>;
      try {
        persona = composePersonaWithRule(await loadEnabledPersonaTemplates(db), personaRule);
      } catch (error) {
        if (!(error instanceof NoMatchingPersonaError)) throw error;
        reply.code(409);
        return { code: "NO_MATCHING_PERSONA", message: "这个任务的买家范围里没有可用的画像，请联系老师调整。" };
      }
      // 先定关联订单（按场景的订单状态），再把对应商品的资料卡交给买家 AI（D-32）
      const personaBrief = { name: persona.name as string, nationality: persona.nationality as string };
      const productRows = await db.query("select name, spec, price, image_url, category, details from store_products where enabled");
      const productPool = productRows.rows.map((row) => ({
        name: row.name as string,
        spec: row.spec as string,
        price: Number(row.price),
        imageUrl: (row.image_url as string | null) ?? null,
      }));
      const factsOf = (name: string) => {
        const row = productRows.rows.find((item) => item.name === name);
        return row ? productFactSheet({ name: row.name, spec: row.spec, price: Number(row.price), category: row.category, details: row.details }) : null;
      };
      let order: OrderInfo | null = null;
      if (scenario) {
        order = generateOrderForScenario(scenario.stage, Math.random, new Date(), productPool, personaBrief, scenario.orderKind);
      }
      const personaRecord = persona as unknown as Record<string, unknown>;
      if (order) {
        personaRecord.productFacts = factsOf(order.productName);
      } else if (scenario?.stage === "pre_sale" || scenario?.orderKind === "none") {
        // 售前没有订单：给买家一个店铺里真实在售的“感兴趣商品”，否则买家只能泛泛地问“那个新品”
        const product = productPool[Math.floor(Math.random() * productPool.length)];
        if (product) {
          personaRecord.interestedProduct = { name: product.name, spec: product.spec, price: product.price };
          personaRecord.productFacts = factsOf(product.name);
        }
      }
      const created = await db.query<ConversationRow>(
        `insert into conversations (task_id, student_id, scenario_id, persona)
         values ($1, $2, $3, $4) returning *`,
        [taskId ?? null, user.sub, resolvedScenarioId, JSON.stringify(persona)],
      );
      const conversation = created.rows[0]!;

      // 当前咨询关联订单（售中/售后/客户维护场景）+ 买家历史订单（老客/粉丝客有过往订单可查可操作）
      const insertOrder = (info: OrderInfo, isPrimary: boolean) =>
        db.query(
          `insert into orders (conversation_id, student_id, order_no, status, product_name, total_amount, currency, payload, is_primary)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            conversation.id,
            user.sub,
            info.orderNo,
            info.status,
            info.productName,
            info.totalAmount,
            info.currency,
            JSON.stringify(info),
            isPrimary,
          ],
        );
      if (order) await insertOrder(order, true);
      const historyOrders = generateBuyerOrderHistory(
        buyerHistoryOrderCount(persona.customerType as string, Math.random),
        Math.random,
        new Date(),
        productPool,
        personaBrief,
      );
      for (const item of historyOrders) await insertOrder(item, false);

      return {
        id: conversation.id,
        taskId: conversation.task_id,
        scenario: scenario
          ? { id: scenario.id, name: scenario.name, objective: scenario.objective }
          : null,
        buyer: toStudentPersonaView(ensurePersonaAvatar(persona, conversation.id)),
        order,
        createdAt: conversation.created_at,
      };
    },
  );

  app.get<{ Querystring: { status?: string } }>(
    "/v1/conversations",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const status = request.query.status === "closed" ? "closed" : "active";
      const result = await db.query(
        `select c.*, s.name as scenario_name, s.objective as scenario_objective, s.stage as scenario_stage,
                o.payload as order_payload,
                lm.content as last_content, lm.sender as last_sender, lm.created_at as last_at,
                (select count(*) from conversation_messages mv
                 where mv.conversation_id = c.id and mv.sender = 'buyer'
                   and mv.created_at > now() - interval '72 hours') as visits72
         from conversations c
         left join scenarios s on s.id = c.scenario_id
         left join orders o on o.conversation_id = c.id and o.is_primary
         left join lateral (
           select content, sender, created_at from conversation_messages m
           where m.conversation_id = c.id order by m.created_at desc limit 1
         ) lm on true
         where c.student_id = $1 and c.status = $2
         order by coalesce(lm.created_at, c.created_at) desc limit 30`,
        [user.sub, status],
      );
      return result.rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        scenarioId: row.scenario_id,
        scenario: row.scenario_name
          ? {
              id: row.scenario_id,
              name: row.scenario_name,
              objective: row.scenario_objective,
              stage: row.scenario_stage,
            }
          : null,
        buyer: toStudentPersonaView(ensurePersonaAvatar(row.persona, row.id) as never),
        order: row.order_payload ?? null,
        status: row.status,
        lastMessage: row.last_content
          ? { content: row.last_content, sender: row.last_sender, createdAt: row.last_at }
          : null,
        unreplied: row.last_sender === "buyer",
        visits72h: Number(row.visits72 ?? 0),
        createdAt: row.created_at,
      }));
    },
  );

  // 学生客服指标：今日接待/平均响应/未回复/12小时响应率/满意率/询单支付金额/付款人数/询单转化率
  app.get(
    "/v1/student/workbench-stats",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const [today, unreplied, response, twelveHour, satisfaction, paid] = await Promise.all([
        db.query(
          `select count(*) as n from conversations
           where student_id = $1 and created_at::date = current_date`,
          [user.sub],
        ),
        db.query(
          `select count(*) as n from conversations c
           where c.student_id = $1 and c.status = 'active' and (
             select sender from conversation_messages m
             where m.conversation_id = c.id and m.sender <> 'teacher' order by m.created_at desc limit 1
           ) = 'buyer'`,
          [user.sub],
        ),
        db.query(
          `select avg(extract(epoch from (reply_at - buyer_at))) as avg_s from (
             select m.created_at as buyer_at,
               (select min(m2.created_at) from conversation_messages m2
                where m2.conversation_id = m.conversation_id
                  and m2.sender = 'student' and m2.created_at > m.created_at) as reply_at
             from conversation_messages m
             join conversations c on c.id = m.conversation_id
             where c.student_id = $1 and m.sender = 'buyer'
               and m.created_at::date = current_date
           ) gaps where reply_at is not null`,
          [user.sub],
        ),
        // 12 小时响应率：近 7 天买家消息中，12 小时内得到学生回复的占比（未满 12 小时且未回复的不计入分母）
        db.query(
          `select count(*) filter (where reply_at is not null and reply_at - buyer_at <= interval '12 hours') as ok,
                  count(*) as total
           from (
             select m.created_at as buyer_at,
               (select min(m2.created_at) from conversation_messages m2
                where m2.conversation_id = m.conversation_id
                  and m2.sender = 'student' and m2.created_at > m.created_at) as reply_at
             from conversation_messages m
             join conversations c on c.id = m.conversation_id
             where c.student_id = $1 and m.sender = 'buyer'
               and m.created_at > now() - interval '7 days'
           ) gaps
           where reply_at is not null or buyer_at < now() - interval '12 hours'`,
          [user.sub],
        ),
        // 满意率：近 7 天会话导演满意度均值
        db.query(
          `select avg((state->>'satisfaction')::numeric) as s from conversations
           where student_id = $1 and state ? 'satisfaction'
             and created_at > now() - interval '7 days'`,
          [user.sub],
        ),
        // 询单支付金额/付款人数：今日会话中已付款（含发货后各状态）的关联订单
        db.query(
          `select coalesce(sum(o.total_amount), 0) as amount,
                  count(distinct o.conversation_id) as buyers
           from orders o
           join conversations c on c.id = o.conversation_id
           where o.student_id = $1 and o.is_primary
             and c.created_at::date = current_date
             and o.status in ('paid','in_transit','delivered','completed')`,
          [user.sub],
        ),
      ]);
      const avg = response.rows[0]?.avg_s;
      const todayCount = Number(today.rows[0]?.n ?? 0);
      const twelveTotal = Number(twelveHour.rows[0]?.total ?? 0);
      const satisfactionAvg = satisfaction.rows[0]?.s;
      const paidBuyers = Number(paid.rows[0]?.buyers ?? 0);
      return {
        todayConversations: todayCount,
        unreplied: Number(unreplied.rows[0]?.n ?? 0),
        avgResponseSeconds: avg === null || avg === undefined ? null : Math.round(Number(avg)),
        twelveHourResponseRate:
          twelveTotal > 0 ? Math.round((Number(twelveHour.rows[0]?.ok ?? 0) / twelveTotal) * 1000) / 10 : null,
        satisfactionRate:
          satisfactionAvg === null || satisfactionAvg === undefined
            ? null
            : Math.round(Number(satisfactionAvg)),
        inquiryPaidAmount: Math.round(Number(paid.rows[0]?.amount ?? 0) * 100) / 100,
        paidBuyers,
        conversionRate: todayCount > 0 ? Math.round((paidBuyers / todayCount) * 1000) / 10 : null,
      };
    },
  );

  // 当前接待买家的全部订单（当前咨询关联订单 + 历史订单），供订单页签查看与售前售后操作
  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/orders",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const owned = await db.query(
        "select 1 from conversations where id = $1 and student_id = $2",
        [request.params.conversationId, user.sub],
      );
      if (!owned.rowCount) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "无权查看该会话。" };
      }
      const result = await db.query(
        `select id, is_primary, payload from orders
         where conversation_id = $1
         order by is_primary desc, (payload->>'placedAt') desc`,
        [request.params.conversationId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        isPrimary: row.is_primary,
        detail: row.payload,
      }));
    },
  );

  // 教师指导通知：不进入会话消息流，在顶栏「消息」中展示
  app.get(
    "/v1/student/guidance",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select m.id, m.conversation_id, m.content, m.created_at, c.persona
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
         where c.student_id = $1 and m.sender = 'teacher'
         order by m.created_at desc limit 30`,
        [user.sub],
      );
      return result.rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        buyerName: ((row.persona ?? {}) as { name?: string }).name ?? "客户",
        content: row.content,
        createdAt: row.created_at,
      }));
    },
  );

  // 关闭会话（结束本次实训对话）
  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/close",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const result = await db.query(
        `update conversations set status = 'closed', closed_reason = 'student_ended', closed_at = now()
         where id = $1 and student_id = $2 and status = 'active' returning id`,
        [request.params.conversationId, user.sub],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "会话不存在或已关闭。" };
      }
      // 后台异步六维评分，不阻塞关闭
      const { assessConversation } = await import("../assessment");
      void assessConversation(db, gateway, request.params.conversationId).catch((error) =>
        request.log.error(error, "assessment failed"),
      );
      // 闭环评价：买家按本次服务结果留评/改评（异步，不阻塞）
      const { generateBuyerReview } = await import("../review-gen");
      void generateBuyerReview(db, gateway, request.params.conversationId, request.log).catch((error) =>
        request.log.error(error, "buyer review failed"),
      );
      return { ok: true };
    },
  );

  // 买家消息翻译（LLM 实时翻译，结果缓存复用）
  app.post<{ Params: { conversationId: string; messageId: string } }>(
    "/v1/conversations/:conversationId/messages/:messageId/translate",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const result = await db.query(
        `select m.id, m.content, m.translated_content from conversation_messages m
         join conversations c on c.id = m.conversation_id
         where m.id = $1 and m.conversation_id = $2 and c.student_id = $3 and m.sender = 'buyer'`,
        [request.params.messageId, request.params.conversationId, user.sub],
      );
      const message = result.rows[0];
      if (!message) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "消息不存在或不可翻译。" };
      }
      if (message.translated_content) {
        return { translation: message.translated_content, cached: true };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "翻译服务未配置。" };
      }
      try {
        const { text: translation } = await gateway.complete("assist", buildTranslationMessages(message.content));
        await db.query(
          "update conversation_messages set translated_content = $1 where id = $2",
          [translation, message.id],
        );
        return { translation, cached: false };
      } catch (error) {
        request.log.error(error, "translate failed");
        reply.code(502);
        return { code: "TRANSLATE_FAILED", message: "翻译失败，请稍后重试。" };
      }
    },
  );

  // 买家消息语音播报（豆包 TTS，音频缓存复用；耗时入库供 ≤5 秒验收核验）
  app.post<{ Params: { conversationId: string; messageId: string } }>(
    "/v1/conversations/:conversationId/messages/:messageId/tts",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const result = await db.query(
        `select m.id, m.content, c.persona from conversation_messages m
         join conversations c on c.id = m.conversation_id
         where m.id = $1 and m.conversation_id = $2 and c.student_id = $3 and m.sender = 'buyer'`,
        [request.params.messageId, request.params.conversationId, user.sub],
      );
      const message = result.rows[0];
      if (!message) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "消息不存在或不可播报。" };
      }
      const persona = (message.persona ?? {}) as {
        gender?: string;
        language?: string;
        sourceTemplateId?: string;
        name?: string;
      };
      const { resolvePersonaGender } = await import("@cecs/domain");
      const gender = resolvePersonaGender(persona);
      const path = await import("node:path");
      const fs = await import("node:fs");
      // 缓存文件名带性别后缀：修正历史女声缓存，且换音色后不串音
      const fileName = `${message.id}-${gender === "male" ? "m" : "f"}.mp3`;
      const target = path.resolve(process.cwd(), "uploads", "tts", fileName);
      const audioUrl = `/uploads/tts/${fileName}`;
      if (fs.existsSync(target)) return { audioUrl, cached: true };
      if (!(await voice.configured())) {
        reply.code(503);
        return { code: "TTS_NOT_CONFIGURED", message: "语音服务未配置。" };
      }
      try {
        // 按买家画像选择音色（男/女）与朗读语种
        const { audio, elapsedMs } = await voice.synthesize(
          message.content.slice(0, 500),
          gender === "male" ? "male" : "female",
          persona.language,
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, audio);
        await db.query(
          "insert into voice_metrics (kind, elapsed_ms, chars, outcome) values ('tts', $1, $2, 'success')",
          [elapsedMs, message.content.length],
        );
        return { audioUrl, cached: false, elapsedMs };
      } catch (error) {
        await db.query(
          "insert into voice_metrics (kind, elapsed_ms, chars, outcome) values ('tts', 0, $1, 'error')",
          [message.content.length],
        );
        request.log.error(error, "tts failed");
        reply.code(502);
        return { code: "TTS_FAILED", message: "语音合成失败，请稍后重试。" };
      }
    },
  );

  // 学生语音输入：整段音频识别为文字（豆包流式识别，耗时入库供 ≤5 秒验收）
  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/asr",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const conversationResult = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2",
        [request.params.conversationId, user.sub],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权访问。" };
      }
      const file = await request.file();
      if (!file || !/(wav|mpeg|mp3|octet-stream)/.test(file.mimetype)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请上传 wav/mp3 音频。" };
      }
      const buffers: Buffer[] = [];
      for await (const chunk of file.file) buffers.push(chunk as Buffer);
      const audio = Buffer.concat(buffers);
      if (audio.length < 1000) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "录音过短，请重试。" };
      }
      if (!(await voice.configured())) {
        reply.code(503);
        return { code: "ASR_NOT_CONFIGURED", message: "语音识别服务未配置。" };
      }
      const persona = (conversation.persona ?? {}) as { language?: string };
      try {
        const format = file.mimetype.includes("wav") || file.mimetype.includes("octet") ? "wav" : "mp3";
        const { text, elapsedMs, audioMs } = await voice.recognize(audio, format, persona.language);
        await db.query(
          "insert into voice_metrics (kind, elapsed_ms, chars, outcome, audio_ms) values ('asr', $1, $2, 'success', $3)",
          [elapsedMs, text.length, audioMs],
        );
        return { text, elapsedMs };
      } catch (error) {
        await db.query(
          "insert into voice_metrics (kind, elapsed_ms, chars, outcome) values ('asr', 0, 0, 'error')",
        );
        request.log.error(error, "asr failed");
        reply.code(502);
        return { code: "ASR_FAILED", message: "语音识别失败，请重试。" };
      }
    },
  );

  // 学生直发语音消息：存音频+后台转写（供买家理解与回放），买家以 SSE 回应
  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/voice-messages",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const conversationResult = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2 and status = 'active'",
        [request.params.conversationId, user.sub],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权访问。" };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 对话服务。" };
      }
      const file = await request.file();
      if (!file) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请上传语音文件。" };
      }
      const buffers: Buffer[] = [];
      for await (const chunk of file.file) buffers.push(chunk as Buffer);
      const audio = Buffer.concat(buffers);
      if (audio.length < 4000) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "录音过短，请重试。" };
      }
      const persona = (conversation.persona ?? {}) as { language?: string };
      const voiceFormat = file.mimetype.includes("mp") && !file.mimetype.includes("wav") ? "mp3" : "wav";
      let transcript = "";
      try {
        const result = await voice.recognize(audio, voiceFormat, persona.language);
        transcript = result.text.trim();
        await db.query(
          "insert into voice_metrics (kind, elapsed_ms, chars, outcome, audio_ms) values ('asr', $1, $2, 'success', $3)",
          [result.elapsedMs, transcript.length, result.audioMs],
        );
      } catch (error) {
        request.log.error(error, "voice message asr failed");
      }
      if (!transcript) {
        reply.code(422);
        return { code: "ASR_EMPTY", message: "未识别到有效语音，请重试或改用文字。" };
      }

      const path = await import("node:path");
      const fs = await import("node:fs");
      const { randomUUID } = await import("node:crypto");
      const fileName = `${randomUUID()}.${voiceFormat}`;
      const target = path.resolve(process.cwd(), "uploads", "voice", fileName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, audio);
      const durationMs = voiceFormat === "wav" ? Math.round((audio.length - 44) / 32) : 0; // 16k/16bit/mono

      const historyResult = await db.query(
        `select sender, content from conversation_messages
         where conversation_id = $1 order by created_at desc limit 300`,
        [conversation.id],
      );
      const history = historyResult.rows
        .reverse()
        .map((row) => ({ role: row.sender as "buyer" | "student" | "teacher", content: row.content }));
      await db.query(
        `insert into conversation_messages (conversation_id, sender, content, kind, payload)
         values ($1, 'student', $2, 'voice', $3)`,
        [
          conversation.id,
          transcript,
          JSON.stringify({ audioUrl: `/uploads/voice/${fileName}`, durationMs, transcript }),
        ],
      );
      await streamBuyerTurn({
        db,
        gateway,
        request,
        reply,
        conversation,
        history: [...history, { role: "student", content: transcript }],
      });
    },
  );

  // 学生发送图片/视频/文件附件（存储后作为消息展示，买家以 SSE 回应）
  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/attachment-messages",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const conversationResult = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2 and status = 'active'",
        [request.params.conversationId, user.sub],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权访问。" };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 对话服务。" };
      }
      const file = await request.file({ limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
      if (!file) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请选择要发送的文件。" };
      }
      const kindField = (file.fields?.kind as { value?: string } | undefined)?.value;
      const kind = kindField === "image" || kindField === "video" || kindField === "file" ? kindField : null;
      if (!kind) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "附件类型无效。" };
      }
      const RULES: Record<string, { mime: RegExp; maxBytes: number; label: string }> = {
        image: { mime: /^image\/(png|jpe?g|webp|gif)$/, maxBytes: 8 * 1024 * 1024, label: "图片" },
        video: { mime: /^video\/(mp4|webm|quicktime)$/, maxBytes: 50 * 1024 * 1024, label: "视频" },
        file: {
          mime: /^(application\/(pdf|zip|msword|vnd\.openxmlformats-officedocument\.[\w.]+|vnd\.ms-excel)|text\/(plain|csv))$/,
          maxBytes: 20 * 1024 * 1024,
          label: "文件",
        },
      };
      const rule = RULES[kind]!;
      if (!rule.mime.test(file.mimetype)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: `该${rule.label}格式不支持。` };
      }
      const buffers: Buffer[] = [];
      for await (const chunk of file.file) buffers.push(chunk as Buffer);
      const data = Buffer.concat(buffers);
      if (file.file.truncated || data.length > rule.maxBytes) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: `${rule.label}大小超过限制。` };
      }
      const path = await import("node:path");
      const fs = await import("node:fs");
      const { randomUUID } = await import("node:crypto");
      const ext = path.extname(file.filename ?? "").slice(0, 10) || `.${kind === "image" ? "png" : "bin"}`;
      const fileName = `${randomUUID()}${ext}`;
      const target = path.resolve(process.cwd(), "uploads", "attachments", fileName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);

      const payload = {
        url: `/uploads/attachments/${fileName}`,
        name: file.filename ?? fileName,
        size: data.length,
        mime: file.mimetype,
      };
      const noun = kind === "image" ? "an image" : kind === "video" ? "a video" : "a file";
      const content = `[Sent ${noun}: ${payload.name}]`;

      const historyResult = await db.query(
        `select sender, content from conversation_messages
         where conversation_id = $1 order by created_at desc limit 300`,
        [conversation.id],
      );
      const history = historyResult.rows
        .reverse()
        .map((row) => ({ role: row.sender as "buyer" | "student" | "teacher", content: row.content }));
      await db.query(
        `insert into conversation_messages (conversation_id, sender, content, kind, payload)
         values ($1, 'student', $2, $3, $4)`,
        [conversation.id, content, kind, JSON.stringify(payload)],
      );
      await streamBuyerTurn({
        db,
        gateway,
        request,
        reply,
        conversation,
        history: [...history, { role: "student", content }],
      });
    },
  );

  // 发送商品卡片 / 优惠券卡片 / 订单卡片给买家（买家以 SSE 流式回应）
  app.post<{ Params: { conversationId: string }; Body: { type?: string; refId?: string } }>(
    "/v1/conversations/:conversationId/cards",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const { type, refId } = request.body ?? {};
      const conversationResult = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2 and status = 'active'",
        [request.params.conversationId, user.sub],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权访问。" };
      }
      let kind: "product" | "coupon" | "order" | "invite";
      let payload: Record<string, unknown>;
      let content: string;
      if (type === "product" || type === "invite") {
        const productResult = await db.query("select * from store_products where id = $1 and enabled", [refId]);
        const row = productResult.rows[0];
        const product = row
          ? { id: row.id, name: row.name, spec: row.spec, price: Number(row.price), sales: row.sales, stock: row.stock, tone: row.tone, imageUrl: row.image_url ?? null }
          : undefined;
        if (!product) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "商品不存在。" };
        }
        kind = type;
        payload = { ...product };
        content =
          type === "product"
            ? `[Shared a product card] ${product.name} (SKU ${product.id}) · ${product.spec} · USD ${product.price}`
            : `[Sent an order invitation] Invited you to place an order for ${product.name} (SKU ${product.id}) · USD ${product.price}. You can order directly from this card.`;
      } else if (type === "order") {
        const orderResult = await db.query(
          "select id, payload from orders where id = $1 and student_id = $2 and conversation_id = $3",
          [refId, user.sub, conversation.id],
        );
        const row = orderResult.rows[0];
        if (!row) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "订单不存在。" };
        }
        const info = row.payload as OrderInfo;
        kind = "order";
        payload = {
          id: row.id,
          orderNo: info.orderNo,
          productName: info.productName,
          productSpec: info.productSpec,
          productImage: info.productImage ?? null,
          quantity: info.quantity,
          totalAmount: info.totalAmount,
          currency: info.currency,
          status: info.status,
          statusLabel: info.statusLabel,
          returnStatus: info.returnStatus ?? null,
          placedAt: info.placedAt,
        };
        content = `[Shared an order card] ${info.orderNo} · ${info.productName} ×${info.quantity} · status: ${info.statusLabel}`;
      } else if (type === "coupon") {
        const coupon = storeCoupons.find((item) => item.id === refId);
        if (!coupon) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "优惠券不存在。" };
        }
        kind = "coupon";
        payload = { ...coupon };
        content = `[Sent a coupon] ${coupon.title}（${coupon.rule}，有效期 ${coupon.validDays} 天）`;
      } else {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "卡片类型无效。" };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 对话服务。" };
      }

      const historyResult = await db.query(
        `select sender, content from conversation_messages
         where conversation_id = $1 order by created_at desc limit 300`,
        [conversation.id],
      );
      const history = historyResult.rows
        .reverse()
        .map((row) => ({ role: row.sender as "buyer" | "student" | "teacher", content: row.content }));
      await db.query(
        `insert into conversation_messages (conversation_id, sender, content, kind, payload)
         values ($1, 'student', $2, $3, $4)`,
        [conversation.id, content, kind, JSON.stringify(payload)],
      );
      await streamBuyerTurn({
        db,
        gateway,
        request,
        reply,
        conversation,
        history: [...history, { role: "student", content }],
      });
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/messages",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const owned = await db.query(
        "select 1 from conversations where id = $1 and student_id = $2",
        [request.params.conversationId, user.sub],
      );
      if (!owned.rowCount) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "无权查看该会话。" };
      }
      const result = await db.query(
        `select id, sender, content, kind, payload, translated_content, created_at from conversation_messages
         where conversation_id = $1 order by created_at`,
        [request.params.conversationId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        sender: row.sender,
        content: row.content,
        kind: row.kind ?? "text",
        payload: row.payload ?? null,
        translation: row.translated_content ?? undefined,
        createdAt: row.created_at,
      }));
    },
  );

  // 买家开场：会话尚无消息时，由 AI 买家主动发出第一条消息
  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/opening",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const conversationResult = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2 and status = 'active'",
        [request.params.conversationId, user.sub],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权访问。" };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 对话服务后再开始实训。" };
      }
      const existing = await db.query(
        "select 1 from conversation_messages where conversation_id = $1 limit 1",
        [conversation.id],
      );
      if (existing.rowCount) {
        reply.code(409);
        return { code: "ALREADY_OPENED", message: "会话已有消息。" };
      }
      await streamBuyerTurn({ db, gateway, request, reply, conversation, history: [] });
    },
  );

  // 学生发消息；defer=true 时只落库不触发买家回复（配合批量窗口实现客服连发多条）
  app.post<{ Params: { conversationId: string }; Body: { content?: string; defer?: boolean } }>(
    "/v1/conversations/:conversationId/messages",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const content = request.body?.content?.trim();
      if (!content) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "消息内容不能为空。" };
      }
      const conversationResult = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2 and status = 'active'",
        [request.params.conversationId, user.sub],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权访问。" };
      }
      if (request.body?.defer === true) {
        await db.query(
          `insert into conversation_messages (conversation_id, sender, content)
           values ($1, 'student', $2)`,
          [conversation.id, content],
        );
        return { ok: true };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return {
          code: "AI_PROVIDER_NOT_CONFIGURED",
          message: "请由管理员配置 LLM 对话服务后再开始实训。",
        };
      }

      const historyResult = await db.query(
        `select sender, content from conversation_messages
         where conversation_id = $1 order by created_at desc limit 300`,
        [conversation.id],
      );
      const history = historyResult.rows
        .reverse()
        .map((row) => ({ role: row.sender as "buyer" | "student" | "teacher", content: row.content }));

      await db.query(
        `insert into conversation_messages (conversation_id, sender, content)
         values ($1, 'student', $2)`,
        [conversation.id, content],
      );

      await streamBuyerTurn({
        db,
        gateway,
        request,
        reply,
        conversation,
        history: [...history, { role: "student", content }],
      });
    },
  );

  // 触发买家回应（批量窗口结束后调用：一次性回应学生连发的多条消息）
  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/reply",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const conversationResult = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2 and status = 'active'",
        [request.params.conversationId, user.sub],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        reply.code(403);
        return { code: "FORBIDDEN", message: "会话不存在或无权访问。" };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 对话服务。" };
      }
      const historyResult = await db.query(
        `select sender, content from conversation_messages
         where conversation_id = $1 order by created_at desc limit 300`,
        [conversation.id],
      );
      const history = historyResult.rows
        .reverse()
        .map((row) => ({ role: row.sender as "buyer" | "student" | "teacher", content: row.content }));
      const last = history[history.length - 1];
      if (!last || last.role !== "student") {
        reply.code(409);
        return { code: "NO_PENDING_MESSAGE", message: "暂无待回复的消息。" };
      }
      await streamBuyerTurn({ db, gateway, request, reply, conversation, history });
    },
  );
}
