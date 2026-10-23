import { applyWaitPenalty, patienceAction, patienceFactor, recordExit, type BuyerLedger } from "@cecs/domain";
import type { ScenarioScript } from "@cecs/contracts";
import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import { buildBuyerNudgeMessages, buildChineseFixMessages, countAgentTurns, hasChineseLeak } from "./prompts/buyer";
import { stripBuyerNotes } from "./prompts/buyer-note";
import { saveLedger } from "./buyer-ledger";
import { once } from "./inflight";
import { loadBuyerOrders } from "./buyer-orders";
import { assessConversation } from "./assessment";
import { generateBuyerReview } from "./review-gen";
import { updateSessionState, type SessionState } from "./director";
import { rateService } from "./service-rating";
import { endFollowUp, followUpActive } from "./tool-followup";

/**
 * 买家耐心（D-40）：买家最后一条消息之后客服一直没回，约 2 / 5 分钟催促，约 10 分钟留言离开（buyer_left）。
 * 时间点按画像倍率缩放（patienceFactor）；催促和离开的话术都由模型生成，模型未配置时不催也不离开（不用固定话术）。
 * 催促记录存 conversations.state.nudge：以“买家原消息时间”为起点计时，催促消息本身不重置计时。
 * 两本账（D-90）：每催一次耐心减 1、复盘记“回得太慢”；等不到回复离开算失望离开（星级最多 2 星）。
 */
export interface NudgeState {
  /** 计时起点（买家原消息时间，ISO） */
  baseAt: string;
  count: number;
  /** 最近一条消息 id；它变了说明有人发过言（客服回复 / 新买家消息），计时重新开始 */
  lastMessageId: string;
}

/** 催促后满意度下降量：第 1 次 / 第 2 次 */
const SATISFACTION_DROP = [8, 12];

type LogLike = { error: (obj: unknown, msg?: string) => void; info: (msg: string) => void; warn: (msg: string) => void };

export async function sweepBuyerPatience(db: Db, gateway: LlmGateway, log: LogLike): Promise<number> {
  if (!gateway.isConfigured("dialogue")) return 0;
  // 最后一条非教师消息是买家发的、会话进行中；取最后消息 id 与时间
  const result = await db.query(
    `select c.id, c.persona, c.state, c.scenario_id, c.created_at, c.tool_followup, c.buyer_ledger, last.id as last_id, last.created_at as last_at
     from conversations c
     join lateral (
       select m.id, m.sender, m.created_at from conversation_messages m
       where m.conversation_id = c.id and m.sender <> 'teacher'
       order by m.created_at desc, m.id desc limit 1
     ) last on true
     where c.status = 'active' and last.sender = 'buyer'`,
  );
  let acted = 0;
  for (const row of result.rows) {
    const state = (row.state ?? {}) as SessionState & { nudge?: NudgeState };
    const previous = state.nudge && state.nudge.lastMessageId === row.last_id ? state.nudge : null;
    const baseAt = previous?.baseAt ?? new Date(row.last_at).toISOString();
    const count = previous?.count ?? 0;
    const waitedMinutes = (Date.now() - new Date(baseAt).getTime()) / 60_000;
    const persona = (row.persona ?? {}) as Record<string, unknown>;
    // 当前情绪（后台观察员评估）优先于初始情绪
    const factor = patienceFactor({ emotion: state.emotion ?? persona.emotion, personality: persona.personality });
    const action = patienceAction(waitedMinutes, count, factor);
    if (!action) continue;
    const ok = await once(`nudge:${row.id}`, () =>
      runNudge(db, gateway, row, { baseAt, count, waitedMinutes, leaving: action === "leave" }, log),
    ).catch((error) => {
      log.error(error, "buyer nudge failed");
      return false;
    });
    if (ok) acted += 1;
  }
  return acted;
}

async function runNudge(
  db: Db,
  gateway: LlmGateway,
  row: Record<string, any>,
  step: { baseAt: string; count: number; waitedMinutes: number; leaving: boolean },
  log: LogLike,
): Promise<boolean> {
  const scenario = row.scenario_id
    ? (await db.query("select name, objective, script from scenarios where id = $1", [row.scenario_id])).rows[0]
    : null;
  const orders = await loadBuyerOrders(db, row.id);
  // 和实时回复一样看完整聊天（D-50），催的话才贴着刚才聊到的地方
  const historyRows = await db.query(
    "select sender, content from conversation_messages where conversation_id = $1 order by created_at desc, id desc limit 300",
    [row.id],
  );
  const history = (historyRows.rows.reverse() as Array<{ sender: "buyer" | "student" | "teacher"; content: string }>).map((m) => ({
    role: m.sender,
    content: m.content,
  }));
  const messages = buildBuyerNudgeMessages({
    context: {
      scenePrompt: scenario ? `${scenario.name}：${scenario.objective}` : "General customer service conversation.",
      script: (scenario?.script as ScenarioScript | null) ?? null,
      personaSnapshot: row.persona ?? {},
      orderSnapshot: orders.primary ?? {},
      pastOrders: orders.past,
      history,
      startedAt: row.created_at,
    },
    waitedMinutes: step.waitedMinutes,
    nudgeIndex: step.count + 1,
    leaving: step.leaving,
  });
  const { text } = await gateway.complete("dialogue", messages, { conversationId: row.id });
  // 催促的提示词里没有账，不会写判断；万一写了照样清掉
  let content = stripBuyerNotes(text).text
    .replace("[END_OF_SERVICE]", "")
    .split("|||")
    .map((part) => part.trim())
    .find(Boolean);
  if (!content) return false;
  // 漏中文兜底（同实时回复）：改写失败就不催这一次，下一轮再生成
  const language = (row.persona ?? {}).language as string | undefined;
  if (hasChineseLeak(content, language)) {
    const fixed = (await gateway.complete("assist", buildChineseFixMessages(content, language), { conversationId: row.id, temperature: 0.2 })).text.trim();
    if (!fixed || hasChineseLeak(fixed, language)) return false;
    content = fixed;
  }

  // 再确认一次：生成期间客服可能已回复或会话已结束
  const latest = await db.query(
    "select id from conversation_messages where conversation_id = $1 and sender <> 'teacher' order by created_at desc, id desc limit 1",
    [row.id],
  );
  if (latest.rows[0]?.id !== row.last_id) return false;
  const saved = await db.query(
    `insert into conversation_messages (conversation_id, sender, content)
     select $1, 'buyer', $2 where exists (select 1 from conversations where id = $1 and status = 'active')
     returning id`,
    [row.id, content],
  );
  if (!saved.rowCount) return false;

  const nextCount = step.count + 1;
  if (step.leaving && followUpActive(row.tool_followup)) {
    // 跟进中等不到回复：只结束跟进，不评分、不打星、不留评（D-56）
    await endFollowUp(db, row.id, "buyer_left");
    return true;
  }
  const ledger = (row.buyer_ledger ?? null) as BuyerLedger | null;
  if (ledger && !followUpActive(row.tool_followup)) {
    await saveLedger(
      db,
      row.id,
      step.leaving
        ? recordExit(ledger, { outcome: "disappointed", fault: "slow" })
        : applyWaitPenalty(ledger, { agentTurn: countAgentTurns(history) }),
    );
  }
  if (step.leaving) {
    const closed = await db.query(
      "update conversations set status = 'closed', closed_reason = 'buyer_left', closed_at = now() where id = $1 and status = 'active' returning id",
      [row.id],
    );
    if (closed.rowCount) {
      // 与买家在回复里带 [END_OF_SERVICE] 离开走同一套收尾：服务评价 + 评分 + 买家留评
      await rateService(db, row.id).catch((error) => log.error(error, "service rating failed"));
      void assessConversation(db, gateway, row.id).catch((error) => log.error(error, "assessment failed"));
      void generateBuyerReview(db, gateway, row.id, log).catch((error) => log.error(error, "buyer review failed"));
    }
    return true;
  }
  // 催促：记录进度，满意度下降（第 2 次起情绪转为不满）；按最新 state 算，不覆盖观察员刚写的（L2）
  await updateSessionState(db, row.id, (current) => {
    const satisfaction = Math.max(0, (current.satisfaction ?? 60) - (SATISFACTION_DROP[step.count] ?? 10));
    return {
      nudge: { baseAt: step.baseAt, count: nextCount, lastMessageId: saved.rows[0].id } satisfies NudgeState,
      satisfaction,
      satisfactions: [...(current.satisfactions ?? []), satisfaction].slice(-50),
      ...(nextCount >= 2 ? { emotion: "不满" } : {}),
    };
  });
  return true;
}
