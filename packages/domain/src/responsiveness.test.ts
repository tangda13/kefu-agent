import { describe, expect, it } from "vitest";
import { averageReplySec, computeResponsiveness, replyRounds, replyTurnScore, replyWithinRate, summarizeReplies } from "./responsiveness";

const at = (sec: number) => new Date(Date.UTC(2026, 9, 13, 8, 0, 0) + sec * 1000).toISOString();

describe("消息响应时效", () => {
  it("单轮得分：45 秒内满分，10 分钟以上 0 分，中间连续下降", () => {
    expect(replyTurnScore(10)).toBe(100);
    expect(replyTurnScore(45)).toBe(100);
    expect(replyTurnScore(90)).toBe(85);
    expect(replyTurnScore(180)).toBe(60);
    expect(replyTurnScore(270)).toBe(45);
    expect(replyTurnScore(900)).toBe(0);
  });

  it("买家连发几条只算一轮，从第一条开始计时；首次响应 2 倍权重", () => {
    const result = computeResponsiveness([
      { sender: "buyer", at: at(0) },
      { sender: "buyer", at: at(20) },
      { sender: "student", at: at(30) },
      { sender: "student", at: at(40) },
      { sender: "buyer", at: at(50) },
      { sender: "teacher", at: at(60) },
      { sender: "student", at: at(230) },
    ]);
    expect(result.turns).toBe(2);
    expect(result.firstReplySec).toBe(30);
    expect(result.avgReplySec).toBe(105);
    expect(result.slowReplies).toBe(1);
    // (100 × 2 + 60) / 3
    expect(result.score).toBe(87);
  });

  it("买家等不到回复离开：计入这一轮，并且最高 40 分", () => {
    const result = computeResponsiveness(
      [
        { sender: "buyer", at: at(0) },
        { sender: "student", at: at(10) },
        { sender: "buyer", at: at(20) },
        { sender: "buyer", at: at(140) },
      ],
      { closedAt: at(620), closedReason: "buyer_left" },
    );
    expect(result.leftWaiting).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.score).toBe(40);
  });

  it("买家道别后马上结束不算没回", () => {
    const result = computeResponsiveness(
      [
        { sender: "buyer", at: at(0) },
        { sender: "student", at: at(20) },
        { sender: "buyer", at: at(30) },
      ],
      { closedAt: at(31), closedReason: "buyer_left" },
    );
    expect(result.leftWaiting).toBe(false);
    expect(result.turns).toBe(1);
    expect(result.score).toBe(100);
  });

  it("没有可计的轮次时不给分", () => {
    expect(computeResponsiveness([{ sender: "student", at: at(0) }]).score).toBeNull();
  });
});

describe("平均响应与 3 分钟回复率（D-61）", () => {
  const t = (sec: number) => new Date(at(sec)).getTime();

  it("逐轮列出，最后没回的那一轮等待为 null", () => {
    const rounds = replyRounds([
      { sender: "buyer", at: at(0) },
      { sender: "buyer", at: at(15) },
      { sender: "student", at: at(40) },
      { sender: "buyer", at: at(100) },
    ]);
    expect(rounds).toEqual([{ startedAt: t(0), waitSec: 40 }, { startedAt: t(100), waitSec: null }]);
  });

  it("3 分钟内回复算达标；单轮等待按 10 分钟封顶进平均", () => {
    const summary = summarizeReplies(
      replyRounds([
        { sender: "buyer", at: at(0) },
        { sender: "student", at: at(60) },
        { sender: "buyer", at: at(100) },
        { sender: "student", at: at(280) },
        { sender: "buyer", at: at(300) },
        { sender: "student", at: at(1500) },
      ]),
      t(1500),
    );
    expect(summary).toEqual({ waitSum: 60 + 180 + 600, replied: 3, within: 2, counted: 3 });
    expect(averageReplySec(summary)).toBe(280);
    expect(replyWithinRate(summary)).toBe(67);
  });

  it("最后没回的一轮：等满 3 分钟算没达标，不满 3 分钟就结束的不计入", () => {
    const messages = [
      { sender: "buyer", at: at(0) },
      { sender: "student", at: at(30) },
      { sender: "buyer", at: at(60) },
    ];
    expect(summarizeReplies(replyRounds(messages), t(120))).toMatchObject({ within: 1, counted: 1 });
    expect(summarizeReplies(replyRounds(messages), t(240))).toMatchObject({ within: 1, counted: 2, replied: 1 });
  });

  it("没有买家发言时两项都为空", () => {
    const summary = summarizeReplies(replyRounds([{ sender: "student", at: at(0) }]), t(10));
    expect(averageReplySec(summary)).toBeNull();
    expect(replyWithinRate(summary)).toBeNull();
  });
});
