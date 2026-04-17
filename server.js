require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const calendarRoutes = require('./routes/calendar');
const chatRoutes = require('./routes/chat');
const publicRoutes = require('./routes/public');

const app = express();
const PORT = process.env.PORT || 5000;

// Unique ID per server start — busts browser/proxy cache for JS and CSS
const BUILD_ID = Date.now();

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
    await db.query(`CREATE TABLE IF NOT EXISTS notification_dismissals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      notif_key TEXT NOT NULL,
      dismissed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, notif_key)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS notif_dismiss_user_idx ON notification_dismissals (user_id)`);
    console.log('Migrations: OK');
  } catch (err) {
    console.error('Migration error (non-fatal):', err.message);
  }
}

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`TrackMyGigs server running on port ${PORT} (build ${BUILD_ID})`);
  });
});
