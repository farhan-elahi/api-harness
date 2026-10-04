#!/usr/bin/env bun
// harness run <task> --driver <name> [--repo <path>] [--max-turns N]
// harness check --api <dir>
import { parseArgs } from "node:util";
import { run } from "./loop.ts";
import { formatReport, runChecks } from "./runner.ts";
import { redact } from "./sdk.ts";

const USAGE = `usage:
  harness run <task-file> --driver <name> [--repo <path>] [--max-turns N]
  harness check --api <dir>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { driver: { type: "string" }, repo: { type: "string" }, "max-turns": { type: "string" }, api: { type: "string" } },
});
const [cmd, task] = positionals;

try {
  if (cmd === "check" && values.api) {
    const report = await runChecks(values.api);
    console.log(formatReport(report));
    process.exit(report.verdict === 100 ? 0 : 1);
  }
  if (cmd !== "run" || !task || !values.driver) {
    console.error(USAGE);
    process.exit(2);
  }
  const r = await run({ task, driver: values.driver, repo: values.repo, maxTurns: Number(values["max-turns"]) || undefined });
  console.log(redact(`\n${r.completed ? "done" : "stopped (turn limit)"}: ${r.final}\nproject: ${r.root}\nlog: runs/${r.run_id}/`));
  process.exit(r.completed ? 0 : 1);
} catch (e) {
  console.error(redact(`error: ${(e as Error).message}`));
  process.exit(1);
}
