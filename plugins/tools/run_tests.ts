import { runTests } from "../../core/runner.ts";
import { defineTool, inRoot } from "../../core/sdk.ts";

export default defineTool({
  name: "run_tests",
  description: "Run tests (all, or the given files).",
  input: { type: "object", properties: { files: { type: "array", items: { type: "string" } } } },
  run: (input, { root }) => {
    const files = Array.isArray(input.files) ? input.files.map((f) => (inRoot(root, f), String(f))) : [];
    const r = runTests(root, files);
    return r.ok ? `pass  ${r.total} tests` : r.failures.slice(0, 30).join("\n");
  },
});
