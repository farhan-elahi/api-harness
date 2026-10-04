// Drizzle tenant isolation: every table has the tenant column; every select/update/delete filters on it; every insert sets it.
// Task file: `tenancy: { column: <name> }` (default workspaceId; matches the property or the SQL name), or `tenancy: none`.
import { Node, SyntaxKind, type CallExpression } from "ts-morph";
import { defineCheck, NotApplicable, type CheckResult } from "../../core/sdk.ts";
import { appFiles, calleeName, decl } from "../checks/_hono.ts";

const TABLE_FNS = /^(sqliteTable|pgTable|mysqlTable)$/;
const DB = /\b\w*(Database|Transaction)\b/;
const RAW = new Set(["run", "all", "get", "values", "execute"]);

export default defineCheck({
  name: "tenant-isolation",
  unit: "queries",
  run: ({ ast, task }) => {
    const COLUMN = tenantColumn(task.tenancy);
    const files = appFiles(ast());
    const calls = files.flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression));
    const out: CheckResult[] = [];
    const at = (n: Node, pass: boolean, message: string) => out.push({ file: n.getSourceFile().getFilePath(), line: n.getStartLineNumber(), pass, message });

    // table declaration node -> name of its tenant property (e.g. workspaceId)
    const tenantProp = new Map<object, string>();
    for (const c of calls.filter((c) => TABLE_FNS.test(calleeName(c)))) {
      const v = c.getParentIfKind(SyntaxKind.VariableDeclaration);
      const cols = c.getArguments()[1];
      const prop =
        cols && Node.isObjectLiteralExpression(cols)
          ? cols.getProperties().find((p) => p.getDescendantsOfKind(SyntaxKind.StringLiteral).some((s) => s.getLiteralValue() === COLUMN) || ("getName" in p && p.getName() === COLUMN))
          : undefined;
      const name = prop && "getName" in prop ? (prop as { getName(): string }).getName() : undefined;
      if (v && name) tenantProp.set(v.compilerNode, name);
      else at(c, false, `table ${literal0(c)} has no ${COLUMN} column`);
    }

    const filtersTenant = (arg: Node | undefined, table: object, prop: string) =>
      !!arg &&
      [arg, ...arg.getDescendants()].some(
        (n) => Node.isPropertyAccessExpression(n) && n.getName() === prop && decl(n.getExpression()).compilerNode === table,
      );

    for (const c of calls) {
      const e = c.getExpression();
      if (!Node.isPropertyAccessExpression(e) || !DB.test(e.getExpression().getType().getText())) continue;
      const op = e.getName();
      if (RAW.has(op)) {
        at(c, false, `raw SQL db.${op}() bypasses tenant scoping`);
        continue;
      }
      if (!["select", "selectDistinct", "insert", "update", "delete"].includes(op)) continue;
      const chain = chainCalls(c);
      const tableArg = op.startsWith("select") ? chain.get("from")?.getArguments()[0] : c.getArguments()[0];
      const table = tableArg ? decl(tableArg).compilerNode : undefined;
      const prop = table && tenantProp.get(table);
      const tname = tableArg?.getText() ?? "?";
      if (!table || !prop) {
        at(c, false, `${op} on ${tname}: not a tenant-scoped table`);
        continue;
      }
      if (op === "insert") {
        const vals = chain.get("values")?.getArguments()[0];
        const rows = vals && Node.isArrayLiteralExpression(vals) ? vals.getElements() : vals ? [vals] : [];
        const ok = rows.length > 0 && rows.every((r) => Node.isObjectLiteralExpression(r) && !!r.getProperty(prop));
        at(c, ok, ok ? `insert ${tname} sets ${prop}` : `insert into ${tname} does not set ${prop}`);
      } else {
        const ok = filtersTenant(chain.get("where")?.getArguments()[0], table, prop);
        at(c, ok, ok ? `${op} ${tname} filtered by ${prop}` : `${op} on ${tname} not filtered by ${tname}.${prop}`);
      }
    }

    // Relational API: db.query.<table>.findMany/findFirst({ where }) must mention the tenant column.
    for (const c of calls.filter((c) => /^(findMany|findFirst)$/.test(calleeName(c)))) {
      const t = c.getExpression();
      const q = Node.isPropertyAccessExpression(t) ? t.getExpression() : undefined;
      if (!q || !Node.isPropertyAccessExpression(q) || !/\.query$/.test(q.getExpression().getText())) continue;
      const props = new Set(tenantProp.values());
      const arg = c.getArguments()[0];
      const ok = !!arg && [arg, ...arg.getDescendants()].some((n) => (Node.isIdentifier(n) && props.has(n.getText())) || (Node.isStringLiteral(n) && n.getLiteralValue() === COLUMN));
      at(c, ok, ok ? `query.${q.getName()} filtered by tenant` : `query.${q.getName()}.${calleeName(c)} not filtered by tenant`);
    }
    return out;
  },
});

function tenantColumn(t: unknown): string {
  if (t === "none") throw new NotApplicable("tenancy: none");
  if (t === undefined) return "workspaceId";
  const col = t && typeof t === "object" && "column" in t ? t.column : undefined;
  if (typeof col !== "string" || !col) throw new Error(`tenancy must be "none" or { column: <name> }, got ${JSON.stringify(t)}`);
  return col;
}

const literal0 = (c: CallExpression) => c.getArguments()[0]?.getText() ?? "?";

// Calls chained after a query root: db.select().from(t).where(x) -> { from, where }
function chainCalls(start: CallExpression): Map<string, CallExpression> {
  const out = new Map<string, CallExpression>();
  let n: Node = start;
  for (;;) {
    const pa = n.getParentIfKind(SyntaxKind.PropertyAccessExpression);
    const call = pa?.getParentIfKind(SyntaxKind.CallExpression);
    if (!pa || !call) return out;
    if (!out.has(pa.getName())) out.set(pa.getName(), call);
    n = call;
  }
}
