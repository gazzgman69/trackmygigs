# Mockup gap closure — plan (2026-06-09)

Goal: build everything the original mockups promised that production doesn't have yet.
Source: mockup-vs-production diff (gigflow-mockup-v3, tmg-marketplace-mockup-v2).

## Wave 1 — Setlists into gigs

- [x] Migration: re-assert `gigs.setlist_id UUID`, add `gigs.setlist_notes TEXT` (done locally, not yet committed)
- [x] API: `PATCH /api/gigs/:id/setlist` to assign/clear a setlist and save per-gig notes (explicit null clears)
- [x] API: `GET /api/print/setlist/:id` printable setlist (same auto-print HTML pattern as other print routes)
- [x] API: `POST /api/setlists/save-shared` to copy a chat-shared setlist (creates songs + setlist for the receiver, reads trusted snapshot from the message)
- [x] Chat server: `setlist` kind in buildAttachmentSnapshot (name, song count, duration, song titles capped)
- [x] UI: repertoire Setlists tab fix (correct song counts, tap opens detail) + new setlist detail screen (add/remove/reorder songs, edit, delete, PDF)
- [x] UI: gig detail setlist section (assign/change/remove, songs preview, per-gig notes, PDF button)
- [x] UI: chat attach sheet "Send a setlist" + picker + sender card + receiver card with "Save to my repertoire"

## Wave 2 — Group chat + lineup (gig detail)

- [x] Group chat: multi-select in the compose contact picker (backend already supports group threads)
- [x] Read receipts: show read count in group threads ("Read by 2 of 4"), keep double-tick for 1-to-1
- [x] Lineup (premium): `gigs.lineup JSONB` members with role + status (confirmed/pending/declined), add/edit/remove on gig detail, premium-gated per mockup

## Wave 3 — Money

- [x] Receipt photos: store on the receipts row (BYTEA, same pattern as documents), wire AI-scan and photo-snap flows to save the image
- [x] Receipts zip: `GET /api/expenses/export.zip?year=` with photos + CSV manifest (free, data export is always free)
- [x] Finance: taxable profit line — already existed in production (estimateTax + tax-year overview), no change needed
- [x] Invoice line items: `invoices.line_items JSONB` (description/qty/rate), form UI, preview + PDF + detail render; single-amount path stays the default

## Wave 4 — Surfaces

- [x] EPK: gallery (`epk_gallery JSONB`), testimonials (`epk_testimonials JSONB`), audio embed using existing `epk_audio_url`; edit UI + in-app render + public /epk/:slug
- [x] Marketplace: "New to TMG" purple chip on applicants with no completed gigs, applicant profile preview sheet, Message button per applicant (thread creation allowed between poster and applicant)
- [x] Public share: embed code snippet + free/busy vs detailed toggle on /share/:slug

## Wave 5 — Calendar + availability

- [x] Block dates: generic weekly recurrence (any weekday + date range + label), CSV bulk upload (uses existing /api/blocked-dates/bulk)
- [x] Calendar layers: no work needed. Travel layer already ships (computeAutoBlocksForGigs + layer toggle); pack-down halos were deliberately removed per Gareth (#138), so not rebuilt.

## Ship ritual per wave

- Syntax-check (`node --check`), one batched commit per feature, one push per wave
- Deploy via reload endpoint (+install=1 only when deps change), verify by grepping served bundle
- Browser-verify the headline flow of each wave before marking complete

## After all waves

- [x] Update Musician_App_Platform_Roadmap.docx with a dated heading
- [x] Refresh repo CLAUDE.md (stale since April)
- [x] Review section added here

## Review (2026-06-09)

All ten feature areas shipped across five deploy waves (commits a9ae69e, 2fe7782, 175a110, 661ee1f, 485d0f7), each pushed, reloaded, and verified against production.

What was verified live:
- Setlists: create with duration/description (bug fixed), assign to gig with notes, print page with night-of notes, clear, delete
- Lineup: 403 premium gate on a free demo account, full CRUD as premium
- Group threads: 3-person thread created via compose API and cleaned up
- Receipts: photo stored and streamed back, zip contains photo + CSV + README
- Itemised invoice: server-computed £266.20 total, qty x rate rows in print + pdfkit
- EPK: gallery + testimonials saved and rendering on the public page (test data cleared after)
- Marketplace DM gate: 403 before an application, allowed after, restored
- Share: ?times=1, ?embed=1 (chrome-free), on-page toggle
- Recurring blocks: Mon+Wed pattern expanded correctly and stopped at the until date
- Chrome pass: gig detail sections render, availability buttons present, zero console errors on fresh load

Surprises captured:
- Production already had: FCFS/pick modes, multi-instrument posts, radius matching, completeness tracker, prep checklist, review links, document expiry alerts, taxable profit + tax estimate, applicant profile modal, worked-together pill
- Pack-down halos were tried and removed at Gareth's request (#138); left out on purpose
- The recurring-blocks API existed but ignored its end date; now honours ;until=

Still open (parked, in CLAUDE.md): marketplace-post contextual send, two unverified 28-Apr demo bugs (Profile 0/0/£0, FILLED-gig 500), demo profile photos, Apple Wallet signing.
