# Go-live: branded email + auto-chase cron

What makes invoice-send and the auto-chaser send **branded from your own domain**
(not the Gmail beta fallback), and how to schedule the chaser reliably. Every
step here is yours to do (registrar, Resend, cron) — the app side is already
wired to consume it with no code change.

## The one idea that removes the name worry

The displayed brand name and the sending domain are **separate knobs**:

- `APP_NAME` — the name shown in email ("Sent with …", the magic-link sender).
- `MAIL_DOMAIN` / `MAIL_FROM` — the actual address mail is sent from.

So you can verify a domain you already own, send from it today, and **rename the
app later without touching any DNS**. The sending domain does not have to be the
final product name.

## Step 1 — Pick a sending domain you control

Any domain you own works (e.g. an existing one, or register a fresh one). It only
needs to be a domain you can add DNS records to. Subdomain is fine and tidy, e.g.
`mail.yourdomain.com`.

## Step 2 — Resend: add + verify the domain

1. Create/sign in to a Resend account (resend.com).
2. Add the domain from Step 1. Resend shows you the **exact DNS records** to add
   (it generates these per-account — I can't pre-fill them):
   - an **SPF** record (TXT, `v=spf1 include:...`)
   - **DKIM** records (CNAME or TXT, the keys are Resend-generated)
   - optionally a **DMARC** TXT record (`v=DMARC1; p=none; ...` to start)
3. Add those records at your registrar / DNS host. Wait for Resend to show the
   domain **Verified** (minutes to a couple of hours depending on DNS).
4. Create an **API key** in Resend (Sending access).

## Step 3 — Set Replit Secrets (production Repl)

In the prod Repl's Secrets (never in the repo):

| Secret | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | the key from Step 2.4 | switches sending to Resend |
| `MAIL_DOMAIN` | `yourdomain.com` | the verified domain; address becomes `no-reply@…` / `invoices@…` |
| `APP_NAME` | your brand name | optional; defaults to `TrackMyGigs` |
| `CHASE_CRON_SECRET` | a long random string | low-privilege key just for the cron (Step 6) |

Optional finer control:
- `MAIL_FROM` = `Your Brand <no-reply@yourdomain.com>` — sets name+address in one
  string (overrides `MAIL_DOMAIN` for the default From).
- `INVOICE_FROM_LOCAL` = `invoices` — the local part invoices/chases send from
  (so `invoices@yourdomain.com`). Or `INVOICE_FROM` for a full override.

Then **Republish** (or hit `/api/admin/reload?key=<RELOAD_SECRET>&force=1`).

## Step 4 — Verify the wiring WITHOUT sending

    GET https://<PROD_HOST>/api/admin/email-config?key=<RELOAD_SECRET>

Expect:
- `"provider": "resend"`
- `"branded_domain_ready": true`
- `default_from` / `invoice_from` showing `…@yourdomain.com`

This reports only booleans for secrets, never their values.

## Step 5 — One real send to yourself

Send an invoice to your own address from the app (the existing Send button), and
run a dry chase:

    GET https://<PROD_HOST>/api/admin/run-chases?key=<CHASE_CRON_SECRET>&dry=1

Confirm the invoice arrives from `invoices@yourdomain.com` and looks right.

## Step 6 — Schedule the auto-chaser (external cron)

The in-process 6-hour interval is best-effort (Replit sleeps). For reliability,
add an external cron (e.g. cron-job.org, free):

- **URL:** `https://<PROD_HOST>/api/admin/run-chases?key=<CHASE_CRON_SECRET>`
- **Method:** GET (POST also works)
- **Schedule:** once daily (the per-invoice cooldown + 3-chase cap make daily
  safe; it never double-chases inside the cooldown window).

Use `&dry=1` for the first run to confirm it reaches the endpoint, then drop it.

> Use `CHASE_CRON_SECRET`, **not** `RELOAD_SECRET`, in the cron URL — that keeps
> the powerful reload/redeploy key out of a third-party service's config.

## Recap of what's already done in the app

- `lib/email.js` prefers Resend when `RESEND_API_KEY` is set; one fallback domain
  knob (`MAIL_DOMAIN`); brand name decoupled from sending domain.
- Invoice send + auto-chase both go through this pipeline (PDF attached, From =
  musician name, Reply-To = musician email).
- `/api/admin/email-config` (readiness check) and `/api/admin/run-chases?dry=1`
  (safe preview) exist for verifying go-live.
- Auto-chase is **opt-in, off by default**, hard cap 3, server-enforced cooldown.
