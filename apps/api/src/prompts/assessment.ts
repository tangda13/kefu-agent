import { z } from "zod";
import { AI_ASSESSMENT_DIMENSIONS, BUSINESS_STAGE_LABELS, type BusinessStage, type ScenarioScript } from "@cecs/contracts";
import type { ResponsivenessResult } from "@cecs/domain";
import type { ChatMessage } from "../llm/gateway";

export const ASSESSMENT_PROMPT_VERSION = "assessment@2026-10-14";

/** 评分读全量对话；超过这个长度时先分段摘要再评分（J4） */
export const ASSESSMENT_FULL_TEXT_LIMIT = 24_000;
export const ASSESSMENT_CHUNK_SIZE = 8_000;

const dimensionScore = z.coerce.number().min(0).max(100).transform((value) => Math.round(value));

/** 模型只给 AI 维度打分；消息响应时效由系统计算（D-46）。个别维度漏给时由调用方兜底 */
export const assessmentOutputSchema = z.object({
  scores: z.object(
    Object.fromEntries(AI_ASSESSMENT_DIMENSIONS.map((item) => [item.id, dimensionScore.optional()])) as Record<
      (typeof AI_ASSESSMENT_DIMENSIONS)[number]["id"],
      z.ZodOptional<typeof dimensionScore>
    >,
  ),
  comment: z.string().max(600).default(""),
  suggestions: z.array(z.string().max(300)).max(5).default([]),
});
export type AssessmentOutput = z.infer<typeof assessmentOutputSchema>;

/** 客观依据（J7、D-46）：违规词命中、导演逐轮得分、系统算的响应时效，一起交给评分模型并随评分留底 */
export interface AssessmentEvidence {
  forbiddenHits: Array<{ term: string; excerpt: string }>;
  turnScores: number[];
  summarized: boolean;
  responsiveness?: ResponsivenessResult;
  /** 评分时有没有拿到商品资料（商品信息准确性的依据） */
  hasProductFacts?: boolean;
}

export function formatTranscript(rows: Array<{ sender: string; content: string }>): string {
  return rows
    .map((row) => `${row.sender === "buyer" ? "Buyer" : row.sender === "student" ? "Agent" : "Teacher"}: ${row.content}`)
    .join("\n");
}

function responsivenessLine(result: ResponsivenessResult | undefined): string {
  if (!result || result.score == null) return "无";
  return (
    `首次响应 ${result.firstReplySec} 秒，平均 ${result.avgReplySec} 秒，超过 2 分钟才回 ${result.slowReplies} 次` +
    (result.leftWaiting ? "，买家等不到回复离开" : "")
  );
}

export function buildAssessmentMessages(input: {
  scenarioName: string | null;
  objective: string | null;
  stage?: BusinessStage | null;
  script?: ScenarioScript | null;
  productFacts?: string | null;
  transcript: string;
  evidence: AssessmentEvidence;
}): ChatMessage[] {
  const dims = AI_ASSESSMENT_DIMENSIONS.map((item) => `- ${item.id}（${item.label}）：${item.hint}`).join("\n");
  const example = Object.fromEntries(AI_ASSESSMENT_DIMENSIONS.map((item) => [item.id, 80]));
  const hits = input.evidence.forbiddenHits.length
    ? input.evidence.forbiddenHits.map((hit) => `“${hit.term}”（原句：${hit.excerpt}）`).join("；")
    : "无";
  const turns = input.evidence.turnScores.length ? input.evidence.turnScores.join(", ") : "无";
  const system =
    "你是跨境电商客服实训评分专家。根据买家与客服学员（Agent）的对话记录，" +
    `从下面 ${AI_ASSESSMENT_DIMENSIONS.length} 个维度打分（0-100 整数）：\n${dims}\n` +
    "并写一段不超过 80 字的中文总评，以及 2-3 条中文改进建议。\n" +
    "系统提供的客观依据必须纳入考量：\n" +
    "- 命中违规用语时，compliance 应明显扣分并在总评中指出；导演逐轮得分反映学员表现的走势。\n" +
    "- knowledge：把学员说到的规格、价格、库存、物流时效、退换和运费政策逐条和“店铺商品资料”对照，说错或编造要明显扣分；" +
    "资料里没有的信息，学员说“核实后答复”不扣分；没有提供资料时，只看有没有编造和乱承诺。\n" +
    "- 场景剧本里的“隐藏信息”学员有没有问出来，计入 effectiveness；剧本“结束条件”对应的业务结果（下单、挽回、满意离开）计入 resolution。\n" +
    "- 消息响应时效由系统另行计算，不用你打分；明显偏慢时可以在总评或建议里提一句。\n" +
    `只返回一个 JSON 对象：${JSON.stringify({ scores: example, comment: "...", suggestions: ["...", "..."] })}`;
  const script = input.script
    ? `场景剧本：买家目标=${input.script.buyerGoal}；隐藏信息=${input.script.hiddenInfo}；结束条件=${input.script.endConditions}\n`
    : "";
  const user =
    `训练场景：${input.scenarioName ?? "通用客服对话"}` +
    (input.stage ? `（业务环节：${BUSINESS_STAGE_LABELS[input.stage]}）` : "") +
    `（目标：${input.objective ?? "-"}）\n` +
    script +
    `店铺商品资料：${input.productFacts ? `\n${input.productFacts}` : "无"}\n` +
    `客观依据——违规用语命中：${hits}\n` +
    `客观依据——导演逐轮得分（按时间顺序）：${turns}\n` +
    `客观依据——系统计算的响应时效：${responsivenessLine(input.evidence.responsiveness)}\n` +
    (input.evidence.summarized ? "（对话较长，前半部分为分段摘要，最后一段为原文）\n" : "") +
    `对话记录：\n${input.transcript}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 邮件任务评分（D-58）：评六项——服务话术规范、客户沟通有效性、订单问题解决（邮件里看行动号召）、商品信息准确性、
 * 语法准确性、违规用语合规；客户情绪安抚、消息响应时效不评（总分只算有分的维度）
 */
export const MAIL_ASSESSMENT_DIMENSION_IDS = ["professionalism", "effectiveness", "resolution", "knowledge", "grammar", "compliance"] as const;

const MAIL_DIMENSION_HINTS: Record<(typeof MAIL_ASSESSMENT_DIMENSION_IDS)[number], string> = {
  professionalism: "称呼、开头、结尾和落款是否得体，语气是否专业，是否符合收件人所在国的商务习惯",
  effectiveness: "主题行是否清楚，重点是否先说，篇幅是否合适，是否结合收件人的情况（老客、新客、粉丝）写",
  resolution: "是否有清楚可执行的行动号召（回复、下单、领券），优惠和时限是否写明",
  knowledge: "商品规格、价格、优惠、物流和售后政策是否和店铺资料一致，有没有编造或乱承诺",
  grammar: "英文拼写、语法、用词是否准确",
  compliance: "有无绝对化宣传、虚假承诺、诱导好评等违规用语；命中违规词库会明显扣分",
};

export const mailAssessmentOutputSchema = z.object({
  scores: z.object(
    Object.fromEntries(MAIL_ASSESSMENT_DIMENSION_IDS.map((id) => [id, dimensionScore.optional()])) as Record<
      (typeof MAIL_ASSESSMENT_DIMENSION_IDS)[number],
      z.ZodOptional<typeof dimensionScore>
    >,
  ),
  comment: z.string().max(600).default(""),
  suggestions: z.array(z.string().max(300)).max(5).default([]),
});

export function buildMailAssessmentMessages(input: {
  scenarioName: string | null;
  objective: string | null;
  stage?: BusinessStage | null;
  templatePurpose: string | null;
  recipient: string;
  productFacts?: string | null;
  subject: string;
  body: string;
  forbiddenHits: AssessmentEvidence["forbiddenHits"];
}): ChatMessage[] {
  const dims = MAIL_ASSESSMENT_DIMENSION_IDS.map((id) => `- ${id}：${MAIL_DIMENSION_HINTS[id]}`).join("\n");
  const example = Object.fromEntries(MAIL_ASSESSMENT_DIMENSION_IDS.map((id) => [id, 80]));
  const hits = input.forbiddenHits.length ? input.forbiddenHits.map((hit) => `“${hit.term}”`).join("、") : "无";
  const system =
    "你是跨境电商客服实训评分专家。下面是客服学员写给海外客户的一封英文邮件（营销 / 客户维护类）。" +
    `从下面 ${MAIL_ASSESSMENT_DIMENSION_IDS.length} 个维度打分（0-100 整数）：\n${dims}\n` +
    "并写一段不超过 80 字的中文总评，以及 2-3 条中文改进建议。命中违规用语时 compliance 应明显扣分并在总评中指出。" +
    "邮件应当用英文写；整封不是英文时 grammar 和 professionalism 明显扣分。\n" +
    `只返回一个 JSON 对象：${JSON.stringify({ scores: example, comment: "...", suggestions: ["...", "..."] })}`;
  const user =
    `训练场景：${input.scenarioName ?? "邮件"}` +
    (input.stage ? `（业务环节：${BUSINESS_STAGE_LABELS[input.stage]}）` : "") +
    `（目标：${input.objective ?? "-"}）\n` +
    (input.templatePurpose ? `学员套用的模板：${input.templatePurpose}\n` : "") +
    `收件人：${input.recipient}\n` +
    `店铺商品资料：${input.productFacts ? `\n${input.productFacts}` : "无"}\n` +
    `客观依据——违规用语命中：${hits}\n` +
    `邮件主题：${input.subject}\n邮件正文：\n${input.body}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function buildChunkSummaryMessages(chunk: string, index: number, total: number): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你在为客服实训评分做准备。把下面这段买家与客服学员的对话压缩成中文摘要（≤300字），" +
        "保留：买家诉求与情绪变化、学员给出的方案与承诺、学员说到的商品参数和政策（原样保留数字）、明显的语言错误或不当用语（尽量引用原句）、问题推进情况。只输出摘要。",
    },
    { role: "user", content: `第 ${index}/${total} 段：\n${chunk}` },
  ];
}
