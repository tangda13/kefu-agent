import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneTtsCache, TTS_CACHE_MAX_AGE_MS } from "./tts-cache";

const DAY = 24 * 60 * 60 * 1000;
let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 在缓存目录里放一个生成于 daysAgo 天前的文件 */
function put(name: string, daysAgo: number, now: number) {
  const file = path.join(dir, name);
  writeFileSync(file, "x");
  const at = new Date(now - daysAgo * DAY);
  utimesSync(file, at, at);
}

describe("朗读缓存保留 30 天（D-88）", () => {
  it("删掉超过 30 天的，留下 30 天内的和试听文件", async () => {
    const now = Date.now();
    dir = mkdtempSync(path.join(os.tmpdir(), "tts-cache-"));
    put("m1-doubao-a.mp3", 31, now);
    put("m2-aliyun-b.wav", 45, now);
    put("m3-doubao-a.mp3", 29, now);
    put("preview-doubao-a-en.mp3", 90, now);
    mkdirSync(path.join(dir, "sub"));

    expect(await pruneTtsCache(dir, TTS_CACHE_MAX_AGE_MS, now)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["m3-doubao-a.mp3", "preview-doubao-a-en.mp3", "sub"]);
  });

  it("目录还没建（从没播报过）算删了 0 个", async () => {
    expect(await pruneTtsCache(path.join(os.tmpdir(), "tts-cache-missing-dir"), TTS_CACHE_MAX_AGE_MS)).toBe(0);
  });
});
