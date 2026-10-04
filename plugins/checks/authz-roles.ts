// Every write route checks the caller's role with requireRole(<known roles>).
import { defineCheck } from "../../core/sdk.ts";
import { hono, label, literal, middlewareFor, WRITE } from "./_hono.ts";

const ROLES = new Set(["owner", "member", "viewer"]);

export default defineCheck({
  name: "authz-roles",
  unit: "write routes",
  run: ({ ast }) => {
    const h = hono(ast());
    return h.routes
      .filter((r) => WRITE.has(r.method))
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
