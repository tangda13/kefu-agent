import {
  applyBuyerNote,
  ledgerDue,
  planBuyerLedger,
  recordExit,
  type BuyerLedger,
  type BuyerNote,
} from "@cecs/domain";
import type { ScenarioScript } from "@cecs/contracts";
import type { Db } from "./db";

/**
 * 买家的两本账（D-90）存 conversations.buyer_ledger。记账规则在 domain 的 buyer-ledger.ts；
 * 这里是“一条买家回复之后走不走”的判定（实时回复和评测脚本共用）和读写库。
 */

/** 老会话、上线前开的会话没有账：第一次轮到买家说话时按画像和场景补一份 */
export async function loadOrPlanLedger(
  db: Db,
  conversation: { id: string; persona: Record<string, unknown>; buyer_ledger?: BuyerLedger | null },
  scene: { stage: string | null; objective: string | null; script: ScenarioScript | null },
): Promise<BuyerLedger> {
  if (conversation.buyer_ledger?.version === 1) return conversation.buyer_ledger;
  const ledger = planBuyerLedger({
    stage: scene.stage,
    goal: scene.script?.buyerGoal ?? scene.objective,
    persona: conversation.persona,
  });
  await saveLedger(db, conversation.id, ledger);
  return ledger;
}

export async function saveLedger(db: Db, conversationId: string, ledger: BuyerLedger): Promise<void> {
  await db.query("update conversations set buyer_ledger = $2 where id = $1", [conversationId, JSON.stringify(ledger)]);
}

export interface BuyerTurnSettlement {
  ledger: BuyerLedger;
  /** 这一条就走：said = 说了告别的话（或该走了就当这条是告别）；silent = 不说话、直接不回 */
  leave: "said" | "silent" | null;
}

/**
 * 一条买家回复记完账之后走不走：
 * - 带了离开标记、判断里写了 leave=yes，或者默默离开 → 走（默默离开只给本来就会默默走的买家，别的照常说再见）；
 * - 上一条按账该走却没走 → 这条不管说了什么都算告别；
 * - 都没有：按账该走了就记下来，下一条一定收尾（提示词里会写）。
 */
export function settleBuyerTurn(
  ledger: BuyerLedger,
  input: { note: BuyerNote | null; endMarked: boolean; hasText: boolean; agentTurn: number; messageId?: string | null; at?: string },
): BuyerTurnSettlement {
  const at = input.at ?? new Date().toISOString();
  const next = input.note ? applyBuyerNote(ledger, input.note, { agentTurn: input.agentTurn, messageId: input.messageId, at }) : ledger;
  let leave: BuyerTurnSettlement["leave"] = null;
  if (input.note?.leave === "silent" && (ledger.silentLeave || !input.hasText)) leave = "silent";
  else if (input.endMarked || input.note?.leave === "yes" || input.note?.leave === "silent" || ledger.mustLeave) leave = input.hasText ? "said" : "silent";
  if (leave) return { ledger: recordExit(next, { silent: leave === "silent", at }), leave };
  return { ledger: { ...next, mustLeave: ledgerDue(next) }, leave: null };
}
