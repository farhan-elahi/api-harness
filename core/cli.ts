#!/usr/bin/env bun
// harness run <task> --driver <name> [--repo <path>] [--max-turns N] [--max-tokens N] [--baseline | --with-baseline [--baseline-turns N]] [--no-ship]
// harness check --api <dir> [--task <file>]
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assemble } from "../scripts/fixture.ts";
import { rootOf, run, runWithBaseline, seed } from "./loop.ts";
import { formatReport, runChecks } from "./runner.ts";
import { redact } from "./sdk.ts";
import { assertClean, ship, stripExample } from "./ship.ts";
import { loadTask } from "./task.ts";

const USAGE = `usage:
  harness run <task-file> --driver <name> [--repo <path>] [--max-turns N] [--max-tokens N] [--baseline | --with-baseline [--baseline-turns N]] [--no-ship]
  harness check --api <dir> [--task <file>]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { driver: { type: "string" }, repo: { type: "string" }, "max-turns": { type: "string" }, "max-tokens": { type: "string" }, baseline: { type: "boolean" }, "with-baseline": { type: "boolean" }, api: { type: "string" }, task: { type: "string" }, "no-ship": { type: "boolean" }, "baseline-turns": { type: "string" } },
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
  const opts = { task, driver: values.driver, repo: values.repo, maxTurns: Number(values["max-turns"]) || undefined, maxTokens: Number(values["max-tokens"]) || undefined, baselineTurns: Number(values["baseline-turns"]) || undefined };
  const t = loadTask(task);
  assertClean(rootOf(t, values.repo));
  if (t.fields.mode === "create") seed(rootOf(t, values.repo));
  const say =(r: Awaited<ReturnType<typeof run>>) =>
    console.log(redact(`\n[${r.mode}] ${r.completed ? `done: ${r.final}` : `FAILED: ${r.reason}`}\nproject: ${r.root}\nlog: runs/${r.run_id}/\ntokens: ${r.tokens} (input ${r.report.total_input_tokens})`));
  // After the stop-gate is green: strip the template's example (create mode), re-prove, then ship. Exit 0 only if shipped.
  const deliver = async (r: Awaited<ReturnType<typeof run>>) => {
    if (!r.completed) return false;
    if (r.mode === "baseline") return true; // a measurement, never shipped
    if (t.fields.mode === "create") {
      const s = await stripExample(r.root, t.fields);
      console.log(s.ok ? `example removed: ${s.changed.join(", ") || "none"}` : `FAILED: ${s.reason}`);
      if (!s.ok) return false;
    }
    const body = `Task: ${t.path}\nRun: runs/${r.run_id}/ (driver ${r.driver}, ${r.turns.length} turns)\nTokens: ${r.tokens}\nGates: stop-gate green (tests pass, harness check 100%).`;
    const s = ship({ root: r.root, task: t.name, title: `harness: ${t.name}`, body, extra: [r.tokens], skip: values["no-ship"] });
    console.log(redact(s.status === "skipped" ? s.message : `ship: ${s.message}`));
    return s.status === "shipped" || s.status === "skipped";
  };
  if (values["with-baseline"]) {
    const { actual, baseline, report } = await runWithBaseline(opts);
    say(baseline);
    say(actual);
    const sum = (k: "baseline_input_tokens" | "actual_input_tokens") => report.comparison!.reduce((a, r) => a + (r[k] ?? 0), 0);
    console.log(`reduction: ${report.reduction_pct}% over turns 1..${report.comparison!.length} (${sum("baseline_input_tokens")} -> ${sum("actual_input_tokens")} input tokens; baseline ${baseline.completed ? "completed" : "capped"})`);
    process.exit((await deliver(actual)) ? 0 : 1); // green + ship follow the actual run; the baseline is only a measurement
  }
  const r = await run({ ...opts, mode: values.baseline ? "baseline" : "actual" });
  say(r);
  process.exit((await deliver(r)) ? 0 : 1);
} catch (e) {
  console.error(redact(`error: ${(e as Error).message}`));
  process.exit(1);
}
