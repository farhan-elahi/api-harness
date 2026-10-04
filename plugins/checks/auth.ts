// Every route sits behind auth middleware registered before it, unless "METHOD /path" is in the public allowlist.
import { Node, SyntaxKind } from "ts-morph";
import { defineCheck } from "../../core/sdk.ts";
import { hono, label, middlewareFor } from "./_hono.ts";

const AUTH = /^(authenticate|requireAuth|auth|bearerAuth|jwt)$/;

export default defineCheck({
  name: "auth",
  unit: "routes",
  rule: `Every route is behind auth middleware, unless allowlisted as public.
Register the auth middleware with app.use()/router.use() before the routes it guards.
A public route goes in the auth middleware's \`public: ["METHOD /path"]\` option; nothing else is exempt.`,
  run: ({ ast }) => {
    const h = hono(ast());
    // Public allowlist: string literals in the `public: [...]` option of any auth middleware call.
    const allow = new Set(
      [...h.uses.flatMap((u) => u.mw), ...h.routes.flatMap((r) => r.mw)]
        .filter((m) => AUTH.test(m.name))
        .flatMap((m) => m.args)
        .flatMap((a) => (Node.isObjectLiteralExpression(a) ? (a.getProperty("public")?.getDescendantsOfKind(SyntaxKind.StringLiteral) ?? []) : []))
        .map((s) => s.getLiteralValue()),
    );
    return h.routes.map((r) => {
      const name = label(r);
      const covered = middlewareFor(h, r).some((m) => AUTH.test(m.name));
      if (allow.has(name)) return { file: r.file, line: r.line, pass: true, message: `${name} (public allowlist)` };
      if (covered) return { file: r.file, line: r.line, pass: true, message: name };
      return { file: r.file, line: r.line, pass: false, message: `${name}: not behind auth middleware (register it before this route, or allowlist it as public)` };
    });
  },
});
