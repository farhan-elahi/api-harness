import { loadChecks } from "../../core/runner.ts";
import { defineTool } from "../../core/sdk.ts";

export default defineTool({
  name: "get_rule",
  jit: true,
  description: "Full text of one standards rule by name (names are in the rule index).",
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  run: async (input) => {
    const checks = await loadChecks();
    const c = checks.find((x) => x.name === input.name);
    if (!c) throw new Error(`unknown rule ${JSON.stringify(input.name)}. Known: ${checks.map((x) => x.name).join(", ")}`);
    return `${c.name}: ${c.rule ?? "(no rule text)"}`;
  },
});
