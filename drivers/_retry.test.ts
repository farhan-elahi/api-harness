// Offline: transient provider errors are retried with backoff (same model), others fail fast. Fake server, no network.
import { test, expect, afterAll } from "bun:test";
import claude from "./claude.ts";
import openai from "./openai-compatible.ts";
import { withRetry } from "./_retry.ts";

let script: number[] = []; // status per request; 200 = success
const models: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    models.push(((await req.json()) as { model: string }).model);
    const status = script.shift() ?? 200;
    if (status !== 200) return Response.json({ error: { message: `fake ${status}` } }, { status });
    return req.url.endsWith("/messages")
      ? Response.json({ id: "m", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
      : Response.json({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  },
});
afterAll(() => server.stop());
process.env.FAKE_KEY = "k";
const drivers = {
  openai: () => openai({ key_env: "FAKE_KEY", base_url: `http://localhost:${server.port}/v1`, model: "pinned", retry_base_ms: 1 }),
  claude: () => claude({ key_env: "FAKE_KEY", base_url: `http://localhost:${server.port}`, model: "pinned", retry_base_ms: 1 }),
};
const send = (d: keyof typeof drivers) => drivers[d]().send("s", [{ role: "user", text: "go" }], []);

for (const d of ["openai", "claude"] as const) {
  test(`${d}: 503 then success -> one retry logged on the reply, same model`, async () => {
    script = [503];
    models.length = 0;
    const r = await send(d);
    expect(r.text).toBe("ok");
    expect(r.retries).toHaveLength(1);
    expect(r.retries![0]).toMatchObject({ attempt: 1, status: 503 });
    expect(models).toEqual(["pinned", "pinned"]);
  });

  test(`${d}: 400 / 401 / 403 -> no retry`, async () => {
    for (const s of [400, 401, 403]) {
      script = [s];
      models.length = 0;
      await expect(send(d)).rejects.toThrow();
      expect(models).toHaveLength(1);
    }
  });

  test(`${d}: 5x 503 -> clear one-line error after the last attempt`, async () => {
    script = [503, 503, 503, 503, 503];
    models.length = 0;
    const err = await send(d).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^provider still failing after 5 attempts \(503\): /);
    expect((err as Error).message).not.toContain("\n");
    expect(models).toHaveLength(5);
  });
}

test("backoff ~2s/4s/8s/16s with jitter; Retry-After wins; network errors retried", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const fail = (status?: number, headers?: Record<string, string>) => Object.assign(new Error(status ? `HTTP ${status}` : "Connection error."), { status, headers });
  await withRetry(async () => { throw fail(529); }, { sleep }).catch(() => {});
  expect(waits).toHaveLength(4);
  waits.forEach((w, i) => {
    expect(w).toBeGreaterThanOrEqual(1500 * 2 ** i);
    expect(w).toBeLessThanOrEqual(2500 * 2 ** i);
  });

  waits.length = 0;
  let n = 0;
  const r = await withRetry(async () => (n++ ? "ok" : Promise.reject(fail(429, { "retry-after": "7" }))), { sleep });
  expect(r.value).toBe("ok");
  expect(waits).toEqual([7000]);

  n = 0;
  const net = await withRetry(async () => (n++ ? "ok" : Promise.reject(fail())), { sleep });
  expect(net.retries).toHaveLength(1);
});
