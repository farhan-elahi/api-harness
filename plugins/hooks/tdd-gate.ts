// Observed red: src/** can't be written until the harness has seen a test fail since the last all-green test run.
// Watches run_tests results. Each red (and each green, which resets) is appended to runs/<id>/tdd-red.jsonl.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allow, block, defineHook } from "../../core/sdk.ts";
import { isWrite } from "./_write.ts";

const LOG = "tdd-red.jsonl";
const isSource = (p: string) => /^src\/.+\.ts$/.test(p) && !/\.(test|d)\.ts$/.test(p);

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
    return block(`Write a failing test first. Next: create test/${String(task.resource ?? "feature")}.test.ts → run_tests → see it fail → then edit src/.`);
  },
  afterTool: ({ call, output, runDir }) => {
    if (call?.name !== "run_tests" || !output) return allow;
    const failures = output.split("\n").filter((l) => l.startsWith("FAIL "));
    const status = failures.length ? "red" : output.startsWith("pass") ? "green" : undefined; // UNPROVEN = neither
    if (status) appendFileSync(join(runDir, LOG), JSON.stringify({ status, at: new Date().toISOString(), files: call.input.files ?? "all", failures }) + "\n");
    return allow;
  },
});
