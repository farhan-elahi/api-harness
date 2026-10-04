// Brownfield safety (task mode: change): run the target's tests before the first edit and save what passed.
// At stop, block if any test that passed before now fails or is gone.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTests } from "../../core/runner.ts";
import { allow, block, defineHook } from "../../core/sdk.ts";

const FILE = "tests-before.json";

export default defineHook({
  name: "test-baseline",
  beforeTool: ({ root, runDir, task }) => {
    if (task.mode === "change" && !existsSync(join(runDir, FILE))) writeFileSync(join(runDir, FILE), JSON.stringify(runTests(root).passed, null, 2));
    return allow;
  },
  beforeStop: ({ root, runDir, task }) => {
    if (task.mode !== "change" || !existsSync(join(runDir, FILE))) return allow;
    const before = JSON.parse(readFileSync(join(runDir, FILE), "utf8")) as string[];
    const now = new Set(runTests(root).passed);
    const lost = before.filter((t) => !now.has(t));
    return lost.length ? block(["Tests that passed before your change now fail or are gone. Existing behaviour must keep working:", ...lost.map((t) => `  ${t}`)].join("\n")) : allow;
  },
});
