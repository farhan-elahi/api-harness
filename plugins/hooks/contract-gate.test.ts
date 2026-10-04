// Each kind of break is blocked with file:line; adding an optional field passes. Offline, on the good-api fixture.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble } from "../../scripts/fixture.ts";
import gate, { breaks, snapshot } from "./contract-gate.ts";

const T = 120_000;

test("contract-gate: each break is reported at file:line; an added optional field passes", () => {
  const root = assemble("good-api");
  const file = join(root, "src/routes/notes.ts");
  const src = readFileSync(file, "utf8");
  const before = snapshot(root);
  const after = (from: string, to: string) => {
    expect(src).toContain(from);
    writeFileSync(file, src.replace(from, to));
    try {
      return breaks(before, snapshot(root));
    } finally {
      writeFileSync(file, src);
    }
  };
  expect(after('notesRouter.delete("/:id"', 'notesRouter.delete("/:id/gone"')).toEqual([expect.stringMatching(/^src\/routes\/notes\.ts:\d+ DELETE \/v1\/notes\/:id: route removed$/)]);
  expect(after("body: z.string().nullable() })", "})")).toContainEqual(expect.stringMatching(/^src\/routes\/notes\.ts:\d+ GET \/v1\/notes\/:id: response field body removed$/));
  expect(after("title: z.string().min(1).max(120)", 'title: z.enum(["a", "b"])')).toContainEqual(expect.stringMatching(/POST \/v1\/notes: request field json.title is stricter: string -> "a" \| "b"$/));
  expect(after("body: z.string().max(5000).optional() })", "body: z.string().max(5000).optional(), tag: z.string() })")).toContainEqual(expect.stringMatching(/POST \/v1\/notes: new required request field json.tag$/));
  expect(after("toNote(row), 201)", "toNote(row))")).toContainEqual(expect.stringMatching(/POST \/v1\/notes: status 201 no longer returned \(now 200\)$/));
  expect(after("body: z.string().max(5000).optional() })", "body: z.string().max(5000).optional(), tag: z.string().optional() })")).toEqual([]);
}, T);

test("contract-gate hook: snapshots on the first tool call, blocks stop on a break; inactive outside mode: change", async () => {
  const root = assemble("good-api");
  const runDir = mkdtempSync(join(tmpdir(), "harness-run-"));
  const ctx = (mode: string) => ({ root, runDir, task: { mode }, turn: 1, usage: { input: 0, output: 0 }, limits: {} });
  expect(await gate.beforeTool!(ctx("change"))).toEqual({ allow: true });
  const file = join(root, "src/routes/notes.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace("body: z.string().nullable() })", "})"));
  expect(await gate.beforeStop!(ctx("create"))).toEqual({ allow: true });
  expect(await gate.beforeStop!(ctx("change"))).toMatchObject({ block: expect.stringContaining("response field body removed") });
}, T);
