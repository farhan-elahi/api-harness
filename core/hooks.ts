// Runs plugins/hooks/* at a hook point. Adding a hook = dropping a file; nothing here changes.
import { loadPlugins } from "./loader.ts";
import type { Hook, HookContext } from "./sdk.ts";

export const loadHooks = () => loadPlugins<Hook>("hooks");

export type HookPoint = "beforeTool" | "afterTool" | "beforeStop";
export type Verdict = { hook: string; block?: string; stop?: string };
export type HookRun = { verdict?: Verdict; notes: { hook: string; note: string }[] };

// First hook that blocks or stops wins (no verdict = everyone allowed). Notes from hooks before it are kept.
export async function runHooks(hooks: Hook[], point: HookPoint, ctx: HookContext): Promise<HookRun> {
  const notes: HookRun["notes"] = [];
  for (const h of hooks) {
    const r = await h[point]?.(ctx);
    if (r && "block" in r) return { verdict: { hook: h.name, block: r.block }, notes };
    if (r && "stop" in r) return { verdict: { hook: h.name, stop: r.stop }, notes };
    if (r && "note" in r && r.note) notes.push({ hook: h.name, note: r.note });
  }
  return { notes };
}
