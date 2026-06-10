# TrackMyGigs production runbook

Target: trackmygigs.app, waitlist-first launch (~mid-August 2026).
This file is the single source of truth for going live. Gareth's actions
are marked [GARETH]; everything else is code-side and already done or
tracked in tasks/todo.md.

## 1. Production secrets (Replit deployment Secrets pane) [GARETH]

Set these on the PRODUCTION deployment (not the dev workspace). Never
reuse dev values where a fresh one is listed.

| Secret | Value | Notes |
|---|---|---|
| DISABLE_DEV_LOGIN | true | Kills /auth/dev-login and /auth/dev-set-premium dead (they 404). THE most important line on this page. |
| RELOAD_SECRET | fresh random string | Dev value is written in repo docs, so it is burned. Generate: 24+ random characters. |
| APP_URL | https://trackmygigs.app | Used in magic-link emails. |
| RESEND_API_KEY | from Resend dashboard | See section 3. |
| EMAIL_FROM | login@trackmygigs.app | Or similar, must be on the verified domain. |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | from Google Cloud | Same project as dev is fine; add the prod redirect URI (section 4). |
| STRIPE_SECRET_KEY | live key | Already live in dev; reuse. |
| STRIPE_WEBHOOK_SECRET | from the NEW prod webhook | Section 5. |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT | copy from dev | Push keys; keep the same pair so subscriptions survive. |
| ANTHROPIC_API_KEY | copy from dev | AI features. |
| PG_POOL_MAX | 20 | Neon handles more than the dev helium instance. |
| DATABASE_URL | Neon production string | Replit deployment config. |

## 2. Release process

1. All changes land on `main` via git push (never the Replit Agent).
2. Dev workspace picks them up via /api/admin/reload (dev verification).
3. [GARETH] Click Republish on the Replit deployment when a wave is
   verified on dev. That rebuilds production from main.
4. Startup migrations run automatically on boot; they are idempotent.
5. Verify production: open https://trackmygigs.app/health (expect
   {"ok":true}), then spot-check the changed feature.

## 3. Resend (transactional email) [GARETH]

Magic-link login is the only way into the app, so email delivery is
launch-critical. Gmail SMTP is the fallback, not the plan.

1. Create an account at resend.com (free tier: 3,000 emails/month).
2. Add domain trackmygigs.app; Resend shows 3-4 DNS records (SPF, DKIM,
   optionally DMARC). Add them at the domain registrar.
3. Wait for Verified status (minutes to a few hours).
4. Create an API key, set RESEND_API_KEY + EMAIL_FROM in prod secrets.
5. Test: request a magic link on prod with a personal email; check it
   lands in the inbox (not spam) within seconds.

## 4. Google OAuth verification [GARETH, START IMMEDIATELY]

Calendar + Sheets are sensitive scopes. Unverified = scary warning screen
for every user and a 100-user connection cap. Verification takes days to
weeks, so this is the long pole.

1. console.cloud.google.com -> the TMG project -> OAuth consent screen.
2. Add https://trackmygigs.app to authorised domains; add the prod
   redirect URI (https://trackmygigs.app/auth/google/callback) to the
   OAuth client credentials.
3. Fill the consent screen: app name TrackMyGigs, support email, logo,
   privacy policy URL + terms URL (Wave 3 pages, links will be
   https://trackmygigs.app/privacy and /terms).
4. Submit for verification. Google will ask WHY each scope: calendar =
   "two-way sync of the musician's own gig diary"; sheets = "export and
   sync of the musician's own gig list to their spreadsheet". They may
   request a demo video of the OAuth flow.
5. Until approved, sync works but shows the unverified warning; label
   the feature "early access" in-app if launch beats the approval.

## 5. Stripe production webhook [GARETH]

1. dashboard.stripe.com -> Developers -> Webhooks -> Add endpoint:
   https://trackmygigs.app/api/stripe/webhook
2. Events: checkout.session.completed, customer.subscription.updated,
   customer.subscription.deleted (match the dev endpoint's list).
3. Copy the signing secret into STRIPE_WEBHOOK_SECRET (prod secrets).
4. Checkout success/cancel URLs derive from APP_URL, no code change.

## 6. Hardening already in the code (Wave 1, 2026-06-10)

- Security headers on every response (HSTS on https, nosniff, referrer
  policy, X-Frame-Options DENY except the ?embed=1 share variant).
- In-memory rate limits: 600 req/min/IP general, 60/min on public token
  pages (/t, /docs, /share, /epk), 30/min on auth POSTs.
- /health endpoint with a real DB round-trip for uptime monitoring.
- Account deletion: Profile -> Sign Out area -> "Delete my account and
  all data" (typed DELETE confirmation, transactional purge across all
  user-owned tables, GDPR erasure).
- Multi-tenancy re-verified across every 2026-06-10 route.

## 7. Monitoring [GARETH, 5 minutes]

1. uptimerobot.com free account -> add monitor: HTTPS,
   https://trackmygigs.app/health, 5-minute interval, keyword "ok":true.
2. Alert contact: your email/phone.

## 8. Launch-day checklist (kept current as waves land)

- [ ] DISABLE_DEV_LOGIN=true confirmed on prod (open /auth/dev-login,
      expect 404)
- [ ] Fresh RELOAD_SECRET on prod
- [ ] /health green on uptime monitor
- [ ] Magic link lands in inbox from the real domain
- [ ] Google connect works on prod domain (warning screen acceptable
      pre-verification)
- [ ] Stripe checkout URL creates from prod (do not complete it)
- [ ] Push notification end-to-end on iPhone (PWA installed)
- [ ] Privacy + Terms live and linked
- [ ] Old test data wiped from prod DB
- [ ] Landing waitlist form delivers to Kit
