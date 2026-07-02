# Gigflow parity closure - COMPLETE 2026-07-01 (all five waves shipped + verified live)

Goal: close the last 5 gaps in tasks/gigflow-parity.md so TMG has EVERYTHING
Gigflow has, then we better it. Register verified against code 2026-07-01;
18 of 23 features already MATCH or BEAT (most closed on parity day 2026-06-28).

## Build order (estimates at my pace)

- [x] W1: iCal subscribe feed (~35 min)
      GET /api/calendar/feed/<token>.ics - per-user random token (users column,
      regenerate endpoint), VEVENTs from non-cancelled gigs (title, venue,
      times or all-day, address in LOCATION). Settings row under Calendar sync:
      "Subscribe on Apple Calendar / Outlook" + copy URL + regenerate.
      Free (Gigflow Pro-gates their one-way feed = we beat it).
- [x] W2: Set types (~30 min)
      set_types managed list (settings, seeded defaults: Solo, Duo, Full band,
      DJ set, Sax + DJ), set_type on gigs (form + detail + edit), filter chip
      on Gigs screen. Mirrors the existing gig_type pattern.
- [x] W3: Tiered agency commission (~25 min)
      Optional tiers JSONB on agencies (fee bands -> pct). Take-home calc uses
      the matching band, falls back to flat pct. Editor rows in the agency form.
- [x] W4: CSV import entry point (~15 min)
      Reuse the onboarding spreadsheet-upload flow; add "Import gigs (CSV)"
      next to the existing "Export gigs (CSV)" + a More-sheet row.
- [x] W5: availability poster (~40 min)
      Shareable open-dates graphic. Lowest value; marketing fluff.

Each wave: build -> syntax check -> ONE commit -> deploy -> live verify
(curl + browser) before the next. Roadmap doc updated at the end.

## Questions for sign-off
1. W5 poster: build or skip?
2. iCal feed: gigs only, or also personal-event busy blocks? (Proposal: gigs
   only v1; the feed is for the musician's own other calendars, which already
   have their personal events.)
