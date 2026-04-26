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

// Read the landing page once at startup. Served at / for unauthenticated
// visitors; authenticated visitors fall through to /app which serves the SPA.
const LANDING_HTML_PATH = path.join(__dirname, 'public', 'landing.html');
let landingHtml = '';
try {
  landingHtml = fs.readFileSync(LANDING_HTML_PATH, 'utf8');
} catch (err) {
  console.warn('[server] landing.html not found yet:', err.message);
}

// Stripe webhook MUST be registered before express.json() so the raw
// payload survives for signature verification. Mount just the webhook
// path early; the rest of the Stripe routes go after body-parsing.
const stripeWebhook = require('./routes/stripe');
if (stripeWebhook.webhookHandler && stripeWebhook.rawJsonParser) {
  app.post('/api/stripe/webhook', stripeWebhook.rawJsonParser, stripeWebhook.webhookHandler);
}

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
  // install=1 chains `npm install` after the git update so dependency bumps
  // (e.g. adding pdfkit) don't require a manual Shell visit. nodemon will
  // then restart the process against the freshly installed node_modules.
  // Timeout is bumped to 120s when install is requested because a cold
  // `npm install` on Replit can take 30-60s.
  const install = req.query.install === '1' || req.body?.install === '1' || req.body?.install === true;
  const gitCmd = force
    ? 'git fetch origin main && git reset --hard origin/main'
    : 'git pull origin main';
  const cmd = install ? `${gitCmd} && npm install --no-audit --no-fund` : gitCmd;
  const timeoutMs = install ? 120000 : 30000;
  exec(cmd, { cwd: __dirname, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    // Re-read landing.html on reload too so marketing-page edits land
    // without a full process restart. Same pattern as indexHtml above.
    try {
      landingHtml = fs.readFileSync(LANDING_HTML_PATH, 'utf8');
    } catch (readErr) {
      console.error('[reload] failed to re-read landing.html:', readErr.message);
    }
    res.json({
      ok: true,
      mode: force ? 'force' : 'pull',
      install,
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

// Stripe routes. The webhook inside stripeRoutes uses express.raw() itself
// so mounting here (after express.json) is fine: Express matches the first
// body-parser that accepts the content-type and the raw parser short-circuits
// the JSON parser for the webhook path specifically.
const stripeRoutes = require('./routes/stripe');
app.use('/api/stripe', stripeRoutes);

app.use('/api/ai', aiRoutes);
app.use('/api', apiRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/chat', chatRoutes);
// Public share and EPK routes (no auth) — mounted at /share and /epk via the same router
app.use('/', publicRoutes);

// Phase IX-G: Admin review queue. The page itself is unauthenticated HTML
// that fetches /api/admin/reports; the API endpoints do the real is_admin
// gate via authMiddleware + requireAdmin. Unauthenticated visitors see
// "Admin access required" because fetch() returns 401/403 and we render it.
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TMG Admin · Report queue</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #1f2630;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --accent: #58a6ff;
    --danger: #f85149;
    --good: #3fb950;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  header {
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  header h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  header nav {
    display: flex;
    gap: 8px;
  }
  nav button {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  nav button.active {
    background: var(--accent);
    color: #0d1117;
    border-color: var(--accent);
  }
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px;
  }
  .status-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    background: var(--panel-2);
    color: var(--muted);
  }
  .status-pill.open { color: #f0b849; }
  .status-pill.resolved { color: var(--good); }
  .status-pill.dismissed { color: var(--muted); }
  .empty, .loading, .error {
    padding: 40px;
    text-align: center;
    color: var(--muted);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .error { color: var(--danger); border-color: var(--danger); }
  .report {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 14px;
  }
  .report .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
  }
  .report .category {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    font-weight: 700;
  }
  .report .time {
    font-size: 12px;
    color: var(--muted);
  }
  .report .people {
    font-size: 14px;
    color: var(--text);
    margin-bottom: 8px;
  }
  .report .people strong { color: var(--text); }
  .report .reason {
    background: var(--panel-2);
    border-left: 3px solid var(--accent);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 14px;
    white-space: pre-wrap;
    word-wrap: break-word;
    margin-bottom: 12px;
    color: var(--text);
  }
  .report .actions {
    display: flex;
    gap: 8px;
  }
  .report .actions button {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  .report .actions button.resolve { border-color: var(--good); color: var(--good); }
  .report .actions button.dismiss { border-color: var(--muted); }
  .report .actions button:disabled { opacity: 0.5; cursor: wait; }
  .report .resolver {
    font-size: 12px;
    color: var(--muted);
  }
</style>
</head>
<body>
<header>
  <h1>TMG Admin · Report queue</h1>
  <nav>
    <button data-status="open" class="active">Open</button>
    <button data-status="resolved">Resolved</button>
    <button data-status="dismissed">Dismissed</button>
    <button data-status="all">All</button>
  </nav>
</header>
<main>
  <div id="queue"><div class="loading">Loading…</div></div>
</main>
<script>
(function () {
  var currentStatus = 'open';
  var queueEl = document.getElementById('queue');
  var navButtons = document.querySelectorAll('header nav button');

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }

  function renderReport(r) {
    var reporter = r.reporter_name || r.reporter_email || r.reporter_id || 'unknown';
    var target = r.target_name || r.target_email || r.target_id || 'unknown';
    var status = r.resolution_status || 'open';
    var statusClass = 'status-pill ' + status;
    var resolverLine = '';
    if (r.resolution_status) {
      var who = r.resolver_name || r.resolver_email || '';
      resolverLine = '<div class="resolver">' +
        escapeHtml(status.charAt(0).toUpperCase() + status.slice(1)) +
        ' ' + escapeHtml(formatTime(r.resolved_at)) +
        (who ? ' by ' + escapeHtml(who) : '') +
        '</div>';
    }
    var actions = '';
    if (!r.resolution_status) {
      actions = '<div class="actions">' +
        '<button class="resolve" data-id="' + escapeHtml(r.id) + '" data-action="resolve">Resolve</button>' +
        '<button class="dismiss" data-id="' + escapeHtml(r.id) + '" data-action="dismiss">Dismiss</button>' +
        '</div>';
    }
    return '<article class="report" data-id="' + escapeHtml(r.id) + '">' +
      '<div class="head">' +
        '<span class="category">' + escapeHtml(r.reason_category || 'other') + '</span>' +
        '<span class="' + statusClass + '">' + escapeHtml(status) + '</span>' +
        '<span class="time">' + escapeHtml(formatTime(r.created_at)) + '</span>' +
      '</div>' +
      '<div class="people"><strong>' + escapeHtml(reporter) + '</strong> reported <strong>' + escapeHtml(target) + '</strong></div>' +
      (r.reason_text ? '<div class="reason">' + escapeHtml(r.reason_text) + '</div>' : '') +
      resolverLine +
      actions +
    '</article>';
  }

  function setQueueHtml(html) { queueEl.innerHTML = html; }

  function load() {
    setQueueHtml('<div class="loading">Loading…</div>');
    fetch('/api/admin/reports?status=' + encodeURIComponent(currentStatus), {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      if (res.status === 401) {
        setQueueHtml('<div class="error">Not signed in. Open the app and sign in first, then reload this page.</div>');
        return null;
      }
      if (res.status === 403) {
        setQueueHtml('<div class="error">Admin access required.</div>');
        return null;
      }
      if (!res.ok) {
        setQueueHtml('<div class="error">Error ' + res.status + ' loading reports.</div>');
        return null;
      }
      return res.json();
    }).then(function (data) {
      if (!data) return;
      var rows = (data && data.reports) || [];
      if (!rows.length) {
        setQueueHtml('<div class="empty">No reports in this bucket.</div>');
        return;
      }
      setQueueHtml(rows.map(renderReport).join(''));
    }).catch(function (err) {
      setQueueHtml('<div class="error">Network error: ' + escapeHtml(err && err.message || err) + '</div>');
    });
  }

  function act(id, action, btn) {
    var buttons = btn.parentNode.querySelectorAll('button');
    buttons.forEach(function (b) { b.disabled = true; });
    fetch('/api/admin/reports/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function () {
      load();
    }).catch(function (err) {
      buttons.forEach(function (b) { b.disabled = false; });
      alert('Failed to ' + action + ': ' + (err && err.message || err));
    });
  }

  navButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      navButtons.forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      currentStatus = b.getAttribute('data-status');
      load();
    });
  });

  queueEl.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.tagName === 'BUTTON' && t.getAttribute('data-action')) {
      act(t.getAttribute('data-id'), t.getAttribute('data-action'), t);
    }
  });

  load();
})();
</script>
</body>
</html>`);
});

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
  // Landing page at / for anonymous visitors. Authenticated users (those
  // with a sessionToken cookie) fall through to the SPA so bookmarked-root
  // returns don't bump them back out to marketing. The session cookie is
  // a UUID; we don't validate it here (the SPA's /auth/me check handles
  // actual auth), just detect presence for the routing flip.
  const isRoot = req.path === '/';
  const hasSession = !!(req.cookies && req.cookies.sessionToken);
  if (isRoot && !hasSession && landingHtml) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(landingHtml);
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
    // Invoice metadata: business address, phone and VAT number printed on invoice PDFs.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_address TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_phone VARCHAR(32)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vat_number VARCHAR(64)`);
    // Invoice lifecycle timestamps and dunning tracking
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS chase_count INTEGER DEFAULT 0`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_chase_at TIMESTAMP`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recipient_email VARCHAR(255)`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recipient_address TEXT`);

    // Invoice client directory: save-on-use address book so a musician only
    // types a client once. Keyed to (user_id, lower(name)) so "Marriott" and
    // "marriott" collapse into a single row, and ordered by last_used_at so
    // recently-billed clients float to the top of the datalist.
    await db.query(`
      CREATE TABLE IF NOT EXISTS invoice_clients (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        address TEXT,
        email VARCHAR(255),
        phone VARCHAR(64),
        last_used_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS invoice_clients_user_name_idx
                    ON invoice_clients (user_id, LOWER(name))`);

    // S13-09: link receipts to gigs so "expenses for this gig" and per-gig P&L work.
    await db.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS gig_id INTEGER`);
    await db.query(`CREATE INDEX IF NOT EXISTS receipts_gig_id_idx ON receipts (gig_id)`);
    // S7-08: per-offer snooze timestamp so snooze survives device switches / re-auth.
    // Offers whose snoozed_until is in the future are hidden from the inbox list.
    await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP`);
    // Import write-safety flag (2026-04-23). When FALSE, the gig was
    // imported from Google and has never been edited in TrackMyGigs. The
    // sync-back layer uses this to avoid overwriting user-curated Google
    // event descriptions / titles / locations with TMG auto-generated
    // copies. Flipped TRUE the first time a user saves the gig via PATCH
    // or the wizard; also TRUE for gigs created directly in TMG.
    await db.query(`ALTER TABLE gigs ADD COLUMN IF NOT EXISTS tmg_edited BOOLEAN NOT NULL DEFAULT FALSE`);
    // Gigs created directly in TMG (no Google origin) should count as
    // edited from the start — if they didn't, sync-back would silently
    // skip them. Backfill any pre-existing rows that originated locally.
    await db.query(`UPDATE gigs SET tmg_edited = TRUE WHERE tmg_edited = FALSE AND (source IS NULL OR source NOT LIKE 'gcal:%')`);
    // Premium subscription columns (2026-04-23). premium is the live flag
    // used to gate premium features; premium_until mirrors the Stripe
    // current_period_end so we can show the user when their billing cycle
    // rolls over. stripe_customer_id persists across subscription cycles
    // (one customer, many subscriptions over time). stripe_subscription_id
    // is the current active subscription, cleared when cancelled.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS premium BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`);
    // 2026-04-26: when the user cancels via Stripe Billing Portal, Stripe
    // doesn't end the subscription immediately; it sets cancel_at_period_end
    // and lets them keep access until the trial / period ends. We mirror that
    // flag so the Profile screen can label the date accordingly ("cancels on
    // 10 May" vs "renews on 10 May"). Resubscribing flips it back to false.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE`);
    // 2026-04-26: trial-abuse defence layer.
    //   trial_consumed_at: stamped on first subscription creation. Stops a
    //     user cancelling and signing up again with the SAME email for a
    //     fresh 14-day trial. Once it's set, future checkouts pass
    //     trial_period_days=0 (subscribe immediately, no free window).
    //   card_fingerprints: every Stripe card has a fingerprint that's stable
    //     across customers. We append to this array whenever a payment
    //     method gets attached to one of our users. At checkout completion
    //     we cross-reference: if the new card has been used by ANY OTHER
    //     user before, that user is recycling cards across emails, so we
    //     end their trial immediately and charge them the £14.99.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_consumed_at TIMESTAMP`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS card_fingerprints TEXT[] NOT NULL DEFAULT '{}'`);
    await db.query(`CREATE INDEX IF NOT EXISTS users_card_fingerprints_gin ON users USING GIN (card_fingerprints)`);
    // Backfill: any user who already has a Stripe subscription has by
    // definition consumed their trial — they signed up before this column
    // existed. Stamp NOW() so a future cancel-then-resubscribe by them
    // doesn't sneak through with another fortnight free. Idempotent: only
    // fills NULL rows, never overwrites.
    await db.query(`
      UPDATE users SET trial_consumed_at = NOW()
      WHERE stripe_subscription_id IS NOT NULL AND trial_consumed_at IS NULL
    `);
    // Universal pay-link (2026-04-23, task #292). User-set URL pointing to
    // their preferred payment method (Stripe Payment Link, PayPal.me, SumUp,
    // Wise, Monzo.me, etc.). Embedded in every invoice email + PDF as a
    // Pay Online button. Per-invoice override lets the user point a single
    // invoice at a different URL when needed (e.g. a deposit link). The
    // public_pay_slug is the short token used in /pay/<slug> redirect URLs
    // so we don't expose the integer invoice id to email recipients.
    // Click-tracking columns let the user see "Bob clicked your pay link
    // 2 min ago" before any money has actually moved.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_link_url TEXT`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link_url_override TEXT`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_pay_slug TEXT UNIQUE`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pay_link_clicks INT NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pay_link_last_clicked_at TIMESTAMP`);
    // Backfill slugs for any pre-existing invoices so the public /pay/:slug
    // route works for old data too. Generates 10 hex chars per row inside
    // Postgres so we don't have to round-trip via the app to mint them.
    await db.query(`
      UPDATE invoices SET public_pay_slug = encode(gen_random_bytes(5), 'hex')
      WHERE public_pay_slug IS NULL
    `).catch(() => {
      // pgcrypto / gen_random_bytes() may not be available on very old
      // Postgres builds. Fall back to md5(random()::text) which exists on
      // every install. Slug uniqueness is enforced by the column constraint
      // so a collision (astronomically unlikely at 10 hex chars) would
      // simply error out and be hand-resolved.
      return db.query(`
        UPDATE invoices SET public_pay_slug = substring(md5(random()::text || id::text) FOR 10)
        WHERE public_pay_slug IS NULL
      `);
    });
    // Nudge cap (2026-04-23): sender gets 1 initial send + up to 2 nudges per
    // active offer. The third send of the same (gig, sender, recipient) pair
    // while the offer is still pending is rejected. nudge_count tracks how
    // many nudges have been sent; last_nudged_at bumps the inbox ordering.
    await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS nudge_count INT NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS last_nudged_at TIMESTAMP`);
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
    // Phase IX-G: Admin review queue for directory reports. is_admin gates the
    // /admin route and the admin API. resolution_status lives alongside the
    // existing resolved_at so we can distinguish "resolved (action taken)"
    // from "dismissed (no action needed)" without losing the audit timestamp.
    // Owner bootstrap: skinnycheck@gmail.com gets is_admin on every migration
    // pass so the admin UI is reachable without a manual DB edit.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS resolution_status VARCHAR(16)`);
    await db.query(`ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS resolver_id UUID`);
    await db.query(`UPDATE users SET is_admin = TRUE WHERE lower(email) = 'skinnycheck@gmail.com' AND is_admin = FALSE`);
    await db.query(`UPDATE users SET subscription_tier = 'premium' WHERE lower(email) = 'skinnycheck@gmail.com' AND subscription_tier IS DISTINCT FROM 'premium'`);
    // Phase X: Urgent-gigs marketplace.
    //
    // users.min_fee_pence drives the default Min £ filter on Browse and which
    // gigs feed the menu notification badge. £30 default matches the paid-tab
    // floor. Stored in pence so we avoid floating-point drift. users.notify_
    // free_gigs is an opt-in flag for the Free tab — badge stays clean for
    // users who don't play unpaid work, discoverable for students/charity-
    // minded pros who switch it on.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS min_fee_pence INTEGER DEFAULT 3000`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_free_gigs BOOLEAN DEFAULT FALSE`);
    // marketplace_gigs: a single post on the urgent-gigs board. fee_pence = 0
    // with is_free = TRUE is the Free tab; fee_pence >= 3000 with is_free =
    // FALSE is the Paid tab. free_reason is required when is_free = TRUE
    // (enforced in the POST handler, not at the column level, so we can
    // evolve the reason list without a migration). mode is 'pick' or 'fcfs';
    // defaults are set per-tab in the composer, not at the column level.
    // status: 'open' (default), 'filled' (someone picked or FCFS-claimed),
    // 'expired' (past expires_at with no fill), 'cancelled' (poster withdrew).
    // instruments is a TEXT[] so the radius-badge matcher can do a simple
    // overlap check against the user's own instruments array.
    await db.query(`CREATE TABLE IF NOT EXISTS marketplace_gigs (
      id SERIAL PRIMARY KEY,
      poster_user_id UUID NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      venue_name VARCHAR(200),
      venue_address TEXT,
      venue_postcode VARCHAR(16),
      venue_lat DOUBLE PRECISION,
      venue_lng DOUBLE PRECISION,
      gig_date DATE NOT NULL,
      start_time TIME,
      end_time TIME,
      instruments TEXT[] NOT NULL DEFAULT '{}',
      fee_pence INTEGER NOT NULL DEFAULT 0,
      is_free BOOLEAN NOT NULL DEFAULT FALSE,
      free_reason VARCHAR(40),
      mode VARCHAR(10) NOT NULL DEFAULT 'pick',
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      filled_by_user_id UUID,
      filled_at TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS marketplace_gigs_status_idx ON marketplace_gigs (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS marketplace_gigs_date_idx ON marketplace_gigs (gig_date)`);
    await db.query(`CREATE INDEX IF NOT EXISTS marketplace_gigs_is_free_idx ON marketplace_gigs (is_free, status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS marketplace_gigs_poster_idx ON marketplace_gigs (poster_user_id, created_at DESC)`);
    // marketplace_applications: one row per applicant per gig. UNIQUE on
    // (gig, applicant) blocks double-applies. status transitions:
    // 'pending' → 'accepted' (poster picked them, or FCFS won) | 'rejected'
    // (poster picked someone else) | 'withdrawn' (applicant pulled out). note
    // is the applicant's short pitch shown in the applicant list + profile
    // preview. thread_id will be backfilled when we wire chat into the flow.
    await db.query(`CREATE TABLE IF NOT EXISTS marketplace_applications (
      id SERIAL PRIMARY KEY,
      marketplace_gig_id INTEGER NOT NULL REFERENCES marketplace_gigs(id) ON DELETE CASCADE,
      applicant_user_id UUID NOT NULL,
      note TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      thread_id INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (marketplace_gig_id, applicant_user_id)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS marketplace_apps_gig_idx ON marketplace_applications (marketplace_gig_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS marketplace_apps_applicant_idx ON marketplace_applications (applicant_user_id, created_at DESC)`);
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
