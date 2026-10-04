// Token report, baseline vs actual, and the history window, all offline with the scripted driver.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scripted } from "../drivers/fake.ts";
import { assemble } from "../scripts/fixture.ts";
import { changedSince, mtimes, dropsTurns, stateNote, view } from "./context.ts";
import { runTests } from "./runner.ts";
import { run, runWithBaseline } from "./loop.ts";
import type { Message } from "./sdk.ts";
import type { TokenReport } from "./tokens.ts";

const T = 120_000;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const taskFile = () => {
  const f = join(tmp("harness-task-"), "notes.yaml");
  writeFileSync(f, "mode: change\nchange: read the routes\n");
  return f;
};
const read = (path: string, id: string) => ({ id, name: "read_file", input: { path } });
const SCRIPT = [
  { text: "", toolCalls: [read("src/routes/notes.ts", "1")], raw: { blocks: ["thinking", "sig-1"] } },
  { text: "", toolCalls: [read("src/db/schema.ts", "2")], raw: { blocks: ["thinking", "sig-2"] } },
  { text: "", toolCalls: [read("src/app.ts", "3")], raw: { blocks: ["thinking", "sig-3"] } },
  { text: "", toolCalls: [read("src/lib/auth.ts", "4")], raw: { blocks: ["thinking", "sig-4"] } },
  { text: "done", toolCalls: [], raw: { blocks: ["sig-5"] } },
];

test("history window: last 3 turns verbatim (same objects, raw untouched); older turns dropped as whole pairs", () => {
  const raw = { opaque: true };
  const msgs: Message[] = [
    { role: "user", text: "go" },
    ...[1, 2, 3, 4, 5].flatMap((i): Message[] => [
      { role: "assistant", text: `t${i}`, toolCalls: [read(`f${i}`, `${i}`)], raw },
      { role: "tool", results: [{ id: `${i}`, output: "a\nb\nc" }] },
    ]),
    { role: "user", text: "blocked by stop-gate" },
  ];
  const v = view("actual", msgs, "STATE");
  expect(v[0]).toEqual({ role: "user", text: "go\n\nSTATE" });
  expect(v.slice(1)).toEqual(msgs.slice(5)); // t3..t5 + their answers
  for (let i = 1; i < v.length; i++) expect(v[i]).toBe(msgs[i + 4]!); // same objects: never edited
  expect(v[1]!.role).toBe("assistant"); // no orphan tool result
  const ids = new Set(v.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => c.id) : [])));
  for (const m of v) if (m.role === "tool") for (const r of m.results) expect(ids.has(r.id)).toBe(true);
  expect(view("baseline", msgs, "DUMP").slice(1)).toEqual(msgs.slice(1)); // baseline keeps everything
  expect(dropsTurns("actual", msgs.slice(0, 7))).toBe(false);
});

test("state note is built from disk: changed files, a fresh test run, a fresh check run", async () => {
  const root = assemble("good-api");
  const since = mtimes(root);
  writeFileSync(join(root, "src/extra.ts"), "export const x = 1;\n");
  const changed = changedSince(root, since);
  expect(changed).toEqual(["src/extra.ts"]);
  const note = await stateNote(root, {}, changed);
  const t = runTests(root);
  expect(note).toContain("files changed: src/extra.ts");
  expect(note).toContain(`tests: ${t.total} pass`);
  expect(note).toContain("checks: verdict 100%");
  expect(note.length).toBeLessThanOrEqual(1200);
}, T);

test("run: the model sees the window + the harness state note once turns are dropped", async () => {
  const d = scripted(SCRIPT);
  const r = await run({ task: taskFile(), driver: d, repo: assemble("good-api"), hooks: [], tokensDir: tmp("harness-tokens-") });
  expect(r.completed).toBe(true);
  const last = d.seen.at(-1)!;
  expect((last[0] as { text: string }).text).toContain("State (written by the harness from disk");
  expect(last.filter((m) => m.role === "assistant").map((m) => m.raw)).toEqual(SCRIPT.slice(1, 4).map((s) => s.raw));
}, T);

test("actual fixed cost (system prompt + tool definitions) is under 1,000 tokens", async () => {
  const d = scripted([{ text: "done", toolCalls: [] }]);
  const r = await run({ task: taskFile(), driver: d, repo: assemble("good-api"), hooks: [], tokensDir: tmp("harness-tokens-") });
  expect(r.fixed_cost.total).toBeLessThan(1000);
  expect(d.systems[0]).toContain("function respond<S extends z.ZodType>"); // map generated from template/src/lib
}, T);

test("token report has the right shape, cache reads shown separately and inside input", async () => {
  const dir = tmp("harness-tokens-");
  const r = await run({ task: taskFile(), driver: scripted(SCRIPT), repo: assemble("good-api"), hooks: [], tokensDir: dir });
  const rep = JSON.parse(readFileSync(join(dir, `${r.run_id}.json`), "utf8")) as TokenReport;
  expect(rep).toMatchObject({ run_id: r.run_id, driver: "custom", mode: "actual", task_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
  expect(rep.turns).toHaveLength(5);
  for (const [i, t] of rep.turns.entries()) {
    expect(Object.keys(t).sort()).toEqual(["cache_read_tokens", "cache_write_tokens", "input_tokens", "output_tokens", "turn"]);
    expect(t.turn).toBe(i + 1);
    expect(t.cache_read_tokens).toBeLessThanOrEqual(t.input_tokens);
  }
  expect(rep.turns[1]!.cache_read_tokens).toBeGreaterThan(0);
  expect(rep.total_input_tokens).toBe(rep.turns.reduce((a, t) => a + t.input_tokens, 0));
  expect(rep.total_cache_read_tokens).toBe(rep.turns.reduce((a, t) => a + t.cache_read_tokens, 0));
}, T);

test("--with-baseline: same task + driver, baseline input > actual input, one combined report", async () => {
  const dir = tmp("harness-tokens-");
  const d = scripted(SCRIPT);
  const { actual, baseline, report } = await runWithBaseline({ task: taskFile(), driver: d, repo: assemble("good-api"), hooks: [], tokensDir: dir });
  expect(actual.completed && baseline.completed).toBe(true);
  expect(baseline.run_id).toEndWith("_baseline");

  // baseline: full rule text + every source file re-injected each turn, no JIT tools, no window
  const b = d.seen.findIndex((m) => m.length === 1);
  const a = d.seen.findLastIndex((m) => m.length === 1);
  expect(a).toBeGreaterThan(b);
  expect((d.seen[b]![0] as { text: string }).text).toContain("=== src/routes/notes.ts ===");
  expect((d.seen[a]![0] as { text: string }).text).not.toContain("===");
  expect(d.systems[b]).toContain("## tenant-isolation\nEvery DB query is scoped");
  expect(d.systems[a]).toContain("- tenant-isolation: Every DB query is scoped");
  expect(d.systems[a]).not.toContain("No raw SQL"); // detail lines only via get_rule / on failure
  expect(d.toolNames[b]).not.toContain("get_rule");
  expect(d.toolNames[a]).toEqual(expect.arrayContaining(["get_rule", "get_route", "get_schema"]));
  const lastBaseline = d.seen[a - 1]!;
  expect((lastBaseline[0] as { text: string }).text.match(/=== src\/routes\/notes\.ts ===/g)).toHaveLength(1); // refreshed, not appended
  expect(lastBaseline.length).toBe(1 + 2 * 4); // whole history kept

  const rep = JSON.parse(readFileSync(join(dir, `${actual.run_id}.json`), "utf8")) as TokenReport;
  expect(rep).toEqual(report);
  expect(rep.mode).toBe("actual");
  expect(rep.baseline?.mode).toBe("baseline");
  expect(rep.baseline!.task_hash).toBe(rep.task_hash);
  expect(rep.baseline!.total_input_tokens).toBeGreaterThan(rep.total_input_tokens);
  for (const t of rep.comparison!) expect(t.baseline_input_tokens!).toBeGreaterThan(t.actual_input_tokens!);
  expect(rep.reduction_pct).toBe(Math.round(1000 * (1 - rep.total_input_tokens / rep.baseline!.total_input_tokens)) / 10);
  expect(rep.reduction_pct!).toBeGreaterThan(0);
}, T);

test("JIT tools return one table, one route (+ its validator schemas), one rule", async () => {
  const root = assemble("good-api");
  const c = { root, runDir: tmp("harness-run-") };
  const tool = async (n: string) => (await import(`../plugins/tools/${n}.ts`)).default;
  const schema = await (await tool("get_schema")).run({ table: "notes" }, c);
  expect(schema).toStartWith("src/db/schema.ts:");
  expect(schema).toContain('sqliteTable(\n  "notes"');
  const route = await (await tool("get_route")).run({ route: "post /v1/notes" }, c);
  expect(route).toContain('notesRouter.post("/"');
  expect(route).toContain("const NoteCreate = z.object(");
  expect(route).not.toContain("notesRouter.delete");
  expect(await (await tool("get_rule")).run({ name: "auth" }, c)).toStartWith("auth: Every route is behind auth middleware");
  const getRoute = await tool("get_route");
  await expect(Promise.resolve().then(() => getRoute.run({ route: "GET /nope" }, c))).rejects.toThrow('no route "GET /nope"');
}, T);
