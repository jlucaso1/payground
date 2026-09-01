## What changed

<!-- One or two sentences. -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## How you verified it

<!-- Tests added, commands run, requests compared against the real API. -->

---

Reminders:

- If you touched `spec/overlay.ts` or the generator in `tools/spec-sync`, re-run `bun run spec:gen` and commit the result.
- If you implemented a new operation, move its operationId from `pending` to `operations` in `packages/server/src/routes/<product>.ts`.
