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
    `select c.student_id, c.task_id, c.persona, s.name as scenario_name, s.objective, t.scoring_weights
     from conversations c
     left join scenarios s on s.id = c.scenario_id
     left join tasks t on t.id = c.task_id
     where c.id = $1`,
    [conversationId],
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return;
  /* 自由练习（无任务会话）不评分：只有任务实训才进入考核统计 */
  if (!conversation.task_id) return;
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
  /* 总分：任务配置了考核权重则按权重加权，无任务/无权重时六维等权 */
  const weights = (conversation.scoring_weights ?? {}) as Record<string, number>;
  const weightOf = (id: string) => {
    const value = Number(weights[id]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const weightSum = DIMENSION_IDS.reduce((sum, id) => sum + weightOf(id), 0);
  const total =
    weightSum > 0
      ? Math.round(DIMENSION_IDS.reduce((sum, id) => sum + (scores[id] ?? 0) * weightOf(id), 0) / weightSum)
      : Math.round(DIMENSION_IDS.reduce((sum, id) => sum + (scores[id] ?? 0), 0) / DIMENSION_IDS.length);
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
    /* 任务 = 考核单位：任务成绩 = 该任务下所有已评会话的平均分，进行中持续更新（教师端可实时跟踪）。
       是否「完成」按任务配置的完成标准判定：
       - all_scenarios：任务勾选的每个场景至少完成一次已评会话
       - conversation_count：已评会话数达到 required_count
       达标与否由前端按 score 与 pass_score 推导展示，这里只负责状态推进 */
    const taskResult = await db.query(
      "select scenario_ids, completion_rule, required_count from tasks where id = $1",
      [conversation.task_id],
    );
    const task = taskResult.rows[0];
    const scenarioIds = (task?.scenario_ids ?? []) as string[];
    const progressResult = await db.query(
      `select count(*)::int as assessed_count,
              count(distinct c.scenario_id) filter (where c.scenario_id = any($3))::int as covered_scenarios,
              round(avg(a.total))::int as avg_total
       from assessments a join conversations c on c.id = a.conversation_id
       where c.task_id = $1 and a.student_id = $2`,
      [conversation.task_id, conversation.student_id, scenarioIds],
    );
    const progress = progressResult.rows[0]!;
    const completed =
      task?.completion_rule === "conversation_count"
        ? Number(progress.assessed_count) >= Math.max(1, Number(task.required_count) || 1)
        : scenarioIds.length === 0 || Number(progress.covered_scenarios) >= scenarioIds.length;
    await db.query(
      `update task_progress set
         status = case when $3 or status = 'done' then 'done' else 'in_progress' end,
         score = $4, updated_at = now()
       where task_id = $1 and student_id = $2`,
      [conversation.task_id, conversation.student_id, completed, progress.avg_total],
    );
  }
}
