// Token report: tokens/<run_id>.json, written on every run. Numbers are the driver's usage field, never estimates.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Usage } from "./sdk.ts";
import type { Mode } from "./context.ts";

export type TurnTokens = { turn: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
export type TokenReport = {
  run_id: string;
  driver: string;
  task: string;
  task_hash: string;
  mode: Mode;
  turns: TurnTokens[];
  total_input_tokens: number; // includes cache reads + writes
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  baseline?: Omit<TokenReport, "baseline" | "comparison" | "reduction_pct"> & { completed?: boolean; turn_limit?: number };
  comparison?: { turn: number; baseline_input_tokens: number | null; actual_input_tokens: number | null }[];
  reduction_pct?: number; // 100 * (1 - actual input / baseline input), over the compared turns
};

export const taskHash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");

export const turnTokens = (turn: number, u: Usage): TurnTokens => ({
  turn,
  input_tokens: u.input,
  output_tokens: u.output,
  cache_read_tokens: u.cacheRead ?? 0,
  cache_write_tokens: u.cacheWrite ?? 0,
});

export function tokenReport(meta: { run_id: string; driver: string; task: string; task_hash: string; mode: Mode }, turns: TurnTokens[]): TokenReport {
  const sum = (k: keyof TurnTokens) => turns.reduce((a, t) => a + t[k], 0);
  return {
    ...meta,
    turns,
    total_input_tokens: sum("input_tokens"),
    total_output_tokens: sum("output_tokens"),
    total_cache_read_tokens: sum("cache_read_tokens"),
    total_cache_write_tokens: sum("cache_write_tokens"),
  };
}

// limit: the baseline was capped at N turns (--baseline-turns), so compare matching turns 1..N only.
export function compare(actual: TokenReport, baseline: TokenReport, b: { completed?: boolean; limit?: number } = {}): TokenReport {
  if (actual.driver !== baseline.driver || actual.task_hash !== baseline.task_hash) throw new Error("baseline must be the same task and driver");
  const n = b.limit ? Math.min(b.limit, actual.turns.length, baseline.turns.length) : Math.max(actual.turns.length, baseline.turns.length);
  const comparison = Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    baseline_input_tokens: baseline.turns[i]?.input_tokens ?? null,
    actual_input_tokens: actual.turns[i]?.input_tokens ?? null,
  }));
  const { baseline: _b, comparison: _c, reduction_pct: _r, ...base } = baseline;
  const sum = (k: "baseline_input_tokens" | "actual_input_tokens") => comparison.reduce((a, r) => a + (r[k] ?? 0), 0);
  const [bIn, aIn] = b.limit ? [sum("baseline_input_tokens"), sum("actual_input_tokens")] : [baseline.total_input_tokens, actual.total_input_tokens];
  const pct = bIn ? Math.round(1000 * (1 - aIn / bIn)) / 10 : 0;
  const meta = { ...(b.completed !== undefined && { completed: b.completed }), ...(b.limit && { turn_limit: b.limit }) };
  return { ...actual, baseline: { ...base, ...meta }, comparison, reduction_pct: pct };
}

export function writeTokens(r: TokenReport, dir = resolve("tokens")): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${r.run_id}.json`);
  writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
  return p;
}
