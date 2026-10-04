// Offline check: a scripted driver drives the real loop + real tools, no network.
import { test, expect, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, Message, Reply } from "./sdk.ts";

const seen: Message[][] = [];
const script: Omit<Reply, "usage" | "stop">[] = [
  { text: "", toolCalls: [{ id: "1", name: "write_file", input: { path: "src/a.ts", content: "export const a = 1;\n" } }] },
  { text: "", toolCalls: [{ id: "2", name: "read_file", input: { path: "../escape" } }, { id: "3", name: "list_files", input: {} }] },
  { text: "done", toolCalls: [] },
];
const fake: Driver = {
  async send(_s, messages) {
    seen.push(structuredClone(messages));
    const r = script[seen.length - 1]!;
    return { ...r, usage: { input: 10, output: 1 }, stop: r.toolCalls.length ? "tool" : "end" };
  },
};
const real = await import("./loader.ts");
mock.module("./loader.ts", () => ({ ...real, loadDriver: async () => fake }));
const { run } = await import("./loop.ts");

test("loop runs tools, sandboxes paths, stops on no tool calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  const task = join(dir, "t.yaml");
  writeFileSync(task, "mode: create\nwhatever: kept\n");
  const r = await run({ task, driver: "fake", repo: join(dir, "proj") });

  expect(r.completed).toBe(true);
  expect(r.turns).toHaveLength(3);
  expect(readFileSync(join(dir, "proj/src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  const results = seen[2]!.at(-1) as Extract<Message, { role: "tool" }>;
  expect(results.results[0]).toMatchObject({ id: "2", isError: true });
  expect(results.results[1]!.output).toBe("src/a.ts");
  expect((seen[0]![0] as { text: string }).text).toContain("whatever: kept");
});
