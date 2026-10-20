import type { UserRole } from "@cecs/contracts";

/**
 * 登录页“记住密码”（D-51）：只在 Windows 客户端里可用。
 * 密码由 Electron 主进程用系统凭据（Windows DPAPI）加密后存本机 userData，
 * 渲染层不落明文；浏览器端没有系统凭据能力，交给浏览器自带的密码管理器。
 */

export interface RememberedCredential {
  username: string;
  password: string;
}

export type RememberedCredentials = Partial<Record<UserRole, RememberedCredential>>;

export function supportsRememberPassword(): boolean {
  return Boolean(window.desktopRuntime?.rememberedLogin);
}

export async function loadRememberedCredentials(): Promise<RememberedCredentials> {
  const bridge = window.desktopRuntime?.rememberedLogin;
  if (!bridge) return {};
  try {
    const result = await bridge.load();
    return result?.ok ? result.credentials : {};
  } catch {
    return {};
  }
}

export async function saveRememberedCredential(
  role: UserRole,
  username: string,
  password: string,
): Promise<void> {
  try {
    await window.desktopRuntime?.rememberedLogin?.save(role, username, password);
  } catch {
    /* 存不了就不记，不打断登录 */
  }
}

export async function removeRememberedCredential(role: UserRole): Promise<void> {
  try {
    await window.desktopRuntime?.rememberedLogin?.remove(role);
  } catch {
    /* 同上 */
  }
}
