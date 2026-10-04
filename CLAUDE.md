# Rules for working on this repo

`plan.md` is the spec. Follow it strictly; build only the current step from its section 7, then stop and report.

- Stack: TypeScript + Bun. `tsc --strict` must stay green (`bun run typecheck`), and `bun test` too.
- `core/` stays generic: no domain words (project, workspace, task as a resource), no vendor or model names, no vendor SDK imports.
- Only `drivers/` imports vendor SDKs. Model names and effort settings live only in `drivers/drivers.yaml`, never in code or task files.
- Extending means dropping a file into `plugins/<kind>/`. Never edit `core/` to add a tool, check, validator or hook.
- Secrets: never commit `.env`. Tools refuse `.env*` (except `.env.example`), `*.pem`, `*.key` and `.git/`. Every transcript or log goes through `redact()`. The ship step stages explicit file lists only, never `git add -A` or `.`, and never `.env`.
- Gitignore `runs/` only. `tokens/` and `evidence/` are committed, because graders read them.
- Nothing is green on the model's word: verdicts come from harness-run checks. A skipped check prints UNPROVEN.
- Runs must stay reproducible: no silent model fallback, and one model per driver entry.
