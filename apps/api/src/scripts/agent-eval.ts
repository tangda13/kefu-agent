/**
 * Agent 评测集（J8）：脚本扮演学生，自动跑典型场景，检查买家 Agent 是否“变差”。改提示词、换模型后跑一遍对比。
 *
 *   pnpm --filter @cecs/api agent-eval              # 快速集：4 个用例 × 8 轮 + 1 个真实议价会话回放（4 个关键回合 × 3 次）
 *   pnpm --filter @cecs/api agent-eval -- --full    # 完整集：9 个用例，含 20 轮长对话
 *   pnpm --filter @cecs/api agent-eval -- --turns 12 --case AFTER-001
 *
 * 用开发库里当前生效的模型档案（管理端配置）真实调用，会产生少量费用；对话只在内存里进行，不写会话表。
 * 报告输出到 apps/api/eval-reports/（已 gitignore）。
 */
import fs from "node:fs";
import path from "node:path";
import { composePersonaWithRule, generateOrderForScenario, personaTemplates } from "@cecs/domain";
import type { BusinessStage, ScenarioScript } from "@cecs/contracts";
import { loadEnv } from "../env";
import { createPool } from "../db";
import { LlmGateway, type ChatMessage } from "../llm/gateway";
import { createSecretSealer } from "../llm/secret";
import { buildBuyerMessages, BUYER_PROMPT_VERSION, hasChineseLeak, trimHistory } from "../prompts/buyer";
import { DIRECTOR_HISTORY_CHAR_BUDGET, DIRECTOR_PROMPT_VERSION } from "../prompts/director";
import { directTurn, type SessionState } from "../director";
import { HAGGLE_REPLAY, type ReplayFixture } from "./agent-eval-fixtures";
import { z } from "zod";

/**
 * replay：以真实会话为前文，只在关键回合重新生成买家回复逐条判。
 * （试过让学员按固定台词自由跑，台词跟不上买家的问题，制造出不真实的错位，判官分不清是编造还是合理推断，弃用。）
 */
type StudentStyle = "helpful" | "unhelpful" | "replay";

interface EvalCase {
  id: string;
  scenarioId: string;
  personaId: string;
  style: StudentStyle;
  turns: number;
  /** 期望：helpful 应在轮数内满意离开；unhelpful 满意度应下降 */
  note: string;
  /** 售前用例固定买家感兴趣的商品（按商品名；店里没有就随机） */
  product?: string;
  /** replay 用例的真实会话和每个关键回合的采样次数 */
  replay?: ReplayFixture;
  samples?: number;
}

const QUICK: EvalCase[] = [
  { id: "after-helpful-en", scenarioId: "AFTER-001", personaId: "P-001", style: "helpful", turns: 8, note: "货损退款，学员积极处理 → 买家应满意并主动结束" },
  { id: "after-unhelpful-en", scenarioId: "AFTER-001", personaId: "P-010", style: "unhelpful", turns: 8, note: "货损退款，学员敷衍 → 满意度下降、情绪恶化" },
  { id: "logistics-fr", scenarioId: "IN-002", personaId: "P-003", style: "helpful", turns: 8, note: "清关延误（画像现为德国买家，D-33 后模板变了，id 沿用）→ 全程用母语" },
  { id: "presale-es", scenarioId: "PRE-001", personaId: "P-008", style: "helpful", turns: 8, note: "批发采购商售前咨询（画像现为德国买家，id 沿用）→ 全程用母语" },
  {
    id: "haggle-replay-es",
    scenarioId: "PRE-005",
    personaId: "P-031",
    style: "replay",
    turns: 0,
    replay: HAGGLE_REPLAY,
    samples: 3,
    product: "收腰短袖V领度假长裙",
    note: "真实议价会话回放（D-50 起因）：学员报错价格、混用元和美元后又讲清楚 → 买家不漏中文、不编造客服原话、不原样再问刚答过的问题；T4 澄清后是否还揪着看回复人工判断",
  },
];

const FULL: EvalCase[] = [
  ...QUICK,
  { id: "review-recover", scenarioId: "AFTER-002", personaId: "P-018", style: "helpful", turns: 10, note: "差评挽回 → 有诚意时愿意改评" },
  { id: "payment-pressure", scenarioId: "IN-001", personaId: "P-004", style: "unhelpful", turns: 8, note: "催付施压 → 买家不满" },
  { id: "care-returning", scenarioId: "CARE-001", personaId: "P-002", style: "helpful", turns: 8, note: "老客复购 → 个性化推荐" },
  { id: "long-20-turns", scenarioId: "AFTER-001", personaId: "P-005", style: "helpful", turns: 20, note: "20 轮长对话连贯性（学员刻意拖长，反复确认细节）" },
];

const AI_LEAK = /\b(as an ai|an ai (language )?model|language model|ai assistant|i am an ai|i'm an ai|chatbot|training (system|scenario)|role-?play|director)\b|我是\s*ai|人工智能|模拟训练/i;
const END_MARK = "[END_OF_SERVICE]";

const LANGUAGE_WORDS: Record<string, string[]> = {
  "en-US": ["the", "and", "is", "my", "you", "it", "to", "i"],
  "fr-FR": ["le", "la", "les", "est", "mon", "ma", "vous", "je", "pas", "et", "de", "c'est"],
  "es-ES": ["el", "la", "los", "es", "mi", "usted", "yo", "no", "y", "de", "que", "por"],
  "de-DE": ["der", "die", "das", "ist", "und", "nicht", "ich", "mein", "sie", "zu", "mir", "es"],
};

/** 粗略语种判断：目标语种常用词命中比例最高即视为该语种 */
function guessLanguage(text: string): string {
  const words = text.toLowerCase().split(/[^a-zà-ÿ']+/).filter(Boolean);
  let best = "unknown";
  let bestScore = 0;
  for (const [language, list] of Object.entries(LANGUAGE_WORDS)) {
    const score = words.filter((word) => list.includes(word)).length / Math.max(words.length, 1);
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  return best;
}

function studentSystemPrompt(style: StudentStyle, language: string, longMode: boolean, storeContext: string): string {
  const behavior =
    style === "helpful"
      ? "You are a competent, polite cross-border e-commerce customer service agent. Apologize when appropriate, ask for the key facts (order number, photos, details), and propose concrete solutions (refund, replacement, tracking update, discount)."
      : "You are a poorly performing customer service agent: give vague, generic answers, avoid commitments, deflect responsibility ('please wait', 'that is the courier's problem'), and never offer compensation.";
  return [
    behavior,
    `Write in ${language}. Keep each reply to 1-3 short sentences, like live chat. Output only the reply text.`,
    `What you can see in your workbench (use it, do not invent other facts): ${storeContext}`,
    longMode
      ? "Keep the conversation going: double-check details one at a time, confirm what was agreed earlier, and do not wrap up quickly."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const coherenceSchema = z.object({
  consistent: z.boolean(),
  issues: z.array(z.string()).default([]),
});

const replayVerdictSchema = z.object({
  ok: z.boolean(),
  reason: z.string().default(""),
});

/** 回放判官：只判买家最新一条回复，客服最后一条消息是什么一目了然，比判整段对话可靠得多 */
function buildReplayJudgeMessages(history: ReplayFixture["transcript"], reply: string): ChatMessage[] {
  const chat = history.map((item) => `${item.role === "buyer" ? "买家" : "客服"}: ${item.content}`).join("\n");
  return [
    {
      role: "system",
      content:
        // 只判能对着原文核对的两种；“客服改了好几次价我不信了”这类对真实失误的抱怨，flash 判官分不清，不算
        "你在检查客服对话里买家的最新一条回复（客服的失误是真实发生的，不用管客服）。只判断这条新回复有没有以下问题：" +
        "①说客服讲过某个内容，而聊天记录里客服的消息根本没有这个意思（编造）；" +
        "②客服最后一条消息刚回答了某个具体问题，买家又原样再问同一个问题（比如客服刚说单价 9.4 含运费，买家又问“最终单价到底多少”）。" +
        "以下不算问题：对客服真实的失误不满或表示不信任（客服确实改过价、混过币种）；继续砍价、要赠品；追问客服还没回答的问题；买家引用自己说过的话。" +
        '只输出 JSON：{"ok":true或false,"reason":"一句话说明"}，没有问题 ok=true。',
    },
    { role: "user", content: `聊天记录：\n${chat}\n\n【买家新回复】${reply}` },
  ];
}

async function runReplayCase(
  gateway: LlmGateway,
  testCase: EvalCase,
  scenario: { name: string; objective: string; script: ScenarioScript | null },
  personaSnapshot: Record<string, unknown>,
): Promise<CaseResult> {
  const replay = testCase.replay!;
  const samples = testCase.samples ?? 3;
  const language = String(personaSnapshot.language);
  const transcript: CaseResult["transcript"] = [];
  const errors: string[] = [];
  const problems: string[] = [];
  const calibration: string[] = [];
  let calibrated = true;
  let total = 0;
  let leaks = 0;
  for (const key of replay.keyTurns) {
    const history = replay.transcript.slice(0, key.index + 1);
    const judge = (reply: string) => gateway.completeJson("assessment", buildReplayJudgeMessages(history, reply), replayVerdictSchema).then((result) => result.data);
    // 校准：改前的原回复该判出问题的要判出来，否则这次判官的结论不可信
    const original = await judge(key.original).catch(() => null);
    const flagged = original ? !original.ok : null;
    if (flagged !== key.expectFlag) calibrated = false;
    calibration.push(`${key.label}：原回复${flagged === null ? "判官出错" : flagged ? "判为有问题" : "判为正常"}（应${key.expectFlag ? "有问题" : "正常"}）`);
    transcript.push({ role: "student", content: `【${key.label}】${history.at(-1)!.content}` });
    for (let i = 0; i < samples; i += 1) {
      let text = "";
      try {
        for await (const part of gateway.stream(
          "dialogue",
          buildBuyerMessages({ scenePrompt: `${scenario.name}：${scenario.objective}`, script: scenario.script, personaSnapshot, orderSnapshot: {}, history }),
        )) {
          text += part;
        }
      } catch (error) {
        errors.push(`dialogue: ${(error as Error).message}`);
        continue;
      }
      const reply = text.replace(END_MARK, "").split("|||").map((part) => part.trim()).filter(Boolean).join(" ||| ");
      total += 1;
      if (hasChineseLeak(reply, language)) leaks += 1;
      transcript.push({ role: "buyer", content: reply });
      const verdict = await judge(reply).catch((error) => {
        errors.push(`judge: ${(error as Error).message}`);
        return null;
      });
      if (verdict && !verdict.ok) problems.push(`${key.label}“${reply.slice(0, 60)}”：${verdict.reason}`);
    }
  }
  const checks: CaseResult["checks"] = [
    { name: "不漏中文", pass: leaks === 0, detail: `${total} 条回复中 ${leaks} 条漏中文（模型原样输出，服务端另有改写兜底）` },
    { name: "不编造客服原话、不原样再问刚答过的问题", pass: problems.length === 0, detail: problems.join("；") || `${total} 条回复均正常` },
    { name: "判官校准（改前原回复）", pass: calibrated, detail: calibration.join("；") },
  ];
  return { testCase, turnsRun: replay.keyTurns.length, ended: false, checks, transcript, satisfaction: [], emotions: [], errors };
}

interface CaseResult {
  testCase: EvalCase;
  turnsRun: number;
  ended: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  transcript: Array<{ role: "buyer" | "student"; content: string }>;
  satisfaction: number[];
  emotions: string[];
  errors: string[];
}

type ProductRow = { name: string; spec: string; price: number; imageUrl: null };

async function runCase(
  gateway: LlmGateway,
  testCase: EvalCase,
  scenario: { name: string; objective: string; stage: BusinessStage; script: ScenarioScript | null },
  products: ProductRow[],
): Promise<CaseResult> {
  const persona = personaTemplates.find((item) => item.id === testCase.personaId)!;
  // 模板是一类买家（D-32），和真实会话一样组合出具体买家（随机姓名、性别）
  const personaSnapshot = composePersonaWithRule([persona]) as unknown as Record<string, unknown>;
  // 与真实实训一致：售中/售后/维护场景生成订单；售前给买家一个在售的感兴趣商品
  const order = generateOrderForScenario(scenario.stage, Math.random, new Date(), products, { name: String(personaSnapshot.name), nationality: persona.nationality });
  if (scenario.stage === "pre_sale" && products.length) {
    const product = products.find((item) => item.name === testCase.product) ?? products[Math.floor(Math.random() * products.length)]!;
    personaSnapshot.interestedProduct = { name: product.name, spec: product.spec, price: product.price };
  }
  if (testCase.style === "replay") return runReplayCase(gateway, testCase, scenario, personaSnapshot);
  const orderSnapshot = (order ?? {}) as unknown as Record<string, unknown>;
  const storeContext = order
    ? `the buyer's order ${JSON.stringify(order)}`
    : `the store's product catalog ${JSON.stringify(products.map((item) => ({ name: item.name, spec: item.spec, price: item.price })))}`;
  const history: Array<{ role: "buyer" | "student"; content: string }> = [];
  let state: SessionState = { emotion: persona.emotion, satisfaction: 60 };
  const satisfaction: number[] = [];
  const emotions: string[] = [];
  const errors: string[] = [];
  const rawBuyer: string[] = [];
  let ended = false;
  let turnsRun = 0;

  const buyerTurn = async () => {
    let text = "";
    for await (const part of gateway.stream(
      "dialogue",
      buildBuyerMessages({ scenePrompt: `${scenario.name}：${scenario.objective}`, script: scenario.script, personaSnapshot, orderSnapshot, history }),
    )) {
      text += part;
    }
    rawBuyer.push(text);
    const hasMark = text.includes(END_MARK);
    const clean = text.replace(END_MARK, "").trim();
    for (const segment of clean.split("|||").map((item) => item.trim()).filter(Boolean)) history.push({ role: "buyer", content: segment });
    return hasMark;
  };

  try {
    ended = await buyerTurn();
    while (!ended && turnsRun < testCase.turns) {
      turnsRun += 1;
      const studentMessages: ChatMessage[] = [
        { role: "system", content: studentSystemPrompt(testCase.style, persona.language, testCase.turns > 12, storeContext) },
        ...history.map((item): ChatMessage => ({ role: item.role === "buyer" ? "user" : "assistant", content: item.content })),
      ];
      const { text: studentReply } = await gateway.complete("assist", studentMessages, { temperature: 0.7, maxTokens: 200 });
      history.push({ role: "student", content: studentReply });
      ended = await buyerTurn();
      try {
        state = await directTurn(
          gateway,
          {
            persona: personaSnapshot,
            scenarioName: scenario.name,
            objective: scenario.objective,
            script: scenario.script,
            previous: state,
            transcript: trimHistory(history, DIRECTOR_HISTORY_CHAR_BUDGET).map((item) => ({ sender: item.role, content: item.content })),
          },
          state,
        );
        satisfaction.push(state.satisfaction ?? 60);
        emotions.push(state.emotion ?? "-");
      } catch (error) {
        errors.push(`observer: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    errors.push(`dialogue: ${(error as Error).message}`);
  }

  const buyerTexts = history.filter((item) => item.role === "buyer").map((item) => item.content);
  const checks: CaseResult["checks"] = [];
  const leak = buyerTexts.find((text) => AI_LEAK.test(text));
  checks.push({ name: "不暴露 AI 身份", pass: !leak, detail: leak ? `命中：“${leak.slice(0, 80)}”` : "未发现" });
  const misplacedMark = rawBuyer.find((text) => text.includes(END_MARK) && !text.trimEnd().endsWith(END_MARK));
  checks.push({ name: "结束标记位置正确", pass: !misplacedMark, detail: misplacedMark ? `标记不在末尾：“${misplacedMark.slice(0, 80)}”` : "正常" });
  // 买家语言按国籍母语（D-44），以组合出来的具体买家为准，不看模板上的旧字段
  const buyerLanguage = String(personaSnapshot.language ?? persona.language);
  const langs = buyerTexts.map(guessLanguage);
  const wrongLang = langs.filter((language) => language !== "unknown" && language !== buyerLanguage).length;
  checks.push({
    name: `全程使用 ${buyerLanguage}`,
    pass: wrongLang <= Math.floor(buyerTexts.length * 0.2),
    detail: `${buyerTexts.length} 条中 ${wrongLang} 条疑似其他语种`,
  });
  // 测的是模型原样输出：实时回复在服务端还有一道改写兜底，评测不走那一步
  const chinese = buyerTexts.filter((text) => hasChineseLeak(text, buyerLanguage));
  checks.push({ name: "不漏中文", pass: chinese.length === 0, detail: chinese.length ? `${chinese.length} 条：“${chinese[0]!.slice(0, 60)}”` : "未发现" });
  const avgWords = buyerTexts.reduce((sum, text) => sum + text.split(/\s+/).length, 0) / Math.max(buyerTexts.length, 1);
  // 一条里至少两行列表项才算列表（德语日期“12. Oktober”开头不算）
  const listLike = buyerTexts.some((text) => (text.match(/^\s*([-*•]|\d+\.)\s/gm) ?? []).length >= 2);
  checks.push({ name: "聊天口吻（短句、无列表）", pass: avgWords <= 30 && !listLike, detail: `平均 ${avgWords.toFixed(1)} 词${listLike ? "，出现列表格式" : ""}` });
  if (satisfaction.length >= 2) {
    const first = satisfaction[0]!;
    const last = satisfaction.at(-1)!;
    const expectUp = testCase.style === "helpful";
    checks.push({
      name: expectUp ? "情绪随良好服务缓和" : "情绪随敷衍服务恶化",
      pass: expectUp ? last >= first : last < first || last <= 40,
      detail: `满意度 ${satisfaction.join(" → ")}；情绪 ${emotions.join(" → ")}`,
    });
  }
  if (testCase.style === "helpful" && testCase.turns <= 10) {
    checks.push({ name: "问题解决后买家主动结束", pass: ended, detail: ended ? `第 ${turnsRun} 轮结束` : `${turnsRun} 轮内未结束` });
  }
  if (testCase.turns > 12) {
    try {
      const transcript = history.map((item) => `${item.role === "buyer" ? "Buyer" : "Agent"}: ${item.content}`).join("\n");
      const { data } = await gateway.completeJson(
        "assessment",
        [
          {
            role: "system",
            content:
              '你在检查一段长对话里“买家”的表现是否前后一致。只看买家：是否忘记或推翻了之前说过的事实（订单情况、损坏程度、已接受的方案、个人信息），是否重复问已经回答过的问题。只输出 JSON：{"consistent":true或false,"issues":["..."]}',
          },
          { role: "user", content: transcript },
        ],
        coherenceSchema,
      );
      checks.push({ name: `${history.length} 条消息内买家前后一致`, pass: data.consistent, detail: data.issues.join("；") || "未发现矛盾" });
    } catch (error) {
      errors.push(`coherence judge: ${(error as Error).message}`);
    }
  }
  return { testCase, turnsRun, ended, checks, transcript: history, satisfaction, emotions, errors };
}

function parseArgs(argv: string[]) {
  const args = { full: false, turns: 0, caseFilter: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--full") args.full = true;
    else if (argv[i] === "--turns") args.turns = Number(argv[++i]) || 0;
    else if (argv[i] === "--case") args.caseFilter = argv[++i] ?? "";
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
const db = createPool(env.databaseUrl);
const log = { warn: (obj: unknown, msg?: string) => console.warn(msg ?? "", obj), error: (obj: unknown, msg?: string) => console.error(msg ?? "", obj) };
try {
  const gateway = new LlmGateway(db, createSecretSealer(env.settingsEncryptionKey || env.jwtSecret), log);
  await gateway.reload();
  if (!gateway.isConfigured("dialogue")) {
    console.error("没有可用的模型档案：请先在管理端「AI 与语音服务」里配置并设为默认。");
    process.exit(1);
  }
  let cases = args.full ? FULL : QUICK;
  if (args.caseFilter) cases = cases.filter((item) => item.id === args.caseFilter || item.scenarioId === args.caseFilter);
  if (args.turns > 0) cases = cases.map((item) => ({ ...item, turns: args.turns }));
  const scenarioRows = await db.query("select id, name, objective, stage, script from scenarios");
  const scenarios = new Map(scenarioRows.rows.map((row) => [row.id as string, row]));
  const productRows = await db.query("select name, spec, price from store_products where enabled");
  const products: ProductRow[] = productRows.rows.map((row) => ({ name: row.name, spec: row.spec, price: Number(row.price), imageUrl: null }));

  console.log(`买家 ${gateway.describe("dialogue")?.profileName}/${gateway.describe("dialogue")?.model}，观察员 ${gateway.describe("director")?.model}，学生模拟 ${gateway.describe("assist")?.model}`);
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const scenario = scenarios.get(testCase.scenarioId);
    if (!scenario) continue;
    process.stdout.write(`- ${testCase.id} … `);
    const started = Date.now();
    const result = await runCase(gateway, testCase, scenario as never, products);
    results.push(result);
    const failed = result.checks.filter((check) => !check.pass).length;
    console.log(`${failed === 0 && result.errors.length === 0 ? "通过" : `${failed} 项未通过${result.errors.length ? `，${result.errors.length} 个错误` : ""}`}（${Math.round((Date.now() - started) / 1000)}s）`);
  }

  const totalChecks = results.reduce((sum, item) => sum + item.checks.length, 0);
  const passedChecks = results.reduce((sum, item) => sum + item.checks.filter((check) => check.pass).length, 0);
  const lines = [
    `# Agent 评测报告 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    "",
    `- 买家：${gateway.describe("dialogue")?.profileName} / ${gateway.describe("dialogue")?.model}（${BUYER_PROMPT_VERSION}）`,
    `- 观察员：${gateway.describe("director")?.model}（${DIRECTOR_PROMPT_VERSION}）`,
    `- 检查项通过 ${passedChecks}/${totalChecks}`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.testCase.id}（${result.testCase.scenarioId} · ${result.testCase.personaId} · 学员${{ helpful: "积极", unhelpful: "敷衍", replay: "真实会话回放" }[result.testCase.style]}）`, "", result.testCase.note, "");
    lines.push("| 检查 | 结果 | 说明 |", "|---|---|---|");
    for (const check of result.checks) lines.push(`| ${check.name} | ${check.pass ? "✅" : "❌"} | ${check.detail.replace(/\|/g, "/")} |`);
    if (result.errors.length) lines.push("", `错误：${result.errors.join("；")}`);
    lines.push("", "<details><summary>对话记录</summary>", "");
    for (const item of result.transcript) lines.push(`- **${item.role === "buyer" ? "买家" : "学员"}**：${item.content}`);
    lines.push("", "</details>", "");
  }
  const dir = path.resolve(process.cwd(), "eval-reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-eval-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  console.log(`\n检查项通过 ${passedChecks}/${totalChecks}，报告：${file}`);
} finally {
  await db.end();
}
