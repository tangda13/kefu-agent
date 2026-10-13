/**
 * Agent 评测集（J8）：脚本扮演学生，自动跑典型场景，检查买家 Agent 是否“变差”。改提示词、换模型后跑一遍对比。
 *
 *   pnpm --filter @cecs/api agent-eval              # 快速集：4 个用例 × 8 轮
 *   pnpm --filter @cecs/api agent-eval -- --full    # 完整集：8 个用例，含 20 轮长对话
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
import { buildBuyerMessages, BUYER_PROMPT_VERSION } from "../prompts/buyer";
import { DIRECTOR_PROMPT_VERSION } from "../prompts/director";
import { directTurn, type SessionState } from "../director";
import { z } from "zod";

type StudentStyle = "helpful" | "unhelpful";

interface EvalCase {
  id: string;
  scenarioId: string;
  personaId: string;
  style: StudentStyle;
  turns: number;
  /** 期望：helpful 应在轮数内满意离开；unhelpful 满意度应下降 */
  note: string;
}

const QUICK: EvalCase[] = [
  { id: "after-helpful-en", scenarioId: "AFTER-001", personaId: "P-001", style: "helpful", turns: 8, note: "货损退款，学员积极处理 → 买家应满意并主动结束" },
  { id: "after-unhelpful-en", scenarioId: "AFTER-001", personaId: "P-010", style: "unhelpful", turns: 8, note: "货损退款，学员敷衍 → 满意度下降、情绪恶化" },
  { id: "logistics-fr", scenarioId: "IN-002", personaId: "P-003", style: "helpful", turns: 8, note: "法语买家清关延误 → 全程法语" },
  { id: "presale-es", scenarioId: "PRE-001", personaId: "P-008", style: "helpful", turns: 8, note: "西语买家售前咨询 → 全程西语" },
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
    const product = products[Math.floor(Math.random() * products.length)]!;
    personaSnapshot.interestedProduct = { name: product.name, spec: product.spec, price: product.price };
  }
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
      buildBuyerMessages({ scenePrompt: `${scenario.name}：${scenario.objective}`, script: scenario.script, personaSnapshot, orderSnapshot, sessionState: state, history }),
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
            transcript: history.slice(-12).map((item) => ({ sender: item.role, content: item.content })),
          },
          state,
        );
        satisfaction.push(state.satisfaction ?? 60);
        emotions.push(state.emotion ?? "-");
      } catch (error) {
        errors.push(`director: ${(error as Error).message}`);
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
  const langs = buyerTexts.map(guessLanguage);
  const wrongLang = langs.filter((language) => language !== "unknown" && language !== persona.language).length;
  checks.push({
    name: `全程使用 ${persona.language}`,
    pass: wrongLang <= Math.floor(buyerTexts.length * 0.2),
    detail: `${buyerTexts.length} 条中 ${wrongLang} 条疑似其他语种`,
  });
  const avgWords = buyerTexts.reduce((sum, text) => sum + text.split(/\s+/).length, 0) / Math.max(buyerTexts.length, 1);
  const listLike = buyerTexts.some((text) => /^\s*([-*•]|\d+\.)\s/m.test(text));
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

  console.log(`买家 ${gateway.describe("dialogue")?.profileName}/${gateway.describe("dialogue")?.model}，导演 ${gateway.describe("director")?.model}，学生模拟 ${gateway.describe("assist")?.model}`);
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
    `- 导演：${gateway.describe("director")?.model}（${DIRECTOR_PROMPT_VERSION}）`,
    `- 检查项通过 ${passedChecks}/${totalChecks}`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.testCase.id}（${result.testCase.scenarioId} · ${result.testCase.personaId} · 学员${result.testCase.style === "helpful" ? "积极" : "敷衍"}）`, "", result.testCase.note, "");
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
