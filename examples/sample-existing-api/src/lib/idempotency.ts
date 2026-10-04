// Idempotency-Key for unsafe POSTs: same key + same body replays the first response; same key + different body -> 422.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth.ts";
import { problem } from "./problem.ts";

type Saved = { body: string; requestBody: string; status: number; contentType: string };
// NOTE: in-memory, per process; move to the DB (with TTL) for multi-instance deploys.
const store = new Map<string, Saved>();

export function idempotency(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header("Idempotency-Key");
    if (!key) return next();
    const id = `${c.get("user").id}:${c.req.method}:${c.req.path}:${key}`;
    const requestBody = await c.req.raw.clone().text();
    const saved = store.get(id);
    if (saved) {
      if (saved.requestBody !== requestBody)
        return problem(c, 422, "Idempotency-Key reused", "This Idempotency-Key was used with a different request body");
      return new Response(saved.body, {
        status: saved.status,
        headers: { "Content-Type": saved.contentType, "Idempotent-Replayed": "true" },
      });
    }
    await next();
    if (c.res.status < 300)
      store.set(id, {
        body: await c.res.clone().text(),
        requestBody,
        status: c.res.status,
        contentType: c.res.headers.get("Content-Type") ?? "application/json",
      });
  };
}
