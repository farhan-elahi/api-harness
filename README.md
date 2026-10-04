# API Harness

Governs AI-written TypeScript REST APIs so standards hold whichever model does the coding.
**Core = `core/`**: it is never edited to extend the harness. Vendor SDKs live only in `drivers/`, and plugins live in `plugins/`.

## Prerequisites
- Node.js 18+ (the only thing you need before setup)
- Bun 1.2+ (`npm run setup` installs it if missing; manual install: `npm i -g bun`)
- git and gh (optional; needed only for the ship/PR step)

## Setup
```
npm run setup          # installs Bun if missing, deps, links the `harness` command, creates .env, runs offline tests + tsc
# then add ANTHROPIC_API_KEY to .env
```

## Run
```
harness run tasks/notes.yaml --driver claude [--repo <path>] [--max-turns N] [--with-baseline]
harness check --api <dir>          # standards: one line per rule, then verdict NN%
harness check --api fixtures/good-api
```
Run from the repo root (runs/, tokens/, generated/ and template/ are relative to it).
No link? `bun harness ...` does the same.

## Hooks
`plugins/hooks/` run around every tool call. Besides the gates (path-guard, tdd-gate, no-delete, stop-gate,
budget-guard), `read-loop-guard` adds a harness-computed `Next:` line to the state note and, after 5 turns with
no write, edit or test run, blocks further reads with that line. path-guard also refuses writes under node_modules/.

## Standards checks
`plugins/checks/` and `plugins/validators/` are AST checks built on ts-morph:

- zod-boundary
- problem-json
- tsc-strict
- rest-conventions
- auth
- authz-roles
- tenant-isolation

A check that can't run prints `UNPROVEN`, and the verdict is never 100% while anything is UNPROVEN.

Fixtures are overlays on `template/`:
- `fixtures/good-api` scores 100%.
- `fixtures/bad-api` fails at every `✗ <rule>` marker.

Try one with `harness check --api fixtures/bad-api` (the overlay is assembled on template/ first).
