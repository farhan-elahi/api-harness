// Observed red: src/** can't be written until the harness has seen a test fail since the last all-green test run.
// Watches run_tests results. Each red (and each green, which resets) is appended to runs/<id>/tdd-red.jsonl.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allow, block, defineHook } from "../../core/sdk.ts";
import { isWrite } from "./_write.ts";

const LOG = "tdd-red.jsonl";
const isSource = (p: string) => /^src\/.+\.ts$/.test(p) && !/\.(test|d)\.ts$/.test(p);

// One observed test run -> the log (run_tests, or the auto-run after a src write in post-write-feedback).
export function record(runDir: string, failures: string[], ok: boolean, files: unknown = "all") {
  const fails = failures.filter((l) => l.startsWith("FAIL "));
  const status = fails.length ? "red" : ok ? "green" : undefined; // UNPROVEN = neither
  if (status) appendFileSync(join(runDir, LOG), JSON.stringify({ status, at: new Date().toISOString(), files, failures: fails }) + "\n");
}
export const observed = (runDir: string) => lastObserved(runDir) !== "none";

// Latest observation in this run: red | green | none.
function lastObserved(runDir: string): "red" | "green" | "none" {
  const f = join(runDir, LOG);
  const last = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").at(-1) : undefined;
  return last ? (JSON.parse(last).status as "red" | "green") : "none";
}

export default defineHook({
  name: "tdd-gate",
  beforeTool: ({ call, runDir, task }) => {
    const p = isWrite(call) ? String(call!.input.path).replace(/^\.\//, "") : "";
    if (!isSource(p) || lastObserved(runDir) === "red") return allow;
    return block(`Write a failing test first. Next: write test/${String(task.resource ?? "feature")}.test.ts copying test/_example.test.ts → run_tests → see it fail → then edit src/.`);
  },
  afterTool: ({ call, output, runDir }) => {
    if (call?.name !== "run_tests" || !output) return allow;
    record(runDir, output.split("\n"), output.startsWith("pass"), call.input.files ?? "all");
    return allow;
  },
});
