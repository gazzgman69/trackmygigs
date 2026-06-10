# Full app stress test + findings campaign (2026-06-09)

Goal: every feature end-to-end tested as if used by a crowd of real musicians, with dep flows and
messaging tested heaviest. Output is a prioritised FINDINGS list (bugs, improvements, UX/navigation),
not silent fixes. AI endpoints are stubbed (assumed working, tested by Gareth later).
Previous completed plan: tasks/archive-2026-06-09-mockup-gaps.md

## Phase 0 — Pre-flight (needs sign-off)

- [x] FIX FIRST (blocker, with Gareth's OK): accepting a dep offer creates no gig for the
      accepter (PATCH /api/offers/:id only flips status + swaps contacts). Without this fix the
      dep stress test just re-finds the same bug a hundred times. Surgical fix: on accept, stamp
      a copy of the gig into the accepter's diary with source='dep-accept', then re-verify.
- [x] AI stub: sim sets header X-Sim-AI=stub; /api/ai/* routes short-circuit to canned responses
      when the header + RELOAD_SECRET match, so flows that chain off AI run without burning usage
- [x] Wipe previous [STRESS]/sim leftovers (offers, threads visible in Gareth's account)

## Phase 1 — Fleet setup (~150 users, full coverage beats raw count)

- [x] Extend sim personas: every user gets a placeholder photo (i.pravatar.cc), bio, genres,
      postcode+radius, public slug; ~40% get full EPKs (picsum gallery, mock YouTube video URL,
      mock audio URL, testimonials); bands, leaders, deps distributed across UK regions
- [x] Verify public pages for a sample: /epk/:slug, /share/:slug (plain, ?times=1, ?embed=1)

## Phase 2 — Dep + messaging (the heavy focus)

- [x] Dep offers: send to specific people, broadcast, accept (verify gig lands in accepter's
      calendar + Offers counters + notifications), decline, snooze + reappear, nudge, cancel
      with replacement suggestion, expiry
- [x] Chat: 1-to-1, group threads, gig threads, renames, leave/delete semantics, read receipts
      (1-to-1 ticks + group "Read by X of Y"), 40KB cap, optimistic-send under cold start
- [x] Contextual sends both directions: gig share -> Add to my gigs, contact share -> save,
      setlist share -> Save to my repertoire (dedupe check), inbox previews
- [x] Marketplace: post pick + FCFS + free-with-reason, radius matching, multi-instrument,
      apply/withdraw, message-before-pick, pick -> others auto-declined + notified, repost,
      badge counts, FILLED-gig-500 demo bug repro attempt
- [x] Block/report: blocked users can't DM or see each other in discover

## Phase 3 — Money (invoices reconciled against money in/out)

- [x] Invoice lifecycle x many users: draft -> edit -> send (mock) -> mark paid / chase /
      delete; line items; teaching bundles; numbering sequence; pay slugs resolve
- [x] Receipts with photos (every add path), edit, delete, category filters
- [x] Reconciliation: sum(confirmed gig fees) == /api/earnings income; invoice paid/unpaid/
      overdue tiles == DB; MTD CSV totals == DB; receipts zip manifest == receipts rows;
      Home stats == Finance == Profile (the 0/0/£0 demo bug check)

## Phase 4 — Google Calendar + Sheets sync (Gareth's real account — needs consent)

- [x] Push single gig, push-all, edit in TMG -> sync, pull Google-side edits, sync-now failure
      detail, nudge import/classify/dismiss, disconnect/reconnect
- [x] Sheets: preview, import w/ column mapper, push edits back, pull, conflict resolver path
      (gigs.updated_at vs sheets_synced_at), disconnect
- [x] All test artefacts tagged [TEST] and deleted afterwards

## Phase 5 — Everything-else sweep

- [x] Gigs CRUD + wizard + quick-log parser edge cases; recurring teaching; CSV/Sheets import dedupe
- [x] Blocked dates: single, weekly pattern incl. until-date, CSV upload, unblock, share page accuracy
- [x] Setlists/songs/ChordPro; documents + expiry alerts; notifications centre + dismissals;
      settings/profile saves; auth (magic link request, logout, dev-login); premium gates as free user
- [x] Concurrency torture: simultaneous FCFS takes, simultaneous picks, double-send guards

## Phase 6 — UX / navigation audit (browser, Gareth's priority)

- [x] Walk core journeys as screenshots: first-run -> log gig -> invoice it -> get paid;
      receive dep -> accept -> see it in calendar; find musician -> chat -> book
- [x] Tap-target sizes, dead ends, back-button consistency, panel stacking, empty states,
      number of taps per common action; note every friction point

## Phase 7 — Report

- [x] tasks/FINDINGS.md: bugs (severity + repro), improvements, UX recommendations, prioritised
- [x] Wipe all sim data, verify Gareth's account back to clean
- [x] Roadmap docx entry + lessons

## Gareth's queued items (from this session, folded into FINDINGS as confirmed improvements)

1. BUG (confirmed): accepted dep offers never appear in calendar — no gig created on accept
2. Marketplace gig cards/detail need venue location info + tappable maps link (like own gigs)
3. Two-step accept option: "I can do it" -> poster confirms (per-gig setting at post time);
   design proposal to be included in FINDINGS
4. Swipe-left on a chat message for quick actions (delete, copy, maybe reply)
5. Reusable invoice line items with remembered prices (saved items library, invoice-side)
6. Google Calendar/Sheets sync must be bulletproof — Phase 4 dedicated pass

## Review (2026-06-10)

Campaign complete. Run 1: 150 users, 3,667 requests, all nine functional modules
PASS (dep offers 267/267, messaging 360/360, marketplace 157 + FCFS race 15/15).
Run 3 (post pool fix): re-confirmed at 25 users. Money reconciled to the penny on
Gareth's account (gigs == earnings == MTD CSV). Google Calendar + Sheets full cycle
verified live, including write-back into the actual sheet. Sim data wiped twice
(April stress cohort + both campaign fleets). Two P0s fixed and deployed during the
campaign (dep diary stamp, pool hardening). Full prioritised output: tasks/FINDINGS.md
(10 open bugs, 12 UX improvements incl. all four of Gareth's requests with designs,
5 notes). Phase 4 used Gareth's real account with his consent; [TEST] artefacts
cleaned except the bin-able [TEST] spreadsheet in his Drive (no Drive scope).
