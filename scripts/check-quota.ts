// Quota check before live runs: one tiny raw request per configured driver that has a key (no retries, so a 429
// shows as 429), then OpenRouter key limits and tool-capable models. Run: bun scripts/check-quota.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const drivers = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../drivers/drivers.yaml"), "utf8")) as Record<string, Record<string, string>>;
const OR = "https://openrouter.ai/api/v1";

async function ping(cfg: Record<string, string>, key: string): Promise<string> {
  const msg = [{ role: "user", content: "hi" }];
  const r =
    cfg.module === "claude.ts"
      ? await fetch(`${cfg.base_url ?? "https://api.anthropic.com"}/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: cfg.model, max_tokens: 1, messages: msg }),
        })
      : await fetch(`${(cfg.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: cfg.model, max_completion_tokens: 16, messages: msg }),
        });
  if (r.ok) return "ok";
  const body = (await r.text()).replace(/\s+/g, " ").slice(0, 160);
  return `${r.status} ${body}`;
}

console.log("driver quota (one tiny request each):");
for (const [name, cfg] of Object.entries(drivers)) {
  const key = process.env[cfg.key_env ?? ""];
  if (!key) {
    console.log(`  ${name.padEnd(11)} skipped (${cfg.key_env} not set)`);
    continue;
  }
  const res = await ping(cfg, key).catch((e: Error) => `network error: ${e.message}`);
  console.log(`  ${name.padEnd(11)} ${cfg.model}: ${res}`);
}

const orKey = process.env.OPENROUTER_API_KEY;
if (orKey) {
  const r = await fetch(`${OR}/key`, { headers: { authorization: `Bearer ${orKey}` } });
  const k = r.ok ? ((await r.json()) as { data: Record<string, unknown> }).data : undefined;
  console.log(`\nopenrouter key: ${k ? `limit=${k.limit ?? "none"} usage=${k.usage} limit_remaining=${k.limit_remaining ?? "n/a"} is_free_tier=${k.is_free_tier}` : `HTTP ${r.status}`}`);
}

type Model = { id: string; created: number; context_length: number; supported_parameters?: string[]; pricing: { prompt: string; completion: string } };
const models = ((await (await fetch(`${OR}/models`)).json()) as { data: Model[] }).data.filter((m) => m.supported_parameters?.includes("tools"));
const perM = (p: string) => `$${(Number(p) * 1e6).toFixed(2)}/M`;
const free = models.filter((m) => m.id.endsWith(":free") || (Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0));
console.log(`\n(a) free models with tool support (${free.length}):`);
for (const m of free.sort((a, b) => b.created - a.created)) console.log(`  ${m.id}  ctx=${m.context_length}`);
// ponytail: "strong" = newest paid tool model from each frontier lab; eyeball the list, not a benchmark.
console.log("\n(b) strong paid models with tool support (input / output):");
for (const lab of ["anthropic/", "openai/", "google/"]) {
  const m = models.filter((x) => x.id.startsWith(lab) && Number(x.pricing.prompt) > 0).sort((a, b) => b.created - a.created)[0];
  if (m) console.log(`  ${m.id}  ${perM(m.pricing.prompt)} / ${perM(m.pricing.completion)}  ctx=${m.context_length}`);
}
