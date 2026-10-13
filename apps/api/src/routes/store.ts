import type { FastifyInstance } from "fastify";
import { DEFAULT_STORE_PROFILE, normalizeStoreProfile, type StoreProfile } from "@cecs/domain";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import { getSetting, setSetting } from "../settings";

/** 店铺资料：全平台一份（老师在场景配置 → 店铺商品维护），学生端侧栏、邮件、AI 帮写、买家 AI 读取 */

const STORE_KEY = "store_profile";
const LOGO_PATTERN = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/;
const LOGO_MAX_BYTES = 256 * 1024;

export async function loadStoreProfile(db: Db): Promise<StoreProfile> {
  const stored = await getSetting<unknown>(db, STORE_KEY);
  return stored ? normalizeStoreProfile(stored) : DEFAULT_STORE_PROFILE;
}

export function registerStoreRoutes(app: FastifyInstance, db: Db, guard: AuthGuard): void {
  app.get("/v1/store/profile", { preHandler: guard.requireRole() }, async () => loadStoreProfile(db));

  app.put<{ Body: Partial<StoreProfile> }>(
    "/v1/store/profile",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const current = await loadStoreProfile(db);
      const body = request.body ?? {};
      if (body.logoUrl) {
        const match = LOGO_PATTERN.exec(String(body.logoUrl));
        if (!match) {
          reply.code(400);
          return { code: "INVALID_STORE_LOGO", message: "店铺标识只支持 PNG、JPG、WebP 或 SVG 图片。" };
        }
        if (Buffer.byteLength(match[2]!, "base64") > LOGO_MAX_BYTES) {
          reply.code(400);
          return { code: "STORE_LOGO_TOO_LARGE", message: "店铺标识不能超过 256 KB。" };
        }
      }
      if (body.supportEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.supportEmail).trim())) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "客服邮箱格式不对。" };
      }
      const next = normalizeStoreProfile({ ...current, ...body, tiers: { ...current.tiers, ...(body.tiers ?? {}) } });
      await setSetting(db, STORE_KEY, next);
      await writeAudit(db, request.user!.sub, "store.profile", undefined, { name: next.name });
      return next;
    },
  );
}
