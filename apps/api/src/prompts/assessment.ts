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
