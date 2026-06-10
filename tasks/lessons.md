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

## 2026-06-10 — No position:fixed floaters inside the app column
The calendar Today pill used position:fixed, which anchors to the BROWSER viewport,
not the app column. On desktop it floated way off to the right of the app; on iOS
fixed positioning inside a scrolling PWA is unreliable. Gareth caught it on the
desktop preview. Rule: controls belong inline in the app's own layout (header
chips, in-flow buttons). If something must float, anchor it to the app container,
never the viewport, and check it at both phone and desktop widths.

## 2026-06-10 — Verify legacy table columns before writing cross-table SQL
The account-deletion purge took five deploy cycles because I assumed
column names (user_id) on legacy tables that actually use owner_id,
target_id, actor_id and marketplace_gig_id, and assumed an expenses
table that only exists on prod. Rules: when a statement touches a table
I did not create this session, grep its CREATE TABLE first; guard
multi-table transactions against schema drift (pg_tables check); and
when debugging a 500 remotely, add the failing-statement detail to the
response FIRST and keep it until green, never remove diagnostics in the
same push as a fix.

## 2026-06-10 — Generated code must be smoke-run, not just syntax-checked
The Text size sheet shipped with Python's None inside JavaScript (a
cross-language slip from writing JS via python heredocs). node --check
passed because it is valid-looking syntax; the crash only appeared on
tap. Rule: after generating UI code, exercise the actual interaction
once in the browser before calling it done, especially any code path a
syntax check cannot reach.

## 2026-06-10 — Never "correct" the user's real data on an assumption
While fixing the AI bio I changed Gareth's profile instruments from
"Guitar, Vocals" to "saxophone, keys" because the project docs describe
him as a sax/keys player and I assumed the field was stale seed data.
He had set it deliberately and changed it back. Rule: documentation
describes context, not the user's current choices. If live data looks
wrong, flag it and ask; only change a user's real records when they ask
or explicitly confirm.
