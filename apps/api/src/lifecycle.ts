import type { Db } from "./db";
import type { LlmGateway } from "./llm/gateway";
import { assessConversation } from "./assessment";
import { generateBuyerReview } from "./review-gen";
import { rateService } from "./service-rating";
import { endFollowUp, FOLLOWUP_ABANDON_MINUTES } from "./tool-followup";

/**
 * 接待（会话）生命周期（D-36）：
 * - 只有任务内接待进入实训跟踪与回放；自由练习老师不监控、不评分。
 * - 结束方式：买家离开 / 学生主动结束 / 超过单次限时 / 2 小时没有学生或买家发言 / 任务被结束或过了截止时间。老师不能手动结束（D-02）。
 * - 评分：买家离开、学生结束、超时照常评分；中途放弃（无人发言、任务结束）学生说满 3 轮才评分，否则记“未完成，不计分”。
 */
export const ABANDON_AFTER_MINUTES = 120;
export const MIN_TURNS_TO_SCORE = 3;

export type CloseReason = "buyer_left" | "student_ended" | "timeout" | "abandoned" | "task_closed";
const ALWAYS_SCORE: CloseReason[] = ["buyer_left", "student_ended", "timeout"];

/** 关闭后按规则决定是否评分 */
export async function scoreIfEligible(db: Db, gateway: LlmGateway, conversationId: string, reason: CloseReason): Promise<void> {
  if (!ALWAYS_SCORE.includes(reason)) {
    const turns = await db.query("select count(*)::int as n from conversation_messages where conversation_id = $1 and sender = 'student'", [conversationId]);
    if ((turns.rows[0]?.n ?? 0) < MIN_TURNS_TO_SCORE) return;
  }
  await assessConversation(db, gateway, conversationId);
}

/**
 * 扫描进行中的接待，满足结束条件的自动结束（API 内每分钟一次；也在结束任务时立即调用）。
 * 邮件会话（D-58）没有聊天，不按“无人发言”结束，只随任务结束。
 * 工具跟进（D-56）不受限时和任务截止约束，两边 30 分钟没说话就结束跟进（不改原来的结束原因、不评分）。
 */
export async function sweepConversations(db: Db, gateway: LlmGateway, options: { taskId?: string } = {}): Promise<number> {
  const result = await db.query(
    `with last as (
       select c.id, c.task_id, c.channel, c.tool_followup,
              coalesce((select max(m.created_at) from conversation_messages m where m.conversation_id = c.id and m.sender <> 'teacher'), c.created_at) as last_at,
              c.created_at, t.status as task_status, t.deadline, t.time_limit_minutes
       from conversations c left join tasks t on t.id = c.task_id
       where c.status = 'active' and ($1::uuid is null or c.task_id = $1)
     )
     select id, task_id,
            case
              when tool_followup is not null then
                case when last_at < now() - make_interval(mins => $3) then 'followup_abandoned' end
              when task_id is not null and (task_status = 'closed' or (deadline is not null and deadline < now())) then 'task_closed'
              when channel = 'mail' then null
              when time_limit_minutes is not null and created_at + make_interval(mins => time_limit_minutes) < now() then 'timeout'
              when last_at < now() - make_interval(mins => $2) then 'abandoned'
            end as reason
     from last`,
    [options.taskId ?? null, ABANDON_AFTER_MINUTES, FOLLOWUP_ABANDON_MINUTES],
  );
  let closed = 0;
  for (const row of result.rows) {
    if (!row.reason) continue;
    if (row.reason === "followup_abandoned") {
      if (await endFollowUp(db, row.id, "abandoned")) closed += 1;
      continue;
    }
    const updated = await db.query(
      "update conversations set status = 'closed', closed_reason = $2, closed_at = now() where id = $1 and status = 'active' returning id",
      [row.id, row.reason],
    );
    if (!updated.rowCount) continue;
    closed += 1;
    await rateService(db, row.id).catch(() => undefined);
    if (row.task_id) await scoreIfEligible(db, gateway, row.id, row.reason as CloseReason).catch(() => undefined);
  }
  return closed;
}

/**
 * 应该有评分、但还没有的任务接待（SQL 条件，会话表别名 c）：和上面的评分规则一致——
 * 邮件发出去了；聊天学生至少说过 1 轮，中途放弃（无人发言、任务结束）的要满 3 轮。
 */
export const SCORE_DUE_SQL = `c.status = 'closed' and c.task_id is not null
  and not exists (select 1 from assessments a where a.conversation_id = c.id)
  and case when c.channel = 'mail'
    then exists (select 1 from conversation_messages m where m.conversation_id = c.id and m.sender = 'student' and m.kind = 'mail')
    else (select count(*) from conversation_messages m where m.conversation_id = c.id and m.sender = 'student')
         >= case when c.closed_reason in ('abandoned', 'task_closed') then ${MIN_TURNS_TO_SCORE} else 1 end
  end`;

/** 自动评分最多跑几次（每次含进程内重试），超过就等管理员在系统总览点“重新评分” */
export const MAX_ASSESS_ATTEMPTS = 3;

type SweepLog = { error: (obj: unknown, msg?: string) => void; info: (msg: string) => void; warn: (msg: string) => void };

/**
 * 后台任务补漏（L1，API 启动后和每 3 分钟一次）：评分、买家留评都是关闭时在进程里异步跑的，
 * API 重启或模型出错就丢了。这里把“结束 5 分钟以上、24 小时以内、还没跑完”的捡回来重跑；
 * 结束不到 5 分钟的可能还在跑，不抢。邮件回信按概率触发，分不清“没触发”和“丢了”，不补。
 */
export async function sweepBackgroundJobs(db: Db, gateway: LlmGateway, log: SweepLog): Promise<{ assessed: number; reviewed: number }> {
  const recent = "c.closed_at < now() - interval '5 minutes' and c.closed_at > now() - interval '24 hours'";
  const toAssess = await db.query<{ id: string }>(
    `select c.id from conversations c where ${SCORE_DUE_SQL} and ${recent} and c.assess_attempts < $1 order by c.closed_at limit 20`,
    [MAX_ASSESS_ATTEMPTS],
  );
  let assessed = 0;
  for (const row of toAssess.rows) {
    await assessConversation(db, gateway, row.id).then(() => (assessed += 1), (error) => log.error(error, "assessment retry failed"));
  }
  // 买家留评只在买家离开、学生结束时触发（和关闭时一致），有主订单才可能留评
  const toReview = await db.query<{ id: string }>(
    `select c.id from conversations c
     where c.status = 'closed' and c.channel = 'chat' and c.review_done_at is null and c.tool_followup is null
       and c.closed_reason in ('buyer_left', 'student_ended') and ${recent}
       and exists (select 1 from orders o where o.conversation_id = c.id and o.is_primary)
     order by c.closed_at limit 20`,
  );
  let reviewed = 0;
  for (const row of toReview.rows) {
    await generateBuyerReview(db, gateway, row.id, log).then(() => (reviewed += 1), (error) => log.error(error, "buyer review retry failed"));
  }
  return { assessed, reviewed };
}

/** 自动评分试满次数仍失败的任务接待（7 天内）：系统总览告警、管理员一键重新评分 */
export const SCORE_FAILED_SQL = `${SCORE_DUE_SQL} and c.assess_attempts >= ${MAX_ASSESS_ATTEMPTS} and c.closed_at > now() - interval '7 days'`;

/** 管理员点“重新评分”：试满次数的那些清零后逐个重评（后台跑，返回条数） */
export async function retryFailedAssessments(db: Db, gateway: LlmGateway, log: SweepLog): Promise<number> {
  const result = await db.query<{ id: string }>(
    `update conversations c set assess_attempts = 0 where ${SCORE_FAILED_SQL} returning c.id`,
  );
  void (async () => {
    for (const row of result.rows) {
      await assessConversation(db, gateway, row.id).catch((error) => log.error(error, "manual assessment retry failed"));
    }
  })();
  return result.rowCount ?? 0;
}
