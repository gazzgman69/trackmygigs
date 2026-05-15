// Web Push notifications for smart gig reminders.
//
// Setup (one-time, done by Gareth):
//   1. Generate VAPID keypair:  npx web-push generate-vapid-keys
//   2. Add to Replit Secrets:
//        VAPID_PUBLIC_KEY  — the public key (also returned to clients
//                            via GET /api/push/vapid-public so they can
//                            subscribe)
//        VAPID_PRIVATE_KEY — the private key (server-side only)
//        VAPID_SUBJECT     — a mailto: URL or https URL identifying you,
//                            e.g. "mailto:skinnycheck@gmail.com"
//   3. Optionally set up a daily cron job to hit
//        /api/push/cron-morning-reminders?key=<RELOAD_SECRET>
//      around 9am UK time. Without that, reminders only fire when the
//      user manually triggers "Send test notification."
//
// All endpoints below gracefully no-op when VAPID isn't configured —
// the feature simply stays inactive instead of crashing the server.

const express = require('express');
const webPush = require('web-push');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Try to configure web-push at boot. If VAPID isn't set, log once and
// leave _configured=false so every send falls through gracefully.
let _configured = false;
try {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:contact@trackmygigs.app';
  if (pub && priv) {
    webPush.setVapidDetails(subject, pub, priv);
    _configured = true;
    console.log('[push] VAPID configured; web-push enabled');
  } else {
    console.log('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set; web-push disabled');
  }
} catch (err) {
  console.error('[push] setVapidDetails failed:', err.message);
}

// GET /api/push/vapid-public — public key the browser uses when
// subscribing (PushManager.subscribe needs applicationServerKey). No
// auth needed; the public key is public by definition.
router.get('/vapid-public', (req, res) => {
  if (!_configured) {
    return res.status(503).json({ error: 'push_not_configured', message: 'Web Push is not configured on this server.' });
  }
  res.json({ ok: true, public_key: process.env.VAPID_PUBLIC_KEY });
});

// Everything below requires a session.
router.use(authMiddleware);

// POST /api/push/subscribe
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
// Saves the subscription onto users.push_subscriptions (deduped by endpoint).
router.post('/subscribe', async (req, res) => {
  try {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'invalid_subscription' });
    }
    // Append unless this endpoint already exists in the user's array.
    await db.query(
      `UPDATE users
          SET push_subscriptions = CASE
            WHEN push_subscriptions @> jsonb_build_array(jsonb_build_object('endpoint', $2::text))
              THEN push_subscriptions
            ELSE COALESCE(push_subscriptions, '[]'::jsonb) || $3::jsonb
          END,
          push_reminders_enabled = TRUE
        WHERE id = $1`,
      [req.user.id, sub.endpoint, JSON.stringify(sub)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err);
    res.status(500).json({ error: 'subscribe_failed', message: err.message });
  }
});

// POST /api/push/unsubscribe
// Body: { endpoint }  — removes one subscription. If body is empty,
// clears them all and disables the toggle.
router.post('/unsubscribe', async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (endpoint) {
      // Filter the JSONB array client-side to drop the matching endpoint.
      const r = await db.query('SELECT push_subscriptions FROM users WHERE id = $1', [req.user.id]);
      const arr = Array.isArray(r.rows[0]?.push_subscriptions) ? r.rows[0].push_subscriptions : [];
      const filtered = arr.filter((s) => s && s.endpoint !== endpoint);
      await db.query(
        `UPDATE users SET push_subscriptions = $2::jsonb,
                          push_reminders_enabled = ($3::int > 0)
            WHERE id = $1`,
        [req.user.id, JSON.stringify(filtered), filtered.length]
      );
    } else {
      await db.query(
        `UPDATE users SET push_subscriptions = '[]'::jsonb,
                          push_reminders_enabled = FALSE
            WHERE id = $1`,
        [req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/unsubscribe]', err);
    res.status(500).json({ error: 'unsubscribe_failed' });
  }
});

// POST /api/push/test — fires a single notification at every subscription
// the calling user has registered. Useful to verify the round-trip end
// to end after enabling notifications.
router.post('/test', async (req, res) => {
  if (!_configured) return res.status(503).json({ error: 'push_not_configured' });
  try {
    const r = await db.query('SELECT push_subscriptions FROM users WHERE id = $1', [req.user.id]);
    const arr = Array.isArray(r.rows[0]?.push_subscriptions) ? r.rows[0].push_subscriptions : [];
    if (arr.length === 0) return res.status(400).json({ error: 'no_subscriptions' });
    const payload = JSON.stringify({
      title: 'TrackMyGigs',
      body: 'Push notifications are working.',
      url: '/',
      tag: 'tmg-test',
    });
    const out = await sendToSubscriptions(req.user.id, arr, payload);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[push/test]', err);
    res.status(500).json({ error: 'test_failed', message: err.message });
  }
});

// POST /api/push/cron-morning-reminders?key=<RELOAD_SECRET>
// Designed to be hit by a daily cron job around 9am UK time. Iterates
// every user with reminders enabled who has a confirmed gig today, then
// pushes a "Tonight: {venue}" notification to each device. Idempotent
// within a calendar day via the `tag` field (browsers replace prior
// notifications with the same tag rather than stacking).
router.post('/cron-morning-reminders', async (req, res) => {
  const want = process.env.RELOAD_SECRET || 'LEROADSECRET!';
  if ((req.query && req.query.key) !== want) return res.status(403).json({ error: 'forbidden' });
  if (!_configured) return res.status(503).json({ error: 'push_not_configured' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await db.query(
      `SELECT u.id AS user_id, u.push_subscriptions, g.venue_name, g.band_name, g.start_time, g.load_in_time
         FROM users u
         JOIN gigs g ON g.user_id = u.id
        WHERE u.push_reminders_enabled = TRUE
          AND jsonb_array_length(COALESCE(u.push_subscriptions, '[]'::jsonb)) > 0
          AND g.status = 'confirmed'
          AND g.date = $1`,
      [today]
    );
    let pushed = 0; let failed = 0;
    for (const row of r.rows) {
      const arr = Array.isArray(row.push_subscriptions) ? row.push_subscriptions : [];
      const venue = row.venue_name || row.band_name || 'your gig';
      const loadInBit = row.load_in_time ? ` Load-in at ${String(row.load_in_time).slice(0, 5)}.` : '';
      const payload = JSON.stringify({
        title: 'Tonight: ' + venue,
        body: 'Gig day.' + loadInBit + ' Tap to open.',
        url: '/',
        tag: 'tmg-morning-' + today,
      });
      const out = await sendToSubscriptions(row.user_id, arr, payload);
      pushed += out.sent || 0;
      failed += out.failed || 0;
    }
    res.json({ ok: true, users_notified: r.rows.length, pushed, failed });
  } catch (err) {
    console.error('[push/cron-morning-reminders]', err);
    res.status(500).json({ error: 'cron_failed', message: err.message });
  }
});

// Helper: send the same payload to every subscription in `subs` for one
// user. On 404 / 410 (subscription gone — user uninstalled / cleared
// browser data), prune that entry from the user's push_subscriptions
// array so we don't keep trying.
async function sendToSubscriptions(userId, subs, payload) {
  let sent = 0;
  let failed = 0;
  const stale = [];
  for (const sub of subs) {
    try {
      await webPush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) stale.push(sub.endpoint);
    }
  }
  if (stale.length > 0) {
    try {
      const fresh = subs.filter((s) => !stale.includes(s.endpoint));
      await db.query(
        `UPDATE users SET push_subscriptions = $2::jsonb,
                          push_reminders_enabled = ($3::int > 0)
            WHERE id = $1`,
        [userId, JSON.stringify(fresh), fresh.length]
      );
    } catch (_) { /* non-fatal */ }
  }
  return { sent, failed, pruned: stale.length };
}

module.exports = router;
