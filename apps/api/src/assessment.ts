import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import { forbiddenTerms as builtinForbiddenTerms } from "@cecs/domain";
import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import type { SessionState } from "./director";
import {
  ASSESSMENT_CHUNK_SIZE,
  ASSESSMENT_FULL_TEXT_LIMIT,
  ASSESSMENT_PROMPT_VERSION,
  assessmentOutputSchema,
  buildAssessmentMessages,
  buildChunkSummaryMessages,
  formatTranscript,
  type AssessmentEvidence,
} from "./prompts/assessment";

const DIMENSION_IDS = ASSESSMENT_DIMENSIONS.map((item) => item.id);

/** 学员消息里命中的违规词（词库与邮件检测同源：DB 为空时回退内置词库） */
async function findForbiddenHits(db: Db, studentMessages: string[]): Promise<AssessmentEvidence["forbiddenHits"]> {
  const termsResult = await db.query("select text from content_terms where kind = 'forbidden' and enabled order by id");
  const terms = termsResult.rows.length ? termsResult.rows.map((row) => String(row.text)) : [...builtinForbiddenTerms];
  const hits: AssessmentEvidence["forbiddenHits"] = [];
  for (const message of studentMessages) {
    const lower = message.toLowerCase();
    for (const term of terms) {
      if (term && lower.includes(term.toLowerCase())) hits.push({ term, excerpt: message.slice(0, 120) });
    }
  }
  return hits.slice(0, 20);
}

/** 对话过长时：前面按段摘要，最后一段保留原文（J4） */
async function condenseTranscript(gateway: LlmGateway, transcript: string, conversationId: string): Promise<{ text: string; summarized: boolean }> {
  if (transcript.length <= ASSESSMENT_FULL_TEXT_LIMIT) return { text: transcript, summarized: false };
  const lines = transcript.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length > ASSESSMENT_CHUNK_SIZE && current) {
      chunks.push(current);
      current = "";
    }
    current += `${line}\n`;
  }
  if (current) chunks.push(current);
  const tail = chunks.pop() ?? "";
  const summaries: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const { text } = await gateway.complete("assist", buildChunkSummaryMessages(chunk, index + 1, chunks.length + 1), { conversationId });
    summaries.push(`【第 ${index + 1} 段摘要】${text}`);
  }
  return { text: `${summaries.join("\n")}\n【最后一段原文】\n${tail}`, summarized: true };
}

/** 会话关闭后异步执行六维自动评分（失败不影响关闭流程） */
export async function assessConversation(
  db: Db,
  gateway: LlmGateway,
  conversationId: string,
): Promise<void> {
  if (!gateway.isConfigured("assessment")) return;
  const existing = await db.query(
    "select 1 from assessments where conversation_id = $1",
    [conversationId],
  );
  if (existing.rowCount) return;
  const conversationResult = await db.query(
    `select c.student_id, c.task_id, c.persona, c.state, s.name as scenario_name, s.objective, t.scoring_weights
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
  // 评分读全量对话（J4），不再只取前 60 条
  const messagesResult = await db.query(
    `select sender, content from conversation_messages
     where conversation_id = $1 order by created_at`,
    [conversationId],
  );
  const rows = messagesResult.rows as Array<{ sender: string; content: string }>;
  const studentMessages = rows.filter((row) => row.sender === "student").map((row) => row.content);
  if (studentMessages.length === 0) return;

  const condensed = await condenseTranscript(gateway, formatTranscript(rows), conversationId);
  const state = (conversation.state ?? {}) as SessionState;
  const evidence: AssessmentEvidence = {
    forbiddenHits: await findForbiddenHits(db, studentMessages),
    turnScores: state.scores ?? [],
    summarized: condensed.summarized,
  };
  const { data: parsed, info } = await gateway.completeJson(
    "assessment",
    buildAssessmentMessages({
      scenarioName: conversation.scenario_name ?? null,
      objective: conversation.objective ?? null,
      transcript: condensed.text,
      evidence,
    }),
    assessmentOutputSchema,
    { conversationId },
  );
  const scores: Record<string, number> = {};
  for (const id of DIMENSION_IDS) scores[id] = (parsed.scores as Record<string, number>)[id] ?? 60;
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
    `insert into assessments (conversation_id, student_id, scores, total, comment, suggestions, prompt_version, model, evidence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (conversation_id) do nothing`,
    [
      conversationId,
      conversation.student_id,
      JSON.stringify(scores),
      total,
      parsed.comment.slice(0, 300),
      JSON.stringify(parsed.suggestions.slice(0, 3)),
      ASSESSMENT_PROMPT_VERSION,
      `${info.profileName} / ${info.model}`,
      JSON.stringify(evidence),
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
