import { describe, expect, it } from "vitest";
import { shouldRetryWithAutoLanguage } from "./doubao";

describe("豆包指定语种失败后要不要换自动识别再试", () => {
  it.each([
    ["服务端错误帧（语种和文本对不上）", "TTS_ERROR_45000001: invalid text for language", true],
    ["会话失败", "TTS_SESSION_FAILED: {\"error\":\"unsupported language\"}", true],
    ["额度用尽", "TTS_ERROR_45000292: quota exceeded for types: text_words_lifetime", false],
    ["并发超限", "TTS_ERROR_45000292: quota exceeded for types: concurrency", false],
    ["超时", "TTS_TIMEOUT", false],
    ["握手被拒 429", "Unexpected server response: 429", false],
    ["连不上", "connect ECONNRESET", false],
  ])("%s", (_name, message, expected) => {
    expect(shouldRetryWithAutoLanguage(new Error(message))).toBe(expected);
  });
});
