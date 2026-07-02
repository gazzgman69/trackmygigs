# MTD for Income Tax: recognised-software plan (started 2026-07-02)

THE PLAY: TMG becomes HMRC-recognised MTD software that files a musician's
quarterly updates from the gig/expense data it already holds, FREE. MTD ITSA
went mandatory April 2026 for sole traders earning over 50k; the over-30k band
joins April 2027, which is the heart of the full-time function-musician market.
Fewer than 3 in 10 mandated users had signed up by April 2026, and rivals
Pro-gate their tax layer. Being listed on HMRC's Software Choices as the
musician app that files for free is a moat competitors must rebuild months of
compliance work to copy.

Grounding (2026-07-02): HMRC end-to-end service guide + software-choices
guidance + developer newsletter edition 3. Quarterly deadlines: 7 Aug, 7 Nov,
7 Feb, 7 May. Recognition = passing HMRC's technical process (not an
endorsement); "MTD ready" trademark usable to 1 July 2027, requests processed
in 3-5 working days.

## Phase 0 - NOW (Gareth's actions, nothing blocks on code)

- [ ] Create an HMRC Developer Hub account (developer.service.hmrc.gov.uk).
      Decide the vendor identity carefully: the name shown on Software Choices
      should be the POST-RENAME brand (Musician One), so if the rename is
      happening, settle it before the production application (sandbox work can
      start under any name).
- [ ] Skim the end-to-end service guide and the Terms of Use so the
      commitments (support expectations for free software, fraud-prevention
      obligations) are known before we build.
- [ ] Confirm TMG's own legal footing for the listing (sole trader vs company
      name, support contact email on the custom domain).

## Phase 1 - buildable against the SANDBOX now (no custom domain needed)

1. Developer Hub sandbox application + credentials; OAuth 2.0 user-restricted
   flow (the replit.dev URL is fine as a sandbox redirect URI).
2. Fraud-prevention header middleware (Gov-Client-* / Gov-Vendor-*), validated
   with HMRC's Test Fraud Prevention Headers API. Mandatory for production.
3. Data mapping layer: TMG gigs -> self-employment income; expenses ->
   MTD expense categories (TMG categories map cleanly); HMRC mileage
   allowance already computed. Quarterly slicing on the 6 Apr / 6 Jul /
   6 Oct / 6 Jan boundaries, cumulative totals per the current spec.
4. Core API integrations (minimum functionality standard):
   - Business Details (retrieve the user's business + obligations)
   - Self-Employment quarterly update submission
   - Tax calculation (trigger + retrieve)
   - Accounting adjustments + final declaration (view, then submit)
5. In-app surface: a Tax > MTD panel showing obligations, quarter status
   (open / due / submitted), a review screen per quarter (income, expenses by
   category, mileage), and a Submit button. Free tier, per the pricing posture.

## Phase 2 - gated on the custom domain / production

- Production credentials application: minimum functionality checklist, live
  fraud-header validation, Terms of Use acceptance, Production Approvals
  Checklist review by HMRC.
- Software Choices listing + optional "MTD ready" trademark request.
- Support surface: public help page for the MTD features (a listing
  expectation, especially for free software).

## Sequencing note

Phase 1 is real engineering (est. 3-5 focused sessions) and worth starting
once the booking funnel settles. Phase 2 cannot start until the production
domain exists, which is the same blocker as OAuth verification and
events.watch, three birds with the one custom-domain stone.
