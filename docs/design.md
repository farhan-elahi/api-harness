# Design

## Token budget: what "baseline" and "actual" mean

Both modes run the same task, with the same driver and model, the same hooks and gates, and the same starting project. Only the context policy differs (`core/context.ts`).

**Baseline (JIT off).** This is how a naive agent works.
- System prompt: every rule's full text.
- Tools: everything except the JIT fetchers (`get_schema`, `get_route`, `get_rule`).
- Every turn, the opening message is rebuilt with the **full current contents of every project source file**. That excludes `node_modules`, build output, lockfiles and secrets. The snapshot replaces the previous one instead of being appended.
- History: every turn is kept verbatim.

**Actual.**
- System prompt: a one-line index of the rules (`get_rule` returns the full text). It also holds a project map generated from the code: the target's file list and the exported signatures from `template/src/lib`.
- Tools: everything, including the JIT fetchers.
- History: the last 3 turns are kept verbatim. A turn is an assistant message plus the tool results or user message that answer it. Older turns are dropped whole, never edited, so the provider's `raw` blocks stay intact.
- Once turns are being dropped, the opening message carries a **state note**. The harness builds it from disk and from its own runs; the model never writes it. It lists the files changed since the run started, a fresh test run (pass/fail counts and failing tests), and a fresh check run (verdict and failing lines). It is capped at about 300 tokens and is rebuilt only when files on disk change.

**Fixed cost.** The system prompt plus tool definitions are sent every turn. Each run logs them as `fixed_cost` in `run.json`, estimated at 4 characters per token. A test keeps actual's fixed cost under 1,000 tokens.

**Loop guard.** 3 identical assistant replies in a row stop the run as failed with reason `loop`.
