/**
 * 买家的两本账（D-90）：事情账（来办的事办成没有）+ 耐心账（还能忍几次答得差的回复）。
 * 判断由买家自己做（每条回复开头那段学生看不到的判断），这里只记账，并按账算出该不该走、走了算哪种。
 * 纯函数，无数据库、无模型：服务端每轮用它记账，评测脚本在内存里用同一套。
 */
import { patienceFactor } from "./patience";

type Stage = "pre_sale" | "in_sale" | "after_sale" | "customer_care";

export type AgendaItemKind = "main" | "side" | "extra";
/** waiting：客服答应稍后回复，买家愿意等（“我去问一下再告诉您”） */
export type AgendaItemStatus = "open" | "done" | "waiting" | "dropped";

export interface AgendaItem {
  /** 序号（从 1 起），买家的判断里用它指这件事 */
  no: number;
  kind: AgendaItemKind;
  /** 给买家看的说法：主要的事是剧本目标原文，顺带的事是英文短句，临时冒出来的事是买家自己写的 */
  text: string;
  /** 顺带的事的话题（price、shipping…），去重、界面显示用 */
  topic?: string;
  status: AgendaItemStatus;
  /** 买家问了这件事、客服的回复却被判差 / 很差的次数（问了两次还没拿到能用的答复 = 2） */
  misses: number;
}

/** 买家对一轮客服回复的判断 */
export type ReplyVerdict = "good" | "ok" | "bad" | "severe";

/** 差 / 很差的原因：买家的判断里写英文代号，复盘里显示中文 */
export const REPLY_FAULTS = {
  offtopic: "答非所问",
  vague: "敷衍含糊",
  ignored: "问了不答",
  selfserve: "让买家自己去查",
  repeat: "让买家重复说",
  exaggerate: "夸大宣传",
  inconsistent: "前后说法不一",
  rude: "态度生硬",
  blame: "推卸责任",
  pressure: "施压强推",
  offplatform: "引导站外交易",
  wrongfact: "关键信息说错",
  slow: "回得太慢，买家催了",
} as const;
export type ReplyFault = keyof typeof REPLY_FAULTS;

export interface ReplyJudgement {
  /** 第几轮客服回复（连发的几条算一轮） */
  turn: number;
  /** 被判的那条客服消息（这一轮的最后一条）；催促记的是没回的那段时间，没有消息 */
  messageId?: string | null;
  verdict: ReplyVerdict;
  fault?: ReplyFault | null;
  /** 判完之后还能忍几次 */
  patienceLeft: number;
  at: string;
}

/**
 * 买家走的时候算哪种：settled 都办成 / partial 主要的办成、次要的没办成 /
 * pending 主要的事客服答应稍后回复、买家先走了 / disappointed 失望（耐心用完、主要的事没办成、等不到回复）/
 * unresolved 主要的事还悬着就走了
 */
export type BuyerOutcome = "settled" | "partial" | "pending" | "disappointed" | "unresolved";

export interface BuyerLedger {
  version: 1;
  items: AgendaItem[];
  /** 买家上一条在问哪几件事：客服下一条回复被判差的话，这几件事各记一次没答上 */
  lastAsked?: number[];
  /** 还能临时冒出来几件事（只能由客服引出：推荐了别的、回答里冒出新问题） */
  extrasLeft: number;
  patience: { start: number; left: number };
  /** 事情办完会不会不说再见、直接不回（D-90 默默离开） */
  silentLeave: boolean;
  judgements: ReplyJudgement[];
  /** 按账该走了、上一条却没走：下一条一定收尾 */
  mustLeave?: Exclude<BuyerOutcome, "unresolved"> | null;
  /** 已经走了（或默默不回了）；fault 是失望离开时最后那次差评的原因 */
  exit?: { outcome: BuyerOutcome; silent?: boolean; fault?: ReplyFault | null; at: string } | null;
}

/** 买家每条回复开头那段判断，解析后的样子（文字格式见 api 的 prompts/buyer-note.ts） */
export interface BuyerNote {
  /** 对客服最新回复的判断；null = 客服还没说过话（开场）或没写 */
  verdict: ReplyVerdict | null;
  fault: ReplyFault | null;
  /** 客服这次办成的事 */
  done: number[];
  /** 客服答应稍后回复、买家愿意等的事 */
  waiting: number[];
  /** 买家这次放弃的事 */
  dropped: number[];
  /** 这条消息在问的事 */
  asked: number[];
  /** 客服引出来、买家现在想办的新事（英文短句） */
  extra: string | null;
  leave: "no" | "yes" | "silent";
}

/**
 * 顺带的事：话题 → 各环节里给买家看的说法。环节里没有的就不会被抽到（售后投诉里不会去问尺码表、新品）。
 * 没有场景的自由练习按售前算。
 */
const SIDE_TOPICS: Record<string, Partial<Record<Stage, string>>> = {
  price: {
    pre_sale: "get a better price: a discount, a coupon or free shipping",
    in_sale: "something off the price, such as a coupon",
    after_sale: "some compensation for the trouble, such as a partial refund or a coupon",
    customer_care: "a returning-customer discount or coupon",
  },
  shipping: {
    pre_sale: "how long delivery to you takes",
    in_sale: "when exactly the parcel will reach you",
    after_sale: "how long the replacement or refund will take",
  },
  returns: {
    pre_sale: "the return and exchange policy",
    in_sale: "what happens if you need to return it",
    after_sale: "how the return works and who pays the return shipping",
  },
  specs: { pre_sale: "the materials, quality and key specs", customer_care: "the materials and quality of the new items" },
  size: { pre_sale: "which size or fit is right for you", after_sale: "getting the right size this time" },
  packaging: { pre_sale: "the packaging, or whether it can be gift-wrapped", in_sale: "whether it will be packed well" },
  warranty: { pre_sale: "the warranty and after-sales support", after_sale: "what the warranty covers" },
  genuine: { pre_sale: "whether it is genuine and properly certified", after_sale: "whether the item you got is genuine" },
  bulk: { pre_sale: "the price if you buy several or in bulk", customer_care: "a better price if you buy several" },
  invoice: { pre_sale: "an invoice and a firm delivery date", in_sale: "getting an invoice" },
  newness: { pre_sale: "whether this is the newest version and what is new", customer_care: "what is new in the store" },
  reviews: { pre_sale: "reviews, ratings or other proof that it is reliable", customer_care: "what other buyers think of the new items" },
  pick: { pre_sale: "a clear recommendation on which option to choose", customer_care: "a clear recommendation on what to get" },
  same: { pre_sale: "that it is the same quality as what you bought before", customer_care: "that the quality and service are as good as before" },
};

/** 话题的中文叫法：复盘、评分依据里说“物流时效没谈妥”用 */
export const AGENDA_TOPIC_LABELS: Record<string, string> = {
  price: "价格优惠",
  shipping: "物流时效",
  returns: "退换政策",
  specs: "材质参数",
  size: "尺码",
  packaging: "包装",
  warranty: "售后保修",
  genuine: "正品资质",
  bulk: "批量价格",
  invoice: "发票交期",
  newness: "新品",
  reviews: "评价口碑",
  pick: "选款推荐",
  same: "和上次一样的品质",
};

/** 画像关注点 → 话题 */
const CONCERN_TOPICS: Record<string, string> = {
  价格优惠: "price",
  物流时效: "shipping",
  退换政策: "returns",
  材质参数: "specs",
  尺码合身: "size",
  包装礼盒: "packaging",
  售后保修: "warranty",
  正品资质: "genuine",
  批量价格: "bulk",
  发票交期: "invoice",
  新品: "newness",
};

/** 消费偏好带出来的事（价格敏感型一定要个优惠、选择困难型要客服帮着定），环节里问得出口就一定在清单上 */
const STYLE_TOPICS: Record<string, string> = {
  品质导向型: "specs",
  品牌口碑型: "reviews",
  新奇尝鲜型: "newness",
  价格敏感型: "price",
  选择困难型: "pick",
  习惯忠诚型: "same",
};

/** 关注点里再抽几件（含两端），按性格：直接高效的偏少，理性谨慎、敏感挑剔的偏多 */
const CONCERN_COUNT: Record<string, readonly [number, number]> = {
  直接高效: [0, 1],
  友好健谈: [1, 2],
  犹豫保守: [1, 2],
  理性谨慎: [1, 3],
  敏感挑剔: [1, 3],
};
const DEFAULT_CONCERN_COUNT = [0, 2] as const;
/** 顺带的事最多几件 */
const MAX_SIDE = 3;

/** 容易被客服带着走的消费偏好：临时冒出来的事最多 2 件；其余一半 0 件、一半 1 件 */
const OPEN_STYLES = new Set(["享受逛买型", "冲动下单型", "新奇尝鲜型"]);

/** 事情办完不说再见、直接不回的概率，按性格（直接高效的多一些，总体约一成半） */
const SILENT_RATE: Record<string, number> = {
  直接高效: 0.35,
  理性谨慎: 0.15,
  犹豫保守: 0.15,
  敏感挑剔: 0.1,
  友好健谈: 0.05,
};
const DEFAULT_SILENT_RATE = 0.15;

/** 能忍几次的环节基数：售前、客户维护换一家店很容易，售中、售后钱在店里、没法一走了之 */
const STAGE_PATIENCE: Record<Stage, number> = { pre_sale: 2, customer_care: 2, in_sale: 3, after_sale: 3 };
export const PATIENCE_MIN = 1;
export const PATIENCE_MAX = 4;

const VERDICT_DELTA: Record<ReplyVerdict, number> = { good: 1, ok: 0, bad: -1, severe: -2 };

function stageOf(stage: string | null | undefined): Stage {
  return stage && stage in STAGE_PATIENCE ? (stage as Stage) : "pre_sale";
}

/** 能忍几次 = 环节基数 × 耐心倍率（性格 × 情绪，D-40），四舍五入，1–4 次 */
export function patienceStart(stage: string | null | undefined, persona: { emotion?: unknown; personality?: unknown }): number {
  const base = STAGE_PATIENCE[stageOf(stage)];
  return Math.min(PATIENCE_MAX, Math.max(PATIENCE_MIN, Math.round(base * patienceFactor(persona))));
}

export interface PlanLedgerInput {
  stage?: string | null;
  /** 剧本里买家的目标；没有剧本用场景目标 */
  goal?: string | null;
  persona: { personality?: unknown; emotion?: unknown; decisionStyle?: unknown; concerns?: unknown };
}

/** 开会话时定好这位买家来办的事、能忍几次、办完会不会默默走 */
export function planBuyerLedger(input: PlanLedgerInput, random: () => number = Math.random): BuyerLedger {
  const stage = stageOf(input.stage);
  const persona = input.persona;
  const personality = typeof persona.personality === "string" ? persona.personality : "";
  const style = typeof persona.decisionStyle === "string" ? persona.decisionStyle : "";
  const fits = (topic: string | undefined): topic is string => Boolean(topic && SIDE_TOPICS[topic]?.[stage]);

  const topics: string[] = [];
  const styleTopic = STYLE_TOPICS[style];
  if (fits(styleTopic)) topics.push(styleTopic);
  const concernTopics = (Array.isArray(persona.concerns) ? persona.concerns : [])
    .map((concern) => CONCERN_TOPICS[String(concern)])
    .filter((topic): topic is string => fits(topic) && !topics.includes(topic));
  const unique = [...new Set(concernTopics)];
  // 洗牌后取前几件：同一种画像每次来办的事不一样多
  for (let i = unique.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [unique[i], unique[j]] = [unique[j]!, unique[i]!];
  }
  const [low, high] = CONCERN_COUNT[personality] ?? DEFAULT_CONCERN_COUNT;
  const count = low + Math.floor(random() * (high - low + 1));
  topics.push(...unique.slice(0, count));

  const goal = input.goal?.trim() || "what you came to the store for";
  const items: AgendaItem[] = [
    { no: 1, kind: "main", text: goal, status: "open", misses: 0 },
    ...topics.slice(0, MAX_SIDE).map((topic, index): AgendaItem => ({
      no: index + 2,
      kind: "side",
      text: SIDE_TOPICS[topic]![stage]!,
      topic,
      status: "open",
      misses: 0,
    })),
  ];
  const start = patienceStart(stage, persona);
  return {
    version: 1,
    items,
    lastAsked: [],
    extrasLeft: OPEN_STYLES.has(style) ? 2 : random() < 0.5 ? 1 : 0,
    patience: { start, left: start },
    silentLeave: random() < (SILENT_RATE[personality] ?? DEFAULT_SILENT_RATE),
    judgements: [],
    mustLeave: null,
    exit: null,
  };
}

function cloneLedger(ledger: BuyerLedger): BuyerLedger {
  return {
    ...ledger,
    items: ledger.items.map((item) => ({ ...item })),
    lastAsked: [...(ledger.lastAsked ?? [])],
    patience: { ...ledger.patience },
    judgements: [...ledger.judgements],
  };
}

/**
 * 按买家这条回复开头的判断记账：
 * - 判断客服这一轮：好加回 1（不超过开始时）、一般不变、差减 1、很差减 2；同一轮只记一次（重试不重复扣）
 * - 买家上一条问的事，客服这条被判差 / 很差又没办成 → 记一次没答上；两次 → 不再问了（主要的事就该走了）。
 *   客服反问订单号、答得不全（一般）都不算没答上
 * - 办成 / 等客服回复 / 放弃 / 在问的事、客服引出来的新事（还有名额才收）
 */
export function applyBuyerNote(
  ledger: BuyerLedger,
  note: BuyerNote,
  context: { agentTurn: number; messageId?: string | null; at?: string },
): BuyerLedger {
  const next = cloneLedger(ledger);
  const at = context.at ?? new Date().toISOString();
  const byNo = new Map(next.items.map((item) => [item.no, item]));
  const judged =
    note.verdict !== null &&
    context.agentTurn > 0 &&
    !next.judgements.some((item) => item.turn === context.agentTurn && item.fault !== "slow");
  if (judged) {
    const verdict = note.verdict!;
    next.patience.left = Math.min(next.patience.start, Math.max(0, next.patience.left + VERDICT_DELTA[verdict]));
    next.judgements.push({
      turn: context.agentTurn,
      messageId: context.messageId ?? null,
      verdict,
      fault: verdict === "bad" || verdict === "severe" ? note.fault : null,
      patienceLeft: next.patience.left,
      at,
    });
    if (verdict === "bad" || verdict === "severe") {
      for (const no of ledger.lastAsked ?? []) {
        const item = byNo.get(no);
        if (item?.status !== "open" || note.done.includes(no) || note.waiting.includes(no)) continue;
        item.misses += 1;
        if (item.misses >= 2) item.status = "dropped";
      }
    }
  }
  for (const no of note.done) {
    const item = byNo.get(no);
    if (item && (item.status === "open" || item.status === "waiting")) item.status = "done";
  }
  for (const no of note.waiting) {
    const item = byNo.get(no);
    if (item?.status === "open") item.status = "waiting";
  }
  for (const no of note.dropped) {
    const item = byNo.get(no);
    if (item && (item.status === "open" || item.status === "waiting")) item.status = "dropped";
  }
  next.lastAsked = [...new Set(note.asked)].filter((no) => byNo.get(no)?.status === "open");
  const extra = note.extra?.trim();
  if (extra && next.extrasLeft > 0) {
    const no = Math.max(...next.items.map((item) => item.no)) + 1;
    next.items.push({ no, kind: "extra", text: extra.slice(0, 120), status: "open", misses: 0 });
    next.extrasLeft -= 1;
    // 冒出来的那一刻买家就在问它了
    next.lastAsked.push(no);
  }
  return next;
}

/** 客服久不回、买家催了一次（D-40 催促）：减 1，复盘里记一条“回得太慢” */
export function applyWaitPenalty(ledger: BuyerLedger, context: { agentTurn: number; at?: string }): BuyerLedger {
  const next = cloneLedger(ledger);
  next.patience.left = Math.max(0, next.patience.left - 1);
  next.judgements.push({
    turn: context.agentTurn,
    messageId: null,
    verdict: "bad",
    fault: "slow",
    patienceLeft: next.patience.left,
    at: context.at ?? new Date().toISOString(),
  });
  return next;
}

/**
 * 按账是不是该走了：耐心用完或主要的事没办成 → 失望；没有还要问的事了（都办成、等客服回复或放弃）→
 * 都办成 / 主要的办成 / 主要的等客服回复；还有没办的事 → null（接着聊）
 */
export function ledgerDue(ledger: BuyerLedger): Exclude<BuyerOutcome, "unresolved"> | null {
  if (ledger.patience.left <= 0) return "disappointed";
  const main = ledger.items.find((item) => item.kind === "main");
  if (main?.status === "dropped") return "disappointed";
  if (ledger.items.some((item) => item.status === "open")) return null;
  if (ledger.items.every((item) => item.status === "done")) return "settled";
  return main?.status === "waiting" ? "pending" : "partial";
}

/** 买家这会儿走，算哪种（自己决定提前走的：主要的办成算 partial、在等客服回复算 pending，还悬着算 unresolved） */
export function exitOutcome(ledger: BuyerLedger): BuyerOutcome {
  const due = ledgerDue(ledger);
  if (due) return due;
  const main = ledger.items.find((item) => item.kind === "main")?.status;
  return main === "done" ? "partial" : main === "waiting" ? "pending" : "unresolved";
}

/** 记下买家走了：失望离开时带上最后那次差评的原因，复盘里说清楚为什么走 */
export function recordExit(
  ledger: BuyerLedger,
  options: { silent?: boolean; at?: string; outcome?: BuyerOutcome; fault?: ReplyFault | null } = {},
): BuyerLedger {
  const next = cloneLedger(ledger);
  const outcome = options.outcome ?? exitOutcome(next);
  const lastFault = [...next.judgements].reverse().find((item) => item.verdict === "bad" || item.verdict === "severe")?.fault ?? null;
  next.exit = {
    outcome,
    ...(options.silent ? { silent: true } : {}),
    fault: options.fault !== undefined ? options.fault : outcome === "disappointed" ? lastFault : null,
    at: options.at ?? new Date().toISOString(),
  };
  next.mustLeave = null;
  return next;
}

/** 结束时用来定星级的结局：买家自己走的看当时记下的；别的结束方式（学生结束、超时）按账，事情还没办完的不限 */
export function ledgerOutcome(ledger: BuyerLedger | null | undefined): BuyerOutcome | null {
  if (!ledger) return null;
  return ledger.exit?.outcome ?? ledgerDue(ledger);
}

/** 复盘里标出来的一条：这条学生消息让买家不满（同一条被判过几次合在一起） */
export interface BuyerComplaint {
  messageId: string;
  /** 有一次判为很差 */
  severe: boolean;
  faults: ReplyFault[];
  /** 买家失望离开前最后一条让他不满的消息（“随后离开”） */
  last: boolean;
}

/**
 * 哪几条学生消息让买家不满（D-90 复盘标注、评分依据）：被判差 / 很差的；“回得太慢”没有对应消息，
 * 标在被催之后学生的第一条回复上。买家失望离开（不是等不到回复走的）时，最后一条标“随后离开”。
 */
export function buyerComplaints(
  ledger: BuyerLedger | null | undefined,
  studentMessages: ReadonlyArray<{ id: string; at: number }>,
): BuyerComplaint[] {
  if (!ledger) return [];
  const list: BuyerComplaint[] = [];
  for (const judgement of ledger.judgements) {
    if (judgement.verdict !== "bad" && judgement.verdict !== "severe") continue;
    let messageId = judgement.messageId ?? null;
    if (!messageId && judgement.fault === "slow") {
      const at = Date.parse(judgement.at);
      messageId = studentMessages.find((message) => message.at > at)?.id ?? null;
    }
    if (!messageId) continue;
    let item = list.find((entry) => entry.messageId === messageId);
    if (!item) {
      item = { messageId, severe: false, faults: [], last: false };
      list.push(item);
    }
    if (judgement.verdict === "severe") item.severe = true;
    if (judgement.fault && !item.faults.includes(judgement.fault)) item.faults.push(judgement.fault);
  }
  const exit = ledger.exit;
  if (exit?.outcome === "disappointed" && !exit.silent && exit.fault !== "slow" && list.length) list[list.length - 1]!.last = true;
  return list;
}
