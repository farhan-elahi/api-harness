// Shared retry for drivers: transient provider errors only, same request (same model) every attempt, no fallback.
// SDK-level retries are turned off in the drivers so this is the only retry layer.
import type { RetryEvent } from "../core/sdk.ts";

const RETRY = new Set([429, 500, 502, 503, 529]);
const ATTEMPTS = 5;
const MAX_WAIT_MS = 60_000;

type HttpError = { status?: number; headers?: Headers | Record<string, string>; message?: string; name?: string; cause?: unknown };

const statusOf = (e: HttpError) => (typeof e.status === "number" ? e.status : undefined);
// SDK connection errors / fetch failures carry no status.
const isNetwork = (e: HttpError) => statusOf(e) === undefined && /connection|fetch|network|ECONN|ETIMEDOUT|socket|timed out/i.test(`${e.name} ${e.message}`);
const retryAfterMs = (e: HttpError) => {
  const h = e.headers;
  const v = h instanceof Headers ? h.get("retry-after") : h?.["retry-after"];
  if (!v) return undefined;
  const s = Number(v);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_WAIT_MS) : undefined;
};
const oneLine = (e: HttpError) => String(e.message ?? e).split("\n")[0]!.slice(0, 300);

// base ~2s -> waits ~2s/4s/8s/16s (+-25% jitter), or Retry-After when the provider sends it.
export async function withRetry<T>(fn: () => Promise<T>, opts: { baseMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<{ value: T; retries: RetryEvent[] }> {
  const base = opts.baseMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const retries: RetryEvent[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(), retries };
    } catch (err) {
      const e = err as HttpError;
      const status = statusOf(e);
      const transient = (status !== undefined && RETRY.has(status)) || isNetwork(e);
      if (!transient) throw err;
      if (attempt >= ATTEMPTS) throw new Error(`provider still failing after ${ATTEMPTS} attempts (${status ?? "network error"}): ${String(e.message ?? e)}`); // full text; the CLI redacts
      const waitMs = Math.round(retryAfterMs(e) ?? base * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      retries.push({ attempt, status, waitMs, error: oneLine(e) });
      console.log(`  retry ${attempt}/${ATTEMPTS - 1} after ${status ?? "network error"}, waiting ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}
