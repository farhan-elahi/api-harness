// The agent loop: send -> run tool calls -> append results -> repeat until the model stops calling tools.
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDriver, loadTools } from "./loader.ts";
import { loadTask } from "./task.ts";
import type { Message, ToolResult } from "./sdk.ts";

const SYSTEM =
  "You are a coding agent working inside one project directory. Use the tools to inspect and write files. " +
  "Read only what you need. Paths are relative to the project root. When the task is complete, reply with a one-line summary and no tool calls.";

export type RunOptions = { task: string; driver: string; repo?: string; maxTurns?: number };

export async function run(opts: RunOptions) {
  const task = loadTask(opts.task);
  const root = resolve(opts.repo ?? (typeof task.fields.target === "string" ? task.fields.target : join("generated", task.name)));
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${opts.driver}_${task.name}`;
  const runDir = resolve("runs", runId);
  mkdirSync(root, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const log = (e: object) => appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify(e) + "\n");

  const [driver, tools] = await Promise.all([loadDriver(opts.driver), loadTools()]);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map(({ name, description, input }) => ({ name, description, input }));
  const messages: Message[] = [{ role: "user", text: `Task file ${task.path}:\n\n${task.text}` }];
  const turns: { turn: number; input_tokens: number; output_tokens: number }[] = [];
  const maxTurns = opts.maxTurns ?? 40;
  let final = "";

  for (let turn = 1; turn <= maxTurns; turn++) {
    const reply = await driver.send(SYSTEM, messages, specs);
    turns.push({ turn, input_tokens: reply.usage.input, output_tokens: reply.usage.output });
    messages.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
    log({ turn, text: reply.text, toolCalls: reply.toolCalls, usage: reply.usage, stop: reply.stop });
    console.log(`turn ${turn}: in=${reply.usage.input} out=${reply.usage.output} ${reply.toolCalls.map((c) => c.name).join(", ") || "(no tools)"}`);

    if (reply.toolCalls.length === 0) {
      if (reply.stop === "pause") continue;
      final = reply.text;
      break;
    }
    const results: ToolResult[] = await Promise.all(
      reply.toolCalls.map(async (c) => {
        const tool = byName.get(c.name);
        if (!tool) return { id: c.id, output: `unknown tool: ${c.name}`, isError: true };
        try {
          return { id: c.id, output: await tool.run(c.input, { root, runDir }) };
        } catch (e) {
          return { id: c.id, output: (e as Error).message, isError: true };
        }
      }),
    );
    messages.push({ role: "tool", results });
    log({ turn, results });
  }

  const summary = { run_id: runId, driver: opts.driver, task: task.path, root, turns, final, completed: final !== "" };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(summary, null, 2));
  return summary;
}
