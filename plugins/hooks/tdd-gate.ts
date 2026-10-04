// Observed red: src/**/<name>.ts can't be written until test/<name>.test.ts exists and the harness ran it and saw it fail.
// The red run is recorded in runs/<id>/tdd-red.jsonl; later writes to the same source pass.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runTests } from "../../core/runner.ts";
import { allow, block, defineHook } from "../../core/sdk.ts";

const SOURCE = /^src\/(.+\/)?([^/]+)\.ts$/;

export default defineHook({
  name: "tdd-gate",
  beforeTool: ({ call, root, runDir }) => {
    const p = typeof call?.input.path === "string" && "content" in call.input ? call.input.path.replace(/^\.\//, "") : "";
    const m = p.match(SOURCE);
    if (!m || p.endsWith(".test.ts") || p.endsWith(".d.ts")) return allow;
    const log = join(runDir, "tdd-red.jsonl");
    if (existsSync(log) && readFileSync(log, "utf8").split("\n").some((l) => l && JSON.parse(l).source === p)) return allow;

    const test = `test/${basename(m[2]!)}.test.ts`;
    if (!existsSync(join(root, test))) return block(`write ${test} first: a failing test must exist before ${p}`);
    const r = runTests(root, [test]);
    if (r.ok) return block(`${test} already passes, so it does not prove ${p}'s change. Make it fail first.`);
    if (!r.failed.includes(test)) return block(`could not observe ${test} failing: ${r.failures.join("; ")}`);
    appendFileSync(log, JSON.stringify({ source: p, test, at: new Date().toISOString(), failures: r.failures }) + "\n");
    return allow;
  },
});
