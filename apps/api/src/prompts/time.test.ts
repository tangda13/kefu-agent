import { describe, expect, it } from "vitest";
import { buyerTimeLines, describeDate, directorTimeLine } from "./time";
import { buildBuyerSystemPrompt, hasChineseLeak } from "./buyer";

// 北京时间 2026-10-13（周二）23:45
const NOW = new Date("2026-10-13T15:45:00Z");

describe("时间锚点", () => {
  it("买家拿到今天和三周日历，周一为一周第一天", () => {
    const text = buyerTimeLines(NOW).join("\n");
    expect(text).toContain("Tuesday, 13 Oct 2026, 23:45");
    expect(text).toContain("this week: Mon 12 Oct (yesterday), Tue 13 Oct (today), Wed 14 Oct (tomorrow), Thu 15 Oct, Fri 16 Oct, Sat 17 Oct, Sun 18 Oct");
    expect(text).toContain("next week: Mon 19 Oct, Tue 20 Oct, Wed 21 Oct, Thu 22 Oct, Fri 23 Oct");
    expect(text).toContain("the week after: Mon 26 Oct");
    expect(text).not.toContain("conversation started");
  });

  it("按北京时间算日期：UTC 还是 13 号，北京已过零点就是 14 号；会话跨天时注明开始日", () => {
    const text = buyerTimeLines(new Date("2026-10-13T16:05:00Z"), "2026-10-13T15:45:00Z").join("\n");
    expect(text).toContain("Wednesday, 14 Oct 2026, 00:05");
    expect(text).toContain("Wed 14 Oct (today)");
    expect(text).toContain("This conversation started on Tue 13 Oct");
  });

  it("周日仍属于本周", () => {
    const text = buyerTimeLines(new Date("2026-10-18T02:00:00Z")).join("\n");
    expect(text).toContain("this week: Mon 12 Oct");
    expect(text).toContain("Sun 18 Oct (today)");
    expect(text).toContain("next week: Mon 19 Oct");
  });

  it("订单时间换成带星期和几天前的说法", () => {
    expect(describeDate("2026-10-09T03:00:00.000Z", NOW)).toBe("Fri 9 Oct 2026 (4 days ago)");
    expect(describeDate("2026-10-13T01:00:00.000Z", NOW)).toBe("Tue 13 Oct 2026 (today)");
  });

  it("导演拿到中文日历", () => {
    const text = directorTimeLine(NOW);
    expect(text).toContain("2026年10月13日周二 23:45");
    expect(text).toContain("下周：10月19日周一");
    expect(text).toContain("10月23日周五");
  });

  it("买家提示词带日历、订单日期可读、不带商品图片地址", () => {
    const prompt = buildBuyerSystemPrompt({
      scenePrompt: "清关延误安抚",
      personaSnapshot: { name: "Lucía", language: "es-ES" },
      orderSnapshot: { orderNo: "PO-1", placedAt: "2026-10-01T08:00:00.000Z", productImage: "https://example.com/a.png" },
      history: [],
      now: NOW,
    });
    expect(prompt).toContain("Fri 16 Oct");
    expect(prompt).toContain('"placedAt":"Thu 1 Oct 2026 (12 days ago)"');
    expect(prompt).not.toContain("example.com");
    expect(prompt).toContain("must not contain a single Chinese character");
  });
});

describe("漏中文检测", () => {
  it("非中日语买家出现汉字或中文标点算漏", () => {
    expect(hasChineseLeak("下周五, pero si no sale de aduanas hoy", "es-ES")).toBe(true);
    expect(hasChineseLeak("you just said “带的带的”", "en-US")).toBe(true);
    expect(hasChineseLeak("Okay，thanks", "en-GB")).toBe(true);
  });

  it("正常外语、弯引号、西语标点不算", () => {
    expect(hasChineseLeak("¿Seguro? ¡Necesito una fecha! “3-5 días” 😞", "es-ES")).toBe(false);
    expect(hasChineseLeak("Schön, danke — bis Freitag?", "de-DE")).toBe(false);
  });

  it("日语买家本来就用汉字，不查", () => {
    expect(hasChineseLeak("明日までに届きますか？", "ja-JP")).toBe(false);
  });
});
