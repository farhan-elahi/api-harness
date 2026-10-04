// What the model sees each turn. Mode decides how lean it is (definitions in docs/design.md).
// actual:   rule index + project map in the system prompt; last WINDOW turns verbatim, older turns dropped whole
//           and replaced by a harness-built state note (from disk + harness-run tests/checks, never the model).
// baseline: full rule texts in the system prompt; full current project source re-injected every turn
//           (replacing the previous snapshot); whole history kept.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { formatReport, runChecks, runTests } from "./runner.ts";
import { isSecretPath, type Check, type Measured, type Message } from "./sdk.ts";

export type Mode = "actual" | "baseline";
export const WINDOW = 3; // most recent turns (assistant message + what answered it) kept verbatim
const NOTE_CHARS = 1200; // ~300 tokens
const MAP_CHARS = 2400; // ~600 tokens
const tokens = (s: string) => Math.ceil(s.length / 4); // NOTE: estimate; providers count their own

const BASE =
  "You are a coding agent in one project directory; paths are relative to its root. Read only what you need. " +
  "When the task is complete, reply with a one-line summary and no tool calls.";

const firstLine = (c: Check) => (c.rule ?? c.unit).split("\n")[0];

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|sql)$/;
const LOCK = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

// Project source files (relative paths), sorted. Skips deps, build output, lockfiles and secrets.
export function sourceFiles(root: string): string[] {
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
      else if (SOURCE.test(e.name) && !LOCK.test(rel)) files.push(rel);
    }
  };
  walk(root);
  return files;
}

// Baseline: every project source file, in full.
export function projectDump(root: string): string {
  const files = sourceFiles(root).map((f) => `=== ${f} ===\n${readFileSync(join(root, f), "utf8")}`);
  return files.length ? `\n\nProject files (current):\n\n${files.join("\n\n")}` : "";
}

// One export line -> its signature: no `export`, no body.
const sig = (l: string) =>
  l
    .replace(/^export /, "")
    .replace(/^(type \w+) = .*/, "$1")
    .replace(/\s*\{\s*$/, "")
    .replace(/(\)(?::[^=]+?)?)\s*=>.*$/, "$1")
    .replace(/\s*=\s*(z\.object\(|$)/, "")
    .replace(/;$/, "")
    .trim();

// Actual: file list of the project + exported signatures of the template's helpers, generated from the code.
export function projectMap(root: string, libDir = resolve("template/src/lib")): string {
  const sigs = sourceFiles(libDir).map((f) => {
    const exported = readFileSync(join(libDir, f), "utf8").split("\n").filter((l) => l.startsWith("export "));
    return `  ${f.replace(/\.ts$/, "")}: ${exported.map(sig).join("; ")}`;
  });
  const files = sourceFiles(root).filter((f) => !f.startsWith("src/lib/"));
  const map = `Project files: ${files.join(", ")}\nsrc/lib helpers (import, don't rewrite):\n${sigs.join("\n")}`;
  return map.length > MAP_CHARS ? map.slice(0, MAP_CHARS - 1) + "…" : map;
}

// actual: one line per rule (get_rule for the rest) + project map. baseline: every rule's full text.
export function systemPrompt(mode: Mode, checks: Check[], root?: string): string {
  const map = mode === "actual" && root ? `\n\n${projectMap(root)}` : "";
  if (!checks.length) return BASE + map;
  if (mode === "baseline") return `${BASE}\n\nStandards (all must pass):\n${checks.map((c) => `## ${c.name}\n${c.rule ?? c.unit}`).join("\n\n")}`;
  return `${BASE}\n\nStandards (harness-checked; get_rule for details):\n${checks.map((c) => `- ${c.name}: ${firstLine(c)}`).join("\n")}${map}`;
}

export const fixedCost = (system: string, tools: object[]) => ({ system: tokens(system), tools: tokens(JSON.stringify(tools)), total: tokens(system) + tokens(JSON.stringify(tools)) });

export function openingMessage(taskPath: string, taskText: string): string {
  return `Task file ${taskPath}:\n\n${taskText}`;
}

// file -> mtime. Compared against a snapshot, not the wall clock (fs timestamps can lag Date.now()).
export const mtimes = (root: string) => new Map(sourceFiles(root).map((f) => [f, statSync(join(root, f)).mtimeMs]));
// Files new or modified since the snapshot.
export const changedSince = (root: string, before: Map<string, number>) =>
  [...mtimes(root)].filter(([f, t]) => before.get(f) !== t).map(([f]) => f);

// The harness's own account of where things stand: changed files, a fresh test run, a fresh check run.
export async function stateNote(root: string, taskFields: Record<string, unknown>, changed: string[]): Promise<{ text: string; measured: Measured }> {
  const t = runTests(root);
  const fails = t.failures.filter((l) => l.startsWith("FAIL "));
  const report = await runChecks(root, taskFields);
  const red = formatReport(report).split("\n").filter((l) => /\b(FAIL|UNPROVEN)\b/.test(l));
  const measured = { testsOk: t.ok, testFailures: t.failures, verdict: report.verdict, failingChecks: red };
  const note = [
    "State (written by the harness from disk; earlier turns were dropped):",
    `files changed: ${changed.join(", ") || "none"}`,
    `tests: ${t.ok ? `${t.total} pass` : `${t.total - fails.length} pass, ${fails.length} fail`}`,
    ...t.failures.map((l) => `  ${l}`),
    `checks: verdict ${report.verdict}%`,
    ...red.map((l) => `  ${l}`),
  ].join("\n");
  return { text: note.length > NOTE_CHARS ? note.slice(0, NOTE_CHARS - 1) + "…" : note, measured };
}

// Indices where turns start (each assistant message). Turn = assistant message + the tool/user messages after it.
const turnStarts = (messages: Message[]) => messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));

// What gets sent. messages[0] is the opening; the rest is history. Kept messages are the same objects (raw untouched).
export function view(mode: Mode, messages: Message[], extra: string, keep = WINDOW): Message[] {
  const opening = messages[0] as Extract<Message, { role: "user" }>;
  const history = messages.slice(1);
  const starts = turnStarts(history);
  const kept = mode === "actual" && starts.length > keep ? history.slice(starts[starts.length - keep]) : history;
  return [{ role: "user", text: extra ? `${opening.text}\n\n${extra}` : opening.text }, ...kept];
}

export const dropsTurns = (mode: Mode, messages: Message[], keep = WINDOW) => mode === "actual" && turnStarts(messages).length > keep;
