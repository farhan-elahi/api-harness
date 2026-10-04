// Public contract for drivers and plugins. Plugin authors import from here; they never edit it.
import { resolve, relative, isAbsolute } from "node:path";
import type { Project as AstProject } from "ts-morph";

export type JSONSchema = Record<string, unknown>;

// Neutral message format. Drivers translate to/from their vendor format.
// `raw` is opaque driver data (e.g. reasoning blocks) round-tripped unchanged; core never reads it.
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ToolResult = { id: string; output: string; isError?: boolean };
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export type Usage = { input: number; output: number };
export type Reply = {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stop: "end" | "tool" | "pause" | "limit";
  raw?: unknown;
};

export type ToolSpec = { name: string; description: string; input: JSONSchema };

export interface Driver {
  send(system: string, messages: Message[], tools: ToolSpec[]): Promise<Reply>;
}
// drivers/<module>.ts default-exports one of these; config comes from drivers/drivers.yaml.
export type DriverFactory = (config: Record<string, unknown>) => Driver;

export type ToolContext = { root: string; runDir: string };
export type Tool = ToolSpec & {
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
};

export const defineTool = (t: Tool): Tool => t;

// Checks, validators and lint rules share one contract. Each returns one result per thing it inspected.
export type CheckResult = { file: string; line: number; pass: boolean; message: string };
export type CheckContext = {
  dir: string; // absolute path of the API under check
  files: string[]; // absolute paths of its .ts files (no node_modules, no .d.ts)
  ast: () => AstProject; // ts-morph program for the API (type-aware); throws Unproven if it can't load
};
export type Check = {
  name: string;
  unit: string; // what results count, e.g. "routes", "handlers"
  run: (ctx: CheckContext) => CheckResult[] | Promise<CheckResult[]>;
};
export const defineCheck = (c: Check): Check => c;

// Throw from a check that cannot run. It prints UNPROVEN and blocks a 100% verdict.
export class Unproven extends Error {}

// .env, .env.* (except .env.example), *.pem, *.key, anything under .git/
export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  const base = parts.at(-1) ?? "";
  return (
    parts.includes(".git") ||
    ((base === ".env" || base.startsWith(".env.")) && base !== ".env.example") ||
    /\.(pem|key)$/i.test(base)
  );
}

// Resolve a model-supplied path inside root; throws on escape or secret file.
export function inRoot(root: string, p: unknown): string {
  if (typeof p !== "string" || !p) throw new Error("path must be a non-empty string");
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes project root: ${p}`);
  if (isSecretPath(rel)) throw new Error("blocked: secret file");
  return abs;
}

// Mask anything key-shaped before it hits a transcript, log or console.
export function redact(s: string): string {
  for (const [k, v] of Object.entries(process.env))
    if (v && v.length >= 8 && /(_KEY|_TOKEN)$/.test(k)) s = s.replaceAll(v, "[REDACTED]");
  return s
    .replace(/\bsk-ant-[\w-]+/g, "[REDACTED]")
    .replace(/\bsk-[\w-]{16,}/g, "[REDACTED]")
    .replace(/\b(\w*(?:_KEY|_TOKEN))(\s*[=:]\s*["']?)[^\s"',}]+/g, "$1$2[REDACTED]");
}
