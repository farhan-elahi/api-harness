// The agent can't finish until the project's tests pass and `harness check --api <root> --task <file>` is 100%.
// On block, only the failing lines go back to the model, plus the text of just the rules that failed.
import { formatReport, runChecks, runTests } from "../../core/runner.ts";
import { allow, block, defineHook } from "../../core/sdk.ts";

export default defineHook({
  name: "stop-gate",
  beforeStop: async ({ root, task }) => {
    const tests = runTests(root);
    const report = await runChecks(root, task);
    const red = formatReport(report).split("\n").filter((l) => /\b(FAIL|UNPROVEN)\b/.test(l));
    if (tests.ok && report.verdict === 100) return allow;
    const rules = report.rules.filter((r) => (r.status === "FAIL" || r.status === "UNPROVEN") && r.rule).map((r) => `rule ${r.name}: ${r.rule}`);
    return block(["Not done.", ...tests.failures, ...red, `verdict ${report.verdict}%`, ...rules, "Fix with edit_file, then run_tests."].join("\n"));
  },
});
