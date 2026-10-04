// After write_file/edit_file on a .ts file: run tsc on the project and hand back only that file's errors (max 10 lines).
// After a write under src/: also run the tests and hand back one line ("tests: 5 passed, 2 failed: file:line msg");
// that counts as an observed run for tdd-gate.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { brief, runTests } from "../../core/runner.ts";
import { allow, defineHook, note } from "../../core/sdk.ts";
import { isWrite } from "./_write.ts";
import { record } from "./tdd-gate.ts";

const MAX = 10;
const HARNESS_TSC = resolve(import.meta.dir, "../../node_modules/.bin/tsc");

export default defineHook({
  name: "post-write-feedback",
  afterTool: ({ call, root, runDir }) => {
    const p = isWrite(call) ? call!.input.path : undefined;
    if (typeof p !== "string" || !/\.tsx?$/.test(p) || !existsSync(join(root, "tsconfig.json"))) return allow;
    const tests = /^(\.\/)?src\//.test(p) ? runTests(root) : undefined;
    if (tests) record(runDir, tests.failures, tests.ok);
    const testLine = tests ? [`tests: ${brief(tests)}`] : [];
    const tsc = [join(root, "node_modules/.bin/tsc"), HARNESS_TSC].find(existsSync);
    if (!tsc) return testLine.length ? note(testLine[0]!) : allow;
    const run = spawnSync(tsc, ["--noEmit", "-p", "."], { cwd: root, encoding: "utf8" });
    const target = resolve(root, p);
    const errors = (run.stdout + run.stderr)
      .split("\n")
      .flatMap((l) => {
        const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
        return m && resolve(root, m[1]!) === target ? [`${p}:${m[2]}:${m[3]} ${m[4]} ${m[5]}`] : [];
      });
    if (!errors.length) return testLine.length ? note(testLine[0]!) : allow;
    const max = MAX - testLine.length; // tests line, header (+ "…N more") count toward MAX
    const room = errors.length > max - 1 ? max - 2 : max - 1;
    const more = errors.length > room ? [`…${errors.length - room} more`] : [];
    return note([...testLine, "tsc errors:", ...errors.slice(0, room), ...more].join("\n"));
  },
});
