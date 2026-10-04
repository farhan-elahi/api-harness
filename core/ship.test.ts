// Ship step, example stripping, brownfield test baseline, secret scan, sample API. Offline: temp git repo with a
// local bare remote, a stub gh, and the scripted driver.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scripted } from "../drivers/fake.ts";
import { scanText } from "../scripts/check-secrets.ts";
import { assemble } from "../scripts/fixture.ts";
import { run } from "./loop.ts";
import { runChecks, runTests } from "./runner.ts";
import { assertClean, ship, stripExample } from "./ship.ts";
import testBaseline from "../plugins/hooks/test-baseline.ts";

const T = 120_000;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();
const KEY = ["gh", "p_", "a".repeat(36)].join(""); // built at runtime so this file never matches the scanner

// repo with a committed api/ dir, a bare origin, and a stub gh that logs its args.
function repo(ghAuth = 0) {
  const dir = tmp("harness-ship-");
  const remote = tmp("harness-remote-");
  git(remote, "init", "-q", "--bare");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "api/src"), { recursive: true });
  writeFileSync(join(dir, "api/src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", remote);
  const gh = join(dir, "..", `gh-stub-${Math.random().toString(36).slice(2)}`);
  writeFileSync(gh, `#!/bin/sh\necho "$@" >> "${gh}.log"\n[ "$1" = auth ] && exit ${ghAuth}\necho https://example.test/pr/1\n`);
  chmodSync(gh, 0o755);
  return { dir, remote, gh, api: join(dir, "api") };
}
const opts = (r: ReturnType<typeof repo>, extra: object = {}) => ({ root: r.api, task: "notes", title: "harness: notes", body: "b", gh: r.gh, now: new Date("2026-10-04T12:00:00Z"), ...extra });

test("ship: harness/<task>-<ts> branch, explicit files only (no .env, no other tokens/), pushed, PR via gh, never main", () => {
  const r = repo();
  assertClean(r.api);
  writeFileSync(join(r.api, "src/a.ts"), "export const a = 2;\n");
  writeFileSync(join(r.api, "src/b.ts"), "export const b = 1;\n");
  writeFileSync(join(r.api, ".env"), "X=1\n");
  mkdirSync(join(r.api, "node_modules/x"), { recursive: true });
  writeFileSync(join(r.api, "node_modules/x/i.js"), "");
  mkdirSync(join(r.dir, "tokens"));
  writeFileSync(join(r.dir, "tokens/this-run.json"), "{}");
  writeFileSync(join(r.dir, "tokens/failed-run.json"), "{}");
  expect(() => assertClean(r.api)).toThrow("refusing to run: uncommitted changes");

  const s = ship(opts(r, { extra: [join(r.dir, "tokens/this-run.json")] }));
  expect(s).toMatchObject({ status: "shipped", branch: "harness/notes-20261004-120000", pr: "https://example.test/pr/1" });
  expect(s.files!.sort()).toEqual(["api/src/a.ts", "api/src/b.ts", "tokens/this-run.json"]);
  expect(git(r.dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(s.files!.sort());
  expect(git(r.remote, "branch", "--list")).toContain("harness/notes-20261004-120000");
  expect(git(r.remote, "branch", "--list")).not.toContain("main"); // only the harness branch is pushed
  expect(readFileSync(`${r.gh}.log`, "utf8")).toContain("pr create --base main --head harness/notes-20261004-120000");
  expect(readFileSync(`${r.gh}.log`, "utf8")).not.toContain("merge");
});

test("ship: a key in a staged file blocks the commit and restores the checkout", () => {
  const r = repo();
  writeFileSync(join(r.api, "src/a.ts"), `export const k = "${KEY}";\n`);
  const s = ship(opts(r));
  expect(s.status).toBe("blocked");
  expect(s.message).toContain("api/src/a.ts:1 github token");
  expect(git(r.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(r.dir, "branch", "--list", "harness/*")).toBe("");
  expect(git(r.remote, "branch", "--list")).toBe("");
});

test("ship: gh missing or logged out -> UNPROVEN with a clear message, never shipped", () => {
  const a = repo();
  writeFileSync(join(a.api, "src/a.ts"), "export const a = 3;\n");
  expect(ship(opts(a, { gh: "/nonexistent/gh" }))).toMatchObject({ status: "UNPROVEN", message: expect.stringContaining("gh is not installed") });
  const b = repo(1);
  writeFileSync(join(b.api, "src/a.ts"), "export const a = 3;\n");
  expect(ship(opts(b))).toMatchObject({ status: "UNPROVEN", message: expect.stringContaining("gh is not logged in") });
  expect(readFileSync(`${b.gh}.log`, "utf8")).not.toContain("pr create");
});

test("ship --no-ship: skipped, no branch, no commit, gh never called", () => {
  const r = repo();
  writeFileSync(join(r.api, "src/a.ts"), "export const a = 4;\n");
  expect(ship(opts(r, { skip: true }))).toEqual({ status: "skipped", message: "ship skipped (--no-ship)" });
  expect(git(r.dir, "branch", "--show-current")).toBe("main");
  expect(git(r.dir, "rev-list", "--count", "HEAD")).toBe("1");
  expect(git(r.dir, "status", "--porcelain")).toContain("api/src/a.ts");
  expect(existsSync(`${r.gh}.log`)).toBe(false);
});

test("secret scan: catches key shapes, ignores short look-alikes", () => {
  const keys = [KEY, ["sk-", "ant-", "x".repeat(40)].join(""), ["AI", "za", "b".repeat(35)].join(""), ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("")];
  expect(keys.every((k) => scanText("f", k).length > 0)).toBe(true);
  expect(scanText("f", "sk-ant-secret ghp_zzz desk-top task-list")).toEqual([]);
});

test("stripExample: removes the example, its test, mount and migration; the API stays green", async () => {
  const root = assemble("good-api");
  const s = await stripExample(root);
  expect(s).toMatchObject({ ok: true, changed: ["src/app.ts", "src/db/migrations.ts", "src/routes/_example.ts", "test/_example.test.ts"] });
  expect(existsSync(join(root, "src/routes/_example.ts")) || existsSync(join(root, "test/_example.test.ts"))).toBe(false);
  expect(readFileSync(join(root, "src/app.ts"), "utf8")).not.toMatch(/example/i);
  expect(readFileSync(join(root, "src/db/migrations.ts"), "utf8")).not.toContain("examples");
  expect(readFileSync(join(root, "src/db/migrations.ts"), "utf8")).toContain("CREATE TABLE IF NOT EXISTS notes");
  expect(await stripExample(root)).toEqual({ ok: true, changed: [] }); // idempotent
}, T);

test("stripExample: if removal breaks the API, everything is restored and it fails", async () => {
  const root = assemble("good-api");
  writeFileSync(join(root, "test/uses-example.test.ts"), `import { expect, it } from "vitest";\nimport { as } from "./helpers.ts";\nit("x", async () => expect((await as("w", "owner")("POST", "/v1/examples", { name: "n" })).status).toBe(201));\n`);
  const app = readFileSync(join(root, "src/app.ts"), "utf8");
  const s = await stripExample(root);
  expect(s.ok).toBe(false);
  expect(s.reason).toContain("removing the example broke the API");
  expect(existsSync(join(root, "src/routes/_example.ts"))).toBe(true);
  expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe(app);
}, T);

test("test-baseline (fake driver, mode change): a change that breaks a passing test is blocked at stop", async () => {
  const root = assemble("good-api");
  const task = join(tmp("harness-task-"), "change.yaml");
  writeFileSync(task, "mode: change\nchange: tweak\n");
  const edit = { id: "1", name: "edit_file", input: { path: "src/routes/notes.ts", old: "toNote(row), 201)", new: "toNote(row), 200)" } };
  const d = scripted([{ text: "", toolCalls: [edit] }, { text: "done", toolCalls: [] }]);
  const r = await run({ task, driver: d, repo: root, hooks: [testBaseline], tokensDir: tmp("harness-tokens-") });
  expect(r.completed).toBe(false);
  const stopMsg = d.seen[2]!.at(-1) as { text: string };
  expect(stopMsg.text).toContain("blocked by test-baseline");
  expect(stopMsg.text).toMatch(/test\/notes\.test\.ts > notes creates \(201\)/);
  expect(JSON.parse(readFileSync(join(resolve("runs", r.run_id), "tests-before.json"), "utf8")).length).toBeGreaterThan(0);
}, T);

test("sample-existing-api scores 100% and its tests pass; add-due-date targets it in change mode", async () => {
  const dir = tmp("harness-sample-");
  cpSync(resolve("examples/sample-existing-api"), dir, { recursive: true, filter: (s) => !s.includes("node_modules") });
  symlinkSync(resolve("template/node_modules"), join(dir, "node_modules"), "dir");
  expect((await runChecks(dir)).verdict).toBe(100);
  expect(runTests(dir).ok).toBe(true);
  expect(readFileSync("tasks/add-due-date.yaml", "utf8")).toMatch(/mode: change\ntarget: examples\/sample-existing-api/);
}, T);
