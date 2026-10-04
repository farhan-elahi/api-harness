// ORM validator: every query names its columns. Drizzle db.select() needs a column map; Prisma find*/Drizzle
// relational find* need `select` / `columns`. No select *: new columns never leak out by accident.
import { Node, SyntaxKind } from "ts-morph";
import { defineCheck, NothingToCheck, type CheckResult } from "../../core/sdk.ts";
import { appFiles } from "../checks/_hono.ts";

const DB = /\b\w*(Database|Transaction|PrismaClient)\b/;
const SELECT = new Set(["select", "selectDistinct"]);
const FIND = /^find(Many|First|Unique)(OrThrow)?$/;

export default defineCheck({
  name: "explicit-columns",
  unit: "queries",
  rule: `Queries list explicit columns: no select *.
Drizzle: db.select({ id: t.id, ... }), not db.select(). Relational db.query.t.findMany({ columns: {...} }).
Prisma: prisma.t.findMany({ select: {...} }), never a bare findMany() / findFirst() / findUnique().`,
  run: ({ ast }) => {
    const out: CheckResult[] = [];
    for (const c of appFiles(ast()).flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression))) {
      const e = c.getExpression();
      if (!Node.isPropertyAccessExpression(e)) continue;
      const op = e.getName();
      const recv = e.getExpression();
      const at = (pass: boolean, message: string) => out.push({ file: c.getSourceFile().getFilePath(), line: c.getStartLineNumber(), pass, message });
      if (SELECT.has(op) && DB.test(recv.getType().getText())) at(c.getArguments().length > 0, `db.${op}(${c.getArguments().length ? "{…}" : ""})${c.getArguments().length ? "" : ": select * — list the columns"}`);
      else if (FIND.test(op) && DB.test(rootType(recv))) {
        const arg = c.getArguments()[0];
        const ok = !!arg && Node.isObjectLiteralExpression(arg) && ["select", "columns"].some((k) => arg.getProperty(k));
        at(ok, `${recv.getText()}.${op}()${ok ? "" : ": no select/columns — list the columns"}`);
      }
    }
    if (!out.length) throw new NothingToCheck();
    return out;
  },
});

// Type of the leftmost receiver: prisma.user.findMany -> PrismaClient, db.query.users.findMany -> Database.
function rootType(n: Node): string {
  while (Node.isPropertyAccessExpression(n)) n = n.getExpression();
  return n.getType().getText();
}
