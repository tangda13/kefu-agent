import { z } from "zod";
import { EMOTIONS, type ScenarioScript } from "@cecs/contracts";
import type { ChatMessage } from "../llm/gateway";
import { directorTimeLine } from "./time";

/**
 * 后台观察员（D-50，原“导演”）：旁观对话，评估学员每轮表现、买家满意度、情绪和对话进度，
 * 结果给教师端走势、最终评分和催促快慢用。只评估，不往买家提示词里写任何东西。
 * 模型用途键仍叫 director（管理端路由配置沿用）。
 */
export const DIRECTOR_PROMPT_VERSION = "observer@2026-10-16";

export const STAGES = ["问题陈述", "信息核实", "方案协商", "达成一致", "僵持升级"] as const;

/** 观察员看完整聊天，按字符预算截断（不再靠备忘录承接早期内容） */
export const DIRECTOR_HISTORY_CHAR_BUDGET = 30_000;

const score = z.coerce.number().min(0).max(100).transform((value) => Math.round(value));

export const directorOutputSchema = z.object({
  turnScore: score,
  satisfaction: score,
  emotion: z.string().transform((value) => value.trim()),
  stage: z.string().transform((value) => value.trim()),
});
export type DirectorOutput = z.infer<typeof directorOutputSchema>;

export interface DirectorInput {
  persona: Record<string, unknown>;
  scenarioName: string | null;
  objective: string | null;
  script: ScenarioScript | null;
  previous: { emotion?: string; stage?: string; satisfaction?: number };
  transcript: Array<{ sender: string; content: string }>;
  /** 当前时间（默认此刻） */
  now?: Date;
}

export function buildDirectorMessages(input: DirectorInput): ChatMessage[] {
  const transcript = input.transcript
    .map((row) => `${row.sender === "buyer" ? "买家" : row.sender === "student" ? "客服学员" : "教师"}: ${row.content}`)
    .join("\n");
  const system =
    "你是跨境电商客服实训的后台观察员：只旁观评估，不参与对话，也不指挥买家。" +
    "依据对话输出一个 JSON 对象（只输出 JSON）：" +
    `{"turnScore":0-100 客服学员最近一轮的表现分,"satisfaction":0-100 买家此刻的满意度,"emotion":"${EMOTIONS.join("|")}"之一（买家此刻的情绪）,` +
    `"stage":"${STAGES.join("|")}"之一（对话进行到哪一步）}` +
    "。表现分依据：合规、语言质量、共情、推进问题解决、报价和信息是否准确。" +
    "满意度和情绪以买家最近几条消息的实际态度为准，并考虑学员表现的累积影响：安抚有效、信息准确则回升，敷衍拖延、报错信息则下降。" +
    "涉及时间时对照所给日历比较完整日期（10月17日周六早于10月23日周五，不能只比星期几）。";
  const script = input.script
    ? `场景剧本（买家的目标与底线，供判断满意度）：目标=${input.script.buyerGoal}；底线=${input.script.bottomLine}；结束条件=${input.script.endConditions}\n`
    : "";
  const user =
    `${directorTimeLine(input.now ?? new Date())}\n` +
    `买家画像：${JSON.stringify({ name: input.persona.name, personality: input.persona.personality, emotion: input.persona.emotion, customerType: input.persona.customerType })}\n` +
    `场景：${input.scenarioName ?? "通用客服"}（目标：${input.objective ?? "-"}）\n` +
    script +
    `上一次评估：${JSON.stringify({ emotion: input.previous.emotion, stage: input.previous.stage, satisfaction: input.previous.satisfaction })}\n` +
    `对话：\n${transcript}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
