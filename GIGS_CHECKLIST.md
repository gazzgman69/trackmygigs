# Gigs Section Checklist (from mockup audit)

Source of truth: gigflow-mockup-v3.html

## Gig List Screen
- [ ] Filtering tabs at top (Weekly / Monthly / Yearly)
- [ ] Date format on cards: "19 Apr" not "Sun, 20 Apr"
- [ ] Load-in time visible on card
- [ ] Mini badges on cards (Draft inv, Pack ready)
- [ ] Tapping a gig card opens detail view
- [ ] Imports to review section (AI-detected calendar events)
- [ ] "+ Add" button matches mockup styling

## Create Gig Wizard
- [ ] Progress indicator: thin 3px bars (not round dots)
- [ ] Step 1: band suggestion shows contact name in meta
- [ ] Step 1: auto-fill card (DONE)
- [ ] Step 1: source tag Manual entry badge (DONE)
- [ ] Step 2: Google Places search (DONE)
- [ ] Step 2: mileage/distance in green box (DONE)
- [ ] Step 2: Google Places footnote (DONE)
- [ ] Step 3: date and times (DONE)
- [ ] Step 4: full-width status chips (DONE)
- [ ] Step 5: 10 gig types with emojis (DONE)
- [ ] Header: Back / New Gig / Show full form (DONE)
- [ ] Footer: Back left + Next right (DONE)

## Full Form Mode
- [ ] Summary bar ("Gig so far" yellow box)
- [ ] Source badges (Manual entry / From calendar / From CRM)
- [ ] Gig type chip selector
- [ ] Status as chips not dropdown
- [ ] Lineup section (Premium - member avatars, open slots, send dep)

## Gig Detail View (NOT BUILT)
- [ ] Header with band name, venue, date/times, fee, status
- [ ] Mileage calculation (miles round trip + claimable amount)
- [ ] Completeness tracker (X of Y complete with progress)
- [ ] Gig Pack section (dress code, parking, load-in, contact, set times)
- [ ] Lineup display (confirmed, pending, open slots)
- [ ] Setlist section
- [ ] Prep checklist (toggleable items)
- [ ] Message band button
- [ ] Create invoice button
- [ ] Ask for review section

## API Routes
- [x] GET /api/gigs (list all)
- [x] POST /api/gigs (create)
- [ ] GET /api/gigs/:id (single gig)
- [ ] PATCH /api/gigs/:id (update)
- [ ] DELETE /api/gigs/:id (delete)
