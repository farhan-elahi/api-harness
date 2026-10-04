// Anthropic driver: translates the harness's neutral messages/tools to the Messages API and back.
import Anthropic from "@anthropic-ai/sdk";
import type { DriverFactory, Message, Reply } from "../core/sdk.ts";

type Block = Anthropic.ContentBlockParam;

const toVendor = (m: Message): Anthropic.MessageParam => {
  if (m.role === "user") return { role: "user", content: m.text };
  if (m.role === "tool")
    return {
      role: "user",
      content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output, is_error: r.isError })),
    };
  // Replay our own content blocks unchanged (thinking blocks must round-trip verbatim).
  if (m.raw) return { role: "assistant", content: m.raw as Block[] };
  const content: Block[] = [];
  if (m.text) content.push({ type: "text", text: m.text });
  for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  return { role: "assistant", content };
};

const STOP: Record<string, Reply["stop"]> = { tool_use: "tool", pause_turn: "pause", max_tokens: "limit" };

const create: DriverFactory = (cfg) => {
  const keyEnv = String(cfg.key_env ?? "ANTHROPIC_API_KEY");
  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`${keyEnv} is not set. Add it to .env (see .env.example).`);
  const client = new Anthropic({ apiKey });
  return {
    async send(system, messages, tools) {
      const res = await client.messages.create({
        model: String(cfg.model),
        max_tokens: Number(cfg.max_tokens ?? 16000),
        ...(cfg.effort ? { output_config: { effort: cfg.effort as Anthropic.OutputConfig["effort"] } } : {}),
        system,
        messages: messages.map(toVendor),
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input as Anthropic.Tool.InputSchema })),
      });
      if (res.stop_reason === "refusal") throw new Error(`model refused: ${res.stop_details?.category ?? "unknown"}`);
      const u = res.usage;
      return {
        text: res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
        toolCalls: res.content.flatMap((b) =>
          b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input as Record<string, unknown> }] : [],
        ),
        usage: {
          input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          output: u.output_tokens,
        },
        stop: STOP[res.stop_reason ?? ""] ?? "end",
        raw: res.content,
      };
    },
  };
};

export default create;
