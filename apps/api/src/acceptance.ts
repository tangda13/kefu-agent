import { ACCEPTANCE_THRESHOLDS } from "@cecs/contracts";
import { composePersonaWithRule } from "@cecs/domain";
import type { Db } from "./db";
import type { ConversationProvider } from "./conversation-provider";
import { getSetting, setSetting } from "./settings";

export interface AcceptanceRunState {
  running: boolean;
  done: number;
  total: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** 验收指标报表：从真实调用日志统计，对照参数文档红线判定 */
export async function buildAcceptanceReport(db: Db) {
  const llm = await db.query(`
    select count(*) as total,
      count(*) filter (where outcome = 'success' and first_char_at is not null) as ok,
      percentile_cont(0.5) within group (order by extract(epoch from (first_char_at - received_at)) * 1000)
        filter (where first_char_at is not null) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from (first_char_at - received_at)) * 1000)
        filter (where first_char_at is not null) as p95,
      percentile_cont(0.99) within group (order by extract(epoch from (first_char_at - received_at)) * 1000)
        filter (where first_char_at is not null) as p99,
      count(*) filter (where first_char_at is not null
        and extract(epoch from (first_char_at - received_at)) * 1000 <= ${ACCEPTANCE_THRESHOLDS.ttftTargetMs}) as within3s,
      count(*) filter (where first_char_at is not null
        and extract(epoch from (first_char_at - received_at)) * 1000 <= ${ACCEPTANCE_THRESHOLDS.ttftMaximumMs}) as within10s,
      coalesce(sum(valid_chars) filter (where completed_at is not null and first_char_at is not null), 0) as chars,
      coalesce(sum(extract(epoch from (completed_at - first_char_at)))
        filter (where completed_at is not null and first_char_at is not null), 0) as gen_seconds
    from conversation_metrics`);
  const voice = await db.query(`
    select kind, count(*) as total, round(avg(elapsed_ms)) as avg_ms, max(elapsed_ms) as max_ms,
      count(*) filter (where elapsed_ms <= ${ACCEPTANCE_THRESHOLDS.voiceMaximumMs} and outcome = 'success') as within5s,
      count(*) filter (where outcome = 'success') as ok
    from voice_metrics group by kind`);
  const row = llm.rows[0];
  const okCount = Number(row.ok);
  const ttftRate3s = okCount > 0 ? Number(row.within3s) / okCount : null;
  const ttftRate10s = okCount > 0 ? Number(row.within10s) / okCount : null;
  const charsPerSecond = Number(row.gen_seconds) > 0 ? Math.round(Number(row.chars) / Number(row.gen_seconds)) : null;
  const voiceStats = Object.fromEntries(
    voice.rows.map((v) => [v.kind, {
      total: Number(v.total),
      avgMs: Number(v.avg_ms),
      maxMs: Number(v.max_ms),
      within5sRate: Number(v.ok) > 0 ? Number(v.within5s) / Number(v.ok) : null,
    }]),
  );
  return {
    thresholds: ACCEPTANCE_THRESHOLDS,
    llm: {
      totalRequests: Number(row.total),
      validRequests: okCount,
      sampleEnough: okCount >= ACCEPTANCE_THRESHOLDS.acceptanceConversationSamples,
      ttftP50: row.p50 !== null ? Math.round(Number(row.p50)) : null,
      ttftP95: row.p95 !== null ? Math.round(Number(row.p95)) : null,
      ttftP99: row.p99 !== null ? Math.round(Number(row.p99)) : null,
      ttftRate3s,
      ttftRate10s,
      charsPerSecond,
      passTtft: ttftRate3s !== null && ttftRate3s >= ACCEPTANCE_THRESHOLDS.ttftTargetPassRate && ttftRate10s === 1,
      passSpeed: charsPerSecond !== null && charsPerSecond >= ACCEPTANCE_THRESHOLDS.minOutputCharactersPerSecond,
    },
    voice: voiceStats,
  };
}

/** 后台验收测试：对当前 Provider 发起 N 次真实对话请求并记录指标（进度存 app_settings） */
export async function runAcceptanceTest(
  db: Db,
  provider: ConversationProvider,
  samples: number,
): Promise<void> {
  const state: AcceptanceRunState = {
    running: true, done: 0, total: samples, startedAt: new Date().toISOString(),
  };
  await setSetting(db, "acceptance_run", state);
  try {
    const admin = await db.query("select id from users where role = 'admin' limit 1");
    const persona = composePersonaWithRule([], {});
    const conversation = await db.query(
      `insert into conversations (student_id, scenario_id, persona, status)
       values ($1, 'PRE-001', $2, 'closed') returning id`,
      [admin.rows[0].id, JSON.stringify(persona)],
    );
    const conversationId = conversation.rows[0].id as string;
    const prompts = [
      "Hi, is this product available in blue?",
      "How long does shipping to the US usually take?",
      "Can I get a discount if I order three?",
      "What is your return policy for damaged items?",
      "Does it come with a warranty?",
    ];
    for (let index = 0; index < samples; index += 1) {
      const receivedAt = new Date();
      let firstCharAt: Date | null = null;
      let chars = 0;
      let outcome: "success" | "error" | "timeout" = "success";
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 30_000);
      try {
        const stream = provider.streamReply(
          {
            conversationId,
            scenePrompt: "Acceptance benchmark: reply briefly as the buyer.",
            personaSnapshot: persona as never,
            orderSnapshot: {},
            history: [{ role: "student", content: prompts[index % prompts.length]! }],
          },
          abort.signal,
        );
        for await (const chunk of stream) {
          if (chunk.text) {
            if (!firstCharAt) firstCharAt = new Date();
            chars += chunk.text.length;
          }
          if (chunk.done) break;
        }
        if (!firstCharAt) outcome = "error";
      } catch {
        outcome = abort.signal.aborted ? "timeout" : "error";
      } finally {
        clearTimeout(timer);
      }
      await db.query(
        `insert into conversation_metrics
           (conversation_id, received_at, first_char_at, completed_at, valid_chars, provider, model, outcome)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [conversationId, receivedAt, firstCharAt, new Date(), chars, provider.providerId, provider.modelId, outcome],
      );
      state.done = index + 1;
      await setSetting(db, "acceptance_run", state);
    }
    state.running = false;
    state.finishedAt = new Date().toISOString();
    await setSetting(db, "acceptance_run", state);
  } catch (error) {
    state.running = false;
    state.error = String(error).slice(0, 200);
    await setSetting(db, "acceptance_run", state);
  }
}

export async function getAcceptanceRunState(db: Db): Promise<AcceptanceRunState | null> {
  return getSetting<AcceptanceRunState>(db, "acceptance_run");
}
