// After write_file on a .ts file: run tsc on the project and hand back only that file's errors (max 10 lines).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { allow, defineHook, note } from "../../core/sdk.ts";

const MAX = 10;
const HARNESS_TSC = resolve(import.meta.dir, "../../node_modules/.bin/tsc");

export default defineHook({
  name: "post-write-feedback",
  afterTool: ({ call, root }) => {
    const p = call?.name === "write_file" ? call.input.path : undefined;
    if (typeof p !== "string" || !/\.tsx?$/.test(p) || !existsSync(join(root, "tsconfig.json"))) return allow;
    const tsc = [join(root, "node_modules/.bin/tsc"), HARNESS_TSC].find(existsSync);
    if (!tsc) return allow;
    const run = spawnSync(tsc, ["--noEmit", "-p", "."], { cwd: root, encoding: "utf8" });
    const target = resolve(root, p);
    const errors = (run.stdout + run.stderr)
      .split("\n")
      .flatMap((l) => {
        const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
        return m && resolve(root, m[1]!) === target ? [`${p}:${m[2]}:${m[3]} ${m[4]} ${m[5]}`] : [];
      });
    if (!errors.length) return allow;
    const room = errors.length > MAX - 1 ? MAX - 2 : MAX - 1; // header (+ "…N more") count toward MAX
    const more = errors.length > room ? [`…${errors.length - room} more`] : [];
    return note(["tsc errors:", ...errors.slice(0, room), ...more].join("\n"));
  },
});
