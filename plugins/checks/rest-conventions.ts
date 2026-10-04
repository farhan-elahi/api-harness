// /v1 base path, plural kebab nouns, cursor-paginated lists, Idempotency-Key on POST, 201/204, 404/409/422 where due.
import { Node, SyntaxKind } from "ts-morph";
import { defineCheck, type CheckResult } from "../../core/sdk.ts";
import { appFiles, calleeName, callsIn, decl, hono, label, literal, middlewareFor, reachable, type Route } from "./_hono.ts";

const IRREGULAR = new Set(["people", "children", "data", "media", "men", "women", "feedback", "staff"]);
const TABLE_FNS = /^(sqliteTable|pgTable|mysqlTable)$/;

const statusIn = (nodes: Node[], code: number) => nodes.some((n) => n.getDescendantsOfKind(SyntaxKind.NumericLiteral).some((l) => l.getLiteralValue() === code));

export default defineCheck({
  name: "rest-conventions",
  unit: "routes",
  run: ({ ast }) => {
    const p = ast();
    const h = hono(p);
    // Tables with a unique constraint: writes touching them must handle 409.
    const uniqueTables: object[] = appFiles(p)
      .flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression))
      .filter((c) => TABLE_FNS.test(calleeName(c)) && callsIn(c).some((x) => /^(unique|uniqueIndex)$/.test(calleeName(x))))
      .flatMap((c) => c.getParentIfKind(SyntaxKind.VariableDeclaration)?.compilerNode ?? []);
    const touchesUnique = (r: Route) =>
      reachable(r).some((f) => f.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => uniqueTables.includes(decl(id).compilerNode)));

    const results: CheckResult[] = h.routes.map((r) => {
      const segs = r.path.split("/").filter(Boolean);
      const item = segs.at(-1)?.startsWith(":") ?? false;
      const mw = middlewareFor(h, r);
      const body = reachable(r);
      const problems: string[] = [];
      if (segs[0] !== "v1") problems.push("path must start with /v1");
      for (const s of segs.slice(1).filter((s) => !s.startsWith(":")))
        if (!/^[a-z][a-z0-9-]*$/.test(s) || !(s.endsWith("s") || IRREGULAR.has(s))) problems.push(`"${s}" is not a plural kebab-case noun`);
      if (r.method === "get" && !item) {
        const q = mw.find((m) => m.name === "validate" && literal(m.args[0]) === "query");
        const cursor = q && /\bcursor\??:/.test(q.args[1]?.getType().getText() ?? "");
        const paged = callsIn(r.handler).some((c) => calleeName(c) === "paginate");
        if (!cursor || !paged) problems.push("list route needs cursor pagination (cursorQuery + paginate())");
      }
      if (r.method === "post") {
        if (!mw.some((m) => m.name === "idempotency")) problems.push("POST needs Idempotency-Key support (idempotency())");
        if (!statusIn(body, 201)) problems.push("create must return 201");
      }
      if (r.method === "delete" && !statusIn(body, 204)) problems.push("delete must return 204");
      if (item && !statusIn(body, 404)) problems.push("item route must return 404 for unknown ids");
      if (["post", "put", "patch"].includes(r.method) && touchesUnique(r) && !statusIn(body, 409))
        problems.push("write on a table with a unique constraint must return 409 on conflict");
      return { file: r.file, line: r.line, pass: !problems.length, message: `${label(r)}${problems.length ? ": " + problems.join("; ") : ""}` };
    });

    // Validation failures must be 422: check the validator implementation once.
    const v = h.routes.flatMap((r) => r.mw).find((m) => m.name === "validate" && Node.isCallExpression(m.call));
    const vfn = v && Node.isCallExpression(v.call) ? decl(v.call.getExpression()) : undefined;
    if (vfn) {
      const ok = vfn.getDescendantsOfKind(SyntaxKind.NumericLiteral).some((l) => l.getLiteralValue() === 422);
      results.push({ file: vfn.getSourceFile().getFilePath(), line: vfn.getStartLineNumber(), pass: ok, message: ok ? "validation failures -> 422" : "validator must return 422 on validation failure" });
    }
    return results;
  },
});
