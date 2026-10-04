// Existing files can't be deleted or emptied. In brownfield (task mode: change), rewrites can't drop exports or routes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Project } from "ts-morph";
import { allow, block, defineHook, inRoot, Unproven } from "../../core/sdk.ts";
import { hono } from "../checks/_hono.ts";
import { nextContent } from "./_write.ts";

const DELETING = /delete|remove|unlink|rm|rename|move/i;

const exportsOf = (src: string) =>
  new Set(new Project({ useInMemoryFileSystem: true }).createSourceFile("f.ts", src).getExportedDeclarations().keys());
// Every Hono route (METHOD /full/path) in the project, optionally with one file's text swapped in.
function routesOf(root: string, file: string, text?: string): Set<string> {
  const tsconfig = join(root, "tsconfig.json");
  if (!existsSync(tsconfig)) return new Set();
  const p = new Project({ tsConfigFilePath: tsconfig });
  if (text !== undefined) p.createSourceFile(file, text, { overwrite: true });
  try {
    return new Set(hono(p).routes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
  } catch (e) {
    if (e instanceof Unproven) return new Set(); // no Hono app: nothing to protect
    throw e;
  }
}

export default defineHook({
  name: "no-delete",
  beforeTool: ({ call, root, task }) => {
    const p = call?.input.path;
    if (typeof p !== "string") return allow;
    let abs: string;
    try {
      abs = inRoot(root, p);
    } catch {
      return allow; // outside root or secret: path-guard's call, and we never read it
    }
    if (!existsSync(abs)) return allow;
    if (DELETING.test(call!.name)) return block(`${p} exists; deleting or moving existing files is not allowed`);
    const next = nextContent(call, root);
    if (typeof next !== "string") return allow;
    const prev = readFileSync(abs, "utf8");
    if (prev.trim() && !next.trim()) return block(`${p} exists; emptying it is not allowed`);
    if (task.mode !== "change" || !/\.tsx?$/.test(p)) return allow;
    const keep = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
    const lost = [...keep(exportsOf(prev), exportsOf(next)).map((e) => `export ${e}`), ...keep(routesOf(root, abs), routesOf(root, abs, next)).map((r) => `route ${r}`)];
    return lost.length ? block(`${p}: existing API must keep working; removed ${lost.join(", ")}`) : allow;
  },
});
