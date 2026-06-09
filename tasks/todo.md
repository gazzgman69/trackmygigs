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

- [ ] Group chat: multi-select in the compose contact picker (backend already supports group threads)
- [ ] Read receipts: show read count in group threads ("Read by 2 of 4"), keep double-tick for 1-to-1
- [ ] Lineup (premium): `gigs.lineup JSONB` members with role + status (confirmed/pending/declined), add/edit/remove on gig detail, premium-gated per mockup

## Wave 3 — Money

- [ ] Receipt photos: store on the receipts row (BYTEA, same pattern as documents), wire AI-scan and photo-snap flows to save the image
- [ ] Receipts zip: `GET /api/expenses/export.zip?year=` with photos + CSV manifest (free, data export is always free)
- [ ] Finance: taxable profit line (income minus claimable expenses) with personal allowance note
- [ ] Invoice line items: `invoices.line_items JSONB` (description/qty/rate), form UI, preview + PDF + detail render; single-amount path stays the default

## Wave 4 — Surfaces

- [ ] EPK: gallery (`epk_gallery JSONB`), testimonials (`epk_testimonials JSONB`), audio embed using existing `epk_audio_url`; edit UI + in-app render + public /epk/:slug
- [ ] Marketplace: "New to TMG" purple chip on applicants with no completed gigs, applicant profile preview sheet, Message button per applicant (thread creation allowed between poster and applicant)
- [ ] Public share: embed code snippet + free/busy vs detailed toggle on /share/:slug

## Wave 5 — Calendar + availability

- [ ] Block dates: generic weekly recurrence (any weekday + date range + label), CSV bulk upload (uses existing /api/blocked-dates/bulk)
- [ ] Calendar layers: travel-time + pack-down buffer blocks around gigs in week/day views, toggleable

## Ship ritual per wave

- Syntax-check (`node --check`), one batched commit per feature, one push per wave
- Deploy via reload endpoint (+install=1 only when deps change), verify by grepping served bundle
- Browser-verify the headline flow of each wave before marking complete

## After all waves

- [ ] Update Musician_App_Platform_Roadmap.docx with a dated heading
- [ ] Refresh repo CLAUDE.md (stale since April)
- [ ] Review section added here

## Review

(to be completed)
