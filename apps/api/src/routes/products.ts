import type { FastifyInstance } from "fastify";
import {
  PRODUCT_SOURCES,
  normalizeCategory,
  type ProductDetails,
  type ProductSource,
} from "@cecs/contracts";
import { productLibrary } from "@cecs/domain";
import type { Db } from "../db";
import type { AuthGuard } from "../auth-context";
import { writeAudit } from "../auth-context";
import type { LlmGateway } from "../llm/gateway";
import { buildProductDraftMessages, productDraftSchema } from "../prompts/catalog";

/** 店铺商品（D-32）：详情字段、多图、链接/文字采集、内置商品库、Excel 批量导入 */

const MAX_IMAGES = 6;

const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const num = (value: unknown) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};
const arr = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

/** 把前端或 AI 给的详情洗成固定结构：去空、限长、限条数 */
export function sanitizeDetails(raw: unknown): ProductDetails {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const options = arr(d.options, 3)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return { name: str(o.name, 12), values: arr(o.values, 12).map((v) => str(v, 40)).filter(Boolean) };
    })
    .filter((o) => o.name && o.values.length);
  const optionNames = new Set(options.map((o) => o.name));
  const skus = arr(d.skus, 60)
    .map((item) => {
      const sku = (item ?? {}) as Record<string, unknown>;
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries((sku.values ?? {}) as Record<string, unknown>)) {
        if (optionNames.has(key) && str(value, 40)) values[key] = str(value, 40);
      }
      const code = str(sku.code, 40);
      return { values, price: num(sku.price), stock: Math.floor(num(sku.stock)), ...(code ? { code } : {}) };
    })
    .filter((sku) => Object.keys(sku.values).length > 0);
  const chart = (d.sizeChart ?? null) as Record<string, unknown> | null;
  const headers = chart ? arr(chart.headers, 10).map((h) => str(h, 20)) : [];
  const sizeChart = chart && headers.length >= 2
    ? { headers, rows: arr(chart.rows, 15).map((row) => arr(row, headers.length).map((cell) => str(cell, 20))).filter((row) => row.some(Boolean)) }
    : null;
  const shipping = (d.shipping ?? {}) as Record<string, unknown>;
  const afterSale = (d.afterSale ?? {}) as Record<string, unknown>;
  return {
    options,
    skus,
    bullets: arr(d.bullets, 6).map((b) => str(b, 300)).filter(Boolean),
    description: str(d.description, 2000),
    specs: arr(d.specs, 15)
      .map((item) => ({ name: str((item as Record<string, unknown>)?.name, 20), value: str((item as Record<string, unknown>)?.value, 120) }))
      .filter((row) => row.name && row.value),
    sizeChart,
    shipping: {
      shipsFrom: str(shipping.shipsFrom, 40),
      handlingDays: shipping.handlingDays === null || shipping.handlingDays === undefined || shipping.handlingDays === "" ? undefined : Math.floor(num(shipping.handlingDays)),
      methods: arr(shipping.methods, 8)
        .map((item) => {
          const m = (item ?? {}) as Record<string, unknown>;
          return { region: str(m.region, 20), method: str(m.method, 30), days: str(m.days, 30), fee: num(m.fee) };
        })
        .filter((m) => m.region && m.days),
    },
    afterSale: { returnPolicy: str(afterSale.returnPolicy, 400), warranty: str(afterSale.warranty, 120) },
    faq: arr(d.faq, 8)
      .map((item) => ({ q: str((item as Record<string, unknown>)?.q, 150), a: str((item as Record<string, unknown>)?.a, 400) }))
      .filter((item) => item.q && item.a),
  };
}

/** 把模型常见的变体写法转成约定结构：对象写法的规格/参数/问答、字符串写法的取值、对象数组写法的尺码表 */
export function normalizeProductDraft(raw: Record<string, unknown>): Record<string, unknown> {
  const splitValues = (value: unknown) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[/,，、|]/u) : []).map((item) => String(item).trim()).filter(Boolean);
  const entries = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : null);
  let options = raw.options;
  const optionEntries = entries(options);
  if (optionEntries) options = optionEntries.map(([name, values]) => ({ name, values: splitValues(values) }));
  if (Array.isArray(options)) {
    options = options.flatMap((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      if (typeof o.name === "string") return [{ name: o.name, values: splitValues(o.values ?? o.value) }];
      return Object.entries(o).map(([name, values]) => ({ name, values: splitValues(values) }));
    });
  }
  let specs = raw.specs;
  const specEntries = entries(specs);
  if (specEntries) specs = specEntries.map(([name, value]) => ({ name, value: String(value ?? "") }));
  let faq = raw.faq;
  const faqEntries = entries(faq);
  if (faqEntries) faq = faqEntries.map(([q, a]) => ({ q, a: String(a ?? "") }));
  if (Array.isArray(faq)) faq = faq.map((item) => { const x = (item ?? {}) as Record<string, unknown>; return { q: x.q ?? x.question, a: x.a ?? x.answer }; });
  let sizeChart = raw.sizeChart;
  if (Array.isArray(sizeChart) && sizeChart.length && typeof sizeChart[0] === "object" && !Array.isArray(sizeChart[0])) {
    const headers = Object.keys(sizeChart[0] as Record<string, unknown>);
    sizeChart = { headers, rows: sizeChart.map((row) => headers.map((h) => String((row as Record<string, unknown>)[h] ?? ""))) };
  }
  const bullets = typeof raw.bullets === "string" ? raw.bullets.split(/\n+/) : raw.bullets;
  return { ...raw, options, specs, faq, sizeChart, bullets };
}

/** 规格摘要：没填时按规格维度生成，如“颜色 4 × 尺码 5” */
function specSummary(spec: string, details: ProductDetails): string {
  if (spec) return spec;
  const options = details.options ?? [];
  return options.length ? options.map((o) => `${o.name} ${o.values.length}`).join(" × ") : "标准款";
}

function totalStock(fallback: number, details: ProductDetails): number {
  return details.skus?.length ? details.skus.reduce((sum, sku) => sum + sku.stock, 0) : fallback;
}

function cleanImages(value: unknown): string[] {
  return arr(value, MAX_IMAGES)
    .map((item) => str(item, 300))
    .filter((url) => url.startsWith("/uploads/products/") || url.startsWith("/library/"));
}

function productRowToJson(row: Record<string, unknown>) {
  const images = (row.images as string[] | null) ?? [];
  return {
    id: row.id,
    name: row.name,
    spec: row.spec,
    price: Number(row.price),
    sales: row.sales,
    stock: row.stock,
    tone: row.tone,
    enabled: row.enabled,
    imageUrl: images[0] ?? (row.image_url as string | null) ?? null,
    images,
    /* D-65：老数据的十个类目读出来时对到类目树上 */
    category: normalizeCategory(row.category, row.name as string),
    details: (row.details ?? {}) as ProductDetails,
    source: row.source,
    sourceUrl: (row.source_url as string | null) ?? null,
    libraryId: (row.library_id as string | null) ?? null,
  };
}

interface ProductBody {
  id?: string;
  name?: string;
  spec?: string;
  price?: number;
  sales?: number;
  stock?: number;
  tone?: string;
  enabled?: boolean;
  category?: string | null;
  images?: string[];
  details?: unknown;
  source?: string;
  sourceUrl?: string | null;
}

function normalizeBody(body: ProductBody) {
  const details = sanitizeDetails(body.details);
  const name = str(body.name, 120);
  const price = num(body.price);
  return {
    name,
    price,
    details,
    spec: specSummary(str(body.spec, 120), details),
    stock: totalStock(Math.floor(num(body.stock ?? 100)), details),
    category: normalizeCategory(body.category, name),
    images: cleanImages(body.images),
    source: (PRODUCT_SOURCES.includes(body.source as never) ? body.source : "manual") as ProductSource,
    sourceUrl: str(body.sourceUrl, 500) || null,
  };
}

export function registerProductRoutes(app: FastifyInstance, db: Db, guard: AuthGuard, gateway: LlmGateway): void {
  app.get<{ Querystring: { all?: string } }>(
    "/v1/store/products",
    { preHandler: guard.requireRole() },
    async (request) => {
      const showAll = request.query.all === "1" && request.user!.role !== "student";
      const result = await db.query(`select * from store_products ${showAll ? "" : "where enabled"} order by created_at, id`);
      return result.rows.map(productRowToJson);
    },
  );

  async function insertProduct(body: ProductBody, extra: { libraryId?: string | null } = {}) {
    const p = normalizeBody(body);
    const id = str(body.id, 40) || `SKU-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`;
    await db.query(
      `insert into store_products (id, name, spec, price, sales, stock, tone, enabled, category, images, image_url, details, source, source_url, library_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, p.name, p.spec, p.price, Math.floor(num(body.sales)), p.stock, body.tone ?? "#2f6f8f", body.enabled ?? true,
        p.category, JSON.stringify(p.images), p.images[0] ?? null, JSON.stringify(p.details), p.source, p.sourceUrl, extra.libraryId ?? null],
    );
    return id;
  }

  app.post<{ Body: ProductBody }>(
    "/v1/store/products",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      if (!str(body.name, 120) || num(body.price) <= 0) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请填写商品名称和大于 0 的价格。" };
      }
      try {
        const id = await insertProduct(body);
        await writeAudit(db, request.user!.sub, "product.create", id, { source: body.source ?? "manual" });
        return { ok: true, id };
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "23505") {
          reply.code(409);
          return { code: "PRODUCT_EXISTS", message: "商品编号已存在。" };
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { productId: string }; Body: ProductBody }>(
    "/v1/store/products/:productId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      const existing = await db.query("select * from store_products where id = $1", [request.params.productId]);
      const current = existing.rows[0];
      if (!current) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "商品不存在。" };
      }
      // 只改启停 / 库存等单项时不动详情
      const fullEdit = body.details !== undefined || body.name !== undefined;
      if (!fullEdit) {
        await db.query(
          `update store_products set price = coalesce($1, price), sales = coalesce($2, sales), stock = coalesce($3, stock),
             enabled = coalesce($4, enabled), updated_at = now() where id = $5`,
          [body.price ?? null, body.sales ?? null, body.stock ?? null, body.enabled ?? null, request.params.productId],
        );
      } else {
        const p = normalizeBody({ ...productRowToJson(current), ...body, details: body.details ?? current.details } as ProductBody);
        if (!p.name || p.price <= 0) {
          reply.code(400);
          return { code: "INVALID_INPUT", message: "请填写商品名称和大于 0 的价格。" };
        }
        await db.query(
          `update store_products set name = $1, spec = $2, price = $3, stock = $4, category = $5, images = $6, image_url = $7,
             details = $8, enabled = coalesce($9, enabled), updated_at = now() where id = $10`,
          [p.name, p.spec, p.price, p.stock, p.category, JSON.stringify(p.images), p.images[0] ?? null, JSON.stringify(p.details), body.enabled ?? null, request.params.productId],
        );
      }
      await writeAudit(db, request.user!.sub, "product.update", request.params.productId);
      return { ok: true };
    },
  );

  app.delete<{ Params: { productId: string } }>(
    "/v1/store/products/:productId",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const result = await db.query("delete from store_products where id = $1 returning id", [request.params.productId]);
      if (!result.rowCount) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "商品不存在。" };
      }
      await writeAudit(db, request.user!.sub, "product.delete", request.params.productId);
      return { ok: true };
    },
  );

  /** 上传一张商品图（multipart 单文件），追加到图片列表末尾；?main=1 时放到第一张 */
  app.post<{ Params: { productId: string }; Querystring: { main?: string } }>(
    "/v1/store/products/:productId/images",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const existing = await db.query("select images from store_products where id = $1", [request.params.productId]);
      if (!existing.rows[0]) {
        reply.code(404);
        return { code: "NOT_FOUND", message: "商品不存在。" };
      }
      const images = (existing.rows[0].images as string[]) ?? [];
      if (images.length >= MAX_IMAGES) {
        reply.code(400);
        return { code: "TOO_MANY_IMAGES", message: `每个商品最多 ${MAX_IMAGES} 张图片。` };
      }
      const file = await request.file();
      if (!file || !/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请上传 png/jpg/webp 图片。" };
      }
      const path = await import("node:path");
      const { createWriteStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const ext = file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "jpg";
      const fileName = `${request.params.productId}-${Date.now()}-${Math.floor(Math.random() * 1000)}.${ext}`;
      await pipeline(file.file, createWriteStream(path.resolve(process.cwd(), "uploads", "products", fileName)));
      const imageUrl = `/uploads/products/${fileName}`;
      const next = request.query.main === "1" ? [imageUrl, ...images] : [...images, imageUrl];
      await db.query("update store_products set images = $1, image_url = $2, updated_at = now() where id = $3", [JSON.stringify(next), next[0], request.params.productId]);
      return { ok: true, imageUrl, images: next };
    },
  );

  /** 采集：把商品页内容（链接读取的页面，或老师粘贴的详情页文字）交给 AI 整理成商品字段草稿，不入库 */
  app.post<{ Body: { url?: string; title?: string; structured?: string; text?: string } }>(
    "/v1/store/products/extract",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const body = request.body ?? {};
      const pageText = str(body.text, 30000);
      if (pageText.length < 30 && !str(body.structured, 100)) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "页面内容太少，没法整理。可以换成粘贴详情页文字。" };
      }
      if (!gateway.isConfigured("assist")) {
        reply.code(503);
        return { code: "AI_PROVIDER_NOT_CONFIGURED", message: "请由管理员配置 LLM 服务。" };
      }
      try {
        const { data } = await gateway.completeJson(
          "assist",
          buildProductDraftMessages({ url: str(body.url, 500), title: str(body.title, 300), structured: str(body.structured, 8000), pageText }),
          productDraftSchema,
          { temperature: 0.2, maxTokens: 3500, signal: AbortSignal.timeout(90_000) },
        );
        const normalized = normalizeProductDraft(data as Record<string, unknown>);
        const details = sanitizeDetails(normalized);
        const price = num(normalized.price);
        await writeAudit(db, request.user!.sub, "product.extract", undefined, { url: str(body.url, 200) || null });
        return {
          name: data.name,
          category: normalizeCategory(normalized.category, String(data.name ?? "")),
          price: price > 0 ? price : details.skus?.[0]?.price ?? null,
          details,
        };
      } catch (error) {
        request.log.error(error, "product extract failed");
        reply.code(502);
        return { code: "EXTRACT_FAILED", message: "没整理出来，请稍后重试，或改用粘贴详情页文字。" };
      }
    },
  );

  /** 内置商品库：列表（标出店铺里已经上架过的） */
  app.get(
    "/v1/store/library",
    { preHandler: guard.requireRole("teacher", "admin") },
    async () => {
      const inStore = await db.query("select library_id, name from store_products");
      const ids = new Set(inStore.rows.map((row) => row.library_id).filter(Boolean));
      const names = new Set(inStore.rows.map((row) => row.name));
      return productLibrary.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        price: item.price,
        spec: item.spec,
        imageUrl: `/library/${item.id}.jpg`,
        inStore: ids.has(item.id) || names.has(item.name),
      }));
    },
  );

  app.post<{ Body: { ids?: string[] } }>(
    "/v1/store/library/add",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const ids = Array.isArray(request.body?.ids) ? request.body!.ids.slice(0, 100) : [];
      const picked = productLibrary.filter((item) => ids.includes(item.id));
      if (!picked.length) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "请先勾选商品。" };
      }
      const inStore = await db.query("select library_id from store_products where library_id = any($1)", [picked.map((item) => item.id)]);
      const skip = new Set(inStore.rows.map((row) => row.library_id));
      const created: string[] = [];
      for (const item of picked) {
        if (skip.has(item.id)) continue;
        const id = await insertProduct(
          { name: item.name, spec: item.spec, price: item.price, category: item.category, details: item.details, images: [`/library/${item.id}.jpg`], source: "library", sales: 0 },
          { libraryId: item.id },
        );
        created.push(id);
      }
      await writeAudit(db, request.user!.sub, "product.library_add", undefined, { count: created.length });
      return { created: created.length, skipped: picked.length - created.length };
    },
  );

  /** Excel 批量导入：前端解析表格后按行提交，逐行校验 */
  app.post<{ Body: { products?: ProductBody[] } }>(
    "/v1/store/products/import",
    { preHandler: guard.requireRole("teacher", "admin") },
    async (request, reply) => {
      const rows = Array.isArray(request.body?.products) ? request.body!.products.slice(0, 500) : [];
      if (!rows.length) {
        reply.code(400);
        return { code: "INVALID_INPUT", message: "导入内容为空。" };
      }
      const failed: Array<{ index: number; reason: string }> = [];
      let created = 0;
      for (const [index, row] of rows.entries()) {
        if (!str(row.name, 120) || num(row.price) <= 0) {
          failed.push({ index, reason: "缺少商品名称或价格" });
          continue;
        }
        await insertProduct({ ...row, id: undefined, images: [], source: "excel" });
        created += 1;
      }
      await writeAudit(db, request.user!.sub, "product.import", undefined, { created, failed: failed.length });
      return { created, failed };
    },
  );
}
