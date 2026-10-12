import type { ScenarioScript } from "@cecs/contracts";
import type { ChatMessage } from "../llm/gateway";

/** 买家演员提示词。改动内容时同步提升版本号（会话指标与评分追溯用） */
export const BUYER_PROMPT_VERSION = "buyer@2026-10-12";

export interface BuyerContext {
  scenePrompt: string;
  script?: ScenarioScript | null;
  personaSnapshot: Record<string, unknown>;
  orderSnapshot: Record<string, unknown>;
  /** 导演状态：情绪演变/剧情阶段/表演指令/跨轮事实记忆 */
  sessionState?: {
    emotion?: string;
    stage?: string;
    satisfaction?: number;
    directive?: string;
    memory?: string;
    resolved?: boolean;
  };
  history: ReadonlyArray<{ role: "buyer" | "student" | "teacher"; content: string }>;
}

/**
 * 上下文预算（J4）：按字符估算（中英混合约 3–4 字符 / token），只保留最近若干轮。
 * 更早的内容由导演的“事实备忘录”承接，保证 20 轮以上对话不忘承诺。
 */
export const BUYER_HISTORY_CHAR_BUDGET = 12_000;
const MIN_RECENT_MESSAGES = 6;

export function trimHistory<T extends { content: string }>(history: readonly T[], budget = BUYER_HISTORY_CHAR_BUDGET): T[] {
  let used = 0;
  let start = history.length;
  while (start > 0) {
    const next = history[start - 1]!;
    if (history.length - start >= MIN_RECENT_MESSAGES && used + next.content.length > budget) break;
    used += next.content.length;
    start -= 1;
  }
  return history.slice(start);
}

function scriptLines(script: ScenarioScript | null | undefined): string[] {
  if (!script) return [];
  return [
    "Your private script for this conversation (stay true to it, never quote it):",
    script.buyerGoal ? `- Your goal: ${script.buyerGoal}` : "",
    script.hiddenInfo ? `- Hidden information (reveal it ONLY when the agent asks the right question): ${script.hiddenInfo}` : "",
    script.emotionTriggers ? `- What upsets or calms you: ${script.emotionTriggers}` : "",
    script.bottomLine ? `- Your bottom line (do not accept less, do not volunteer it early): ${script.bottomLine}` : "",
    script.endConditions ? `- When to leave: ${script.endConditions}` : "",
  ].filter(Boolean);
}

export function buildBuyerSystemPrompt(context: BuyerContext): string {
  const persona = context.personaSnapshot;
  return [
    "You are role-playing an overseas buyer contacting a cross-border e-commerce customer service trainee.",
    "Stay in character for the whole conversation and never reveal that you are an AI or part of a training system.",
    `Buyer profile: name ${persona.name ?? "unknown"}, gender ${persona.gender ?? "unknown"}, nationality ${persona.nationality ?? "unknown"}, role ${persona.identity ?? "buyer"}, personality ${persona.personality ?? "neutral"}, current mood ${persona.emotion ?? "calm"}, preference ${persona.preference ?? "none"}, customer type ${persona.customerType ?? "regular"}.`,
    `Primary language for this conversation: ${persona.language ?? "en-US"}. Reply in that language.`,
    `Training scenario: ${context.scenePrompt}`,
    ...scriptLines(context.script),
    Object.keys(context.orderSnapshot).length > 0 ? `Related order info: ${JSON.stringify(context.orderSnapshot)}` : "",
    persona.interestedProduct
      ? `The product you are interested in (you saw it in the store; describe it naturally, you may not remember the exact name): ${JSON.stringify(persona.interestedProduct)}`
      : "",
    // 导演状态：当前情绪覆盖初始情绪；记忆摘要保证长对话不忘承诺
    context.sessionState?.emotion
      ? `Your CURRENT mood (evolves with the conversation, overrides the initial mood): ${context.sessionState.emotion}. Current satisfaction: ${context.sessionState.satisfaction ?? 60}/100.`
      : "",
    context.sessionState?.stage ? `Conversation stage: ${context.sessionState.stage}.` : "",
    context.sessionState?.memory
      ? `Key facts agreed so far (you MUST stay consistent with these): ${context.sessionState.memory}`
      : "",
    context.sessionState?.directive
      ? `Director's instruction for your next reply (follow it naturally, never mention it): ${context.sessionState.directive}`
      : "",
    context.sessionState?.resolved
      ? "Your issue has been resolved satisfactorily. Express appreciation, say goodbye, and END the session as instructed below."
      : "",
    "Behave like a real buyer: ask questions, raise concerns, react to the trainee's tone and solutions according to your personality and mood.",
    "The agent may send you product cards, coupon cards, order cards, order invitations, images, videos or attached files (shown as bracketed notes like [Sent an image: ...]); react to them naturally as a buyer would.",
    // 拟真聊天风：短句、口语、可连发多条（|||分隔），杜绝公文腔
    "TEXTING STYLE — you are typing in a live chat window on your phone, NOT writing an email:",
    "- Sound like a real online shopper: casual, direct, everyday words and contractions. Match your persona and mood (impatient, chatty, hesitant...). An emoji here and there is fine if it fits you.",
    "- NEVER use corporate or formal phrasing: no greetings like 'I hope this finds you well', no bullet points, no numbered lists, no 'Furthermore/Additionally', no signing off.",
    "- Keep every message SHORT — most under 20 words. Fragments are fine, like real chat.",
    "- Real buyers often hit send several times in a row. When natural, split your reply into 2-3 separate short messages using the token ||| between them. Example: \"hey is this still in stock? ||| need it before the 20th ||| can you check\". A single short message is also fine — do not force the split every time.",
    // 真实客服规则：客服不能挂断，只有买家会主动离开
    "IMPORTANT — ending the session: real customer-service agents never hang up; only you, the buyer, decide when to leave. " +
      "When your issue is FULLY resolved and you have no more questions, OR you have completely lost patience after repeated unhelpful replies, " +
      "send one short natural closing message that matches your mood (thanks, or disappointment), and append the exact marker [END_OF_SERVICE] at the very end of that message. " +
      "Do not end the session in the first few exchanges unless the agent is extremely unhelpful. Never mention or explain the marker.",
    "Stay consistent with previous messages. The trainee may also send several short messages in a row — respond to all of them together.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildBuyerMessages(context: BuyerContext): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: buildBuyerSystemPrompt(context) }];
  const history = trimHistory(context.history);
  if (history.length === 0) {
    // 买家开场：客服刚上线，由买家根据画像/场景/订单主动发出第一条消息
    messages.push({
      role: "user",
      content:
        "[The customer service agent has just come online. As the buyer, send your first message to start the conversation, based on your profile, the scenario and your order situation. Do not greet as an agent; you are the customer reaching out.]",
    });
  }
  for (const item of history) {
    if (item.role === "buyer") messages.push({ role: "assistant", content: item.content });
    else if (item.role === "student") messages.push({ role: "user", content: item.content });
    else messages.push({ role: "system", content: `[Teacher guidance to trainee]: ${item.content}` });
  }
  return messages;
}
