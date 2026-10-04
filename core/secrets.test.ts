import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "./sdk.ts";
import readFile from "../plugins/tools/read_file.ts";
import writeFile from "../plugins/tools/write_file.ts";
import listFiles from "../plugins/tools/list_files.ts";

const root = mkdtempSync(join(tmpdir(), "harness-sec-"));
const ctx = { root, runDir: root };
writeFileSync(join(root, ".env"), "SOME_API_KEY=sk-ant-secret\n");
writeFileSync(join(root, ".env.example"), "SOME_API_KEY=\n");
writeFileSync(join(root, "ok.ts"), "x\n");
mkdirSync(join(root, ".git"));
writeFileSync(join(root, ".git/config"), "x\n");

test("read_file(.env) is blocked", () => {
  expect(() => readFile.run({ path: ".env" }, ctx)).toThrow("blocked: secret file");
});

test("other secret paths are blocked for read and write", () => {
  for (const p of [".env.local", "certs/server.pem", "id.key", ".git/config"])
    expect(() => readFile.run({ path: p }, ctx)).toThrow("blocked: secret file");
  expect(() => writeFile.run({ path: ".env", content: "x" }, ctx)).toThrow("blocked: secret file");
  expect(() => listFiles.run({ dir: ".git" }, ctx)).toThrow("blocked: secret file");
  expect(existsSync(join(root, "id.key"))).toBe(false);
});

test(".env.example stays readable; listing hides secrets", async () => {
  expect(await readFile.run({ path: ".env.example" }, ctx)).toContain("SOME_API_KEY=");
  expect((await listFiles.run({}, ctx)).split("\n").sort()).toEqual([".env.example", "ok.ts"]);
});

test("redact masks key-shaped strings", () => {
  process.env.MY_SERVICE_TOKEN = "tok_1234567890abc";
  const out = redact('k=sk-ant-api03-abcDEF_123 o=sk-proj-abcdefghijklmnopqr GH_TOKEN: ghp_zzz t=tok_1234567890abc desk-top');
  expect(out).not.toMatch(/sk-ant-api03|sk-proj|ghp_zzz|tok_1234567890abc/);
  expect(out).toContain("GH_TOKEN: [REDACTED]");
  expect(out).toContain("desk-top");
});
