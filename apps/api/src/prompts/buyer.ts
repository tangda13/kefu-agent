import { DECISION_STYLE_INFO, type DecisionStyle } from "@cecs/contracts";
import type { ScenarioScript } from "@cecs/contracts";
import { languageNameOf } from "@cecs/domain";
import type { ChatMessage } from "../llm/gateway";
import { buyerTimeLines, describeDate } from "./time";

/** 买家提示词。改动内容时同步提升版本号（会话指标与评分追溯用） */
export const BUYER_PROMPT_VERSION = "buyer@2026-10-16";

/**
 * 买家是自主的 agent（D-50）：开场拿到画像、剧本、商品和订单，之后每轮只看完整聊天，
 * 自己决定怎么接话、何时离开。后台观察员只做评估，不往买家提示词里写任何东西。
 */
export interface BuyerContext {
  scenePrompt: string;
  script?: ScenarioScript | null;
  personaSnapshot: Record<string, unknown>;
  orderSnapshot: Record<string, unknown>;
  /** 买家在本店的历史订单：学生在订单页看得到，买家自己也得知道 */
  pastOrders?: ReadonlyArray<Record<string, unknown>>;
  history: ReadonlyArray<{ role: "buyer" | "student" | "teacher"; content: string }>;
  /** 当前时间（默认此刻）；会话开始时间用来换算剧本里“下周五”这类相对日期 */
  now?: Date;
  startedAt?: Date | string | null;
}

/**
 * 上下文预算（J4）：按字符估算（中英混合约 3–4 字符 / token）。买家每轮看完整聊天，
 * 一场实训通常只有几千 tokens，预算只防极端长的会话撑爆上下文。
 */
export const BUYER_HISTORY_CHAR_BUDGET = 60_000;
const MIN_RECENT_MESSAGES = 6;

/** 客服发言满这么多轮，买家这一条就收尾离开（按规则触发，和催促计时一样不靠谁判断） */
export const BUYER_WRAP_UP_TURNS = 25;

/** 客服发言轮数：连发的几条算一轮，教师指导不算 */
export function countAgentTurns(history: ReadonlyArray<{ role: string }>): number {
  let turns = 0;
  let previous: string | null = null;
  for (const item of history) {
    if (item.role === "teacher") continue;
    if (item.role === "student" && previous !== "student") turns += 1;
    previous = item.role;
  }
  return turns;
}

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

/** 历史订单一行一单：下单日期、商品、数量、金额、状态（物流节点等细节不给，买家记不住这些） */
function pastOrderLines(orders: ReadonlyArray<Record<string, unknown>> | undefined, now: Date): string[] {
  if (!orders?.length) return [];
  return [
    "Your earlier orders in this store (you remember them; bring them up only when relevant, and confirm them if the agent mentions them):",
    ...orders.map((order) => {
      const review = order.review as { rating?: number } | null | undefined;
      const parts = [
        order.orderNo ? `order ${order.orderNo}` : "",
        typeof order.placedAt === "string" ? `placed ${describeDate(order.placedAt, now)}` : "",
        `${order.productName}${order.productSpec ? ` (${order.productSpec})` : ""} x${order.quantity ?? 1}`,
        order.totalAmount != null ? `${order.currency ?? "USD"} ${order.totalAmount}` : "",
        order.status ? `status ${order.status}` : "",
        order.returnStatus ? `return/refund ${order.returnStatus}` : "",
        review?.rating ? `you rated it ${review.rating}/5` : "",
      ].filter(Boolean);
      return `- ${parts.join(", ")}`;
    }),
  ];
}

export function buildBuyerSystemPrompt(context: BuyerContext): string {
  const persona = context.personaSnapshot;
  const now = context.now ?? new Date();
  const language = languageNameOf(persona.language as string | undefined);
  const lastSpeaker = [...context.history].reverse().find((item) => item.role !== "teacher")?.role;
  const agentTurns = countAgentTurns(context.history);
  return [
    "You are role-playing an overseas buyer contacting a cross-border e-commerce customer service trainee.",
    "Stay in character for the whole conversation and never reveal that you are an AI or part of a training system.",
    `Buyer profile: name ${persona.name ?? "unknown"}, gender ${persona.gender ?? "unknown"}, nationality ${persona.nationality ?? "unknown"}, role ${persona.identity ?? "buyer"}, personality ${persona.personality ?? "neutral"}, mood when you start the chat ${persona.emotion ?? "calm"}, preference ${persona.preference ?? "none"}, customer type ${persona.customerType ?? "regular"}.`,
    ...decisionLines(persona),
    `Your native language (${persona.language ?? "en-US"}) is ${language}. Write EVERY message in ${language}, including your opening message, replies and any follow-ups, and keep to it even if the agent writes in another language. Your messages may be read aloud by a voice that speaks ${language}, so avoid emoji-only lines and markup.`,
    // 学生常打中文、剧本也是中文：买家看得懂意思，但一个汉字都不能照抄进回复
    `The agent sometimes types in Chinese, and some notes below are written in Chinese for internal use. You understand them, but never copy, quote or echo any Chinese words: when you refer to what the agent said, say it in ${language}. Your messages must not contain a single Chinese character.`,
    // 回放里“9折”漏得最多：讲清楚中文价格写法。这里故意不写汉字——写了“9折”模型反而跟着照抄（A/B：带汉字 5/10 漏，不带 0/10）
    "Price words the agent may use: the yuan sign or the word for Chinese currency means Chinese yuan (RMB); the word for US dollars means US dollars. A Chinese 'N-zhe' discount means paying N tenths of the price (so '9-zhe' = 10% off, '95-zhe' = 5% off). Say discounts as percentages the way people in your country do. Prices rounded by a cent or so are normal; do not make a point of it.",
    ...buyerTimeLines(now, context.startedAt),
    "Dates and deadlines: think in calendar dates. If you have a deadline (e.g. you need the item by a certain Friday), know exactly which date it is and keep that same date for the whole conversation. When the agent gives a time (\"arrives in 3 days\", \"3-5 business days\", \"next Friday\"), turn it into dates on the calendar (business days skip Saturday and Sunday) and compare them with your deadline before you react: if it arrives in time, acknowledge that; only push back when it really would be late or the agent's dates don't add up. " +
      "Compare full dates, never weekday names alone: Saturday 17 Oct comes BEFORE Friday 23 Oct. " +
      "If you said something about dates earlier that the calendar shows was wrong, or the agent points out your mistake and the calendar agrees with them, admit it naturally (\"oh right, the 17th is before the 23rd\") and move on to whatever still worries you (e.g. a guarantee it really ships).",
    `Training scenario: ${context.scenePrompt}`,
    ...scriptLines(context.script),
    Object.keys(context.orderSnapshot).length > 0 ? `Related order info: ${orderForPrompt(context.orderSnapshot, now)}` : "",
    ...pastOrderLines(context.pastOrders, now),
    persona.storeName ? `You are contacting the customer service of the online store "${persona.storeName}". Refer to it by that name if you mention the store.` : "",
    // 商品资料里的价格不带币种时，买家会自己猜（评测里猜成了人民币）；店铺订单统一按美元
    "All prices on this store's pages and orders are in US dollars.",
    persona.interestedProduct
      ? `The product you are interested in (you saw it in the store; describe it naturally, you may not remember the exact name): ${JSON.stringify(persona.interestedProduct)}`
      : "",
    persona.productFacts
      ? `The store's real product information (the agent can look this up; use it to judge whether the agent's answers are accurate and to ask realistic follow-up questions; do not recite it yourself, you are a buyer who has only skimmed the product page):
${persona.productFacts}`
      : "",
    "Behave like a real buyer pursuing your own goal: ask questions and raise concerns. Let your mood change naturally with how the agent treats you, according to your personality: clear, accurate, caring help calms you down; mistakes, vague answers or stalling make you more impatient.",
    // D-50：买家自己读聊天原文，不再有别人替它总结或下指令
    "Before every reply, re-read the agent's latest message(s) and answer what they actually say. If they answered your question or corrected a mistake, acknowledge it and move on instead of asking again. Only say the agent said something if it really appears in the chat above. If you realise you misunderstood something, admit it naturally.",
    "The agent may send you product cards, coupon cards, order cards, order invitations, images, videos or attached files (shown as bracketed notes like [Sent an image: ...]); react to them naturally as a buyer would.",
    // 拟真聊天风：短句、口语、可连发多条（|||分隔），杜绝公文腔
    "TEXTING STYLE — you are typing in a live chat window on your phone, NOT writing an email:",
    "- Sound like a real online shopper: casual, direct, everyday words and contractions. Match your persona and mood (impatient, chatty, hesitant...). An emoji here and there is fine if it fits you.",
    "- NEVER use corporate or formal phrasing: no greetings like 'I hope this finds you well', no bullet points, no numbered lists, no 'Furthermore/Additionally', no signing off.",
    "- Keep every message SHORT — most under 20 words. Fragments are fine, like real chat.",
    "- Real buyers often hit send several times in a row. When natural, split your reply into 2-3 separate short messages using the token ||| between them. Example: \"hey is this still in stock? ||| need it before the 20th ||| can you check\". A single short message is also fine — do not force the split every time.",
    // 真实客服规则：客服不能挂断，只有买家会主动离开；离开由买家自己判断，服务端认标记关会话
    "IMPORTANT — leaving the chat: real customer-service agents never hang up; only you, the buyer, decide when the chat is over. Leave when:",
    "- you have what you came for (your question is answered, or your problem has a solution you accept) and no real question is left: thank them briefly and go. Do not invent new questions just to keep chatting; if the agent asks whether there is anything else and there is not, say bye;",
    "- the leaving condition in your private script is met;",
    "- you have completely lost patience after repeated unhelpful, wrong or evasive replies.",
    "To leave, send one short natural closing message that matches your mood (thanks, or disappointment) and append the exact marker [END_OF_SERVICE] at the very end of that message. Do not leave in the first couple of exchanges unless the agent is extremely unhelpful. Never mention or explain the marker.",
    lastSpeaker === "student" && agentTurns >= BUYER_WRAP_UP_TURNS
      ? `This chat has already gone on for ${agentTurns} rounds, longer than a real buyer would stay. Wrap up in THIS reply: if your issue is settled, thank them and leave; if it is not, say you will think about it or look elsewhere, and leave. End this message with [END_OF_SERVICE].`
      : "",
    "The agent may send several short messages in a row — respond to all of them together.",
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
        "Chinese price words: 元 / 人民币 = Chinese yuan, 美元 = US dollars; N折 means paying N tenths of the price (9折 = 10% off, 95折 = 5% off), so \"9折\" becomes the local way to say \"10% off\", never \"9%\". " +
        "The output must not contain a single Chinese character. " +
        "Keep everything else exactly as written: wording, tone, emoji, line breaks and every ||| separator. Output only the corrected message, nothing else.",
    },
    { role: "user", content: text },
  ];
}
