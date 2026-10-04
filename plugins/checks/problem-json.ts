// Every non-2xx is RFC 7807 application/problem+json with type, title, status, detail, instance.
import { Node, SyntaxKind, type CallExpression } from "ts-morph";
import { defineCheck, type CheckResult } from "../../core/sdk.ts";
import { appFiles, calleeName, fnBody, hono, num } from "./_hono.ts";

const FIELDS = ["type", "title", "status", "detail", "instance"];
const isCtx = (n: Node) => /\bContext</.test(n.getType().getText());

export default defineCheck({
  name: "problem-json",
  unit: "error paths",
  rule: `Every non-2xx response is RFC 7807 application/problem+json.
Use one problem() helper whose body has type, title, status, detail and instance.
app.onError() and app.notFound() must return problem(). Never send a status >= 400 with c.json()/c.text()/new Response(); throw or return problem() instead.`,
  run: ({ ast }) => {
    const files = appFiles(ast());
    const calls = files.flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression));
    const news = files.flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.NewExpression));
    const at = (n: Node, pass: boolean, message: string): CheckResult => ({ file: n.getSourceFile().getFilePath(), line: n.getStartLineNumber(), pass, message });
    const out: CheckResult[] = [];

    // The helper itself must emit the right media type and all five fields.
    const helper = files.flatMap((sf) => sf.getFunctions()).find((f) => f.getName() === "problem");
    if (!helper) out.push({ file: "src", line: 1, pass: false, message: "no problem() helper found" });
    else {
      const strings = helper.getDescendantsOfKind(SyntaxKind.StringLiteral).map((s) => s.getLiteralValue());
      const props = helper.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression).flatMap((o) => o.getProperties().map((x) => (x as { getName?(): string }).getName?.()));
      const missing = FIELDS.filter((f) => !props.includes(f));
      out.push(
        !strings.includes("application/problem+json")
          ? at(helper, false, "problem() does not set Content-Type: application/problem+json")
          : missing.length
            ? at(helper, false, `problem() body missing: ${missing.join(", ")}`)
            : at(helper, true, "problem() helper"),
      );
    }

    // onError and notFound must route through problem(); a missing hook is reported at the root app.
    const { mounts } = hono(ast());
    const rootApp = news.find(
      (n) => n.getExpression().getText() === "Hono" && !mounts.has(n.getParentIfKind(SyntaxKind.VariableDeclaration)?.compilerNode ?? n.compilerNode),
    );
    for (const hook of ["onError", "notFound"]) {
      const reg = calls.find((c) => calleeName(c) === hook && Node.isPropertyAccessExpression(c.getExpression()));
      const body = fnBody(reg?.getArguments()[0]);
      const ok = body?.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => calleeName(c) === "problem");
      const missing = `no app.${hook}() returning problem()`;
      out.push(reg ? at(reg, !!ok, ok ? `${hook} -> problem()` : `${hook} handler does not return problem()`) : rootApp ? at(rootApp, false, missing) : { file: "src", line: 1, pass: false, message: missing });
    }

    for (const c of calls) {
      const name = calleeName(c);
      if (name === "problem" && c.getExpression().getKind() === SyntaxKind.Identifier) out.push(at(c, true, "problem()"));
      const e = c.getExpression();
      if (!Node.isPropertyAccessExpression(e) || !isCtx(e.getExpression())) continue;
      if (["json", "text", "body", "html", "newResponse"].includes(name)) {
        const status = num(c.getArguments()[1]);
        if (status !== undefined && status >= 400) out.push(at(c, false, `${status} sent with c.${name}(); use problem()`));
        else if (name === "json" && hasErrorKey(c)) out.push(at(c, false, "{ error } body; use problem()"));
      }
    }
    for (const n of news) {
      const name = n.getExpression().getText();
      if (name === "ProblemError" || name === "HTTPException") out.push(at(n, true, `${name}`));
      if (name === "Response" && n.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getName() !== "problem") {
        const init = n.getArguments()[1];
        const status = init && Node.isObjectLiteralExpression(init) ? num(init.getProperty("status")?.getLastChild()) : undefined;
        if (status !== undefined && status >= 400) out.push(at(n, false, `${status} sent with new Response(); use problem()`));
      }
    }
    return out;
  },
});

function hasErrorKey(c: CallExpression): boolean {
  const arg = c.getArguments()[0];
  return !!arg && Node.isObjectLiteralExpression(arg) && !!arg.getProperty("error");
}
