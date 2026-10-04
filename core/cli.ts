#!/usr/bin/env bun
// harness run <task> --driver <name> [--repo <path>] [--max-turns N] [--max-tokens N] [--baseline | --with-baseline]
// harness check --api <dir> [--task <file>]
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assemble } from "../scripts/fixture.ts";
import { rootOf, run, runWithBaseline, seed } from "./loop.ts";
import { formatReport, runChecks } from "./runner.ts";
import { redact } from "./sdk.ts";
import { loadTask } from "./task.ts";

const USAGE = `usage:
  harness run <task-file> --driver <name> [--repo <path>] [--max-turns N] [--max-tokens N] [--baseline | --with-baseline]
  harness check --api <dir> [--task <file>]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { driver: { type: "string" }, repo: { type: "string" }, "max-turns": { type: "string" }, "max-tokens": { type: "string" }, baseline: { type: "boolean" }, "with-baseline": { type: "boolean" }, api: { type: "string" }, task: { type: "string" } },
});
const [cmd, task] = positionals;

try {
  if (cmd === "check" && values.api) {
    // fixtures/<name> is an overlay on template/; check the assembled API, not the bare overlay.
    const api = dirname(resolve(values.api)) === resolve(import.meta.dir, "../fixtures") ? assemble(basename(values.api)) : values.api;
    const report = await runChecks(api, values.task ? loadTask(values.task).fields : {});
    console.log(formatReport(report));
    process.exit(report.verdict === 100 ? 0 : 1);
  }
  if (cmd !== "run" || !task || !values.driver) {
    console.error(USAGE);
    process.exit(2);
  }
  if (values.baseline && values["with-baseline"]) throw new Error("use --baseline or --with-baseline, not both");
  const opts = { task, driver: values.driver, repo: values.repo, maxTurns: Number(values["max-turns"]) || undefined, maxTokens: Number(values["max-tokens"]) || undefined };
  if (loadTask(task).fields.mode === "create") seed(rootOf(loadTask(task), values.repo));
  const say =(r: Awaited<ReturnType<typeof run>>) =>
    console.log(redact(`\n[${r.mode}] ${r.completed ? `done: ${r.final}` : `FAILED: ${r.reason}`}\nproject: ${r.root}\nlog: runs/${r.run_id}/\ntokens: ${r.tokens} (input ${r.report.total_input_tokens})`));
  if (values["with-baseline"]) {
    const { actual, baseline, report } = await runWithBaseline(opts);
    say(baseline);
    say(actual);
    console.log(`reduction: ${report.reduction_pct}% (${report.baseline?.total_input_tokens} -> ${report.total_input_tokens} input tokens)`);
    process.exit(actual.completed && baseline.completed ? 0 : 1);
  }
  const r = await run({ ...opts, mode: values.baseline ? "baseline" : "actual" });
  say(r);
  process.exit(r.completed ? 0 : 1);
} catch (e) {
  console.error(redact(`error: ${(e as Error).message}`));
  process.exit(1);
}
