import { z } from "zod";
import { EMOTIONS, type ScenarioScript } from "@cecs/contracts";
import type { ChatMessage } from "../llm/gateway";

export const DIRECTOR_PROMPT_VERSION = "director@2026-10-12";

export const STAGES = ["问题陈述", "信息核实", "方案协商", "达成一致", "僵持升级"] as const;

/** 导演只看最近若干轮，更早的内容靠备忘录承接（J4） */
export const DIRECTOR_RECENT_MESSAGES = 12;

const score = z.coerce.number().min(0).max(100).transform((value) => Math.round(value));

export const directorOutputSchema = z.object({
  turnScore: score,
  satisfaction: score,
  emotion: z.string().transform((value) => value.trim()),
  stage: z.string().transform((value) => value.trim()),
  directive: z.string().max(400).optional().default(""),
  memory: z.string().max(2000).optional().default(""),
  resolved: z.union([z.boolean(), z.string().transform((value) => value === "true")]).optional().default(false),
});
export type DirectorOutput = z.infer<typeof directorOutputSchema>;

export interface DirectorInput {
  persona: Record<string, unknown>;
  scenarioName: string | null;
  objective: string | null;
  script: ScenarioScript | null;
  previous: { emotion?: string; stage?: string; satisfaction?: number; memory?: string };
  transcript: Array<{ sender: string; content: string }>;
}

export function buildDirectorMessages(input: DirectorInput): ChatMessage[] {
  const transcript = input.transcript
    .map((row) => `${row.sender === "buyer" ? "买家" : row.sender === "student" ? "客服学员" : "教师"}: ${row.content}`)
    .join("\n");
  const system =
    "你是跨境电商客服实训的“导演”，负责让AI买家的表演真实、有剧情推进，并评估客服学员表现。" +
    "依据最近对话输出一个 JSON 对象（只输出 JSON）：" +
    `{"turnScore":0-100 学员最近一轮表现分,"satisfaction":0-100 买家当前满意度,"emotion":"${EMOTIONS.join("|")}"之一,` +
    `"stage":"${STAGES.join("|")}"之一,"directive":"给买家演员的下一轮表演指令，中文≤50字",` +
    `"memory":"合并旧备忘录后的关键事实摘要，中文≤200字：双方承诺/报价折扣/证据/已确认信息","resolved":问题是否已解决 true 或 false}` +
    "。评分依据：合规、语言质量、共情、推进问题解决。买家情绪应对学员表现做出合理演变：安抚有效则缓和，敷衍拖延则恶化。" +
    "若有场景剧本，买家的让步不得超过剧本底线，隐藏信息只有在学员问到点子上时才让买家透露。";
  const script = input.script
    ? `场景剧本：目标=${input.script.buyerGoal}；隐藏信息=${input.script.hiddenInfo}；情绪触发=${input.script.emotionTriggers}；底线=${input.script.bottomLine}；结束条件=${input.script.endConditions}\n`
    : "";
  const user =
    `买家画像：${JSON.stringify({ name: input.persona.name, personality: input.persona.personality, emotion: input.persona.emotion, customerType: input.persona.customerType })}\n` +
    `场景：${input.scenarioName ?? "通用客服"}（目标：${input.objective ?? "-"}）\n` +
    script +
    `上一轮状态：${JSON.stringify({ emotion: input.previous.emotion, stage: input.previous.stage, satisfaction: input.previous.satisfaction })}\n` +
    `既往备忘录：${input.previous.memory ?? "（无）"}\n最近对话：\n${transcript}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
