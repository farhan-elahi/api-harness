// Params, query, body validated with Zod middleware; responses parsed with Zod; no hand-written duplicates of schemas.
import { Node, SyntaxKind } from "ts-morph";
import { defineCheck, type CheckResult } from "../../core/sdk.ts";
import { appFiles, calleeName, ctxCalls, hono, label, literal, middlewareFor, WRITE } from "./_hono.ts";

const RAW = new Set(["param", "query", "queries", "json", "parseBody", "formData", "arrayBuffer", "text"]);
const isZod = (n: Node | undefined) => !!n && /\bZod[A-Z]\w*/.test(n.getType().getText());

export default defineCheck({
  name: "zod-boundary",
  unit: "handlers",
  rule: `Every input is validated with Zod and every response is parsed with Zod.
Params, query and JSON bodies go through validate(target, Schema) middleware and are read with c.req.valid(); never raw c.req.param()/query()/json().
Response bodies are produced by Schema.parse(). Types come from z.infer<typeof Schema>; no hand-written duplicate types.`,
  run: ({ ast }) => {
    const p = ast();
    const h = hono(p);
    const results: CheckResult[] = h.routes.map((r) => {
      const fail = (line: number, message: string) => ({ file: r.file, line, pass: false, message: `${label(r)}: ${message}` });
      const targets = new Set(
        middlewareFor(h, r)
          .filter((m) => /^(validate|zValidator)$/.test(m.name) && isZod(m.args[1]))
          .map((m) => literal(m.args[0])),
      );
      if (r.path.includes("/:") && !targets.has("param")) return fail(r.line, "path params not validated with Zod");
      if (WRITE.has(r.method) && r.method !== "delete" && !targets.has("json") && !targets.has("form"))
        return fail(r.line, "body not parsed with Zod");
      if (!r.handler) return fail(r.line, "handler not resolvable for analysis");
      const raw = ctxCalls(r, ".req").find((c) => RAW.has(c.name));
      if (raw) return fail(raw.call.getStartLineNumber(), `raw c.req.${raw.name}() bypasses Zod; use c.req.valid()`);
      const unparsed = ctxCalls(r, "").find((c) => {
        if (c.name !== "json") return false;
        const arg = c.call.getArguments()[0];
        return !(arg && Node.isCallExpression(arg) && /^(parse|parseAsync)$/.test(calleeName(arg)));
      });
      if (unparsed) return fail(unparsed.call.getStartLineNumber(), "response not parsed with Zod; use respond()");
      return { file: r.file, line: r.line, pass: true, message: label(r) };
    });

    // Hand-written interface/type literal with the same keys as a z.object schema -> should be z.infer.
    const files = appFiles(p);
    const schemas = files
      .flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression))
      .filter((c) => c.getExpression().getText() === "z.object" && Node.isObjectLiteralExpression(c.getArguments()[0]))
      .map((c) => {
        const keys = c.getArguments()[0]!.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties().map((x) => (x as { getName?(): string }).getName?.() ?? "");
        return [...keys].sort().join(",");
      });
    for (const sf of files) {
      const types = [
        ...sf.getInterfaces().map((i) => ({ node: i as Node, keys: i.getProperties().map((m) => m.getName()) })),
        ...sf.getTypeAliases().flatMap((t) => {
          const lit = t.getTypeNode();
          return lit && Node.isTypeLiteral(lit) ? [{ node: t as Node, keys: lit.getProperties().map((m) => m.getName()) }] : [];
        }),
      ];
      for (const t of types)
        if (t.keys.length >= 2 && schemas.includes([...t.keys].sort().join(",")))
          results.push({ file: sf.getFilePath(), line: t.node.getStartLineNumber(), pass: false, message: "hand-written type duplicates a Zod schema; use z.infer" });
    }
    return results;
  },
});
