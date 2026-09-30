import path from "node:path";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { testDatabaseUrl } from "./guard";

/** Recreates the schema from the committed migrations (0000 → latest) before the suite. */
export default async function setup() {
  const url = testDatabaseUrl();
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [rows] = await conn.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const { t } of rows as { t: string }[]) await conn.query(`DROP TABLE \`${t}\``);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    await migrate(drizzle(conn), { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
  } finally {
    await conn.end();
  }
}
