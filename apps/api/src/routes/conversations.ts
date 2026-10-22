import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BusinessStage, OrderKind, ScenarioScript } from "@cecs/contracts";
import {
  averageReplySec,
  buyerHistoryOrderCount,
  composePersonaWithRule,
  computeCustomerTags,
  CONTACT_REASONS,
  deriveBuyerEmail,
  mailTemplateForScenario,
  suggestContactReason,
  NoMatchingPersonaError,
  ensurePersonaAvatar,
  generateBuyerOrderHistory,
  generateOrderForScenario,
  productFactSheet,
  replyWithinRate,
  toStudentPersonaView,
  type OrderInfo,
} from "@cecs/domain";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import type { CallInfo, LlmGateway } from "../llm/gateway";
import type { VoiceService } from "../voice/service";
import { resolveBuyerLanguage } from "../voice/buyer-language";
import {
  buildBuyerMessages,
  buildBuyerToolReactionMessages,
  buildChineseFixMessages,
  countAgentTurns,
  hasChineseLeak,
  TOOL_REACTION_NONE,
  TOOL_REACTION_PAID,
} from "../prompts/buyer";
import { loadEnabledPersonaTemplates } from "./catalog";
import { loadStoreProfile } from "./store";
import { once } from "../inflight";
import { loadBuyerOrders } from "../buyer-orders";
import { buildOutgoingTranslationMessages, buildTranslationMessages } from "../prompts/assist";
import { rateService } from "../service-rating";
import { loadEnabledCoupon } from "./coupons";
import { loadReceptionTimings, sumReplySummaries } from "../reception-stats";
import {
  endFollowUp,
  FOLLOWUP_MAX_TURNS,
  followUpActive,
  followUpOpen,
  isToolCardKind,
  paidOrder,
  toolCardContent,
  toolCardPayload,
  toolCardProblem,
  type ToolFollowUp,
} from "../tool-followup";

interface ConversationRow {
  id: string;
  task_id: string | null;
  student_id: string;
  scenario_id: string | null;
  persona: Record<string, unknown>;
  state?: Record<string, unknown> | null;
  status: string;
  created_at: string;
  /** 工具跟进（D-56），见 tool-followup.ts */
  tool_followup?: ToolFollowUp | null;
  channel?: string;
}

type LogLike = { error: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };

/** 跟进开始后客服回了几轮（连发的几条算一轮） */
async function followUpAgentTurns(db: Db, conversationId: string, startedAt: string): Promise<number> {
  const rows = await db.query(
    "select sender from conversation_messages where conversation_id = $1 and created_at > $2 and sender <> 'teacher' order by created_at, id",
    [conversationId, startedAt],
  );
  return countAgentTurns(rows.rows.map((row) => ({ role: row.sender as string })));
}

const STREAM_TIMEOUT_MS = 60_000;

/** 买家离场标记：模型在告别消息末尾输出，服务端剥离并自动结束会话 */
const END_MARK = "[END_OF_SERVICE]";
/** 买家连发分隔符：一轮回复拆成多条短消息（拟真聊天节奏） */
const SPLIT_MARK = "|||";

/** 漏中文改写最多试几次：flash 偶尔原样吐回来，再试一次通常就改掉了 */
const CHINESE_FIX_ATTEMPTS = 2;

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

/**
 * 生成一轮买家回复，落库消息与验收指标。
 * 带 request / reply 时以 SSE 流式推给前端；不带时在后台生成（订单页发工具卡片时没有聊天窗口在等），
 * 后台生成不是“有效对话请求”，不记验收指标。
 */
async function streamBuyerTurn(options: {
  db: Db;
  gateway: LlmGateway;
  request?: FastifyRequest;
  reply?: FastifyReply;
  log?: LogLike;
  conversation: ConversationRow;
  history: Array<{ role: "buyer" | "student" | "teacher"; content: string }>;
}): Promise<{ closed: boolean }> {
  const { db, gateway, request, reply, conversation, history } = options;
  const log: LogLike = request?.log ?? options.log ?? console;
  // B2：首字耗时从收到请求那一刻算起（含查库、组装上下文），不是从调用模型时算
  const receivedAt = request ? new Date(request.receivedAt) : new Date();
  const scene = await loadScene(db, conversation.scenario_id);
  const orders = await loadBuyerOrders(db, conversation.id);
  // 工具跟进（D-56）：买家知道这是短跟进，客服回满 3 轮后这一条收尾
  const followUp = followUpActive(conversation.tool_followup) ? conversation.tool_followup : null;
  const followUpTurns = followUp ? await followUpAgentTurns(db, conversation.id, followUp.startedAt) : 0;

  const raw = reply && request ? reply.raw : null;
  if (reply && request) {
    reply.hijack();
    // 跨域头沿用 @fastify/cors 已按白名单算好的（hijack 后不会自动写出），不再无条件回写请求的 Origin（F 节）
    const presetHeaders = Object.fromEntries(
      Object.entries(reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined),
    );
    reply.raw.writeHead(200, {
      ...presetHeaders,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  }
  const send = (payload: Record<string, unknown>) => {
    raw?.write(`data: ${JSON.stringify(payload)}\n\n`);
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
    orderSnapshot: orders.primary ?? {},
    pastOrders: orders.past,
    history,
    startedAt: conversation.created_at,
    followUp: followUp ? { kind: followUp.kind, agentTurns: followUpTurns, maxTurns: FOLLOWUP_MAX_TURNS } : null,
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
      log.error({ err: error, attempt }, "llm stream failed");
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
  const completedAt = new Date();

  // 漏中文兜底：改写后再落库，done 事件带上改好的内容，前端替换刚流出来的气泡
  const buyerLanguage = conversation.persona.language as string | undefined;
  let corrected = false;
  if (outcome === "success" && hasChineseLeak(buyerReply, buyerLanguage)) {
    for (let attempt = 1; attempt <= CHINESE_FIX_ATTEMPTS && !corrected; attempt += 1) {
      try {
        const { text } = await gateway.complete("assist", buildChineseFixMessages(buyerReply, buyerLanguage), {
          conversationId: conversation.id,
          temperature: 0.2,
        });
        const fixed = text.replace(END_MARK, "").trim();
        if (fixed && !hasChineseLeak(fixed, buyerLanguage)) {
          buyerReply = fixed;
          corrected = true;
        }
      } catch (error) {
        log.error({ err: error, conversationId: conversation.id, attempt }, "buyer chinese fix failed");
      }
    }
    if (!corrected) log.warn({ conversationId: conversation.id }, "buyer reply still has chinese after fix");
  }

  // 按 ||| 拆成多条短消息分行落库（拟真买家连发；回放/教师端同样逐条展示）
  const segments = buyerReply
    .split(SPLIT_MARK)
    .map((part) => part.trim())
    .filter(Boolean);
  const totalChars = segments.reduce((sum, part) => sum + part.length, 0);

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
  if (raw) await db.query(
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

  // 买家离开：自动结束会话并触发评分（真实规则：只有客户会主动断开）
  let conversationClosed = false;
  if (followUp && outcome === "success") {
    // 跟进：买家收尾离开，或客服已回满 3 轮（这一条是买家的收尾），跟进结束；不评分、不打星、不留评
    if (buyerLeft || followUpTurns >= FOLLOWUP_MAX_TURNS) {
      conversationClosed = await endFollowUp(db, conversation.id, buyerLeft ? "buyer_left" : "turn_limit");
    }
  } else if (buyerLeft && outcome === "success") {
    const closed = await db.query(
      "update conversations set status = 'closed', closed_reason = 'buyer_left', closed_at = now() where id = $1 and status = 'active' returning id",
      [conversation.id],
    );
    if (closed.rowCount) {
      conversationClosed = true;
      await rateService(db, conversation.id).catch((error) => log.error(error, "service rating failed"));
      const { assessConversation } = await import("../assessment");
      void assessConversation(db, gateway, conversation.id).catch((error) =>
        log.error(error, "assessment failed"),
      );
      // 闭环评价：买家按本次服务结果留评/改评（异步，不阻塞）
      const { generateBuyerReview } = await import("../review-gen");
      void generateBuyerReview(db, gateway, conversation.id, log).catch((error) =>
        log.error(error, "buyer review failed"),
      );
    }
  }

  // 后台观察员（D-50）：异步评估学生表现与买家满意度，只给教师端、评分和催促用，不回写买家（不阻塞响应）。
  // 跟进不评估：原来那次的满意度和走势留给教师端、评分
  if (outcome === "success" && !conversationClosed && !followUp && history.some((item) => item.role === "student")) {
    void import("../director")
      .then(({ runDirector }) => runDirector(db, gateway, conversation.id))
      .catch((error) => log.error(error, "director failed"));
  }

  const durationSeconds = firstCharAt
    ? Math.max((completedAt.getTime() - firstCharAt.getTime()) / 1000, 0.001)
    : 0;
  send({
    type: outcome === "success" ? "done" : "error",
    messageId: buyerMessageId,
    closed: conversationClosed,
    ...(corrected ? { segments } : {}),
    metrics: {
      ttftMs: firstCharAt ? firstCharAt.getTime() - receivedAt.getTime() : null,
      validChars: totalChars,
      charsPerSecond: firstCharAt ? Math.round(totalChars / durationSeconds) : 0,
      outcome,
    },
  });
  raw?.end();
  return { closed: conversationClosed };
}

/**
 * 会话已结束时收到工具卡片（D-56）：买家看了卡片自己决定回复、直接付款或不理。
 * 回复了就开始跟进（会话回到进行中）；付款了把订单改成已付款；后台执行，失败只记日志。
 */
async function buyerReactToToolCard(db: Db, gateway: LlmGateway, conversationId: string, log: LogLike): Promise<void> {
  const conversationResult = await db.query<ConversationRow>("select * from conversations where id = $1", [conversationId]);
  const conversation = conversationResult.rows[0];
  const followUp = conversation?.tool_followup;
  if (!conversation || conversation.status !== "closed" || !followUp || followUp.startedAt || followUp.endedAt) return;
  const scene = await loadScene(db, conversation.scenario_id);
  const orders = await loadBuyerOrders(db, conversation.id);
  const historyRows = await db.query(
    "select sender, content from conversation_messages where conversation_id = $1 order by created_at desc, id desc limit 300",
    [conversation.id],
  );
  const history = historyRows.rows.reverse().map((row) => ({ role: row.sender as "buyer" | "student" | "teacher", content: row.content as string }));
  const { text } = await gateway.complete(
    "dialogue",
    buildBuyerToolReactionMessages(
      {
        scenePrompt: scene.prompt,
        script: scene.script,
        personaSnapshot: conversation.persona,
        orderSnapshot: orders.primary ?? {},
        pastOrders: orders.past,
        history,
        startedAt: conversation.created_at,
      },
      followUp.kind,
    ),
    { conversationId: conversation.id },
  );
  const paid = followUp.kind === "payment_reminder" && text.includes(TOOL_REACTION_PAID);
  const left = text.includes(END_MARK);
  let content = text
    .replace(TOOL_REACTION_PAID, "")
    .replace(TOOL_REACTION_NONE, "")
    .replace(END_MARK, "")
    .split(SPLIT_MARK)
    .map((part) => part.trim())
    .find(Boolean) ?? "";
  const language = conversation.persona.language as string | undefined;
  if (content && hasChineseLeak(content, language)) {
    const fixed = (await gateway.complete("assist", buildChineseFixMessages(content, language), { conversationId, temperature: 0.2 })).text.trim();
    content = fixed && !hasChineseLeak(fixed, language) ? fixed : "";
  }
  if (paid) {
    const order = await db.query("select payload from orders where id = $1", [followUp.orderId]);
    const info = order.rows[0]?.payload as OrderInfo | undefined;
    if (info && info.status === "pending_payment") {
      await db.query("update orders set status = 'paid', payload = $2 where id = $1", [followUp.orderId, JSON.stringify(paidOrder(info))]);
    }
  }
  if (!content) {
    await db.query(
      `update conversations set tool_followup = tool_followup || jsonb_build_object('endedAt', now(), 'endReason', $2::text)
       where id = $1 and status = 'closed'`,
      [conversationId, paid ? "paid" : "no_reply"],
    );
    log.info(`tool card ${followUp.kind}: buyer ${paid ? "paid without replying" : "did not reply"} (${conversationId})`);
    return;
  }
  await db.query("insert into conversation_messages (conversation_id, sender, content) values ($1, 'buyer', $2)", [conversationId, content]);
  if (paid || left) {
    await db.query(
      `update conversations set tool_followup = tool_followup || jsonb_build_object('endedAt', now(), 'endReason', $2::text)
       where id = $1 and status = 'closed'`,
      [conversationId, paid ? "paid" : "buyer_left"],
    );
    return;
  }
  // 买家回复了：跟进开始，会话回到进行中（结束原因、结束时间、星级、成绩都保留原样）
  await db.query(
    `update conversations set status = 'active', tool_followup = tool_followup || jsonb_build_object('startedAt', now())
     where id = $1 and status = 'closed'`,
    [conversationId],
  );
}

/** 客服在接待中的标记（C2）：系统客户标签只读，咨询原因 / 待跟进 / 客户备注由学生写 */
function serviceMetaOf(
  row: Record<string, unknown>,
  orders: OrderInfo[],
  tiers: Parameters<typeof computeCustomerTags>[2],
) {
  const persona = (row.persona ?? {}) as { customerType?: string };
  const orderTotals = orders.map((order) => ({
    totalAmount: order.totalAmount,
    placedAt: order.placedAt,
    status: order.status,
  }));
  const paid = orderTotals.filter((order) => order.status !== "pending_payment");
  return {
    customerTags: computeCustomerTags(persona.customerType, orderTotals, tiers),
    orderStats: {
      count: paid.length,
      total: Math.round(paid.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0) * 100) / 100,
      lastPlacedAt: paid.length ? paid.map((order) => order.placedAt).sort().at(-1) ?? null : null,
    },
    contactReason: (row.contact_reason as string | null) ?? null,
    /* 老会话没存预填值时按场景现算 */
    contactReasonSuggested:
      (row.contact_reason_suggested as string | null) ??
      suggestContactReason(row.scenario_name as string | null, row.scenario_stage as string | null),
    followUp: Boolean(row.follow_up),
    buyerNote: (row.buyer_note as string | null) ?? null,
    buyerNoteAt: (row.buyer_note_at as string | null) ?? null,
    closedReason: (row.closed_reason as string | null) ?? null,
  };
}

export function registerConversationRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
  gateway: LlmGateway,
  voice: VoiceService,
): void {
  /** 邮件会话（D-58）给写信框用的信息：收件人、建议模板、客户标签和历史订单 */
  async function mailConversationView(conversation: ConversationRow, scenario: { id: string; name: string; objective: string }) {
    const orderRows = await db.query("select payload from orders where conversation_id = $1", [conversation.id]);
    const store = await loadStoreProfile(db);
    const meta = serviceMetaOf(conversation as unknown as Record<string, unknown>, orderRows.rows.map((row) => row.payload as OrderInfo), store.tiers);
    const persona = ensurePersonaAvatar(conversation.persona as never, conversation.id);
    const name = String(conversation.persona.name ?? "Customer");
    return {
      id: conversation.id,
      taskId: conversation.task_id,
      channel: "mail" as const,
      scenario: { id: scenario.id, name: scenario.name, objective: scenario.objective },
      buyer: toStudentPersonaView(persona),
      order: null,
      createdAt: conversation.created_at,
      mail: {
        to: deriveBuyerEmail(name, conversation.id),
        toName: name,
        templateId: mailTemplateForScenario(scenario.name).id,
        customerTags: meta.customerTags,
        orderStats: meta.orderStats,
      },
    };
  }

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
          `select t.scenario_ids, t.persona_rule, t.start_at, t.deadline, t.status from task_progress tp
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
        if (row.status !== "published" || (row.deadline && new Date(row.deadline).getTime() < Date.now())) {
          reply.code(403);
          return { code: "TASK_CLOSED", message: "这个任务已经结束或过了截止时间，不能再接待新的买家。" };
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

      let scenario: { id: string; name: string; objective: string; stage: BusinessStage; orderKind: OrderKind | null; channel: string } | null = null;
      if (resolvedScenarioId) {
        const result = await db.query(
          "select id, name, objective, stage, order_kind as \"orderKind\", coalesce(channel, 'chat') as channel from scenarios where id = $1 and enabled",
          [resolvedScenarioId],
        );
        scenario = result.rows[0] ?? null;
        if (!scenario) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "场景不存在或未启用。" };
        }
      }
      /* 邮件类场景（D-58）：只在任务里按邮件下发；同一任务同一场景还没发出的邮件会话接着用（收件人不变） */
      const channel = scenario?.channel === "mail" ? "mail" : "chat";
      if (channel === "mail") {
        if (!taskId) {
          reply.code(400);
          return { code: "MAIL_SCENARIO_NEEDS_TASK", message: "邮件类场景请在任务里完成。" };
        }
        const existing = await db.query<ConversationRow>(
          `select * from conversations where task_id = $1 and student_id = $2 and scenario_id = $3 and channel = 'mail' and status = 'active'
           order by created_at desc limit 1`,
          [taskId, user.sub, resolvedScenarioId],
        );
        if (existing.rows[0]) return mailConversationView(existing.rows[0], scenario!);
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
      // 买家语言（D-43）：国籍母语，朗读做不到就改英语；任务规则明确指定语言时尊重规则
      persona.language = await resolveBuyerLanguage(
        voice,
        { language: persona.language, nationality: persona.nationality as string, gender: persona.gender },
        Array.isArray(personaRule.languages) && personaRule.languages.length > 0,
      );
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
      const store = await loadStoreProfile(db);
      personaRecord.storeName = store.name;
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
        `insert into conversations (task_id, student_id, scenario_id, persona, contact_reason_suggested, channel)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [taskId ?? null, user.sub, resolvedScenarioId, JSON.stringify(persona), suggestContactReason(scenario?.name, scenario?.stage), channel],
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
      // 历史订单不抽这次咨询的商品：否则会出现“刚在店里看到这条裙子想批发”却“上个月买过两条正在退货”的矛盾
      const consulting = new Set([order?.productName, (personaRecord.interestedProduct as { name?: string } | undefined)?.name].filter(Boolean));
      const historyPool = productPool.filter((item) => !consulting.has(item.name));
      const historyOrders = generateBuyerOrderHistory(
        buyerHistoryOrderCount(persona.customerType as string, Math.random),
        Math.random,
        new Date(),
        historyPool.length > 0 ? historyPool : productPool,
        personaBrief,
      );
      for (const item of historyOrders) await insertOrder(item, false);
      if (channel === "mail") return mailConversationView(conversation, scenario!);

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
         where c.student_id = $1 and c.status = $2 and c.channel = 'chat'
         order by coalesce(lm.created_at, c.created_at) desc limit 30`,
        [user.sub, status],
      );
      const ids = result.rows.map((row) => row.id as string);
      const orderRows = ids.length
        ? await db.query("select conversation_id, payload from orders where conversation_id = any($1)", [ids])
        : { rows: [] as Array<Record<string, unknown>> };
      const ordersByConversation = new Map<string, OrderInfo[]>();
      for (const item of orderRows.rows) {
        const key = item.conversation_id as string;
        ordersByConversation.set(key, [...(ordersByConversation.get(key) ?? []), item.payload as OrderInfo]);
      }
      const store = await loadStoreProfile(db);
      return result.rows.map((row) => ({
        ...serviceMetaOf(row, ordersByConversation.get(row.id as string) ?? [], store.tiers),
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
        closedAt: row.closed_at ?? null,
        /* 服务评价 1–5 星（D-54），没结束或买家没说过话时为空 */
        serviceRating: row.service_rating == null ? null : Number(row.service_rating),
        /* 工具跟进（D-56）：进行中时界面按跟进处理（不计时、不计分），结束后在聊天末尾显示“跟进结束” */
        toolFollowUp: row.tool_followup ?? null,
      }));
    },
  );

  // 文本翻译（评价、邮件正文的中文译文）。同一段文字只翻一次，译文存库（text_translations），之后直接读取
  /** 输入框翻译的目标语言（客服把中文译成买家的语言） */
  const TARGET_LANGUAGES: Record<string, string> = {
    en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
    ru: "Russian", ja: "Japanese", ko: "Korean", ar: "Arabic",
  };
  app.post<{ Body: { text?: string; target?: string } }>(
    "/v1/translate",
    { preHandler: guard.requireRole("student", "teacher") },
    async (request, reply) => {
      const text = typeof request.body?.text === "string" ? request.body.text.trim().slice(0, 4000) : "";
      if (!text) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "没有要翻译的内容。" };
      }
      // 不传 target = 译成中文（评价、邮件正文）；传了 = 输入框外译成买家的语言
      const target = request.body?.target && request.body.target !== "zh" ? request.body.target : null;
      if (target && !TARGET_LANGUAGES[target]) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "不支持这种语言。" };
      }
      const textHash = createHash("sha256").update(target ? `${target}|${text}` : text).digest("hex");
      const stored = await db.query("select translation from text_translations where text_hash = $1", [textHash]);
      if (stored.rowCount) return { translation: stored.rows[0].translation as string, cached: true };
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 服务。" };
      }
      try {
        const translation = await once(`translate:${textHash}`, async () => {
          const { text: result } = await gateway.complete(
            "assist",
            target ? buildOutgoingTranslationMessages(text, TARGET_LANGUAGES[target]!) : buildTranslationMessages(text),
          );
          await db.query(
            "insert into text_translations (text_hash, source, translation) values ($1, $2, $3) on conflict (text_hash) do nothing",
            [textHash, text, result],
          );
          return result;
        });
        return { translation, cached: false };
      } catch (error) {
        request.log.error(error, "translate failed");
        reply.code(502);
        return { code: "TRANSLATE_FAILED", message: "翻译失败，请稍后重试。" };
      }
    },
  );

  // 客服标记：咨询原因（确认或改正系统预填）、待跟进、客户备注。会话结束后仍可补记
  app.patch<{ Params: { conversationId: string }; Body: { contactReason?: string | null; followUp?: boolean; buyerNote?: string | null } }>(
    "/v1/conversations/:conversationId/service-meta",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const body = request.body ?? {};
      const sets: string[] = [];
      const params: unknown[] = [request.params.conversationId, user.sub];
      if (body.contactReason !== undefined) {
        if (body.contactReason !== null && !(CONTACT_REASONS as readonly string[]).includes(body.contactReason)) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "咨询原因不在可选范围内。" };
        }
        params.push(body.contactReason);
        sets.push(`contact_reason = $${params.length}`);
      }
      if (body.followUp !== undefined) {
        params.push(Boolean(body.followUp));
        sets.push(`follow_up = $${params.length}`);
      }
      if (body.buyerNote !== undefined) {
        params.push(typeof body.buyerNote === "string" && body.buyerNote.trim() ? body.buyerNote.trim().slice(0, 500) : null);
        sets.push(`buyer_note = $${params.length}`, "buyer_note_at = now()");
      }
      if (!sets.length) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "没有要保存的内容。" };
      }
      const result = await db.query(
        `update conversations set ${sets.join(", ")} where id = $1 and student_id = $2
         returning contact_reason, contact_reason_suggested, follow_up, buyer_note, buyer_note_at`,
        params,
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "会话不存在。" };
      }
      const row = result.rows[0]!;
      return {
        contactReason: row.contact_reason ?? null,
        contactReasonSuggested: row.contact_reason_suggested ?? null,
        followUp: Boolean(row.follow_up),
        buyerNote: row.buyer_note ?? null,
        buyerNoteAt: row.buyer_note_at ?? null,
      };
    },
  );

  // 学生客服指标：今日接待/平均响应/未回复/3 分钟回复率/满意率（今天 4–5 星占比）/询单支付金额/付款人数/询单转化率
  app.get(
    "/v1/student/workbench-stats",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const [today, unreplied, todayChats, satisfaction, paid] = await Promise.all([
        db.query(
          `select count(*) as n from conversations
           where student_id = $1 and channel = 'chat' and created_at::date = current_date`,
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
        // 平均响应、3 分钟回复率（D-61）：今天有买家发言的聊天接待，只算今天开始的轮次；和我的记录、复盘同一套算法
        db.query(
          `select c.id, (extract(epoch from date_trunc('day', now())) * 1000)::bigint as day_start from conversations c
           where c.student_id = $1 and c.channel = 'chat' and exists (
             select 1 from conversation_messages m
             where m.conversation_id = c.id and m.sender = 'buyer' and m.created_at >= date_trunc('day', now()))`,
          [user.sub],
        ),
        // 满意率（D-54）：今天结束的接待里，买家服务评价 4–5 星的占比
        db.query(
          `select count(*) filter (where service_rating >= 4)::int as satisfied, count(*)::int as rated from conversations
           where student_id = $1 and service_rating is not null and closed_at::date = current_date`,
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
      const dayStart = todayChats.rows.length ? Number(todayChats.rows[0].day_start) : Date.now();
      const replies = sumReplySummaries((await loadReceptionTimings(db, todayChats.rows.map((row) => row.id as string))).values(), dayStart);
      const todayCount = Number(today.rows[0]?.n ?? 0);
      const rated = Number(satisfaction.rows[0]?.rated ?? 0);
      const paidBuyers = Number(paid.rows[0]?.buyers ?? 0);
      return {
        todayConversations: todayCount,
        unreplied: Number(unreplied.rows[0]?.n ?? 0),
        avgResponseSeconds: averageReplySec(replies),
        replyWithinRate: replyWithinRate(replies),
        satisfactionRate: rated > 0 ? Math.round((Number(satisfaction.rows[0]?.satisfied ?? 0) / rated) * 100) : null,
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
      const owned = await db.query<ConversationRow>(
        "select * from conversations where id = $1 and student_id = $2 and status = 'active'",
        [request.params.conversationId, user.sub],
      );
      if (!owned.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "会话不存在或已关闭。" };
      }
      if (followUpActive(owned.rows[0]!.tool_followup)) {
        await endFollowUp(db, request.params.conversationId, "student_ended");
        return { ok: true };
      }
      const result = await db.query(
        `update conversations set status = 'closed', closed_reason = 'student_ended', closed_at = now()
         where id = $1 and student_id = $2 and status = 'active' returning id`,
        [request.params.conversationId, user.sub],
      );
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "会话不存在或已关闭。" };
      }
      await rateService(db, request.params.conversationId).catch((error) => request.log.error(error, "service rating failed"));
      // 后台异步评分，不阻塞关闭
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
        const translation = await once(`message-translate:${message.id}`, async () => {
          const { text: result } = await gateway.complete("assist", buildTranslationMessages(message.content));
          await db.query("update conversation_messages set translated_content = $1 where id = $2", [result, message.id]);
          return result;
        });
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
        nationality?: string;
        sourceTemplateId?: string;
        name?: string;
      };
      const { resolvePersonaGender } = await import("@cecs/domain");
      const gender = resolvePersonaGender(persona);
      // 音色池（D-42）：语种 → 厂商 → 音色，同一买家固定同一个声音
      const selection = await voice.selectVoice({ ...persona, gender }, gender);
      if (!selection) {
        reply.code(503);
        return { code: "TTS_NOT_CONFIGURED", message: "语音服务未配置。" };
      }
      const path = await import("node:path");
      const fs = await import("node:fs");
      const { VOICE_VENDORS } = await import("../voice/service");
      const { VoiceSynthesisError } = await import("../voice/fallback");
      // 缓存文件名带实际使用的厂商和音色 id：换音色不串音
      const nameOf = (item: { voice: { vendor: string; id: string } }) =>
        `${message.id}-${item.voice.vendor}-${item.voice.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.${VOICE_VENDORS[item.voice.vendor]!.audioExt}`;
      const resolveTarget = (name: string) => path.resolve(process.cwd(), "uploads", "tts", name);
      // 主音色和备用音色（阿里云转豆包后落盘的就是备用文件）任一已有缓存就直接用，不再请求阿里云
      const cacheNames = [nameOf(selection), ...(selection.fallback ? [nameOf(selection.fallback)] : [])];
      const cachedName = cacheNames.find((name) => fs.existsSync(resolveTarget(name)));
      if (cachedName) return { audioUrl: `/uploads/tts/${cachedName}`, cached: true };
      try {
        // 自动播报和手动点击可能同时到：同一条消息只合成一次
        const { elapsedMs, fresh, fileName } = await once(`tts:${cacheNames[0]}`, async () => {
          const existing = cacheNames.find((name) => fs.existsSync(resolveTarget(name)));
          if (existing) return { elapsedMs: 0, fresh: false, fileName: existing };
          const spoken = await voice.synthesizeWith(selection, message.content.slice(0, 500), (text, meta) => request.log.warn(meta, text));
          const name = nameOf({ voice: { vendor: spoken.vendor, id: spoken.voiceId } });
          const target = resolveTarget(name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, spoken.audio);
          await db.query(
            "insert into voice_metrics (kind, elapsed_ms, chars, outcome, vendor, fallback, fallback_reason) values ('tts', $1, $2, 'success', $3, $4, $5)",
            [spoken.elapsedMs, message.content.length, spoken.vendor, Boolean(spoken.fallback), spoken.fallbackReason ?? null],
          );
          return { elapsedMs: spoken.elapsedMs, fresh: true, fileName: name };
        });
        return { audioUrl: `/uploads/tts/${fileName}`, cached: !fresh, elapsedMs };
      } catch (error) {
        const failure = error instanceof VoiceSynthesisError ? error : null;
        await db.query(
          "insert into voice_metrics (kind, elapsed_ms, chars, outcome, vendor, fallback, fallback_reason) values ('tts', 0, $1, 'error', $2, $3, $4)",
          [message.content.length, failure?.vendor ?? selection.voice.vendor, Boolean(failure?.fallbackReason), failure?.fallbackReason ?? null],
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
        const coupon = refId ? await loadEnabledCoupon(db, refId) : null;
        if (!coupon) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "这张优惠券不存在或已经停用。" };
        }
        kind = "coupon";
        // 存快照：之后改券、删券，老聊天里的卡片照原样显示（D-66）
        payload = { id: coupon.id, title: coupon.title, rule: coupon.rule, scope: coupon.scope, validDays: coupon.validDays, customerTypes: coupon.customerTypes };
        content = `[Sent a coupon] ${coupon.title}（${coupon.rule}，${coupon.scope}，有效期 ${coupon.validDays} 天）`;
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

  /**
   * 订单页工具卡片（D-56）：付款提醒 / 物流通知。
   * 会话进行中：卡片进当前聊天，买家在后台回复（工作台轮询会刷出来）；
   * 会话已结束：卡片记在原会话里，买家看了自己决定回复、付款或不理，回复了就开始 2–3 轮的跟进
   */
  app.post<{ Params: { orderId: string }; Body: { kind?: string; text?: string } }>(
    "/v1/orders/:orderId/tool-cards",
    { preHandler: guard.requireRole("student") },
    async (request, reply) => {
      const user = request.user!;
      const kind = request.body?.kind;
      const text = typeof request.body?.text === "string" ? request.body.text.trim().slice(0, 1000) : "";
      if (!isToolCardKind(kind) || !text) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请选择卡片类型并填写话术。" };
      }
      const found = await db.query(
        "select o.id as order_id, o.payload as order_payload, o.conversation_id from orders o where o.id = $1 and o.student_id = $2",
        [request.params.orderId, user.sub],
      );
      const orderRow = found.rows[0];
      if (!orderRow) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "订单不存在。" };
      }
      const info = orderRow.order_payload as OrderInfo;
      const problem = toolCardProblem(kind, info);
      if (problem) {
        reply.code(409);
        return { code: "TOOL_NOT_APPLICABLE", message: problem };
      }
      if (!gateway.isConfigured()) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 对话服务。" };
      }
      const conversation = (await db.query<ConversationRow>("select * from conversations where id = $1", [orderRow.conversation_id])).rows[0];
      if (!conversation || conversation.channel !== "chat") {
        reply.code(409);
        return { code: "TOOL_NOT_APPLICABLE", message: "这笔订单没有可以联系的聊天。" };
      }
      const open = followUpOpen(conversation.tool_followup) ? conversation.tool_followup : null;
      if (open && (conversation.status === "closed" || (open.kind === kind && open.orderId === orderRow.order_id))) {
        reply.code(409);
        return {
          code: "TOOL_FOLLOWUP_OPEN",
          message: conversation.status === "closed" ? "买家还没看上一张卡片，稍后再发。" : "这张订单刚发过同样的卡片，等这段跟进结束后再发。",
        };
      }
      const content = toolCardContent(kind, info, text);
      const payload = toolCardPayload(kind, orderRow.order_id, info, text);
      const historyResult = await db.query(
        "select sender, content from conversation_messages where conversation_id = $1 order by created_at desc limit 300",
        [conversation.id],
      );
      const history = historyResult.rows.reverse().map((row) => ({ role: row.sender as "buyer" | "student" | "teacher", content: row.content as string }));
      await db.query(
        "insert into conversation_messages (conversation_id, sender, content, kind, payload) values ($1, 'student', $2, $3, $4)",
        [conversation.id, content, kind, JSON.stringify(payload)],
      );
      if (conversation.status === "active") {
        void streamBuyerTurn({ db, gateway, log: request.log, conversation, history: [...history, { role: "student", content }] }).catch((error) =>
          request.log.error(error, "buyer reply to tool card failed"),
        );
        return { delivered: "live", conversationId: conversation.id };
      }
      const followUp: ToolFollowUp = { kind, orderId: orderRow.order_id, sentAt: new Date().toISOString() };
      await db.query("update conversations set tool_followup = $2 where id = $1 and status = 'closed'", [conversation.id, JSON.stringify(followUp)]);
      void buyerReactToToolCard(db, gateway, conversation.id, request.log).catch((error) => request.log.error(error, "buyer reaction to tool card failed"));
      return { delivered: "closed", conversationId: conversation.id };
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
