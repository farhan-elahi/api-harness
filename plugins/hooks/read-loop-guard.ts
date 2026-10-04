// Keeps the agent moving. Adds a deterministic "Next:" line to the state note (from disk + run state, never the
// model), and after READ_TURNS turns in a row with no write_file/edit_file/run_tests it blocks further reads with it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatReport, runChecks, runTests } from "../../core/runner.ts";
import { allow, block, defineHook, type Measured } from "../../core/sdk.ts";

const READ_TURNS = 5;
const PROGRESS = new Set(["write_file", "edit_file", "run_tests"]);
const isRead = (name: string) => name === "read_file" || name === "list_files" || name.startsWith("get_");

// Per run (keyed by runDir): last turn that made progress, and whether a failing test has been seen.
const runs = new Map<string, { progress: number; red: boolean }>();
const of = (runDir: string) => runs.get(runDir) ?? runs.set(runDir, { progress: 0, red: false }).get(runDir)!;

export function nextStep(root: string, task: Record<string, unknown>, red: boolean, m: Measured): string {
  const r = String(task.resource ?? "feature");
  const test = `test/${r}.test.ts`;
  if (!existsSync(join(root, test))) return `Next: write ${test}`;
  if (!red) return "Next: run_tests";
  if (!m.testsOk) {
    const example = existsSync(join(root, "src/routes/_example.ts")) ? " by copying the pattern in src/routes/_example.ts (schema + table + routes)" : "";
    const failing = m.testFailures.slice(0, 3).map((f) => f.replace(/^FAIL\s+/, "").trim()).join("; ");
    return `Next: write src/routes/${r}.ts${example}, add the table to src/db/schema.ts and its CREATE TABLE to src/db/migrations.ts, mount it in src/app.ts. Then run_tests.${failing ? ` Failing: ${failing}` : ""}`;
  }
  if (m.verdict < 100) return `Next: fix ${m.failingChecks[0]?.trim() ?? `checks at ${m.verdict}%`}`;
  return "Next: reply with a one-line summary to finish";
}

const measure = async (root: string, task: Record<string, unknown>): Promise<Measured> => {
  const t = runTests(root);
  const r = await runChecks(root, task);
  return { testsOk: t.ok, testFailures: t.failures, verdict: r.verdict, failingChecks: formatReport(r).split("\n").filter((l) => /\b(FAIL|UNPROVEN)\b/.test(l)) };
};

export default defineHook({
  name: "read-loop-guard",
  state: ({ root, runDir, task, measured }) => nextStep(root, task, of(runDir).red, measured),
  beforeTool: async ({ call, root, runDir, task, turn }) => {
    const s = of(runDir);
    if (!call || !isRead(call.name) || turn - s.progress <= READ_TURNS) return allow;
    return block(`Stop reading. You already read these files. ${nextStep(root, task, s.red, await measure(root, task))}`);
  },
  afterTool: ({ call, output, runDir, turn }) => {
    if (!call || !PROGRESS.has(call.name)) return allow;
    const s = of(runDir);
    s.progress = turn;
    if (call.name === "run_tests" && output?.split("\n").some((l) => l.startsWith("FAIL "))) s.red = true;
    return allow;
  },
});
