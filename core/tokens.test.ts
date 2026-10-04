// Token report, baseline vs actual, and compaction, all offline with the scripted driver.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scripted } from "../drivers/fake.ts";
import { assemble } from "../scripts/fixture.ts";
import { compact } from "./context.ts";
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

test("compaction shrinks old tool results only; assistant turns and their raw are never touched", async () => {
  const d = scripted(SCRIPT);
  const r = await run({ task: taskFile(), driver: d, repo: assemble("good-api"), hooks: [], tokensDir: tmp("harness-tokens-") });
  expect(r.completed).toBe(true);
  const last = d.seen.at(-1)!;
  const assistants = last.filter((m) => m.role === "assistant");
  expect(assistants.map((m) => m.raw)).toEqual(SCRIPT.slice(0, 4).map((s) => s.raw));
  expect(assistants.map((m) => m.toolCalls)).toEqual(SCRIPT.slice(0, 4).map((s) => s.toolCalls));
  const outputs = last.flatMap((m) => (m.role === "tool" ? m.results.map((x) => x.output) : []));
  expect(outputs[0]).toMatch(/^\[read_file src\/routes\/notes\.ts: \d+ lines, compacted\]$/);
  expect(outputs[1]).toMatch(/^\[read_file src\/db\/schema\.ts: \d+ lines, compacted\]$/);
  expect(outputs[2]).toContain("\n"); // last 2 kept in full
  expect(outputs[3]).toContain("\n");

  // direct: raw object identity survives compaction
  const raw = { opaque: true };
  const msgs: Message[] = [
    { role: "user", text: "go" },
    ...[1, 2, 3].flatMap((i): Message[] => [
      { role: "assistant", text: "", toolCalls: [read(`f${i}`, `${i}`)], raw },
      { role: "tool", results: [{ id: `${i}`, output: "a\nb\nc" }] },
    ]),
  ];
  compact(msgs);
  expect((msgs[1] as { raw: unknown }).raw).toBe(raw);
  expect((msgs[2] as Extract<Message, { role: "tool" }>).results[0]!.output).toBe("[read_file f1: 3 lines, compacted]");
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

  // baseline: full rule text + every source file up front, no JIT tools, no compaction
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
  expect(d.systems[a]!.length).toBeLessThan(2048);

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
