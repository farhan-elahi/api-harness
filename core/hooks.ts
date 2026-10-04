// Runs plugins/hooks/* at a hook point. Adding a hook = dropping a file; nothing here changes.
import { loadPlugins } from "./loader.ts";
import type { Hook, HookContext } from "./sdk.ts";

export const loadHooks = () => loadPlugins<Hook>("hooks");

export type HookPoint = "beforeTool" | "afterTool" | "beforeStop";
export type Verdict = { hook: string; block?: string; stop?: string };

// First hook that blocks or stops wins; undefined = everyone allowed.
export async function runHooks(hooks: Hook[], point: HookPoint, ctx: HookContext): Promise<Verdict | undefined> {
  for (const h of hooks) {
    const r = await h[point]?.(ctx);
    if (r && "block" in r) return { hook: h.name, block: r.block };
    if (r && "stop" in r) return { hook: h.name, stop: r.stop };
  }
}
