import type { BuyerNote, ReplyFault, ReplyVerdict } from "@cecs/domain";
import { REPLY_FAULTS } from "@cecs/domain";

/**
 * 买家每条回复开头那段判断（D-90）：<<reply=bad/vague done=2 ask=3 leave=no>>。
 * 学生看不到：流式外发前截下来，服务端记账（domain 的 buyer-ledger）。写在开头是为了让买家先判断、再照着判断说话；
 * 首字按第一个正文字算，判断本身大约多花 0.1 秒。
 */
export const NOTE_OPEN = "<<";
export const NOTE_CLOSE = ">>";
/** 判断最长这么多字还没写完，就不当它是判断了 */
const NOTE_MAX_CHARS = 400;

const VERDICTS: Record<string, ReplyVerdict | null> = { good: "good", ok: "ok", okay: "ok", bad: "bad", poor: "bad", severe: "severe", none: null };

/** 模型偶尔写近义词：能对上的归到已有代号，对不上的不记原因 */
const FAULT_ALIASES: Record<string, ReplyFault> = {
  offtopic: "offtopic",
  irrelevant: "offtopic",
  vague: "vague",
  evasive: "vague",
  canned: "vague",
  template: "vague",
  ignored: "ignored",
  ignore: "ignored",
  unanswered: "ignored",
  selfserve: "selfserve",
  lookup: "selfserve",
  repeat: "repeat",
  exaggerate: "exaggerate",
  exaggerated: "exaggerate",
  exaggeration: "exaggerate",
  overclaim: "exaggerate",
  inconsistent: "inconsistent",
  contradiction: "inconsistent",
  rude: "rude",
  blame: "blame",
  blaming: "blame",
  pressure: "pressure",
  pushy: "pressure",
  offplatform: "offplatform",
  wrongfact: "wrongfact",
  wrong: "wrongfact",
};

function normalizeFault(raw: string | undefined): ReplyFault | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (key in REPLY_FAULTS) return key as ReplyFault;
  return FAULT_ALIASES[key] ?? null;
}

function numbers(raw: string | undefined): number[] {
  if (!raw) return [];
  return [...raw.matchAll(/\d+/g)].map((match) => Number(match[0])).filter((value) => value > 0 && value < 50);
}

/** 解析判断正文（不含 << >>）；一个字段都认不出来就返回 null */
export function parseBuyerNote(raw: string | null | undefined): BuyerNote | null {
  if (!raw) return null;
  // 按“键=”切开：值是到下一个键之前的那一段（extra 里可能有空格）；只认这几个键，值里的冒号不算
  const fields = new Map<string, string>();
  const pattern = /\b(reply|done|waiting|wait|dropped|drop|asked|ask|extra|leave)\s*[=:]/gi;
  const keys = [...raw.matchAll(pattern)];
  keys.forEach((match, index) => {
    const start = match.index! + match[0].length;
    const end = index + 1 < keys.length ? keys[index + 1]!.index! : raw.length;
    fields.set(match[1]!.toLowerCase(), raw.slice(start, end).replace(/^[\s"']+|[\s"';|,]+$/g, ""));
  });
  if (fields.size === 0) return null;
  const reply = fields.get("reply") ?? "";
  const [verdictWord, faultWord] = reply.split(/[\s/:\-]+/).filter(Boolean);
  const verdict = verdictWord ? VERDICTS[verdictWord.toLowerCase()] ?? null : null;
  const leaveWord = (fields.get("leave") ?? "no").toLowerCase();
  const extra = fields.get("extra")?.trim() || null;
  return {
    verdict,
    fault: verdict === "bad" || verdict === "severe" ? normalizeFault(faultWord) : null,
    done: numbers(fields.get("done")),
    waiting: numbers(fields.get("wait") ?? fields.get("waiting")),
    dropped: numbers(fields.get("dropped") ?? fields.get("drop")),
    asked: numbers(fields.get("ask") ?? fields.get("asked")),
    extra: extra && extra !== "-" && extra.toLowerCase() !== "none" ? extra : null,
    leave: leaveWord.startsWith("silent") ? "silent" : leaveWord.startsWith("yes") ? "yes" : "no",
  };
}

/** 存库和放回聊天记录用的标准写法（空字段不写），买家照着学的就是这个样子 */
export function serializeBuyerNote(note: BuyerNote): string {
  const list = (values: number[]) => values.join(",");
  return [
    `reply=${note.verdict ?? "none"}${note.fault ? `/${note.fault}` : ""}`,
    note.done.length ? `done=${list(note.done)}` : "",
    note.waiting.length ? `wait=${list(note.waiting)}` : "",
    note.dropped.length ? `dropped=${list(note.dropped)}` : "",
    note.asked.length ? `ask=${list(note.asked)}` : "",
    note.extra ? `extra=${note.extra}` : "",
    `leave=${note.leave}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * 流式拆出开头的判断：判断写完之前一个正文字都不放出去；开头不是 << 就当这条没有判断。
 * 忘了写 >> 的，遇到换行就当判断结束。
 */
export class BuyerNoteSplitter {
  private head = "";
  private passed = false;
  /** 判断后面紧跟的空格、换行不算正文（可能落在下一段里） */
  private trimLead = false;
  /** 截下来的判断正文（不含 << >>）；没有就是 null */
  note: string | null = null;

  /** 喂一段模型输出，返回可以当正文处理的部分 */
  push(chunk: string): string {
    if (this.passed) {
      if (!this.trimLead) return chunk;
      const text = chunk.replace(/^\s+/, "");
      if (text) this.trimLead = false;
      return text;
    }
    this.head += chunk;
    const trimmed = this.head.trimStart();
    if (!trimmed) return "";
    if (!trimmed.startsWith(NOTE_OPEN)) {
      if (NOTE_OPEN.startsWith(trimmed)) return "";
      this.passed = true;
      return this.head;
    }
    const close = trimmed.indexOf(NOTE_CLOSE, NOTE_OPEN.length);
    const newline = trimmed.indexOf("\n", NOTE_OPEN.length);
    const end = close >= 0 ? close : newline;
    if (end < 0) {
      if (trimmed.length <= NOTE_MAX_CHARS) return "";
      this.passed = true;
      return this.head;
    }
    this.note = trimmed.slice(NOTE_OPEN.length, end).trim();
    this.passed = true;
    const rest = trimmed.slice(end + (close >= 0 ? NOTE_CLOSE.length : 1)).replace(/^\s+/, "");
    this.trimLead = !rest;
    return rest;
  }

  /** 输出结束：判断一直没写完的，剩下的全当正文（最后再统一清掉残留的 <<） */
  finish(): string {
    if (this.passed) return "";
    this.passed = true;
    return this.head;
  }
}

/**
 * 正文里残留的判断（写到末尾、写了两次、没写完）一律清掉；返回清过的正文和清掉的第一段判断。
 * 不动别的字：流式外发停在判断前面，已经发出去的部分位置不能变
 */
export function stripBuyerNotes(text: string): { text: string; note: string | null } {
  let first: string | null = null;
  const cleaned = text
    .replace(/<<([^<>]{0,400})>>/g, (_, body: string) => {
      first ??= body.trim();
      return "";
    })
    .replace(/<<[^\n]*$/, "");
  return { text: cleaned, note: first };
}
