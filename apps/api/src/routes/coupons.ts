import type { FastifyInstance } from "fastify";
import {
  COUPON_KINDS, CUSTOMER_TYPES, couponFace, couponRuleText, couponScopeText,
  type CouponFields, type CouponKind,
} from "@cecs/contracts";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";

/** 店铺优惠券（D-66）：教师端增删改、启停；学生工作台只看得到启用的券 */

interface CouponRow {
  id: string;
  title: string;
  kind: CouponKind;
  amount: string | number;
  threshold: string | number;
  product_ids: string[];
  customer_types: string[];
  valid_days: number;
  enabled: boolean;
}

export function couponFromRow(row: CouponRow) {
  const fields: CouponFields = {
    title: row.title,
    kind: row.kind,
    amount: Number(row.amount),
    threshold: Number(row.threshold),
    productIds: row.product_ids ?? [],
    customerTypes: row.customer_types ?? [],
    validDays: Number(row.valid_days),
  };
  return {
    id: row.id,
    ...fields,
    enabled: row.enabled,
    /* 学生工作台和买家看到的文字，和教师端预览同一套写法 */
    rule: couponRuleText(fields),
    scope: couponScopeText(fields),
    face: couponFace(fields),
  };
}

/** 发券时用：启用的券才能发 */
export async function loadEnabledCoupon(db: Db, id: string) {
  const result = await db.query<CouponRow>("select * from store_coupons where id = $1 and enabled", [id]);
  return result.rows[0] ? couponFromRow(result.rows[0]) : null;
}

const num = (value: unknown) => (typeof value === "number" ? value : Number(value));

/** 校验并整理成入库字段；不合法时返回中文原因 */
async function parseCoupon(db: Db, body: Record<string, unknown>, partial: boolean): Promise<{ ok: true; fields: Partial<CouponFields> & { enabled?: boolean } } | { ok: false; message: string }> {
  const fields: Partial<CouponFields> & { enabled?: boolean } = {};
  const has = (key: string) => body[key] !== undefined;
  if (!partial || has("title")) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 60) return { ok: false, message: "名称要填，60 个字符以内（买家看到的，用英文）。" };
    fields.title = title;
  }
  if (!partial || has("kind")) {
    if (!COUPON_KINDS.includes(body.kind as CouponKind)) return { ok: false, message: "类型只能是满减、折扣或免运费。" };
    fields.kind = body.kind as CouponKind;
  }
  if (!partial || has("amount") || has("kind")) {
    const kind = fields.kind ?? (body.kind as CouponKind | undefined);
    const amount = kind === "shipping" ? 0 : num(body.amount);
    if (kind === "amount" && !(amount > 0 && amount <= 1000)) return { ok: false, message: "满减面额填 0.01–1000 美元。" };
    if (kind === "percent" && !(Number.isInteger(amount) && amount >= 1 && amount <= 90)) return { ok: false, message: "折扣填 1–90 的整数（10 = 9 折）。" };
    if (kind) fields.amount = Math.round(amount * 100) / 100;
  }
  if (!partial || has("threshold")) {
    const threshold = num(body.threshold ?? 0);
    if (!(threshold >= 0 && threshold <= 10000)) return { ok: false, message: "使用门槛填 0–10000 美元，0 是无门槛。" };
    fields.threshold = Math.round(threshold * 100) / 100;
  }
  if (!partial || has("validDays")) {
    const days = num(body.validDays);
    if (!(Number.isInteger(days) && days >= 1 && days <= 365)) return { ok: false, message: "有效期填 1–365 天。" };
    fields.validDays = days;
  }
  if (!partial || has("customerTypes")) {
    const types = Array.isArray(body.customerTypes) ? [...new Set(body.customerTypes.map(String))] : [];
    if (types.some((item) => !CUSTOMER_TYPES.includes(item as never))) return { ok: false, message: "适用客户不正确。" };
    fields.customerTypes = types;
  }
  if (!partial || has("productIds")) {
    const ids = Array.isArray(body.productIds) ? [...new Set(body.productIds.map(String))].slice(0, 50) : [];
    if (ids.length) {
      const found = await db.query("select id from store_products where id = any($1)", [ids]);
      if (found.rowCount !== ids.length) return { ok: false, message: "指定的商品有的已经不在店里了。" };
    }
    fields.productIds = ids;
  }
  if (has("enabled")) fields.enabled = Boolean(body.enabled);
  return { ok: true, fields };
}

const COLUMNS: Record<string, string> = {
  title: "title", kind: "kind", amount: "amount", threshold: "threshold", productIds: "product_ids",
  customerTypes: "customer_types", validDays: "valid_days", enabled: "enabled",
};

export function registerCouponRoutes(app: FastifyInstance, db: Db, guard: AuthGuard): void {
  app.get(
    "/v1/store/coupons",
    { preHandler: guard.requireRole() },
    async (request) => {
      const student = request.user!.role === "student";
      const result = await db.query<CouponRow>(`select * from store_coupons ${student ? "where enabled" : ""} order by created_at, id`);
      return result.rows.map(couponFromRow);
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    "/v1/store/coupons",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const parsed = await parseCoupon(db, request.body ?? {}, false);
      if (!parsed.ok) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: parsed.message };
      }
      const f = parsed.fields as CouponFields & { enabled?: boolean };
      const id = `CPN-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 100)}`;
      await db.query(
        `insert into store_coupons (id, title, kind, amount, threshold, product_ids, customer_types, valid_days, enabled)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, f.title, f.kind, f.amount, f.threshold, JSON.stringify(f.productIds), JSON.stringify(f.customerTypes), f.validDays, f.enabled ?? true],
      );
      await writeAudit(db, request.user!.sub, "coupon.create", id, { title: f.title });
      return { id };
    },
  );

  app.patch<{ Params: { couponId: string }; Body: Record<string, unknown> }>(
    "/v1/store/coupons/:couponId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const existing = await db.query<CouponRow>("select * from store_coupons where id = $1", [request.params.couponId]);
      if (!existing.rows[0]) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "优惠券不存在。" };
      }
      // 改类型时面额按新类型校验
      const body = { ...request.body };
      if (body.kind !== undefined && body.amount === undefined) body.amount = existing.rows[0].amount;
      if (body.amount !== undefined && body.kind === undefined) body.kind = existing.rows[0].kind;
      const parsed = await parseCoupon(db, body, true);
      if (!parsed.ok) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: parsed.message };
      }
      const entries = Object.entries(parsed.fields).filter(([key]) => COLUMNS[key]);
      if (!entries.length) return couponFromRow(existing.rows[0]);
      const sets = entries.map(([key], index) => `${COLUMNS[key]} = $${index + 2}`).join(", ");
      const values = entries.map(([, value]) => (Array.isArray(value) ? JSON.stringify(value) : value));
      const updated = await db.query<CouponRow>(`update store_coupons set ${sets} where id = $1 returning *`, [request.params.couponId, ...values]);
      await writeAudit(db, request.user!.sub, "coupon.update", request.params.couponId, { fields: entries.map(([key]) => key) });
      return couponFromRow(updated.rows[0]!);
    },
  );

  app.delete<{ Params: { couponId: string } }>(
    "/v1/store/coupons/:couponId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const result = await db.query("delete from store_coupons where id = $1", [request.params.couponId]);
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "优惠券不存在。" };
      }
      // 已经发出去的券卡片存的是快照，删券不影响老聊天记录
      await writeAudit(db, request.user!.sub, "coupon.delete", request.params.couponId);
      return { ok: true };
    },
  );
}
