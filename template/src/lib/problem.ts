// RFC 7807 problem details. Every non-2xx response goes through problem() or ProblemError.
import type { Context } from "hono";

export function problem(c: Context, status: number, title: string, detail?: string, type = "about:blank"): Response {
  const body = { type, title, status, detail: detail ?? title, instance: c.req.path };
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/problem+json" } });
}

// Throw from anywhere; onError turns it into a problem response.
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
  }
}
