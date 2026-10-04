import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { problem, ProblemError } from "./problem.ts";

export function onError(err: Error, c: Context): Response {
  if (err instanceof ProblemError) return problem(c, err.status, err.title, err.detail);
  if (err instanceof HTTPException) return problem(c, err.status, err.message || "Request error");
  console.error(err);
  return problem(c, 500, "Internal Server Error");
}

export function notFound(c: Context): Response {
  return problem(c, 404, "Not Found", `No route for ${c.req.method} ${c.req.path}`);
}
