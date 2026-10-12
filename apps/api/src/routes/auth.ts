import type { FastifyInstance } from "fastify";
import type { ApiEnv } from "../env";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  passwordPolicyError,
  signAccessToken,
  verifyPassword,
} from "../security";
import { clearLoginFailures, lockedMinutes, recordLoginFailure } from "../login-throttle";

const ROLE_LABEL: Record<DbUser["role"], string> = { student: "学生", teacher: "教师", admin: "管理员" };

interface DbUser {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: "student" | "teacher" | "admin";
  class_id: string | null;
  status: "active" | "disabled";
  must_change_password: boolean;
}

async function issueSession(db: Db, env: ApiEnv, user: DbUser) {
  const { token, tokenHash } = generateRefreshToken();
  await db.query(
    `insert into refresh_tokens (user_id, token_hash, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))`,
    [user.id, tokenHash, env.refreshTokenTtlSeconds],
  );
  const accessToken = signAccessToken(
    {
      sub: user.id,
      role: user.role,
      name: user.display_name,
      classId: user.class_id,
      mustChangePassword: user.must_change_password,
    },
    env.jwtSecret,
    env.accessTokenTtlSeconds,
  );
  return {
    accessToken,
    refreshToken: token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      classId: user.class_id,
      mustChangePassword: user.must_change_password,
    },
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Db,
  env: ApiEnv,
  guard: AuthGuard,
): void {
  app.post<{ Body: { username?: string; password?: string; expectedRole?: string } }>(
    "/v1/auth/login",
    async (request, reply) => {
      const { username, password, expectedRole } = request.body ?? {};
      if (!username || !password) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请输入账号和密码。" };
      }
      const minutes = await lockedMinutes(db, username, request.ip);
      if (minutes > 0) {
        reply.code(429);
        return {
          code: "LOGIN_LOCKED",
          message: `登录失败次数过多，请 ${minutes} 分钟后再试；忘记密码请联系教师或管理员重置。`,
        };
      }
      const result = await db.query<DbUser>(
        "select * from users where username = $1",
        [username],
      );
      const user = result.rows[0];
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        await writeAudit(db, user?.id ?? null, "auth.login_failed", username, { ip: request.ip });
        if (await recordLoginFailure(db, username, request.ip)) {
          await writeAudit(db, user?.id ?? null, "auth.locked", username, { ip: request.ip });
        }
        reply.code(401);
        return { code: "INVALID_CREDENTIALS", message: "账号或密码错误。" };
      }
      await clearLoginFailures(db, username);
      if (user.status !== "active") {
        reply.code(403);
        return { code: "ACCOUNT_DISABLED", message: "账号已停用，请联系教师或管理员。" };
      }
      // 登录页签与账号角色不符（I7）：密码校验通过后才告知真实角色，且不签发任何令牌
      if (expectedRole && expectedRole !== user.role) {
        await writeAudit(db, user.id, "auth.role_mismatch", username, { expectedRole });
        reply.code(403);
        return {
          code: "ROLE_MISMATCH",
          actualRole: user.role,
          message: user.role === "admin"
            ? "管理员账号请通过浏览器管理端登录。"
            : `该账号是${ROLE_LABEL[user.role]}账号，请切换到「${ROLE_LABEL[user.role]}登录」。`,
        };
      }
      await writeAudit(db, user.id, "auth.login", username);
      return issueSession(db, env, user);
    },
  );

  app.post<{ Body: { refreshToken?: string } }>(
    "/v1/auth/refresh",
    async (request, reply) => {
      const { refreshToken } = request.body ?? {};
      if (!refreshToken) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "缺少刷新令牌。" };
      }
      const tokenHash = hashRefreshToken(refreshToken);
      const result = await db.query<{ user_id: string }>(
        `update refresh_tokens set revoked_at = now()
         where token_hash = $1 and revoked_at is null and expires_at > now()
         returning user_id`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) {
        reply.code(401);
        return { code: "INVALID_REFRESH_TOKEN", message: "登录已过期，请重新登录。" };
      }
      const userResult = await db.query<DbUser>(
        "select * from users where id = $1 and status = 'active'",
        [row.user_id],
      );
      const user = userResult.rows[0];
      if (!user) {
        reply.code(401);
        return { code: "INVALID_REFRESH_TOKEN", message: "登录已过期，请重新登录。" };
      }
      return issueSession(db, env, user);
    },
  );

  app.post<{ Body: { refreshToken?: string } }>(
    "/v1/auth/logout",
    async (request) => {
      const { refreshToken } = request.body ?? {};
      if (refreshToken) {
        await db.query(
          "update refresh_tokens set revoked_at = now() where token_hash = $1",
          [hashRefreshToken(refreshToken)],
        );
      }
      return { ok: true };
    },
  );

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    "/v1/auth/change-password",
    { preHandler: guard.requireRole() },
    async (request, reply) => {
      const user = request.user!;
      const { currentPassword, newPassword } = request.body ?? {};
      const policyError = newPassword ? passwordPolicyError(newPassword) : "请输入新密码";
      if (!currentPassword || !newPassword || policyError) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: `${policyError ?? "请输入当前密码"}。` };
      }
      const result = await db.query<DbUser>(
        "select * from users where id = $1",
        [user.sub],
      );
      const dbUser = result.rows[0];
      if (!dbUser || !(await verifyPassword(currentPassword, dbUser.password_hash))) {
        reply.code(401);
        return { code: "INVALID_CREDENTIALS", message: "当前密码错误。" };
      }
      if (newPassword === currentPassword) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "新密码不能与当前密码相同。" };
      }
      const newHash = await hashPassword(newPassword);
      await db.query(
        `update users set password_hash = $1, must_change_password = false, updated_at = now()
         where id = $2`,
        [newHash, user.sub],
      );
      await db.query(
        "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
        [user.sub],
      );
      guard.invalidateAccount(user.sub);
      await writeAudit(db, user.sub, "auth.change_password");
      return { ok: true };
    },
  );

  app.get(
    "/v1/me",
    { preHandler: guard.requireRole() },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select id, username, display_name, role, class_id, must_change_password
         from users where id = $1`,
        [user.sub],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        classId: row.class_id,
        mustChangePassword: row.must_change_password,
      };
    },
  );
}
