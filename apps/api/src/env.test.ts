import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const saved = { NODE_ENV: process.env.NODE_ENV, DESKTOP_ONLY: process.env.DESKTOP_ONLY, CORS_ORIGINS: process.env.CORS_ORIGINS };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("生产开关：.env 在 Windows 上编辑带了 \r 也不能被悄悄关掉", () => {
  it("生产环境 DESKTOP_ONLY 留空（含只有 \r）时仍是只认客户端，跨域不放行", () => {
    process.env.NODE_ENV = "production";
    for (const value of [undefined, "", "\r", " "]) {
      if (value === undefined) delete process.env.DESKTOP_ONLY;
      else process.env.DESKTOP_ONLY = value;
      process.env.CORS_ORIGINS = "\r";
      const env = loadEnv();
      expect(env.desktopOnly).toBe(true);
      expect(env.corsOrigins).toBe(false);
    }
  });

  it("显式 false（带 \r）才关闭；开发环境默认关闭", () => {
    process.env.NODE_ENV = "production";
    process.env.DESKTOP_ONLY = "false\r";
    expect(loadEnv().desktopOnly).toBe(false);
    process.env.NODE_ENV = "development";
    delete process.env.DESKTOP_ONLY;
    expect(loadEnv().desktopOnly).toBe(false);
  });
});
