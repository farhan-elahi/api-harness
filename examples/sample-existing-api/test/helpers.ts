import { app } from "../src/app.ts";
import { registerToken, type Role } from "../src/lib/auth.ts";

// One user per (workspace, role); returns a request helper with that user's token.
export function as(workspaceId: string, role: Role) {
  const token = `${workspaceId}-${role}`;
  registerToken(token, { id: `user-${token}`, workspaceId, role });
  return (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
