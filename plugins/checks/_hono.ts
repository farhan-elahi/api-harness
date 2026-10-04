// Shared AST helpers for Hono APIs (underscore = not a plugin). Type-aware via ts-morph, no regex on code.
import { Node, SyntaxKind, type CallExpression, type Project, type SourceFile } from "ts-morph";
import { Unproven } from "../../core/sdk.ts";

export const WRITE = new Set(["post", "put", "patch", "delete"]);
const METHODS = new Set(["get", ...WRITE]);

export type Mw = { name: string; call: Node; args: Node[] };
export type Route = {
  method: string;
  path: string;
  call: CallExpression;
  file: string;
  line: number;
  router: object; // key of the router the route is registered on
  mw: Mw[];
  handler?: Node; // function node of the final handler
  ctx?: string; // name of the handler's Context parameter
};
type Mount = { parent: object; prefix: string; call: CallExpression };
export type Hono = { routes: Route[]; uses: { router: object; call: CallExpression; mw: Mw[] }[]; mounts: Map<object, Mount> };

export const appFiles = (p: Project): SourceFile[] =>
  p.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && !/\/node_modules\/|\.test\.ts$|\/test\//.test(sf.getFilePath()));

export const literal = (n: Node | undefined): string | undefined =>
  n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) ? n.getLiteralValue() : undefined;

export const num = (n: Node | undefined): number | undefined => (n && Node.isNumericLiteral(n) ? n.getLiteralValue() : undefined);

const isHono = (n: Node) => /\bHono</.test(n.getType().getText());

// Declaration a reference resolves to (through imports), or the node itself.
export function decl(n: Node): Node {
  if (!Node.isIdentifier(n)) return n;
  const sym = n.getSymbol();
  return (sym?.getAliasedSymbol() ?? sym)?.getDeclarations()[0] ?? n;
}

// Leftmost receiver of a call chain: a.b(...).c(...) -> a
function root(n: Node): Node {
  for (;;) {
    if (Node.isCallExpression(n)) n = n.getExpression();
    else if (Node.isPropertyAccessExpression(n)) n = n.getExpression();
    else return n;
  }
}
const routerKey = (receiver: Node): object => decl(root(receiver)).compilerNode;

export function calleeName(call: CallExpression): string {
  const e = call.getExpression();
  return Node.isPropertyAccessExpression(e) ? e.getName() : e.getText();
}

export function fnBody(n: Node | undefined): Node | undefined {
  if (!n) return undefined;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n)) return n;
  if (Node.isIdentifier(n)) {
    const d = decl(n);
    if (Node.isFunctionDeclaration(d)) return d;
    if (Node.isVariableDeclaration(d)) return fnBody(d.getInitializer());
  }
  return undefined;
}

const mwOf = (n: Node): Mw =>
  Node.isCallExpression(n) ? { name: calleeName(n), call: n, args: n.getArguments() } : { name: n.getText(), call: n, args: [] };

const join = (...parts: string[]) => ("/" + parts.join("/")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");

const cache = new WeakMap<Project, Hono>();

export function hono(p: Project): Hono {
  const hit = cache.get(p);
  if (hit) return hit;
  const calls = appFiles(p).flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression));
  const viaHono = calls.flatMap((call) => {
    const e = call.getExpression();
    return Node.isPropertyAccessExpression(e) && isHono(e.getExpression()) ? [{ call, name: e.getName(), receiver: e.getExpression() }] : [];
  });
  if (!viaHono.length) throw new Unproven("no Hono app found (framework not detected or deps not installed)");

  const mounts = new Map<object, Mount>();
  for (const { call, name, receiver } of viaHono) {
    const [prefix, child] = call.getArguments();
    if (name === "route" && literal(prefix) !== undefined && child)
      mounts.set(decl(child).compilerNode, { parent: routerKey(receiver), prefix: literal(prefix)!, call });
  }
  const basePath = (key: object): string => {
    const d = viaHono.find((v) => v.name === "basePath" && routerKey(v.receiver) === key);
    return literal(d?.call.getArguments()[0]) ?? "";
  };
  const prefixOf = (key: object, seen = new Set<object>()): string => {
    const m = mounts.get(key);
    if (seen.has(key)) return "";
    seen.add(key);
    return join(m ? prefixOf(m.parent, seen) : "", m?.prefix ?? "", basePath(key));
  };

  const routes: Route[] = [];
  const uses: Hono["uses"] = [];
  for (const { call, name, receiver } of viaHono) {
    const args = call.getArguments();
    if (name === "use") uses.push({ router: routerKey(receiver), call, mw: args.filter((a) => literal(a) === undefined).map(mwOf) });
    if (!METHODS.has(name) || literal(args[0]) === undefined) continue;
    const router = routerKey(receiver);
    const handler = fnBody(args.at(-1));
    const param = handler && "getParameters" in handler ? (handler as { getParameters(): { getName(): string }[] }).getParameters()[0] : undefined;
    routes.push({
      method: name,
      path: join(prefixOf(router), literal(args[0])!),
      call,
      file: call.getSourceFile().getFilePath(),
      line: call.getStartLineNumber(),
      router,
      mw: args.slice(1, -1).map(mwOf),
      handler,
      ctx: param?.getName(),
    });
  }
  const out = { routes, uses, mounts };
  cache.set(p, out);
  return out;
}

// Router chain from a route's router up to the root app: [{ router, before: position that middleware must precede }]
export function chain(h: Hono, r: Route): { router: object; before: CallExpression }[] {
  const out = [{ router: r.router, before: r.call }];
  for (let m = h.mounts.get(r.router); m && out.length < 20; m = h.mounts.get(m.parent)) out.push({ router: m.parent, before: m.call });
  return out;
}

// Middleware applied to a route: its own args plus router-level .use() registered before it.
export function middlewareFor(h: Hono, r: Route): Mw[] {
  const inherited = chain(h, r).flatMap(({ router, before }) =>
    h.uses
      .filter((u) => u.router === router)
      .filter((u) => u.call.getSourceFile() !== before.getSourceFile() || u.call.getStart() < before.getStart())
      .flatMap((u) => u.mw),
  );
  return [...inherited, ...r.mw];
}

export const callsIn = (n: Node | undefined): CallExpression[] => (n ? n.getDescendantsOfKind(SyntaxKind.CallExpression) : []);

// Calls on the handler's context: c.json(...), c.req.param(...) -> matched by the text before the method name.
export function ctxCalls(r: Route, receiver: string): { name: string; call: CallExpression }[] {
  if (!r.ctx) return [];
  return callsIn(r.handler).flatMap((call) => {
    const e = call.getExpression();
    return Node.isPropertyAccessExpression(e) && e.getExpression().getText() === `${r.ctx}${receiver}` ? [{ name: e.getName(), call }] : [];
  });
}

// Function bodies the handler calls directly (one level), for checks that follow helper functions.
export function reachable(r: Route): Node[] {
  const own = r.handler ? [r.handler] : [];
  const helpers = callsIn(r.handler).flatMap((c) => {
    const e = c.getExpression();
    const f = Node.isIdentifier(e) ? fnBody(e) : undefined;
    return f && f.getSourceFile() === r.handler?.getSourceFile() ? [f] : [];
  });
  return [...own, ...helpers];
}

export const rel = (r: Route) => ({ file: r.file, line: r.line });
export const label = (r: Route) => `${r.method.toUpperCase()} ${r.path}`;
