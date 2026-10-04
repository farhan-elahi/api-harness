// Keeps the agent moving. Adds a deterministic "Next:" line to the state note (from disk + run state, never the
// model), and after READ_TURNS turns in a row with no write_file/edit_file/run_tests it blocks further reads with it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatReport, runChecks, runTests } from "../../core/runner.ts";
import { allow, block, defineHook, type Measured } from "../../core/sdk.ts";
import { observed } from "./tdd-gate.ts";

const READ_TURNS = 5;
const PROGRESS = new Set(["write_file", "edit_file", "run_tests"]);
const isRead = (name: string) => name === "read_file" || name === "list_files" || name.startsWith("get_");

// Per run (keyed by runDir): last turn that made progress.
const runs = new Map<string, { progress: number }>();
const of = (runDir: string) => runs.get(runDir) ?? runs.set(runDir, { progress: 0 }).get(runDir)!;

// The Next ladder, from fresh state (disk, the observed-run log, measured tests/checks). First failure only.
export function nextStep(root: string, task: Record<string, unknown>, ran: boolean, m: Measured): string {
  const r = String(task.resource ?? "feature");
  const test = `test/${r}.test.ts`;
  if (!existsSync(join(root, test))) return `Next: write ${test} copying test/_example.test.ts`;
  if (!ran) return "Next: run_tests";
  if (!m.testsOk) {
    const route = `src/routes/${r}.ts`;
    if (!existsSync(join(root, route))) return `Next: write ${route} copying src/routes/_example.ts, add table to schema.ts + migrations.ts, mount in app.ts`;
    const f = (m.testFailures[0] ?? "").match(/^FAIL (\S+?)(?: > (.*?))?: (.*?)(?: \((\S+:\d+)\))?$/);
    return f ? `Next: fix ${f[2] ?? f[1]}: ${f[3]} (${f[4] ?? f[1]})` : `Next: fix ${m.testFailures[0] ?? "the failing tests"}`;
  }
  if (m.verdict < 100) {
    const c = (m.failingChecks[0] ?? "").trim().match(/^(\S+)\s+(?:FAIL|UNPROVEN)\s+(\S+:\d+)/);
    return c ? `Next: fix ${c[1]} at ${c[2]}` : `Next: fix ${m.failingChecks[0]?.trim() ?? `checks at ${m.verdict}%`}`;
  }
  return "Next: all green, reply done";
}

const measure = async (root: string, task: Record<string, unknown>): Promise<Measured> => {
  const t = runTests(root);
  const r = await runChecks(root, task);
  return { testsOk: t.ok, testFailures: t.failures, verdict: r.verdict, failingChecks: formatReport(r).split("\n").filter((l) => /\b(FAIL|UNPROVEN)\b/.test(l)) };
};

export default defineHook({
  name: "read-loop-guard",
  state: ({ root, runDir, task, measured }) => nextStep(root, task, observed(runDir), measured),
  beforeTool: async ({ call, root, runDir, task, turn }) => {
    const s = of(runDir);
    if (!call || !isRead(call.name) || turn - s.progress <= READ_TURNS) return allow;
    return block(`Stop reading. You already read these files. ${nextStep(root, task, observed(runDir), await measure(root, task))}`);
  },
  afterTool: ({ call, output, runDir, turn }) => {
    if (!call || !PROGRESS.has(call.name)) return allow;
    const s = of(runDir);
    s.progress = turn;
    return allow;
  },
});
