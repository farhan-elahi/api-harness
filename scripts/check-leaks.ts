// Fails if a vendor/model name appears outside drivers/. Run by `npm run verify`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["core", "plugins", "tasks"];
const PATTERN = /anthropic|openai|claude|gpt|deepseek|grok/i;

const files = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

const hits = DIRS.flatMap(files).flatMap((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .flatMap((line, i) => (PATTERN.test(line) || PATTERN.test(f) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
);

console.log(hits.length ? hits.join("\n") : "");
console.log(`leak-check  ${hits.length ? "FAIL" : "pass"}  ${hits.length} hits in ${DIRS.join("/ ")}/`);
process.exit(hits.length ? 1 : 0);
