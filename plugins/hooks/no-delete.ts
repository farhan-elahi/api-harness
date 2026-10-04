// Existing files can't be deleted or emptied. In brownfield (task mode: change), rewrites can't drop exports or routes.
import { existsSync, readFileSync } from "node:fs";
import { Project } from "ts-morph";
import { allow, block, defineHook, inRoot } from "../../core/sdk.ts";

const DELETING = /delete|remove|unlink|rm|rename|move/i;

const exportsOf = (src: string) =>
  new Set(new Project({ useInMemoryFileSystem: true }).createSourceFile("f.ts", src).getExportedDeclarations().keys());
// NOTE: route literals by regex (app.get("/x") / router.post('/x')); dynamic paths aren't seen.
const routesOf = (src: string) =>
  new Set([...src.matchAll(/\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`));

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
    const next = call!.input.content;
    if (typeof next !== "string") return allow;
    const prev = readFileSync(abs, "utf8");
    if (prev.trim() && !next.trim()) return block(`${p} exists; emptying it is not allowed`);
    if (task.mode !== "change" || !/\.tsx?$/.test(p)) return allow;
    const keep = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
    const lost = [...keep(exportsOf(prev), exportsOf(next)).map((e) => `export ${e}`), ...keep(routesOf(prev), routesOf(next)).map((r) => `route ${r}`)];
    return lost.length ? block(`${p}: existing API must keep working; removed ${lost.join(", ")}`) : allow;
  },
});
