// Fails on anything key-shaped in tracked files or the staged index. Run by `npm run verify` and by the ship step.
// bun scripts/check-secrets.ts [dir]   (default: this repo)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATTERNS: [string, RegExp][] = [
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ["openai-style key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];

export type Hit = { file: string; line: number; kind: string };

export function scanText(file: string, text: string): Hit[] {
  return text.split("\n").flatMap((l, i) => PATTERNS.filter(([, re]) => re.test(l)).map(([kind]) => ({ file, line: i + 1, kind })));
}

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
const list = (cwd: string, ...args: string[]) => git(cwd, ...args, "-z").stdout.split("\0").filter(Boolean);

// Staged (index) content of every staged file; never prints the secret itself.
export function scanStaged(cwd: string): Hit[] {
  return list(cwd, "diff", "--cached", "--name-only", "--diff-filter=ACMR").flatMap((f) => scanText(f, git(cwd, "show", `:${f}`).stdout));
}

// Every tracked file as it is on disk, plus the staged index.
export function scanRepo(cwd: string): Hit[] {
  const tracked = list(cwd, "ls-files").flatMap((f) => {
    try {
      return scanText(f, readFileSync(join(cwd, f), "utf8"));
    } catch {
      return []; // deleted on disk, or a directory (submodule)
    }
  });
  return [...tracked, ...scanStaged(cwd)];
}

if (import.meta.main) {
  const hits = scanRepo(process.argv[2] ?? process.cwd());
  for (const h of hits) console.log(`${h.file}:${h.line} ${h.kind}`);
  console.log(`secret-check  ${hits.length ? "FAIL" : "pass"}  ${hits.length} hits`);
  process.exit(hits.length ? 1 : 0);
}
