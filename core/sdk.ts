// Public contract for drivers and plugins. Plugin authors import from here; they never edit it.
import { resolve, relative, isAbsolute } from "node:path";

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

// Resolve a model-supplied path inside root; throws on escape.
export function inRoot(root: string, p: unknown): string {
  if (typeof p !== "string" || !p) throw new Error("path must be a non-empty string");
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes project root: ${p}`);
  return abs;
}
