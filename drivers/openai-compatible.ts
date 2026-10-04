// OpenAI-compatible driver (OpenAI, DeepSeek, Grok, OpenRouter…): Chat Completions + function tools.
// base_url, model and key_env come from drivers/drivers.yaml.
import OpenAI from "openai";
import type { DriverFactory, Message, Reply } from "../core/sdk.ts";
import { withRetry } from "./_retry.ts";

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

const toVendor = (m: Message): Msg[] => {
  if (m.role === "user") return [{ role: "user", content: m.text }];
  if (m.role === "tool") return m.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.output}` : r.output }));
  // Replay the provider's own assistant message unchanged (keeps provider-specific reasoning fields).
  if (m.raw) return [m.raw as Msg];
  return [
    {
      role: "assistant",
      content: m.text || null,
      ...(m.toolCalls.length && {
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })),
      }),
    },
  ];
};

const parseArgs = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {}; // bad JSON -> tool sees missing args and returns a validation error the model can fix
  }
};

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const STOP: Record<string, Reply["stop"]> = { tool_calls: "tool", length: "limit" };

const create: DriverFactory = (cfg) => {
  const keyEnv = String(cfg.key_env ?? "OPENAI_API_KEY");
  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`${keyEnv} is not set. Add it to .env (see .env.example).`);
  const client = new OpenAI({ apiKey, maxRetries: 0, ...(cfg.base_url ? { baseURL: String(cfg.base_url) } : {}) });

  return {
    async send(system, messages, tools) {
      const { value: res, retries } = await withRetry(() => client.chat.completions.create({
        model: String(cfg.model),
        ...(cfg.reasoning_effort ? { reasoning_effort: cfg.reasoning_effort as OpenAI.ReasoningEffort } : {}),
        messages: [{ role: "system", content: system }, ...messages.flatMap(toVendor)],
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input } })),
      }), { baseMs: num(cfg.retry_base_ms) });
      const choice = res.choices[0];
      if (!choice) throw new Error("provider returned no choices");
      const msg = choice.message;
      return {
        text: msg.content ?? "",
        toolCalls: (msg.tool_calls ?? []).flatMap((c) =>
          c.type === "function" ? [{ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }] : [],
        ),
        // prompt_tokens already includes cached_tokens; providers cache automatically, so there is no write count.
        usage: {
          input: res.usage?.prompt_tokens ?? 0,
          output: res.usage?.completion_tokens ?? 0,
          cacheRead: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWrite: 0,
        },
        stop: STOP[choice.finish_reason] ?? "end",
        raw: msg,
        retries,
      };
    },
  };
};

export default create;
