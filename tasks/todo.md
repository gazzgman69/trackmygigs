# Findings clear-down (2026-06-10)

Working tasks/FINDINGS.md to zero, signed off by Gareth ("work through all of these").
Three waves, one push + deploy + verify per wave.

## Wave A — Sync trust

- [ ] (F3) Resurrection: tombstone table for deleted google_event_ids; gig delete verifies the
      Google delete with retry and records the tombstone either way; pull skips tombstoned events
- [ ] (F4) Connect-flow import: per-event checkbox review in the modal (default ticked)
- [ ] (F6) sync-now: report skipped (read-only imports, deleted) separately from failed, with
      readable reasons; failures sheet UI updated to match
- [ ] (F7) Single push endpoint: fix the false-failure response

## Wave B — Identity + flags

- [ ] (F5) startChatWith/openChatThread closes other open panel-overlays so the thread is visible
- [ ] (F8) Premium: subscription_tier is canonical; migrate users.premium=TRUE into it;
      dev-set-premium and any other writers set both
- [ ] (F9) Contacts: backfill linked_user_id <-> contact_user_id both ways; writers set both
- [ ] (F10) sheets status: surface needs_reconnect honestly (same signal the calendar banner uses)

## Wave C — UX batch

- [ ] (F11) Marketplace detail: venue address + Open in Maps (reuse openDirections)
- [ ] (F12) Two-step accept: offers.confirm_mode, status 'provisional', sender Confirm/Release,
      diary stamp + contacts only on confirm; send-dep toggle; both Offers tabs updated
- [ ] (F13) Swipe-left (touch) or long-press a message bubble -> action sheet: Copy / Delete (own)
- [ ] (F14) Saved invoice items: invoice_saved_items table, auto-save on invoice create,
      autocomplete + rate autofill in itemise rows, small manager sheet
- [ ] (F15) Boot splash in index.html, removed on first render
- [ ] (F16) Marketplace empty state: distinguish "none exist" vs "filtered out"; Show-all button
- [ ] (F17) My Network double header removed
- [ ] (F18) Directory avatar onerror falls back to initials
- [ ] (F19) Quick-log: "next <weekday>" means the week after; "this <weekday>"/bare = upcoming
- [ ] (F20) Quick-log save: 12s timeout, inline error, sheet stays open
- [ ] (F21) Receipts claimable figure: fix or relabel after reading the calculation
- [ ] (F22) Delete the three [SEC-TEST] expenses from Gareth's account
- [ ] (F24) Discover: ensure every mode bounds candidates before the per-row subqueries

## Ship ritual

Per wave: node --check, batched commit, push, reload, curl + browser verification, tick here.

## Review

(to be completed)
