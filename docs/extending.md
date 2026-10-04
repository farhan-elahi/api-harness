# Extending the harness

**Core = `core/`.** You never edit it to add something. Every extension is a new file in `plugins/<kind>/`, or a
`drivers/` entry. The loader (`core/loader.ts`) auto-discovers each `*.ts` file and uses it on the next run. It
skips files starting with `_` (shared helpers) and `*.test.ts`. There is no registry to update. Contracts are in
`core/sdk.ts`: import from it, never edit it.

Rehearsed: each addition below, done on a clean branch, gives a `git diff --stat` that lists only the new plugin
files.

## Tool: `plugins/tools/<name>.ts`

The model can call it on the next run. Resolve paths with `inRoot`, which refuses path escapes and secret files.

```ts
import { readFileSync } from "node:fs";
import { defineTool, inRoot } from "../../core/sdk.ts";

export default defineTool({
  name: "count_lines",
  description: "Number of lines in a file.",
  input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  run: (input, { root }) => String(readFileSync(inRoot(root, input.path), "utf8").split("\n").length),
});
```

Files to touch: `plugins/tools/count_lines.ts`.

## Check or lint rule: `plugins/checks/<name>.ts`

Return one `{ file, line, pass, message }` per item inspected. Each rule gets its own line in
`harness check --api <dir>`, one `FAIL file:line message` per failure, and a share of the verdict. The first line of
`rule` goes to the model's rule index; the rest is sent only when the check fails. Throw `NothingToCheck` to report
0/0 (a pass), `NotApplicable` for n/a, or `Unproven` when the check can't run. An UNPROVEN check blocks 100%.

```ts
import { Node, SyntaxKind } from "ts-morph";
import { defineCheck, type CheckResult } from "../../core/sdk.ts";
import { appFiles } from "./_hono.ts";

export default defineCheck({
  name: "no-console-log",
  unit: "files",
  rule: "No console.log or console.debug in src/.",
  run: ({ ast, dir }) =>
    appFiles(ast())
      .filter((sf) => sf.getFilePath().startsWith(`${dir}/src/`))
      .flatMap((sf): CheckResult[] => {
        const bad = sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
          .filter((e) => /^console\.(log|debug)$/.test(e.getText()) && Node.isCallExpression(e.getParent()));
        return bad.length
          ? bad.map((e) => ({ file: sf.getFilePath(), line: e.getStartLineNumber(), pass: false, message: `${e.getText()}() left in source` }))
          : [{ file: sf.getFilePath(), line: 1, pass: true, message: "clean" }];
      }),
});
```

Files to touch: `plugins/checks/no-console-log.ts`. Shipped as a real rule.

## Validator: `plugins/validators/<name>.ts`

Validators use the same contract as checks; the folder only keeps ORM and data rules apart. `ctx.ast()` is a
type-aware ts-morph program, so you can match a query by its receiver's type rather than by variable name.

```ts
import { Node, SyntaxKind } from "ts-morph";
import { defineCheck, type CheckResult } from "../../core/sdk.ts";
import { appFiles } from "../checks/_hono.ts";

export default defineCheck({
  name: "users-explicit-columns",
  unit: "queries",
  rule: "Queries on users list explicit columns.",
  run: ({ ast }) =>
    appFiles(ast()).flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression)).flatMap((c): CheckResult[] => {
      const e = c.getExpression();
      if (!Node.isPropertyAccessExpression(e) || !/^find(Many|First|Unique)$/.test(e.getName()) || !/\.users?$/.test(e.getExpression().getText())) return [];
      const arg = c.getArguments()[0];
      const pass = !!arg && Node.isObjectLiteralExpression(arg) && !!(arg.getProperty("select") ?? arg.getProperty("columns"));
      return [{ file: sf.getFilePath(), line: c.getStartLineNumber(), pass, message: pass ? "explicit columns" : "no select/columns" }];
    }),
});
```

Files to touch: `plugins/validators/<name>.ts` and an optional `<name>.test.ts` next to it. The full shipped
version is `plugins/validators/explicit-columns.ts`. It covers Drizzle `db.select()`, relational `findMany`, and
Prisma `find*`.

## Hook: `plugins/hooks/<name>.ts`

Hooks run around every tool call and before the agent may stop, in filename order. The first `block` or `stop` wins.
`block(reason)` sends the reason back to the model, and `stop(reason)` ends the run as failed. `note(text)`
(afterTool only) appends text to the tool result, and `state` adds a line to the per-turn state note.

```ts
import { allow, block, defineHook } from "../../core/sdk.ts";

export default defineHook({
  name: "no-sql-files",
  beforeTool: ({ call }) =>
    typeof call?.input.path === "string" && call.input.path.endsWith(".sql") ? block("write migrations in src/db/migrations.ts") : allow,
});
```

Files to touch: `plugins/hooks/no-sql-files.ts`. For a real example, see `plugins/hooks/contract-gate.ts`, the
breaking-change gate.

## Driver: `drivers/<module>.ts` + `drivers/drivers.yaml`

An OpenAI-compatible provider needs one YAML entry and no code. Then run `--driver mistral`:

```yaml
mistral:
  module: openai-compatible.ts
  key_env: MISTRAL_API_KEY
  base_url: https://api.mistral.ai/v1
  model: mistral-large-latest
```

A new API shape needs a module that default-exports a `DriverFactory`. The module translates the neutral `Message[]`
to the vendor's format and maps the provider's own usage numbers back.

```ts
import type { DriverFactory } from "../core/sdk.ts";

const factory: DriverFactory = (cfg) => ({
  async send(system, messages, tools) {
    // call the vendor with cfg.model and process.env[String(cfg.key_env)]
    return { text: "", toolCalls: [], usage: { input: 0, output: 0 }, stop: "end" };
  },
});
export default factory;
```

Files to touch: `drivers/drivers.yaml`, plus `drivers/<module>.ts` for a new API shape. Model names belong only in
`drivers.yaml`, and each entry uses exactly one model, with no fallback.
