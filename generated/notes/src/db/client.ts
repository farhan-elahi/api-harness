import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrations } from "./migrations.ts";
import * as schema from "./schema.ts";

const sqlite = new Database(process.env.DB_PATH ?? ":memory:");
sqlite.pragma("foreign_keys = ON");
for (const sql of migrations) sqlite.exec(sql);

export const db = drizzle(sqlite, { schema });
