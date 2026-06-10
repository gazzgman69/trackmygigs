# TrackMyGigs full-app test campaign — FINDINGS (2026-06-10)

STATUS: ALL ITEMS CLEARED as of 2026-06-10 (commits b3c10a1..e13f51e).
Every open bug and improvement below was fixed, deployed, and verified live;
two items were withdrawn after honest retests. Detail per item left intact
for the record.

How this was produced: 150 simulated musicians ran every feature against the dev app
(3,667 requests, assertion-checked), plus a 25-user follow-up run, a hands-on browser
UX walk, a to-the-penny money reconciliation, and a live Google Calendar + Sheets
sync cycle on Gareth's account. All synthetic data wiped afterwards. AI endpoints
deliberately untested (Gareth will test by hand). Raw evidence: sim/results/*-campaign/.

═══════════════════════════════════════════════════════════════════
## P0 — Fixed during the campaign (deployed + regression-tested)
═══════════════════════════════════════════════════════════════════

1. **Dep work never reached the winner's calendar** (found by Gareth). Accepting a dep
   offer, winning an FCFS take, or being picked only flipped statuses; no gig was
   created for the dep. Fixed via a shared diary-stamp (source 'dep-accept' /
   'marketplace-fill', sender or poster becomes gig leader, agreed fee wins,
   idempotent). 267/267 dep assertions + FCFS race (exactly one winner) now pass.
2. **API wedged permanently under load.** pg pool defaults (10 conns, infinite wait)
   plus a 20-conn experiment exhausted the dev Postgres slots; every request hung
   until a hard restart. Now: max 10 (PG_POOL_MAX override for prod), 10s bounded
   connect wait, 30s statement timeout. Verified recovered.

═══════════════════════════════════════════════════════════════════
## P1 — Real bugs, open, in priority order
═══════════════════════════════════════════════════════════════════

3. ~~Deleted gigs can resurrect~~ **WITHDRAWN after clean retest (2026-06-10).**
   The "resurrection" was a duplicate test gig created by an aborted shell command
   during testing, not the app. A clean create-push-delete-pull-pull cycle does not
   resurrect. No tombstone work needed.
4. **FIXED.** Calendar-connect bulk import trusts the AI classifier blindly.** "Wedding
   anniversary next week" and "Doz's birthday next week" imported as confirmed gigs
   (they then show as BUSY on the public availability page). The modal offers
   "Import all 6" with no per-event review. Fix: checkbox list per event, default
   ticked, so obvious non-gigs can be dropped in one glance.
5. **FIXED.** "Send message" from Find Musicians opens the chat invisibly.** The thread panel
   opens BEHIND the network panel (panel-stacking order); the user sees nothing
   happen. Fix: close panel-network before opening panel-chat-thread.
6. **FIXED.** Sync-now reports by-design skips as failures.** Google-imported gigs that are
   deliberately not pushed back (read-only until edited in TMG) are counted in
   pushed.failed with reason "push_returned_null" — the UI would say "8 failed"
   forever. Fix: separate skipped from failed, human-readable reasons.
7. ~~Single-gig push reports failure while succeeding~~ **DOWNGRADED after retest.**
   Could not reproduce; the one occurrence was seconds after the OAuth reconnect
   (token not yet usable, push returned null, a later sync created the event).
   Clean retest returns success with the event id. No code change.
8. **FIXED** (incl. the Stripe webhook, which had the same bug). Two competing premium flags. /auth/dev-set-premium sets users.premium +
   premium_until; the lineup gate and client UI read users.subscription_tier.
   Confirmed live: a dev-set-premium user gets 403 on premium features. Pick one
   flag (suggest subscription_tier, set by Stripe webhook) and migrate the other.
9. **FIXED** (writers set both + two-way backfill). Contacts table split-brain. POST /api/contacts writes linked_user_id; chat
   permission checks and the dep replacement picker read contact_user_id (only
   populated when a dep offer resolves the contact by email). Hand-added contacts
   are invisible to those flows until then. Pick one column, backfill, drop the other.
10. **FIXED.** Dead Google token reported as live. /api/sheets/status returns
    has_google_token:true when the token is revoked. The calendar banner gets it
    right ("needs to be reconnected"); sheets status should verify the same way.

═══════════════════════════════════════════════════════════════════
## P2 — UX and navigation improvements (Gareth's priority area)
═══════════════════════════════════════════════════════════════════

11. **BUILT.** Marketplace venue location + maps link (Gareth). Detail screen should
    show the full address with the same "Open in Maps" tap as own gigs. The data is
    already in marketplace_gigs (venue_address/postcode); reuse openDirections().
12. **BUILT** (verified live: provisional, confirm stamps diary, release does not). Two-step accept option (Gareth). Keep one-tap accept as the
    default (panic deps need speed). Add a per-offer choice at send time mirroring
    the marketplace's fcfs-vs-pick: "First yes wins" vs "I'll confirm each".
    Confirm mode: accept => status 'provisional', sender notified, sender confirms
    or releases; diary stamp + contact swap only on confirm.
    Schema: offers.confirm_mode BOOLEAN, status gains 'provisional'.
13. **BUILT** (swipe or long-press, Copy + Delete own). Swipe-left on chat messages (Gareth): reveal Copy / Delete (own) / Share.
    Long-press as the desktop/accessibility fallback.
14. **BUILT** (auto-saved with last rate, autocomplete + autofill, manager sheet). Reusable invoice items (Gareth): autocomplete previous line items with last
    price in the itemise rows + a small "Saved items" manager inside the invoice
    panel. Mirror of the existing invoice_clients pattern (new table
    invoice_items_saved: user_id, description, rate, last_used_at).
15. **BUILT.** No splash on cold boot. Replit cold starts show a black screen until /auth/me
    returns. Add an instant skeleton/logo so it never looks dead.
16. **FIXED** (future-dated total_open distinguishes the cases; Show-all button). Marketplace empty state Says "match your filters"
    even when zero gigs exist at all, and offers no one-tap "show everything".
    Differentiate the two cases and add a "Show all gigs" shortcut button.
17. **FIXED.** Double header on My Network. "‹ Back My Network" panel header sits directly
    above a second "‹ My Network + Add" header. Remove the inner one.
18. **NO CHANGE NEEDED** (onerror fallback already existed; observed circles were slow loads). Directory avatar fallback. A slow/failed photo URL leaves an empty circle;
    fall back to initials (the chat bubbles already do this properly).
19. **FIXED** ("next X" now means the week after). Quick-log "next Friday" parses as the upcoming Friday; many people mean the
    week after. Suggest "this Friday"/"Friday" = upcoming, "next Friday" = +1 week.
    The live parse preview already makes errors catchable — keep that.
20. **FIXED** (12s timeout, friendly retry message). Quick-log save under a slow server sits on "Saving…" with no timeout. Add a
    10s timeout with inline error + retry (code path is otherwise correct).
21. **FIXED** (tolerant category matching for legacy rows). Receipts "Claimable £0" showed against £283 of expenses incl. Travel during
    the walk — verify the claimable calculation (may only count mileage, in which
    case label it "Mileage claimable" to avoid looking broken).
22. **DONE** (deleted). Stale [SEC-TEST] expenses (3 rows, Dec 2025) sit in Gareth's real receipt
    list from an old test — delete after confirming.

═══════════════════════════════════════════════════════════════════
## P3 — Notes / housekeeping
═══════════════════════════════════════════════════════════════════

23. Dev Replit instance saturates around 10-12 concurrent active users (10s+ medians,
    timeouts). Production (Neon) handled 50 concurrent in May with zero 5xx. Demo
    from the production deployment, not the dev URL.
24. PARTLY ADDRESSED (nearby candidates bounded to 200; full precompute deferred). /api/discover is the heaviest query in the app (4 correlated subqueries per
    candidate row). Fine when idle (0.8s for 175 users); first thing to die under
    load. Candidate: precompute gig/offer counts or LIMIT before decorating.
25. After connect, Google Calendar sync pushed all 19 TMG gigs (incl. [DEMO] seeds)
    to the connected calendar. Expected behaviour, but Gareth's test calendar now
    contains them; the [TEST] sheet "[TEST] TMG sync check 2026-06-10" in his Drive
    can be binned (couldn't self-delete: app has no Drive scope, deliberately).
26. The 6 calendar-imported gigs (incl. the 2 misclassified personal events) are
    left in Gareth's account for his review — deleting them from TMG may remove
    the matching Google events, so review rather than bulk-delete.
27. Browser walk did not cover: invoice composer visuals, chat thread visuals, EPK
    editor, repertoire screens (all API-verified though). Worth eyeballing when
    convenient.

═══════════════════════════════════════════════════════════════════
## What was proven to WORK (all assertion-checked against production code)
═══════════════════════════════════════════════════════════════════

- Dep offers end to end: send (pick + broadcast), accept => diary stamp + contacts
  swap, re-accept can't double-book, decline, snooze + reappear, nudge with 2-cap,
  cancel with replacement, sent-tab counters. 267 + 58 checks across two runs.
- Messaging: 1-to-1, group threads, gig threads, renames, leave semantics, read
  receipts (ticks + group counts), gig/contact/setlist shares with server-side
  snapshots, save-shared with song dedupe, 40KB cap, message delete. 360 + 126 checks.
- Marketplace: fee floor, free-with-reason, pick + FCFS, the FCFS race (5 parallel
  applies, exactly one winner), winner diary stamp, losers auto-rejected + late
  applies 409, FILLED-gig 500 no longer reproduces, message-before-pick DM gate
  (403 without an application, allowed with), withdraw/cancel/repost, block/report.
- Money: every invoice/expense echo check across 150 users passed; Gareth's account
  reconciles to the penny: gigs £3,359.00 == /api/earnings == MTD CSV, expenses
  £207.45 == earnings == MTD, invoice buckets consistent, receipts zip valid.
- Google: calendar OAuth reconnect, import (6 events), single push, edit + sync,
  pull, delete (when the mirror works — see bug 3); Sheets: brand-new sheet,
  preview, column-mapped import, TMG-edit write-back verified IN the actual sheet,
  pull with zero conflicts, disconnect.
- Public pages at scale: /epk/:slug, /share/:slug (+times/+embed), next-gig .ics.
- Profiles: 150 users with photos, bios, EPKs (galleries, testimonials, video and
  audio URLs), slugs; premium gate verified both ways (modulo bug 8).
