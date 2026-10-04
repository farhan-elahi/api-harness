// Scripted driver for offline tests: replays fixed replies in order, records what it was sent. No network, no keys.
import type { Driver, Message, Reply } from "../core/sdk.ts";

export type Scripted = Driver & { seen: Message[][] };

export function scripted(replies: Omit<Reply, "usage" | "stop">[], tokensPerTurn = 10): Scripted {
  const seen: Message[][] = [];
  return {
    seen,
    async send(_system, messages) {
      seen.push(structuredClone(messages));
      const r = replies[seen.length - 1] ?? { text: "out of script", toolCalls: [] };
      return { ...r, usage: { input: tokensPerTurn, output: 0 }, stop: r.toolCalls.length ? "tool" : "end" };
    },
  };
}
