// The agent loop: send -> run tool calls -> append results -> repeat until the model stops calling tools.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changedSince, mtimes, dropsTurns, fixedCost, openingMessage, projectDump, stateNote, systemPrompt, view, type Mode } from "./context.ts";
import { loadHooks, runHooks, type HookPoint } from "./hooks.ts";
import { loadDriver, loadTools } from "./loader.ts";
import { loadChecks } from "./runner.ts";
import { loadTask, type Task } from "./task.ts";
import { compare, taskHash, tokenReport, turnTokens, writeTokens, type TurnTokens } from "./tokens.ts";
import { redact, type Driver, type Hook, type HookContext, type Measured, type Message, type ToolResult } from "./sdk.ts";

export type RunOptions = {
  task: string;
  driver: string | Driver; // a name from drivers.yaml, or a Driver object (tests)
  repo?: string;
  maxTurns?: number;
  maxTokens?: number;
  hooks?: Hook[]; // default: everything in plugins/hooks/
  mode?: Mode; // actual (default): JIT tools, rule index, history window. baseline: none of that (docs/design.md).
  tokensDir?: string; // default: tokens/
  baselineTurns?: number; // --with-baseline: cap the baseline at N turns (default 8); the report compares turns 1..N
};
const HARD_CAP = 500; // NOTE: safety net only; turn/token limits belong to hooks.
const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);

export const rootOf = (task: Task, repo?: string) =>
  resolve(repo ?? (typeof task.fields.target === "string" ? task.fields.target : join("generated", task.name)));

// Create mode starts from template/ (minus node_modules), then installs deps. Refuses a non-empty target.
export function seed(root: string, opts: { template?: string; install?: boolean } = {}) {
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`refusing to seed: ${root} is not empty (delete it or pick another --repo)`);
  cpSync(resolve(opts.template ?? "template"), root, { recursive: true, filter: (src) => !/\/node_modules(\/|$)/.test(src) });
  if (opts.install === false) return;
  const r = Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`bun install failed in ${root}`);
}

export async function run(opts: RunOptions) {
  const task = loadTask(opts.task);
  const mode = opts.mode ?? "actual";
  const root = rootOf(task, opts.repo);
  const driverName = typeof opts.driver === "string" ? opts.driver : "custom";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${driverName}_${task.name}${mode === "baseline" ? "_baseline" : ""}`;
  const runDir = resolve("runs", runId);
  const log = (e: object) => appendFileSync(join(runDir, "transcript.jsonl"), redact(JSON.stringify(e)) + "\n");

  const [driver, allTools, hooks, checks] = await Promise.all([
    typeof opts.driver === "string" ? loadDriver(opts.driver) : opts.driver,
    loadTools(),
    opts.hooks ?? loadHooks(),
    loadChecks(),
  ]);
  mkdirSync(root, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const tools = mode === "baseline" ? allTools.filter((t) => !t.jit) : allTools;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map(({ name, description, input }) => ({ name, description, input }));
  const system = systemPrompt(mode, checks, root);
  const fixed = fixedCost(system, specs);
  console.log(`fixed cost [${mode}]: system ${fixed.system} + tools ${fixed.tools} = ${fixed.total} tokens (est.)`);
  const messages: Message[] = [{ role: "user", text: openingMessage(task.path, task.text) }];
  const started = mtimes(root);
  let state: { key?: string; text: string; measured?: Measured } = { text: "" }; // state note, rebuilt only when disk changed
  const extra = async (turn: number) => {
    if (mode === "baseline") return projectDump(root).trimStart();
    if (!dropsTurns(mode, messages)) return "";
    const changed = changedSince(root, started);
    const key = changed.map((f) => `${f}@${statSync(join(root, f)).mtimeMs}`).join("|");
    if (key !== state.key) state = { key, ...(await stateNote(root, task.fields, changed)) };
    // Hook lines are rebuilt every turn (cheap; they read run state), the measured part only when disk changed.
    const measured = state.measured!;
    const lines = hooks.map((h) => h.state?.({ ...ctx(turn), measured })).filter(Boolean);
    const note = [state.text, ...lines].join("\n");
    log({ turn, state: note });
    return note;
  };
  let retries = 0;
  const recent: string[] = []; // loop guard: signatures of the last replies
  const LOOP = 3;
  const turns: TurnTokens[] = [];
  const usage = { input: 0, output: 0 };
  const limits = { maxTurns: opts.maxTurns ?? num(task.fields.max_turns), maxTokens: opts.maxTokens ?? num(task.fields.max_tokens) };
  const ctx = (turn: number, extra: Partial<HookContext> = {}): HookContext => ({ root, runDir, task: task.fields, turn, usage: { ...usage }, limits, ...extra });
  let final = "";
  let failure = "";
  // Runs hooks at a point; logs any block/stop/note. Returns the block reason, or sets `failure` on stop.
  let notes = "";
  const gate = async (point: HookPoint, c: HookContext) => {
    const run = await runHooks(hooks, point, c);
    for (const n of run.notes) log({ turn: c.turn, hook: n.hook, point, tool: c.call?.name, note: n.note });
    notes = run.notes.map((n) => n.note).join("\n");
    const v = run.verdict;
    if (!v) return undefined;
    log({ turn: c.turn, hook: v.hook, point, tool: c.call?.name, ...(v.block !== undefined ? { block: v.block } : { stop: v.stop }) });
    console.log(`  ${v.block !== undefined ? "blocked" : "stopped"} by ${v.hook}`);
    if (v.stop !== undefined) failure = `${v.hook}: ${v.stop}`;
    return `blocked by ${v.hook}: ${v.block ?? v.stop}`;
  };

  for (let turn = 1; turn <= HARD_CAP && !failure; turn++) {
    const reply = await driver.send(system, view(mode, messages, await extra(turn)), specs);
    usage.input += reply.usage.input;
    usage.output += reply.usage.output;
    turns.push(turnTokens(turn, reply.usage));
    for (const r of reply.retries ?? []) log({ turn, retry: r }); // retries are part of this turn, not extra turns
    retries += reply.retries?.length ?? 0;
    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
    log({ turn, text: reply.text, toolCalls: reply.toolCalls, usage: reply.usage, stop: reply.stop });
    console.log(`turn ${turn}: in=${reply.usage.input} out=${reply.usage.output} ${reply.toolCalls.map((c) => c.name).join(", ") || "(no tools)"}`);
    recent.push(JSON.stringify([reply.text, reply.toolCalls.map(({ name, input }) => [name, input])]));
    if (recent.length >= LOOP && recent.slice(-LOOP).every((s) => s === recent.at(-1))) {
      failure = `loop: ${LOOP} identical replies in a row`;
      log({ turn, stop: failure });
      break;
    }

    if (reply.toolCalls.length === 0) {
      if (reply.stop === "pause") continue;
      const blocked = await gate("beforeStop", ctx(turn));
      if (failure) break;
      if (blocked) {
        messages.push({ role: "user", text: blocked });
        continue;
      }
      final = reply.text;
      break;
    }
    // Sequential: hooks judge each call against the files as the previous call left them.
    const results: ToolResult[] = [];
    for (const c of reply.toolCalls) {
      const tool = byName.get(c.name);
      const blocked = failure ? "run stopped" : await gate("beforeTool", ctx(turn, { call: c }));
      if (blocked) {
        results.push({ id: c.id, output: blocked, isError: true });
        continue;
      }
      if (!tool) {
        results.push({ id: c.id, output: `unknown tool: ${c.name}`, isError: true });
        continue;
      }
      let r: ToolResult;
      try {
        r = { id: c.id, output: await tool.run(c.input, { root, runDir }) };
      } catch (e) {
        r = { id: c.id, output: (e as Error).message, isError: true };
      }
      const after = await gate("afterTool", ctx(turn, { call: c, output: r.output }));
      const output = [r.output, notes, after].filter(Boolean).join("\n");
      results.push(after ? { id: c.id, output, isError: true } : { ...r, output });
    }
    messages.push({ role: "tool", results });
    log({ turn, results });
  }

  if (!final && !failure) failure = `hard cap of ${HARD_CAP} turns`;
  const status = failure ? "failed" : "done";
  const tokens = tokenReport({ run_id: runId, driver: driverName, task: task.path, task_hash: taskHash(task.text), mode }, turns);
  const tokensPath = writeTokens(tokens, opts.tokensDir);
  const summary = { run_id: runId, driver: driverName, task: task.path, mode, root, turns, usage, fixed_cost: fixed, retries, final, status, reason: failure, completed: !failure, tokens: tokensPath };
  writeFileSync(join(runDir, "run.json"), redact(JSON.stringify(summary, null, 2)));
  return { ...summary, report: tokens };
}

// --with-baseline: same task + driver, baseline first on a snapshot of the starting project (so the two runs
// don't see each other's files), then the actual run. One combined report at tokens/<actual run_id>.json.
export async function runWithBaseline(opts: RunOptions) {
  const root = rootOf(loadTask(opts.task), opts.repo);
  const snap = mkdtempSync(join(tmpdir(), "harness-baseline-"));
  if (existsSync(root)) {
    cpSync(root, snap, { recursive: true, filter: (src) => !/\/(node_modules|\.git)(\/|$)/.test(src) });
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(snap, "node_modules"));
  }
  const limit = opts.baselineTurns ?? 8;
  const baseline = await run({ ...opts, mode: "baseline", repo: snap, maxTurns: limit });
  const actual = await run({ ...opts, mode: "actual" });
  const report = compare(actual.report, baseline.report, { completed: baseline.completed, limit });
  writeTokens(report, opts.tokensDir);
  return { actual, baseline, report };
}
