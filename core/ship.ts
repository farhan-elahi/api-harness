// The harness ships, the agent never does. Runs git/gh as subprocesses after the stop-gate is green:
// branch harness/<task>-<timestamp> (never main/master), stage an explicit file list, secret-scan the index,
// commit, push, open a PR. Never merges. Without a usable gh the result is UNPROVEN, never a fake pass.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { scanStaged } from "../scripts/check-secrets.ts";
import { runChecks, runTests } from "./runner.ts";
import { isSecretPath } from "./sdk.ts";

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const out = (cwd: string, ...args: string[]) => {
  const r = git(cwd, ...args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};
const existing = (p: string): string => (existsSync(p) ? p : existing(dirname(p)));
const repoOf = (p: string) => {
  const r = git(existing(resolve(p)), "rev-parse", "--show-toplevel");
  return r.status === 0 ? r.stdout.trim() : undefined;
};

// Before the run: the target must have no uncommitted changes, so the PR holds only the agent's work.
export function assertClean(root: string): void {
  if (!existsSync(root) || !repoOf(root)) return; // nothing there yet, or not a git repo (ship will say UNPROVEN)
  const dirty = out(root, "status", "--porcelain", "--", ".");
  if (dirty) throw new Error(`refusing to run: uncommitted changes in ${root} (commit or stash them first)\n${dirty}`);
}

// Create mode, after the final proof: remove the template's reference resource (src/routes/_example.ts, its test,
// every line in src/ that imports or uses its exports, the CREATE TABLE lines for its tables), then re-prove.
// Red after removal -> everything is restored and the run fails.
export async function stripExample(root: string, task: Record<string, unknown> = {}): Promise<{ ok: boolean; changed: string[]; reason?: string }> {
  const route = join(root, "src/routes/_example.ts");
  if (!existsSync(route)) return { ok: true, changed: [] };
  const src = readFileSync(route, "utf8");
  const names = [...src.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((m) => m[1]!);
  const tables = [...src.matchAll(/\w+Table\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]!);
  const uses = new RegExp([String.raw`_example(\.ts)?["']`, ...names.map((n) => `\\b${n}\\b`), ...tables.map((t) => String.raw`CREATE TABLE (IF NOT EXISTS )?["\`]?${t}\b`)].join("|"));

  const backup = new Map<string, string>();
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : /\.ts$/.test(f) ? [join(d, f)] : []));
  for (const f of [route, join(root, "test/_example.test.ts")].filter(existsSync)) {
    backup.set(f, readFileSync(f, "utf8"));
    rmSync(f);
  }
  for (const f of files(join(root, "src"))) {
    const text = readFileSync(f, "utf8");
    const kept = text.split("\n").filter((l) => !uses.test(l));
    if (kept.length === text.split("\n").length) continue;
    backup.set(f, text);
    writeFileSync(f, kept.join("\n"));
  }
  const changed = [...backup.keys()].map((f) => relative(root, f)).sort();
  const tests = runTests(root);
  const report = await runChecks(root, task);
  if (tests.ok && report.verdict === 100) return { ok: true, changed };
  for (const [f, text] of backup) writeFileSync(f, text);
  return { ok: false, changed, reason: `removing the example broke the API (tests ${tests.ok ? "ok" : "red"}, checks ${report.verdict}%): ${tests.failures[0] ?? ""}` };
}

export type ShipResult = { status: "shipped" | "UNPROVEN" | "blocked" | "skipped"; message: string; branch?: string; pr?: string; files?: string[] };
export type ShipOptions = {
  root: string; // project the run changed
  task: string; // task name, used in the branch name
  title: string;
  body: string;
  extra?: string[]; // other files of this run to include (e.g. its token report); only if inside the repo
  gh?: string; // gh binary (tests pass a stub)
  now?: Date;
};

export function ship(o: ShipOptions): ShipResult {
  const repo = repoOf(o.root);
  if (!repo) return { status: "UNPROVEN", message: `UNPROVEN not shipped: ${o.root} is not in a git repo` };
  const base = out(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const stamp = (o.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const branch = `harness/${o.task.replace(/[^\w.-]+/g, "-")}-${stamp}`;
  if (/^(main|master)$/.test(branch)) return { status: "blocked", message: `refusing to ship to ${branch}` };

  // Explicit list: what changed under the project (git's view, so .gitignore holds), minus secrets, deps and
  // other runs' token reports; plus this run's own files.
  const changed = git(o.root, "status", "--porcelain", "-z", "-uall", "--", ".").stdout // untrimmed; paths are repo-relative
    .split("\0")
    .filter(Boolean)
    .flatMap((e) => (/^[ MADRCU?!]{2} /.test(e) ? [e.slice(3)] : [])); // rename sources come as bare entries; skip them
  const extra = (o.extra ?? []).filter(existsSync).map((f) => relative(repo, realpathSync(f))).filter((f) => !f.startsWith("..") && !isAbsolute(f));
  const files = [...new Set([...changed.filter((f) => !/^tokens\//.test(f)), ...extra])].filter((f) => !isSecretPath(f) && !/(^|\/)node_modules(\/|$)/.test(f));
  if (!files.length) return { status: "skipped", message: "nothing to ship: no changed files" };

  out(repo, "checkout", "-q", "-b", branch);
  const current = out(repo, "rev-parse", "--abbrev-ref", "HEAD");
  if (/^(main|master)$/.test(current)) return { status: "blocked", message: `refusing to commit on ${current}` };
  const back = () => {
    git(repo, "reset", "-q");
    git(repo, "checkout", "-q", base);
    git(repo, "branch", "-q", "-D", branch);
  };
  out(repo, "add", "--", ...files);
  const hits = scanStaged(repo);
  if (hits.length) {
    back();
    return { status: "blocked", message: `secret scan blocked the commit:\n${hits.map((h) => `  ${h.file}:${h.line} ${h.kind}`).join("\n")}` };
  }
  const msg = join(mkdtempSync(join(tmpdir(), "harness-ship-")), "msg");
  writeFileSync(msg, `${o.title}\n\n${o.body}\n`);
  out(repo, "commit", "-q", "-F", msg);
  const push = git(repo, "push", "-q", "-u", "origin", branch);
  if (push.status !== 0) return { status: "UNPROVEN", message: `UNPROVEN committed on ${branch} but push failed: ${push.stderr.trim()}`, branch, files };

  const gh = o.gh ?? "gh";
  const auth = spawnSync(gh, ["auth", "status"], { cwd: repo, encoding: "utf8" });
  if (auth.error) return { status: "UNPROVEN", message: `UNPROVEN pushed ${branch}, but no PR: gh is not installed (https://cli.github.com), open it by hand`, branch, files };
  if (auth.status !== 0) return { status: "UNPROVEN", message: `UNPROVEN pushed ${branch}, but no PR: gh is not logged in (run gh auth login), open it by hand`, branch, files };
  writeFileSync(msg, o.body);
  const pr = spawnSync(gh, ["pr", "create", "--base", base, "--head", branch, "--title", o.title, "--body-file", msg], { cwd: repo, encoding: "utf8" });
  if (pr.status !== 0) return { status: "UNPROVEN", message: `UNPROVEN pushed ${branch}, but gh pr create failed: ${(pr.stderr || pr.stdout).trim()}`, branch, files };
  const url = pr.stdout.trim().split("\n").at(-1) ?? "";
  return { status: "shipped", message: `PR opened: ${url}`, branch, pr: url, files };
}
