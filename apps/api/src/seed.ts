import { forbiddenTerms, personaTemplates, productLibrary, scenarioScripts, standardPhrases, storeProducts, trainingScenarios } from "@cecs/domain";
import { getSetting, setSetting } from "./settings";
import type { Db } from "./db";
import { hashPassword } from "./security";

/** 改过名的内置场景：旧名 → 新名（老师改过名的不动） */
const RENAMED_SCENARIOS: Record<string, string> = { "CARE-001": "复购老客优惠沟通" };

export async function seedCatalog(db: Db): Promise<void> {
  const scenarioSeeded = (await getSetting<number>(db, "scenarioSeedVersion")) ?? 0;
  for (const scenario of trainingScenarios) {
    await db.query(
      `insert into scenarios (id, name, stage, objective, default_language, enabled, channel, order_kind)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do nothing`,
      [scenario.id, scenario.name, scenario.stage, scenario.objective, scenario.defaultLanguage, scenario.enabled, scenario.channel, scenario.orderKind],
    );
    // D-32 升级：旧库里的内置场景补上沟通方式和订单状态（order_kind 为空 = 还没升级过）
    await db.query(
      `update scenarios set channel = $2, order_kind = $3,
         name = case when name = $4 then $5 else name end
       where id = $1 and order_kind is null`,
      [scenario.id, scenario.channel, scenario.orderKind, RENAMED_SCENARIOS[scenario.id] ?? scenario.name, scenario.name],
    );
    // D-33：客户分层维护场景的适用客户价值层，只写一次（scenarioSeedVersion）
    if (scenario.customerTypes?.length && scenarioSeeded < 3) {
      await db.query("update scenarios set customer_types = $2 where id = $1 and customer_types = '[]'::jsonb", [scenario.id, JSON.stringify(scenario.customerTypes)]);
    }
    // 剧本只在为空时写入，管理员改过的剧本不会被覆盖
    const script = scenarioScripts[scenario.id];
    if (script) {
      await db.query("update scenarios set script = $2 where id = $1 and script is null", [scenario.id, JSON.stringify(script)]);
    }
  }
  if (scenarioSeeded < 3) await setSetting(db, "scenarioSeedVersion", 3);
  // D5：内置画像按版本只写入一次，老师删掉的不会在重启后回来
  const personaSeeded = (await getSetting<number>(db, "personaSeedVersion")) ?? 0;
  if (personaSeeded >= PERSONA_SEED_VERSION) return;
  for (const persona of personaTemplates) {
    const values = [persona.id, persona.name, persona.nationality, persona.identity, persona.personality, persona.emotion, persona.language,
      persona.preference, persona.customerType, persona.buyerRole, persona.decisionStyle, JSON.stringify(persona.concerns), persona.note];
    if (personaSeeded === 0) {
      await db.query(
        `insert into persona_templates
           (id, name, nationality, identity, personality, emotion, language, preference, customer_type, buyer_role, decision_style, concerns, note, enabled)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
         on conflict (id) do nothing`,
        values,
      );
    } else {
      // D-33 升级：旧结构的内置模板（buyer_role 为空）按新定义重写；老师删掉的不补回来
      await db.query(
        `update persona_templates set name = $2, nationality = $3, identity = $4, personality = $5, emotion = $6, language = $7,
           preference = $8, customer_type = $9, buyer_role = $10, decision_style = $11, concerns = $12, note = $13
         where id = $1 and buyer_role is null`,
        values,
      );
    }
  }
  await setSetting(db, "personaSeedVersion", PERSONA_SEED_VERSION);
}

/** 内置画像的版本：扩充内置数据时加 1（D5）。2 = D-32 扩到 40 个；3 = D-33 结构化（角色 × 决策风格 × 价值层） */
export const PERSONA_SEED_VERSION = 3;
/** 内置商品的版本。2 = 用商品库给内置商品补详情和图片 */
export const PRODUCT_SEED_VERSION = 2;

export async function seedStoreProducts(db: Db): Promise<void> {
  const seeded = (await getSetting<number>(db, "productSeedVersion")) ?? 0;
  if (seeded >= PRODUCT_SEED_VERSION) return;
  if (seeded < 1) {
    for (const product of storeProducts) {
      await db.query(
        `insert into store_products (id, name, spec, price, sales, stock, tone)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing`,
        [product.id, product.name, product.spec, product.price, product.sales, product.stock, product.tone],
      );
    }
  }
  // 商品库还没就绪时先不升版本，下次启动再补
  if (productLibrary.length === 0) {
    await setSetting(db, "productSeedVersion", 1);
    return;
  }
  for (const item of productLibrary) {
    await db.query(
      `update store_products set
         category = coalesce(category, $2),
         stock = case when details = '{}'::jsonb then $7 else stock end,
         details = case when details = '{}'::jsonb then $3::jsonb else details end,
         images = case when images = '[]'::jsonb then $4::jsonb else images end,
         image_url = coalesce(image_url, $5),
         library_id = coalesce(library_id, $6)
       where name = $1`,
      [item.name, item.category, JSON.stringify(item.details), JSON.stringify([`/library/${item.id}.jpg`]), `/library/${item.id}.jpg`, item.id, item.details.skus.reduce((sum, sku) => sum + sku.stock, 0)],
    );
  }
  await setSetting(db, "productSeedVersion", PRODUCT_SEED_VERSION);
}

/** 内置词库的版本：扩充内置词条时加 1，下次启动只写入一次（E6）。 */
export const CONTENT_SEED_VERSION = 2;

/**
 * 内置违规词与标准话术。按版本只写入一次：管理员删除的词条，重启后不会被补回来（E6 修复“删除后复活”）。
 */
export async function seedContentTerms(db: Db): Promise<void> {
  const seeded = await getSetting<number>(db, "contentSeedVersion");
  if (seeded !== null && seeded >= CONTENT_SEED_VERSION) return;
  for (const term of forbiddenTerms) {
    await db.query(
      "insert into content_terms (kind, text) values ('forbidden', $1) on conflict do nothing",
      [term],
    );
  }
  for (const phrase of standardPhrases) {
    await db.query(
      "insert into content_terms (kind, text) values ('phrase', $1) on conflict do nothing",
      [phrase],
    );
  }
  await setSetting(db, "contentSeedVersion", CONTENT_SEED_VERSION);
}

export async function seedAdmin(
  db: Db,
  initialPassword: string,
): Promise<void> {
  const existing = await db.query(
    "select 1 from users where role = 'admin' limit 1",
  );
  if (existing.rowCount) return;
  const passwordHash = await hashPassword(initialPassword);
  await db.query(
    `insert into users (username, password_hash, display_name, role, must_change_password)
     values ('admin', $1, '系统管理员', 'admin', true)`,
    [passwordHash],
  );
}
