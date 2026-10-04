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
bun harness run tasks/hello.yaml --driver claude [--repo <path>] [--max-turns N]
```
