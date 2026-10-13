import { describe, expect, it } from "vitest";
import { once } from "./inflight";

describe("在途请求合并", () => {
  it("同一个 key 同时到达只执行一次，结束后可再次执行", async () => {
    let calls = 0;
    const task = () => new Promise<string>((resolve) => setTimeout(() => { calls += 1; resolve("译文"); }, 20));
    const results = await Promise.all([once("t:1", task), once("t:1", task), once("t:1", task)]);
    expect(results).toEqual(["译文", "译文", "译文"]);
    expect(calls).toBe(1);
    await once("t:1", task);
    expect(calls).toBe(2);
  });

  it("失败后不留在途记录，下次可重试", async () => {
    await expect(once("t:2", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(once("t:2", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
