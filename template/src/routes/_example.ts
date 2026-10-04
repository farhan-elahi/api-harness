// Reference resource: copy this pattern for new resources (table goes in db/schema.ts, CREATE TABLE in db/migrations.ts).
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.ts";
import { requireRole, type AppEnv } from "../lib/auth.ts";
import { cursorQuery, decodeCursor, page, paginate } from "../lib/cursor.ts";
import { idempotency } from "../lib/idempotency.ts";
import { respond, validate } from "../lib/validate.ts";

// Declared here only to keep the example self-contained.
export const examples = sqliteTable("examples", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
});

const Example = z.object({ id: z.string(), name: z.string() });
const ExampleCreate = z.object({ name: z.string().min(1).max(120) });
const toExample = (r: Pick<typeof examples.$inferSelect, "id" | "name">): z.infer<typeof Example> => ({ id: r.id, name: r.name });

export const examplesRouter = new Hono<AppEnv>();

examplesRouter.get("/", validate("query", cursorQuery), (c) => {
  const { cursor, limit } = c.req.valid("query");
  const after = decodeCursor(cursor);
  const rows = db
    .select({ id: examples.id, name: examples.name })
    .from(examples)
    .where(and(eq(examples.workspaceId, c.get("user").workspaceId), after ? gt(examples.id, after) : undefined))
    .orderBy(asc(examples.id))
    .limit(limit + 1)
    .all();
  const result = paginate(rows, limit);
  return respond(c, page(Example), { data: result.data.map(toExample), next_cursor: result.next_cursor });
});

examplesRouter.post("/", requireRole("owner", "member"), idempotency(), validate("json", ExampleCreate), (c) => {
  const { name } = c.req.valid("json");
  const row = db
    .insert(examples)
    .values({ id: randomUUID(), workspaceId: c.get("user").workspaceId, name })
    .returning()
    .get();
  return respond(c, Example, toExample(row), 201);
});
