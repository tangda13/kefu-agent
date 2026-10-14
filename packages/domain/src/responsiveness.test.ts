import { describe, expect, it } from "vitest";
import { computeResponsiveness, replyTurnScore } from "./responsiveness";

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
