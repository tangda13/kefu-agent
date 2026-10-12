import { EMOTIONS, type ScenarioScript } from "@cecs/contracts";
import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import {
  buildDirectorMessages,
  directorOutputSchema,
  DIRECTOR_RECENT_MESSAGES,
  STAGES,
  type DirectorInput,
} from "./prompts/director";

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
  /** 学生发言轮数（导演按 N 轮一次运行时计数用） */
  studentTurns?: number;
  resolved?: boolean;
  updatedAt?: string;
}

/**
 * 导演核心（纯逻辑，无数据库）：根据最近对话推演买家情绪/剧情阶段、给学生本轮打分、
 * 生成下一轮表演指令并增量维护事实备忘录。评测脚本（J8）直接复用。
 */
export async function directTurn(
  gateway: LlmGateway,
  input: DirectorInput,
  state: SessionState,
  conversationId?: string,
): Promise<SessionState> {
  const { data } = await gateway.completeJson("director", buildDirectorMessages(input), directorOutputSchema, { conversationId });
  const scores = [...(state.scores ?? []), data.turnScore].slice(-50);
  return {
    ...state,
    emotion: (EMOTIONS as readonly string[]).includes(data.emotion) ? data.emotion : state.emotion,
    stage: (STAGES as readonly string[]).includes(data.stage) ? data.stage : state.stage ?? "问题陈述",
    satisfaction: data.satisfaction,
    directive: data.directive ? data.directive.slice(0, 120) : undefined,
    memory: data.memory ? data.memory.slice(0, 600) : state.memory,
    liveScore: data.turnScore,
    scores,
    turnCount: (state.turnCount ?? 0) + 1,
    resolved: data.resolved === true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 每轮买家回复后异步运行（不阻塞学生）。按管理端设置每 N 轮学生发言运行一次（J6），
 * 导演用途可单独指定便宜快速的模型。输出不合格时保留上一轮状态（降级），不影响对话。
 */
export async function runDirector(db: Db, gateway: LlmGateway, conversationId: string): Promise<void> {
  if (!gateway.isConfigured("director")) return;
  const conversationResult = await db.query(
    `select c.persona, c.state, s.name as scenario_name, s.objective, s.script
     from conversations c left join scenarios s on s.id = c.scenario_id
     where c.id = $1 and c.status = 'active'`,
    [conversationId],
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return;
  const state = (conversation.state ?? {}) as SessionState;
  const studentTurns = (state.studentTurns ?? 0) + 1;
  const every = gateway.directorEveryNTurns;
  if (every > 1 && studentTurns % every !== 0) {
    await db.query("update conversations set state = state || $1::jsonb where id = $2", [
      JSON.stringify({ studentTurns }),
      conversationId,
    ]);
    return;
  }
  const messagesResult = await db.query(
    `select sender, content from conversation_messages
     where conversation_id = $1 order by created_at desc limit $2`,
    [conversationId, DIRECTOR_RECENT_MESSAGES],
  );
  const recent = messagesResult.rows.reverse() as Array<{ sender: string; content: string }>;
  if (!recent.some((row) => row.sender === "student")) return;

  const next = await directTurn(
    gateway,
    {
      persona: conversation.persona as Record<string, unknown>,
      scenarioName: conversation.scenario_name ?? null,
      objective: conversation.objective ?? null,
      script: (conversation.script as ScenarioScript | null) ?? null,
      previous: state,
      transcript: recent,
    },
    state,
    conversationId,
  ).catch(async (error) => {
    // 降级：保留旧状态，只推进计数
    await db.query("update conversations set state = state || $1::jsonb where id = $2", [
      JSON.stringify({ studentTurns }),
      conversationId,
    ]);
    throw error;
  });
  await db.query("update conversations set state = $1 where id = $2", [
    JSON.stringify({ ...next, studentTurns }),
    conversationId,
  ]);
}
