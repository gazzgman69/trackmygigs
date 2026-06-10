# PRODUCTION READINESS (target: 2026-06-24, plan pending Gareth sign-off)

Goal: trackmygigs.app live and safe for real users in 2 weeks.

## External blockers (start day 1, not under our control)

- [ ] Google OAuth verification: calendar+sheets are sensitive scopes. Until
      Google verifies the app, users see the scary "unverified app" screen
      and there is a 100-user cap. Verification takes days to weeks. Submit
      NOW. Mitigation if late: launch with sync labelled early access and
      the warning documented; the cap is fine at launch scale.
- [ ] Resend (transactional email) domain verification for trackmygigs.app.
      Magic-link login IS the auth, so this must be bulletproof. Needs DNS
      records at the registrar. Minutes of work + DNS propagation.
- [ ] Stripe live webhook endpoint registered for the prod domain; checkout
      success/cancel URLs point at prod.

## Wave 1 - security hardening (days 1-3, code)

- [ ] Prod env checklist doc: DISABLE_DEV_LOGIN=true, fresh RELOAD_SECRET
      (current value is written in repo docs), APP_URL, RESEND_API_KEY,
      VAPID keys, Google creds + prod redirect URI, PG_POOL_MAX, Stripe live
      keys + webhook secret. Gareth applies in Replit Secrets for the
      production deployment.
- [ ] Security headers middleware: HSTS, X-Content-Type-Options, Referrer-
      Policy, X-Frame-Options DENY except the ?embed=1 share route.
- [ ] Rate limiting extended: light in-memory limits on auth/google, public
      token pages (/t, /docs, /share, /epk), and a general API ceiling.
- [ ] Fresh multi-tenancy pass over every route added this session (venues,
      polls, splits, documents share, testimonials, radar, followup).
- [ ] Account deletion endpoint + Settings button (GDPR right to erasure;
      currently missing). Export already exists.

## Wave 2 - prod data + pipeline (days 3-5)

- [ ] Prod DB: deploy runs startup migrations; wipe stale test data from
      prod; confirm Neon backup/PITR story.
- [ ] Document the release process: push main -> Gareth clicks Republish
      (admin/reload only refreshes the dev workspace).
- [ ] /health endpoint + free uptime monitor + error visibility.

## Wave 3 - legal + onboarding (days 5-9)

- [ ] Privacy policy + Terms pages (UK/GDPR basics, only-essential-cookies
      statement), linked from landing + app. Support email on both.
- [ ] First-run experience: fresh-account walk of every screen, fix empty
      states that assume data.
- [ ] AI features: Gareth hand-tests this week OR we hide them for launch.

## Wave 4 - full regression on PROD (days 9-12)

- [ ] Sim campaign against production (Neon took 50 concurrent in May).
- [ ] Browser walk on prod domain; PWA install + push end-to-end on the
      actual iPhone; Google connect with prod redirect; Stripe checkout URL
      (never completed).

## Wave 5 - launch (days 12-14)

- [ ] DNS/SSL check, landing live, waitlist switch-over, install-the-app
      instructions page, final findings sweep, go/no-go.

## Gareth's side (can start today)

- [ ] Submit Google OAuth verification (I prep everything, you click)
- [ ] Resend account + DNS records at the registrar
- [ ] Replit Secrets for prod (I give you the exact list and values to set)
- [ ] Hand-test the AI features, or tell me to hide them
- [ ] Pick the support email address
- [ ] Republish clicks when each wave lands

# Musician-life wave 2 (2026-06-10, "lets add 4-10")

Mockups first for the four new screens, then build in waves.

## Mockup round (pending Gareth sign-off)

- [x] Documents wallet mockup: store PLI/PAT/insurance docs (BYTEA, like
      receipt photos), expiry dates with Home reminder chip, one-tap share
      link a venue can open without logging in
- [x] Band availability poll mockup: pick dates, share into a chat thread,
      participants tap yes/no per date, live tally; poll state lives
      server-side (not a snapshot) so votes update
- [x] Gig fee splitter mockup: fee minus costs, equal or custom split with
      optional leader cut, mark-paid per member; rides on lineup (premium)
- [x] Post-gig follow-up mockup: morning-after prompt on past gigs with a
      client contact; testimonial ask via public link; submissions land as
      pending and feed EPK testimonials after approval
- [x] Inline proposals (no new screens): weather on gig card + pack within
      48h (Open-Meteo via server proxy, venue lat/lng already stored); kit
      checklist templates on the existing prep checklist (save as template
      by gig type, one-tap apply); unpaid invoice chase = overdue list in
      the invoice panel + one-tap prefilled chase email and "chased" stamp
      (manual send, consistent with nothing-auto-sends)

## Build waves (after sign-off)

- [x] Wave A: documents wallet share links (wallet itself already existed:
      table, CRUD, expiry badges and 30/7-day reminders were live; added
      share_token, /docs/:token public page + file, Send/Revoke on cards.
      Verified: page+file public, revoke 404s, re-share mints fresh token)
- [x] Wave B: weather (Open-Meteo proxy, venue coords or postcode, gig
      window summary on detail + pack; live test returned Drizzle 16C 40%),
      kit templates (save/apply/delete on the prep checklist), invoice
      chase strip (overdue sent invoices, prefilled mailto, chased stamp)
- [x] Wave C: fee splitter (PATCH /gigs/:id/splits behind the lineup
      premium gate; equal/leader-cut/custom + paid ticks; demo2 403,
      Gareth's leader-cut maths verified rendering: 269-29-60 -> 120/60/60)
- [x] Wave D: availability poll (polls + poll_votes, live-hydrating chat
      card, Can/Can't pips, owner pencil-in when all can; cross-user votes
      verified, anon 401, off-poll date 400)
- [x] Wave E: follow-up (morning-after cards for client gigs, /t/:token
      public submit, pending approval to epk_testimonials, thank-you page
      pre-copies the quote and bounces to users.review_link, chase sheet
      with GBP deep links + honest verification wording). Full lifecycle
      verified live incl. suggestion disappearing after ask and approve
      appending to the EPK; all QA fiction cleaned from the real account.
      Fix during verify: public pages use the full act name (his account
      is "The Vents", first-word logic read as "How did The do?").

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
