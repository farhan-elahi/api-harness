// Every write route checks the caller's role with requireRole(<known roles>).
import { defineCheck, NothingToCheck } from "../../core/sdk.ts";
import { hono, label, literal, middlewareFor, WRITE } from "./_hono.ts";

const ROLES = new Set(["owner", "member", "viewer"]);

export default defineCheck({
  name: "authz-roles",
  unit: "write routes",
  rule: `Every write route (POST/PUT/PATCH/DELETE) calls requireRole() with known roles.
Known roles: owner, member, viewer. Put requireRole("owner", ...) in the route's middleware chain before the handler.
requireRole() with no roles, or an unknown role name, fails.`,
  run: ({ ast }) => {
    const h = hono(ast());
    const writes = h.routes.filter((r) => WRITE.has(r.method));
    if (h.routes.length && !writes.length) throw new NothingToCheck("no write routes");
    return writes
      .map((r) => {
        const checks = middlewareFor(h, r).filter((m) => m.name === "requireRole");
        const roles = checks.flatMap((m) => m.args.map((a) => literal(a) ?? `<${a.getText()}>`));
        const unknown = roles.filter((x) => !ROLES.has(x));
        const message = !checks.length
          ? "no requireRole() on write route"
          : !roles.length
            ? "requireRole() with no roles"
            : unknown.length
              ? `unknown role ${unknown.join(", ")} (known: ${[...ROLES].join(", ")})`
              : "";
        return { file: r.file, line: r.line, pass: !message, message: `${label(r)}${message ? ": " + message : ` [${roles.join(", ")}]`}` };
      });
  },
});
