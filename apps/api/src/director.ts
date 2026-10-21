import { EMOTIONS, type ScenarioScript } from "@cecs/contracts";
import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import {
  buildDirectorMessages,
  directorOutputSchema,
  DIRECTOR_HISTORY_CHAR_BUDGET,
  STAGES,
  type DirectorInput,
} from "./prompts/director";
import { trimHistory } from "./prompts/buyer";

/** 会话评估状态（存 conversations.state）。D-50 前的老会话里还留着 directive / memory / resolved，已不再使用 */
export interface SessionState {
  emotion?: string;
  stage?: string;
  satisfaction?: number;
  liveScore?: number;
  scores?: number[];
  /** 每轮买家满意度（实训跟踪画走势，最多 50 个） */
  satisfactions?: number[];
  turnCount?: number;
  /** 学生发言轮数（观察员按 N 轮一次运行时计数用） */
  studentTurns?: number;
  updatedAt?: string;
}

const LEGACY_KEYS = ["directive", "memory", "resolved"] as const;

/**
 * 观察员核心（纯逻辑，无数据库）：根据对话评估学员本轮表现、买家满意度、情绪和对话进度。
 * 结果只给教师端、评分和催促用，不回写买家（D-50）。评测脚本（J8）直接复用。
 */
export async function directTurn(
  gateway: LlmGateway,
  input: DirectorInput,
  state: SessionState,
  conversationId?: string,
): Promise<SessionState> {
  const { data } = await gateway.completeJson("director", buildDirectorMessages(input), directorOutputSchema, { conversationId });
  const scores = [...(state.scores ?? []), data.turnScore].slice(-50);
  const satisfactions = [...(state.satisfactions ?? []), data.satisfaction].slice(-50);
  const next: SessionState & Record<string, unknown> = {
    ...state,
    emotion: (EMOTIONS as readonly string[]).includes(data.emotion) ? data.emotion : state.emotion,
    stage: (STAGES as readonly string[]).includes(data.stage) ? data.stage : state.stage ?? "问题陈述",
    satisfaction: data.satisfaction,
    liveScore: data.turnScore,
    scores,
    satisfactions,
    turnCount: (state.turnCount ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  for (const key of LEGACY_KEYS) delete next[key];
  return next;
}

/**
 * 按字段合并写 conversations.state（L2）：在行锁里读最新的 state 再算补丁，观察员、催促各写各的字段，
 * 走势数组按最新的值追加，谁也不会把别人刚写进去的覆盖掉。remove 是要顺手删掉的旧字段。
 */
export async function updateSessionState(
  db: Db,
  conversationId: string,
  build: (current: SessionState) => Record<string, unknown>,
  remove: readonly string[] = [],
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query("select state from conversations where id = $1 for update", [conversationId]);
    if (result.rowCount) {
      const patch = build((result.rows[0].state ?? {}) as SessionState);
      await client.query(
        "update conversations set state = (coalesce(state, '{}'::jsonb) || $1::jsonb) - $3::text[] where id = $2",
        [JSON.stringify(patch), conversationId, [...remove]],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** 正在评估的会话 → 评估期间学生又说了话（跑完按最新对话再评一次） */
const observing = new Map<string, boolean>();

/**
 * 每轮买家回复后异步运行（不阻塞学生）。按管理端设置每 N 轮学生发言运行一次（J6），
 * 可单独指定便宜快速的模型。输出不合格时保留上一轮状态（降级），不影响对话。
 * 同一会话串行（L2）：上一次还没评完就不再并发，记一笔，评完按最新对话补评一次（中间几轮合并成一次）。
 */
export async function runDirector(db: Db, gateway: LlmGateway, conversationId: string): Promise<void> {
  if (!gateway.isConfigured("director")) return;
  // 学生发言计数原子自增：学生回得快、几轮同时到，也不会算少
  const counted = await db.query<{ turns: number }>(
    `update conversations
     set state = coalesce(state, '{}'::jsonb) || jsonb_build_object('studentTurns', coalesce((state->>'studentTurns')::int, 0) + 1)
     where id = $1 and status = 'active' returning (state->>'studentTurns')::int as turns`,
    [conversationId],
  );
  if (!counted.rowCount) return;
  const every = gateway.directorEveryNTurns;
  if (every > 1 && counted.rows[0]!.turns % every !== 0) return;
  if (observing.has(conversationId)) {
    observing.set(conversationId, true);
    return;
  }
  try {
    do {
      observing.set(conversationId, false);
      await observe(db, gateway, conversationId);
    } while (observing.get(conversationId));
  } finally {
    observing.delete(conversationId);
  }
}

async function observe(db: Db, gateway: LlmGateway, conversationId: string): Promise<void> {
  const conversationResult = await db.query(
    `select c.persona, c.state, s.name as scenario_name, s.objective, s.script
     from conversations c left join scenarios s on s.id = c.scenario_id
     where c.id = $1 and c.status = 'active'`,
    [conversationId],
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return;
  const state = (conversation.state ?? {}) as SessionState;
  const messagesResult = await db.query(
    `select sender, content from conversation_messages
     where conversation_id = $1 order by created_at desc, id desc limit 300`,
    [conversationId],
  );
  const transcript = trimHistory(messagesResult.rows.reverse() as Array<{ sender: string; content: string }>, DIRECTOR_HISTORY_CHAR_BUDGET);
  if (!transcript.some((row) => row.sender === "student")) return;

  const next = await directTurn(
    gateway,
    {
      persona: conversation.persona as Record<string, unknown>,
      scenarioName: conversation.scenario_name ?? null,
      objective: conversation.objective ?? null,
      script: (conversation.script as ScenarioScript | null) ?? null,
      previous: state,
      transcript,
    },
    state,
    conversationId,
  );
  // 只写观察员自己的字段；走势按最新 state 追加，评估期间催促写进去的满意度点不会丢
  await updateSessionState(
    db,
    conversationId,
    (current) => ({
      emotion: next.emotion,
      stage: next.stage,
      satisfaction: next.satisfaction,
      liveScore: next.liveScore,
      scores: [...(current.scores ?? []), next.liveScore].slice(-50),
      satisfactions: [...(current.satisfactions ?? []), next.satisfaction].slice(-50),
      turnCount: (current.turnCount ?? 0) + 1,
      updatedAt: next.updatedAt,
    }),
    LEGACY_KEYS,
  );
}
