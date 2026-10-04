// Deterministic standards run: every plugin in plugins/checks and plugins/validators, one line per rule, then a verdict.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
  rule?: string;
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
  const checks = await loadChecks();
  const rules: RuleReport[] = [];
  for (const check of checks) {
    const base = { name: check.name, unit: check.unit, rule: check.rule, passed: 0, total: 0, failures: [] };
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

export const loadChecks = async () => [...(await loadPlugins<Check>("checks")), ...(await loadPlugins<Check>("validators"))];

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

// Runs the API's own Vitest suite (optionally just some files). Short result: one line per failure.
export type TestRun = { ok: boolean; total: number; failed: string[]; failures: string[] };
export function runTests(apiDir: string, files: string[] = []): TestRun {
  const dir = existsSync(apiDir) ? realpathSync(apiDir) : resolve(apiDir); // vitest reports real paths (/var -> /private/var)
  const vitest = join(dir, "node_modules/.bin/vitest");
  if (!existsSync(vitest)) return { ok: false, total: 0, failed: [], failures: ["UNPROVEN no vitest in node_modules/.bin"] };
  const out = join(mkdtempSync(join(tmpdir(), "harness-vitest-")), "r.json");
  const run = spawnSync(vitest, ["run", "--reporter=json", `--outputFile=${out}`, ...files], { cwd: dir, encoding: "utf8", timeout: 300_000 });
  if (!existsSync(out)) return { ok: false, total: 0, failed: [], failures: [`UNPROVEN vitest did not report: ${(run.stderr || run.stdout).trim().split("\n")[0]}`] };
  type R = { numTotalTests: number; testResults: { name: string; status: string; message: string; assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[] };
  const r = JSON.parse(readFileSync(out, "utf8")) as R;
  const first = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n")[0];
  const failed = r.testResults.filter((t) => t.status === "failed").map((t) => relative(dir, t.name));
  const failures = r.testResults.flatMap((t) => {
    const file = relative(dir, t.name);
    const asserts = t.assertionResults.filter((a) => a.status === "failed").map((a) => `FAIL ${file} > ${a.fullName}: ${first(a.failureMessages[0])}`);
    return asserts.length ? asserts : t.status === "failed" ? [`FAIL ${file}: ${first(t.message)}`] : [];
  });
  if (r.numTotalTests === 0 && !failures.length) failures.push("UNPROVEN no tests ran");
  return { ok: failures.length === 0, total: r.numTotalTests, failed, failures };
}
