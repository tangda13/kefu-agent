import { describe, expect, it } from "vitest";
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
