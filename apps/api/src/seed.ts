import { forbiddenTerms, personaTemplates, scenarioScripts, standardPhrases, storeProducts, trainingScenarios } from "@cecs/domain";
import { getSetting, setSetting } from "./settings";
import type { Db } from "./db";
import { hashPassword } from "./security";

export async function seedCatalog(db: Db): Promise<void> {
  for (const scenario of trainingScenarios) {
    await db.query(
      `insert into scenarios (id, name, stage, objective, default_language, enabled)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [
        scenario.id,
        scenario.name,
        scenario.stage,
        scenario.objective,
        scenario.defaultLanguage,
        scenario.enabled,
      ],
    );
    // 剧本只在为空时写入，管理员改过的剧本不会被覆盖
    const script = scenarioScripts[scenario.id];
    if (script) {
      await db.query("update scenarios set script = $2 where id = $1 and script is null", [scenario.id, JSON.stringify(script)]);
    }
  }
  // D5：内置画像只在首次初始化时写入，老师删掉的不会在重启后回来
  const personaSeeded = await getSetting<number>(db, "personaSeedVersion");
  if (personaSeeded !== null && personaSeeded >= CATALOG_SEED_VERSION) return;
  for (const persona of personaTemplates) {
    await db.query(
      `insert into persona_templates
         (id, name, nationality, identity, personality, emotion, language, preference, customer_type, enabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do nothing`,
      [
        persona.id,
        persona.name,
        persona.nationality,
        persona.identity,
        persona.personality,
        persona.emotion,
        persona.language,
        persona.preference,
        persona.customerType,
        persona.enabled,
      ],
    );
  }
  await setSetting(db, "personaSeedVersion", CATALOG_SEED_VERSION);
}

/** 内置画像与商品的版本：扩充内置数据时加 1，只写入一次（D5） */
export const CATALOG_SEED_VERSION = 1;

export async function seedStoreProducts(db: Db): Promise<void> {
  const seeded = await getSetting<number>(db, "productSeedVersion");
  if (seeded !== null && seeded >= CATALOG_SEED_VERSION) return;
  for (const product of storeProducts) {
    await db.query(
      `insert into store_products (id, name, spec, price, sales, stock, tone)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing`,
      [product.id, product.name, product.spec, product.price, product.sales, product.stock, product.tone],
    );
  }
  await setSetting(db, "productSeedVersion", CATALOG_SEED_VERSION);
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
