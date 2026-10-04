# Design

## 1. Architecture

```
task file ─► core/task.ts ─► core/loop.ts ──send──► driver ──► model
                                  │  ▲
                   tool call ─────┘  └── compact result
                                  ▼
            core/hooks.ts: before-hooks ─► plugins/tools/<tool> ─► after-hooks
                                  │
          model says "done" ─► stop-gate ─► core/runner.ts (tests, tsc, checks)
                                  │ all green, nothing UNPROVEN
                                  ▼
                            core/ship.ts (branch, commit explicit files, push, PR)
```

- **Loop** (`core/loop.ts`): builds the context view, calls the driver, runs each tool call through the hooks, and records `usage` per turn. It stops on done, budget, or 3 identical replies.
- **Hooks** (`plugins/hooks/`) run before and after every tool call. Each one returns allow, block(reason) or a note.
  - path-guard: writes stay in the project, never `.git/`, `.env*`, keys or `node_modules/`.
  - tdd-gate: a `src/` write needs a mapped test that the harness ran and saw fail.
  - no-delete: refuses deletes.
  - contract-gate: refuses breaking API changes.
  - post-write-feedback: reruns the tests after each `src/` write.
  - read-loop-guard: computes the `Next:` step.
  - stop-gate and budget-guard: control when the run ends.
- **Deterministic (harness):** running tests, tsc and checks, the verdict, the state note, the `Next:` line, git, and the PR. The model has no shell or git tool.
- **Model decides:** which files to read, and what test and route code to write. Nothing is green on its word.

## 2. Driver abstraction

The interface is `send(system, messages, tools) → { text, toolCalls, usage, raw }` (`core/sdk.ts`).
- Messages use a neutral shape: role, text, toolCall, toolResult.
- Tools are declared once in JSON Schema.
- `drivers/claude.ts` and `drivers/openai-compatible.ts` convert both into the vendor format and back.

**What doesn't leak:**
- Vendor SDK imports appear only in `drivers/`.
- Model names, effort and `base_url` live only in `drivers/drivers.yaml`.
- Prompt formats, tool-schema dialects and stop reasons are mapped inside the driver.
- The driver is chosen only by the `--driver` flag, never by the task file.

The opaque `raw` blocks a provider returns, such as reasoning or signatures, are passed back untouched. That's why compaction drops whole turns rather than editing them.
`scripts/check-leaks.ts` (in `npm run verify`) greps `core/`, `plugins/` and `tasks/` for vendor and model names and fails on any hit. Each driver entry pins one model, and there is no fallback.

## 3. Token budget

Both modes run the same task, with the same driver, model, hooks and starting project. Only the context policy differs (`core/context.ts`).

- **Baseline (naive):**
  - System prompt with every rule's full text.
  - No JIT fetchers.
  - Each turn, the opening message is rebuilt with the full contents of every project source file.
  - Full history.
- **Actual:**
  - System prompt with a one-line rule index plus a generated project map.
  - JIT tools: `read_file` (capped), `get_schema`, `get_route`, `get_rule`.
  - Compact tool results, with the full transcript kept in `runs/<id>/`.
  - Only the last 3 turns kept verbatim, older turns dropped whole.
  - A harness-built state note of about 300 tokens: changed files, a fresh test result and a fresh check result.
  - Fixed cost (system prompt plus tools) is 948 tokens, which a test keeps under 1,000.

**Measured** with gpt-5.5 on `tasks/notes.yaml`, using `tokens/2026-10-04T17-44-39_openai_notes.json` and its baseline. Input tokens come from the provider's `usage` field.

| turn | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| baseline | 4,709 | 5,063 | 6,197 | 7,637 | 7,766 | 10,240 | 10,369 | 10,463 |
| actual | 1,042 | 2,697 | 3,279 | 4,347 | 3,582 | 3,152 | 3,206 | 2,593 |

Over turns 1–8, input drops from 62,444 to 23,898 tokens, a **61.7% reduction**. The baseline is capped at 8 turns (`--baseline-turns`) to limit spend.

**Why it is below the 90% target:**
- **The project is small.** The baseline's whole-repo dump starts at only about 4.7k tokens, so there's little to cut early on.
- **The window starts late.** Compaction only begins dropping turns after turn 3, so turns 1–4 pay nearly the full history in both modes.
- **The cap ends the comparison early.** It stops where the two curves are just separating.

The shapes differ:
- **Actual stays flat.** Across all 18 turns of the run it stayed between 1.0k and 4.3k tokens (turn 18: 2,295), because the window and the state note bound it.
- **Baseline keeps growing.** It rose about 800 tokens a turn, more than doubling in 8 turns, because every write grows the dump and the history.

A longer run or a larger repo would widen the gap. That is an extrapolation and was **not measured**. The scored number is 61.7%.

## 4. Extension points

- **The core directory is `core/`.** Plugin authors import `defineTool`, `defineCheck` and `defineHook` from `core/sdk.ts` and never edit it.
- **Plugins are auto-discovered** in `plugins/tools/`, `plugins/checks/`, `plugins/validators/` and `plugins/hooks/`. There is no registry file: dropping a file in the folder is the registration.
- **One contract for every check type.** Checks, validators and lint rules all return `{ file, line, pass, message }`, and each gets its own line in `harness check --api`.
- **Templates:** [docs/extending.md](extending.md) has a copy-paste template for each grader addition.

**Rehearsed:** the commit that added the example plugins (`7bca042`) touched only `plugins/` and docs, with no file under `core/`.

| Addition | Files | Lines added |
|---|---|---|
| lint rule | `plugins/checks/no-console-log.ts` | 21 |
| ORM validator | `plugins/validators/explicit-columns.ts` + test | 41 + 22 |
| hook (the breaking-change gate) | `plugins/hooks/contract-gate.ts` + test | 114 + 42 |

## 5. Honesty boundary

**What the checks prove:**
- The generated tests pass when the harness runs them.
- `tsc --strict` is clean.
- Each AST rule holds at every handler, route, error path and query it finds.
- No route contract was broken: removed fields, stricter types and changed statuses are all blocked.

**What they skip:**
- Anything a scanner can't see.
  - Dynamic routes and raw SQL strings aren't scanned.
  - Roles are checked for presence, not against a permission matrix, which was not built.
  - Tenant isolation is checked per query, not end to end.
- A check that can't run prints `UNPROVEN`, and the verdict can't reach 100%.

**What was not run live:**
- The brownfield `--repo` path, which has fake-driver tests only.
- A Claude run after Step 2, because the key became invalid.

**What a human must still verify:**
- Business logic beyond the task file.
- Security beyond these rules.
- Whether the generated tests actually cover the behaviours in the task.
- The PR diff before merging. The harness never merges.
