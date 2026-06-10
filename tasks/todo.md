# Landing page refresh + premium purchase check (2026-06-10)

## Phase 1 — Purchase flow

- [ ] Fix Stripe checkout: omit trial_period_days when 0 (Stripe rejects 0, so anyone who
      already used a trial can never check out — found live with Gareth's account)
- [ ] Verify live: fresh checkout URL returned for a returning-trial user; logged-out 401
      bounce to /app?intent=premium still works; intent handler kicks off checkout post-login

## Phase 2 — Content refresh (public/landing.html, keep the visual identity)

- [ ] Phone mock: update dock + cards to today's Home (5-tab nav, hero card, Needs You)
- [ ] New feature sections for everything built since April:
      dep network (offers, two-step confirm, cascade premium), urgent-gig marketplace
      (first-come vs pick, maps), Find Musicians directory, chat (gig/contact/setlist
      sharing, group threads, read receipts), EPK (gallery, video, audio, testimonials),
      public availability share + embed + next-gig widget, setlists/ChordPro/print,
      Google Calendar + Sheets two-way sync, push reminders, receipts photos +
      accountant zip, invoice line items + saved items + pay links
- [ ] Refresh stale copy in existing "What if" rows; keep mileage/tax rows (still true)
- [ ] Pricing truth-check: free list vs premium list vs actual app gates
- [ ] FAQ pass for accuracy
- [ ] DECISION (Gareth): invented stats (10k+ gigs, 500+ musicians) and fictional
      testimonials — keep, soften, or swap for honest capability stats?
- [ ] DECISION (Gareth): landing lists "EPK page" as FREE but the app gates EPK behind
      premium (and the stated principle is premium covers EPK) — which is right?

## Phase 3 — Verify

- [ ] Browser pass: sections, pricing toggle, checkout CTA both auth states, console clean
- [ ] Deploy + grep + tick

## Review

(to be completed)
