# TMG as your one calendar: Google-parity events + two-way sync (design chat 2026-06-30, mockups + API map done, AWAITING SIGN-OFF)

Goal: TMG becomes the calendar a musician runs their diary from. Two event types,
GIG (rich) and PERSONAL (baseline like Google), both two-way synced to Google. Add
anything in two taps, see everything properly, and Google stays the reminder engine
underneath. Full build spec (schema, sync algorithm, parity table, risks):
tasks/calendar-parity-spec.md.

## Locked
- TMG = the one calendar. Gig (rich) + Personal (Google-baseline) event types,
  both two-way synced. [Gareth 2026-06-30]
- Google is the notification engine: TMG writes reminders onto the synced event;
  Google fires them cross-device. We do NOT build PWA push. [Gareth + API map 2026-06-30]
- Add must be super easy for both: gig keeps the enriched flow; anything else is a
  two-tap quick-add. [Gareth 2026-06-30]
- All-day events surface in-app (time off, birthdays = heads-ups). Bank holidays are
  SIGNAL: flag + hint to raise the fee. [Gareth 2026-06-30]
- Public link (parked): TWO states, AVAILABLE / UNAVAILABLE, reason never shown.
  [Gareth 2026-06-30]

## First cut (v1 core) - the foundation that makes TMG the one calendar
### C1 - personal_events schema + two-way sync  [DONE + adversarially reviewed, verified live 2026-06-30]
- [x] personal_events table + indexes. Startup migration.
- [x] pullFromGoogle upserts non-gig events (atomic ON CONFLICT, own-echo skip,
      cancelled -> soft-delete, 410 -> wipe google rows + re-baseline). Excludes
      gig-owned (id OR legacy gcal: tag) and blocked-date events.
- [x] pushPersonalEventToGoogle / removePersonalEventFromGoogle; CRUD endpoints;
      gig-promotion drops the personal mirror.
- [x] Verified live on Gareth's account: 978 events pulled (Google->TMG); create
      pushed to Google with correct tz; delete propagated both ways. His data was
      clean (gigs all have google_event_id, no legacy duplicates).
- Deferred from the C1 review (low / can't-trigger-yet, handle later):
  * C3 must send offset-qualified ISO datetimes (naive strings would parse in the
    server tz). Handle in C3.
  * GET range filter + DST-ambiguous wall-clock hardcode Europe/London (fine for a
    UK user). calendar_id column not yet stamped (latent).
  * Recurring expansion via singleEvents=true is heavy (978 rows, ~83 future
    "Lock up shuts at 12pm"). Cap the horizon or store masters in C5.
  * A deleted-gig whose Google event survives re-appears as a personal event
    (correct: it is still in the calendar). One [TEST] orphan from old sync testing
    is in Gareth's Google Calendar this way.
### C2 - proper in-app calendar  [DONE, verified live in browser 2026-06-30]
- [x] Calendar sources personal events from the synced store (personalEventsToPins),
      not live /pins; multi-day all-day events expand per day. "Other events" layer
      ON by default. Tapping a personal event opens a clean detail sheet (title,
      time, location, notes) with Delete that propagates to Google. List-view and
      day-detail paths both route personal events to the detail; gig-candidates keep
      the import sheet. Verified: calendar shows the synced events; tap opens detail.
### C3 - add anything  [DONE, verified live 2026-06-30]
- [x] "Add event" on the day-action sheet (alongside Add gig / Block) + "Edit event"
      on the detail sheet open a New/Edit event form: title, all-day, date, start/end
      time, location, busy/free, reminder, notes. Save -> POST/PATCH -> pushes to
      Google -> calendar refreshes. Verified live: created a timed event (19:00 BST
      stored 18:00 UTC), it pushed to Google (google_event_id set), then deleted both
      ways. Recurrence (repeat preset) still deferred to C5; gig add unchanged.

## FIRST CUT COMPLETE (C1+C2+C3, 2026-06-30): TMG is the one calendar.
Personal events sync both ways with Google, render properly on the in-app calendar
(layer on by default, tappable detail), and can be added/edited/deleted in TMG with
changes pushed to Google. Next: C4 (gig-entry day context + fee nudge), C5
(recurrence + reminders), then the public link.

## Fast-follows (in order)
### C4 - gig-entry day context + premium-date fee nudge
- [ ] Inline "That day" panel in gig entry (reads stored events now): timeline + list
      of that day's commitments, new gig slots in live, real overlap -> one-tap "save
      anyway", non-overlap items as heads-ups, catches gig-vs-gig double-booking.
- [ ] Premium-date hint (bank holiday / NYE / already-busy) -> "consider a higher fee".
### C5 - recurrence + reminders
- [ ] Preset recurrence create/edit (Daily / Weekly on <day> / Monthly / Annually /
      Every weekday) as real RRULE; edit scope this / all / this-and-following.
      Recurring events FROM Google already display from C1 (singleEvents=true).
- [ ] Reminders pass-through (default useDefault=true; one custom override).

## Later / parked
- [ ] events.watch push channel (replace polling), custom recurrence editor, event
      colour, per-calendar selection UI, natural-language time parse.
- [ ] D1 Public link: does a personal EVENING event make you unavailable? (needs the
      stored events from C1 + a >= 17:00 boundary). Decide after the calendar lands.

Verify: events created in Google appear properly in TMG and vice versa; deletes
propagate both ways; an all-day event spans the right single day; a recurring Google
event shows its instances; adding a personal event in TMG two taps and it lands in
Google with reminders intact.

---

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
- [ ] Resend (transactional email) domain verification. Magic-link login IS the
      auth, so this must be bulletproof. Needs DNS records at the registrar.
      CODE SIDE DONE (2026-06-28): see docs/GO-LIVE-EMAIL.md for the exact
      registrar/Resend/Secrets/cron checklist. App is rename-safe (APP_NAME is
      decoupled from the sending domain via MAIL_DOMAIN/MAIL_FROM, proven), so
      the sending domain need NOT be the final brand name. Verify wiring with no
      send via GET /api/admin/email-config?key=<RELOAD_SECRET>. Remaining = Gareth
      executes: pick domain, Resend account + DNS, set Replit Secrets, daily cron
      on /api/admin/run-chases?key=<CHASE_CRON_SECRET> (use the dedicated key, not
      RELOAD_SECRET).
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

---

## MVP Tiering Spec (2026-06-11, IN PROGRESS — awaiting final sign-off, then build)

Free-core commitment (CLAUDE.md #6) is being RETIRED for this rendition. Gareth
will reword CLAUDE.md + landing copy once the tier map is locked. Until then,
the tier map below is the source of truth, not commitment #6.

### Mechanism
- ONE feature->tier config (visible-in-MVP? + free|paid). Single layer does BOTH
  the MVP "cut" (hide) and the free/paid split. No code deleted; reversible.
- Built on existing entitlement: users.subscription_tier + full Stripe (live;
  gates already on lineup, fee-splitter, Whisper). Cleanup needed: explicit
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier` migration;
  add premium_until expiry check to gates; centralise scattered isPremium checks.
- Nudges: gate at the feature, prompt at the moment of friction, never block the
  free core. Tasteful "Part of Premium" locked states + occasional contextual prompts.

### FREE
- All gig tracking: list/pipeline, detail, wizard, quick-add, edit, cancel, delete, status, import
- Calendar (all views) + Google Calendar sync + Google Sheets sync + blocked dates/availability + CSV import
- Mileage (real Google Routes driving distance; venue cache to add — see below)
- All invoicing (create, line items, send, PDF/print, pay link, chase ACTION, fields, teaching bundler). FREE invoices carry TMG branding.
- Manual expenses (entry, snap-photo no-AI, categories, edit/delete) + accountant ZIP export
- Finance: earnings totals, monthly breakdown, tax-year overview, ALL CSV/PDF/MTD exports
- Chat (1-1 + group/band), attachments, availability polls
- Find Musicians REFRAMED: search existing users by name/email/phone + invite-link for those not on app (BUILD the invite link)
- Availability sharing (all variants), sat-nav, reminders/nudges, review prompts
- Profile basics, rate card, pay link, photo; safety (block/report/DM); accessibility (text size, theme)
- Voice notes: browser speech-to-text path
- Calendar import gig-detection KEYWORD scorer (deterministic) — stays free
- Clash/double-booking warning: extend to import paths (deterministic for imports, keep AI sanity-check for manual) — FREE
- Manual dep send: pick ONE connection and send

### PAID
- Custom invoice branding / remove TMG footer — NEEDS BUILDING (no toggle today)
- AI receipt scanner; EPK AI bio writer; Documents & Certs wallet (+ expiry reminders + sharing)
- Setlists/Repertoire WHOLE module (song library + setlist building + Stage Mode)
- EPK media: gallery, video, audio (free EPK = bio + hero photo + testimonials)
- Dep auto-cascade fallback (the relay)
- Lineup + fee splitter (already gated)
- Finance AI "Monthly Insight" narrative
- AI extract on calendar/email import (auto-fill fee/band from prose)
- All other AI generation: smart-paste, AI chordpro normaliser, AI setlist generator, AI invoice-chase & thank-you drafts, server Whisper

### CUT FOR MVP (hidden, not deleted)
- Open marketplace (browse/post/apply/pick/FCFS) entirely
- Open Find Musicians discovery (browse strangers nearby/by instrument) — replaced by search-known + invite
- Directory-only profile fields (discoverable toggle, directory bio, available-now pulse, min-fee/free-gig filters)
- Apple Wallet pass (external blocker: Apple Developer cert)

### Dep cascade spec (PAID)
- Setup from a gig: pick connections, drag to RANK fallback order, choose advance mode
- Offers ONE at a time (not a blast); private 1-1 dep thread + push to current holder; band leader notified SEPARATELY
- Auto-advance on decline OR timed-window lapse
- Quiet hours: hold overnight (~9pm-8am), resume 9am; "urgent, ignore quiet hours" override for same-day scrambles
- Confirm-mode toggle: DEFAULT OFF (first yes auto-locks, hands-off). ON = holds each yes for sender approval
- First yes wins -> cascade stops -> gig stamps into dep's diary -> sender + leader notified
- Live "Sent" status with nudge/skip/stop; recipient-side snooze stays FREE

### Setlist-in-chat edge
- Free user receiving a shared setlist: sees song TITLES + blurb "Upgrade to see the charts,
  save to your repertoire, perform in Stage Mode." Save-to-repertoire shows the upgrade nudge.

### Mileage details
- Stays FREE. Real driving distance via Google Routes API (paid Google API; ~1 lookup per gig, cached on gig row, persisted via PATCH).
- ADD venue cache: before calling Google, reuse an existing gig's stored distance for the same (home postcode -> venue). Repeat venue = 1 lookup ever.
- FIX finance bug: per-gig card claims round-trip (miles x2 x0.45) but finance dashboard total uses one-way (miles x0.45). Under-reports return journey. Reconcile to round-trip.

### Loose ends to close before building
1. Auto-guess column mapping on Sheet/CSV import (FREE, no-AI, pre-select dropdowns from header names)? — offered, not yet answered
2. Voice notes in MVP at all, or drop? Leaning keep as-is (free browser + paid Whisper)
3. Confirm the round-trip finance mileage fix is wanted

### Loose ends — RESOLVED (2026-06-11)
1. Auto-guess column mapping on Sheet/CSV import: YES, deterministic guess from header names pre-selects dropdowns, user can still manually change any. Free, no AI.
2. Voice notes: DROP from MVP entirely (free browser speech AND paid Whisper both hidden). Keep lean. Reversible later.
3. Finance mileage round-trip fix: YES. Reconcile finance dashboard total to round-trip (miles x2 x0.45) to match the per-gig card.

### Build phases (proposed)
- P1 SPINE: entitlement cleanup (explicit subscription_tier migration + premium_until expiry check) + lib/features.js single config + wire client nav/menus to HIDE cut features + server 404s cut routes. No new screens, reversible. Makes it an MVP.
- P2 GATE: paid gating + tasteful locked states on newly-paid features (Repertoire/setlists/Stage, EPK media, Documents, AI features, Monthly Insight, AI import extract). Drop voice notes.
- P3 RIDE-ALONGS (no new screens): mileage venue cache + finance round-trip fix; clash detection extended to import paths (deterministic); auto-guess column mapping with manual override.
- P4 NET-NEW (MOCKUP FIRST per CLAUDE.md #10): custom invoice branding toggle; Find Musicians invite-link flow; dep cascade quiet-hours + confirm-mode relay build-out.

### Baseline multi-tenant audit (2026-06-11, commit 347399e)
- 27 flags raised, adversarially verified. ZERO confirmed cross-tenant data leaks in core (expenses, chat reads, save-shared charts, AI endpoints all properly scoped; 15 false positives refuted).
- ONE real leak found + FIXED + deployed: GET /setlists/:id expanded song_ids with no owner filter while PATCH stores arbitrary ids -> could read another user's song rows (lyrics/charts) if you knew their song UUIDs. Scoped the read to user_id. Verified own setlists still expand.
- The 4 "confirmed" gate findings (marketplace post/browse, EPK publish) are MOOT under new tiering: marketplace is CUT (Phase 1 seals routes), EPK basic is now FREE. EPK media + AI writer get server gates in Phase 2.
- AI endpoints ungated by documented design (all-AI-free-until-flag-flip in routes/ai.js) -> Phase 2 flips them.
- TAKEAWAY: config layer must be the SERVER enforcement point (requirePremium driven by feature config), preventing all gate gaps in one place.
- TO RE-CHECK post-build: chat.js message-read queries scope by thread_id relying on a prior participant guard (chat.js:268-281, 857-870) - confirm guard fires before read. Full re-audit after gates land.

### Phase 1 progress (2026-06-11)
DONE + VERIFIED:
- SPINE: config/features.json (single source of truth) + lib/features.js (isVisible/isEntitled/isPremiumUser/requireFeature) + /js/features.js served to client (window.TMG_FEATURES + tmgFeatureVisible/tmgIsPremium/tmgEntitled helpers, loads before app.js). subscription_tier migration added (audit schema-drift fix). isPremiumUser honours premium_until expiry (audit fix). 3 existing gates (splits/lineup/transcribe) refactored onto helper. Verified: features.js served, premium passes lineup gate (200), free blocked (403).
- SERVER SEAL: one config-driven guard in routes/api.js 404s every /marketplace* route while marketplace.mvp=false. Verified GET /api/marketplace -> 404, /api/gigs -> 200.

NEXT (Phase 1 remainder):
- CLIENT HIDING (surgical, browser-verify): hide marketplace entry points (Find dep home card app.js:1227, Marketplace tab in Offers app.js:4666, marketplace panels in index.html) WHILE KEEPING the dep-offers screen + chat + contacts. Hide open Find Musicians tab (app.js:11894 switchNetTab('find')) + renderFindTab/renderDiscoverEmptyState guards. Hide voice-note button (app.js:10883) + directory-profile editor section (buildDirectoryProfileEditor call app.js:11258). Hide Apple Wallet button. All config-driven via tmgFeatureVisible(), NOT deleted.
- DECISION MADE: /discover server routes (6020/6442/6639) NOT sealed in Phase 1 — they also serve kept contextual lookups and the P4 reframed search+invite will reuse them. Seal/scope properly in P4.
- Discovery map saved: 53 surfaces in workflow output wuz67p6za.

### Phase 1 COMPLETE (2026-06-11) — verified live
- SPINE: config/features.json + lib/features.js + /js/features.js (window.TMG_FEATURES + helpers) + subscription_tier migration + premium_until expiry check + 3 gates refactored. Verified.
- SERVER SEAL: /marketplace* all 404 (config-driven). Verified.
- CLIENT CUTS (config-driven body classes + 2 template guards, nothing deleted): Find dep home card hidden, Marketplace tab in Offers hidden (Received/Sent dep tabs + Send dep stay), open Find Musicians tab hidden, directory-only profile fields + summary hidden, voice-note button hidden. Apple Wallet: no client button existed. Verified in browser at 390px: home grid 5 cards, Offers clean, Edit Profile goes Instruments->Home Postcode, no console errors, all screens navigate.
- COPY: removed 2 "check the marketplace" quiet-state strings.
- Reversible: flip any feature's mvp/tier in config/features.json.
- NOT DONE (deferred by design): /discover server routes not sealed (serve kept contextual lookups + P4 reframed search reuses them).

### NEXT: Phase 2 (gate newly-paid features with tasteful locked states)
- Repertoire/setlists/Stage, EPK media (gallery/video/audio), Documents, AI features (smart-paste, chordpro, setlist-gen, invoice-chase, thank-you, receipt-scan, monthly-insight, import-extract). Each: server requireFeature/isPremiumUser gate + client locked state via tmgEntitled(). Drop voice notes server path too (already client-hidden).

---

# Server-side invoice send via Resend (2026-06-26, AWAITING SIGN-OFF, then build)

## Why
Gigflow competitive deep-dive (browser + their JS bundle) found their "Send invoice" is a real server-side send: client-gen PDF -> Supabase Edge Function `send-invoice` -> emailed (Resend), and they PAYWALL it behind £9.99/mo Pro. TMG today does NOT send server-side: `confirmSendInvoice` (public/js/app.js:12824) PATCHes status->sent then hands off to navigator.share / a `mailto:` (no email leaves our server, user attaches the PDF manually). The MVP tier map already promises invoicing INCLUDING send as FREE (todo line ~416). This build makes that real and turns "send invoices free, no paywall on getting paid" into a headline Gigflow can't match. Decision (Gareth, 2026-06-26): "Gonna go with resend."

## What we already have (audit 2026-06-26, file:line)
- Server PDF renderer: lib/invoicePdf.js:38 `renderInvoicePdfBuffer(invoice, user, opts)` -> Promise<Buffer> (pdfkit); `buildInvoiceFilename(invoice)`. Already pulls sender identity (display_name, business_address/phone, vat, bank_details) + bill-to (recipient_address, band_name, due_date, amount, line_items, notes).
- Authed PDF route: GET /api/invoices/:id/pdf (routes/api.js:5813) resolves payUrl + streams the Buffer.
- Resend wrapper: routes/auth.js:56 `sendEmail({to,subject,html})` = raw fetch to https://api.resend.com/emails, key=RESEND_API_KEY, From=MAIL_FROM, Gmail-SMTP fallback when no key. NOT exported; no attachments/reply_to/from-name yet. (Resend API natively supports reply_to + attachments[{filename,content:base64}] + display-name from.)
- invoices columns: status (draft/sent/paid/cancelled/overdue), sent_at (auto-stamped on PATCH status->sent at api.js:5325), recipient_email, recipient_address, due_date, amount, line_items, payment_link_url_override, public_pay_slug, chase_count/last_chase_at/chased_at. NO recipient_name column.
- Sender identity on req.user (api.js authMiddleware sets req.user = full users row): From-name = display_name||name; Reply-To = email; bank_details + payment_link_url already rendered into the PDF.
- All invoice routes live in routes/api.js (no routes/invoices.js); router.use(authMiddleware) authes the whole file.

## Build steps
1. lib/email.js: lift sendEmail out of auth.js into a shared, EXPORTED module. Extend to `{to, subject, html, text?, fromName?, replyTo?, attachments?}`; forward `reply_to` + `attachments` + a display-name `from` to the Resend API; keep Gmail fallback. Point auth.js at it (magic-links unchanged). Fix MAIL_FROM vs .env.example EMAIL_FROM mismatch (standardise on MAIL_FROM).
2. POST /api/invoices/:id/send in routes/api.js right after the /pdf route (~5853). Reuse the /pdf handler's user+invoice query + `renderInvoicePdfBuffer(inv, me, {payUrl})` to get the Buffer in-process (no HTTP round-trip), base64 it for the attachment. Recipient email from body.recipient_email || invoice.recipient_email (400 if none); name from body.recipient_name || invoice.band_name || gig.client_name. Build From-name = me.display_name||me.name over MAIL_FROM, Reply-To = me.email, subject default `Invoice {invoice_number}` (body.subject overridable), branded HTML body + PDF attached. On success: UPDATE status='sent' (auto-stamps sent_at) + persist recipient_email(+name); return {success, sent_at}. On Resend failure: 502, do NOT mark sent. Scope every query by user_id (multi-tenant, mirror /pdf).
3. Migration (server.js): `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recipient_name VARCHAR(255)` for a clean greeting + record (fallback to band_name/client_name when null).
4. lib/invoiceEmail.js: branded HTML body -> "Hi {name}, please find below my invoice for {band/gig}." + amount + due date + a "Pay online" button when a pay link exists + PDF-attached note + signed with the musician's name. FREE invoices keep the TMG footer (custom-branding removal stays the PAID toggle, todo line ~429).
5. Rewrite confirmSendInvoice (app.js:12824): primary action POSTs /send (recipient email, optional name + message/subject), optimistic "Sending..." -> "Invoice sent to {email}", refresh list (sent_at). KEEP a secondary "Download PDF / send from my own email" using the existing share/mailto path as a fallback. Error toast on 502 (and leave status unchanged).

## Reply-To / From (personal-touch handling we agreed)
- From: `{musician name} <invoices@trackmygigs.app>` (recognisable name, deliverable domain).
- Reply-To: musician's own email, so client replies land in their inbox not ours.

## Depends on (external)
- RESEND_API_KEY set (already in prod checklist, todo line ~75) + Resend domain verification for trackmygigs.app (external blocker, todo line ~65). On the dev workspace, test via the Gmail fallback or a Resend test key. MAIL_FROM set.

## Verify plan
- node --check, one commit, push + reload, grep bundle for the new symbol.
- Test send to Gareth's own email from the dev account: email received, PDF attaches + opens, From shows musician name, Reply-To = musician email, invoice flips to sent + sent_at stamped, recipient persisted.
- Multi-tenant: user B cannot /send or read user A's invoice (404, scoped by user_id).
- Failure paths: empty recipient -> 400 no status change; forced Resend error -> 502, invoice NOT marked sent.

## Open questions for Gareth (answer before build)
1. From address: `invoices@trackmygigs.app` (recommend), `no-reply@...`, or existing MAIL_FROM?
2. Keep the "download PDF / send from my own email" fallback alongside server send (recommend), or server-send only?
3. Add the recipient_name column (recommend, tiny) or just fall back to band_name/client_name?

Mockup: updated send sheet + "sent" confirmation rendered in chat for sign-off.

## SIGNED OFF (2026-06-26) — build approved
1. From = `{musician display_name} <invoices@{MAIL_FROM domain}>`. The musician's NAME is the From display name (Gareth: "need their name for sure"), so the client sees a person, not the app.
2. KEEP the "download PDF / send from my own email" fallback alongside server send.
3. ADD `invoices.recipient_name` column (fallback to band_name/client_name when null).
4. NAME-NOT-COMMITTED CONSTRAINT (Gareth): "trackmygigs" is a PLACEHOLDER, do not hard-bake it. Route the app name through a single `APP_NAME` value (env APP_NAME || existing default) and the sending domain through `MAIL_FROM` env, so a rename is one config change, not a code sweep. Do NOT add new hardcoded "TrackMyGigs"/"trackmygigs.app" string literals. The email footer/branding reads APP_NAME. (Existing PDF branding left as-is for now; just don't add more.)
- Live branded send from the domain waits on BOTH Resend DNS verification AND the final name. Until then: build + test on dev via the Gmail fallback; the From-name (musician) and all wiring work regardless of the eventual domain.

## BUILT + VERIFIED LIVE 2026-06-26 (commit 87096c7)
Files: lib/email.js (new, shared sender + APP_NAME + invoiceFromAddress), lib/invoiceEmail.js (new, branded HTML body), routes/auth.js (uses lib/email, login call site unchanged), routes/api.js (POST /invoices/:id/send + requires), server.js (recipient_name migration), public/js/app.js (recipient-name field, new server-send confirmSendInvoice, old path kept as sendInvoiceFallback).
Local checks PASS: node --check on all 6 files; runtime smoke test (APP_NAME swap -> invoices@gigly.io proves nothing hard-baked; template renders greeting/amount/due/pay-button/brand-footer/sign-off; branded:false hides footer).
VERIFIED LIVE 2026-06-26: reload OK (HEAD 87096c7), /health 200, bundle has sendInvoiceFallback. End-to-end: dev-login -> created throwaway invoice -> POST /invoices/:id/send to gazzgwyn@me.com returned 200 {success:true}; invoice flipped status=sent with recipient_email + recipient_name persisted + sent_at stamped (recipient_name migration confirmed); test invoice deleted. The 200 means a transport accepted the email. STILL TO CONFIRM by Gareth: inbox receipt + From shows musician name + Reply-To = his email + PDF attached + brand footer (and whether it went via Resend or the Gmail fallback).
Secrets for the real send: RESEND_API_KEY, MAIL_FROM (e.g. `TrackMyGigs <no-reply@trackmygigs.app>`), optional APP_NAME / INVOICE_FROM. Without RESEND_API_KEY it uses the Gmail fallback (GMAIL_USER/GMAIL_APP_PASSWORD).
LIVE-TESTED INBOX (Gareth screenshots 2026-06-26): PDF attached + rendered (header, bank details, totals, "Generated with TrackMyGigs" footer); email body greeting/message/summary/"attached as PDF"/sign-off/"Sent with TrackMyGigs" footer; Reply-To present. Confirmed it went via the GMAIL FALLBACK (From showed the Gmail account identity "Club Kudo Tracker", overriding the intended musician name "Gareth" that the body sign-off shows). Setting RESEND_API_KEY + verified domain will make From = "{musician} <invoices@domain>" un-overridable. TODO later: one consistent profile display_name so email/PDF/sender all agree.

---

# Per-gig payment tracking (2026-06-26, MOCKUP DONE, awaiting sign-off)

## Why (Gigflow parity gap #2 of the remaining gaps)
Today a gig has only `fee` + `status` (no payment columns; confirmed via every ALTER TABLE gigs). "Paid" is inferred BINARY from a linked invoice (`_gpMoneyState` app.js:1726-1744); an UNINVOICED cash gig has no money state at all; no Record-payment, no "to collect", no partial deposit+balance. Gigflow puts all of this on the gig detail (useGigPayments + ChasePaymentSheet). This is core to "track my gigs and get paid".

## Data model
- NEW table `gig_payments` (id UUID, gig_id UUID, user_id UUID, amount DECIMAL(10,2), paid_at DATE, method VARCHAR(32) [bank_transfer|cash|card|other], kind VARCHAR(16) [deposit|balance|other], note TEXT, created_at). Append-only ledger of receipts.
- Roll-up per gig: `paid_so_far = SUM(amount)`, `outstanding = fee - paid_so_far`. Status: unpaid (0) / part paid (0<paid<fee) / paid (paid>=fee).
- Gig is the SINGLE SOURCE OF TRUTH for client money received. Linked invoice paid-state becomes a projection: when paid_so_far >= fee, flip linked invoice to paid (reuse PATCH /invoices/:id, api.js:5320); and `markInvoiceAsPaid` (app.js:14262) writes a balancing gig_payments row, so gig and invoice never disagree or double-count.

## Finance integration (CLAUDE.md rule #7 = confirmed money only)
- Today "earned"/tax-year = `SUM(gigs.fee) WHERE status='confirmed'` = BOOKED, not banked (api.js:3716/3443). Keep that meaning.
- ADD a separate RECEIVED vs TO-COLLECT axis sourced from gig_payments: "in the bank" = SUM(gig_payments.amount) over confirmed gigs; "to collect" = SUM(fee) - SUM(payments) over confirmed gigs. Scope every payment query to gigs.status='confirmed' (pencilled contributes nothing) per rule #7. Extend GET /earnings + /stats with received/outstanding fields.

## Endpoints (routes/api.js)
- POST /api/gigs/:id/payments  (add a payment; validate amount>0, scope user_id; optional invoice-paid sync)
- GET /api/gigs/:id/payments   (list for the gig)
- DELETE /api/gigs/:id/payments/:pid  (remove a mistaken entry; re-derive status)
- Extend /earnings + /stats with received/outstanding.

## UI (public/js/app.js)
- Payment section inside openGigDetail (~9957/10055): status pill (Unpaid/Part paid/Paid), big "£X to collect", progress bar, fee + received line, recorded-payments list, "Record payment" button, "Mark fully paid" quick action. (Mockup rendered in chat 2026-06-26.)
- Record-payment sheet: amount (prefill = outstanding), type Deposit/Balance/Other, date, method. Save -> POST.
- Rewrite `_gpMoneyState` (app.js:1726) to derive paid/part/outstanding from payments not invoice-only; update the `'money'` ("Awaiting money") filter (app.js:1979) to outstanding>0.

## Decisions (SIGNED OFF 2026-06-27, all recommended)
1. Invoice <-> gig sync: YES, kept in sync both ways. Gig = source of truth.
2. Finance: ADD a new "in the bank / to collect" view; keep "earned" = booked confirmed fees.
3. Cash gigs record payments directly, no invoice required: YES.

## BUILT + BACKEND-VERIFIED LIVE 2026-06-27 (commit 82027a0)
Server: server.js gig_payments table + index; routes/api.js GET /gigs enriched with paid_so_far, gigPaymentRollup + syncInvoicePaidFromGig helpers, GET/POST/DELETE /api/gigs/:id/payments, and reverse sync in PATCH /invoices/:id (marking invoice paid inserts a balancing gig_payment). Client: app.js _gpMoneyState + 'money' filter use paid_so_far; gig-detail Payment section + loader; Record-payment sheet (amount/type/date/method) + Save/Delete/Mark-fully-paid; list-badge cache refresh. node --check PASS on all 3 files.
NOTE: this build is the GIG-LEVEL feature only. Decision #2's finance "in the bank / to collect" panel (extend /earnings + /stats with received/outstanding from gig_payments over confirmed gigs + surface in the finance UI) is the NEXT wave, not in 82027a0.
VERIFIED LIVE 2026-06-27 (curl, dev account, all cleaned up): reload OK, /health 200, bundle has openRecordPaymentSheet, gig_payments migration ran. Test A rollup: fee 450 -> deposit 150 = part/300 owed -> balance 300 = paid/0 -> delete payment re-derives to part/150. Test B forward sync: paying gig in full flipped linked invoice draft->paid (+paid_at). Test C reverse sync: PATCH invoice paid wrote a balancing "Invoice marked paid" payment so the gig reads paid. UI VERIFIED IN BROWSER 2026-06-27 (drove Gareth's Chrome on the dev app): gig-list money badge shows "£300 to collect" on the part-paid gig (others say "invoice it"); gig-detail Payment section renders the part-paid state (£300 to collect + Part paid pill, purple progress bar, £150 received / Fee £450, Deposit £150 row); Record-payment sheet (amount prefilled to outstanding, Deposit/Balance/Other chips, date, method) recorded the £300 balance and the section flipped to "£450 paid in full / Paid" green with full bar + both ledger rows (purple Deposit, green Balance). Test gig deleted, account clean. FEATURE COMPLETE.

## Finance "in the bank / to collect" view — BUILT + VERIFIED 2026-06-27 (commit 7d33679)
Decision #2's other half. /earnings now returns in_the_bank (SUM gig_payments over confirmed tax-year gigs, same window as "earned") + to_collect (max(0, earned - in_the_bank)); earned = in the bank + to collect, confirmed-only per rule #7. Finance Dashboard gained a "Money in" section (In the bank / To collect cards). ALSO fixed a pre-existing bug: the panel read data.paid_total/unpaid_total/overdue_total which /earnings never returned (nested under invoice_summary), so the hero "Total invoiced", split bar and 3 tiles rendered £0 - now read invoice_summary.{paid,unpaid,overdue}. Live-tested: baseline 3490/0/3490 -> +£400 gig -> +£250 payment gave earned 3890 / bank 250 / collect 3640, consistency checks pass both ways. Browser-verified: Money in shows In the bank £250 / To collect £3,640; hero now shows real £1,063 invoiced / £269 paid / £794 overdue (were £0); cleaned up. Note: "Total invoiced" (invoice framing) and "Income"/"Money in" (gig framing) now both show, labelled distinctly - Gareth to decide later if he wants to consolidate to one framing.

## Venue reuse + mileage cache (Gigflow "saved venues" gap) — BUILT 2026-06-27 (commit 3fcf4e9), LIVE VERIFY PENDING (Repl asleep)
Closes the saved-venues gap + the MVP-spec venue cache (cuts Google Routes cost). Server: GET /api/venues/recent (DISTINCT ON LOWER(TRIM(venue_address)) from the user's non-cancelled gigs, prefers rows with mileage, recency-ordered, top 12); /api/distance now checks for a prior gig at the same venue (by address) with a stored mileage and returns it `cached:true` BEFORE calling Google (moved the cache check above the key guard so it works even without a key). Client: gig wizard venue field gains onfocus + a "Your venues" group atop #venueSuggestions (loadRecentVenues -> window._recentVenuesCache, _renderVenueSuggestions merges saved + Google rows); selectRecentVenue fills name+address and reuses stored mileage with NO Google call. node --check PASS both files. NOT done: edit-gig venue field still plain text (no picker) - editing preserves mileage via PATCH COALESCE so no regression; can add the picker there later.
VERIFIED LIVE 2026-06-27: GET /venues/recent returned his 6 venues with mileage; /distance for Tyneside Cinema returned cached:true miles=220 (no Google), unknown venue fell through to a real lookup. Browser: wizard step 2 shows "Your venues" (Tyneside 440 / Cardiff 304 / Brighton 274 mi round trip); tapping Cardiff Castle filled it + "✓ Saved venue · 304 miles round trip (reused, no lookup)". FEATURE COMPLETE.

## Polish wave — BUILT + VERIFIED LIVE 2026-06-27 (commit 710b983)
- Gig type on gig-list cards: subline now appends getGigType(g) (e.g. "20:00 · Cardiff Castle · DEMO"). Verified in browser.
- Manual mileage fallback: edit-gig form gains an editable "Mileage (one-way, optional)" field (pre-filled from gig.mileage_miles, verified showing 152.00); saveEditGig sends mileage_miles (PATCH COALESCE preserves on empty). Covers the "auto-distance failed, type it" case.
Both verified live.

## Agencies + commission — BUILT + VERIFIED 2026-06-27 (commit b24fd4a)
agencies table (name + commission_pct) + gigs.agency_id; CRUD /api/agencies; gig POST/PATCH thread agency_id; GET /gigs (list+single) LEFT JOIN agencies -> agency_name/commission_pct. UI: Agencies manager (More menu), edit-gig "Booked through" picker + inline add + live take-home preview, gig-detail take-home line. Backend verified: take-home £340 on £400@15%, clear works, all user-scoped. UI not yet browser-eyeballed.

## SAFETY SWEEP (2026-06-27) — multi-agent audit + live cross-tenant probe of the whole session (a4542ea..HEAD)
VERDICT: clean. ZERO critical/high. Multi-tenant CLEAN (static audit + live two-account probe: account B got 404 on every one of A's gig-payments/gig/invoice-send/agency endpoints, no data leaked, A's data uncorrupted). No regressions (auth/email refactor, searchVenues, finance fix, invoice sync all OK). No SQL param bugs ($32/$33, 26->27 placeholders correct). No injection/XSS (parameterized + escaped). Migrations idempotent; features correctly free-core.
FIXES APPLIED + VERIFIED (commit 707c249, all low-severity):
1. /earnings "in the bank" caps each gig's received at its fee (LEAST per gig) so an overpaid gig can't break earned==in_the_bank+to_collect. Verified: £200 gig + £250 paid -> in_the_bank +£200 (capped), identity holds.
2. refreshAgencyTakeHome rounds take-home one-step (matches gig detail) -> no 1p preview/detail drift.
3. gig POST/PATCH validate agency_id belongs to caller (coerce to null if not). Verified: fake UUID -> null, own agency -> set.
RESOLVED — fee-splitter (commit 613d282): now deducts agency commission off the top BEFORE the band split (shown as its own breakdown row). Gareth asked how Gigflow does it; Gigflow is solo (no band split) so no precedent, net-of-commission matches real-world (agency takes its cut first). Verified: take-home math; splitter pot = fee - commission - costs.

## "Complete gig" + auto-chase — BUILT + VERIFIED 2026-06-27/28 (commits d198ee5, bb9c02f)
MARK-AS-PLAYED (d198ee5): gigs.completed_at; _gpIsPast counts it so a marked-played gig flows into Played + get-paid surfaces even before its date; PATCH set/clear via provided-flag; gig-detail "Mark as played / undo" button. Verified: completed_at sets to a timestamp + clears to null, other fields intact.
AUTO-CHASE (bb9c02f, OPT-IN, off by default): users.auto_chase_enabled + auto_chase_cooldown_days; lib/chaseEmail.js (reminder template) + lib/autoChase.js (sweep: opted-in + sent + overdue + recipient + chase_count<3 + past cooldown -> emails reminder w/ PDF via the Resend pipeline, bumps chase_count/last_chase_at); server.js /api/admin/run-chases (RELOAD_SECRET-gated, ?dry=1) for external-cron + best-effort 6h interval; Notification Settings toggle + cooldown (GET/POST /auto-chase-settings). Verified on a DEMO account (no real-client risk): pre-enable dry=0 (gating), dry-run preview, live run sent 1 chase to gazzgwyn@me.com + chase_count->1, immediate re-run blocked by cooldown (0), cleaned up. NOTE: Replit free dyno sleeps so the 6h interval is best-effort; the reliable path is an external cron hitting /api/admin/run-chases (give Gareth the URL+key when going live). Real branded send still waits on Resend DNS (Gmail fallback on dev).
ALL of "do them all" now done: fee-splitter decision, agency UI verify, mark-as-played, auto-chase.

## Loose ends TIED OFF + VERIFIED 2026-06-28 (commit 6684d07)
1. Edit-form venue autocomplete: #editVenue gains the same saved-venues + Google Places picker as the wizard (searchVenuesEdit/selectRecentVenueEdit/selectVenueEdit, targeting the edit inputs; picking a saved venue reuses its mileage). Verified live in the browser: focusing the edit venue field shows "Your venues" (4 of his 6 saved venues, e.g. Tyneside Cinema), picker wired.
2. Splitter commission row: verified by rendering renderGigSplitsSection with a mock gig (fee 400, 15% agency, 2-member equal split) - commission row shows "-£60", net pot 340 splits to £170/£170 (not £200). No premium lineup needed for the check.
NOTHING outstanding from the whole Gigflow-parity + extras + safety-sweep arc. TMG matches/beats Gigflow on gig tracking + invoicing.

## Gigflow UX head-to-head response — BUILT + VERIFIED 2026-06-30
Full side-by-side walk of both apps (live). TMG matches/beats every Gigflow feature; the only true gaps were income goals + a dedicated forecast. Acted on the 5-point response:
WAVE 1 (UX polish, no new screens):
- Money tab added to the bottom nav (6 tabs now), opens the Finance dashboard. Verified.
- Remembered gig-entry mode (wizard vs full form) per device via localStorage; "Full form" now a visible pill; toggles preserve entered data. switchGigEntryMode. Verified.
- Deposit-at-creation on the FULL gig form ("Payment so far": Not paid / Deposit paid / Paid in full + amount); records into gig_payments on save (kind balance/deposit). setFullFormPayment. Verified.
- Hide-figures eye toggle on the Finance dashboard; masks every figure incl the chart to "£•••" via fmtGBP/fmtBar; device-local localStorage. toggleHideFigures. Verified.
WAVE 2 (new Finance sections, mockup-signed-off first):
- Income goal: users.income_goal + GET/POST /api/finance/goal; card shows confirmed income vs annual target, % there, to-go, monthly pace over tax-year months left; "Set a goal" empty state + Edit (prompt() v1, could be a styled sheet later). Tracks `earnings` (confirmed). Verified live (£3,490/£20k → 17%, £1,651/mo over 10mo).
- Income forecast: GET /api/finance/forecast?months=3 sums upcoming CONFIRMED gig fees by month (rule #7 enforced server-side; months=12 still returned only the 3 confirmed). Card: per-month + Projected total + "confirmed only". Verified live (£720/£380/£500 = £1,600).
Commits: bdabb40 (nav+entry-mode), 10c438d (deposit+hide-figures), f8fb32c (chart mask), 30481d8 (goals+forecast). Remaining tiny: hide-figures only masks the Finance dashboard (not gig-card fees app-wide, by design); goal editor is a prompt(); roadmap .docx not yet updated this session.
