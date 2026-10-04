// The agent loop: send -> run tool calls -> append results -> repeat until the model stops calling tools.
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadHooks, runHooks, type HookPoint } from "./hooks.ts";
import { loadDriver, loadTools } from "./loader.ts";
import { loadTask } from "./task.ts";
import { redact, type Driver, type Hook, type HookContext, type Message, type ToolResult } from "./sdk.ts";

const SYSTEM =
  "You are a coding agent working inside one project directory. Use the tools to inspect and write files. " +
  "Read only what you need. Paths are relative to the project root. When the task is complete, reply with a one-line summary and no tool calls.";

export type RunOptions = {
  task: string;
  driver: string | Driver; // a name from drivers.yaml, or a Driver object (tests)
  repo?: string;
  maxTurns?: number;
  maxTokens?: number;
  hooks?: Hook[]; // default: everything in plugins/hooks/
};
const HARD_CAP = 500; // NOTE: safety net only; turn/token limits belong to hooks.
const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);

export async function run(opts: RunOptions) {
  const task = loadTask(opts.task);
  const root = resolve(opts.repo ?? (typeof task.fields.target === "string" ? task.fields.target : join("generated", task.name)));
  const driverName = typeof opts.driver === "string" ? opts.driver : "custom";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${driverName}_${task.name}`;
  const runDir = resolve("runs", runId);
  const log = (e: object) => appendFileSync(join(runDir, "transcript.jsonl"), redact(JSON.stringify(e)) + "\n");

  const [driver, tools, hooks] = await Promise.all([
    typeof opts.driver === "string" ? loadDriver(opts.driver) : opts.driver,
    loadTools(),
    opts.hooks ?? loadHooks(),
  ]);
  mkdirSync(root, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map(({ name, description, input }) => ({ name, description, input }));
  const messages: Message[] = [{ role: "user", text: `Task file ${task.path}:\n\n${task.text}` }];
  const turns: { turn: number; input_tokens: number; output_tokens: number }[] = [];
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
    const reply = await driver.send(SYSTEM, messages, specs);
    usage.input += reply.usage.input;
    usage.output += reply.usage.output;
    turns.push({ turn, input_tokens: reply.usage.input, output_tokens: reply.usage.output });
    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
    log({ turn, text: reply.text, toolCalls: reply.toolCalls, usage: reply.usage, stop: reply.stop });
    console.log(`turn ${turn}: in=${reply.usage.input} out=${reply.usage.output} ${reply.toolCalls.map((c) => c.name).join(", ") || "(no tools)"}`);

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
  const summary = { run_id: runId, driver: driverName, task: task.path, root, turns, usage, final, status, reason: failure, completed: !failure };
  writeFileSync(join(runDir, "run.json"), redact(JSON.stringify(summary, null, 2)));
  return summary;
}
