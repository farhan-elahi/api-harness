import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.ts";
import { notes } from "../db/schema.ts";
import { requireRole, type AppEnv } from "../lib/auth.ts";
import { cursorQuery, decodeCursor, page, paginate } from "../lib/cursor.ts";
import { problem } from "../lib/problem.ts";
import { idempotency } from "../lib/idempotency.ts";
import { respond, validate } from "../lib/validate.ts";

const Note = z.object({ id: z.string(), title: z.string(), body: z.string().nullable() });
const NoteCreate = z.object({ title: z.string().min(1).max(200), body: z.string().optional() });
const IdParam = z.object({ id: z.string().min(1) });
const toNote = (r: Pick<typeof notes.$inferSelect, "id" | "title" | "body">): z.infer<typeof Note> => ({
  id: r.id,
  title: r.title,
  body: r.body,
});

export const notesRouter = new Hono<AppEnv>();

notesRouter.get("/", validate("query", cursorQuery), (c) => {
  const { cursor, limit } = c.req.valid("query");
  const after = decodeCursor(cursor);
  const rows = db
    .select({ id: notes.id, title: notes.title, body: notes.body })
    .from(notes)
    .where(and(eq(notes.workspaceId, c.get("user").workspaceId), after ? gt(notes.id, after) : undefined))
    .orderBy(asc(notes.id))
    .limit(limit + 1)
    .all();
  const result = paginate(rows, limit);
  return respond(c, page(Note), { data: result.data.map(toNote), next_cursor: result.next_cursor });
});

notesRouter.post("/", requireRole("owner", "member"), idempotency(), validate("json", NoteCreate), (c) => {
  const { title, body } = c.req.valid("json");
  const workspaceId = c.get("user").workspaceId;
  const existing = db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.title, title)))
    .get();
  if (existing) {
    return problem(c, 409, "Conflict", "A note with this title already exists.");
  }
  const row = db
    .insert(notes)
    .values({ id: randomUUID(), workspaceId, title, body: body ?? null })
    .returning({ id: notes.id, title: notes.title, body: notes.body })
    .get();
  return respond(c, Note, toNote(row), 201);
});

notesRouter.get("/:id", validate("param", IdParam), (c) => {
  const { id } = c.req.valid("param");
  const row = db
    .select({ id: notes.id, title: notes.title, body: notes.body })
    .from(notes)
    .where(and(eq(notes.workspaceId, c.get("user").workspaceId), eq(notes.id, id)))
    .get();
  if (!row) {
    return problem(c, 404, "Not Found", "Note not found.");
  }
  return respond(c, Note, toNote(row));
});

notesRouter.delete("/:id", requireRole("owner"), validate("param", IdParam), (c) => {
  const { id } = c.req.valid("param");
  const row = db
    .delete(notes)
    .where(and(eq(notes.workspaceId, c.get("user").workspaceId), eq(notes.id, id)))
    .returning({ id: notes.id })
    .get();
  if (!row) {
    return problem(c, 404, "Not Found", "Note not found.");
  }
  return c.body(null, 204);
});
