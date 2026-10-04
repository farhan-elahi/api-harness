// Deliberately broken: every "✗ <rule>" marker is a line that rule must report.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.ts";
import { logs, widgets } from "../db/schema.ts";
import { requireRole, type AppEnv } from "../lib/auth.ts";
import { respond, validate } from "../lib/validate.ts";

const Widget = z.object({ id: z.string(), name: z.string() });
const IdParam = z.object({ id: z.string() });
interface WidgetShape { id: string; name: string } // ✗ zod-boundary

export const widgetsRouter = new Hono<AppEnv>();

widgetsRouter.get("/", (c) => { // ✗ rest-conventions ✗ auth
  const rows = db.select().from(widgets).all(); // ✗ tenant-isolation
  return c.json(rows); // ✗ zod-boundary
});

widgetsRouter.get("/search", (c) => { // ✗ rest-conventions ✗ auth
  const q = c.req.query("q"); // ✗ zod-boundary
  const all = db.select().from(logs).all(); // ✗ tenant-isolation
  return respond(c, z.array(z.string()), all.map((l) => l.message).filter((m) => m.includes(q ?? "")));
});

widgetsRouter.get("/:id", validate("param", IdParam), (c) => { // ✗ auth
  const { id } = c.req.valid("param");
  const row = db.select().from(widgets).where(eq(widgets.workspaceId, c.get("user").workspaceId)).get();
  if (!row) return c.json({ error: "not found" }, 404); // ✗ problem-json ✗ zod-boundary
  if (row.id !== id) return new Response("mismatch", { status: 500 }); // ✗ problem-json
  const shape: WidgetShape = row;
  return respond(c, Widget, shape);
});

widgetsRouter.post("/", requireRole("admin"), async (c) => { // ✗ zod-boundary ✗ authz-roles ✗ rest-conventions ✗ auth ✗ tsc-strict
  const body = (await c.req.json()) as any; // ✗ tsc-strict
  const row = db.insert(widgets).values({ id: randomUUID(), name: body.name }).returning().get(); // ✗ tenant-isolation ✗ tsc-strict
  return respond(c, Widget, row!); // ✗ tsc-strict
});

widgetsRouter.delete("/:id", validate("param", IdParam), (c) => { // ✗ authz-roles ✗ rest-conventions ✗ auth
  const { id } = c.req.valid("param");
  db.delete(widgets).where(eq(widgets.id, id)).run(); // ✗ tenant-isolation
  return respond(c, z.object({ ok: z.boolean() }), { ok: true });
});

// @ts-ignore ✗ tsc-strict
export const count: number = "zero"; // suppressed by the @ts-ignore above, which is itself the violation
