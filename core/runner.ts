// Deterministic standards run: every plugin in plugins/checks and plugins/validators, one line per rule, then a verdict.
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Project } from "ts-morph";
import { loadPlugins } from "./loader.ts";
import { NotApplicable, NothingToCheck, Unproven, type Check, type CheckContext, type CheckResult } from "./sdk.ts";

export type RuleReport = {
  name: string;
  unit: string;
  status: "pass" | "FAIL" | "UNPROVEN" | "n/a";
  passed: number;
  total: number;
  failures: CheckResult[];
  reason?: string;
};
export type Report = { dir: string; rules: RuleReport[]; verdict: number };

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const tsFiles = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    SKIP.has(e.name) ? [] : e.isDirectory() ? tsFiles(join(d, e.name)) : /(?<!\.d)\.ts$/.test(e.name) ? [join(d, e.name)] : [],
  );

export async function runChecks(apiDir: string, task: Record<string, unknown> = {}): Promise<Report> {
  const dir = resolve(apiDir);
  if (!existsSync(dir)) throw new Error(`no such directory: ${apiDir}`);
  let ast: Project | undefined;
  const ctx: CheckContext = {
    dir,
    task,
    files: tsFiles(dir),
    ast: () => {
      if (ast) return ast;
      const tsconfig = join(dir, "tsconfig.json");
      if (!existsSync(tsconfig)) throw new Unproven("no tsconfig.json");
      return (ast = new Project({ tsConfigFilePath: tsconfig }));
    },
  };
  const checks = [...(await loadPlugins<Check>("checks")), ...(await loadPlugins<Check>("validators"))];
  const rules: RuleReport[] = [];
  for (const check of checks) {
    const base = { name: check.name, unit: check.unit, passed: 0, total: 0, failures: [] };
    try {
      const results = (await check.run(ctx)).map((r) => ({ ...r, file: relative(dir, resolve(dir, r.file)) }));
      if (results.length === 0) throw new Unproven(`no ${check.unit} found to check`);
      const failures = results.filter((r) => !r.pass);
      rules.push({ ...base, status: failures.length ? "FAIL" : "pass", passed: results.length - failures.length, total: results.length, failures });
    } catch (e) {
      if (e instanceof NothingToCheck) rules.push({ ...base, status: "pass", reason: e.message });
      else if (e instanceof NotApplicable) rules.push({ ...base, status: "n/a", reason: e.message });
      else rules.push({ ...base, status: "UNPROVEN", reason: e instanceof Unproven ? e.message : `check crashed: ${(e as Error).message}` });
    }
  }
  const counted = rules.filter((r) => r.status !== "n/a");
  const verdict = counted.length ? Math.floor((100 * counted.filter((r) => r.status === "pass").length) / counted.length) : 0;
  return { dir, rules, verdict };
}

export function formatReport(r: Report): string {
  const w = Math.max(16, ...r.rules.map((x) => x.name.length + 2));
  const lines = r.rules.flatMap((x) =>
    x.status === "pass"
      ? [`${x.name.padEnd(w)}pass  ${x.passed}/${x.total} ${x.unit}${x.reason ? ` (${x.reason})` : ""}`]
      : x.status === "UNPROVEN" || x.status === "n/a"
        ? [`${x.name.padEnd(w)}${x.status}  ${x.reason}`]
        : x.failures.map((f) => `${x.name.padEnd(w)}FAIL  ${f.file}:${f.line} ${f.message}`),
  );
  return [...lines, `${"verdict".padEnd(w)}${r.verdict}%`].join("\n");
}
