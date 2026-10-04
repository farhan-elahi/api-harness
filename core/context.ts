// What the model sees: system prompt, opening message, and history compaction. Mode decides how lean it is.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isSecretPath, type Check, type Message, type ToolCall } from "./sdk.ts";

export type Mode = "actual" | "baseline";
export const KEEP_FULL = 2; // most recent tool results kept verbatim

const BASE =
  "You are a coding agent working inside one project directory. Use the tools to inspect and write files. " +
  "Read only what you need. Paths are relative to the project root. When the task is complete, reply with a one-line summary and no tool calls.";

const firstLine = (c: Check) => (c.rule ?? c.unit).split("\n")[0];

// actual: one line per rule (get_rule for the rest). baseline: every rule's full text.
export function systemPrompt(mode: Mode, checks: Check[]): string {
  if (!checks.length) return BASE;
  if (mode === "baseline") return `${BASE}\n\nStandards (all must pass):\n${checks.map((c) => `## ${c.name}\n${c.rule ?? c.unit}`).join("\n\n")}`;
  return `${BASE}\n\nStandards (checked by the harness; get_rule <name> for details):\n${checks.map((c) => `- ${c.name}: ${firstLine(c)}`).join("\n")}`;
}

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|sql)$/;
const LOCK = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

// Baseline only: every project source file, in full, like a naive agent that front-loads the repo.
export function projectDump(root: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      const rel = relative(root, p);
      if (SKIP.has(e.name) || isSecretPath(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (SOURCE.test(e.name) && !LOCK.test(rel)) files.push(`=== ${rel} ===\n${readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return files.length ? `\n\nProject files:\n\n${files.join("\n\n")}` : "";
}

export function openingMessage(mode: Mode, taskPath: string, taskText: string, root: string): string {
  return `Task file ${taskPath}:\n\n${taskText}${mode === "baseline" ? projectDump(root) : ""}`;
}

const COMPACTED = /^\[.*, compacted\]$/;
const subject = (c: ToolCall | undefined) => {
  const v = c && ["path", "route", "table", "name", "dir"].map((k) => c.input[k]).find((x) => typeof x === "string");
  return typeof v === "string" ? ` ${v}` : "";
};

// Replace all but the last KEEP_FULL tool results with a one-line summary. Only tool messages are replaced
// (with new objects); assistant messages, and the driver's raw inside them, are never touched.
export function compact(messages: Message[], keep = KEEP_FULL): void {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.toolCalls) calls.set(c.id, c);
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    const results = [...m.results].reverse().map((r) => {
      if (seen++ < keep || COMPACTED.test(r.output) || !r.output.includes("\n")) return r;
      const c = calls.get(r.id);
      return { ...r, output: `[${c?.name ?? "tool"}${subject(c)}: ${r.output.split("\n").length} lines, compacted]` };
    });
    messages[i] = { role: "tool", results: results.reverse() };
  }
}
