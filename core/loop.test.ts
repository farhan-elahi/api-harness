// Offline check: a scripted driver drives the real loop + real tools + real hooks, no network.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scripted } from "../drivers/fake.ts";
import { loadHooks } from "./hooks.ts";
import { run } from "./loop.ts";
import type { Message } from "./sdk.ts";

const setup = (taskYaml = "mode: create\nwhatever: kept\n") => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  writeFileSync(join(dir, "t.yaml"), taskYaml);
  return { dir, task: join(dir, "t.yaml"), repo: join(dir, "proj"), tokensDir: join(dir, "tokens") };
};
const toolMsg = (m: Message[]) => m.at(-1) as Extract<Message, { role: "tool" }>;

test("loop runs tools, sandboxes paths, stops on no tool calls", async () => {
  const { dir, task, repo, tokensDir } = setup();
  const d = scripted([
    { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "a.ts", content: "export const a = 1;\n" } }] },
    { text: "", toolCalls: [{ id: "2", name: "read_file", input: { path: "../escape" } }, { id: "3", name: "list_files", input: {} }] },
    { text: "done", toolCalls: [] },
  ]);
  const r = await run({ task, driver: d, repo, tokensDir, hooks: [] });

  expect(r).toMatchObject({ completed: true, status: "done" });
  expect(r.turns).toHaveLength(3);
  expect(readFileSync(join(dir, "proj/a.ts"), "utf8")).toBe("export const a = 1;\n");
  expect(toolMsg(d.seen[2]!).results[0]).toMatchObject({ id: "2", isError: true });
  expect(toolMsg(d.seen[2]!).results[1]!.output).toBe("a.ts");
  expect((d.seen[0]![0] as { text: string }).text).toContain("whatever: kept");
});

test("a hook block goes back to the model as the tool result and is logged with hook + reason", async () => {
  const { task, repo, tokensDir } = setup();
  const d = scripted([
    { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: ".env", content: "X=1" } }] },
    { text: "ok", toolCalls: [] },
  ]);
  const hooks = (await loadHooks()).filter((h) => h.name !== "stop-gate");
  const r = await run({ task, driver: d, repo, tokensDir, hooks });
  expect(toolMsg(d.seen[1]!).results[0]).toMatchObject({ isError: true, output: "blocked by path-guard: .env is a secret file" });
  const log = readFileSync(join("runs", r.run_id, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(log).toContainEqual(expect.objectContaining({ hook: "path-guard", point: "beforeTool", tool: "write_file", block: ".env is a secret file" }));
});

test("beforeStop block makes the model continue; budget stop marks the run failed", async () => {
  const { task, repo, tokensDir } = setup("mode: create\nmax_turns: 3\n");
  const d = scripted([{ text: "done?", toolCalls: [] }, { text: "done!", toolCalls: [] }, { text: "really", toolCalls: [] }, { text: "x", toolCalls: [] }]);
  const nag = { name: "nag", beforeStop: () => ({ block: "not yet" }) };
  const hooks = [...(await loadHooks()).filter((h) => h.name === "budget-guard"), nag];
  const r = await run({ task, driver: d, repo, tokensDir, hooks });
  expect(d.seen[1]!.at(-1)).toEqual({ role: "user", text: "blocked by nag: not yet" });
  expect(r).toMatchObject({ completed: false, status: "failed", reason: "budget-guard: over budget: turn 4 > max 3 turns" });
});

test("afterTool notes are appended to the tool result (not an error) and logged", async () => {
  const { task, repo, tokensDir } = setup();
  const d = scripted([{ text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "a.ts", content: "x" } }] }, { text: "ok", toolCalls: [] }]);
  const r = await run({ task, driver: d, repo, tokensDir, hooks: [{ name: "fb", afterTool: () => ({ note: "a.ts:1:1 TS1 boom" }) }] });
  expect(toolMsg(d.seen[1]!).results[0]).toEqual({ id: "1", output: "wrote a.ts (1 lines)\na.ts:1:1 TS1 boom" });
  const log = readFileSync(join("runs", r.run_id, "transcript.jsonl"), "utf8");
  expect(log).toContain('"hook":"fb","point":"afterTool","tool":"write_file","note":"a.ts:1:1 TS1 boom"');
});
