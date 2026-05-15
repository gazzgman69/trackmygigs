# TrackMyGigs simulator

A Node script that drives the live TrackMyGigs API end-to-end with N
synthetic UK musicians, logs every request, polls the DB for invariants,
and writes a pass/fail report. Designed to surface regressions, slow
queries, and FK / migration bugs that single-user testing can never hit.

## Run

```bash
# Smoke test (10 users, ~1 min)
node sim/run.js --users 10

# Ramp (100 users, ~5 min)
node sim/run.js --users 100

# Full run (1,000 users, ~20-30 min on Neon paid tier)
node sim/run.js --users 1000 --concurrency 50

# Override the target (default: https://trackmygigs.replit.app)
node sim/run.js --users 100 --base https://your-staging-url.replit.app

# Wipe all sim data and exit (no run)
node sim/run.js --wipe
```

The simulator targets the **production** URL by default because that's where
real users live, and surfacing prod regressions early is the whole point.
You can re-aim with `--base` for staging.

## Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--users N` | 100 | How many virtual users to spawn |
| `--concurrency N` | 25 | Max active users at any moment. Neon free caps around 100; paid tiers comfortably take more. |
| `--base URL` | `https://trackmygigs.replit.app` | The live app to hit |
| `--admin-key K` | `LEROADSECRET!` | The `RELOAD_SECRET` env var used by the admin endpoints |
| `--seed N` | time-based | Deterministic RNG seed. Same seed → same set of virtual users + same behaviour. Re-run-friendly. |
| `--out-dir PATH` | `sim/results/<timestamp>` | Where the logs + report land |
| `--wipe` | off | Wipe all `sim+*@trackmygigs.app` data and exit |

## What it does

For each virtual user it:

1. **Bootstraps the account** via `POST /api/admin/sim-create-user` (server
   mints a session token, returns it for the per-user cookie jar). Skips the
   real signup / magic-link flow because that needs a real mailbox.
2. **Onboards** — patches profile (rate card, bio, photo URL, postcode,
   available_now), mints a public_slug for half the users.
3. **Opens Home** — exercises the `/api/stats` payload, `/api/user/profile`
   aggregations, `/api/gigs`, `/api/calendar/status`, `/api/ai/status`, etc.
4. **Logs gigs** — 5-15 for active giggers, fewer for hobbyists, with a
   geographic mix: 80% local (inside `travel_radius_miles`), 15% mid-range,
   5% touring (>100mi). Each gig has a real UK venue postcode + pre-computed
   lat/lng so the distance / mileage / navigate paths all populate.
5. **Invoices** — for each past confirmed gig, create + send an invoice and
   sometimes mark paid. ~15% of invoices start as drafts to exercise the
   Save Draft fix.
6. **Marketplace** — band-leader / active-gigger personas post dep gigs;
   dep-specialist / hobbyist personas apply. Posters pick a winner on ~60%
   of posts. Tests the Browse → Apply → Pick flow under load including the
   auto-thread bootstrap.
7. **Social** — Find Musicians searches (`name`, `nearby`, `instrument_match`),
   dep offers (send + withdraw + accept/decline), chat messages into the
   threads spawned by Pick / offer-accept.
8. **Final stats poll** — exercises the cache + SWR refresh path.

Errors at any step are logged with full context (request body, response
body sample, latency, retry count) so they're easy to track down. A flow
that throws gets logged as `flow_threw` but doesn't kill the user — the
remaining flows still run so a single bug doesn't cascade.

## Persona mix

| Persona | Weight | Behaviour |
|---------|--------|-----------|
| `active_gigger` | 40% | 5-15 gigs, invoices most, posts a few marketplace gigs, sends dep offers |
| `hobbyist` | 35% | 1-3 gigs, sometimes invoices, browses marketplace rarely applies |
| `dep_specialist` | 15% | Few own gigs, many marketplace applications, `available_now=true` |
| `band_leader` | 5% | Posts many marketplace gigs to find deps, fewer own gigs |
| `lurker` | 5% | Signs up, sets profile, does almost nothing else |

## Geographic distribution

Each virtual user gets a real UK outward postcode (e.g. `M14`, `SW1A`, `EH1`)
weighted to roughly match where UK gigging musicians actually live:

- London ~25%, Manchester/Birmingham/Leeds/Liverpool ~15%
- Bristol/Brighton/Cardiff/Glasgow/Edinburgh ~20%
- Long tail of smaller cities + market towns

Pre-computed lat/lng accompanies each postcode so the simulator can pre-pick
"nearby" vs "touring" venues without round-tripping to postcodes.io. This
keeps the run fast and deterministic. The real `users.home_lat/lng` populates
directly via the create endpoint; no server-side geocode lookup needed for
sim users.

## Output

Each run writes a timestamped directory under `sim/results/`:

```
sim/results/2026-05-15T07-42-31-000Z/
├── summary.json          # Run metadata + DB stats before/after
├── events.jsonl          # Every HTTP request/response (1 line each)
├── errors.jsonl          # Errors with extra context (request bodies, stack traces)
├── report.json           # Per-endpoint roll-ups + invariants + pass/fail
├── report.html           # Single-page HTML to open in a browser
├── slowest-paths.json    # Top-50 slowest individual requests
└── top-errors.json       # Top-50 error groups with example bodies
```

`report.html` is the primary deliverable — open it in a browser to see the
verdict, DB delta, per-endpoint p50/p95/p99 latency, and the top error
groups with example response bodies pasted in.

## Pass criteria

The "VERDICT" block printed to stdout at the end shows:

- **5xx-free**: zero responses in the 500-599 range. PASS if true.
- **Users**: how many of the requested N successfully bootstrapped.
- **Requests**: total HTTP calls across the run.
- **Errors**: total non-2xx (excluding intentional 4xx like rate limits or
  validation rejections from error-injection).
- **Flow throws**: how many times a flow function itself threw. Should be 0.
- **DB delta**: increments per key table (`users`, `gigs`, `invoices`, etc).

A clean pass looks like: `5xx-free=PASS`, `users=1000/1000`, `flow_throws=0`,
DB delta showing realistic increments across all the major tables.

## Cleanup

```bash
node sim/run.js --wipe
```

Hits `POST /api/admin/wipe-sim-data?key=...` which deletes every row owned by
or referencing a `sim+*@trackmygigs.app` user, in dependency order, in a
single transaction. Idempotent — safe to re-run. Your real account + the 5
demo profiles you carried over from dev are never touched.

If the wipe is interrupted mid-flight (network drop, server restart), just
run it again. Postgres transactions guarantee partial deletes never land.

## Admin endpoints

| Method + Path | Purpose |
|---|---|
| `POST /api/admin/sim-create-user?key=...` | Create a sim user with profile fields, return `{ user_id, session_token }`. |
| `GET /api/admin/sim-stats?key=...` | Return DB row counts + status distributions + sanity counters. |
| `POST /api/admin/wipe-sim-data?key=...` | Delete every sim+* user and their cascading data. |

All three are gated by `RELOAD_SECRET`. Don't expose the secret in client code.

## Limits + known gaps

- **No browser**. The simulator only drives the HTTP API. Browser-only
  paths (Web Speech mic permission, Service Worker offline mode, the
  Navigate button's iOS Maps deep-link) are tested at the URL-construction
  level only.
- **No real Anthropic spend**. The AI features are exercised via their
  endpoints but the underlying `callHaiku` helper isn't patched for the
  sim. If you want a fully isolated AI mock, set `ANTHROPIC_API_KEY=""` on
  the server before running the sim — `isEnabled()` will return false and
  every AI route will gracefully return 503. (The simulator doesn't directly
  hit AI feature endpoints heavily, so this is rarely needed.)
- **No real Google Calendar / Sheets**. Those routes are exercised
  (status, list, push, pull) but with no connected Google account they
  return `connected: false`. To exercise the full sync path, connect a
  Google account to one or two sim users out of band before re-running.
- **No payment flows**. Stripe checkout creates real Stripe Customer
  objects which we don't want to pollute. The premium upgrade path is
  best tested manually with a Stripe test card.
- **Rate limits**: the directory search routes have per-actor rate limits
  (30/hr for `name`, 20/hr for `email`+`phone`). The simulator stays well
  under those for any single user; if you push concurrency very high you
  may see 429s on those routes — that's expected, not a bug.

## Re-running for regression baselines

Use `--seed <integer>` to get the exact same set of virtual users +
exact same behaviour across runs. This gives you a stable baseline to
compare report.html against after a code change. Suggested seed: `42`.

```bash
node sim/run.js --users 1000 --seed 42 --out-dir sim/results/baseline-v1
# ... ship a code change ...
node sim/run.js --users 1000 --seed 42 --out-dir sim/results/baseline-v2
```

Then diff the two report.json files (or open the two HTML reports side
by side) to see what changed in latency, error rates, or DB shape.

## What to do if a run fails

1. Open `report.html`. Look at the top-errors table for the first 1-2 rows.
2. Open `errors.jsonl` and grep for the offending status / path to see
   the full request body that triggered it.
3. Open the matching code path in the repo (paths in errors point straight
   at the route).
4. Fix, redeploy, `--wipe`, re-run with the same `--seed` to compare.
