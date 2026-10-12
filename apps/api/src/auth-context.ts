import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserRole } from "@cecs/contracts";
import type { Db } from "./db";
import { verifyAccessToken, type AccessTokenPayload } from "./security";

declare module "fastify" {
  interface FastifyRequest {
    user: AccessTokenPayload | null;
    /** 收到请求的时刻（毫秒），验收统计首字耗时的起点（B2），server.ts onRequest 钩子写入 */
    receivedAt: number;
  }
}

/** 待改密账号（must_change_password）只放行这些路由；其余一律 403，前端拦截不可信（I2） */
const PASSWORD_CHANGE_ALLOWED = new Set(["/v1/auth/change-password", "/v1/me"]);
/** 账号状态短时缓存：停用/改密时主动失效，其余情况最多滞后这么久 */
const ACCOUNT_CACHE_TTL_MS = 10_000;

interface AccountState {
  status: "active" | "disabled";
  mustChangePassword: boolean;
  expiresAt: number;
}

export function createAuthGuard(jwtSecret: string, db: Db) {
  const accountCache = new Map<string, AccountState>();

  function authenticate(request: FastifyRequest): AccessTokenPayload | null {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return verifyAccessToken(header.slice("Bearer ".length), jwtSecret);
  }

  /** 令牌只证明身份；账号状态与改密标记以数据库为准（I2/I6） */
  async function loadAccount(userId: string): Promise<AccountState | null> {
    const cached = accountCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const result = await db.query<{ status: AccountState["status"]; must_change_password: boolean }>(
      "select status, must_change_password from users where id = $1",
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      accountCache.delete(userId);
      return null;
    }
    const state: AccountState = {
      status: row.status,
      mustChangePassword: row.must_change_password,
      expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS,
    };
    accountCache.set(userId, state);
    return state;
  }

  /** 账号状态或密码变更后调用，使鉴权立即看到新状态 */
  function invalidateAccount(userId: string): void {
    accountCache.delete(userId);
  }

  function requireRole(...roles: UserRole[]) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const token = authenticate(request);
      request.user = null;
      if (!token) {
        reply.code(401).send({ code: "UNAUTHORIZED", message: "请先登录。" });
        return reply;
      }
      const account = await loadAccount(token.sub);
      if (!account || account.status !== "active") {
        reply.code(401).send({ code: "ACCOUNT_DISABLED", message: "账号已停用，请联系教师或管理员。" });
        return reply;
      }
      const user = { ...token, mustChangePassword: account.mustChangePassword };
      request.user = user;
      if (roles.length > 0 && !roles.includes(user.role)) {
        reply.code(403).send({ code: "FORBIDDEN", message: "无权访问该资源。" });
        return reply;
      }
      if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(request.routeOptions.url ?? "")) {
        reply.code(403).send({ code: "PASSWORD_CHANGE_REQUIRED", message: "首次登录请先修改密码。" });
        return reply;
      }
      return undefined;
    };
  }

  return { authenticate, requireRole, invalidateAccount };
}

export type AuthGuard = ReturnType<typeof createAuthGuard>;

/** 教师是否被授权访问某班级（班主任或已授权）。管理员恒真。 */
export async function teacherOwnsClass(
  db: Db,
  user: AccessTokenPayload,
  classId: string,
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (user.role !== "teacher") return false;
  const result = await db.query(
    `select 1 from teacher_classes where teacher_id = $1 and class_id = $2
     union
     select 1 from classes where id = $2 and head_teacher_id = $1
     limit 1`,
    [user.sub, classId],
  );
  return Boolean(result.rowCount);
}

export async function writeAudit(
  db: Db,
  actorId: string | null,
  action: string,
  target?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    "insert into audit_log (actor_id, action, target, detail) values ($1, $2, $3, $4)",
    [actorId, action, target ?? null, detail ? JSON.stringify(detail) : null],
  );
}
