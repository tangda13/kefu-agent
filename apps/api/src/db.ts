import pg from "pg";
import { migrations } from "./migrations";

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  for (const migration of migrations) {
    const applied = await db.query(
      "select 1 from schema_migrations where id = $1",
      [migration.id],
    );
    if (applied.rowCount) continue;
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(migration.sql);
      await client.query("insert into schema_migrations (id) values ($1)", [
        migration.id,
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function resetDatabase(db: Db): Promise<void> {
  await db.query("drop schema public cascade; create schema public;");
  await migrate(db);
}
