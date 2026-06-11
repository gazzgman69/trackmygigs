# Stage-ready setlists (approved 2026-06-10 "Lets get started", mockup signed off)

Scope agreed in chat: editor upgrade + stage mode + the extras list
(transpose, per-song stage notes, announcement markers, jump-to-song,
overrun warning, pedal keys, count-in pulse, auto-scroll with remembered
speed), then follow mode as its own wave.

## Wave S1 - data + editor

- [x] setlists.stage_meta JSONB: { breaks: [idx], markers: [{after, text}],
      notes: {song_id: text}, speeds: {song_id}, transpose: {song_id} } -
      one column, no other schema churn
- [x] PATCH /api/setlists/:id accepts stage_meta
- [x] Editor: hold-drag reorder (pointer events), set breaks with per-set
      song count + running time, announcement marker rows, per-song stage
      note editing, Perform button

## Wave S2 - stage mode

- [x] Full-screen performance view: huge title, key chip, BPM, inline
      chords from ChordPro lyrics, next-up bar, swipe L/R + arrow/pedal
      keys + space for scroll toggle, tap-to-pause, font size controls
      (persisted), wake lock with visibility re-acquire, elapsed set clock
      with amber overrun, jump-to-song grid from the position indicator,
      count-in BPM pulse, auto-scroll (default speed from song duration vs
      lyric height, remembered per song), transpose stepper on the key chip
      (chord maths with sensible enharmonics, remembered per song)

## Waves S1+S2 review (2026-06-10, commits e15de95..b6d485a)

Verified live on a real 9-song setlist built from Gareth's repertoire
(Function Bangers Vol 2, now in his account): editor renders Set 1/Set 2
with per-set running times and a merge link, durations normalised
against mixed seconds/minutes legacy data (m:ss everywhere), Perform
opens the black stage view with Valerie's chart, VERSE/CHORUS sections,
amber inline chords, count-in dot at 108bpm, awake indicator, elapsed
clock, auto-scroll pill and next-up bar. Transpose +2 produced exactly
C/Dm/F/E7/Am/G from Bb/Cm/Eb/D7/Gm/F with a reset control. Jump grid
lists both sets with the current song highlighted. Console clean.
Touch-only paths (drag feel, swipe, pinch) need Gareth's phone.

## Wave S3 - follow mode

- [ ] stage_sessions (code, setlist_id, leader, position, updated_at);
      leader PATCHes position on swipe; followers poll GET /api/stage/:code
      which returns the rendered song payload (no setlist copy needed);
      share-the-code card into band chat; follower view = stage mode minus
      controls, "Following <leader>" banner

# PRODUCTION READINESS (approved 2026-06-10, "Lets start")

Timeline revised by Gareth: ~2 months to full launch (around mid-August),
waitlist-first. The landing page + email collection goes live FIRST to
build attention; the app follows. External blockers (Google verification,
Resend DNS) still start immediately. Launch shape: waitlist trickle.
Open decisions: AI features hand-test vs hide; support email address.

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

- [x] Prod env checklist doc: DISABLE_DEV_LOGIN=true, fresh RELOAD_SECRET
      (current value is written in repo docs), APP_URL, RESEND_API_KEY,
      VAPID keys, Google creds + prod redirect URI, PG_POOL_MAX, Stripe live
      keys + webhook secret. Gareth applies in Replit Secrets for the
      production deployment.
- [x] Security headers middleware: HSTS, X-Content-Type-Options, Referrer-
      Policy, X-Frame-Options DENY except the ?embed=1 share route.
- [x] Rate limiting extended: light in-memory limits on auth/google, public
      token pages (/t, /docs, /share, /epk), and a general API ceiling.
- [x] Fresh multi-tenancy pass over every route added this session (venues,
      polls, splits, documents share, testimonials, radar, followup).
- [x] Account deletion endpoint + Settings button (GDPR right to erasure;
      currently missing). Export already exists.

## Wave 1 review (2026-06-10, commits 2d7db8f..4af3e75)

Headers verified live (HSTS/nosniff/referrer/frame-deny, embed route
exempt), public-token rate limit trips at 60/min (59 served, 6 throttled
in a 65-hit test), /health does a real DB round-trip, every route from
this session re-verified scoped to req.user.id, and account deletion
passed the full lifecycle: typed-DELETE gate, transactional purge, fresh
same-email login sees zero data. Five schema mismatches found and fixed
along the way (contacts.owner_id, user_reports.target_id,
discovery_lookups.actor_id, marketplace_applications.marketplace_gig_id,
prod-only expenses table -> drift guard). PRODUCTION.md runbook written.

## Wave 2 - prod data + pipeline (days 3-5)

- [ ] Prod DB: deploy runs startup migrations; wipe stale test data from
      prod; confirm Neon backup/PITR story.
- [ ] Document the release process: push main -> Gareth clicks Republish
      (admin/reload only refreshes the dev workspace).
- [x] /health endpoint (built in Wave 1) + free uptime monitor + error visibility.

## Accessibility (shipped 2026-06-10, Gareth: "I want it in now")

Whole-app text scaling SHIPPED, superseding the brief retirement: the
system text-size preference zooms the entire UI uniformly (commit
04a2ccd), clamped 0.85-1.35, rem anchored at 16px so nothing
double-scales. Preview override ?textscale=N persists until
?textscale=reset. Verified at 1.3x and reset on a 390px viewport.

## Wave 3 - legal + onboarding (days 5-9)

- [ ] Privacy policy + Terms pages (UK/GDPR basics, only-essential-cookies
      statement), linked from landing + app. Support email on both.
- [ ] First-run experience: fresh-account walk of every screen, fix empty
      states that assume data.
- [x] AI features: full battery tested 2026-06-10 on Gareth's request (all
      nine endpoints, multiple scenarios each, Haiku so pennies total).
      PASS: extract-gig (formal email, WhatsApp shorthand, junk input
      correctly refused with confidence 0), extract-receipt (fuel ->
      Travel, music shop -> Equipment, HMRC categories right), setlist
      (real song ids only, sane ordering reasons, no invented songs even
      when asked for 4 hours from a 15-song book), invoice chase (polite +
      firm variants, correct amounts/days overdue), thank-you draft,
      sanity-check (flagged the real 20 June clash, clean on free days),
      bio, transcribe gating (402 free, 503 premium-without-key).
      FIXED during testing: bio trusted stale profile instruments over the
      musician's typed facts (called a sax player a guitarist) and printed
      the home postcode into a public bio; both prompt-fixed and retested
      clean. Gareth's profile instruments corrected to saxophone/keys.
      RESOLVED: normalize-chordpro upgraded to Sonnet (commit e228038);
      retest kept all 8 chord tokens with musical mid-line placement. Every
      other endpoint stays on Haiku.

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

## Onboarding wizard wave (2026-06-11, signed off in chat)
- [x] Dual Google tokens: sheets_* columns on users; /auth/google/callback writes sheets_* when state=sheets; lib/google-auth.js purpose param ('sheets' prefers sheets token, falls back to shared); sheets status reflects either token
- [x] Wizard step 4 becomes a form: bank details + payment link, stamped on every invoice, PATCHed to profile (both optional)
- [x] finishOnboarding lands on Profile and pulses the Google Calendar row, Google Sheets row, and Edit button so people learn where settings live
- [x] Picker copy: connections live in Profile afterwards
- [ ] Gareth manual test: connect a Sheet with a second Google account and confirm the calendar connection survives (needs real OAuth, can't be automated)
