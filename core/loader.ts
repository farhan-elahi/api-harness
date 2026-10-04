// Auto-discovers plugins and resolves drivers. Adding a plugin = dropping a file; nothing here changes.
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Driver, DriverFactory, Tool } from "./sdk.ts";

const ROOT = resolve(import.meta.dir, "..");

export async function loadPlugins<T extends { name: string }>(kind: string): Promise<T[]> {
  const dir = join(ROOT, "plugins", kind);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /\.ts$/.test(f) && !f.startsWith("_")).sort();
  const mods = await Promise.all(files.map((f) => import(join(dir, f))));
  return mods.map((m, i) => {
    if (!m.default?.name) throw new Error(`plugins/${kind}/${files[i]}: missing default export with a name`);
    return m.default as T;
  });
}

export const loadTools = () => loadPlugins<Tool>("tools");

export async function loadDriver(name: string): Promise<Driver> {
  const all = Bun.YAML.parse(readFileSync(join(ROOT, "drivers", "drivers.yaml"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  const cfg = all[name];
  if (!cfg) throw new Error(`unknown driver "${name}". Known: ${Object.keys(all).join(", ")}`);
  const mod = await import(join(ROOT, "drivers", String(cfg.module)));
  return (mod.default as DriverFactory)(cfg);
}
