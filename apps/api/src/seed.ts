import { forbiddenTerms, personaTemplates, standardPhrases, storeProducts, trainingScenarios } from "@cecs/domain";
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
  }
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
}

export async function seedStoreProducts(db: Db): Promise<void> {
  for (const product of storeProducts) {
    await db.query(
      `insert into store_products (id, name, spec, price, sales, stock, tone)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing`,
      [product.id, product.name, product.spec, product.price, product.sales, product.stock, product.tone],
    );
  }
}

export async function seedContentTerms(db: Db): Promise<void> {
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
