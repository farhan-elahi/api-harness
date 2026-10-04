import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { defineTool, inRoot, isSecretPath } from "../../core/sdk.ts";

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const MAX = 200;

export default defineTool({
  name: "list_files",
  description: "List files under dir (recursive).",
  input: { type: "object", properties: { dir: { type: "string" } } },
  run: (input, { root }) => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (out.length >= MAX || SKIP.has(e.name) || isSecretPath(relative(root, p))) continue;
        e.isDirectory() ? walk(p) : out.push(relative(root, p));
      }
    };
    walk(inRoot(root, input.dir ?? "."));
    return out.length ? out.join("\n") + (out.length >= MAX ? `\n…truncated at ${MAX}` : "") : "(empty)";
  },
});
