import { readFileSync, writeFileSync } from "node:fs";
import { defineTool, inRoot } from "../../core/sdk.ts";

// The file text after replacing `old` with `new`; throws unless `old` occurs exactly once. Hooks use it too.
export function applyEdit(text: string, oldText: unknown, newText: unknown): string {
  if (typeof oldText !== "string" || typeof newText !== "string" || !oldText) throw new Error("old and new must be strings, old non-empty");
  const n = text.split(oldText).length - 1;
  if (n !== 1) throw new Error(`old text found ${n} times; it must match exactly once (copy it exactly, add surrounding lines)`);
  return text.replace(oldText, () => newText);
}

export default defineTool({
  name: "edit_file",
  description: "Replace one exact snippet (must match once). Prefer over write_file for changes.",
  input: {
    type: "object",
    properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
    required: ["path", "old", "new"],
  },
  run: (input, { root }) => {
    const abs = inRoot(root, input.path);
    writeFileSync(abs, applyEdit(readFileSync(abs, "utf8"), input.old, input.new));
    return `edited ${input.path}`;
  },
});
