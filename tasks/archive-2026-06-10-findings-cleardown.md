# Findings clear-down (2026-06-10)

Working tasks/FINDINGS.md to zero, signed off by Gareth ("work through all of these").
Three waves, one push + deploy + verify per wave.

## Wave A — Sync trust

- [x] (F3) Resurrection: tombstone table for deleted google_event_ids; gig delete verifies the
      Google delete with retry and records the tombstone either way; pull skips tombstoned events
- [x] (F4) Connect-flow import: per-event checkbox review in the modal (default ticked)
- [x] (F6) sync-now: report skipped (read-only imports, deleted) separately from failed, with
      readable reasons; failures sheet UI updated to match
- [x] (F7) Single push endpoint: fix the false-failure response

## Wave B — Identity + flags

- [x] (F5) startChatWith/openChatThread closes other open panel-overlays so the thread is visible
- [x] (F8) Premium: subscription_tier is canonical; migrate users.premium=TRUE into it;
      dev-set-premium and any other writers set both
- [x] (F9) Contacts: backfill linked_user_id <-> contact_user_id both ways; writers set both
- [x] (F10) sheets status: surface needs_reconnect honestly (same signal the calendar banner uses)

## Wave C — UX batch

- [x] (F11) Marketplace detail: venue address + Open in Maps (reuse openDirections)
- [x] (F12) Two-step accept: offers.confirm_mode, status 'provisional', sender Confirm/Release,
      diary stamp + contacts only on confirm; send-dep toggle; both Offers tabs updated
- [x] (F13) Swipe-left (touch) or long-press a message bubble -> action sheet: Copy / Delete (own)
- [x] (F14) Saved invoice items: invoice_saved_items table, auto-save on invoice create,
      autocomplete + rate autofill in itemise rows, small manager sheet
- [x] (F15) Boot splash in index.html, removed on first render
- [x] (F16) Marketplace empty state: distinguish "none exist" vs "filtered out"; Show-all button
- [x] (F17) My Network double header removed
- [x] (F18) Directory avatar onerror falls back to initials
- [x] (F19) Quick-log: "next <weekday>" means the week after; "this <weekday>"/bare = upcoming
- [x] (F20) Quick-log save: 12s timeout, inline error, sheet stays open
- [x] (F21) Receipts claimable figure: fix or relabel after reading the calculation
- [x] (F22) Delete the three [SEC-TEST] expenses from Gareth's account
- [x] (F24) Discover: ensure every mode bounds candidates before the per-row subqueries

## Ship ritual

Per wave: node --check, batched commit, push, reload, curl + browser verification, tick here.

## Review (2026-06-10)

All findings cleared in three waves (commits b3c10a1..e13f51e), each deployed and
verified live. Two findings were withdrawn after honest retests (resurrection was a
tester-side duplicate; push false-error was a post-OAuth transient). Bonus catch:
the Stripe webhook had the same premium-flag bug as dev-set-premium, so real paying
customers would not have unlocked premium features. Verified live: provisional ->
confirm stamps the diary, release does not; saved items autocomplete with rates;
sync-now reports 0 failed; marketplace maps link; panel stacking fixed; boot splash;
zero console errors. Deploy gotcha hit once: static files updated while the node
process kept old routes — reload twice and verify a NEW route responds, not just
/api/stats (lesson recorded).
