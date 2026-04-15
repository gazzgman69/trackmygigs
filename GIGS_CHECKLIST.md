# Gigs Section Checklist (from mockup audit)

Source of truth: gigflow-mockup-v3.html

## Gig List Screen
- [x] Filtering tabs at top (Weekly / Monthly / Yearly)
- [x] Date format on cards: "19 Apr" date box style (gdb/gdd/gdm)
- [x] Load-in time visible on card
- [x] Mini badges on cards (Draft inv, Pack ready)
- [x] Tapping a gig card opens detail view
- [ ] Imports to review section (AI-detected calendar events) - needs Google Calendar integration
- [x] "+ New" button matches mockup styling
- [x] Search bar for filtering gigs

## Create Gig Wizard
- [x] Progress indicator: thin 3px bars (not round dots)
- [x] Step 1: band suggestion shows contact name in meta
- [x] Step 1: auto-fill card
- [x] Step 1: source tag Manual entry badge
- [x] Step 2: Google Places search
- [x] Step 2: mileage/distance in green box
- [x] Step 2: Google Places footnote
- [x] Step 3: date and times
- [x] Step 4: full-width status chips
- [x] Step 5: 10 gig types with emojis
- [x] Header: Back / New Gig / Show full form
- [x] Footer: Back left + Next right

## Full Form Mode
- [x] Summary bar ("Gig so far" yellow box)
- [x] Source badges (Manual entry / From calendar / From CRM)
- [x] Gig type chip selector
- [x] Status as chips not dropdown
- [x] Lineup section (Premium - placeholder with send dep)

## Gig Detail View
- [x] Header with band name, venue, date/times, fee, status
- [x] Mileage calculation (miles round trip + claimable amount)
- [x] Completeness tracker (X of Y complete with progress)
- [x] Gig Pack section (dress code, load-in, set times, notes)
- [x] Lineup display (Premium placeholder)
- [x] Setlist section (placeholder)
- [x] Prep checklist (toggleable items)
- [ ] Message band button - needs chat system
- [x] Create invoice button
- [x] Ask for review section (Google/Facebook)
- [x] Delete gig button

## API Routes
- [x] GET /api/gigs (list all)
- [x] POST /api/gigs (create)
- [x] GET /api/gigs/:id (single gig)
- [x] PATCH /api/gigs/:id (update)
- [x] DELETE /api/gigs/:id (delete)
- [x] GET /api/places (venue search proxy)
- [x] GET /api/places/detail (venue details proxy)
- [x] GET /api/distance (mileage calculation proxy)
