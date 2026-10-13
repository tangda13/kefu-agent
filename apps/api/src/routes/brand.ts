import type { FastifyInstance } from "fastify";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import type { Db } from "../db";
import { getSetting, setSetting } from "../settings";

/** 平台品牌（D-21）：名称与标识都可由管理员替换；未设置时前端用初始名称与内置耳麦图标。 */
export interface BrandSettings {
  name: string;
  /** data URL（png / jpeg / webp / svg），null 表示使用内置图标 */
  logo: string | null;
}

export const DEFAULT_BRAND_NAME = "跨境电商客服AI实训平台";
const NAME_MAX = 30;
const LOGO_MAX_BYTES = 256 * 1024;
const LOGO_PATTERN = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/;

async function readBrand(db: Db): Promise<BrandSettings> {
  const stored = await getSetting<Partial<BrandSettings>>(db, "brand");
  return {
    name: stored?.name?.trim() || DEFAULT_BRAND_NAME,
    logo: stored?.logo ?? null,
  };
}

export function registerBrandRoutes(app: FastifyInstance, db: Db, guard: AuthGuard) {
  // 登录前就要显示品牌，所以读取接口不需要登录
  app.get("/v1/public/brand", async () => readBrand(db));

  app.put<{ Body: { name?: unknown; logo?: unknown } }>(
    "/v1/admin/brand",
    { preHandler: guard.requireRole("admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      const current = await readBrand(db);

      let name = current.name;
      if (body.name !== undefined) {
        name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > NAME_MAX) {
          reply.code(400);
          return { code: "INVALID_BRAND_NAME", message: `平台名称需为 1–${NAME_MAX} 个字。` };
        }
      }

      let logo = current.logo;
      if (body.logo !== undefined) {
        if (body.logo === null) {
          logo = null;
        } else {
          const match = typeof body.logo === "string" ? LOGO_PATTERN.exec(body.logo) : null;
          if (!match) {
            reply.code(400);
            return { code: "INVALID_BRAND_LOGO", message: "标识只支持 PNG、JPG、WebP 或 SVG 图片。" };
          }
          if (Buffer.byteLength(match[2]!, "base64") > LOGO_MAX_BYTES) {
            reply.code(400);
            return { code: "BRAND_LOGO_TOO_LARGE", message: "标识图片不能超过 256 KB。" };
          }
          logo = body.logo as string;
        }
      }

      const next: BrandSettings = { name, logo };
      await setSetting(db, "brand", next);
      await writeAudit(db, request.user!.sub, "admin.brand", undefined, { name, logoChanged: logo !== current.logo });
      return next;
    },
  );
}
