# Gigflow parity register (verified against code 2026-07-01)

THE GOAL (Gareth, 2026-07-01): TMG has everything Gigflow has, then betters it.
STATUS: FULL PARITY REACHED 2026-07-01. 23/23 features MATCH or BEAT.
Gigflow = the floor. Source feature map: 2026-06-11 logged-in sweep + 2026-06-26
live corrections (memory: reference_gigflow_competitor). Statuses below verified
against the current codebase, not the stale memory list.

## Verified register

| Gigflow feature | Gigflow tier | TMG status |
|---|---|---|
| Gig log (date, arrive-by, times, venue, fee, notes) | Free (capped ~10) | MATCH, unlimited free |
| Venue autocomplete + auto round-trip mileage + manual fallback | Free | MATCH |
| Money overview (month, in-bank / to-collect, YTD) | Free | MATCH (finance dashboard, free) |
| Build invoice + preview | Free | BEATS (line items, branding, numbering) |
| SEND invoice (server-side email) | PRO | BEATS, free, Resend + PDF, commit 87096c7 |
| Invoice tracker | PRO | BEATS, free |
| Income forecast | PRO | MATCH free (3-month confirmed-only) |
| Tax reports + CSV/PDF export | PRO | BEATS, free |
| Expenses + receipt capture | PRO | BEATS, free + AI scan |
| HMRC mileage calc | PRO | MATCH free |
| Income goals (per tax year) | PRO | MATCH free (single annual goal; per-year history is a nicety) |
| Agencies + commission (take-home, commission-as-expense) | Free entity | MATCH (built parity day 2026-06-28) |
| Partial payments per gig (gig_payments ledger) | Free | MATCH (append-only ledger + auto invoice-paid rollup) |
| Auto payment chasing, configurable cooldown | PRO | MATCH free (auto_chase_enabled + cooldown_days) |
| Hide financial figures mask | Free | MATCH |
| One-tap Google review requests | PRO | MATCH free (review chase, Wave E) |
| Shared calendar / availability link | Free | MATCH (public share + embed) |
| Calendar sync | PRO, iCal ONE-WAY only | BEATS: two-way Google + Sheets, PLUS a free iCal subscribe feed (gigs + busy) for Apple/Outlook (W1, 2026-07-01) |
| Gig types (managed list) | Free | MATCH |
| CSV gig import | PRO | BEATS, free: upload + column-map reachable from Finance and the More sheet (W4, 2026-07-01) |
| Set types (2nd categorisation axis) | Free | MATCH: set_type on gigs, wizard/full-form/edit + search (W2, 2026-07-01) |
| Tiered agency commission rules | PRO | MATCH free: fee-banded commission_tiers + band editor (W3, 2026-07-01) |
| Availability poster (shareable graphic) | PRO | MATCH free: canvas poster of open dates, share/download (W5, 2026-07-01) |

## Remaining gaps: NONE (all five closed 2026-07-01, see todo.md)

## Closed gaps (were the whole list)

1. **iCal subscribe feed** - Apple Calendar / Outlook users have NO sync at all
   (Google two-way doesn't help them). Token-authed `/api/calendar/feed/<token>.ics`
   serving gigs as VEVENTs. Free, which beats Gigflow's Pro-gated one-way feed.
2. **Set types** - second categorisation axis alongside gig type (e.g. Solo Sax /
   Sax+DJ / Full band). Managed list + field on gig form/detail + filter.
3. **Tiered agency commission** - optional fee-banded rates per agency
   (e.g. 15% up to 500, 12% above) on top of the existing flat %.
4. **CSV import entry point** - reuse the existing onboarding upload flow, add an
   entry from the Gigs screen (+ More sheet) so established users can bulk-add.
5. **Availability poster** - shareable graphic of open dates. Lowest value,
   marketing fluff; propose LAST or skip.

## TMG's moat (Gigflow has none of these)
Setlists + stage mode, EPK, dep system + marketplace, band chat, two-way Google
Calendar + Sheets, documents wallet, weather, kit lists, gig pack, AI features,
personal events / one-calendar, fee splitter, follow-ups + testimonials.

## Pricing posture (unchanged decision)
Gigflow monetises financial intelligence (Pro 9.99/mo). TMG keeps ALL of that
free and monetises the performance/career layer. Every "BEATS, free" row above
is the marketing story.
