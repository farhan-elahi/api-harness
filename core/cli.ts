#!/usr/bin/env bun
// harness run <task> --driver <name> [--repo <path>] [--max-turns N]
import { parseArgs } from "node:util";
import { run } from "./loop.ts";
import { redact } from "./sdk.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { driver: { type: "string" }, repo: { type: "string" }, "max-turns": { type: "string" } },
});
const [cmd, task] = positionals;

if (cmd !== "run" || !task || !values.driver) {
  console.error("usage: harness run <task-file> --driver <name> [--repo <path>] [--max-turns N]");
  process.exit(2);
}
try {
  const r = await run({ task, driver: values.driver, repo: values.repo, maxTurns: Number(values["max-turns"]) || undefined });
  console.log(redact(`\n${r.completed ? "done" : "stopped (turn limit)"}: ${r.final}\nproject: ${r.root}\nlog: runs/${r.run_id}/`));
  process.exit(r.completed ? 0 : 1);
} catch (e) {
  console.error(redact(`error: ${(e as Error).message}`));
  process.exit(1);
}
