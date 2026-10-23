import { ACCEPTANCE_THRESHOLDS } from "@cecs/contracts";
import { composePersonaWithRule, planBuyerLedger } from "@cecs/domain";
import type { Db } from "./db";
import type { CallInfo, LlmGateway } from "./llm/gateway";
import { buildBuyerMessages } from "./prompts/buyer";
import { BuyerNoteSplitter } from "./prompts/buyer-note";
import { getSetting, setSetting } from "./settings";

export interface AcceptanceRunState {
  running: boolean;
  done: number;
  total: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** API 重启时还没跑完（L4）：停在 done/total，可以重新运行 */
  interrupted?: boolean;
}

const TTFT_MS = "extract(epoch from (first_char_at - received_at)) * 1000";

/**
 * 验收指标报表：从真实调用日志统计，对照参数文档红线判定。
 * 口径（B2）：首字从服务端收到请求那一刻算起；达标率的分母是全部请求（失败、超时都算未达标），
 * 失败与超时单独列出。since 为空时统计全部记录。
 */
export async function buildAcceptanceReport(db: Db, since?: string) {
  const params = since ? [since] : [];
  const where = since ? "where received_at >= $1" : "";
  const llm = await db.query(
    `select count(*) as total,
      count(*) filter (where outcome = 'success' and first_char_at is not null) as ok,
      count(*) filter (where outcome = 'error') as errors,
      count(*) filter (where outcome = 'timeout') as timeouts,
      percentile_cont(0.5) within group (order by ${TTFT_MS}) filter (where first_char_at is not null) as p50,
      percentile_cont(0.95) within group (order by ${TTFT_MS}) filter (where first_char_at is not null) as p95,
      percentile_cont(0.99) within group (order by ${TTFT_MS}) filter (where first_char_at is not null) as p99,
      max(${TTFT_MS}) filter (where first_char_at is not null) as max_ttft,
      count(*) filter (where outcome = 'success' and first_char_at is not null
        and ${TTFT_MS} <= ${ACCEPTANCE_THRESHOLDS.ttftTargetMs}) as within3s,
      count(*) filter (where outcome = 'success' and first_char_at is not null
        and ${TTFT_MS} <= ${ACCEPTANCE_THRESHOLDS.ttftMaximumMs}) as within10s,
      coalesce(sum(valid_chars) filter (where completed_at is not null and first_char_at is not null), 0) as chars,
      coalesce(sum(extract(epoch from (completed_at - first_char_at)))
        filter (where completed_at is not null and first_char_at is not null), 0) as gen_seconds
    from conversation_metrics ${where}`,
    params,
  );
  const voice = await db.query(
    `select kind, count(*) as total, round(avg(elapsed_ms)) as avg_ms, max(elapsed_ms) as max_ms,
      count(*) filter (where elapsed_ms <= ${ACCEPTANCE_THRESHOLDS.voiceMaximumMs} and outcome = 'success') as within5s,
      count(*) filter (where outcome = 'success') as ok
    from voice_metrics ${since ? "where created_at >= $1" : ""} group by kind`,
    params,
  );
  const failures = await db.query(
    `select received_at, model, outcome from conversation_metrics
     ${where ? `${where} and` : "where"} outcome <> 'success'
     order by received_at desc limit 20`,
    params,
  );
  const row = llm.rows[0];
  const total = Number(row.total);
  const okCount = Number(row.ok);
  const ttftRate3s = total > 0 ? Number(row.within3s) / total : null;
  const ttftRate10s = total > 0 ? Number(row.within10s) / total : null;
  const charsPerSecond = Number(row.gen_seconds) > 0 ? Math.round(Number(row.chars) / Number(row.gen_seconds)) : null;
  const voiceStats = Object.fromEntries(
    voice.rows.map((v) => [
      v.kind,
      {
        total: Number(v.total),
        avgMs: Number(v.avg_ms),
        maxMs: Number(v.max_ms),
        // 语音同样以全部请求为分母
        within5sRate: Number(v.total) > 0 ? Number(v.within5s) / Number(v.total) : null,
      },
    ]),
  );
  const round = (value: unknown) => (value !== null && value !== undefined ? Math.round(Number(value)) : null);
  return {
    thresholds: ACCEPTANCE_THRESHOLDS,
    since: since ?? null,
    llm: {
      totalRequests: total,
      validRequests: okCount,
      errorRequests: Number(row.errors),
      timeoutRequests: Number(row.timeouts),
      sampleEnough: total >= ACCEPTANCE_THRESHOLDS.acceptanceConversationSamples,
      ttftP50: round(row.p50),
      ttftP95: round(row.p95),
      ttftP99: round(row.p99),
      ttftMax: round(row.max_ttft),
      ttftRate3s,
      ttftRate10s,
      charsPerSecond,
      passTtft: ttftRate3s !== null && ttftRate3s >= ACCEPTANCE_THRESHOLDS.ttftTargetPassRate && ttftRate10s === 1,
      passSpeed: charsPerSecond !== null && charsPerSecond >= ACCEPTANCE_THRESHOLDS.minOutputCharactersPerSecond,
      recentFailures: failures.rows.map((item) => ({
        at: new Date(item.received_at).toISOString(),
        model: item.model as string,
        outcome: item.outcome as string,
      })),
    },
    voice: voiceStats,
  };
}

/** 验收证据导出：逐条请求明细（CSV，Excel 可直接打开） */
export async function exportAcceptanceCsv(db: Db, since?: string): Promise<string> {
  const result = await db.query(
    `select request_id, conversation_id, received_at, first_char_at, completed_at, valid_chars, provider, model, outcome,
            round(${TTFT_MS}) as ttft_ms,
            case when completed_at is not null and first_char_at is not null and completed_at > first_char_at
              then round(valid_chars / extract(epoch from (completed_at - first_char_at))) end as chars_per_second
     from conversation_metrics ${since ? "where received_at >= $1" : ""}
     order by received_at`,
    since ? [since] : [],
  );
  const header = ["请求ID", "会话ID", "收到请求", "首字时间", "完成时间", "首字耗时ms", "有效字符", "输出字符每秒", "档案", "模型", "结果"];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = result.rows.map((r) =>
    [r.request_id, r.conversation_id, r.received_at, r.first_char_at, r.completed_at, r.ttft_ms, r.valid_chars, r.chars_per_second, r.provider, r.model, r.outcome]
      .map(escape)
      .join(","),
  );
  // BOM：Excel 按 UTF-8 识别中文表头
  return `﻿${[header.join(","), ...lines].join("\r\n")}\r\n`;
}

/** 后台验收测试：对“买家对话”当前生效档案发起 N 次真实对话请求并记录指标（进度存 app_settings） */
export async function runAcceptanceTest(db: Db, gateway: LlmGateway, samples: number): Promise<void> {
  const state: AcceptanceRunState = {
    running: true,
    done: 0,
    total: samples,
    startedAt: new Date().toISOString(),
  };
  await setSetting(db, "acceptance_run", state);
  try {
    const admin = await db.query("select id from users where role = 'admin' limit 1");
    const persona = composePersonaWithRule([], {});
    // 用真实的场景剧本和买家提示词压测（含两本账，买家每条先写判断，D-90），口径与学生实训一致
    const scenario = await db.query("select name, objective, stage, script from scenarios where id = 'AFTER-001'");
    const scene = scenario.rows[0];
    const ledger = planBuyerLedger({ stage: scene?.stage ?? "after_sale", goal: scene?.script?.buyerGoal ?? scene?.objective, persona });
    const conversation = await db.query(
      `insert into conversations (student_id, scenario_id, persona, status)
       values ($1, 'AFTER-001', $2, 'closed') returning id`,
      [admin.rows[0].id, JSON.stringify(persona)],
    );
    const conversationId = conversation.rows[0].id as string;
    const prompts = [
      "Hi, sorry to hear that. Could you tell me what happened to the item?",
      "I understand. Could you send me a photo of the damage?",
      "Thanks. We can offer a partial refund or send a replacement part. Which do you prefer?",
      "Of course. The refund will reach your account in 3-5 business days.",
      "Is there anything else I can help you with?",
    ];
    for (let index = 0; index < samples; index += 1) {
      const receivedAt = new Date();
      let firstCharAt: Date | null = null;
      let chars = 0;
      let outcome: "success" | "error" | "timeout" = "success";
      let info: CallInfo | null = null;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 30_000);
      try {
        const messages = buildBuyerMessages({
          scenePrompt: scene ? `${scene.name}：${scene.objective}` : "After-sale damage refund.",
          script: scene?.script ?? null,
          personaSnapshot: persona as never,
          orderSnapshot: {},
          history: [{ role: "student", content: prompts[index % prompts.length]! }],
          ledger,
        });
        // 首字是学生看到的第一个字：开头那段判断不算
        const splitter = new BuyerNoteSplitter();
        for await (const text of gateway.stream("dialogue", messages, {
          signal: abort.signal,
          conversationId,
          onInfo: (value) => {
            info = value;
          },
        })) {
          const visible = splitter.push(text);
          if (!visible) continue;
          if (!firstCharAt) firstCharAt = new Date();
          chars += visible.length;
        }
        const rest = splitter.finish();
        if (rest) {
          firstCharAt ??= new Date();
          chars += rest.length;
        }
        if (!firstCharAt) outcome = "error";
      } catch {
        outcome = abort.signal.aborted ? "timeout" : "error";
      } finally {
        clearTimeout(timer);
      }
      const used = info as CallInfo | null;
      await db.query(
        `insert into conversation_metrics
           (conversation_id, received_at, first_char_at, completed_at, valid_chars, provider, model, outcome)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          conversationId,
          receivedAt,
          firstCharAt,
          new Date(),
          chars,
          used?.profileName ?? gateway.describe("dialogue")?.profileName ?? "unconfigured",
          used?.model ?? gateway.describe("dialogue")?.model ?? "unconfigured",
          outcome,
        ],
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

/** API 启动时调用（L4）：上次没跑完的验收进程已经没了，标成“已中断”，否则会一直显示运行中、也不能重新运行 */
export async function closeInterruptedAcceptance(db: Db): Promise<boolean> {
  const state = await getAcceptanceRunState(db);
  if (!state?.running) return false;
  await setSetting(db, "acceptance_run", { ...state, running: false, interrupted: true, finishedAt: new Date().toISOString() });
  return true;
}
