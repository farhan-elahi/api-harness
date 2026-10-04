// Proves the standards checks: good fixture = 100%, bad fixture fails exactly at its "✗ <rule>" markers.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { assemble } from "../scripts/fixture.ts";
import { formatReport, runChecks } from "./runner.ts";

const RULES = ["auth", "authz-roles", "problem-json", "rest-conventions", "tsc-strict", "zod-boundary", "tenant-isolation"];
const T = 120_000;

test("good fixture scores 100% on every rule, nothing UNPROVEN", async () => {
  const r = await runChecks(assemble("good-api"));
  expect(r.rules.map((x) => x.name).sort()).toEqual([...RULES].sort());
  expect(r.rules.filter((x) => x.status !== "pass").map((x) => `${x.name}: ${x.reason ?? x.failures[0]?.message}`)).toEqual([]);
  expect(r.verdict).toBe(100);
  expect(formatReport(r)).toEndWith("100%");
}, T);

test("good fixture's runtime tests pass (201/204/404/409/422/403, isolation, cursor, idempotency)", () => {
  const dir = assemble("good-api");
  const run = spawnSync(join(dir, "node_modules/.bin/vitest"), ["run"], { cwd: dir, encoding: "utf8" });
  expect(run.status, run.stdout + run.stderr).toBe(0);
}, T);

test("bad fixture fails every rule exactly at the marked file:line", async () => {
  const overlay = resolve(import.meta.dir, "../fixtures/bad-api");
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
  const expected = files(overlay).flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .flatMap((line, i) => [...line.matchAll(/✗ ([a-z-]+)/g)].map((m) => `${m[1]} ${relative(overlay, f)}:${i + 1}`)),
  );
  const r = await runChecks(assemble("bad-api"));
  const actual = r.rules.flatMap((x) => x.failures.map((f) => `${x.name} ${f.file}:${f.line}`));
  expect([...new Set(actual)].sort()).toEqual([...new Set(expected)].sort());
  expect(r.rules.every((x) => x.status === "FAIL")).toBe(true);
  expect(r.verdict).toBe(0);
}, T);

test("checks that cannot run print UNPROVEN and block 100%", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-empty-"));
  writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
  const r = await runChecks(dir);
  expect(r.rules.every((x) => x.status === "UNPROVEN")).toBe(true);
  expect(r.verdict).toBe(0);
  expect(formatReport(r)).toContain("UNPROVEN  no tsconfig.json");

  const tpl = await runChecks(resolve(import.meta.dir, "../template"));
  expect(tpl.rules.find((x) => x.name === "auth")?.status).toBe("UNPROVEN");
  expect(tpl.verdict).toBeLessThan(100);
}, T);
