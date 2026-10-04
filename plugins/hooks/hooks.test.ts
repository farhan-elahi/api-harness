// One allow + one block case per shipped hook, called directly with a hook context. Offline.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "../../scripts/fixture.ts";
import type { Hook, HookContext, ToolCall } from "../../core/sdk.ts";
import budgetGuard from "./budget-guard.ts";
import noDelete from "./no-delete.ts";
import pathGuard from "./path-guard.ts";
import stopGate from "./stop-gate.ts";
import tddGate from "./tdd-gate.ts";

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

test("no-delete: allows edits that keep the API; blocks emptying and (brownfield) dropping exports/routes", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-"));
  writeFileSync(join(root, "r.ts"), `export const a = 1;\nexport function b() {}\napp.get("/items", h);\n`);
  const change = { task: { mode: "change" } };
  const kept = `export const a = 2;\nexport function b() {}\nexport const c = 3;\napp.get("/items", h);\n`;
  expect(before(noDelete, ctx(root, { ...change, call: write("r.ts", kept) }))).toEqual({ allow: true });
  expect(before(noDelete, ctx(root, { call: write("r.ts", "  \n") }))).toEqual({ block: "r.ts exists; emptying it is not allowed" });
  expect(before(noDelete, ctx(root, { call: { id: "1", name: "delete_file", input: { path: "r.ts" } } }))).toHaveProperty("block");
  expect(before(noDelete, ctx(root, { ...change, call: write("r.ts", `export const a = 1;\n`) }))).toEqual({
    block: "r.ts: existing API must keep working; removed export b, route GET /items",
  });
  expect(before(noDelete, ctx(root, { call: write("r.ts", `export const a = 1;\n`) }))).toEqual({ allow: true }); // greenfield
});

test("tdd-gate: blocks source without a failing test; allows it after the harness observes red and records it", () => {
  const root = assemble("good-api");
  const c = ctx(root, { call: write("src/lib/slug.ts", "export const slug = (s: string) => s.toLowerCase();\n") });
  expect(before(tddGate, c)).toEqual({ block: "write test/slug.test.ts first: a failing test must exist before src/lib/slug.ts" });

  writeFileSync(join(root, "test/slug.test.ts"), `import { expect, it } from "vitest";\nimport { slug } from "../src/lib/slug.ts";\nit("lowercases", () => expect(slug("AB")).toBe("ab"));\n`);
  expect(before(tddGate, c)).toEqual({ allow: true });
  const red = JSON.parse(readFileSync(join(c.runDir, "tdd-red.jsonl"), "utf8").trim());
  expect(red).toMatchObject({ source: "src/lib/slug.ts", test: "test/slug.test.ts" });
  expect(red.failures[0]).toContain("FAIL test/slug.test.ts");

  writeFileSync(join(root, "src/lib/slug.ts"), c.call!.input.content as string);
  const fresh = ctx(root, { call: c.call }); // new run, test now green: not a red observation
  expect(before(tddGate, fresh)).toHaveProperty("block");
  expect(existsSync(join(fresh.runDir, "tdd-red.jsonl"))).toBe(false);
}, T);

test("stop-gate: allows finishing when tests + checks are green; otherwise sends back only failing lines", async () => {
  expect(await stopGate.beforeStop!(ctx(assemble("good-api")))).toEqual({ allow: true });
  const r = await stopGate.beforeStop!(ctx(assemble("bad-api")));
  const lines = (r as { block: string }).block.split("\n");
  expect(lines[0]).toStartWith("not done yet");
  expect(lines.at(-1)).toBe("verdict 0%");
  expect(lines.slice(1, -1).every((l) => /\b(FAIL|UNPROVEN)\b/.test(l))).toBe(true);
  expect(lines.some((l) => l.startsWith("tenant-isolation"))).toBe(true);
}, T);
