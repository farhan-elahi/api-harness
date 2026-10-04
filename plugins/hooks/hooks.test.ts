// One allow + one block case per shipped hook, called directly with a hook context. Offline.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "../../scripts/fixture.ts";
import type { Hook, HookContext, ToolCall } from "../../core/sdk.ts";
import budgetGuard from "./budget-guard.ts";
import noDelete from "./no-delete.ts";
import pathGuard from "./path-guard.ts";
import stopGate from "./stop-gate.ts";
import postWriteFeedback from "./post-write-feedback.ts";
import tddGate from "./tdd-gate.ts";
import { loadTask } from "../../core/task.ts";

const T = 120_000;
const ctx = (root: string, extra: Partial<HookContext> = {}): HookContext => ({
  root, runDir: mkdtempSync(join(tmpdir(), "harness-run-")), task: {}, turn: 1, usage: { input: 0, output: 0 }, limits: {}, ...extra,
});
const write = (path: string, content = "x"): ToolCall => ({ id: "1", name: "write_file", input: { path, content } });
const before = (h: Hook, c: HookContext) => h.beforeTool!(c);

test("path-guard: allows a path inside root; blocks escapes, .env, keys, .git/", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-"));
  expect(before(pathGuard, ctx(root, { call: write("src/a.ts") }))).toEqual({ allow: true });
  expect(before(pathGuard, ctx(root, { call: write(".env.example") }))).toEqual({ allow: true });
  for (const p of ["../x.ts", "/etc/passwd", ".env", ".env.local", "id.pem", "a.key", ".git/config"])
    expect(before(pathGuard, ctx(root, { call: write(p) }))).toHaveProperty("block");
});

test("budget-guard: allows within budget; stops over turns or tokens", () => {
  const root = "/nowhere";
  expect(before(budgetGuard, ctx(root, { turn: 2, limits: { maxTurns: 3 } }))).toEqual({ allow: true });
  expect(before(budgetGuard, ctx(root, { turn: 3, limits: { maxTurns: 3 } }))).toHaveProperty("stop");
  expect(budgetGuard.beforeStop!(ctx(root, { turn: 4, limits: { maxTurns: 3 } }))).toHaveProperty("stop");
  expect(before(budgetGuard, ctx(root, { usage: { input: 900, output: 200 }, limits: { maxTokens: 1000 } }))).toEqual({ stop: "over budget: 1100 tokens > max 1000" });
});

test("no-delete: allows edits that keep the API; blocks emptying and (brownfield) dropping exports", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-"));
  writeFileSync(join(root, "r.ts"), `export const a = 1;\nexport function b() {}\napp.get("/items", h);\n`);
  const change = { task: { mode: "change" } };
  const kept = `export const a = 2;\nexport function b() {}\nexport const c = 3;\napp.get("/items", h);\n`;
  expect(before(noDelete, ctx(root, { ...change, call: write("r.ts", kept) }))).toEqual({ allow: true });
  expect(before(noDelete, ctx(root, { call: write("r.ts", "  \n") }))).toEqual({ block: "r.ts exists; emptying it is not allowed" });
  expect(before(noDelete, ctx(root, { call: { id: "1", name: "delete_file", input: { path: "r.ts" } } }))).toHaveProperty("block");
  expect(before(noDelete, ctx(root, { ...change, call: write("r.ts", `export const a = 1;\n`) }))).toEqual({
    block: "r.ts: existing API must keep working; removed export b",
  });
  expect(before(noDelete, ctx(root, { call: write("r.ts", `export const a = 1;\n`) }))).toEqual({ allow: true }); // greenfield
});

test("no-delete (brownfield): route removal is found through the Hono AST, incl. router mount prefixes", () => {
  const root = assemble("good-api");
  const file = "src/routes/notes.ts";
  const src = readFileSync(join(root, file), "utf8");
  const change = { task: { mode: "change" } };
  expect(before(noDelete, ctx(root, { ...change, call: write(file, src + "\n// touched\n") }))).toEqual({ allow: true });
  const noDeleteRoute = src.replace(/notesRouter\.delete\([\s\S]*?\n\}\);\n/, "");
  expect(noDeleteRoute).not.toBe(src);
  const r = before(noDelete, ctx(root, { ...change, call: write(file, noDeleteRoute) }));
  expect(r).toEqual({ block: `${file}: existing API must keep working; removed route DELETE /v1/notes/:id` });
}, T);

test("tdd-gate: blocks src writes until run_tests is observed red; a later green run resets it", () => {
  const c = ctx("/nowhere", { call: write("src/lib/slug.ts") });
  const tests = (output: string) => tddGate.afterTool!({ ...c, call: { id: "t", name: "run_tests", input: {} }, output });
  expect(before(tddGate, c)).toHaveProperty("block"); // nothing observed yet
  expect(before(tddGate, { ...c, call: write("test/slug.test.ts") })).toEqual({ allow: true }); // tests always writable

  tests("FAIL test/slug.test.ts > lowercases: Cannot find module");
  expect(before(tddGate, c)).toEqual({ allow: true });
  expect(before(tddGate, { ...c, call: write("src/app.ts") })).toEqual({ allow: true }); // any src while red

  tests("pass  3 tests");
  expect(before(tddGate, c)).toHaveProperty("block");
  tests("UNPROVEN no tests ran"); // neither red nor green
  expect(before(tddGate, c)).toHaveProperty("block");

  const log = readFileSync(join(c.runDir, "tdd-red.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.map((e) => e.status)).toEqual(["red", "green"]);
  expect(log[0].failures).toEqual(["FAIL test/slug.test.ts > lowercases: Cannot find module"]);
});

test("post-write-feedback: nothing extra for a clean file; only that file's tsc errors (max 10 lines)", () => {
  const root = assemble("good-api");
  const after = (path: string, body: string) => {
    writeFileSync(join(root, path), body);
    return postWriteFeedback.afterTool!(ctx(root, { call: write(path, body), output: "wrote" }));
  };
  expect(after("src/lib/ok.ts", "export const ok: number = 1;\n")).toEqual({ allow: true });
  after("src/lib/other.ts", "export const other: number = 'x';\n"); // error in another file
  const r = after("src/lib/bad.ts", Array.from({ length: 15 }, (_, i) => `export const v${i}: number = "s";`).join("\n"));
  const lines = (r as { note: string }).note.split("\n");
  expect(lines).toHaveLength(10);
  expect(lines[0]).toBe("tsc errors:");
  expect(lines[1]).toStartWith("src/lib/bad.ts:1:14 TS2322");
  expect(lines.at(-1)).toBe("…7 more");
  expect(lines.some((l) => l.includes("other.ts"))).toBe(false);
}, T);

test("tasks/notes.yaml is a real API task with tenancy on and no gate bypass", () => {
  const t = loadTask(join(import.meta.dir, "../../tasks/notes.yaml"));
  expect(t.fields).toMatchObject({ mode: "create", resource: "notes", tenancy: { column: "workspaceId" } });
  expect(t.text).not.toMatch(/skip|bypass|disable|gates?:/i);
});

test("stop-gate: allows finishing when tests + checks are green; otherwise sends back only failing lines", async () => {
  expect(await stopGate.beforeStop!(ctx(assemble("good-api")))).toEqual({ allow: true });
  const r = await stopGate.beforeStop!(ctx(assemble("bad-api")));
  const lines = (r as { block: string }).block.split("\n");
  expect(lines[0]).toStartWith("not done yet");
  const v = lines.indexOf("verdict 0%");
  expect(v).toBeGreaterThan(0);
  expect(lines.slice(1, v).every((l) => /\b(FAIL|UNPROVEN)\b/.test(l))).toBe(true);
  expect(lines.some((l) => l.startsWith("tenant-isolation"))).toBe(true);
}, T);

test("stop-gate: rule text only for the rules that failed", async () => {
  const r = await stopGate.beforeStop!(ctx(assemble("good-api"), { task: { tenancy: { column: "orgId" } } }));
  const text = (r as { block: string }).block;
  expect(text).toContain("rule tenant-isolation: Every DB query is scoped");
  expect(text.match(/^rule /gm)).toHaveLength(1);
  expect(text).not.toContain("rule auth:");
}, T);
