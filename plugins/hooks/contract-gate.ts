// Breaking-change gate (task mode: change). Snapshots every route's contract before the first tool call and again
// when the agent wants to stop; blocks removed routes, removed response fields, stricter request types, new required
// request fields and dropped status codes. Adding routes, optional request fields or response fields is fine.
// Contracts come from the code: Hono routes (_hono.ts) + the Zod schemas in validate()/respond(), read via the type checker.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Node, Project, type Type } from "ts-morph";
import { allow, block, defineHook, Unproven } from "../../core/sdk.ts";
import { calleeName, callsIn, ctxCalls, hono, label, literal, middlewareFor, num, reachable } from "../checks/_hono.ts";

export type Fields = Record<string, { type: string; optional: boolean }>; // "json.title" -> string, required
export type Contract = Record<string, { at: string; request: Fields; response: Record<string, Fields> }>; // "GET /v1/x" -> status -> fields

const BEFORE = "contract-before.json";

// Zod schema expression -> flat field map of its input or output type.
function fields(schema: Node | undefined, side: "_input" | "_output", prefix = ""): Fields {
  const sym = schema?.getType().getProperty(side);
  const out: Fields = {};
  if (schema && sym) walk(sym.getTypeAtLocation(schema), prefix, false, out, 0);
  return out;
}
function walk(t: Type, path: string, optional: boolean, out: Fields, depth: number): void {
  if (t.isUnion() && t.getUnionTypes().some((u) => u.isUndefined())) {
    const rest = t.getUnionTypes().filter((u) => !u.isUndefined());
    if (rest.length === 1) return walk(rest[0]!, path, true, out, depth);
    optional = true;
  }
  if (t.isArray()) return walk(t.getArrayElementTypeOrThrow(), `${path}[]`, optional, out, depth + 1);
  if (t.isObject() && !t.getCallSignatures().length && t.getProperties().length && depth < 6) {
    if (path) out[path] = { type: "object", optional };
    for (const p of t.getProperties()) {
      const d = p.getValueDeclaration() ?? p.getDeclarations()[0];
      const pt = d ? p.getTypeAtLocation(d) : p.getDeclaredType();
      walk(pt, path ? `${path}.${p.getName()}` : p.getName(), p.isOptional(), out, depth + 1);
    }
    return;
  }
  out[path] = { type: t.getText(undefined, 0).replace(/import\([^)]*\)\./g, "").replace(/ \| undefined$/, ""), optional };
}

export function snapshot(root: string): Contract {
  if (!existsSync(join(root, "tsconfig.json"))) return {};
  const p = new Project({ tsConfigFilePath: join(root, "tsconfig.json") });
  let h;
  try {
    h = hono(p);
  } catch (e) {
    if (e instanceof Unproven) return {}; // no Hono app: nothing to protect
    throw e;
  }
  const out: Contract = {};
  for (const r of h.routes) {
    const request: Fields = {};
    for (const m of middlewareFor(h, r).filter((m) => m.name === "validate"))
      Object.assign(request, fields(m.args[1], "_input", literal(m.args[0])));
    const response: Record<string, Fields> = {};
    const add = (status: number, f: Fields) => (response[status] = { ...response[status], ...f });
    for (const c of reachable(r).flatMap(callsIn).filter((c) => calleeName(c) === "respond")) add(num(c.getArguments()[3]) ?? 200, fields(c.getArguments()[1], "_output"));
    for (const { name, call } of ctxCalls(r, "")) if (["json", "body", "text"].includes(name)) add(num(call.getArguments()[1]) ?? 200, {});
    out[label(r)] = { at: `${relative(root, r.file)}:${r.line}`, request, response };
  }
  return out;
}

// a's union members all appear in b (b accepts everything a did).
const within = (a: string, b: string) => a.split(" | ").every((m) => b.split(" | ").includes(m));

export function breaks(before: Contract, after: Contract): string[] {
  const out: string[] = [];
  for (const [route, b] of Object.entries(before)) {
    const a = after[route];
    if (!a) {
      out.push(`${b.at} ${route}: route removed`);
      continue;
    }
    const at = `${a.at} ${route}:`;
    for (const [status, bf] of Object.entries(b.response)) {
      const af = a.response[status];
      if (!af) {
        out.push(`${at} status ${status} no longer returned (now ${Object.keys(a.response).join(", ") || "none"})`);
        continue;
      }
      for (const [f, x] of Object.entries(bf)) {
        const y = af[f];
        if (!y) out.push(`${at} response field ${f} removed`);
        else if (!within(y.type, x.type)) out.push(`${at} response field ${f} changed type ${x.type} -> ${y.type}`);
        else if (!x.optional && y.optional) out.push(`${at} response field ${f} is no longer always present`);
      }
    }
    for (const [f, y] of Object.entries(a.request)) {
      const x = b.request[f];
      if (!x && !y.optional) out.push(`${at} new required request field ${f}`);
      else if (x && x.optional && !y.optional) out.push(`${at} request field ${f} is now required`);
      else if (x && !within(x.type, y.type)) out.push(`${at} request field ${f} is stricter: ${x.type} -> ${y.type}`);
    }
  }
  return out;
}

export default defineHook({
  name: "contract-gate",
  beforeTool: ({ root, runDir, task }) => {
    if (task.mode === "change" && !existsSync(join(runDir, BEFORE))) writeFileSync(join(runDir, BEFORE), JSON.stringify(snapshot(root), null, 2));
    return allow;
  },
  beforeStop: ({ root, runDir, task }) => {
    if (task.mode !== "change" || !existsSync(join(runDir, BEFORE))) return allow;
    const after = snapshot(root);
    writeFileSync(join(runDir, "contract-after.json"), JSON.stringify(after, null, 2));
    const found = breaks(JSON.parse(readFileSync(join(runDir, BEFORE), "utf8")) as Contract, after);
    return found.length ? block(["Breaking API change; existing clients would break. Keep the old contract (add, don't change):", ...found].join("\n")) : allow;
  },
});
