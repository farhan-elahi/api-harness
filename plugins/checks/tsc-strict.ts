// Real `tsc --noEmit` under strict + noUncheckedIndexedAccess, plus bans: any, non-null !, @ts-ignore/@ts-expect-error/@ts-nocheck.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SyntaxKind, ts } from "ts-morph";
import { defineCheck, Unproven, type CheckResult } from "../../core/sdk.ts";

const HARNESS_TSC = resolve(import.meta.dir, "../../node_modules/.bin/tsc");
// Directive = a comment token whose text *starts* with @ts-… (the compiler's rule), not any mention of it.
const DIRECTIVE = /^\/(?:\/|\*+)\s*@ts-(ignore|expect-error|nocheck)\b/;

function suppressions(text: string): { line: number; message: string }[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const out: { line: number; message: string }[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k !== ts.SyntaxKind.SingleLineCommentTrivia && k !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const m = scanner.getTokenText().match(DIRECTIVE);
    if (m) out.push({ line: text.slice(0, scanner.getTokenStart()).split("\n").length, message: `@ts-${m[1]} suppression` });
  }
  return out;
}

export default defineCheck({
  name: "tsc-strict",
  unit: "files",
  rule: `TypeScript is clean under strict: \`tsc --noEmit\` passes with strict and noUncheckedIndexedAccess.
No \`any\`, no non-null assertions (\`!\`), no @ts-ignore / @ts-expect-error / @ts-nocheck.`,
  run: ({ dir, files, ast }) => {
    const p = ast();
    const opts = p.getCompilerOptions();
    const out: CheckResult[] = [];
    const missing = (["strict", "noUncheckedIndexedAccess"] as const).filter((k) => opts[k] !== true);
    out.push({ file: "tsconfig.json", line: 1, pass: !missing.length, message: missing.length ? `tsconfig missing: ${missing.join(", ")}` : "tsconfig strict" });

    const tsc = [join(dir, "node_modules/.bin/tsc"), HARNESS_TSC].find(existsSync);
    if (!tsc) throw new Unproven("tsc not found");
    const run = spawnSync(tsc, ["--noEmit", "-p", "."], { cwd: dir, encoding: "utf8" });
    if (run.error) throw new Unproven(`tsc failed to start: ${run.error.message}`);
    const errors = (run.stdout + run.stderr).split("\n").flatMap((l) => {
      const m = l.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/);
      return m ? [{ file: m[1]!, line: Number(m[2]), pass: false, message: `${m[3]} ${m[4]}` }] : [];
    });
    if (run.status !== 0 && !errors.length) out.push({ file: "tsconfig.json", line: 1, pass: false, message: `tsc exited ${run.status}: ${(run.stdout + run.stderr).trim().split("\n")[0]}` });
    out.push(...errors);

    for (const f of files) {
      const sf = p.getSourceFile(f) ?? p.addSourceFileAtPath(f);
      const bad: CheckResult[] = [
        ...sf.getDescendantsOfKind(SyntaxKind.AnyKeyword).map((n) => ({ line: n.getStartLineNumber(), message: "`any` type" })),
        ...sf.getDescendantsOfKind(SyntaxKind.NonNullExpression).map((n) => ({ line: n.getStartLineNumber(), message: "non-null assertion `!`" })),
        ...suppressions(sf.getFullText()),
      ].map((b) => ({ file: f, pass: false, ...b }));
      const tscHit = errors.some((e) => resolve(dir, e.file) === f);
      out.push(...(bad.length ? bad : tscHit ? [] : [{ file: f, line: 1, pass: true, message: "clean" }]));
    }
    return out;
  },
});
