import { EMOTIONS } from "@cecs/contracts";
import type { Db } from "./db";
import type { ConversationProvider } from "./conversation-provider";

/** 会话导演状态（存 conversations.state） */
export interface SessionState {
  emotion?: string;
  stage?: string;
  satisfaction?: number;
  directive?: string;
  liveScore?: number;
  scores?: number[];
  memory?: string;
  turnCount?: number;
  resolved?: boolean;
  updatedAt?: string;
}

const STAGES = ["问题陈述", "信息核实", "方案协商", "达成一致", "僵持升级"];

/**
 * 轻量 Agent 导演：每轮买家回复后异步运行（不阻塞学生）。
 * 职责：评估学生本轮表现（实时得分）、推演买家情绪与剧情阶段、
 * 生成下一轮表演指令，并增量维护跨轮"事实记忆"摘要。
 */
export async function runDirector(
  db: Db,
  provider: ConversationProvider,
  conversationId: string,
): Promise<void> {
  if (provider.providerId === "unconfigured") return;
  const conversationResult = await db.query(
    `select c.persona, c.state, s.name as scenario_name, s.objective
     from conversations c left join scenarios s on s.id = c.scenario_id
     where c.id = $1 and c.status = 'active'`,
    [conversationId],
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return;
  const messagesResult = await db.query(
    `select sender, content from conversation_messages
     where conversation_id = $1 order by created_at desc limit 10`,
    [conversationId],
  );
  const recent = messagesResult.rows.reverse();
  if (!recent.some((row) => row.sender === "student")) return;

  const persona = conversation.persona as Record<string, unknown>;
  const state = (conversation.state ?? {}) as SessionState;
  const transcript = recent
    .map((row) => `${row.sender === "buyer" ? "买家" : row.sender === "student" ? "客服学员" : "教师"}: ${row.content}`)
    .join("\n");

  const raw = await provider.complete(
    "你是跨境电商客服实训的“导演”，负责让AI买家的表演真实、有剧情推进，并评估客服学员表现。" +
      `依据最近对话输出 JSON（只输出JSON）：{"turnScore":0-100学员最近一轮表现分,` +
      `"satisfaction":0-100买家当前满意度,"emotion":"${EMOTIONS.join("|")}"之一,` +
      `"stage":"${STAGES.join("|")}"之一,"directive":"给买家演员的下一轮表演指令，中文≤50字",` +
      `"memory":"合并旧备忘录后的关键事实摘要，中文≤200字：双方承诺/报价折扣/证据/已确认信息","resolved":问题是否已解决true或false}` +
      " 评分依据：合规、语言质量、共情、推进问题解决。买家情绪应对学员表现做出合理演变：安抚有效则缓和，敷衍拖延则恶化。",
    `买家画像：${JSON.stringify({ name: persona.name, personality: persona.personality, emotion: persona.emotion, customerType: persona.customerType })}\n` +
      `场景：${conversation.scenario_name ?? "通用客服"}（目标：${conversation.objective ?? "-"}）\n` +
      `上一轮状态：${JSON.stringify({ emotion: state.emotion, stage: state.stage, satisfaction: state.satisfaction })}\n` +
      `既往备忘录：${state.memory ?? "（无）"}\n最近对话：\n${transcript}`,
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("DIRECTOR_PARSE_FAILED");
  const parsed = JSON.parse(match[0]) as SessionState & { turnScore?: number };

  const clamp = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
  };
  const turnScore = clamp(parsed.turnScore, 70);
  const scores = [...(state.scores ?? []), turnScore].slice(-50);
  const next: SessionState = {
    emotion: EMOTIONS.includes(parsed.emotion as never) ? parsed.emotion : state.emotion,
    stage: STAGES.includes(parsed.stage ?? "") ? parsed.stage : state.stage ?? "问题陈述",
    satisfaction: clamp(parsed.satisfaction, state.satisfaction ?? 60),
    directive: typeof parsed.directive === "string" ? parsed.directive.slice(0, 120) : undefined,
    memory: typeof parsed.memory === "string" ? parsed.memory.slice(0, 600) : state.memory,
    liveScore: turnScore,
    scores,
    turnCount: (state.turnCount ?? 0) + 1,
    resolved: parsed.resolved === true,
    updatedAt: new Date().toISOString(),
  };
  await db.query("update conversations set state = $1 where id = $2", [
    JSON.stringify(next),
    conversationId,
  ]);
}
