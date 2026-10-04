# API Harness

Governs AI-written TypeScript REST APIs so standards hold whichever model does the coding.

**Core = `core/`**: it is never edited to extend the harness. Vendor SDKs live only in `drivers/`, and plugins live in `plugins/`.
Design note: [docs/design.md](docs/design.md). Extending: [docs/extending.md](docs/extending.md).

## Prerequisites
- Node.js 18+ (the only thing you need before setup)
- Bun 1.2+ (`npm run setup` installs it if missing; manual install: `npm i -g bun`)
- git and gh (optional; needed only for the ship/PR step)

## Setup (one command)
```
npm run setup          # installs Bun if missing, deps, links the `harness` command, creates .env, runs offline tests + tsc
# then add the key for your driver to .env (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
```

## Run
```
harness run <task-file> --driver <name> [--repo <path>] [--max-turns N] [--with-baseline] [--baseline-turns N]
harness check --api <dir>          # standards: one line per rule, then verdict NN%
harness check --api fixtures/good-api
```
Example: `harness run tasks/notes.yaml --driver openai --with-baseline`.
Run from the repo root, because `runs/`, `tokens/`, `generated/` and `template/` are relative to it.
If the `harness` link is missing, `bun harness ...` does the same thing.
`npm run verify` runs the tests, tsc, the leak check and the secret check.

A task file can be YAML, JSON, Markdown or plain text, and unknown fields are passed through. `--driver` is a CLI flag only; it is never read from the task file.

## Drivers
`drivers/drivers.yaml` maps a driver name to a module, a key env var and a pinned model. It is the only place model names and effort settings appear.
- `claude`: `drivers/claude.ts` (Anthropic SDK).
- `openai`, `deepseek`, `grok`, `gemini`, `openrouter`: `drivers/openai-compatible.ts` with a `base_url`.

Inside the harness, messages and tool schemas are neutral, and each driver translates to its vendor's format. `scripts/check-leaks.ts` fails if a vendor or model name appears in `core/`, `plugins/` or `tasks/`. There's no silent fallback: one driver entry means one model.

## Hooks
`plugins/hooks/` run around every tool call:
- The gates: path-guard, tdd-gate, no-delete, stop-gate, budget-guard and contract-gate.
- post-write-feedback reruns the tests after any `src/` write and returns a one-line result.
- read-loop-guard adds a harness-computed `Next:` line to the state note. After 5 turns with no write, edit or test run, it blocks further reads and returns that line.
- path-guard also refuses writes under `node_modules/`.

## Standards checks
`plugins/checks/` and `plugins/validators/` are AST checks built on ts-morph:

- zod-boundary
- problem-json
- tsc-strict
- rest-conventions
- auth
- authz-roles
- tenant-isolation
- explicit-columns (an example validator)
- no-console-log (an example lint rule)

A check that can't run prints `UNPROVEN`, and the verdict is never 100% while anything is UNPROVEN.
Fixtures are overlays on `template/`:
- `fixtures/good-api` scores 100%.
- `fixtures/bad-api` fails at every `✗ <rule>` marker.

## Own additions
- **Breaking-change gate** (`plugins/hooks/contract-gate.ts`): snapshots every route's contract before a change and diffs it after. It blocks removed routes or fields, stricter types, newly required request fields and changed status codes. Demo: [evidence/breaking-change-block.txt](evidence/breaking-change-block.txt).
- **Rules sent only on failure**: the system prompt carries a one-line rule index. A rule's full text reaches the model only through `get_rule` or a failing check.
- **Tenant isolation check** (`plugins/validators/tenant-isolation.ts`): every Drizzle query must filter by the tenant column.
- **Token report on every run**: per-turn input tokens taken from the provider's `usage` field, in `tokens/<run>.json`.

## Evidence
- Greenfield API built by the harness, and the PR it opened: [PR #14](https://github.com/farhan-elahi/api-harness/pull/14) → `generated/notes/`.
- Standards output: [evidence/standards-openai-notes.txt](evidence/standards-openai-notes.txt), with a 100% verdict.
- Token report: [tokens/2026-10-04T17-44-39_openai_notes.json](tokens/2026-10-04T17-44-39_openai_notes.json) and its baseline, [tokens/2026-10-04T17-43-47_openai_notes_baseline.json](tokens/2026-10-04T17-43-47_openai_notes_baseline.json).
- Run logs: [evidence/runs/openai/](evidence/runs/openai/) (including `notes-console.log`) and [evidence/runs/claude/](evidence/runs/claude/).
- Failed runs and what we fixed after them: [evidence/failed-runs/](evidence/failed-runs/README.md).

## Honesty notes
- **Both drivers were verified live in Step 2**: the claude and openai `hello` runs are in `evidence/runs/`. The Claude key later became invalid, so the final green greenfield run used **openai (gpt-5.5)** only. No Claude notes run exists.
- **Reduction is 61.7%, below the 90% target.** See [docs/design.md](docs/design.md#token-budget) for why.
- **The brownfield path was not run live.** It is covered by fake-driver tests (`plugins/hooks/hooks.test.ts`) and the breaking-change demo above.
- **The permission matrix was not built.** authz-roles checks that write routes check a role; it does not compare against a route × role matrix.
- We wrote our own task files and sample APIs, since none were provided. Scope is any TypeScript REST API, not any repo.
- Known limit: after a green run, tdd-gate blocks further `src/` writes until it observes a new red test. That gets in the way of refactoring after green.
