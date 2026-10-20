import { languageNameOf } from "@cecs/domain";
import { z } from "zod";
import type { ChatMessage } from "../llm/gateway";

/** 辅助生成类提示词（用途 assist）：翻译、话术建议、写信辅助、买家回信、买家评价 */
export const ASSIST_PROMPT_VERSION = "assist@2026-10-19";

const nonEmpty = z.string().trim().min(1);

// ---------- 翻译 ----------
export function buildTranslationMessages(text: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a professional translator for cross-border e-commerce customer service. Translate the buyer's message into Simplified Chinese. Output ONLY the translation, no explanations.",
    },
    { role: "user", content: text },
  ];
}

// ---------- 客服输入框翻译：把客服写的（多为中文）译成买家的语言 ----------
export function buildOutgoingTranslationMessages(text: string, targetLanguage: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `You are a professional translator for cross-border e-commerce customer service. Translate the agent's message into ${targetLanguage}. ` +
        "Keep a polite, natural customer-service tone; keep order numbers, SKUs, prices and product names unchanged. Output ONLY the translation.",
    },
    { role: "user", content: text },
  ];
}

// ---------- 订单话术建议（3 版） ----------
export const suggestionsSchema = z.object({ items: z.array(nonEmpty).min(3) });

export function buildSuggestionMessages(input: {
  task: string;
  persona: Record<string, unknown>;
  order: Record<string, unknown>;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a cross-border e-commerce customer service coach. Generate exactly 3 alternative reply drafts the agent can send to the buyer. " +
        `Task: ${input.task}. Write in the buyer's language (${input.persona.language ?? "en-US"}). ` +
        "Each draft: 1-3 sentences, professional, no forbidden absolute claims (e.g. 'best', '100% guaranteed'). " +
        'Return ONLY a JSON object: {"items":["...","...","..."]}.',
    },
    {
      role: "user",
      content: `Buyer profile: ${JSON.stringify({ name: input.persona.name, nationality: input.persona.nationality, customerType: input.persona.customerType })}\nOrder: ${JSON.stringify(input.order)}`,
    },
  ];
}

// ---------- 评价回复（C5 / D-57：固定 3 版英文，各附中文意思和切入角度；要用买家语言时学生点“译成 X 语”） ----------
export const reviewReplySchema = z.object({
  items: z
    .array(z.object({ angle: nonEmpty, en: nonEmpty, zh: nonEmpty }))
    .min(3),
});

export function buildReviewReplyMessages(input: {
  persona: Record<string, unknown>;
  order: Record<string, unknown>;
  storeName: string;
  signature: string;
}): ChatMessage[] {
  // 参数要求英文回复（D-57）：买家用德语留评也先给英文版，学生需要时再一键译成买家的语言
  const reviewLanguage = languageNameOf(input.persona.language as string | undefined);
  return [
    {
      role: "system",
      content:
        `You are a customer service coach for the cross-border online store "${input.storeName}". ` +
        "Write exactly 3 alternative PUBLIC replies to the buyer's product review (rating and text are in order.review). " +
        `All replies MUST be written in English, even if the review is written in ${reviewLanguage}. Each reply takes a different angle ` +
        "(e.g. apologise and reship, offer a refund option, invite a private conversation; for positive reviews: thank, invite to buy again, ask to share photos). " +
        "2-4 sentences each, address the buyer by first name, concrete remedy for reviews of 3 stars or lower, no absolute claims ('best', '100% guaranteed'), no signature line. " +
        "For each reply also give `angle`: a 4-8 character Simplified Chinese label of the approach, and `zh`: a faithful Simplified Chinese translation. " +
        'Return ONLY JSON: {"items":[{"angle":"...","en":"...","zh":"..."}, ...]}.',
    },
    {
      role: "user",
      content: `Buyer: ${JSON.stringify({ name: input.persona.name, nationality: input.persona.nationality })}\nOrder: ${JSON.stringify(input.order)}`,
    },
  ];
}

// ---------- 写信辅助（3 版草稿） ----------
export const mailDraftsSchema = z.object({
  items: z.array(z.object({ subject: z.string().optional(), body: nonEmpty })).min(3),
});

export function buildMailReplyDraftMessages(input: {
  language: string;
  buyerBrief: string;
  orderBrief: string;
  originalSubject: string;
  originalBody: string;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a cross-border e-commerce customer service coach. Draft exactly 3 alternative reply EMAILS the agent can send to the buyer, " +
        "with distinct strategies: (1) solution-focused, (2) empathy-first, (3) brief and efficient. " +
        `Write in the buyer's language (${input.language}). Each 2-5 sentences plus a short sign-off, professional, ` +
        "no absolute marketing claims (e.g. 'best', '100% guaranteed'). " +
        'Return ONLY a JSON object: {"items":[{"body":"..."},{"body":"..."},{"body":"..."}]}.',
    },
    {
      role: "user",
      content: `Buyer profile: ${input.buyerBrief}\nOrder: ${input.orderBrief}\nBuyer's email:\nSubject: ${input.originalSubject}\n\n${input.originalBody}`,
    },
  ];
}

export function buildMailComposeDraftMessages(input: {
  language: string;
  purpose: string;
  buyerBrief: string;
  orderBrief: string;
  templateBody: string;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a cross-border e-commerce customer service coach. Draft exactly 3 alternative outreach EMAILS (subject + body) " +
        `for the purpose: ${input.purpose}. ` +
        `Personalize for the recipient. Write in the buyer's language (${input.language}). ` +
        "Each body 3-6 sentences with greeting and sign-off, professional, no absolute marketing claims. " +
        'Return ONLY a JSON object: {"items":[{"subject":"...","body":"..."}, ...]}.',
    },
    {
      role: "user",
      content: `Buyer profile: ${input.buyerBrief}\nOrder history: ${input.orderBrief}\nReference template:\n${input.templateBody}`,
    },
  ];
}

// ---------- 买家回信 ----------
export const buyerMailSchema = z.object({ subject: z.string().optional(), body: nonEmpty });

export function buildBuyerMailMessages(input: {
  persona: Record<string, unknown>;
  customerType: string;
  orderBrief: string;
  moodDirective: string;
  subject: string;
  body: string;
}): ChatMessage[] {
  const persona = input.persona;
  return [
    {
      role: "system",
      content:
        `You are ${persona.name ?? "a buyer"}, a cross-border e-commerce buyer from ${persona.nationality ?? "abroad"} ` +
        `(customer type: ${input.customerType || "regular"}). You write emails in your own native language (${languageNameOf(persona.language as string | undefined)}, code ${persona.language ?? "en-US"}), ` +
        "in a natural, everyday customer tone.\n" +
        `Your related order: ${input.orderBrief}.\n` +
        "You just received an email from the store's customer support. Write your reply email: 2-5 sentences, sign with your name. " +
        `${input.moodDirective}\n` +
        'Return ONLY a JSON object like {"subject":"...","body":"..."} with no extra text.',
    },
    { role: "user", content: `Subject: ${input.subject}\n\n${input.body}` },
  ];
}

// ---------- 买家评价 ----------
export const buyerReviewSchema = z.object({ content: nonEmpty });

export function buildBuyerReviewMessages(input: {
  persona: Record<string, unknown>;
  productName: unknown;
  satisfaction: number;
  mode: "create" | "revise";
  rating: number;
  existing: { rating?: number; content?: string } | null;
  /** 最近一段聊天原文（买家称 Me，客服称 Store agent） */
  transcript: string;
}): ChatMessage[] {
  const persona = input.persona;
  return [
    {
      role: "system",
      content:
        `You are ${persona.name ?? "a buyer"}, a cross-border e-commerce buyer from ${persona.nationality ?? "abroad"}. ` +
        `You just finished a customer service conversation about your order (product: ${input.productName}). ` +
        `Final satisfaction with the service: ${input.satisfaction}/100. ` +
        (input.mode === "revise"
          ? `You previously left a ${input.existing?.rating}-star review: "${input.existing?.content}". The support agent resolved your issue, so you are UPDATING your review to ${input.rating} stars. Mention that the seller followed up and resolved the problem.`
          : `Now you are leaving a ${input.rating}-star review for this order, reflecting both the product and the service experience.`) +
        ` The end of your chat with the store, for reference (the agent may have typed Chinese; never copy Chinese words into the review):\n${input.transcript || "(no messages)"}\n` +
        `Write the review in ${languageNameOf(persona.language as string | undefined)} (your native language), 1-3 natural sentences, first person, no absolute marketing phrases. ` +
        'Return ONLY a JSON object: {"content":"..."}.',
    },
    { role: "user", content: "Write the review now." },
  ];
}
