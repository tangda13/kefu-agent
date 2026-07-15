import { deriveBuyerEmail } from "@cecs/domain";
import type { Db } from "./db";
import type { ConversationProvider } from "./conversation-provider";

/** 营销邮件按客户类型的回信概率（回复类邮件必回） */
const MARKETING_REPLY_RATE: Record<string, number> = {
  复购老客: 0.75,
  粉丝客: 0.75,
  潜在意向客: 0.5,
  沉睡客: 0.35,
};

const MARKETING_MOODS = [
  "You are interested: ask one or two concrete follow-up questions (price, shipping time, discount for returning customers).",
  "You are politely declining for now: thank them, say it's not the right time, maybe mention you might come back later.",
  "You are curious but cautious: raise one specific concern (quality, sizing, delivery to your country) before deciding.",
] as const;

export interface BuyerMailReplyInput {
  submissionId: string;
  orderId: string | null;
  studentId: string;
  subject: string;
  body: string;
  templateId: string;
}

/**
 * 学生发出邮件后，AI 扮演买家异步回信（fire-and-forget 调用）。
 * 回复类邮件（MAIL-REPLY）必回；营销模板按客户类型概率回信，不回则仅记录日志。
 */
export async function generateBuyerMailReply(
  db: Db,
  provider: ConversationProvider,
  input: BuyerMailReplyInput,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  if (!input.orderId) {
    log.info(`mail-reply skip: submission ${input.submissionId} has no linked order`);
    return;
  }
  if (provider.providerId === "unconfigured") {
    log.warn("mail-reply skip: AI provider not configured");
    return;
  }
  const result = await db.query(
    `select o.payload, o.order_no, c.persona from orders o
     join conversations c on c.id = o.conversation_id
     where o.id = $1 and o.student_id = $2`,
    [input.orderId, input.studentId],
  );
  const row = result.rows[0];
  if (!row) {
    log.info(`mail-reply skip: order ${input.orderId} not found for student`);
    return;
  }
  const persona = row.persona as Record<string, unknown>;
  const order = row.payload as Record<string, unknown>;
  const customerType = String(persona.customerType ?? "");
  const isReply = input.templateId === "MAIL-REPLY";
  let moodDirective = "Reply naturally to what the support agent wrote, continuing the ongoing email thread.";
  if (!isReply) {
    const rate = MARKETING_REPLY_RATE[customerType] ?? 0.5;
    if (Math.random() >= rate) {
      log.info(`mail-reply skip: buyer chose not to reply (marketing mail, type=${customerType || "unknown"}, rate=${rate})`);
      return;
    }
    moodDirective = MARKETING_MOODS[Math.floor(Math.random() * MARKETING_MOODS.length)]!;
  }

  const system =
    `You are ${persona.name ?? "a buyer"}, a cross-border e-commerce buyer from ${persona.nationality ?? "abroad"} ` +
    `(customer type: ${customerType || "regular"}). You write emails in your own language (${persona.language ?? "en-US"}), ` +
    `in a natural, everyday customer tone.\n` +
    `Your related order: ${JSON.stringify({ orderNo: row.order_no, product: order.productName, status: order.statusLabel, total: order.totalAmount })}.\n` +
    `You just received an email from the store's customer support. Write your reply email: 2-5 sentences, sign with your name. ` +
    `${moodDirective}\n` +
    'Return ONLY a JSON object like {"subject":"...","body":"..."} with no extra text.';

  const raw = await provider.complete(system, `Subject: ${input.subject}\n\n${input.body}`);
  let subject = `Re: ${input.subject.replace(/^Re:\s*/i, "")}`;
  let body = "";
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { subject?: string; body?: string };
      if (parsed.subject?.trim()) subject = parsed.subject.trim();
      if (parsed.body?.trim()) body = parsed.body.trim();
    }
  } catch {
    // 解析失败走兜底
  }
  if (!body) {
    const plain = raw.trim();
    if (plain.length < 20 || plain.startsWith("{")) {
      log.warn(`mail-reply skip: unusable LLM output for submission ${input.submissionId}`);
      return;
    }
    body = plain;
  }
  await db.query(
    `insert into mail_replies (student_id, order_id, submission_id, from_name, from_email, subject, body)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.studentId,
      input.orderId,
      input.submissionId,
      String(persona.name ?? "Buyer"),
      deriveBuyerEmail(String(persona.name ?? "buyer"), String(row.order_no)),
      subject.slice(0, 300),
      body,
    ],
  );
  log.info(`mail-reply created for submission ${input.submissionId}`);
}
