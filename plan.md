# Build Plan: API Harness for TypeScript REST APIs
**Demo domain:** TaskFlow, a mini Jira (workspaces, projects, tasks)
**Deadline:** Sun 4 Oct 2026, 11:59 PM PKT. Tag the commit. No force-push after.

> Rule for every decision: **graders run commands and read files. If the harness didn't produce it, it doesn't count.**

---

## 0. The scenario (for the README)
TaskFlow is a company that builds TypeScript REST APIs for a multi-tenant project management product. Every API must follow strict standards: Zod validation, RFC 7807 errors, strict types, REST conventions, authentication, role-based authorization, and **tenant isolation** (a workspace never sees another workspace's data). The harness governs all API work so these rules hold no matter which AI model does the coding.

## 0.1 Scope: what the harness must handle
- **Project management is only our demo.** Graders can use **any idea** (e-commerce, hospital, library…).
- **Greenfield:** build **any** new TypeScript REST API from a task file. Each run = one task. Two new APIs = two runs.
- **Brownfield:** change **any TypeScript REST API** repo via `--repo <path>`: our shipped sample, an API the harness just generated, or their own repo.
- **Detect, don't assume:** package manager, test command, framework (Hono/Express/Fastify), route locations. Can't detect or tool missing → `UNPROVEN`, never a fake pass.
- **Honest limit (state in README):** any TypeScript REST API, not any repo. Python or frontend-only projects are out of scope.
- **Never hardcode the domain.** PM words appear only in `tasks/`, `generated/`, `examples/`, and the optional tenant-isolation plugin. `core/`, `drivers/` and standard checks stay generic.

## 0.2 How grading flows
```
        WE SHIP (now)                         GRADERS (later)
  ┌──────────────────────────┐          ┌───────────────────────────────┐
  │ Harness                  │          │ Their task → new API(s)       │
  │ API #1: NEW (greenfield) │  submit  │ Their change → any API        │
  │ API #2: CHANGED existing │ ───────► │   (our sample or a new one)   │
  │ Evidence + PR            │          │ Read checks, tokens, PR, diff │
  └──────────────────────────┘          └───────────────────────────────┘
```
"Two governed APIs" in the deliverables = **one new + one change to an existing API**, not two new APIs. The PDF says "we provide" for both; none were provided, so we ship our own stand-ins and say so.

---

## 1. What the graders will run → what we must build

### 1.1 Model agnosticism (25%)
**They run:**
```
harness run <their-task> --driver claude
harness run <their-task> --driver openai
```
**Pass:** zero diff in task file, hooks and checks between runs. Both end with standards checks green.
**Fail:** provider names, prompt formats or tool schemas leaking into task files or hooks.

**We build:**
- [ ] `drivers/` is the **only** folder that imports `@anthropic-ai/sdk` or `openai`.
- [ ] One neutral `Driver` interface: `send(messages, tools) → { text, toolCalls, usage }`.
- [ ] Tools defined once in neutral JSON Schema. Each driver converts to its vendor format internally.
- [ ] Neutral message format inside the harness (role, text, toolCall, toolResult). Drivers translate.
- [ ] `--driver` is a CLI flag only. Never read from the task file.
- [ ] `openai` driver is OpenAI-compatible (`baseURL` in `drivers/drivers.yaml`) → DeepSeek, Grok, OpenRouter work too.
- [ ] **Leak check** `scripts/check-leaks.ts`: greps `core/ plugins/ tasks/` for `anthropic|openai|claude|gpt|deepseek|grok`. Must print 0 hits. Runs in `npm run verify`.
- [ ] **Their task file is unknown.** Task loader must be tolerant:
  - YAML or JSON → parse structured fields (resource, fields, behaviours…)
  - Markdown or plain text → pass as the task description
  - Unknown fields → kept and passed through, never crash
- [ ] Same run must work start-to-finish with **no human input**.

### 1.2 Token efficiency (25%)
**They read:** `tokens/<run>.json` with baseline and actual **input tokens per turn**. Baseline = same task, same driver, context fetchers and compaction **disabled**. Ratio is the score. Target **> 90% reduction**.

**We build:**
- [ ] `--baseline` flag: disables JIT fetchers + compaction (dumps the whole target repo + full raw tool output into context, like a naive agent).
- [ ] Token report written **automatically on every run**:
```json
{
  "run_id": "2026-10-04T15-02-11_claude_projects",
  "driver": "claude",
  "task": "tasks/projects.yaml",
  "mode": "actual",
  "turns": [
    { "turn": 1, "input_tokens": 1840, "output_tokens": 412 },
    { "turn": 2, "input_tokens": 2105, "output_tokens": 380 }
  ],
  "total_input_tokens": 38120,
  "baseline": { "run_id": "…_baseline", "total_input_tokens": 512400, "turns": [ … ] },
  "reduction_pct": 92.6
}
```
- [ ] Token counts come from the **provider's `usage` field**, not estimates.
- [ ] `harness run … --with-baseline` runs both and writes one combined report.

**Mechanisms that earn the reduction:**
- [ ] **Tiny system prompt** (target < 1 KB). Standards are enforced by checks, not explained in the prompt.
- [ ] **JIT tools:** `list_files`, `read_file(path, range?)`, `get_schema(resource)`, `get_route(path)`, `get_rule(name)`. Nothing is preloaded.
- [ ] **Compact returns:** tests → `3 passed, 1 failed: tasks.test.ts:42 expected 201 got 500`. Full logs saved to `runs/<id>/logs/*.log`, returned as a path.
- [ ] **Read cap:** `read_file` returns max N lines unless a range is given.
- [ ] **History compaction:** old tool results replaced with one-line summaries after K turns.
- [ ] **Rules JIT:** a rule's text is only shown to the model when a check for it fails (cheapest mechanism wins).

### 1.3 API standards compliance (25%)
**They run:** our `harness check --api <dir>` on the API our harness built for **their** task, then **their own reference checks** on the same code. Both must be 100%. One fail = zero.

**Required output shape** (one line per rule per file, with location on fail):
```
$ harness check --api ./generated/projects-api
zod-boundary      pass  12/12 handlers
problem-json      pass  9/9 error paths
tsc --strict      pass  0 errors
rest-conventions  pass  6/6 routes
auth              pass  6/6 routes
authz-roles       pass  4/4 write routes
tenant-isolation  pass  8/8 queries
verdict           100%
```
On fail: `zod-boundary  FAIL  src/routes/tasks.ts:31 body not parsed with Zod`

**The checks (each a plugin in `plugins/checks/`):**
- [ ] **zod-boundary:** params, query, body and response parsed with Zod. Types come from `z.infer`. No duplicate hand-written interface for a schema.
- [ ] **problem-json:** every non-2xx sets `Content-Type: application/problem+json` with `type, title, status, detail, instance`. No `{ error: "…" }`.
- [ ] **tsc --strict:** runs real `tsc --noEmit`, tsconfig has `strict` + `noUncheckedIndexedAccess`. Scan for `any`, non-null `!`, `@ts-ignore`, `@ts-expect-error`.
- [ ] **rest-conventions:** plural nouns, `/v1` base path, cursor pagination on list routes, `Idempotency-Key` on unsafe POSTs, 201 on create, 204 on delete, 404/409/422 used correctly.
- [ ] **auth:** every route behind auth middleware unless listed in a public allowlist.
- [ ] **authz-roles:** write routes check role (owner, member, viewer).
- [ ] **tenant-isolation:** every DB query filters by `workspace_id`.

**Because their reference checks are hidden, the generated code must be genuinely correct, not just pass our scanner:**
- [ ] Scanners use **ts-morph (AST)**, not loose regex, to avoid false passes.
- [ ] Every generated API includes **runtime tests** (Vitest + real HTTP requests) proving 201/204/404/409/422 and problem+json bodies.
- [ ] A **project template** the harness copies first: strict tsconfig, shared `problem()` helper, error middleware, auth middleware, Zod validator, cursor helper. The model fills in resources on a correct base.
- [ ] Generated stack: **Hono + Zod + Drizzle (SQLite) + Vitest**. Drizzle chosen so graders' ORM-validator example has real queries to check.

### 1.4 Extensibility (25%)
**They add live, then check `git diff --stat`:**
1. A new tool (e.g. `openapi-diff`) by dropping a file into a registry folder or manifest. Appears next run.
2. A custom ORM validator (e.g. "every Prisma or Drizzle query on users selects explicit columns") as a plugin.
3. A new linter rule with its own pass/fail line and location output.

**Pass:** diff touches only the plugin's own files + a registry entry. Any change under core fails.

**We build:**
- [ ] **Core directory = `core/`.** Named clearly at the top of the README.
- [ ] Plugin loader **auto-discovers** files in `plugins/tools/`, `plugins/checks/`, `plugins/validators/`, `plugins/hooks/`. `plugins/registry.yaml` is optional (enable/disable/order).
- [ ] One tiny contract per plugin type:
```ts
// plugins/checks/<name>.ts
export default defineCheck({
  name: "no-console-log",
  run: ({ files }) => results,   // [{ file, line, pass, message }]
});

// plugins/tools/<name>.ts
export default defineTool({
  name: "openapi_diff",
  description: "…",
  input: { /* JSON Schema */ },
  run: async (input, ctx) => "compact summary",
});
```
- [ ] Checks, validators and lint rules **all use the same check contract** → automatically appear in `harness check --api` with their own line.
- [ ] `defineCheck` / `defineTool` imported from `core/sdk.ts` (never edited by plugin authors).
- [ ] `docs/extending.md` with copy-paste templates for all 3 grader additions.
- [ ] **Rehearse it:** add a sample tool, ORM validator and lint rule ourselves, confirm `git diff --stat` shows only plugin files. Ship them as examples.

---

## 2. Principles → where each lives in the repo
| Principle | Where |
|---|---|
| Deterministic tools for deterministic tasks | `core/runner.ts` runs tests, tsc, checks, git. Model never does. |
| Hooks, not prompts | `core/hooks.ts` runs `plugins/hooks/*` before/after every tool call → `pass`, `block(reason)`, `record` |
| Observed red | `plugins/hooks/tdd-gate.ts`: source write refused until the mapped test exists **and the harness ran it and saw it fail** |
| Harness ships, agent never does | `core/ship.ts` runs git as subprocess after all gates green. Model has **no** git or shell tool. |
| Cheapest mechanism wins | Rules live in checks; rule text only sent when a check fails |
| Honesty boundary | Any skipped check prints `UNPROVEN`, verdict can't be 100% if anything is UNPROVEN |

### Hooks we ship
- [ ] **path-guard:** writes only inside the target project dir. No `..`, no `.git/`, no `.env`.
- [ ] **tdd-gate:** observed red before source edits.
- [ ] **no-delete:** the model can't delete files outside its generated dir.
- [ ] **post-write feedback:** after each write, run the changed-scope checks, return only failures.
- [ ] **stop-gate:** model says "done" → harness runs full proof. Any red or UNPROVEN → model must continue.
- [ ] **budget-guard:** max turns + max tokens per run, then stop safely with a report.

### Our own additions (what sf-harness lacks, named in README)

**1. Breaking-change gate (automatic contract diff) ⭐ build first**
- [ ] Before a change: snapshot every route (method, path, request + response schemas, status codes) → `runs/<id>/contract-before.json`.
- [ ] After: re-snapshot and diff.
- [ ] **Blocks if:** route removed, field removed or renamed, type made stricter, required field added to a request, status code changed.
- [ ] Adding optional fields or new routes = allowed.
- [ ] Why new: sf-harness only asks a **human** to sign off contracts. Ours **detects breaking changes automatically**.
- [ ] Demo: deliberately remove a field → harness blocks it. Save as evidence.

**2. Permission matrix gate ⭐**
- [ ] Before coding, harness writes `permissions.yaml` (route × role → allow/deny) from the task:
```
route                owner  member  viewer
GET    /v1/projects   ✅     ✅      ✅
POST   /v1/projects   ✅     ✅      ❌
DELETE /v1/projects   ✅     ❌      ❌
```
- [ ] `authz-roles` check verifies code matches the matrix; one test generated per row.
- [ ] Why new: sf-harness has no authorization check.

**Bonus differences (mention briefly)**
- Runs on **any model** via its own loop + drivers; sf-harness depends on Claude Code / Codex.
- **Token report** per turn on every run; sf-harness doesn't measure context.
- **Rules sent only on failure:** rule text reaches the model only when its check fails.
- **Tenant isolation check:** every DB query scoped to `workspace_id`.

**If time runs short:** keep the breaking-change gate, drop the permission matrix.

---

## 3. Deliverables checklist (exactly what the PDF lists)

### 3.1 Harness source
- [ ] `core/`, `drivers/`, `plugins/` (hooks, checks, tools, validators), registry
- [ ] **One-command setup:** `npm run setup` (installs, checks tools, copies `.env.example` → `.env` if missing)
- [ ] README

### 3.2 Two governed APIs
- [ ] **New API** generated from a task file → `generated/projects-api/`
- [ ] **One change applied to an existing API** → `examples/sample-existing-api/` (we wrote it, since none was provided; say so honestly in the README) with change task "add optional `due_date` to tasks"

### 3.3 Run evidence (commit it under `evidence/`)
- [ ] Logs for **both drivers**: `evidence/runs/claude/…`, `evidence/runs/openai/…`
- [ ] Token report(s): `tokens/<run>.json`
- [ ] Standards check output: `evidence/standards-claude.txt`, `evidence/standards-openai.txt`
- [ ] **The PR the harness opened** (real GitHub PR link in README)

### 3.4 Own addition
- [ ] Contract gate + permission matrix, named in README

### 3.5 Design note (README or `docs/design.md`, 1–2 pages, all 5 sections)
- [ ] **Architecture:** the loop, where hooks sit, what's deterministic vs what the model decides
- [ ] **Driver abstraction:** the interface, and what we refused to let leak (vendor schemas, model names, prompt formats)
- [ ] **Token budget:** baseline vs actual per turn, with the mechanisms that earned it (numbers copied from the harness's own report)
- [ ] **Extension points:** how a tool, validator, lint rule is registered; core dir = `core/`
- [ ] **Honesty boundary:** what checks prove, what they skip, what a human must still verify

---

## 4. Ground rules → how we comply
| Rule | How we guarantee it |
|---|---|
| No secrets in repo (committed key = outright fail) | Keys only from env. `.env` in `.gitignore`. `.env.example` has empty values. `scripts/check-secrets.ts` scans repo + every commit the ship step makes; blocks on a hit. Run before tagging. |
| The agent never pushes | Model has no git or shell tool. `core/ship.ts` runs git as a subprocess, only after all gates green, only to `harness/<task>-<timestamp>` branch. Refuses `main`/`master`. Never merges. |
| Nothing green on the model's word | Verdict comes from check results only. Skipped = UNPROVEN. TDD gate needs harness-observed red. |
| Must never damage a repository | Refuse dirty working tree. Always work on a new branch. path-guard sandbox. No delete outside generated dir. Baseline tests before change, block regressions. |
| Works without you in the room | Fully non-interactive run. Clear error for missing keys or tools. README run steps tested from a fresh clone. |

### Where people lose points → our defense
| Trap | Defense |
|---|---|
| Front-loading the repo (40 KB prompt) | System prompt < 1 KB, JIT tools, measured in token report |
| Provider leaks | Leak check script, neutral tool schema, `--driver` flag only |
| Editing core to extend | Auto-discovered plugins, rehearsed `git diff --stat` test |

---

## 5. Repo layout
```
api-harness/
├── core/                  ← ENGINE. Never edited to extend.
│   ├── loop.ts            ← the agent loop
│   ├── hooks.ts           ← runs pre/post hooks
│   ├── loader.ts          ← auto-discovers plugins
│   ├── runner.ts          ← tests, tsc, checks (deterministic)
│   ├── tokens.ts          ← token report writer
│   ├── ship.ts            ← branch, commit, push, PR
│   ├── task.ts            ← tolerant task loader
│   └── sdk.ts             ← defineTool / defineCheck / defineHook
├── drivers/               ← only place with vendor SDKs
│   ├── claude.ts
│   ├── openai-compatible.ts
│   └── drivers.yaml
├── plugins/
│   ├── tools/             ← read_file, write_file, list_files, run_tests, get_schema
│   ├── checks/            ← zod-boundary, problem-json, tsc-strict, rest-conventions, auth, authz-roles
│   ├── validators/        ← tenant-isolation (Drizzle), example explicit-columns
│   ├── hooks/             ← path-guard, tdd-gate, no-delete, stop-gate, contract-gate, budget-guard
│   └── registry.yaml
├── template/              ← strict Hono + Zod + Drizzle + Vitest starter
├── tasks/                 ← projects.yaml, tasks.yaml, add-due-date.yaml
├── examples/sample-existing-api/
├── generated/             ← APIs the harness built
├── tokens/                ← token reports
├── evidence/              ← logs, standards outputs
├── scripts/               ← setup, verify, check-leaks, check-secrets
├── docs/                  ← design.md, extending.md
├── .env.example
└── README.md
```

## 6. Demo tasks (TaskFlow)
```yaml
# tasks/projects.yaml
mode: create
resource: projects
tenant: workspace
fields:
  name: { type: string, min: 1, max: 120 }
  description: { type: string, optional: true }
  status: { type: enum, values: [active, archived] }
behaviours:
  - list (cursor paginated), get, create, update, delete
  - names are unique per workspace (409 on duplicate)
  - viewers can read, members can create/update, only owners can delete
```
```yaml
# tasks/add-due-date.yaml
mode: change
target: examples/sample-existing-api
change: add optional due_date (ISO date) to tasks; existing routes and clients must keep working
```

---

## 7. Time plan (now → 11:59 PM)
| Time | Build | Unlocks |
|---|---|---|
| 13:30–15:30 | `core/loop`, `task`, `sdk`, `loader`, Claude driver, basic tools | First run works |
| 15:30–16:30 | OpenAI-compatible driver + leak check | Model agnosticism |
| 16:30–18:00 | `template/` + standards checks + `harness check --api` | API standards |
| 18:00–19:00 | Hooks: path-guard, tdd-gate, stop-gate | Principles |
| 19:00–20:00 | Token report + `--baseline` + compaction | Token efficiency |
| 20:00–21:00 | Plugin rehearsal (3 grader additions), contract gate | Extensibility + own idea |
| 21:00–22:00 | Ship step + secret scan + sample existing API | PR evidence |
| 22:00–23:15 | Full runs on both drivers, collect evidence | Deliverables |
| 23:15–23:45 | README / design note | Design note |
| 23:45 | Fresh-clone test, secret scan, **tag commit**, post link | Submit |

**If behind:** cut permission matrix first, then budget-guard. **Never cut:** both drivers, 100% checks, token report, plugin loader, ship step, secret scan.

---

## 8. Final pre-submit checklist (do exactly what graders do)
- [ ] Fresh clone → `cp .env.example .env` → add keys → `npm run setup` works
- [ ] `harness run tasks/projects.yaml --driver claude --with-baseline` → green
- [ ] `harness run tasks/projects.yaml --driver openai --with-baseline` → green
- [ ] `git diff` between those two runs shows **no** changes to `tasks/`, `plugins/hooks/`, `plugins/checks/`
- [ ] `tokens/*.json` shows > 90% reduction for both drivers
- [ ] `harness check --api generated/projects-api` → 100%, no UNPROVEN
- [ ] Add a dummy tool, validator, lint rule → `git diff --stat` touches only `plugins/` + registry → revert
- [ ] Brownfield run on `examples/sample-existing-api` → PR opened on a feature branch
- [ ] Brownfield run on an API the harness **just generated** → green (graders may do this)
- [ ] One **non-PM** task (e.g. `books`) → green with zero code changes (proves it's generic)
- [ ] Breaking-change demo: removing a field gets **blocked**
- [ ] `grep` `core/ drivers/ plugins/checks/` for `project|workspace|task` domain words → none hardcoded
- [ ] `npm run verify` → leak check 0, secret check 0
- [ ] README names `core/` as core, lists own addition, links the PR, has all 5 design sections
- [ ] Tag commit (`git tag v1.0-submission && git push --tags`), post repo link + design note in channel