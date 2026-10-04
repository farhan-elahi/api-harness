// Breaking-change demo (offline, fake driver): a change run on a copy of examples/sample-existing-api whose "model"
// removes `body` from the Task response. The contract gate must block the stop. Run: bun scripts/demo-breaking-change.ts
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scripted } from "../drivers/fake.ts";
import { run } from "../core/loop.ts";
import contractGate from "../plugins/hooks/contract-gate.ts";

const dir = mkdtempSync(join(tmpdir(), "harness-demo-"));
cpSync(resolve("examples/sample-existing-api"), dir, { recursive: true, filter: (s) => !s.includes("node_modules") });
symlinkSync(resolve("template/node_modules"), join(dir, "node_modules"), "dir");
const task = join(dir, "..", `drop-body-${Date.now()}.yaml`);
writeFileSync(task, "mode: change\nchange: drop the body field from task responses\n");

const f = "src/routes/tasks.ts";
const d = scripted([
  { text: "", toolCalls: [{ id: "1", name: "edit_file", input: { path: f, old: "title: z.string(), body: z.string().nullable() }", new: "title: z.string() }" } }] },
  { text: "", toolCalls: [{ id: "2", name: "edit_file", input: { path: f, old: `"id" | "title" | "body">): z.infer<typeof Task> => ({ id: r.id, title: r.title, body: r.body })`, new: `"id" | "title">): z.infer<typeof Task> => ({ id: r.id, title: r.title })` } }] },
  { text: "done", toolCalls: [] },
]);
const r = await run({ task, driver: d, repo: dir, hooks: [contractGate], tokensDir: mkdtempSync(join(tmpdir(), "harness-tokens-")) });
const stop = d.seen.at(-1)!.at(-1) as { text?: string };
console.log(`$ bun scripts/demo-breaking-change.ts\nchange run on a copy of examples/sample-existing-api (fake driver, hooks: contract-gate only, so tdd-gate does not stop the edit first)\nedit: ${f} removes \`body\` from the Task response\n`);
console.log(`harness reply to "done":\n${stop.text}\n`);
console.log(`run: ${r.completed ? "COMPLETED (gate did not block!)" : `not completed (${r.reason})`}\nlog: runs/${r.run_id}/`);
process.exit(r.completed ? 1 : 0);
