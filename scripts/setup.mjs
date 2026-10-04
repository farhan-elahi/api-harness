// npm run setup — plain Node so it works on a fresh clone before Bun exists. Never reads or prints keys.
import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";

const shell = process.platform === "win32";
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", shell, ...opts }).status === 0;
const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore", shell }).status === 0;
const step = (s) => console.log(`\n▶ ${s}`);
const fail = (s) => (console.error(`\n✖ ${s}`), process.exit(1));

step("Bun");
if (!has("bun")) {
  console.log("Bun not found. Installing: npm i -g bun");
  if (!run("npm", ["i", "-g", "bun"]) || !has("bun"))
    fail("Bun not found. Install it manually: npm i -g bun  (or see https://bun.sh), then rerun npm run setup");
}
run("bun", ["--version"]);

step("Dependencies");
if (!run("bun", ["install"])) fail("bun install failed");
if (existsSync("template/package.json") && !run("bun", ["install"], { cwd: "template" })) fail("bun install in template/ failed");

step("git / gh");
for (const [cmd, why] of [["git", "needed to ship branches"], ["gh", "needed to open PRs"]])
  console.log(has(cmd) ? `✔ ${cmd}` : `⚠ ${cmd} not found (${why}); runs still work without it`);
if (existsSync(".git") && run("git", ["config", "core.hooksPath", ".githooks"])) console.log("✔ pre-push hook: npm run verify");

step(".env");
if (existsSync(".env")) console.log("✔ .env exists (not touched)");
else (copyFileSync(".env.example", ".env"), console.log("✔ created .env from .env.example"));

step("Offline tests + typecheck");
if (!run("bun", ["test"])) fail("tests failed");
if (!run("bun", ["run", "typecheck"])) fail("typecheck failed");

console.log(`
✔ Setup complete. Next:
  1. Put your API key(s) in .env (ANTHROPIC_API_KEY for --driver claude).
  2. bun harness run tasks/hello.yaml --driver claude
  3. Output lands in generated/<task>/, logs in runs/<id>/.`);
