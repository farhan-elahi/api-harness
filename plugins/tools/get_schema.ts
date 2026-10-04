import { relative } from "node:path";
import { SyntaxKind } from "ts-morph";
import { appFiles, calleeName, literal } from "../checks/_hono.ts";
import { defineTool } from "../../core/sdk.ts";
import { project } from "./_project.ts";

const TABLE_FNS = /^(sqliteTable|pgTable|mysqlTable)$/;

export default defineTool({
  name: "get_schema",
  jit: true,
  description: "One DB table definition; omit table to list.",
  input: { type: "object", properties: { table: { type: "string" } } },
  run: (input, { root }) => {
    const tables = appFiles(project(root))
      .flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression))
      .filter((c) => TABLE_FNS.test(calleeName(c)))
      .map((c) => {
        const v = c.getParentIfKind(SyntaxKind.VariableDeclaration);
        return { sql: literal(c.getArguments()[0]), name: v?.getName(), node: v?.getVariableStatement() ?? c };
      });
    if (!input.table) return tables.map((t) => `${t.name ?? "?"} (${t.sql ?? "?"})`).join("\n") || "(no tables)";
    const t = tables.find((x) => x.sql === input.table || x.name === input.table);
    if (!t) throw new Error(`no table ${JSON.stringify(input.table)}. Tables: ${tables.map((x) => x.sql ?? x.name).join(", ")}`);
    const sf = t.node.getSourceFile();
    return `${relative(root, sf.getFilePath())}:${t.node.getStartLineNumber()}\n${t.node.getText()}`;
  },
});
