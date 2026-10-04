// Shared by hooks: what a file-writing tool call (write_file or edit_file) would leave on disk.
import { existsSync, readFileSync } from "node:fs";
import type { ToolCall } from "../../core/sdk.ts";
import { inRoot } from "../../core/sdk.ts";
import { applyEdit } from "../tools/edit_file.ts";

export const isWrite = (call: ToolCall | undefined) => !!call && typeof call.input.path === "string" && ("content" in call.input || "old" in call.input);

// New file text, or undefined if the call doesn't write (or the edit can't apply; the tool will report that).
export function nextContent(call: ToolCall | undefined, root: string): string | undefined {
  if (!call || !isWrite(call)) return undefined;
  if (typeof call.input.content === "string") return call.input.content;
  try {
    const abs = inRoot(root, call.input.path);
    return applyEdit(existsSync(abs) ? readFileSync(abs, "utf8") : "", call.input.old, call.input.new);
  } catch {
    return undefined;
  }
}
