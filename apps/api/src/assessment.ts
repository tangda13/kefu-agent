import { AI_ASSESSMENT_DIMENSIONS, ASSESSMENT_DIMENSIONS, type BusinessStage, type ScenarioScript } from "@cecs/contracts";
import { buyerComplaints, computeResponsiveness, forbiddenTerms as builtinForbiddenTerms, type BuyerLedger } from "@cecs/domain";
import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import { once } from "./inflight";
import type { SessionState } from "./director";
import {
  ASSESSMENT_CHUNK_SIZE,
  ASSESSMENT_FULL_TEXT_LIMIT,
  ASSESSMENT_PROMPT_VERSION,
  assessmentOutputSchema,
  buildAssessmentMessages,
  buildChunkSummaryMessages,
  buildMailAssessmentMessages,
  buyerExitSummary,
  formatTranscript,
  MAIL_ASSESSMENT_DIMENSION_IDS,
  mailAssessmentOutputSchema,
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

/** 评分失败后在进程内再试的等待时间（L1）；还不行留给定时补漏（lifecycle.sweepBackgroundJobs） */
const RETRY_DELAYS_MS = process.env.NODE_ENV === "test" ? [0, 0] : [5_000, 20_000];

/**
 * 会话关闭后异步执行自动评分（失败不影响关闭流程）：七项由模型打分，消息响应时效由系统计算（D-46）。
 * 同一会话同时只跑一次（关闭和补漏撞上时等前一个）；每跑一次 assess_attempts + 1，模型出错退避重试 2 次。
 */
export function assessConversation(db: Db, gateway: LlmGateway, conversationId: string): Promise<void> {
  if (!gateway.isConfigured("assessment")) return Promise.resolve();
  return once(`assess:${conversationId}`, async () => {
    await db.query("update conversations set assess_attempts = assess_attempts + 1 where id = $1", [conversationId]);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await assessOnce(db, gateway, conversationId);
        return;
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  });
}

async function assessOnce(db: Db, gateway: LlmGateway, conversationId: string): Promise<void> {
  const existing = await db.query(
    "select 1 from assessments where conversation_id = $1",
    [conversationId],
  );
  if (existing.rowCount) return;
  const conversationResult = await db.query(
    `select c.student_id, c.task_id, c.persona, c.state, c.closed_at, c.closed_reason, c.channel, c.buyer_ledger,
            s.name as scenario_name, s.objective, s.stage, s.script, t.scoring_weights
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
  if (conversation.channel === "mail") {
    await assessMail(db, gateway, conversationId, conversation);
    return;
  }
  // 评分读全量对话（J4），不再只取前 60 条
  const messagesResult = await db.query(
    `select id, sender, content, created_at from conversation_messages
     where conversation_id = $1 order by created_at, id`,
    [conversationId],
  );
  const rows = messagesResult.rows as Array<{ id: string; sender: string; content: string; created_at: Date }>;
  const studentMessages = rows.filter((row) => row.sender === "student").map((row) => row.content);
  if (studentMessages.length === 0) return;

  const condensed = await condenseTranscript(gateway, formatTranscript(rows), conversationId);
  const state = (conversation.state ?? {}) as SessionState;
  const persona = (conversation.persona ?? {}) as Record<string, unknown>;
  const productFacts = typeof persona.productFacts === "string" && persona.productFacts.trim() ? persona.productFacts : null;
  const responsiveness = computeResponsiveness(
    rows.map((row) => ({ sender: row.sender, at: row.created_at })),
    { closedAt: conversation.closed_at, closedReason: conversation.closed_reason },
  );
  // 买家怎么走的（D-90）：和复盘里标出来的消息同一套账，总评第一句据此写
  const ledger = (conversation.buyer_ledger ?? null) as BuyerLedger | null;
  const summary = buyerExitSummary(ledger, conversation.closed_reason ?? null);
  const studentRows = rows.filter((row) => row.sender === "student");
  const evidence: AssessmentEvidence = {
    forbiddenHits: await findForbiddenHits(db, studentMessages),
    turnScores: state.scores ?? [],
    summarized: condensed.summarized,
    responsiveness,
    hasProductFacts: !!productFacts,
    buyerExit: summary
      ? {
          summary,
          complaints: buyerComplaints(ledger, studentRows.map((row) => ({ id: row.id, at: new Date(row.created_at).getTime() }))).map((item) => ({
            excerpt: (studentRows.find((row) => row.id === item.messageId)?.content ?? "").slice(0, 80),
            faults: item.faults,
            severe: item.severe,
            last: item.last,
          })),
        }
      : null,
  };
  const { data: parsed, info } = await gateway.completeJson(
    "assessment",
    buildAssessmentMessages({
      scenarioName: conversation.scenario_name ?? null,
      objective: conversation.objective ?? null,
      stage: (conversation.stage as BusinessStage | null) ?? null,
      script: (conversation.script as ScenarioScript | null) ?? null,
      productFacts,
      transcript: condensed.text,
      evidence,
    }),
    assessmentOutputSchema,
    { conversationId },
  );
  const scores: Record<string, number> = {};
  for (const dim of AI_ASSESSMENT_DIMENSIONS) scores[dim.id] = (parsed.scores as Record<string, number | undefined>)[dim.id] ?? 60;
  if (responsiveness.score != null) scores.responsiveness = responsiveness.score;
  const total = weightedTotal(scores, (conversation.scoring_weights ?? {}) as Record<string, number>);
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
  if (conversation.task_id) await updateTaskProgress(db, conversation.task_id, conversation.student_id);
}

/** 邮件任务评分（D-58）：评六项，客户情绪安抚、消息响应时效不评；违规词命中作为客观依据 */
async function assessMail(db: Db, gateway: LlmGateway, conversationId: string, conversation: Record<string, any>): Promise<void> {
  const mailResult = await db.query(
    "select payload from conversation_messages where conversation_id = $1 and sender = 'student' and kind = 'mail' order by created_at desc limit 1",
    [conversationId],
  );
  const mail = mailResult.rows[0]?.payload as { subject?: string; body?: string; to?: string; toName?: string; templateId?: string } | undefined;
  if (!mail?.body) return;
  const persona = (conversation.persona ?? {}) as Record<string, unknown>;
  const { emailTemplates } = await import("@cecs/domain");
  const template = emailTemplates.find((item) => item.id === mail.templateId);
  const evidence: AssessmentEvidence = {
    forbiddenHits: await findForbiddenHits(db, [`${mail.subject ?? ""}\n${mail.body}`]),
    turnScores: [],
    summarized: false,
    hasProductFacts: typeof persona.productFacts === "string" && !!persona.productFacts.trim(),
  };
  const { data: parsed, info } = await gateway.completeJson(
    "assessment",
    buildMailAssessmentMessages({
      scenarioName: conversation.scenario_name ?? null,
      objective: conversation.objective ?? null,
      stage: (conversation.stage as BusinessStage | null) ?? null,
      templatePurpose: template ? `${template.name}（${template.purpose}）` : null,
      recipient: `${mail.toName ?? persona.name ?? "customer"}，${persona.nationality ?? ""}，客户类型 ${persona.customerType ?? "-"}`,
      productFacts: typeof persona.productFacts === "string" ? persona.productFacts : null,
      subject: mail.subject ?? "",
      body: mail.body,
      forbiddenHits: evidence.forbiddenHits,
    }),
    mailAssessmentOutputSchema,
    { conversationId },
  );
  const scores: Record<string, number> = {};
  for (const id of MAIL_ASSESSMENT_DIMENSION_IDS) scores[id] = (parsed.scores as Record<string, number | undefined>)[id] ?? 60;
  const total = weightedTotal(scores, (conversation.scoring_weights ?? {}) as Record<string, number>);
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
      `${ASSESSMENT_PROMPT_VERSION}#mail`,
      `${info.profileName} / ${info.model}`,
      JSON.stringify(evidence),
    ],
  );
  if (conversation.task_id) await updateTaskProgress(db, conversation.task_id, conversation.student_id);
}

/**
 * 任务进度：评完一次接待（聊天或邮件）后推进。任务 = 考核单位：任务成绩 = 该任务下所有已评会话的平均分，
 * 进行中持续更新（教师端可实时跟踪）。是否「完成」按任务配置的完成标准判定：
 * - all_scenarios：任务勾选的每个场景至少完成一次已评会话
 * - conversation_count：已评会话数达到 required_count
 * 达标与否由前端按 score 与 pass_score 推导展示，这里只负责状态推进
 */
async function updateTaskProgress(db: Db, taskId: string, studentId: string): Promise<void> {
  const taskResult = await db.query("select scenario_ids, completion_rule, required_count from tasks where id = $1", [taskId]);
  const task = taskResult.rows[0];
  const scenarioIds = (task?.scenario_ids ?? []) as string[];
  const progressResult = await db.query(
    `select count(*)::int as assessed_count,
            count(distinct c.scenario_id) filter (where c.scenario_id = any($3))::int as covered_scenarios,
            round(avg(a.total))::int as avg_total
     from assessments a join conversations c on c.id = a.conversation_id
     where c.task_id = $1 and a.student_id = $2`,
    [taskId, studentId, scenarioIds],
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
    [taskId, studentId, completed, progress.avg_total],
  );
}

/**
 * 总分：任务配置了考核权重则按权重加权，无任务/无权重时各项等权（AI 评分与教师复核共用）。
 * 只算有分的维度：老记录没有新增两项（D-46）、或响应时效无可计轮次时，不按 0 分拉低总分。
 */
export function weightedTotal(scores: Record<string, number>, weights: Record<string, number>): number {
  const scored = DIMENSION_IDS.filter((id) => Number.isFinite(scores[id]));
  if (!scored.length) return 0;
  const weightOf = (id: string) => {
    const value = Number(weights[id]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const weightSum = scored.reduce((sum, id) => sum + weightOf(id), 0);
  return weightSum > 0
    ? Math.round(scored.reduce((sum, id) => sum + scores[id]! * weightOf(id), 0) / weightSum)
    : Math.round(scored.reduce((sum, id) => sum + scores[id]!, 0) / scored.length);
}
