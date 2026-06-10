# Musician-life wave 2 (2026-06-10, "lets add 4-10")

Mockups first for the four new screens, then build in waves.

## Mockup round (pending Gareth sign-off)

- [ ] Documents wallet mockup: store PLI/PAT/insurance docs (BYTEA, like
      receipt photos), expiry dates with Home reminder chip, one-tap share
      link a venue can open without logging in
- [ ] Band availability poll mockup: pick dates, share into a chat thread,
      participants tap yes/no per date, live tally; poll state lives
      server-side (not a snapshot) so votes update
- [ ] Gig fee splitter mockup: fee minus costs, equal or custom split with
      optional leader cut, mark-paid per member; rides on lineup (premium)
- [ ] Post-gig follow-up mockup: morning-after prompt on past gigs with a
      client contact; testimonial ask via public link; submissions land as
      pending and feed EPK testimonials after approval
- [ ] Inline proposals (no new screens): weather on gig card + pack within
      48h (Open-Meteo via server proxy, venue lat/lng already stored); kit
      checklist templates on the existing prep checklist (save as template
      by gig type, one-tap apply); unpaid invoice chase = overdue list in
      the invoice panel + one-tap prefilled chase email and "chased" stamp
      (manual send, consistent with nothing-auto-sends)

## Build waves (after sign-off)

- [ ] Wave A: documents wallet (+ expiry chip)
- [ ] Wave B: weather + kit templates + invoice chase (small batch)
- [ ] Wave C: fee splitter (premium, on lineup)
- [ ] Wave D: availability poll (chat attachment kind with live state)
- [ ] Wave E: post-gig follow-up + public testimonial submit + EPK approval

# Musician-life wave (2026-06-10, mockups approved "go ahead")

Build order agreed: venue memory -> gig pack -> rebooking radar.

## Wave 1 — Venue memory

- [x] Tables: venue_notes (private, per user+venue), venue_facts (community,
      structured kinds: limiter/parking/loadin/power/pa/stage, keyed
      name+outward postcode), venue_fact_votes (confirm/flag, one per user)
- [x] Write gate: only users with a logged gig at the venue can add/vote;
      community facts need a postcode in the venue address (prevents
      cross-town "The Crown" collisions); value length capped; one fact per
      kind per user (upsert own). Nothing reputational: kinds are fixed.
- [x] API: GET /api/venues/detail (stats, gigs, notes, facts+votes,
      canContribute), PUT notes, POST fact, POST fact vote
- [x] UI: venue panel (stats row, community heads-up with confirmed-by +
      thumbs, freshness banner after a recent gig there, private notes,
      gigs-here list), entry link on gig detail
- [x] Deploy + verify live (facts gated, votes, notes persist)

## Wave 2 — Gig pack

- [x] Migration: gigs.load_in_time, soundcheck_time, stage_time TIME,
      parking_notes TEXT; PATCH whitelist extended
- [x] Pack panel from gig detail: timeline (leave-by -> load-in -> soundcheck
      -> on stage -> finish), essentials (contact, maps, parking, dress code,
      fee+invoice state, setlist), venue heads-up line, inline edit of the
      new fields
- [x] Share to band chat as a snapshot card (house pattern; snapshot, not
      live-updating - difference from mockup noted to Gareth)
- [x] Deploy + verify live

## Wave 3 — Rebooking radar

- [x] rebook_dismissals table (dismiss forever / snooze a month)
- [x] GET /api/rebooking-suggestions: one-off venue gigs 10-12 months old
      with no later booking; wedding-looking gigs ~11 months old framed as
      anniversary; regular venues overdue vs their usual gap. Pure SQL/date
      arithmetic, no AI.
- [x] Home card "Worth a follow-up" (count + estimated value) -> panel of
      cards with Message / Dismiss / Snooze; Message routes to chat when a
      contact matches, otherwise shows the gig's client details
- [x] Deploy + verify live

## Review (2026-06-10, commits e0db142..1659cc7)

Wave 1 venue memory: tables + gated API + panel live. Verified on the dev
server: fact created by Gareth (postcode OX27 derived from the address),
demo2 blocked from adding/voting without a gig there (403s), self-vote
blocked, demo2 gained access by logging a gig, confirm bumped the count,
flag flipped disputed, notes round-tripped, all test data cleaned up.
Wave 2 gig pack: soundcheck_time column, timeline panel (leave-by 16:00
computed from 27 mi), inline edit saved via PATCH, chat snapshot extended
(soundcheck/sets/parking/leader) and proven inside a sent message. One
bug found and fixed during verify: /api/chat/threads returns {threads},
not an array. Wave 3 radar: all three rules fired on crafted demo data
(rebook £320 / anniversary £650 / regular £153 avg), dismiss permanent,
snooze 30 days, Home card wired; ym key fix (pg Date objects). Panels
verified rendering with a clean console. Gareth's radar is empty today
because nothing in his history sits in the 10-12 month windows yet.

# Google pin three-choice tap (2026-06-10, approved "yeh build it")

Tapping a From-Google row offers Import as gig / Mark day as busy / Ignore,
so personal Google events can count as busy without becoming gigs.

- [x] server.js migration: blocked_dates.source_event_id TEXT (links a block to
      the original Google event WITHOUT touching google_event_id, so unblocking
      can never delete the user's real Google event)
- [x] POST /api/blocked-dates accepts source_event_id; skips the Google
      "Unavailable" push for those rows (the original event already marks it)
- [x] GET /api/calendar/pins filters out events claimed by source_event_id
      (pin disappears once marked busy)
- [x] Client: openGooglePinSheet(pinId) with Import as gig (existing
      /api/calendar/import), Mark day as busy, Ignore + a See-all-imports link
- [x] List view pin rows route to the new sheet instead of openGigNudge()
- [x] Deploy, verify live on the harmless "Lock up shuts" event, then revert

## Review (2026-06-10, commit bf55575)

Live and verified end to end on Gareth's account with the recurring
"Lock up shuts" event: mark-busy 200 with source_event_id stored and
google_event_id null (no duplicate Unavailable pushed), the pin
disappeared from /api/calendar/pins and the nudges list while blocked,
unblock 200, and the original Google event reappeared as a pin
afterwards, proving Google was never touched. The nudges candidate
filter got the same source_event_id treatment so marked-busy events
stop nagging. Sheet verified rendering in the browser, console clean.

# Calendar polish wave (2026-06-10, all 6 ideas approved + 1 bug)

Approved in chat: "all sound perfect additions". All in public/js/app.js list view.

- [x] BUG: Day-options sheet recognises blocked days only by first date; use
      expanded_dates / start_date so mid-run days show Blocked + Manage block
- [x] Tap month name -> month/year jump sheet (year stepper + 12-month grid)
- [x] Sideways swipe on the grid changes month (day-panel swipe stays per-day)
- [x] Dim past days in the grid (number + bars), Apple style
- [x] Subtle weekend tint on SA/SU cells
- [x] Small + on the day header: add gig prefilled to selected date
      (reuses window._prefillGigDate + openGigWizard, same as Day options)
- [x] Long-press a grid day opens Day options directly (with click suppression
      + no text selection on the grid)
- [x] node --check, one commit, deploy, grep new symbols, browser verify, console clean

## Review (2026-06-10, commit 463f14c)

All seven shipped in one wave and verified live in the browser: jump sheet
opens from the month name (year stepper, current month highlighted, Jump to
today), Dec 2027 jump rendered with the money strip and blocked count
correct, the Day-options sheet on the blocked 15 Dec 2027 now shows
Blocked + Manage block (the bug fix), past days dim, weekends tint, the
day-header + opened the New Gig wizard, and grid gesture handlers
(month swipe + long-press) are attached. Console clean. Touch gestures
need a real phone for feel; Gareth to try swipe + long-press on iPhone.

# Landing page refresh + premium purchase check (2026-06-10)

## Phase 1 — Purchase flow

- [x] Fix Stripe checkout: omit trial_period_days when 0 (Stripe rejects 0, so anyone who
      already used a trial can never check out — found live with Gareth's account)
- [x] Verify live: fresh checkout URL returned for a returning-trial user; logged-out 401
      bounce to /app?intent=premium still works; intent handler kicks off checkout post-login

## Phase 2 — Content refresh (public/landing.html, keep the visual identity)

- [x] Phone mock: update dock + cards to today's Home (5-tab nav, hero card, Needs You)
- [x] New feature sections for everything built since April:
      dep network (offers, two-step confirm, cascade premium), urgent-gig marketplace
      (first-come vs pick, maps), Find Musicians directory, chat (gig/contact/setlist
      sharing, group threads, read receipts), EPK (gallery, video, audio, testimonials),
      public availability share + embed + next-gig widget, setlists/ChordPro/print,
      Google Calendar + Sheets two-way sync, push reminders, receipts photos +
      accountant zip, invoice line items + saved items + pay links
- [x] Refresh stale copy in existing "What if" rows; keep mileage/tax rows (still true)
- [x] Pricing truth-check: free list vs premium list vs actual app gates
- [x] FAQ pass for accuracy
- [x] DECISION (Gareth): invented stats (10k+ gigs, 500+ musicians) and fictional
      testimonials — keep, soften, or swap for honest capability stats?
- [x] DECISION (Gareth): landing lists "EPK page" as FREE but the app gates EPK behind
      premium (and the stated principle is premium covers EPK) — which is right?

## Phase 3 — Verify

- [x] Browser pass: sections, pricing toggle, checkout CTA both auth states, console clean
- [x] Deploy + grep + tick

## Review (2026-06-10)

Stripe checkout fixed (trial_period_days 0 rejection blocked every returning
trialist; verified live, a real checkout URL now returns). Landing refreshed:
four new feature sections (dep network with two-step confirm + marketplace,
network + chat with sharing, public pages + premium EPK, setlists + Google
sync), pricing truth-up (EPK premium per Gareth, lineup added, free list now
matches the real free core), honest capability stats, early-access-labelled
testimonials, FAQ corrected (unlimited free) and extended (deps, sync), dead
Log-in link fixed, phone mock matches the real 5-tab nav. All verified
rendering in the browser; 9 feature blocks total.


# Calendar List view (2026-06-10, mockup approved "I like them all")

- [x] List mode: compact month grid (4-colour bars: gig/dep/google/blocked) + day-grouped list
- [x] Month money strip (confirmed only) + blocked-day count
- [x] Rows: fee + time, leave-by subline, No-fee chip, dep Needs-answer rows with respond-by,
      Google rows with From-Google tag, blocked ranges collapsed
- [x] Grid tap -> scroll list; list scroll -> grid highlight; Today FAB
- [x] List replaces Month tab, becomes default, view remembered (localStorage)
- [x] Deploy + browser verify (incl. fix: scroll handler binds to .app-content, the
      app's real scroll container, not window)
- [x] Correction (Gareth): panel shows ONLY the highlighted day, true Apple flow.
      Chevrons + swipe move a day, blocked runs attached to every covered day.
- [x] Correction (Gareth): floating Today pill was fixed to the browser viewport,
      so it sat outside the app column on desktop and was unreliable on iPhone.
      Replaced with an inline amber Today chip beside the day name (only when a
      non-today day is selected). Verified live: chip jumps to today and hides.
