import { describe, expect, it } from "vitest";
import {
  applyBuyerNote,
  applyWaitPenalty,
  buyerComplaints,
  exitOutcome,
  ledgerDue,
  ledgerOutcome,
  patienceStart,
  planBuyerLedger,
  recordExit,
  starsForOutcome,
  type BuyerLedger,
  type BuyerNote,
} from "./index";

/** 固定的随机序列：按顺序循环取值 */
function sequence(...values: number[]) {
  let index = 0;
  return () => values[index++ % values.length]!;
}

const note = (patch: Partial<BuyerNote>): BuyerNote => ({
  verdict: null,
  fault: null,
  done: [],
  waiting: [],
  dropped: [],
  asked: [],
  extra: null,
  leave: "no",
  ...patch,
});

function ledgerOf(items: number, patience: number): BuyerLedger {
  return {
    version: 1,
    items: Array.from({ length: items }, (_, index) => ({
      no: index + 1,
      kind: index === 0 ? "main" : "side",
      text: `item ${index + 1}`,
      status: "open",
      misses: 0,
    })),
    extrasLeft: 1,
    patience: { start: patience, left: patience },
    silentLeave: false,
    judgements: [],
    mustLeave: null,
    exit: null,
  };
}

describe("耐心账：能忍几次（D-90）", () => {
  it("售前、维护基数 2，售中、售后基数 3，乘性格 × 情绪倍率，限制在 1–4", () => {
    expect(patienceStart("pre_sale", { personality: "犹豫保守", emotion: "平静" })).toBe(2);
    expect(patienceStart("after_sale", { personality: "犹豫保守", emotion: "平静" })).toBe(3);
    expect(patienceStart("after_sale", { personality: "理性谨慎", emotion: "平静" })).toBe(4);
    // 急的、本来就不满的：一次答差就走
    expect(patienceStart("pre_sale", { personality: "直接高效", emotion: "不满" })).toBe(1);
    expect(patienceStart("after_sale", { personality: "友好健谈", emotion: "期待" })).toBe(4);
    // 没场景的自由练习按售前算
    expect(patienceStart(null, { personality: "犹豫保守", emotion: "平静" })).toBe(2);
  });

  it("好加回 1（不超过开始时），一般不变，差减 1，很差减 2；减到 0 就该走", () => {
    let ledger = ledgerOf(2, 3);
    ledger = applyBuyerNote(ledger, note({ verdict: "good" }), { agentTurn: 1 });
    expect(ledger.patience.left).toBe(3);
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "vague" }), { agentTurn: 2 });
    expect(ledger.patience.left).toBe(2);
    ledger = applyBuyerNote(ledger, note({ verdict: "ok" }), { agentTurn: 3 });
    expect(ledger.patience.left).toBe(2);
    expect(ledgerDue(ledger)).toBeNull();
    ledger = applyBuyerNote(ledger, note({ verdict: "severe", fault: "blame" }), { agentTurn: 4, messageId: "m4" });
    expect(ledger.patience.left).toBe(0);
    expect(ledgerDue(ledger)).toBe("disappointed");
    expect(ledger.judgements.map((item) => [item.turn, item.verdict, item.fault, item.patienceLeft])).toEqual([
      [1, "good", null, 3],
      [2, "bad", "vague", 2],
      [3, "ok", null, 2],
      [4, "severe", "blame", 0],
    ]);
    expect(ledger.judgements[3]!.messageId).toBe("m4");
  });

  it("同一轮只记一次（重试不重复扣）；开场没有客服回复不判", () => {
    let ledger = ledgerOf(1, 2);
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "vague", asked: [1] }), { agentTurn: 0 });
    expect(ledger.judgements).toHaveLength(0);
    expect(ledger.patience.left).toBe(2);
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "vague" }), { agentTurn: 1 });
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "vague" }), { agentTurn: 1 });
    expect(ledger.patience.left).toBe(1);
  });

  it("被晾到催了一次减 1，复盘记“回得太慢”，不占那一轮的判断", () => {
    let ledger = applyWaitPenalty(ledgerOf(1, 2), { agentTurn: 2 });
    expect(ledger.patience.left).toBe(1);
    expect(ledger.judgements[0]).toMatchObject({ verdict: "bad", fault: "slow", patienceLeft: 1 });
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "ignored" }), { agentTurn: 2 });
    expect(ledger.patience.left).toBe(0);
  });
});

describe("事情账：来办的事（D-90）", () => {
  it("主要的事来自剧本目标；消费偏好带出来的事环节问得出口就一定在；关注点按性格抽，售后不问尺码表", () => {
    const presale = planBuyerLedger(
      { stage: "pre_sale", goal: "确认这款手表适不适合自己", persona: { personality: "理性谨慎", emotion: "平静", decisionStyle: "价格敏感型", concerns: ["物流时效", "材质参数", "价格优惠"] } },
      sequence(0.99, 0.99, 0.99, 0.1, 0.5),
    );
    expect(presale.items[0]).toMatchObject({ no: 1, kind: "main", text: "确认这款手表适不适合自己", status: "open" });
    expect(presale.items[1]).toMatchObject({ kind: "side", topic: "price" });
    // 价格优惠和消费偏好重复，只留一次
    expect(presale.items.filter((item) => item.topic === "price")).toHaveLength(1);
    expect(presale.items.length).toBeLessThanOrEqual(4);

    const afterSale = planBuyerLedger(
      { stage: "after_sale", goal: "要求退款或补发", persona: { personality: "理性谨慎", emotion: "不满", decisionStyle: "选择困难型", concerns: ["尺码合身", "新品", "材质参数"] } },
      sequence(0.99),
    );
    // 售后没有“尺码表之外”的这些话题：选择困难型的推荐、新品、材质都不在清单上
    expect(afterSale.items.map((item) => item.topic ?? "main")).toEqual(["main", "size"]);
  });

  it("直接高效、没带出话题的买家可能只来办一件事；件数随抽签变化", () => {
    const single = planBuyerLedger(
      { stage: "pre_sale", goal: "有没有 M 码", persona: { personality: "直接高效", emotion: "平静", decisionStyle: "冲动下单型", concerns: ["物流时效"] } },
      sequence(0),
    );
    expect(single.items).toHaveLength(1);
    // 冲动下单型容易被带着走：临时冒出来的事最多 2 件
    expect(single.extrasLeft).toBe(2);
    const more = planBuyerLedger(
      { stage: "pre_sale", goal: "有没有 M 码", persona: { personality: "直接高效", emotion: "平静", decisionStyle: "冲动下单型", concerns: ["物流时效"] } },
      sequence(0.99),
    );
    expect(more.items).toHaveLength(2);
  });

  it("问了两次还没答上：次要的放下，主要的就该失望地走", () => {
    let ledger = ledgerOf(2, 4);
    ledger = applyBuyerNote(ledger, note({ asked: [2] }), { agentTurn: 0 });
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "vague", asked: [2] }), { agentTurn: 1 });
    expect(ledger.items[1]).toMatchObject({ status: "open", misses: 1 });
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "ignored", asked: [1] }), { agentTurn: 2 });
    expect(ledger.items[1]!.status).toBe("dropped");
    expect(ledgerDue(ledger)).toBeNull();
    ledger = applyBuyerNote(ledger, note({ verdict: "good" }), { agentTurn: 3 });
    expect(ledger.items[0]).toMatchObject({ status: "open", misses: 0 });

    let main = ledgerOf(1, 4);
    main = applyBuyerNote(main, note({ asked: [1] }), { agentTurn: 0 });
    main = applyBuyerNote(main, note({ verdict: "bad", fault: "vague", asked: [1] }), { agentTurn: 1 });
    main = applyBuyerNote(main, note({ verdict: "severe", fault: "blame" }), { agentTurn: 2 });
    expect(main.items[0]!.status).toBe("dropped");
    expect(main.patience.left).toBe(1);
    expect(ledgerDue(main)).toBe("disappointed");
  });

  it("客服反问订单号、答得不全（一般）不算没答上；这次答上了就算办成", () => {
    let ledger = ledgerOf(1, 2);
    ledger = applyBuyerNote(ledger, note({ asked: [1] }), { agentTurn: 0 });
    ledger = applyBuyerNote(ledger, note({ verdict: "ok", asked: [1] }), { agentTurn: 1 });
    ledger = applyBuyerNote(ledger, note({ verdict: "ok", asked: [1] }), { agentTurn: 2 });
    expect(ledger.items[0]).toMatchObject({ status: "open", misses: 0 });
    ledger = applyBuyerNote(ledger, note({ verdict: "good", done: [1] }), { agentTurn: 3 });
    expect(ledger.items[0]!.status).toBe("done");
    expect(ledgerDue(ledger)).toBe("settled");
  });

  it("客服答应稍后回复：没有还要问的事就收尾；主要的在等算 pending（不限星级），之后办成照样算办成", () => {
    let ledger = ledgerOf(2, 2);
    ledger = applyBuyerNote(ledger, note({ verdict: "ok", waiting: [1], asked: [2] }), { agentTurn: 1 });
    expect(ledger.items[0]!.status).toBe("waiting");
    expect(ledgerDue(ledger)).toBeNull();
    const pending = applyBuyerNote(ledger, note({ verdict: "good", done: [2] }), { agentTurn: 2 });
    expect(ledgerDue(pending)).toBe("pending");
    expect(starsForOutcome(5, "pending")).toBe(5);
    const later = applyBuyerNote(pending, note({ verdict: "good", done: [1] }), { agentTurn: 3 });
    expect(ledgerDue(later)).toBe("settled");
  });

  it("客服引出来的新事有名额才收，编号接着往下排", () => {
    let ledger = ledgerOf(1, 2);
    ledger = applyBuyerNote(ledger, note({ verdict: "good", extra: "the matching strap" }), { agentTurn: 1 });
    // 冒出来的这件事买家正在问：客服下一条答差了就记一次没答上
    expect(ledger.lastAsked).toEqual([2]);
    ledger = applyBuyerNote(ledger, note({ verdict: "good", extra: "a gift box" }), { agentTurn: 2 });
    expect(ledger.items.map((item) => [item.no, item.kind, item.text])).toEqual([
      [1, "main", "item 1"],
      [2, "extra", "the matching strap"],
    ]);
    expect(ledger.extrasLeft).toBe(0);
  });

  it("都办成 / 主要的办成 / 主要的还悬着：走的时候算法不同", () => {
    const base = ledgerOf(2, 2);
    const allDone = applyBuyerNote(base, note({ verdict: "good", done: [1, 2] }), { agentTurn: 1 });
    expect(exitOutcome(allDone)).toBe("settled");
    const mainDone = applyBuyerNote(base, note({ verdict: "good", done: [1], dropped: [2] }), { agentTurn: 1 });
    expect(exitOutcome(mainDone)).toBe("partial");
    const leftEarly = applyBuyerNote(base, note({ verdict: "good", done: [1] }), { agentTurn: 1 });
    expect(ledgerDue(leftEarly)).toBeNull();
    expect(exitOutcome(leftEarly)).toBe("partial");
    expect(exitOutcome(base)).toBe("unresolved");
  });

  it("记下离开：失望的带上最后那次差评的原因；学生结束等别的方式按账算结局", () => {
    let ledger = ledgerOf(1, 1);
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "exaggerate" }), { agentTurn: 1 });
    const left = recordExit(ledger);
    expect(left.exit).toMatchObject({ outcome: "disappointed", fault: "exaggerate" });
    expect(ledgerOutcome(left)).toBe("disappointed");
    const silent = recordExit(applyBuyerNote(ledgerOf(1, 2), note({ verdict: "good", done: [1] }), { agentTurn: 1 }), { silent: true });
    expect(silent.exit).toMatchObject({ outcome: "settled", silent: true, fault: null });
    // 事情还悬着就被学生结束：不限星级
    expect(ledgerOutcome(ledgerOf(2, 2))).toBeNull();
    expect(ledgerOutcome(null)).toBeNull();
  });
});

describe("复盘标注：哪几条让买家不满（D-90）", () => {
  it("差 / 很差的学生消息标出来；回得太慢标在被催后的第一条回复上；失望离开时最后一条标随后离开", () => {
    const t0 = Date.parse("2026-10-22T10:00:00Z");
    const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
    let ledger = ledgerOf(1, 4);
    ledger = applyBuyerNote(ledger, note({ verdict: "good" }), { agentTurn: 1, messageId: "s1", at: at(1) });
    ledger = applyWaitPenalty(ledger, { agentTurn: 1, at: at(4) });
    ledger = applyBuyerNote(ledger, note({ verdict: "bad", fault: "vague" }), { agentTurn: 2, messageId: "s2", at: at(6) });
    ledger = applyBuyerNote(ledger, note({ verdict: "severe", fault: "blame" }), { agentTurn: 3, messageId: "s3", at: at(7) });
    const messages = [
      { id: "s1", at: t0 + 60_000 },
      { id: "s2", at: t0 + 5 * 60_000 },
      { id: "s3", at: t0 + 7 * 60_000 },
    ];
    expect(buyerComplaints(ledger, messages)).toEqual([
      { messageId: "s2", severe: false, faults: ["slow", "vague"], last: false },
      { messageId: "s3", severe: true, faults: ["blame"], last: false },
    ]);
    const left = recordExit(ledger);
    expect(left.exit?.outcome).toBe("disappointed");
    expect(buyerComplaints(left, messages).at(-1)).toMatchObject({ messageId: "s3", last: true });
    // 满意离开、没有账：不标“随后离开” / 什么都不标
    expect(buyerComplaints(recordExit(ledger, { outcome: "settled" }), messages).some((item) => item.last)).toBe(false);
    expect(buyerComplaints(null, messages)).toEqual([]);
  });
});

describe("星级跟着离开原因走（D-90）", () => {
  it("失望最多 2 星，都办成至少 4 星，主要的办成 3–4 星，其余照满意度", () => {
    expect(starsForOutcome(4, "disappointed")).toBe(2);
    expect(starsForOutcome(1, "disappointed")).toBe(1);
    expect(starsForOutcome(3, "settled")).toBe(4);
    expect(starsForOutcome(5, "settled")).toBe(5);
    expect(starsForOutcome(5, "partial")).toBe(4);
    expect(starsForOutcome(1, "partial")).toBe(3);
    expect(starsForOutcome(2, "unresolved")).toBe(2);
    expect(starsForOutcome(5, null)).toBe(5);
  });
});
