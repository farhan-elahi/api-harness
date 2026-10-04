import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.ts";
import { notes } from "../db/schema.ts";
import { requireRole, type AppEnv } from "../lib/auth.ts";
import { cursorQuery, decodeCursor, page, paginate } from "../lib/cursor.ts";
import { idempotency } from "../lib/idempotency.ts";
import { ProblemError } from "../lib/problem.ts";
import { respond, validate } from "../lib/validate.ts";

const Note = z.object({ id: z.string(), title: z.string(), body: z.string().nullable() });
const NoteCreate = z.object({ title: z.string().min(1).max(120), body: z.string().max(5000).optional() });
const NoteUpdate = NoteCreate.partial();
const IdParam = z.object({ id: z.string().uuid() });

const toNote = (r: typeof notes.$inferSelect): z.infer<typeof Note> => ({ id: r.id, title: r.title, body: r.body });

function assertUniqueTitle(workspaceId: string, title: string, exceptId?: string): void {
  const clash = db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.title, title)))
    .get();
  if (clash && clash.id !== exceptId) throw new ProblemError(409, "Conflict", `A note titled "${title}" already exists`);
}

export const notesRouter = new Hono<AppEnv>();

notesRouter.get("/", validate("query", cursorQuery), (c) => {
  const { cursor, limit } = c.req.valid("query");
  const after = decodeCursor(cursor);
  const ws = c.get("user").workspaceId;
  const rows = db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, ws), after ? gt(notes.id, after) : undefined))
    .orderBy(asc(notes.id))
    .limit(limit + 1)
    .all();
  const result = paginate(rows, limit);
  return respond(c, page(Note), { data: result.data.map(toNote), next_cursor: result.next_cursor });
});

notesRouter.get("/:id", validate("param", IdParam), (c) => {
  const { id } = c.req.valid("param");
  const row = db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, c.get("user").workspaceId), eq(notes.id, id)))
    .get();
  if (!row) throw new ProblemError(404, "Not Found", `Note ${id} not found`);
  return respond(c, Note, toNote(row));
});

notesRouter.post("/", requireRole("owner", "member"), idempotency(), validate("json", NoteCreate), (c) => {
  const input = c.req.valid("json");
  const ws = c.get("user").workspaceId;
  assertUniqueTitle(ws, input.title);
  const row = db
    .insert(notes)
    .values({ id: randomUUID(), workspaceId: ws, title: input.title, body: input.body ?? null })
    .returning()
    .get();
  return respond(c, Note, toNote(row), 201);
});

notesRouter.patch("/:id", requireRole("owner", "member"), validate("param", IdParam), validate("json", NoteUpdate), (c) => {
  const { id } = c.req.valid("param");
  const input = c.req.valid("json");
  const ws = c.get("user").workspaceId;
  if (input.title !== undefined) assertUniqueTitle(ws, input.title, id);
  const row = db
    .update(notes)
    .set(input)
    .where(and(eq(notes.workspaceId, ws), eq(notes.id, id)))
    .returning()
    .get();
  if (!row) throw new ProblemError(404, "Not Found", `Note ${id} not found`);
  return respond(c, Note, toNote(row));
});

notesRouter.delete("/:id", requireRole("owner"), validate("param", IdParam), (c) => {
  const { id } = c.req.valid("param");
  const row = db
    .delete(notes)
    .where(and(eq(notes.workspaceId, c.get("user").workspaceId), eq(notes.id, id)))
    .returning({ id: notes.id })
    .get();
  if (!row) throw new ProblemError(404, "Not Found", `Note ${id} not found`);
  return c.body(null, 204);
});
