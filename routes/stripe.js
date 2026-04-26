// Stripe subscription plumbing for premium.
//
// Three endpoints:
//   POST /api/stripe/create-checkout-session  -> returns { url } to redirect
//   POST /api/stripe/webhook                  -> Stripe signs + sends events
//   POST /api/stripe/billing-portal           -> returns { url } to the portal
//
// Config lives in env vars:
//   STRIPE_SECRET_KEY         - sk_test_... or sk_live_...
//   STRIPE_MONTHLY_PRICE_ID   - price_... for the £14.99/mo plan
//   STRIPE_ANNUAL_PRICE_ID    - price_... for the £129/yr plan
//   STRIPE_WEBHOOK_SECRET     - whsec_... from the webhook dashboard
//   APP_ORIGIN                - https://trackmygigs.app (success/cancel URL host)
//
// The checkout endpoint attaches the TMG user id as session metadata so the
// webhook can link the subscription back to the right user. A 14-day trial
// is always attached (subscription_data.trial_period_days = 14).
//
// The webhook listens for:
//   checkout.session.completed         -> write stripe_customer_id + sub_id,
//                                         flip premium = true, set premium_until
//   customer.subscription.updated      -> re-sync premium + premium_until state
//   customer.subscription.deleted      -> flip premium = false, clear sub id
//
// All webhook handlers are idempotent: repeated deliveries are safe because we
// only UPDATE based on stripe_subscription_id lookups.

const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Stripe SDK is optional at import time so the server still boots when the
// STRIPE_SECRET_KEY env var is missing (pre-Stripe-verification phase). The
// endpoints return a 503 with a friendly message when called without keys.
let stripe = null;
let stripeInitError = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    // eslint-disable-next-line global-require
    const Stripe = require('stripe');
    stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  }
} catch (err) {
  stripeInitError = err.message || String(err);
  console.error('[stripe] SDK init failed:', stripeInitError);
}

function stripeConfigured(res) {
  if (stripe) return true;
  res.status(503).json({
    error: 'Stripe is not configured yet',
    detail: stripeInitError || 'STRIPE_SECRET_KEY missing',
  });
  return false;
}

function priceIdForPlan(plan) {
  if (plan === 'annual') return process.env.STRIPE_ANNUAL_PRICE_ID || null;
  if (plan === 'monthly') return process.env.STRIPE_MONTHLY_PRICE_ID || null;
  // Unknown plan: explicit null so the caller surfaces a 400. The earlier
  // version of this helper fell back to monthly for any non-annual value,
  // which let bogus plan strings sail through. Caught by harness scenario N-4.
  return null;
}

function appOrigin(req) {
  // Prefer the explicit env var so success/cancel URLs are stable even
  // when the server sits behind a proxy with a different Host header.
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// ── POST /api/stripe/create-checkout-session ─────────────────────────────────
// Requires authentication: we need a user to attach the Stripe customer to.
// If the caller isn't signed in we return 401 so the landing page can bounce
// to /app?intent=premium and the app kicks off checkout after sign-in.
router.post('/create-checkout-session', authMiddleware, async (req, res) => {
  if (!stripeConfigured(res)) return;
  try {
    const { plan } = req.body || {};
    const priceId = priceIdForPlan(plan);
    if (!priceId) {
      return res.status(400).json({
        error: 'Invalid plan',
        detail: `Unknown plan '${plan}'. Expected 'monthly' or 'annual'.`,
      });
    }

    const userRow = await db.query(
      'SELECT id, email, stripe_customer_id, trial_consumed_at FROM users WHERE id = $1 LIMIT 1',
      [req.user.id]
    );
    const user = userRow.rows[0];
    if (!user) return res.status(401).json({ error: 'unknown_actor' });

    // Trial-abuse defence layer 1 (#292-followup): if this user has already
    // consumed a trial — either on this account or by being a returning
    // customer — skip the 14-day window. They subscribe immediately and pay
    // the £14.99 (or £129) on day 1. Catches the easy abuse vector of
    // "cancel, resubscribe, get another fortnight free" using the same email.
    const alreadyTrialled = !!user.trial_consumed_at;
    const trialDays = alreadyTrialled ? 0 : 14;

    const origin = appOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // Reuse customer across cycles if we've already stored one; otherwise
      // pass the email so Stripe creates one and we'll capture the id via
      // the webhook.
      customer: user.stripe_customer_id || undefined,
      customer_email: user.stripe_customer_id ? undefined : user.email,
      // Trial period is 14 days for first-time subscribers, 0 days for
      // anyone whose users.trial_consumed_at flag is already set.
      subscription_data: {
        trial_period_days: trialDays,
        metadata: { tmg_user_id: String(user.id) },
      },
      // Session-level metadata too so the checkout.session.completed handler
      // can find the user without needing to fetch the subscription.
      metadata: { tmg_user_id: String(user.id), plan: plan === 'annual' ? 'annual' : 'monthly' },
      allow_promotion_codes: true,
      success_url: `${origin}/app?premium=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app?premium=cancelled`,
    });

    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[stripe] create-checkout-session error:', err);
    return res.status(500).json({ error: 'Could not start checkout', detail: err.message });
  }
});

// ── POST /api/stripe/billing-portal ──────────────────────────────────────────
// Opens the Stripe-hosted billing portal so users can update card, cancel, or
// download invoices without us building a custom UI. Requires an existing
// stripe_customer_id on the user row (i.e. they've completed checkout at
// least once).
router.post('/billing-portal', authMiddleware, async (req, res) => {
  if (!stripeConfigured(res)) return;
  try {
    const userRow = await db.query(
      'SELECT id, stripe_customer_id FROM users WHERE id = $1 LIMIT 1',
      [req.user.id]
    );
    const user = userRow.rows[0];
    if (!user) return res.status(401).json({ error: 'unknown_actor' });
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'no_subscription', detail: 'Subscribe to premium first' });
    }
    const origin = appOrigin(req);
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${origin}/app`,
    });
    return res.json({ url: portal.url });
  } catch (err) {
    console.error('[stripe] billing-portal error:', err);
    return res.status(500).json({ error: 'Could not open portal', detail: err.message });
  }
});

// ── POST /api/stripe/webhook ─────────────────────────────────────────────────
// This route MUST be mounted with the raw-body parser, not express.json,
// because Stripe's signature verification runs over the raw payload bytes.
// See server.js for the mount order: raw parser specifically for /api/stripe/webhook.
//
// Signature check: Stripe provides a STRIPE_WEBHOOK_SECRET we compare against
// the Stripe-Signature header. In local/no-key environments we skip the
// verification (the endpoint is still a no-op unless Stripe can reach us).
async function webhookHandler(req, res) {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // No webhook secret set: parse the body without verification. Safe for
      // local dev; NEVER use in production. The 503 above catches the
      // "no Stripe at all" case; if STRIPE_SECRET_KEY is set but
      // STRIPE_WEBHOOK_SECRET is not, we log a warning and continue.
      console.warn('[stripe] webhook received without STRIPE_WEBHOOK_SECRET configured');
      event = JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error('[stripe] webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const tmgUserId = (session.metadata && session.metadata.tmg_user_id) || null;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        if (!tmgUserId) {
          console.warn('[stripe] checkout.session.completed without tmg_user_id metadata');
          break;
        }
        // Pull the full subscription so we can read current_period_end and the
        // cancel_at_period_end flag. The flag is almost always false on a fresh
        // checkout but we read it anyway for symmetry with the update handler.
        let periodEnd = null;
        let cancelAtPeriodEnd = false;
        let defaultPaymentMethodId = null;
        try {
          if (subscriptionId) {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            if (sub && sub.current_period_end) {
              periodEnd = new Date(sub.current_period_end * 1000);
            }
            cancelAtPeriodEnd = !!(sub && sub.cancel_at_period_end);
            defaultPaymentMethodId = sub && sub.default_payment_method;
          }
        } catch (subErr) {
          console.error('[stripe] subscription retrieve failed:', subErr.message);
        }

        // Trial-abuse defence layer 2: pull the card fingerprint and check it
        // against every other user's card_fingerprints. If the same physical
        // card has been used on a different account before, the new signup is
        // recycling cards across emails — end their trial immediately so the
        // £14.99 charge fires today instead of in 14 days.
        let cardFingerprint = null;
        if (defaultPaymentMethodId) {
          try {
            const pm = await stripe.paymentMethods.retrieve(defaultPaymentMethodId);
            if (pm && pm.card && pm.card.fingerprint) {
              cardFingerprint = pm.card.fingerprint;
            }
          } catch (pmErr) {
            console.error('[stripe] payment method retrieve failed:', pmErr.message);
          }
        }

        let trialKilled = false;
        if (cardFingerprint && subscriptionId) {
          const collision = await db.query(
            `SELECT id FROM users WHERE id <> $1 AND $2 = ANY(card_fingerprints) LIMIT 1`,
            [tmgUserId, cardFingerprint]
          );
          if (collision.rows.length > 0) {
            try {
              // trial_end='now' is Stripe's documented "end this trial right
              // now" sentinel. Stripe immediately attempts to charge the
              // saved payment method and transitions the subscription from
              // trialing -> active.
              await stripe.subscriptions.update(subscriptionId, { trial_end: 'now' });
              trialKilled = true;
              console.log('[stripe] trial-abuse: card fingerprint matched user',
                collision.rows[0].id, '— trial ended immediately for user', tmgUserId);
            } catch (killErr) {
              console.error('[stripe] failed to end abused trial:', killErr.message);
            }
          }
        }

        await db.query(
          `UPDATE users
             SET stripe_customer_id = COALESCE(stripe_customer_id, $1),
                 stripe_subscription_id = $2,
                 premium = TRUE,
                 premium_until = $3,
                 stripe_cancel_at_period_end = $4,
                 trial_consumed_at = COALESCE(trial_consumed_at, NOW()),
                 card_fingerprints = CASE
                   WHEN $6::text IS NOT NULL AND NOT ($6 = ANY(card_fingerprints))
                     THEN array_append(card_fingerprints, $6)
                   ELSE card_fingerprints
                 END
           WHERE id = $5`,
          [customerId, subscriptionId, periodEnd, cancelAtPeriodEnd, tmgUserId, cardFingerprint]
        );
        console.log('[stripe] premium ON for user', tmgUserId, 'until', periodEnd,
          'cancelAtPeriodEnd=', cancelAtPeriodEnd, 'trialKilled=', trialKilled,
          'fingerprint=', cardFingerprint ? cardFingerprint.slice(0, 8) + '...' : 'none');
        break;
      }
      // Capture card fingerprints whenever a payment method gets attached to
      // a customer, even outside the checkout flow (e.g. user adds a backup
      // card via the Billing Portal). Lets us widen the cross-user match
      // window beyond just the moment of subscription creation.
      case 'payment_method.attached': {
        const pm = event.data.object;
        const fingerprint = pm && pm.card && pm.card.fingerprint;
        const customerId = pm && pm.customer;
        if (fingerprint && customerId) {
          await db.query(
            `UPDATE users
               SET card_fingerprints = CASE
                 WHEN NOT ($1 = ANY(card_fingerprints))
                   THEN array_append(card_fingerprints, $1)
                 ELSE card_fingerprints
               END
             WHERE stripe_customer_id = $2`,
            [fingerprint, customerId]
          );
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        // status: active | trialing | past_due | canceled | unpaid | incomplete
        const active = sub.status === 'active' || sub.status === 'trialing';
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
        // cancel_at_period_end mirrors the Stripe flag verbatim. true = user
        // clicked Cancel in the Billing Portal but still has access until
        // periodEnd. false = subscription is healthy AND will renew (or has
        // been resubscribed after a cancel-at-period-end was reversed).
        const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

        // Fingerprint capture also runs here so that any subscription event
        // (e.g. cancel, plan change, payment-method swap) keeps the
        // card_fingerprints array fresh. Same code path as the checkout
        // handler, just without the cross-user trial-killing check (this
        // path is for already-subscribed users, not new signups).
        let cardFingerprint = null;
        if (sub.default_payment_method) {
          try {
            const pm = await stripe.paymentMethods.retrieve(sub.default_payment_method);
            if (pm && pm.card && pm.card.fingerprint) {
              cardFingerprint = pm.card.fingerprint;
            }
          } catch (pmErr) {
            console.error('[stripe] payment method retrieve failed:', pmErr.message);
          }
        }

        await db.query(
          `UPDATE users
             SET premium = $1,
                 premium_until = $2,
                 stripe_cancel_at_period_end = $3,
                 trial_consumed_at = COALESCE(trial_consumed_at, NOW()),
                 card_fingerprints = CASE
                   WHEN $5::text IS NOT NULL AND NOT ($5 = ANY(card_fingerprints))
                     THEN array_append(card_fingerprints, $5)
                   ELSE card_fingerprints
                 END
           WHERE stripe_subscription_id = $4`,
          [active, periodEnd, cancelAtPeriodEnd, sub.id, cardFingerprint]
        );
        console.log('[stripe] subscription', sub.id, 'status=', sub.status, 'active=', active, 'cancelAtPeriodEnd=', cancelAtPeriodEnd, 'fingerprint=', cardFingerprint ? cardFingerprint.slice(0, 8) + '...' : 'none');
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(
          `UPDATE users
             SET premium = FALSE,
                 stripe_subscription_id = NULL,
                 stripe_cancel_at_period_end = FALSE
           WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        console.log('[stripe] subscription', sub.id, 'deleted, premium OFF');
        break;
      }
      default:
        // Ignore other event types; Stripe sends many we don't care about.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook handler error:', err);
    res.status(500).json({ error: 'webhook handler error', detail: err.message });
  }
}
// The webhook route is NOT mounted on this router. Instead we export the
// handler and the raw parser so server.js can wire it in before express.json()
// consumes the request body. Mounting it here would be too late — by the
// time this router's middleware runs, the body has already been parsed to an
// object and the Stripe signature check (which runs over raw bytes) fails.

module.exports = router;
module.exports.webhookHandler = webhookHandler;
module.exports.rawJsonParser = express.raw({ type: 'application/json' });
