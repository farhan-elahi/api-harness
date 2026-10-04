// Lint rule: no console.log / console.debug left in src/ (debug leftovers can leak request data into logs).
import { Node, SyntaxKind } from "ts-morph";
import { defineCheck, NothingToCheck, type CheckResult } from "../../core/sdk.ts";
import { appFiles } from "./_hono.ts";

export default defineCheck({
  name: "no-console-log",
  unit: "files",
  rule: `No console.log/debug in src/.
Remove it, or use console.info/console.error deliberately.`,
  run: ({ ast, dir }) => {
    const files = appFiles(ast()).filter((sf) => sf.getFilePath().startsWith(`${dir}/src/`));
    if (!files.length) throw new NothingToCheck();
    return files.flatMap((sf): CheckResult[] => {
      const bad = sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).filter((e) => /^console\.(log|debug)$/.test(e.getText()) && Node.isCallExpression(e.getParent()));
      return bad.length
        ? bad.map((e) => ({ file: sf.getFilePath(), line: e.getStartLineNumber(), pass: false, message: `${e.getText()}() left in source` }))
        : [{ file: sf.getFilePath(), line: 1, pass: true, message: "clean" }];
    });
  },
});
