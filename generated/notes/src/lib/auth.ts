import type { MiddlewareHandler } from "hono";
import { problem } from "./problem.ts";

export const ROLES = ["owner", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export type User = { id: string; workspaceId: string; role: Role };
export type AppEnv = { Variables: { user: User } };

// NOTE: in-memory token store; swap for a real identity provider in production.
const tokens = new Map<string, User>();
export const registerToken = (token: string, user: User): void => void tokens.set(token, user);

// Every route requires a bearer token unless "METHOD /path" is in the public allowlist.
export function authenticate(opts: { public: readonly string[] }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (opts.public.includes(`${c.req.method} ${c.req.path}`)) return next();
    const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    const user = token ? tokens.get(token) : undefined;
    if (!user) return problem(c, 401, "Unauthorized", "Missing or invalid bearer token");
    c.set("user", user);
    await next();
  };
}

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get("user").role)) return problem(c, 403, "Forbidden", `Requires role: ${roles.join(" or ")}`);
    await next();
  };
}
