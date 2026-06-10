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
