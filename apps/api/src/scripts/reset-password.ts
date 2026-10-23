/**
 * 服务器命令行重置任意账号密码（I3：管理员自己忘记密码时的唯一出路）。
 *
 *   本机：  pnpm --filter @cecs/api reset-password admin
 *   容器内：docker compose exec api pnpm reset-password admin
 *
 * 生成 8 位临时密码并打印；该账号下次登录强制改密，原有会话全部失效，登录锁定一并解除。
 */
import { loadEnv } from "../env";
import { createPool } from "../db";
import { generateTemporaryPassword, hashPassword } from "../security";
import { clearLoginFailures } from "../login-throttle";
import { revokeAllRefreshTokens, writeAudit } from "../auth-context";

const username = process.argv[2]?.trim();
if (!username) {
  console.error("用法：pnpm reset-password <账号>，例如 pnpm reset-password admin");
  process.exit(1);
}

const db = createPool(loadEnv().databaseUrl);
try {
  const temporaryPassword = generateTemporaryPassword();
  const result = await db.query<{ id: string; role: string }>(
    `update users set password_hash = $1, must_change_password = true, status = 'active', updated_at = now()
     where lower(username) = lower($2) returning id, role`,
    [await hashPassword(temporaryPassword), username],
  );
  const user = result.rows[0];
  if (!user) {
    console.error(`账号不存在：${username}`);
    process.exitCode = 1;
  } else {
    await revokeAllRefreshTokens(db, user.id);
    await clearLoginFailures(db, username);
    await writeAudit(db, null, "cli.reset_password", user.id, { username });
    console.log(`已重置 ${username}（${user.role}）的密码。`);
    console.log(`临时密码：${temporaryPassword}`);
    console.log("登录后需立即修改密码。账号如被停用，已一并恢复启用。");
  }
} finally {
  await db.end();
}
