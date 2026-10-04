// Scripted driver for offline tests: replays fixed replies in order, records what it was sent. No network, no keys.
// Usage mimics a provider: input = size of what was sent (~4 chars/token); cacheRead = the prefix shared with the
// previous request, like automatic prompt caching. Real drivers report the provider's own numbers.
import type { Driver, Message, Reply, ToolSpec } from "../core/sdk.ts";

export type Scripted = Driver & { seen: Message[][]; systems: string[]; toolNames: string[][] };

const tokens = (s: string) => Math.ceil(s.length / 4);

export function scripted(replies: Omit<Reply, "usage" | "stop">[]): Scripted {
  const seen: Message[][] = [];
  const systems: string[] = [];
  const toolNames: string[][] = [];
  let prev = "";
  let i = 0; // script position; restarts when a new conversation begins (e.g. the second run of --with-baseline)
  return {
    seen,
    systems,
    toolNames,
    async send(system: string, messages: Message[], tools: ToolSpec[]) {
      seen.push(structuredClone(messages));
      systems.push(system);
      toolNames.push(tools.map((t) => t.name));
      if (messages.length === 1) i = 0;
      const sent = JSON.stringify({ system, tools, messages });
      let shared = 0;
      while (shared < prev.length && shared < sent.length && prev[shared] === sent[shared]) shared++;
      prev = sent;
      const r = replies[i++] ?? { text: "out of script", toolCalls: [] };
      return {
        ...r,
        usage: { input: tokens(sent), output: tokens(r.text + JSON.stringify(r.toolCalls)), cacheRead: Math.floor(shared / 4), cacheWrite: 0 },
        stop: r.toolCalls.length ? "tool" : "end",
      };
    },
  };
}
