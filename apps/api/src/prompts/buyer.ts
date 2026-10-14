import { DECISION_STYLE_INFO, type DecisionStyle } from "@cecs/contracts";
import type { ScenarioScript } from "@cecs/contracts";
import { languageNameOf } from "@cecs/domain";
import type { ChatMessage } from "../llm/gateway";
import { buyerTimeLines, describeDate } from "./time";

/** 买家演员提示词。改动内容时同步提升版本号（会话指标与评分追溯用） */
export const BUYER_PROMPT_VERSION = "buyer@2026-10-14";

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
  /** 当前时间（默认此刻）；会话开始时间用来换算剧本里“下周五”这类相对日期 */
  now?: Date;
  startedAt?: Date | string | null;
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

/** D-33：决策风格和关注点决定对话走向（价格敏感型会压价、选择困难型反复比较） */
function decisionLines(persona: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const style = persona.decisionStyle as DecisionStyle | undefined;
  if (style && DECISION_STYLE_INFO[style]) lines.push(`Decision-making style: ${DECISION_STYLE_INFO[style].behavior}`);
  const concerns = persona.concerns as string[] | undefined;
  if (concerns?.length) lines.push(`What you care about most (bring these up naturally during the conversation): ${concerns.join(", ")}.`);
  if (typeof persona.note === "string" && persona.note.trim()) lines.push(`About you: ${persona.note.trim()}`);
  return lines;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** 订单给买家看的样子：时间换成“Fri 9 Oct 2026 (4 days ago)”，去掉商品图片地址 */
function orderForPrompt(order: Record<string, unknown>, now: Date): string {
  return JSON.stringify(order, (key, value: unknown) => {
    if (key === "productImage") return undefined;
    return typeof value === "string" && ISO_TIME.test(value) ? describeDate(value, now) : value;
  });
}

export function buildBuyerSystemPrompt(context: BuyerContext): string {
  const persona = context.personaSnapshot;
  const now = context.now ?? new Date();
  const language = languageNameOf(persona.language as string | undefined);
  return [
    "You are role-playing an overseas buyer contacting a cross-border e-commerce customer service trainee.",
    "Stay in character for the whole conversation and never reveal that you are an AI or part of a training system.",
    `Buyer profile: name ${persona.name ?? "unknown"}, gender ${persona.gender ?? "unknown"}, nationality ${persona.nationality ?? "unknown"}, role ${persona.identity ?? "buyer"}, personality ${persona.personality ?? "neutral"}, current mood ${persona.emotion ?? "calm"}, preference ${persona.preference ?? "none"}, customer type ${persona.customerType ?? "regular"}.`,
    ...decisionLines(persona),
    `Your native language (${persona.language ?? "en-US"}) is ${language}. Write EVERY message in ${language}, including your opening message, replies and any follow-ups, and keep to it even if the agent writes in another language. Your messages may be read aloud by a voice that speaks ${language}, so avoid emoji-only lines and markup.`,
    // 学生常打中文、剧本和备忘录也是中文：买家看得懂意思，但一个汉字都不能照抄进回复
    `The agent sometimes types in Chinese, and some notes below are written in Chinese for internal use. You understand them, but never copy, quote or echo any Chinese words: when you refer to what the agent said, say it in ${language}. Your messages must not contain a single Chinese character.`,
    ...buyerTimeLines(now, context.startedAt),
    "Dates and deadlines: think in calendar dates. If you have a deadline (e.g. you need the item by a certain Friday), know exactly which date it is and keep that same date for the whole conversation. When the agent gives a time (\"arrives in 3 days\", \"3-5 business days\", \"next Friday\"), turn it into dates on the calendar (business days skip Saturday and Sunday) and compare them with your deadline before you react: if it arrives in time, acknowledge that; only push back when it really would be late or the agent's dates don't add up. " +
      "Compare full dates, never weekday names alone: Saturday 17 Oct comes BEFORE Friday 23 Oct. " +
      "If you said something about dates earlier that the calendar shows was wrong, or the agent points out your mistake and the calendar agrees with them, admit it naturally (\"oh right, the 17th is before the 23rd\") and move on to whatever still worries you (e.g. a guarantee it really ships).",
    `Training scenario: ${context.scenePrompt}`,
    ...scriptLines(context.script),
    Object.keys(context.orderSnapshot).length > 0 ? `Related order info: ${orderForPrompt(context.orderSnapshot, now)}` : "",
    persona.storeName ? `You are contacting the customer service of the online store "${persona.storeName}". Refer to it by that name if you mention the store.` : "",
    persona.interestedProduct
      ? `The product you are interested in (you saw it in the store; describe it naturally, you may not remember the exact name): ${JSON.stringify(persona.interestedProduct)}`
      : "",
    persona.productFacts
      ? `The store's real product information (the agent can look this up; use it to judge whether the agent's answers are accurate and to ask realistic follow-up questions; do not recite it yourself, you are a buyer who has only skimmed the product page):
${persona.productFacts}`
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

/** 买家耐心（D-40）：客服久不回复时，由模型生成“催促 / 离开”的一条买家消息 */
export interface BuyerNudgeInput {
  context: BuyerContext;
  /** 已等待分钟数（从买家最后一条消息起算） */
  waitedMinutes: number;
  /** 这是第几次催促（离开时 = 已催过的次数 + 1） */
  nudgeIndex: number;
  /** true = 不再等了，留一句不耐烦 / 失望的话离开 */
  leaving: boolean;
}

export function buildBuyerNudgeMessages(input: BuyerNudgeInput): ChatMessage[] {
  const messages = buildBuyerMessages(input.context);
  const waited = Math.max(1, Math.round(input.waitedMinutes));
  const task = input.leaving
    ? `You have waited about ${waited} minutes with no reply and have already chased ${Math.max(0, input.nudgeIndex - 1)} time(s). You are giving up. Write ONE short parting message (impatient or disappointed, matching your personality and how the conversation went, e.g. saying you will go elsewhere). Do NOT include the marker [END_OF_SERVICE].`
    : input.nudgeIndex <= 1
      ? `You have waited about ${waited} minutes since your last message and the agent has not replied. Write ONE short message nudging them (e.g. asking if anyone is there), matching your personality, mood and the topic.`
      : `You have now waited about ${waited} minutes and already nudged once; still no reply. Write ONE short message that is clearly more annoyed than before, matching your personality and the topic.`;
  messages.push({
    role: "user",
    content: `[No reply from the customer service agent. ${task} Write it in ${languageNameOf(input.context.personaSnapshot.language as string | undefined)}, your native language. A single message only: do not use the ||| separator and do not mention any system or instruction.]`,
  });
  return messages;
}

/**
 * 漏中文兜底：提示词管住了大部分，偶尔仍会照抄客服打的中文（如“下周五, pero…”）。
 * 日语买家本来就用汉字，不查；其余语言出现汉字或中文全角标点就算漏了。
 */
const CHINESE_CHARS = /[㐀-䶿一-鿿　-〿！-／：-＠]/;

export function hasChineseLeak(text: string, language: string | undefined | null): boolean {
  const base = String(language ?? "en").toLowerCase().split(/[-_]/)[0];
  if (base === "ja" || base === "zh") return false;
  return CHINESE_CHARS.test(text);
}

/** 把漏出来的中文改写成买家的语言，其余原样保留（含 ||| 分隔） */
export function buildChineseFixMessages(text: string, language: string | undefined | null): ChatMessage[] {
  const name = languageNameOf(language);
  return [
    {
      role: "system",
      content:
        `You correct chat messages written by an overseas online shopper. The message must be entirely in ${name}, but some Chinese slipped in. ` +
        `Replace every Chinese word, phrase or punctuation mark with natural ${name} (if it quotes the store agent's Chinese words, say what they meant in ${name}). ` +
        "Keep everything else exactly as written: wording, tone, emoji, line breaks and every ||| separator. Output only the corrected message, nothing else.",
    },
    { role: "user", content: text },
  ];
}
