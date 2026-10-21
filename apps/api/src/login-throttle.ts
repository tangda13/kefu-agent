import type { Db } from "./db";

/**
 * 登录失败限流（I1）：
 * - 账号：15 分钟内连续失败 5 次 → 锁 15 分钟（成功登录或教师/管理员重置密码后清零）
 * - IP：15 分钟内失败 100 次 → 锁 15 分钟。阈值放宽是因为整个机房常共用一个出口 IP，
 *   开课时几十名学生同时输错不能把全班锁住；账号维度才是主防线
 */
export const LOGIN_WINDOW_MINUTES = 15;
export const ACCOUNT_MAX_FAILURES = 5;
export const IP_MAX_FAILURES = 100;

// 账号不区分大小写（D-78），换个大小写不能绕开锁定
const userKey = (username: string) => `user:${username.trim().toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;

/** 返回仍在锁定中的剩余分钟数；未锁定返回 0 */
export async function lockedMinutes(db: Db, username: string, ip: string): Promise<number> {
  const result = await db.query<{ seconds: number }>(
    `select extract(epoch from max(locked_until) - now())::int as seconds
     from login_failures where key = any($1) and locked_until > now()`,
    [[userKey(username), ipKey(ip)]],
  );
  const seconds = result.rows[0]?.seconds ?? 0;
  return seconds > 0 ? Math.ceil(seconds / 60) : 0;
}

/** 记一次失败；返回本次是否触发了账号锁定 */
export async function recordLoginFailure(db: Db, username: string, ip: string): Promise<boolean> {
  const bump = async (key: string, max: number) => {
    // 窗口过期或上一次锁定已结束 → 从 1 重新计数
    const result = await db.query<{ locked: boolean }>(
      `insert into login_failures (key, fail_count, window_started_at)
       values ($1, 1, now())
       on conflict (key) do update set
         fail_count = case when login_failures.window_started_at < now() - make_interval(mins => $3)
                             or login_failures.locked_until <= now()
                           then 1 else login_failures.fail_count + 1 end,
         window_started_at = case when login_failures.window_started_at < now() - make_interval(mins => $3)
                                    or login_failures.locked_until <= now()
                                  then now() else login_failures.window_started_at end,
         locked_until = null
       returning fail_count >= $2 as locked`,
      [key, max, LOGIN_WINDOW_MINUTES],
    );
    const locked = Boolean(result.rows[0]?.locked);
    if (locked) {
      await db.query(
        "update login_failures set locked_until = now() + make_interval(mins => $2) where key = $1",
        [key, LOGIN_WINDOW_MINUTES],
      );
    }
    return locked;
  };
  const accountLocked = await bump(userKey(username), ACCOUNT_MAX_FAILURES);
  await bump(ipKey(ip), IP_MAX_FAILURES);
  return accountLocked;
}

/** 登录成功或密码被重置后清除该账号的失败计数（IP 计数保留） */
export async function clearLoginFailures(db: Db, username: string): Promise<void> {
  await db.query("delete from login_failures where key = $1", [userKey(username)]);
}
