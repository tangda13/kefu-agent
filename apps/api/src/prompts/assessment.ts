import { z } from "zod";
import { ASSESSMENT_DIMENSIONS } from "@cecs/contracts";
import type { ChatMessage } from "../llm/gateway";

export const ASSESSMENT_PROMPT_VERSION = "assessment@2026-10-12";

/** 评分读全量对话；超过这个长度时先分段摘要再评分（J4） */
export const ASSESSMENT_FULL_TEXT_LIMIT = 24_000;
export const ASSESSMENT_CHUNK_SIZE = 8_000;

const dimensionScore = z.coerce.number().min(0).max(100).transform((value) => Math.round(value));

export const assessmentOutputSchema = z.object({
  scores: z.object(
    Object.fromEntries(ASSESSMENT_DIMENSIONS.map((item) => [item.id, dimensionScore])) as Record<
      (typeof ASSESSMENT_DIMENSIONS)[number]["id"],
      typeof dimensionScore
    >,
  ),
  comment: z.string().max(600).default(""),
  suggestions: z.array(z.string().max(300)).max(5).default([]),
});
export type AssessmentOutput = z.infer<typeof assessmentOutputSchema>;

/** 客观依据（J7）：违规词命中 + 导演逐轮得分，一起交给评分模型 */
export interface AssessmentEvidence {
  forbiddenHits: Array<{ term: string; excerpt: string }>;
  turnScores: number[];
  summarized: boolean;
}

export function formatTranscript(rows: Array<{ sender: string; content: string }>): string {
  return rows
    .map((row) => `${row.sender === "buyer" ? "Buyer" : row.sender === "student" ? "Agent" : "Teacher"}: ${row.content}`)
    .join("\n");
}

export function buildAssessmentMessages(input: {
  scenarioName: string | null;
  objective: string | null;
  transcript: string;
  evidence: AssessmentEvidence;
}): ChatMessage[] {
  const dims = ASSESSMENT_DIMENSIONS.map((item) => `${item.id}（${item.label}）`).join("、");
  const example = Object.fromEntries(ASSESSMENT_DIMENSIONS.map((item) => [item.id, 80]));
  const hits = input.evidence.forbiddenHits.length
    ? input.evidence.forbiddenHits.map((hit) => `“${hit.term}”（原句：${hit.excerpt}）`).join("；")
    : "无";
  const turns = input.evidence.turnScores.length ? input.evidence.turnScores.join(", ") : "无";
  const system =
    "你是跨境电商客服实训评分专家。根据买家与客服学员（Agent）的对话记录，" +
    `从六个维度打分（0-100 整数）：${dims}。` +
    "并写一段不超过 80 字的中文总评，以及 2-3 条中文改进建议。" +
    "系统提供的客观依据必须纳入考量：命中违规用语时，“违规用语合规”维度应明显扣分并在总评中指出；导演逐轮得分反映学员表现的走势。" +
    `只返回一个 JSON 对象：${JSON.stringify({ scores: example, comment: "...", suggestions: ["...", "..."] })}`;
  const user =
    `训练场景：${input.scenarioName ?? "通用客服对话"}（目标：${input.objective ?? "-"}）\n` +
    `客观依据——违规用语命中：${hits}\n` +
    `客观依据——导演逐轮得分（按时间顺序）：${turns}\n` +
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
        "保留：买家诉求与情绪变化、学员给出的方案与承诺、明显的语言错误或不当用语（尽量引用原句）、问题推进情况。只输出摘要。",
    },
    { role: "user", content: `第 ${index}/${total} 段：\n${chunk}` },
  ];
}
