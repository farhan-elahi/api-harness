import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.ts";
import { tasks } from "../db/schema.ts";
import { requireRole, type AppEnv } from "../lib/auth.ts";
import { cursorQuery, decodeCursor, page, paginate } from "../lib/cursor.ts";
import { idempotency } from "../lib/idempotency.ts";
import { ProblemError } from "../lib/problem.ts";
import { respond, validate } from "../lib/validate.ts";

const Task = z.object({ id: z.string(), title: z.string(), body: z.string().nullable() });
const TaskCreate = z.object({ title: z.string().min(1).max(120), body: z.string().max(5000).optional() });
const TaskUpdate = TaskCreate.partial();
const IdParam = z.object({ id: z.string().uuid() });

const toTask = (r: Pick<typeof tasks.$inferSelect, "id" | "title" | "body">): z.infer<typeof Task> => ({ id: r.id, title: r.title, body: r.body });

function assertUniqueTitle(workspaceId: string, title: string, exceptId?: string): void {
  const clash = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.title, title)))
    .get();
  if (clash && clash.id !== exceptId) throw new ProblemError(409, "Conflict", `A task titled "${title}" already exists`);
}

export const tasksRouter = new Hono<AppEnv>();

tasksRouter.get("/", validate("query", cursorQuery), (c) => {
  const { cursor, limit } = c.req.valid("query");
  const after = decodeCursor(cursor);
  const ws = c.get("user").workspaceId;
  const rows = db
    .select({ id: tasks.id, title: tasks.title, body: tasks.body })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ws), after ? gt(tasks.id, after) : undefined))
    .orderBy(asc(tasks.id))
    .limit(limit + 1)
    .all();
  const result = paginate(rows, limit);
  return respond(c, page(Task), { data: result.data.map(toTask), next_cursor: result.next_cursor });
});

tasksRouter.get("/:id", validate("param", IdParam), (c) => {
  const { id } = c.req.valid("param");
  const row = db
    .select({ id: tasks.id, title: tasks.title, body: tasks.body })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, c.get("user").workspaceId), eq(tasks.id, id)))
    .get();
  if (!row) throw new ProblemError(404, "Not Found", `Task ${id} not found`);
  return respond(c, Task, toTask(row));
});

tasksRouter.post("/", requireRole("owner", "member"), idempotency(), validate("json", TaskCreate), (c) => {
  const input = c.req.valid("json");
  const ws = c.get("user").workspaceId;
  assertUniqueTitle(ws, input.title);
  const row = db
    .insert(tasks)
    .values({ id: randomUUID(), workspaceId: ws, title: input.title, body: input.body ?? null })
    .returning()
    .get();
  return respond(c, Task, toTask(row), 201);
});

tasksRouter.patch("/:id", requireRole("owner", "member"), validate("param", IdParam), validate("json", TaskUpdate), (c) => {
  const { id } = c.req.valid("param");
  const input = c.req.valid("json");
  const ws = c.get("user").workspaceId;
  if (input.title !== undefined) assertUniqueTitle(ws, input.title, id);
  const row = db
    .update(tasks)
    .set(input)
    .where(and(eq(tasks.workspaceId, ws), eq(tasks.id, id)))
    .returning()
    .get();
  if (!row) throw new ProblemError(404, "Not Found", `Task ${id} not found`);
  return respond(c, Task, toTask(row));
});

tasksRouter.delete("/:id", requireRole("owner"), validate("param", IdParam), (c) => {
  const { id } = c.req.valid("param");
  const row = db
    .delete(tasks)
    .where(and(eq(tasks.workspaceId, c.get("user").workspaceId), eq(tasks.id, id)))
    .returning({ id: tasks.id })
    .get();
  if (!row) throw new ProblemError(404, "Not Found", `Task ${id} not found`);
  return c.body(null, 204);
});
