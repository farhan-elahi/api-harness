# API Harness

Governs AI-written TypeScript REST APIs so standards hold whichever model does the coding.
**Core = `core/`**: it is never edited to extend the harness. Vendor SDKs live only in `drivers/`, and plugins live in `plugins/`.

## Prerequisites
- Node.js 18+ (the only thing you need before setup)
- Bun 1.2+ (`npm run setup` installs it if missing; manual install: `npm i -g bun`)
- git and gh (optional; needed only for the ship/PR step)

## Setup
```
npm run setup          # installs Bun if missing, deps, creates .env, runs offline tests + tsc
# then add ANTHROPIC_API_KEY to .env
```

## Run
```
bun harness run tasks/notes.yaml --driver claude [--repo <path>] [--max-turns N]
bun harness check --api <dir>      # standards: one line per rule, then verdict NN%
```

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

Try one with `bun harness check --api $(bun scripts/fixture.ts bad-api)`.
