import { describe, expect, it } from "vitest";
import type { BuyerLedger } from "@cecs/domain";
import {
  buildBuyerMessages,
  buildBuyerNudgeMessages,
  buildBuyerSystemPrompt,
  buildChineseFixMessages,
  BUYER_WRAP_UP_TURNS,
  countAgentTurns,
  type BuyerContext,
} from "./buyer";

const NOW = new Date("2026-10-16T04:00:00Z");

function context(overrides: Partial<BuyerContext> = {}): BuyerContext {
  return {
    scenePrompt: "议价与批量询价：守住价格底线",
    personaSnapshot: { name: "Javier Sánchez", language: "es-ES", emotion: "期待" },
    orderSnapshot: {},
    history: [],
    now: NOW,
    ...overrides,
  };
}

/** n 轮“客服说一句、买家回一句” */
function rounds(n: number, endWithStudent = true) {
  const history: BuyerContext["history"][number][] = [{ role: "buyer", content: "Hola" }];
  for (let i = 0; i < n; i += 1) {
    history.push({ role: "student", content: `回复 ${i}` });
    if (i < n - 1 || !endWithStudent) history.push({ role: "buyer", content: `vale ${i}` });
  }
  return history;
}

describe("买家是自主 agent（D-50）", () => {
  it("提示词里没有导演指令、备忘录、满意度这些外部状态", () => {
    const prompt = buildBuyerSystemPrompt(context({ history: rounds(3) }));
    expect(prompt).not.toMatch(/Director|director|Key facts agreed|satisfaction|CURRENT mood/);
    expect(prompt).toContain("re-read the agent's latest message");
    expect(prompt).toContain("mood when you start the chat 期待");
  });

  it("买家知道自己在本店的历史订单（日期可读、不带物流细节）", () => {
    const prompt = buildBuyerSystemPrompt(
      context({
        pastOrders: [
          {
            orderNo: "PO-202610-730660",
            placedAt: "2026-09-10T04:04:39.740Z",
            productName: "Foldable Yoga Mat",
            productSpec: "6mm / TPE",
            quantity: 2,
            totalAmount: 37.8,
            currency: "USD",
            status: "delivered",
            returnStatus: "returning",
            logistics: { carrier: "Yanwen Logistics", nodes: [] },
            review: { rating: 2 },
          },
        ],
      }),
    );
    expect(prompt).toContain("Your earlier orders in this store");
    expect(prompt).toContain("order PO-202610-730660, placed Thu 10 Sep 2026 (36 days ago), Foldable Yoga Mat (6mm / TPE) x2, USD 37.8, status delivered, return/refund returning, you rated it 2/5");
    expect(prompt).not.toContain("Yanwen");
  });

  it("讲清中文价格写法：9折是便宜 10%（说明里不带汉字，免得模型照抄）；店里标价是美元", () => {
    expect(buildBuyerSystemPrompt(context())).toContain("'9-zhe' = 10% off");
    expect(buildBuyerSystemPrompt(context())).not.toContain("折");
    expect(buildBuyerSystemPrompt(context())).toContain("All prices on this store's pages and orders are in US dollars.");
    expect(buildChineseFixMessages("¿9折 solo?", "es-ES")[0]!.content).toContain("never \"9%\"");
  });

  it("离开由买家自己判断：满意离开、剧本条件、没耐心三种都写明", () => {
    const prompt = buildBuyerSystemPrompt(context());
    expect(prompt).toContain("you have what you came for");
    expect(prompt).toContain("leaving condition in your private script");
    expect(prompt).toContain("[END_OF_SERVICE]");
  });
});

describe("轮数硬上限", () => {
  it("客服连发几条算一轮，教师指导不算", () => {
    expect(
      countAgentTurns([
        { role: "buyer" },
        { role: "student" },
        { role: "student" },
        { role: "teacher" },
        { role: "student" },
        { role: "buyer" },
        { role: "student" },
      ]),
    ).toBe(2);
  });

  it("满上限且轮到买家回客服时，这一条收尾离开；没满不提", () => {
    expect(buildBuyerSystemPrompt(context({ history: rounds(BUYER_WRAP_UP_TURNS - 1) }))).not.toContain("Wrap up in THIS reply");
    expect(buildBuyerSystemPrompt(context({ history: rounds(BUYER_WRAP_UP_TURNS) }))).toContain("Wrap up in THIS reply");
  });

  it("催促时（最后一条是买家自己的）不触发收尾，免得催促变成告别", () => {
    const messages = buildBuyerNudgeMessages({
      context: context({ history: rounds(BUYER_WRAP_UP_TURNS + 2, false) }),
      waitedMinutes: 3,
      nudgeIndex: 1,
      leaving: false,
    });
    expect(messages[0]!.content).not.toContain("Wrap up in THIS reply");
  });

  it("买家看完整聊天：几十轮的对话不截断", () => {
    const history = rounds(40);
    const messages = buildBuyerMessages(context({ history }));
    expect(messages).toHaveLength(1 + history.length);
  });
});

describe("两本账（D-90）", () => {
  function ledger(patch: Partial<BuyerLedger> = {}): BuyerLedger {
    return {
      version: 1,
      items: [
        { no: 1, kind: "main", text: "确认这款手表适不适合自己", status: "done", misses: 0 },
        { no: 2, kind: "side", text: "how long delivery to you takes", topic: "shipping", status: "open", misses: 1 },
        { no: 3, kind: "side", text: "the warranty and after-sales support", topic: "warranty", status: "waiting", misses: 0 },
        { no: 4, kind: "extra", text: "the matching strap", status: "dropped", misses: 2 },
      ],
      extrasLeft: 1,
      patience: { start: 3, left: 2 },
      silentLeave: false,
      judgements: [],
      mustLeave: null,
      exit: null,
      ...patch,
    };
  }

  it("有账时：清单带进度、只问清单上的事、能忍几次、每条先写判断；不出现观察员的满意度", () => {
    const prompt = buildBuyerSystemPrompt(context({ history: rounds(2), ledger: ledger(), personaSnapshot: { name: "Rachel", language: "en-GB", concerns: ["物流时效"] } }));
    expect(prompt).toContain("1. [main reason] 确认这款手表适不适合自己 — settled");
    expect(prompt).toContain("2. [also want to know] how long delivery to you takes — still open (the agent has already failed to answer it once)");
    expect(prompt).toContain("3. [also want to know] the warranty and after-sales support — waiting for the agent to get back to you");
    expect(prompt).toContain("4. [came up in the chat] the matching strap — given up");
    expect(prompt).toContain("do not make up other questions");
    expect(prompt).toContain("you may take up one new thing");
    expect(prompt).toContain("YOUR PATIENCE: right now you will put up with 2 more poor replies");
    expect(prompt).toContain("only ask about what is on your to-do list");
    expect(prompt).toContain("<<reply=bad/vague done=2 ask=3 leave=no>>");
    // 笼统的旧规则不再出现，也不会提默默离开
    expect(prompt).not.toContain("leaving condition in your private script");
    expect(prompt).not.toContain("leave=silent");
    expect(prompt).not.toMatch(/satisfaction|Director/);
  });

  it("耐心用完：这一条就走；按账该走没走：下一条一定收尾；会默默离开的买家才知道 leave=silent", () => {
    expect(buildBuyerSystemPrompt(context({ ledger: ledger({ patience: { start: 2, left: 0 } }) }))).toContain("you have none left");
    expect(buildBuyerSystemPrompt(context({ ledger: ledger({ patience: { start: 2, left: 0 } }) }))).toContain("Unless your verdict on the agent's latest message is good, THIS reply is your goodbye");
    // 剩 1 次：差或很差就是告别；剩 2 次：很差就是告别，差就把不满说出来
    expect(buildBuyerSystemPrompt(context({ ledger: ledger({ patience: { start: 2, left: 1 } }) }))).toContain("is bad or severe, THIS reply is your goodbye");
    expect(buildBuyerSystemPrompt(context({ ledger: ledger() }))).toContain("If it is bad, you are down to your last bit of patience");
    expect(buildBuyerSystemPrompt(context({ ledger: ledger({ mustLeave: "disappointed" }) }))).toContain("You have made up your mind to leave");
    expect(buildBuyerSystemPrompt(context({ ledger: ledger({ silentLeave: true }) }))).toContain("leave=silent");
    expect(buildBuyerSystemPrompt(context({ ledger: ledger({ extrasLeft: 0 }) }))).toContain("Do not take up anything new.");
  });

  it("买家以前每轮开头的判断原样放回聊天记录，最后再提醒一句；没有账时不放", () => {
    const history: BuyerContext["history"] = [
      { role: "buyer", content: "Is it waterproof?", note: "reply=none ask=1 leave=no" },
      { role: "buyer", content: "I swim a lot." },
      { role: "student", content: "Yes, 5 ATM." },
    ];
    const messages = buildBuyerMessages(context({ history, ledger: ledger() }));
    expect(messages.map((item) => item.content).slice(1, 4)).toEqual(["<<reply=none ask=1 leave=no>>Is it waterproof?", "I swim a lot.", "Yes, 5 ATM."]);
    expect(messages.at(-1)).toMatchObject({ role: "system" });
    expect(messages.at(-1)!.content).toContain("Begin with your hidden status note");
    const plain = buildBuyerMessages(context({ history }));
    expect(plain[1]!.content).toBe("Is it waterproof?");
    expect(plain).toHaveLength(4);
  });

  it("没有账（催促、工具卡片、跟进）照旧用笼统规则，不要求写判断；评测长对话不走", () => {
    const plain = buildBuyerSystemPrompt(context());
    expect(plain).not.toContain("BEFORE EVERY MESSAGE");
    expect(plain).toContain("you have what you came for");
    const held = buildBuyerSystemPrompt(context({ ledger: ledger(), holdOpen: true, history: rounds(BUYER_WRAP_UP_TURNS) }));
    expect(held).toContain("do not leave yet");
    expect(held).not.toContain("Wrap up in THIS reply");
    expect(held).not.toContain("BEFORE EVERY MESSAGE");
  });
});
