require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const calendarRoutes = require('./routes/calendar');
const chatRoutes = require('./routes/chat');
const publicRoutes = require('./routes/public');
const aiRoutes = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 5000;

// Unique ID per server start, or per /api/admin/reload call. Busts browser
// and service-worker caches for JS and CSS. Kept as `let` so the reload
// endpoint can bump it without a full process restart; otherwise the browser
// keeps serving the pre-pull `/js/app.js?v=OLD_BUILD_ID` from cache and the
// deploy looks like it didn't land.
let BUILD_ID = Date.now();

// Read index.html once at startup and inject BUILD_ID into asset URLs
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
let indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
// Replace any existing ?v=... or add ?v=BUILD_ID to .js and .css links
indexHtml = indexHtml
  .replace(/(href="\/css\/[^"]+\.css)(\?[^"]*)?"/g, `$1?v=${BUILD_ID}"`)
  .replace(/(src="\/js\/[^"]+\.js)(\?[^"]*)?"/g, `$1?v=${BUILD_ID}"`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static assets (JS, CSS, images) — never serve index.html or sw.js from here
// sw.js is excluded because the server injects BUILD_ID into it dynamically
app.use((req, res, next) => {
  if (req.path === '/sw.js') return next(); // skip static, hit our custom route below
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // prevent express.static from serving index.html for /
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // S14-05: "no-store" told the browser not to cache at all, which
      // defeated the service worker's offline story — the SW would serve
      // a cached hit for /js/app.js, but the Cache-Control header forced
      // every navigation revalidation and broke cold loads on flaky
      // mobile networks. BUILD_ID query strings are the real cache-bust
      // mechanism, so let the SW manage freshness. `must-revalidate`
      // without `no-store` means browsers still respect the SW cache but
      // always check origin on stale entries.
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

app.use('/auth', authRoutes);

// ── Admin reload endpoint ────────────────────────────────────────────────────
// Lets Claude trigger a git pull + restart with a single curl after pushing
// changes to GitHub, skipping the manual Replit Shell + Console dance. The
// server watches its own source files via nodemon (see .replit), so after the
// git pull writes new files on disk nodemon auto-restarts the process.
//
// Protected by RELOAD_SECRET env var. Accepts GET and POST so plain `curl URL`
// works; the key travels in the query string. Responds with the git output so
// it's obvious whether the pull actually fetched new commits.
//
// CRITICAL: these routes must be registered BEFORE `app.use('/api', apiRoutes)`
// so they bypass the auth middleware mounted inside apiRoutes. Otherwise every
// reload attempt returns 401 from authMiddleware before the handler runs.
function handleReload(req, res) {
  const expected = process.env.RELOAD_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'RELOAD_SECRET not configured' });
  }
  const provided = req.query.key || req.body?.key;
  if (provided !== expected) {
    return res.status(401).json({ error: 'Invalid reload key' });
  }
  // force=1 resolves the "local changes would be overwritten" case that
  // occasionally appears on Replit when the workspace has uncommitted edits.
  // It runs `git fetch origin && git reset --hard origin/main`, which always
  // lands the working tree on the latest origin/main. The reload secret is
  // enough of a gate since the only consumer is Gareth's deploy flow.
  const force = req.query.force === '1' || req.body?.force === '1' || req.body?.force === true;
  const cmd = force
    ? 'git fetch origin main && git reset --hard origin/main'
    : 'git pull origin main';
  exec(cmd, { cwd: __dirname, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[reload] ' + cmd + ' failed:', err.message);
      return res.status(500).json({ error: cmd + ' failed', stderr: stderr || err.message });
    }
    console.log('[reload] ' + cmd + ' output:\n' + stdout);
    // Re-read index.html into memory so HTML-only deploys take effect even
    // when nodemon doesn't restart the process. Nodemon by default only watches
    // .js / .json under the project root, so changes to public/index.html or
    // public/css/*.css land on disk after `git pull` but the running process
    // keeps serving the old cached `indexHtml` string from startup. Refreshing
    // it here closes that gap. If anything goes wrong (file moved, perms),
    // log and continue — the pull itself still succeeded.
    // Bump BUILD_ID so the injected `?v=...` cache-buster actually changes.
    // Without this, the reload endpoint reinjects the SAME value that was
    // injected at process start, browsers keep serving `/js/app.js` from
    // cache, and the deploy looks like it silently failed.
    BUILD_ID = Date.now();
    let indexReloaded = false;
    try {
      let fresh = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
      fresh = fresh
        .replace(/(href="\/css\/[^"]+\.css)(\?[^"]*)?"/g, `$1?v=${BUILD_ID}"`)
        .replace(/(src="\/js\/[^"]+\.js)(\?[^"]*)?"/g, `$1?v=${BUILD_ID}"`);
      indexHtml = fresh;
      indexReloaded = true;
    } catch (readErr) {
      console.error('[reload] failed to re-read index.html:', readErr.message);
    }
    res.json({
      ok: true,
      mode: force ? 'force' : 'pull',
      output: stdout.trim(),
      indexReloaded,
      buildId: BUILD_ID
    });
    // nodemon will pick up server.js / route changes and restart automatically;
    // for HTML/CSS-only changes, the in-memory refresh above is what makes them
    // visible without a full restart.
  });
}
app.get('/api/admin/reload', handleReload);
app.post('/api/admin/reload', handleReload);

// One-off cleanup endpoint for [SEC-TEST] harness data on the live helium DB.
// The multi-tenant audit test creates 10 sec-test-*@trackmygigs.test users
// plus their gigs, contacts, threads, messages and offers; the test's own
// cleanup() can only delete rows reachable via the REST API, which leaves the
// user rows themselves (and FK-cascading dependent rows) behind. This endpoint
// drops everything owned by those accounts in one transaction. Gated by
// RELOAD_SECRET because it runs raw deletes against live data.
async function handleCleanupSecTest(req, res) {
  const expected = process.env.RELOAD_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'RELOAD_SECRET not configured' });
  }
  const provided = req.query.key || req.body?.key;
  if (provided !== expected) {
    return res.status(401).json({ error: 'Invalid reload key' });
  }
  const pattern = 'sec-test-%@trackmygigs.test';
  const db = require('./db');
  const counts = {};
  try {
    await db.query('BEGIN');

    // Find the victim user ids first so every follow-on DELETE can use them.
    const ids = await db.query(
      `SELECT id FROM users WHERE email LIKE $1`, [pattern]
    );
    const userIds = ids.rows.map((r) => r.id);
    counts.users_matched = userIds.length;

    if (userIds.length === 0) {
      await db.query('COMMIT');
      return res.json({ ok: true, counts, note: 'no sec-test users present' });
    }

    // Tables that reference a user column directly. Every query takes a
    // single $1 = userIds::uuid[] param so the bind shape matches. Most
    // users-FK tables CASCADE on user delete, but we do explicit deletes
    // first so any weird NOT NULL constraint on related rows can't block
    // the transaction. nudge_feedback is excluded entirely because its
    // user_id column is INTEGER (legacy schema mismatch with users.id UUID)
    // and sec-test rows there are disposable anyway.
    const deletes = [
      // Non-gig threads first: no FK to users, only a UUID[] participant
      // array, so CASCADE can't reach them. Cascades messages on its way.
      ['threads_non_gig',     `DELETE FROM threads WHERE gig_id IS NULL AND participant_ids && $1::uuid[]`],
      // Orphan messages (shouldn't exist after the thread sweep, but belt
      // and braces: any message whose sender is about to vanish).
      ['messages_orphan',     `DELETE FROM messages WHERE sender_id = ANY($1::uuid[])`],
      ['offers',              `DELETE FROM offers WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])`],
      ['contacts',            `DELETE FROM contacts WHERE owner_id = ANY($1::uuid[])`],
      ['invoices',            `DELETE FROM invoices WHERE user_id = ANY($1::uuid[])`],
      ['receipts',            `DELETE FROM receipts WHERE user_id = ANY($1::uuid[])`],
      ['blocked_dates',       `DELETE FROM blocked_dates WHERE user_id = ANY($1::uuid[])`],
      ['songs',               `DELETE FROM songs WHERE user_id = ANY($1::uuid[])`],
      ['setlists',            `DELETE FROM setlists WHERE user_id = ANY($1::uuid[])`],
      ['user_documents',      `DELETE FROM user_documents WHERE user_id = ANY($1::uuid[])`],
      // Gigs cascade: offers (gig_id), threads (gig_id), and through those
      // messages. Deletes any gig-linked chat rows left after the earlier
      // sweeps.
      ['gigs',                `DELETE FROM gigs WHERE user_id = ANY($1::uuid[])`],
      ['sessions',            `DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`],
      ['users',               `DELETE FROM users WHERE id = ANY($1::uuid[])`],
    ];

    for (const [name, sql] of deletes) {
      try {
        const r = await db.query(sql, [userIds]);
        counts[name] = r.rowCount;
      } catch (tableErr) {
        // Table or column may not exist on every deploy; record the miss
        // and keep going so one missing table doesn't strand the rest.
        counts[name] = `skipped: ${tableErr.message}`;
      }
    }

    await db.query('COMMIT');
    res.json({ ok: true, counts });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('[cleanup-sec-test] failed:', err);
    res.status(500).json({ error: 'cleanup failed', detail: err.message });
  }
}
app.get('/api/admin/cleanup-sec-test', handleCleanupSecTest);
app.post('/api/admin/cleanup-sec-test', handleCleanupSecTest);

app.use('/api/ai', aiRoutes);
app.use('/api', apiRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/chat', chatRoutes);
// Public share and EPK routes (no auth) — mounted at /share and /epk via the same router
app.use('/', publicRoutes);

// Serve sw.js with BUILD_ID injected so the service worker cache name changes
// on every server restart — forcing browsers to install the new worker and
// wipe out any stale cached responses.
app.get('/sw.js', (req, res) => {
  const swPath = path.join(__dirname, 'public', 'sw.js');
  let swSource = fs.readFileSync(swPath, 'utf8');
  // Replace the placeholder CACHE_VERSION with the real BUILD_ID
  swSource = swSource.replace(
    "const CACHE_VERSION = self.CACHE_VERSION || 'v-' + Date.now();",
    `const CACHE_VERSION = '${BUILD_ID}';`
  );
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
  res.setHeader('Content-Type', 'application/javascript');
  res.send(swSource);
});

// Serve config.js as valid JS regardless of browser cache state.
// Old index.html versions reference this file; returning valid JS prevents
// the "Unexpected token '<'" crash caused by a cached HTML response.
app.get('/config.js', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '775009954166-8ngl19vdj033jv0mbquoll385c8cd58t.apps.googleusercontent.com';
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.GOOGLE_CLIENT_ID = window.GOOGLE_CLIENT_ID || "${clientId}";\n`);
});

// Asset requests that don't exist as static files → 404 (never return HTML)
const ASSET_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|json|woff|woff2|ttf|map)$/i;

app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || ASSET_EXTENSIONS.test(req.path)) {
    res.status(404).send('Not found');
    return;
  }
  // Serve the pre-built index.html with injected BUILD_ID — never cached
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(indexHtml);
});

// Run pending migrations on startup
const db = require('./db');
async function runMigrations() {
  try {
    // Add Google token columns if they don't exist
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_token_expires_at TIMESTAMP`);
    // Store the Google account email whose calendar is linked. Can differ from
    // the user's app login email (e.g. a shared band-admin account holding the
    // gig calendar). Shown in Profile so users know which account to
    // disconnect or re-authorize.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_calendar_email VARCHAR(255)`);
    // Add created_at to invoices if missing
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
    // Add created_at to gigs if missing
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);
    // Add venue_address to invoices for auto-fill from linked gig
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS venue_address TEXT`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS venue_name VARCHAR(255)`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS description TEXT`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT`);
    // Add checklist JSON to gigs for prep items
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS checklist JSONB DEFAULT '[]'`);
    // Add gig_type as its own column (previously embedded in notes as [Type])
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS gig_type VARCHAR(100)`);
    // Allow users to mark gig details as complete (dismisses optional fields)
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS details_complete BOOLEAN DEFAULT FALSE`);
    // Add review URLs to users for Google/Facebook review links
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_review_url TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_review_url TEXT`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS set_times JSONB DEFAULT '[]'`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS parking_info TEXT`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS day_of_contact TEXT`);
    // Invoice & payment settings on users
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_details TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_prefix VARCHAR(20) DEFAULT 'INV'`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_next_number INTEGER DEFAULT 1`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_format VARCHAR(20) DEFAULT 'plain'`);
    // Colour theme preference (amber, blue, green, purple, red)
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS colour_theme VARCHAR(20) DEFAULT 'amber'`);
    // display_name: user's real name (separate from "name" which is often used for act/band)
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`);
    // Public share / EPK
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_slug VARCHAR(64)`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_public_slug_uniq ON users (public_slug) WHERE public_slug IS NOT NULL`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS epk_bio TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS epk_photo_url TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS epk_video_url TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS epk_audio_url TEXT`);
    // Two-way Google Calendar sync: store the Google event id for each pushed gig
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255)`);
    // Mirror manually-blocked dates onto the user's Google Calendar as all-day
    // "Busy" events so other apps (Doodle, Calendly, their partner) see the
    // block. google_event_id links each blocked_dates row to its Google event
    // so updates and deletes stay in sync.
    await db.query(`ALTER TABLE blocked_dates ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255)`);
    // Inbound sync: incremental syncToken from Google, plus last-pull timestamp for throttling
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sync_token TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_last_pull_at TIMESTAMP`);
    // Onboarding + feedback
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP`);
    await db.query(`CREATE TABLE IF NOT EXISTS nudge_feedback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      nudge_type VARCHAR(64) NOT NULL,
      gig_id INTEGER,
      action VARCHAR(32) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    // Calendar public-feed token (separate from public_slug so it can be rotated independently)
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS share_token VARCHAR(64)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS share_token_enabled BOOLEAN DEFAULT FALSE`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_share_token_uniq ON users (share_token) WHERE share_token IS NOT NULL`);
    // Thread classification: 'dep' threads are private 1:1 chats with a dep;
    // anything else is a gig-band group thread. Older rows default to NULL.
    await db.query(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS kind VARCHAR(32)`);
    // Rate card: default rates the user quotes for different gig types.
    // Stored as DECIMAL so we never hit floating-point fee errors.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_standard DECIMAL(10,2)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_premium DECIMAL(10,2)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_dep DECIMAL(10,2)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_deposit_pct INTEGER`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_notes TEXT`);
    // BUG-AUDIT-01: Per-user notification preferences (dep offers, chat, gig reminders, invoices, weekly digest, important emails).
    // Stored as JSONB so we can add new channels without further migrations.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{}'::jsonb`);
    // Onboarding: has the user seen the welcome tour yet?
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_completed_at TIMESTAMP`);
    // Invoice metadata: business address and VAT number printed on invoice PDFs.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_address TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vat_number VARCHAR(64)`);
    // Invoice lifecycle timestamps and dunning tracking
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS chase_count INTEGER DEFAULT 0`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_chase_at TIMESTAMP`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recipient_email VARCHAR(255)`);
    // S13-09: link receipts to gigs so "expenses for this gig" and per-gig P&L work.
    await db.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS gig_id INTEGER`);
    await db.query(`CREATE INDEX IF NOT EXISTS receipts_gig_id_idx ON receipts (gig_id)`);
    // S7-08: per-offer snooze timestamp so snooze survives device switches / re-auth.
    // Offers whose snoozed_until is in the future are hidden from the inbox list.
    await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP`);
    // S8-05: notification dismissals persisted server-side by notification key.
    // Notification "keys" are synthesized client-side from type:action_type:action_id:timestamp.
    // user_id is UUID (users.id is UUID). An earlier version of this migration
    // typed it as INTEGER, so every INSERT silently failed and the try/catch
    // masked it. If the column still exists as INTEGER, drop and recreate —
    // any stored data is garbage (the INSERTs never succeeded).
    const dismissCol = await db.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'notification_dismissals' AND column_name = 'user_id'
    `);
    if (dismissCol.rows.length && dismissCol.rows[0].data_type !== 'uuid') {
      await db.query(`DROP TABLE IF EXISTS notification_dismissals`);
    }
    await db.query(`CREATE TABLE IF NOT EXISTS notification_dismissals (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      notif_key TEXT NOT NULL,
      dismissed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, notif_key)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS notif_dismiss_user_idx ON notification_dismissals (user_id)`);
    // Stage-4 QA fix: contacts.location was referenced by POST /api/contacts but
    // the column was never added — every contact create returned 500.
    await db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location TEXT`);
    // Calendar connection error state: when the refresh_token gets revoked
    // (user unlinks TMG from their Google security page), the next refresh
    // throws invalid_grant. Used to silently return null from getGoogleAuth
    // and the app just stopped syncing with no user-visible signal. Now we
    // persist the state so the Calendar UI can render a "reconnect" banner.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_connection_state VARCHAR(32)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_connection_error TEXT`);
    // Multi-calendar selection: TMG used to hardcode calendarId:'primary', so
    // users who kept gigs on a separate work or band calendar saw nothing flow
    // through. Single calendar selection (default primary) is enough for the
    // launch cohort; bumping to multi-select would need per-calendar sync tokens.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_selected_calendar VARCHAR(255) DEFAULT 'primary'`);
    // One-time cleanup: a legacy gig row (uuid prefix 1cc2b3e0, "The Vents @
    // The Post Barn", 2026-04-23) was created with 00:00/00:00 start+end times
    // and kept surfacing on the Calendar as a ghost. Predates the wizard's
    // required-start-time rule. Idempotent: only matches if both times are
    // still 00:00:00.
    await db.query(`DELETE FROM gigs WHERE id::text LIKE '1cc2b3e0%' AND start_time = '00:00:00'::time AND end_time = '00:00:00'::time`);
    // Teaching gig support. Private lessons need a client contact that is
    // distinct from the band/venue (the parent or the pupil) and an hourly
    // rate that drives the per-lesson fee and the invoice bundler. These
    // columns stay NULL for non-teaching rows.
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS client_name VARCHAR(255)`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS client_email VARCHAR(255)`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS client_phone VARCHAR(64)`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS rate_per_hour DECIMAL(10,2)`);
    // Fast lookup for the bundler: "all teaching gigs for a client in a range"
    await db.query(`CREATE INDEX IF NOT EXISTS gigs_teaching_client_idx ON gigs (user_id, gig_type, client_email) WHERE gig_type = 'Teaching'`);
    // Documents & certs. Stores DBS, PLI, risk assessments, etc. File bytes
    // live in-row as bytea for MVP — we're not pulling in object storage until
    // average file size or usage forces it. expiry_date is optional so users
    // can log a policy number or reference doc with no renewal date.
    await db.query(`CREATE TABLE IF NOT EXISTS user_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      doc_type VARCHAR(32) NOT NULL DEFAULT 'other',
      file_data BYTEA,
      mime_type VARCHAR(128),
      file_name VARCHAR(255),
      file_size INTEGER,
      issued_date DATE,
      expiry_date DATE,
      notes TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS user_documents_user_idx ON user_documents (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS user_documents_expiry_idx ON user_documents (user_id, expiry_date) WHERE expiry_date IS NOT NULL`);
    // Distance filter (roadmap Phase VI). users.home_postcode already exists;
    // we only add the resolved lat/lng and the travel radius. Gigs get a
    // venue_postcode plus resolved lat/lng so broadcast send can filter on
    // distance without a postcodes.io round-trip per recipient. travel radius
    // default of 50 miles matches the current roadmap slider default.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lat DOUBLE PRECISION`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lng DOUBLE PRECISION`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS travel_radius_miles INTEGER DEFAULT 50`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS venue_postcode VARCHAR(16)`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS venue_lat DOUBLE PRECISION`);
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS venue_lng DOUBLE PRECISION`);
    // Phase IX-A: Find Musicians directory foundations.
    //
    // users.discoverable: default TRUE so every new account is findable in the
    // directory unless they opt out in Profile Settings. Decision 1, locked.
    // users.phone_normalized: E.164 canonical of users.phone so exact-match
    // lookups work regardless of how the user typed their number. Backfilled
    // further down. users.bio / photo_url / genres: profile richness for
    // directory result cards (decisions 5 and 6). 280-char cap on bio is
    // enforced in the API, not the column, so schema does not need to change
    // later if we raise the limit.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS discoverable BOOLEAN DEFAULT TRUE`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_normalized TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS genres TEXT[]`);
    // Partial indexes: directory queries are always scoped by discoverable =
    // TRUE, so the index only needs to cover those rows. Phone lookup is an
    // exact-match equality query on phone_normalized, so a simple btree is
    // the right shape.
    await db.query(`CREATE INDEX IF NOT EXISTS users_discoverable_idx ON users (discoverable) WHERE discoverable = TRUE`);
    await db.query(`CREATE INDEX IF NOT EXISTS users_phone_normalized_idx ON users (phone_normalized) WHERE phone_normalized IS NOT NULL`);
    // user_blocks: symmetric block relation. A block row from A to B hides B
    // from A's directory results, hides A from B's results, and hard-fails
    // any dep-offer between the two with a generic error (decision 10).
    await db.query(`CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id UUID NOT NULL,
      blocked_id UUID NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id)`);
    // user_reports: free-form abuse reports from the directory. reason_category
    // is one of a small enum (spam, impersonation, harassment, fake, other);
    // reason_text is the free-text explanation. resolved_at is NULL until an
    // admin clears the report. No FK to users because we want reports to
    // outlive soft-deletes of the reported account for audit purposes.
    await db.query(`CREATE TABLE IF NOT EXISTS user_reports (
      id SERIAL PRIMARY KEY,
      reporter_id UUID NOT NULL,
      target_id UUID NOT NULL,
      reason_category VARCHAR(32) NOT NULL,
      reason_text TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS user_reports_target_idx ON user_reports (target_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS user_reports_open_idx ON user_reports (created_at DESC) WHERE resolved_at IS NULL`);
    // discovery_lookups: audit log plus the data source for rate limiting
    // (decision 12: 30 name lookups/hr, 20 email+phone combined/hr). query_hash
    // is a SHA-256 of the raw query term so the audit log does not store PII
    // in the clear; the hash is still enough to identify duplicate lookups
    // during abuse review.
    await db.query(`CREATE TABLE IF NOT EXISTS discovery_lookups (
      id SERIAL PRIMARY KEY,
      actor_id UUID NOT NULL,
      mode VARCHAR(16) NOT NULL,
      query_hash VARCHAR(64),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS discovery_lookups_actor_time_idx ON discovery_lookups (actor_id, created_at DESC)`);
    // Phase IX-A backfill: populate phone_normalized for every existing row
    // that has a phone but no normalised form yet. The WHERE clause makes the
    // migration idempotent on subsequent restarts.
    try {
      const { normaliseE164 } = require('./lib/phone');
      const backfill = await db.query(
        `SELECT id, phone FROM users WHERE phone IS NOT NULL AND phone <> '' AND phone_normalized IS NULL`
      );
      let filled = 0, unparsed = 0;
      for (const row of backfill.rows) {
        const e164 = normaliseE164(row.phone);
        if (e164) {
          await db.query(`UPDATE users SET phone_normalized = $1 WHERE id = $2`, [e164, row.id]);
          filled++;
        } else {
          unparsed++;
        }
      }
      if (backfill.rows.length) {
        console.log(`Phase IX-A phone backfill: ${filled} normalised, ${unparsed} unparseable (left as NULL)`);
      }
    } catch (backfillErr) {
      console.error('Phase IX-A backfill error (non-fatal):', backfillErr.message);
    }
    // Phase IX-D: Add Contact auto-suggest bridge. When the Add Contact form
    // detects a typed email/phone matches a discoverable TrackMyGigs user,
    // clicking "Link" stores linked_user_id on the contact row. This is the
    // durable join that lets later flows (dep cascade, chat) map a network
    // contact to a real TMG account without re-matching by email+phone.
    // ON DELETE SET NULL: if the linked user deletes their account, the
    // contact row survives as an unlinked entry.
    await db.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linked_user_id UUID REFERENCES users(id) ON DELETE SET NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS contacts_linked_user_idx ON contacts (linked_user_id) WHERE linked_user_id IS NOT NULL`);
    console.log('Migrations: OK');
  } catch (err) {
    console.error('Migration error (non-fatal):', err.message);
  }
}

// Safety net: a rejected promise inside a route handler that isn't caught by
// a try/catch will otherwise crash the whole Node process under Replit's
// supervisor. We'd rather log and keep serving. An earlier deep-test run of
// the AI routes took the server down because one SQL query referenced a
// non-existent column and the rejection escaped.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err && err.stack ? err.stack : err);
});

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`TrackMyGigs server running on port ${PORT} (build ${BUILD_ID})`);
  });
});
