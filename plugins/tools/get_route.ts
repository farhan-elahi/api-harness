import { relative } from "node:path";
import { Node } from "ts-morph";
import { decl, hono } from "../checks/_hono.ts";
import { defineTool } from "../../core/sdk.ts";
import { project } from "./_project.ts";

export default defineTool({
  name: "get_route",
  jit: true,
  description: 'One route\'s registration + handler, plus the Zod schemas its validators use. route = "METHOD /v1/path". Omit to list routes.',
  input: { type: "object", properties: { route: { type: "string" } } },
  run: (input, { root }) => {
    const routes = hono(project(root)).routes;
    const key = (r: (typeof routes)[number]) => `${r.method.toUpperCase()} ${r.path}`;
    if (!input.route) return routes.map(key).join("\n");
    const want = String(input.route).trim().replace(/\s+/, " ").toUpperCase();
    const r = routes.find((x) => key(x).toUpperCase() === want);
    if (!r) throw new Error(`no route ${JSON.stringify(input.route)}. Routes:\n${routes.map(key).join("\n")}`);
    const at = (n: Node) => `${relative(root, n.getSourceFile().getFilePath())}:${n.getStartLineNumber()}`;
    // Schemas = identifiers passed to validator middleware (e.g. validate("json", NoteCreate)), resolved to their declarations.
    const schemas = new Map<Node, string>();
    for (const m of r.mw)
      for (const a of m.args)
        if (Node.isIdentifier(a)) {
          const d = decl(a);
          if (d !== a && Node.isVariableDeclaration(d)) schemas.set(d, `${at(d)}\n${d.getVariableStatement()?.getText() ?? d.getText()}`);
        }
    const fn = r.handler && !r.call.getText().includes(r.handler.getText()) ? [`${at(r.handler)}\n${r.handler.getText()}`] : [];
    return [`${at(r.call)}\n${r.call.getText()}`, ...fn, ...schemas.values()].join("\n\n");
  },
});
