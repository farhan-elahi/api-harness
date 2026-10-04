// Offline check: drive the OpenAI-compatible driver against a local fake server (base_url override).
import { test, expect, afterAll } from "bun:test";
import create from "./openai-compatible.ts";
import type { Message } from "../core/sdk.ts";

const bodies: any[] = [];
const replies = [
  { message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","content":"x"}' } }] }, finish_reason: "tool_calls" },
  { message: { role: "assistant", content: "done" }, finish_reason: "stop" },
];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push(await req.json());
    const r = replies[bodies.length - 1];
    return Response.json({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, ...r }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } });
  },
});
afterAll(() => server.stop());

test("missing key -> clear error", () => {
  expect(() => create({ key_env: "NOPE_UNSET_KEY", model: "m" })).toThrow("NOPE_UNSET_KEY is not set");
});

test("neutral tools/messages round-trip through the chat format", async () => {
  process.env.FAKE_KEY = "k";
  const d = create({ key_env: "FAKE_KEY", base_url: `http://localhost:${server.port}/v1`, model: "m" });
  const tools = [{ name: "write_file", description: "w", input: { type: "object", properties: {} } }];
  const msgs: Message[] = [{ role: "user", text: "go" }];

  const r1 = await d.send("sys", msgs, tools);
  expect(r1).toMatchObject({ stop: "tool", usage: { input: 50, output: 5 }, toolCalls: [{ id: "c1", name: "write_file", input: { path: "a.ts", content: "x" } }] });
  expect(bodies[0].messages[0]).toEqual({ role: "system", content: "sys" });
  expect(bodies[0].tools[0]).toEqual({ type: "function", function: { name: "write_file", description: "w", parameters: { type: "object", properties: {} } } });

  msgs.push({ role: "assistant", text: r1.text, toolCalls: r1.toolCalls, raw: r1.raw }, { role: "tool", results: [{ id: "c1", output: "wrote a.ts" }] });
  const r2 = await d.send("sys", msgs, tools);
  expect(r2).toMatchObject({ stop: "end", text: "done", toolCalls: [] });
  expect(bodies[1].messages.slice(2)).toEqual([
    { role: "assistant", content: null, tool_calls: replies[0]!.message.tool_calls },
    { role: "tool", tool_call_id: "c1", content: "wrote a.ts" },
  ]);
});
