import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserRole } from "@cecs/contracts";
import type { Db } from "./db";
import { verifyAccessToken, type AccessTokenPayload } from "./security";

declare module "fastify" {
  interface FastifyRequest {
    user: AccessTokenPayload | null;
  }
}

export function createAuthGuard(jwtSecret: string) {
  function authenticate(request: FastifyRequest): AccessTokenPayload | null {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return verifyAccessToken(header.slice("Bearer ".length), jwtSecret);
  }

  function requireRole(...roles: UserRole[]) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const user = authenticate(request);
      request.user = user;
      if (!user) {
        reply.code(401).send({ code: "UNAUTHORIZED", message: "请先登录。" });
        return reply;
      }
      if (roles.length > 0 && !roles.includes(user.role)) {
        reply.code(403).send({ code: "FORBIDDEN", message: "无权访问该资源。" });
        return reply;
      }
      return undefined;
    };
  }

  return { authenticate, requireRole };
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
