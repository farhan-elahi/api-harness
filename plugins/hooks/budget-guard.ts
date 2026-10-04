// Stops the run (as failed, not done) once it passes max turns or max tokens. Limits: CLI flags, else task max_turns / max_tokens.
import { allow, defineHook, stop, type HookContext } from "../../core/sdk.ts";

const DEFAULT_TURNS = 40;

// Tool calls on the last turn are refused too: the model would need another turn to see their results.
const check = (lastTurnOk: boolean) => ({ turn, usage, limits }: HookContext) => {
  const maxTurns = limits.maxTurns ?? DEFAULT_TURNS;
  const used = usage.input + usage.output;
  if (turn > maxTurns) return stop(`over budget: turn ${turn} > max ${maxTurns} turns`);
  if (turn === maxTurns && !lastTurnOk) return stop(`over budget: tool calls on the last of ${maxTurns} turns`);
  if (limits.maxTokens && used > limits.maxTokens) return stop(`over budget: ${used} tokens > max ${limits.maxTokens}`);
  return allow;
};

export default defineHook({ name: "budget-guard", beforeTool: check(false), beforeStop: check(true) });
