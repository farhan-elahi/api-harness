import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { defineTool, inRoot } from "../../core/sdk.ts";

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const MAX = 200;

export default defineTool({
  name: "list_files",
  description: "List files under a directory (recursive, relative paths). Skips node_modules/.git.",
  input: { type: "object", properties: { dir: { type: "string", description: "default: ." } } },
  run: (input, { root }) => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (out.length >= MAX || SKIP.has(e.name)) continue;
        const p = join(d, e.name);
        e.isDirectory() ? walk(p) : out.push(relative(root, p));
      }
    };
    walk(inRoot(root, input.dir ?? "."));
    return out.length ? out.join("\n") + (out.length >= MAX ? `\n…truncated at ${MAX}` : "") : "(empty)";
  },
});
