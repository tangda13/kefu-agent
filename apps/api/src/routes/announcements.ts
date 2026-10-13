import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { teacherOwnsClass, writeAudit } from "../auth-context";

/**
 * 公告：教师/管理员发布的广播型信息（与铃铛"消息"边界不同——
 * 消息是定向、需处理的事件流；公告是面向班级/全体、只需知晓、有时效的通知）。
 * class_id 为空 = 全体公告（仅管理员可发）。
 */

interface PublishBody {
  title?: string;
  content?: string;
  classIds?: string[];
  days?: number | null;
}

const VALID_DAYS = [7, 14, 30];

async function ownedClassIds(db: Db, teacherId: string): Promise<string[]> {
  const result = await db.query(
    `select class_id as id from teacher_classes where teacher_id = $1
     union
     select id from classes where head_teacher_id = $1`,
    [teacherId],
  );
  return result.rows.map((row) => row.id);
}

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  db: Db,
  guard: AuthGuard,
): void {
  app.post<{ Body: PublishBody }>(
    "/v1/announcements",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const body = request.body ?? {};
      const title = body.title?.trim();
      const content = body.content?.trim();
      if (!title || title.length > 60) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写公告标题（60 字以内）。" };
      }
      if (!content || content.length > 500) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写公告内容（500 字以内）。" };
      }
      const days = body.days ?? null;
      if (days !== null && !VALID_DAYS.includes(Number(days))) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "有效期只支持 7 / 14 / 30 天或长期。" };
      }
      const expiresAt = days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null;

      /* 目标班级：教师默认发到全部授权班级；管理员不传班级 = 全体公告 */
      let targets: (string | null)[];
      const requested = Array.isArray(body.classIds) ? body.classIds.filter(Boolean) : [];
      if (requested.length > 0) {
        for (const classId of requested) {
          if (!(await teacherOwnsClass(db, user, classId))) {
            reply.code(403);
            return { code: "FORBIDDEN", message: "您未被授权管理该班级。" };
          }
        }
        targets = requested;
      } else if (user.role === "admin") {
        targets = [null];
      } else {
        const owned = await ownedClassIds(db, user.sub);
        if (owned.length === 0) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "您还没有授权班级，无法发布公告。" };
        }
        targets = owned;
      }

      const created: unknown[] = [];
      for (const classId of targets) {
        const result = await db.query(
          `insert into announcements (publisher_id, class_id, title, content, expires_at)
           values ($1, $2, $3, $4, $5)
           returning id, created_at`,
          [user.sub, classId, title, content, expiresAt],
        );
        created.push({ id: result.rows[0].id, classId, createdAt: result.rows[0].created_at });
      }
      await writeAudit(db, user.sub, "announcement.publish", title, { targets: targets.length });
      return { created };
    },
  );

  app.get(
    "/v1/announcements",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request) => {
      const user = request.user!;
      const scopeFilter = user.role === "admin" ? "" : "where a.publisher_id = $1";
      const params = user.role === "admin" ? [] : [user.sub];
      const result = await db.query(
        `select a.id, a.title, a.content, a.expires_at, a.created_at, a.class_id,
                c.name as class_name,
                (select count(*) from users u where u.role = 'student' and u.status = 'active'
                   and (a.class_id is null or u.class_id = a.class_id)) as recipient_count,
                (select count(*) from read_marks r join users u on u.id = r.user_id
                  where r.kind = 'notice' and r.item_id = a.id::text
                    and (a.class_id is null or u.class_id = a.class_id)) as read_count
         from announcements a
         left join classes c on c.id = a.class_id
         ${scopeFilter}
         order by a.created_at desc
         limit 100`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        content: row.content,
        className: row.class_name ?? null,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        expired: row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false,
        recipientCount: Number(row.recipient_count),
        readCount: Number(row.read_count),
      }));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/announcements/:id",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;
      const result = await db.query(
        `delete from announcements
         where id = $1 and ($2 = 'admin' or publisher_id = $3)
         returning id`,
        [id, user.role, user.sub],
      );
      if (result.rows.length === 0) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "公告不存在或您无权撤回。" };
      }
      await writeAudit(db, user.sub, "announcement.delete", id);
      return { ok: true };
    },
  );

  /* 学生端：本班 + 全体的有效公告 */
  app.get(
    "/v1/student/announcements",
    { preHandler: guard.requireRole("student") },
    async (request) => {
      const user = request.user!;
      const result = await db.query(
        `select a.id, a.title, a.content, a.created_at, u.display_name as publisher_name
         from announcements a
         join users u on u.id = a.publisher_id
         where (a.class_id is null or a.class_id = (select class_id from users where id = $1))
           and (a.expires_at is null or a.expires_at > now())
         order by a.created_at desc
         limit 10`,
        [user.sub],
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        content: row.content,
        publisherName: row.publisher_name,
        createdAt: row.created_at,
      }));
    },
  );
}
