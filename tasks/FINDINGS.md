# TrackMyGigs full-app test campaign — findings (work in progress, 2026-06-10)

Status: campaign run 1 (150 users) complete, heavy modules all PASS; run 2 (25 users,
gentle) in progress to cover the phases that timed out; UX walk + Google sync pending.

## A. Bugs found and ALREADY FIXED during the campaign

1. **Accepted dep work never reached the dep's calendar** (CRITICAL, found by Gareth).
   Accepting a dep offer, winning an FCFS take, or being picked only flipped statuses.
   Fixed: gig copy stamped into the winner's diary (source dep-accept / marketplace-fill,
   sender or poster becomes gig leader, agreed offer fee wins). Idempotent. Verified live
   and regression-asserted 267/267 in the campaign.

## B. Bugs confirmed, NOT yet fixed

2. **Two competing premium flags.** `/auth/dev-set-premium` (and possibly other paths) set
   `users.premium` + `premium_until`, while the lineup gate and the client UI check
   `users.subscription_tier === 'premium'`. The two disagree; premium upgrades through one
   path won't unlock features gated on the other. Decide the canonical flag (suggest
   subscription_tier) and migrate.
3. **Contacts linkage split.** `POST /api/contacts` writes `linked_user_id`, but thread
   creation (routes/chat.js) and the offer-cancel replacement picker read
   `contact_user_id` (only populated when a dep-offer send resolves the contact by email).
   Contacts added by hand are therefore invisible to flows that should recognise them.
   Decide one column and backfill the other.
4. **Dead Google token reported as live.** `/api/sheets/status` returns
   `has_google_token: true` when the stored token no longer works (calendar reports
   connected:false). The UI can't prompt a reconnect off that signal. Status should
   verify the token (or at least reconcile with the calendar connection state).

## C. To verify in the clean pass (observed under load, may be environmental)

5. Quick-log save under slow network: button sits on "Saving…" with no timeout; retest
   clean, and add a timeout + inline error if reproducible.
6. Home hero staleness after quick-log save (code looks correct; verify).
7. Cold boot shows a pure black screen until /auth/me returns. On a Replit cold start
   that is many seconds of "is it broken?". Add a splash or skeleton.

## D. Improvements queued from Gareth (with design proposals — to finish in final report)

8. **Marketplace location info + maps link.** Cards show distance but the detail screen
   should show the full address with the same tappable "Open in Maps" affordance as own
   gigs (`openDirections`). Cheap: snapshot already carries venue fields.
9. **Two-step accept option for dep offers.** Keep one-tap accept as default (panic deps
   need speed). Add per-offer setting at send time, mirroring the marketplace's
   fcfs-vs-pick concept: "First yes wins" vs "I'll confirm". In confirm mode an accept
   puts the offer into 'provisional' and notifies the sender, who confirms or releases;
   only on confirm does the diary stamp + contact swap happen. Schema: offers.status
   gains 'provisional'; offers.confirm_mode BOOLEAN.
10. **Swipe-left message actions.** Swipe a bubble to reveal Copy / Delete (own messages)
    / Share. Touch: touchstart/touchmove transform with a threshold, falls back to
    long-press on desktop.
11. **Reusable invoice items.** Autocomplete in the itemise rows from previously used
    line items (description + last rate), plus a small "Saved items" manager inside the
    invoice panel. Pattern already exists for clients (invoice_clients) — add
    invoice_items_saved (user_id, description, rate, last_used_at).
12. **"next Friday" parsing.** Quick-log parses "next Friday" as the upcoming Friday;
    many users mean the Friday after. Suggest: treat "this Friday" as upcoming,
    "next Friday" as the following week, and always show the parsed date prominently
    (already done) so misreads are catchable.

## E. Campaign results (run 1, 150 users, 3,667 requests)

- PASS: fleet 424 checks, gigs 1350, invoices 510, expenses 759, dep-offers 267,
  messaging 360, marketplace 157, FCFS race 15 (exactly one winner), block semantics 3.
- Regressions specifically asserted and passing: dep-accept diary stamp + re-accept
  dedupe, marketplace-fill stamp, FILLED-gig 500 (no longer reproduces), message-before-
  pick DM authorization, fee floor, 40KB message cap, save-shared song dedupe.
- INVALID (timeouts after the dev instance saturated; covered by run 2): sweep,
  public-pages, reconciliation.
- Environment note: this hammered the DEV Replit instance. The May 1,000-user load test
  against the production deployment recorded zero 5xx; the dev box starts timing out
  around 12 concurrent users. Not an app bug, but worth remembering when demoing.

## F. UX walk notes (in progress)

- Quick-log sheet: placeholder, live parse preview and colour cue are genuinely good.
- (to be completed after run 2)

## G. Deliberately untested

- All /api/ai/* endpoints (Gareth will test by hand; flows that chain off AI were
  exercised through their non-AI paths).
- Apple Wallet pass (route is a stub pending Apple Developer enrolment).
- Stripe checkout (would create real billing objects).
