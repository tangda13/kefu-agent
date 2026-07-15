export interface ConversationContext {
  conversationId: string;
  scenePrompt: string;
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

export interface StreamChunk {
  text: string;
  done: boolean;
}

export interface ConversationProvider {
  readonly providerId: string;
  readonly modelId: string;
  streamReply(context: ConversationContext, signal: AbortSignal): AsyncIterable<StreamChunk>;
  /** 非流式单轮补全（用于翻译、话术生成等辅助能力） */
  complete(systemPrompt: string, userText: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Production intentionally has no fixed-script or keyword-based fallback.
 * A missing LLM provider is a configuration error and must be visible to operators.
 */
export class MissingConversationProvider implements ConversationProvider {
  readonly providerId = "unconfigured";
  readonly modelId = "unconfigured";

  async *streamReply(): AsyncIterable<StreamChunk> {
    throw new Error("AI_PROVIDER_NOT_CONFIGURED");
  }

  async complete(): Promise<string> {
    throw new Error("AI_PROVIDER_NOT_CONFIGURED");
  }
}

function buildSystemPrompt(context: ConversationContext): string {
  const persona = context.personaSnapshot;
  return [
    "You are role-playing an overseas buyer contacting a cross-border e-commerce customer service trainee.",
    "Stay in character for the whole conversation and never reveal that you are an AI or part of a training system.",
    `Buyer profile: name ${persona.name ?? "unknown"}, nationality ${persona.nationality ?? "unknown"}, role ${persona.identity ?? "buyer"}, personality ${persona.personality ?? "neutral"}, current mood ${persona.emotion ?? "calm"}, preference ${persona.preference ?? "none"}, customer type ${persona.customerType ?? "regular"}.`,
    `Primary language for this conversation: ${persona.language ?? "en-US"}. Reply in that language.`,
    `Training scenario: ${context.scenePrompt}`,
    Object.keys(context.orderSnapshot).length > 0
      ? `Related order info: ${JSON.stringify(context.orderSnapshot)}`
      : "",
    // 导演状态：当前情绪覆盖初始情绪；记忆摘要保证长对话不忘承诺
    context.sessionState?.emotion
      ? `Your CURRENT mood (evolves with the conversation, overrides the initial mood): ${context.sessionState.emotion}. Current satisfaction: ${context.sessionState.satisfaction ?? 60}/100.`
      : "",
    context.sessionState?.stage
      ? `Conversation stage: ${context.sessionState.stage}.`
      : "",
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

/** OpenAI 兼容 /v1/chat/completions 流式适配器（deepseek/智谱/通义等均可用） */
export class OpenAiCompatibleProvider implements ConversationProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly modelId: string,
  ) {}

  readonly providerId = "openai-compatible";

  async *streamReply(
    context: ConversationContext,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: buildSystemPrompt(context) },
    ];
    if (context.history.length === 0) {
      // 买家开场：客服刚上线，由买家根据画像/场景/订单主动发出第一条消息
      messages.push({
        role: "user",
        content:
          "[The customer service agent has just come online. As the buyer, send your first message to start the conversation, based on your profile, the scenario and your order situation. Do not greet as an agent; you are the customer reaching out.]",
      });
    }
    for (const item of context.history) {
      if (item.role === "buyer") messages.push({ role: "assistant", content: item.content });
      else if (item.role === "student") messages.push({ role: "user", content: item.content });
      else messages.push({ role: "system", content: `[Teacher guidance to trainee]: ${item.content}` });
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        stream: true,
        temperature: 0.8,
        messages,
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`LLM_HTTP_${response.status}: ${detail.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            yield { text: "", done: true };
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              yield { text: delta, done: false };
            }
          } catch {
            /* 忽略无法解析的心跳行 */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { text: "", done: true };
  }

  async complete(
    systemPrompt: string,
    userText: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        stream: false,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
      }),
      signal: signal ?? AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`LLM_HTTP_${response.status}: ${detail.slice(0, 200)}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("LLM_EMPTY_COMPLETION");
    return text.trim();
  }
}

export function createConversationProvider(config: {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}): ConversationProvider {
  if (config.llmBaseUrl && config.llmApiKey && config.llmModel) {
    return new OpenAiCompatibleProvider(
      config.llmBaseUrl,
      config.llmApiKey,
      config.llmModel,
    );
  }
  return new MissingConversationProvider();
}

/** 可热切换的 Provider 包装：管理端更新配置后 swap 内部实现，调用方无感 */
export class SwappableConversationProvider implements ConversationProvider {
  constructor(private inner: ConversationProvider) {}

  swap(next: ConversationProvider): void {
    this.inner = next;
  }

  get providerId(): string {
    return this.inner.providerId;
  }

  get modelId(): string {
    return this.inner.modelId;
  }

  streamReply(context: ConversationContext, signal: AbortSignal): AsyncIterable<StreamChunk> {
    return this.inner.streamReply(context, signal);
  }

  complete(systemPrompt: string, userText: string, signal?: AbortSignal): Promise<string> {
    return this.inner.complete(systemPrompt, userText, signal);
  }
}
