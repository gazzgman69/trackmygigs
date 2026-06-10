# Lessons

## 2026-06-09 — Plan sign-off before implementation
Started implementing the mockup-gap batch (schema migration edit) before writing a plan to tasks/todo.md and getting Gareth's sign-off. Gareth's standing methodology: for any non-trivial task, write the plan to tasks/todo.md FIRST, check in, then build.
Rule: before the first Edit/Write on a non-trivial task, tasks/todo.md must exist with the plan, and Gareth must have seen it.

## 2026-06-10 — Verify on an idle server before calling something broken
The big campaign's 17 "bugs" in sweep/public-pages were all one cause: dev Postgres
connection-slot exhaustion. Endpoints I had hand-verified hours earlier showed as
broken under load. Rule: when a batch of unrelated endpoints fails together with
identical latency (all ~10s = the connect bound), suspect infrastructure first and
retest idle before logging app bugs.

## 2026-06-10 — Watch the load you generate
Running the 150-user sim at concurrency 12 against the dev Repl wedged it and
poisoned the UX walk happening at the same time. Rule: dev instance tolerates ~4
concurrent active synthetic users; run heavier campaigns against production, or
sequence load tests and interactive testing.

## 2026-06-10 — Verify route freshness after reload, not just liveness
After a reload the static bundle updated but nodemon did not restart the server, so
new API routes 404'd while /api/stats (old code) returned 200 and 'deployed' looked
true. Rule: after deploying server-route changes, verify by hitting one of the NEW
routes (expect 200/structured error), not a pre-existing endpoint.

## 2026-06-10 — Multi-edit python scripts must write incrementally or assert first
A multi-replacement script asserted halfway and exited without writing, leaving HALF
the intended edits applied on the next partial run. Rule: run all assertions before
any replace, or apply each edit in its own script run, and grep the file for EVERY
expected symbol afterwards.
