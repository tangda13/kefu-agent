import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import type { Db } from "./db";
import type { ConversationProvider } from "./conversation-provider";

const DIMENSION_IDS = ASSESSMENT_DIMENSIONS.map((item) => item.id);

/** 会话关闭后异步执行六维自动评分（失败不影响关闭流程） */
export async function assessConversation(
  db: Db,
  provider: ConversationProvider,
  conversationId: string,
): Promise<void> {
  if (provider.providerId === "unconfigured") return;
  const existing = await db.query(
    "select 1 from assessments where conversation_id = $1",
    [conversationId],
  );
  if (existing.rowCount) return;
  const conversationResult = await db.query(
    `select c.student_id, c.task_id, c.persona, s.name as scenario_name, s.objective
     from conversations c left join scenarios s on s.id = c.scenario_id
     where c.id = $1`,
    [conversationId],
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return;
  const messagesResult = await db.query(
    `select sender, content from conversation_messages
     where conversation_id = $1 order by created_at limit 60`,
    [conversationId],
  );
  const studentTurns = messagesResult.rows.filter((row) => row.sender === "student").length;
  if (studentTurns === 0) return;
  const transcript = messagesResult.rows
    .map((row) => `${row.sender === "buyer" ? "Buyer" : row.sender === "student" ? "Agent" : "Teacher"}: ${row.content}`)
    .join("\n");

  const dims = ASSESSMENT_DIMENSIONS.map((item) => `${item.id}（${item.label}）`).join("、");
  const raw = await provider.complete(
    "你是跨境电商客服实训评分专家。根据买家与客服学员（Agent）的对话记录，" +
      `从六个维度打分（0-100 整数）：${dims}。` +
      "并写一段不超过 80 字的中文总评，以及 2-3 条中文改进建议。" +
      '只返回 JSON：{"scores":{"compliance":85,"grammar":80,"professionalism":78,"effectiveness":82,"empathy":75,"resolution":80},"comment":"...","suggestions":["...","..."]}',
    `训练场景：${conversation.scenario_name ?? "通用客服对话"}（目标：${conversation.objective ?? "-"}）\n对话记录：\n${transcript}`,
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("ASSESSMENT_PARSE_FAILED");
  const parsed = JSON.parse(match[0]) as {
    scores: Record<string, number>;
    comment?: string;
    suggestions?: string[];
  };
  const scores: Record<string, number> = {};
  for (const id of DIMENSION_IDS) {
    const value = Number(parsed.scores?.[id]);
    scores[id] = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 60;
  }
  const total = Math.round(
    DIMENSION_IDS.reduce((sum, id) => sum + (scores[id] ?? 0), 0) / DIMENSION_IDS.length,
  );
  await db.query(
    `insert into assessments (conversation_id, student_id, scores, total, comment, suggestions)
     values ($1, $2, $3, $4, $5, $6) on conflict (conversation_id) do nothing`,
    [
      conversationId,
      conversation.student_id,
      JSON.stringify(scores),
      total,
      (parsed.comment ?? "").slice(0, 300),
      JSON.stringify((parsed.suggestions ?? []).slice(0, 3)),
    ],
  );
  if (conversation.task_id) {
    await db.query(
      `update task_progress set status = 'done', score = $1, updated_at = now()
       where task_id = $2 and student_id = $3`,
      [total, conversation.task_id, conversation.student_id],
    );
  }
}
