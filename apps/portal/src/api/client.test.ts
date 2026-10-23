import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet, changePassword, loadSession, onSessionExpired, saveSession, streamConversationOpening, type Session } from "./client";

/* 令牌续期：访问令牌 15 分钟过期，刷新令牌用一次就作废。
   之前页面手里一直是登录时那份 session，续过一次后再 401 就拿作废的刷新令牌去换 → 被踢回“请先登录”；
   发消息（流式）更是从不续期，过了 15 分钟直接报“请先登录” */

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

function session(generation: number): Session {
  return {
    accessToken: `access-${generation}`,
    refreshToken: `refresh-${generation}`,
    user: { id: "u1", username: "s1", displayName: "张三", role: "student", classId: null, mustChangePassword: false },
  };
}

/** 假服务端：只认最新的访问令牌；刷新令牌用一次作废并换新 */
function fakeServer() {
  let generation = 1;
  const state = { refreshCalls: 0, refreshStatus: 200, access: "access-1", refresh: "refresh-1", disabled: false };
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/v1/auth/refresh")) {
      state.refreshCalls += 1;
      if (state.refreshStatus !== 200) return new Response("{}", { status: state.refreshStatus });
      const { refreshToken } = JSON.parse(String(init.body)) as { refreshToken: string };
      if (refreshToken !== state.refresh) {
        return new Response(JSON.stringify({ code: "INVALID_REFRESH_TOKEN", message: "登录已过期，请重新登录。" }), { status: 401 });
      }
      generation += 1;
      const next = session(generation);
      state.access = next.accessToken;
      state.refresh = next.refreshToken;
      return new Response(JSON.stringify(next), { status: 200 });
    }
    if (headers.authorization !== `Bearer ${state.access}`) {
      return new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "请先登录。" }), { status: 401 });
    }
    if (url.endsWith("/v1/auth/change-password")) {
      return new Response(JSON.stringify({ code: "INVALID_CREDENTIALS", message: "当前密码错误。" }), { status: 401 });
    }
    if (state.disabled) {
      return new Response(JSON.stringify({ code: "ACCOUNT_DISABLED", message: "账号已停用，请联系教师或管理员。" }), { status: 401 });
    }
    if (url.endsWith("/opening")) {
      return new Response('data: {"type":"delta","text":"hi"}\n\ndata: {"type":"done","metrics":{}}\n\n', { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  /** 过了 15 分钟：服务端不再认当前的访问令牌 */
  const expireAccess = () => { state.access = "expired"; };
  return { fetchMock, state, expireAccess };
}

describe("api client token renewal", () => {
  let server: ReturnType<typeof fakeServer>;
  const original = session(1);

  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    saveSession(original);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps working with the login-time session object after several renewals", async () => {
    server.expireAccess();
    await expect(apiGet("/v1/student/tasks", original)).resolves.toEqual({ ok: true });
    // 第二次过期：页面手里仍是登录时那份（refresh-1 早已作废）
    server.expireAccess();
    await expect(apiGet("/v1/student/tasks", original)).resolves.toEqual({ ok: true });
    await expect(apiGet("/v1/student/tasks", original)).resolves.toEqual({ ok: true });
    expect(server.state.refreshCalls).toBe(2);
    expect(loadSession()?.refreshToken).toBe("refresh-3");
  });

  it("renews once when several requests hit 401 together", async () => {
    server.expireAccess();
    await Promise.all([1, 2, 3, 4].map(() => apiGet("/v1/student/tasks", original)));
    expect(server.state.refreshCalls).toBe(1);
  });

  it("renews before streaming a buyer reply instead of failing with 请先登录", async () => {
    server.expireAccess();
    const deltas: string[] = [];
    const errors: string[] = [];
    await streamConversationOpening(original, "c1", {
      onDelta: (text) => deltas.push(text),
      onDone: () => undefined,
      onError: (message) => errors.push(message),
    });
    expect(errors).toEqual([]);
    expect(deltas.join("")).toBe("hi");
  });

  it("keeps the login when the refresh endpoint is temporarily down", async () => {
    server.expireAccess();
    server.state.refreshStatus = 502;
    await expect(apiGet("/v1/student/tasks", original)).rejects.toMatchObject({ code: "REFRESH_UNAVAILABLE" });
    expect(loadSession()?.refreshToken).toBe("refresh-1");
  });

  it("does not renew on 401s that are not about the token (wrong current password)", async () => {
    await expect(changePassword(original, "wrong", "NewPass#1")).rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });
    expect(server.state.refreshCalls).toBe(0);
    expect(loadSession()?.refreshToken).toBe("refresh-1");
  });

  it("goes back to the login page with the reason when the account is disabled", async () => {
    server.state.disabled = true;
    const messages: string[] = [];
    const off = onSessionExpired((message) => messages.push(message));
    await expect(apiGet("/v1/student/tasks", original)).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
    off();
    expect(messages).toEqual(["账号已停用，请联系教师或管理员。"]);
    expect(loadSession()).toBeNull();
    expect(server.state.refreshCalls).toBe(0);
  });

  it("signs out with the server message when the refresh token is really dead", async () => {
    server.expireAccess();
    server.state.refresh = "revoked-elsewhere";
    const messages: string[] = [];
    const off = onSessionExpired((message) => messages.push(message));
    await expect(apiGet("/v1/student/tasks", original)).rejects.toMatchObject({ status: 401 });
    off();
    expect(messages).toEqual(["登录已过期，请重新登录。"]);
    expect(loadSession()).toBeNull();
  });
});
