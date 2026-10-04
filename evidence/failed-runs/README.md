# Failed runs

These are kept so the green run can be checked against the runs before it. Their token reports are left out of `tokens/`, so that folder holds only the run that passed. The copies here are what each run wrote to `runs/`, plus its console output.

| Run | Driver / model | Outcome |
|---|---|---|
| `deepseek-v3.2/` | openrouter, deepseek/deepseek-v3.2 | Hit budget-guard at 25/25 turns, in both baseline and actual. Reduction was 64.3%. |
| `gpt-5.5-run1/` | openai, gpt-5.5 | Hit budget-guard at 40/40 turns. Tests stood at 5 passed, 2 failed, and checks at 77%. Reduction was 63.1% over turns 1–8. |

## Why they failed
- **DeepSeek v3.2:** after its first test run, the model kept re-reading files without writing anything. From turn 20 on, read-loop-guard blocked every read, but the block message didn't say what to do next, so the run ran out of turns.
- **gpt-5.5 run 1:** the model stopped calling `run_tests` after editing `src/`. The harness's state note and its `Next:` line were therefore built from an old test result. The model kept fixing failures that no longer existed and never reached green.

## What we fixed (between runs, both on `step-8-runs`)
- `e06f274`: every block message from read-loop-guard and tdd-gate now ends with a concrete `Next:` step. The loop logs `{turn, state}`. `--baseline-turns N` caps the baseline, and the comparison covers turns 1..N only.
- `de17afc`: any write under `src/` now runs the tests automatically and returns a one-line result, which also counts as an observed run for tdd-gate. The `Next:` line is built from that fresh state: write the test, run it, write the route, fix the first failure at `file:line`, fix the failing rule, done.

Re-running gpt-5.5 after these fixes went green: done in 18 turns, 7/7 tests, checks 100%. See `evidence/runs/openai/notes-console.log`.
