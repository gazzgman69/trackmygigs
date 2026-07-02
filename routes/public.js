const express = require('express');
const db = require('../db');

const router = express.Router();

// Basic HTML escape for values injected into the page
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// S9-06: user.instruments can be stored as a proper text[] (returned as a JS
// array by node-postgres), a Postgres array literal string like `{Guitar,Vocal}`
// on older rows, or a legacy comma-joined string. This helper normalises all
// three to a clean `", "` display string so the EPK page never shows raw braces.
function formatInstruments(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.filter(Boolean).join(', ');
  const s = String(val).trim();
  if (!s) return '';
  if (s.startsWith('{') && s.endsWith('}')) {
    // Naive parse of `{a,"b with, comma",c}` — good enough for instrument names.
    const inner = s.slice(1, -1);
    if (!inner) return '';
    const out = [];
    let buf = '';
    let inQuotes = false;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '"' && inner[i - 1] !== '\\') { inQuotes = !inQuotes; continue; }
      if (c === ',' && !inQuotes) { out.push(buf); buf = ''; continue; }
      buf += c;
    }
    if (buf) out.push(buf);
    return out.map(x => x.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim()).filter(Boolean).join(', ');
  }
  return s;
}

// S9-04: public EPK and share pages used to render `mailto:<raw email>` into
// the HTML, which scrapers harvest for spam lists. Emit a base64-encoded
// placeholder plus a tiny inline decoder that only wires up the real mailto
// href on user interaction. Humans see a working Email button; bots see an
// opaque string. Not a security control (it's base64, not encryption), just
// enough friction to dodge naive scrapers.
function emailLink(email, subject, label, extraClasses) {
  if (!email) return '';
  const payload = Buffer.from(`mailto:${email}?subject=${encodeURIComponent(subject || '')}`).toString('base64');
  const cls = ['btn'].concat(extraClasses ? [extraClasses] : []).join(' ');
  return `<a class="${cls}" href="#" data-eb64="${payload}" onclick="try{this.href=atob(this.dataset.eb64);}catch(e){}">${esc(label)}</a>`;
}

// Shared minimal styles for public pages (standalone — no app shell)
const BASE_STYLES = `
  :root {
    --bg: #0D1117; --card: #161B22; --border: #30363D;
    --text: #F0F6FC; --text-2: #8B949E; --text-3: #6E7681;
    --accent: #F0A500; --accent-dim: rgba(240,165,0,.12);
    --success: #3FB950; --danger: #F85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh; padding: 24px 16px 48px;
  }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .sub { color: var(--text-2); font-size: 14px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  .empty { text-align: center; padding: 40px 16px; color: var(--text-2); }
  .avatar { width: 80px; height: 80px; border-radius: 40px; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 700; border: 3px solid var(--accent); margin: 0 auto 16px; }
  .foot { text-align: center; color: var(--text-3); font-size: 12px; margin-top: 40px; }
  .foot a { color: var(--accent); text-decoration: none; }
  .cal-month { font-size: 14px; font-weight: 700; color: var(--text); margin: 12px 0 6px; }
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; font-size: 12px; }
  .cal-hd { color: var(--text-3); text-align: center; font-size: 10px; padding: 4px 0; }
  .cal-cell { background: var(--card); border: 1px solid var(--border); padding: 8px 0; text-align: center; border-radius: 4px; }
  .cal-cell.booked { background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 600; }
  .cal-cell.free { background: var(--card); color: var(--text-3); }
  .cal-cell.blocked { background: #6E7681; border-color: #6E7681; color: #fff; }
  .cal-cell.past { opacity: 0.3; }
  .legend { display: flex; gap: 12px; font-size: 11px; color: var(--text-2); justify-content: center; margin: 12px 0 20px; flex-wrap: wrap; }
  .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .btn { display: inline-block; background: var(--accent); color: #000; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; font-size: 14px; margin: 4px 2px; }
  .btn-o { background: transparent; color: var(--text); border: 1px solid var(--border); }
  .media { width: 100%; border-radius: 8px; margin-bottom: 12px; }
  .row { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row .dot { width: 8px; height: 8px; border-radius: 4px; background: var(--success); flex-shrink: 0; }
  .section-label { font-size: 11px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: 1px; margin: 20px 0 6px; }
`;

// Wrap body in full HTML document with shared styles.
// `meta` is optional: { description, image, url, type, noindex } — when present,
// injects Open Graph + Twitter Card + meta description + canonical tags so the
// page previews properly when shared on WhatsApp / iMessage / socials.
function pageHtml(title, bodyHtml, meta) {
  meta = meta || {};
  const desc = meta.description || 'Live music booking and availability, powered by TrackMyGigs.';
  const image = meta.image || '';
  const url = meta.url || '';
  const type = meta.type || 'website';
  const robots = meta.noindex ? 'noindex, nofollow' : 'index, follow';

  const ogImageTag = image ? `\n  <meta property="og:image" content="${esc(image)}">` : '';
  const twImageTag = image ? `\n  <meta name="twitter:image" content="${esc(image)}">` : '';
  const ogUrlTag = url ? `\n  <meta property="og:url" content="${esc(url)}">` : '';
  const canonicalTag = url && !meta.noindex ? `\n  <link rel="canonical" href="${esc(url)}">` : '';
  const twCard = image ? 'summary_large_image' : 'summary';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="robots" content="${robots}">
  <meta name="description" content="${esc(desc)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="${esc(type)}">
  <meta property="og:site_name" content="TrackMyGigs">${ogUrlTag}${ogImageTag}
  <meta name="twitter:card" content="${twCard}">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">${twImageTag}${canonicalTag}
  <style>${BASE_STYLES}</style>
</head>
<body${meta.embed ? ' style="padding:0;"' : ''}>
  <div class="wrap"${meta.embed ? ' style="padding:8px;max-width:none;"' : ''}>${bodyHtml}</div>
  ${meta.embed ? '' : '<div class="foot">Powered by <a href="https://trackmygigs.app">TrackMyGigs</a></div>'}
</body>
</html>`;
}

// Build the fully-qualified URL for the current request so OG/canonical tags
// point at the real public URL (not the internal Replit one).
function absoluteUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host') || 'trackmygigs.app';
  return `${proto}://${host}${req.originalUrl.split('?')[0]}`;
}

// Find a user by their public_slug only. S9-01/S9-10: the previous numeric-id
// fallback allowed user enumeration (`/share/1`, `/share/2`, ...) and bypassed
// the ICS-toggle opt-in. Users must explicitly set a public_slug to expose
// their availability or EPK. If they haven't, this returns null and the page
// 404s — closing the enumeration hole.
async function findUserBySlug(slug) {
  if (!slug) return null;
  // Only honour non-numeric slugs to prevent `/share/<id>` enumeration.
  if (/^\d+$/.test(slug)) return null;
  const r = await db.query('SELECT * FROM users WHERE public_slug = $1', [slug]);
  return r.rows.length ? r.rows[0] : null;
}

// ── Public pay-link redirect (#292) ─────────────────────────────────────────
// /pay/:slug — looks up the invoice by its short public slug, increments the
// click counter, and 302s to the resolved payment URL (per-invoice override
// first, then the user's profile-level default). The slug is the only public
// identifier — the integer invoice id is never exposed.
//
// Anonymous: bookers receiving the invoice email shouldn't need to log in
// to pay. The route is rate-limited indirectly by Express's overall posture
// (no per-IP limit here, but the click-tracker is a single UPDATE so abuse
// would just inflate the per-invoice counter rather than do real damage).
//
// Failure modes:
//   - Unknown slug → 404 page
//   - Invoice exists but no pay URL is set anywhere → "not configured" page
//     so the bookee sees a useful message instead of a redirect loop.
router.get('/pay/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  // Defensive: slug is always 10 hex chars when minted by the app, but allow
  // any reasonable length so manually-pasted links don't 404 on a typo.
  if (!/^[a-f0-9]{6,32}$/i.test(slug)) {
    return res.status(404).set('Content-Type', 'text/html')
      .send(pageHtml('Pay link not found', `<div class="empty"><h1>Pay link not found</h1><p class="sub">This link looks malformed. Check the URL and try again.</p></div>`));
  }
  try {
    const r = await db.query(
      `SELECT i.id, i.payment_link_url_override, u.payment_link_url
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.public_pay_slug = $1
       LIMIT 1`,
      [slug]
    );
    if (!r.rows.length) {
      return res.status(404).set('Content-Type', 'text/html')
        .send(pageHtml('Pay link not found', `<div class="empty"><h1>Pay link not found</h1><p class="sub">This link is no longer active. The musician may have cancelled the invoice.</p></div>`));
    }
    const row = r.rows[0];
    const target = row.payment_link_url_override || row.payment_link_url || null;
    if (!target) {
      return res.status(409).set('Content-Type', 'text/html')
        .send(pageHtml('Pay link not configured', `<div class="empty"><h1>Pay link not configured</h1><p class="sub">The musician hasn&#x2019;t set up an online payment link yet. Please pay using the bank details on the invoice, or contact them directly.</p></div>`));
    }
    // Defense in depth: never redirect to anything that isn't http(s). The
    // PATCH/POST validators already enforce this on input, but a corrupted
    // row shouldn't be allowed to bounce a clicker to a javascript: URL.
    if (!/^https?:\/\//i.test(target)) {
      return res.status(409).set('Content-Type', 'text/html')
        .send(pageHtml('Pay link invalid', `<div class="empty"><h1>Pay link invalid</h1><p class="sub">Something went wrong with this link. Please contact the musician directly.</p></div>`));
    }
    // Fire-and-forget click tracking: bumping the counter must NOT block the
    // redirect. If the UPDATE fails (e.g. transient DB hiccup), the user
    // still gets to where they were going; the musician just doesn't see the
    // click event in their telemetry.
    db.query(
      `UPDATE invoices SET pay_link_clicks = pay_link_clicks + 1, pay_link_last_clicked_at = NOW() WHERE id = $1`,
      [row.id]
    ).catch((e) => console.warn('[pay] click track failed:', e && e.message));
    return res.redirect(302, target);
  } catch (err) {
    console.error('Pay link lookup error:', err);
    return res.status(500).set('Content-Type', 'text/html')
      .send(pageHtml('Pay link error', `<div class="empty"><h1>Something went wrong</h1><p class="sub">Please try again in a moment.</p></div>`));
  }
});

// ── Public availability calendar ────────────────────────────────────────────
// /share/:slug — shows the next 12 months with busy/free/blocked dates.
// Deliberately anonymous: no name, avatar, email or photo. A booker who has
// the link knows whose calendar it is; anyone who stumbles across it should
// see nothing but busy/free dates. If a musician wants to share bio, photo
// and rates, they send their /epk/:slug link separately.
// ── Testimonial submission page ──────────────────────────────────────────────
// /t/:token is sent to a client after a gig. They write a line, it lands in
// the musician's pending list, and the thank-you screen offers the Google
// review bounce (with the text pre-copied) when the musician has a review
// link configured.

router.get('/t/:token', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT tr.*, u.name AS musician_name
         FROM testimonial_requests tr JOIN users u ON u.id = tr.user_id
        WHERE tr.token = $1`,
      [req.params.token]
    );
    const reqRow = r.rows[0];
    if (!reqRow) {
      return res.status(404).set('Content-Type', 'text/html')
        .send(pageHtml('Not found', `<div class="empty"><h1>Not found</h1><p class="sub">This link is no longer active.</p></div>`));
    }
    const first = (reqRow.musician_name || 'the musician').trim();
    const body = `
      <div class="empty" style="text-align:left;max-width:460px;margin:40px auto;">
        <h1 style="font-size:22px;">How did ${esc(first)} do?</h1>
        <p class="sub" style="margin-top:8px;">A line or two about the night helps other people book with confidence. It goes to ${esc(first)} first, never straight online.</p>
        <form method="POST" action="/t/${esc(req.params.token)}">
          <textarea name="quote" required maxlength="600" placeholder="What was the night like?" style="width:100%;box-sizing:border-box;border:1px solid #444;background:#161B22;color:#E6EDF3;border-radius:8px;min-height:110px;margin-top:14px;font-size:14px;padding:12px;font-family:inherit;"></textarea>
          <input name="name" maxlength="120" placeholder="Your name" value="${esc(reqRow.client_name || '')}" style="width:100%;box-sizing:border-box;border:1px solid #444;background:#161B22;color:#E6EDF3;border-radius:8px;margin-top:10px;font-size:14px;padding:12px;">
          <div class="sub" style="margin-top:8px;">${esc(reqRow.context || '')}</div>
          <button type="submit" style="display:block;width:100%;text-align:center;background:#F0A500;color:#000;border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:700;margin-top:14px;cursor:pointer;">Send to ${esc(first)}</button>
        </form>
      </div>`;
    res.set('Content-Type', 'text/html').send(pageHtml('How did ' + (first || 'it') + ' do?', body));
  } catch (error) {
    console.error('Testimonial page error:', error);
    res.status(500).send('Something went wrong');
  }
});

router.post('/t/:token', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const r = await db.query(
      `SELECT tr.*, u.name AS musician_name, u.review_link
         FROM testimonial_requests tr JOIN users u ON u.id = tr.user_id
        WHERE tr.token = $1`,
      [req.params.token]
    );
    const reqRow = r.rows[0];
    if (!reqRow) return res.status(404).send('Not found');
    const quote = String((req.body && req.body.quote) || '').trim().slice(0, 600);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
    if (!quote) return res.redirect('/t/' + req.params.token);
    await db.query(
      `INSERT INTO testimonial_submissions (user_id, gig_id, quote, name, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [reqRow.user_id, reqRow.gig_id, quote, name || null, reqRow.context || null]
    );
    await db.query(`UPDATE testimonial_requests SET status = 'submitted' WHERE id = $1`, [reqRow.id]);
    const first = (reqRow.musician_name || 'them').trim();
    const googleBlock = reqRow.review_link ? `
      <p class="sub" style="margin-top:14px;">One more tap and it helps even more people find ${esc(first)}: paste it as a review, your words are already copied.</p>
      <a href="${esc(reqRow.review_link)}" onclick="try{navigator.clipboard.writeText(${JSON.stringify(quote)})}catch(e){}" target="_blank" rel="noopener" style="display:inline-block;margin-top:10px;background:#4285F4;color:#fff;border-radius:10px;padding:12px 20px;font-weight:700;text-decoration:none;">Open review page \u00B7 just paste &amp; pick stars</a>
      <script>try{navigator.clipboard.writeText(${JSON.stringify(quote)});}catch(e){}</script>` : '';
    const body = `
      <div class="empty" style="max-width:460px;margin:60px auto;">
        <h1>Thank you! \uD83C\uDFB6</h1>
        <p class="sub" style="margin-top:8px;">That means a lot. ${esc(first)} reads it first and chooses where it appears.</p>
        ${googleBlock}
      </div>`;
    res.set('Content-Type', 'text/html').send(pageHtml('Thank you', body));
  } catch (error) {
    console.error('Testimonial submit error:', error);
    res.status(500).send('Something went wrong');
  }
});

// ── Profile photos ───────────────────────────────────────────────────────────
// Public on purpose: these photos appear on EPKs, share pages and directory
// cards, all of which strangers can view. UUID in the path is unguessable
// enough for an avatar; cache for a day, the ?v= stamp busts on re-upload.
router.get('/pp/:userId', async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) return res.status(404).send('Not found');
    const r = await db.query(
      'SELECT photo_data, photo_mime FROM users WHERE id = $1', [req.params.userId]
    );
    const row = r.rows[0];
    if (!row || !row.photo_data) return res.status(404).send('Not found');
    res.setHeader('Content-Type', row.photo_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(row.photo_data);
  } catch (error) {
    console.error('Profile photo serve error:', error);
    res.status(500).send('Failed');
  }
});

// ── Shared document page ─────────────────────────────────────────────────────
// /docs/:token shows one document with a download button, no login. The token
// is unguessable and the owner can revoke it from the wallet at any time.

async function findSharedDocument(token) {
  if (!token || !/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
  const result = await db.query(
    `SELECT d.id, d.name, d.doc_type, d.mime_type, d.file_name, d.file_size,
            d.issued_date, d.expiry_date, d.file_data IS NOT NULL AS has_file,
            u.name AS owner_name
       FROM user_documents d
       JOIN users u ON u.id = d.user_id
      WHERE d.share_token = $1`,
    [token]
  );
  return result.rows[0] || null;
}

router.get('/docs/:token', async (req, res) => {
  try {
    const doc = await findSharedDocument(req.params.token);
    if (!doc) {
      return res.status(404).set('Content-Type', 'text/html')
        .send(pageHtml('Not found', `<div class="empty"><h1>Not found</h1><p class="sub">This link is no longer active. Ask the sender for a fresh one.</p></div>`));
    }
    const fmt = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
    const expiry = fmt(doc.expiry_date);
    const issued = fmt(doc.issued_date);
    const expired = doc.expiry_date && new Date(doc.expiry_date) < new Date();
    const body = `
      <div class="empty" style="text-align:left;max-width:460px;margin:40px auto;">
        <h1 style="font-size:22px;">${esc(doc.owner_name || 'Musician')} &middot; ${esc(doc.name)}</h1>
        <p class="sub" style="margin-top:8px;">
          ${issued ? 'Issued ' + issued + ' &middot; ' : ''}
          ${expiry ? (expired ? '<b style="color:#F85149;">Expired ' + expiry + '</b>' : 'Valid until ' + expiry) : 'No expiry date'}
        </p>
        <p class="sub">Shared via TrackMyGigs. The owner can revoke this link at any time.</p>
        ${doc.has_file
          ? `<a href="/docs/${esc(req.params.token)}/file" style="display:inline-block;margin-top:18px;background:#F0A500;color:#000;border-radius:10px;padding:12px 22px;font-weight:700;text-decoration:none;">Download ${doc.mime_type === 'application/pdf' ? 'PDF' : 'file'}</a>`
          : '<p class="sub" style="margin-top:18px;">No file attached to this document.</p>'}
      </div>`;
    res.set('Content-Type', 'text/html').send(pageHtml(esc(doc.name), body));
  } catch (error) {
    console.error('Shared doc page error:', error);
    res.status(500).send('Something went wrong');
  }
});

router.get('/docs/:token/file', async (req, res) => {
  try {
    const doc = await findSharedDocument(req.params.token);
    if (!doc || !doc.has_file) return res.status(404).send('Not found');
    const fileRes = await db.query(
      'SELECT file_data, mime_type, file_name FROM user_documents WHERE id = $1',
      [doc.id]
    );
    const row = fileRes.rows[0];
    if (!row || !row.file_data) return res.status(404).send('Not found');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    const safeName = (row.file_name || 'document').replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.send(row.file_data);
  } catch (error) {
    console.error('Shared doc file error:', error);
    res.status(500).send('Failed to fetch file');
  }
});

router.get('/share/:slug', async (req, res) => {
  try {
    const user = await findUserBySlug(req.params.slug);
    if (!user) {
      res.status(404).set('Content-Type', 'text/html').send(pageHtml('Not found', `<div class="empty"><h1>Not found</h1><p class="sub">This link is no longer active.</p></div>`));
      return;
    }

    // June 2026 mockup-gap batch: two display variants.
    //   ?times=1  — booked days also show the gig's time range, so a booker
    //               can see "busy 7pm-11pm" rather than a whole blocked day.
    //   ?embed=1  — chrome-free compact rendering for <iframe> embedding.
    const showTimes = req.query.times === '1';
    const isEmbed = req.query.embed === '1';

    // Pull next 400 days of gigs and blocked dates (~13 months, to cover any
    // partial month at the end of the 12-month window).
    const [gigsR, blockedR, personalR] = await Promise.all([
      db.query(
        `SELECT date, start_time, end_time FROM gigs
         WHERE user_id = $1 AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '400 days'`,
        [user.id]
      ),
      db.query(
        `SELECT date FROM blocked_dates
         WHERE user_id = $1 AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '400 days'`,
        [user.id]
      ).catch(() => ({ rows: [] })),
      // Personal events count toward "unavailable" on the public link, but only
      // busy ones (Free events skip), and never with any detail. Recurring master
      // rows are excluded (their instances carry the times).
      db.query(
        `SELECT all_day, start_date, end_date,
                (start_at AT TIME ZONE 'Europe/London')::date AS start_day,
                (start_at AT TIME ZONE 'Europe/London')::time AS start_local,
                (COALESCE(end_at, start_at) AT TIME ZONE 'Europe/London')::time AS end_local
           FROM personal_events
          WHERE user_id = $1 AND deleted_at IS NULL AND status != 'cancelled'
            AND is_recurring_master IS NOT TRUE
            AND transparency != 'transparent'
            AND COALESCE(start_date, (start_at AT TIME ZONE 'Europe/London')::date)
                  BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '400 days'`,
        [user.id]
      ).catch(() => ({ rows: [] })),
    ]);

    const bookedSet = new Set(gigsR.rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))));
    const blockedSet = new Set(blockedR.rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))));

    // Fold busy personal events into the unavailable (blocked) days. An all-day
    // event blocks every day it covers; a timed event blocks the day only if it
    // runs into the evening (17:00 or later), so a daytime dentist appointment
    // still leaves the evening bookable. No title or time is ever exposed.
    const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    for (const r of personalR.rows) {
      if (r.all_day) {
        const s = r.start_date ? ymd(r.start_date) : (r.start_day ? ymd(r.start_day) : null);
        if (!s) continue;
        const e = r.end_date ? ymd(r.end_date) : s;
        let cur = new Date(s + 'T00:00:00Z');
        const last = new Date(e + 'T00:00:00Z');
        let guard = 0;
        while (cur <= last && guard < 400) { blockedSet.add(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); guard++; }
      } else if (r.start_day) {
        const startLate = r.start_local && String(r.start_local) >= '17:00:00';
        const endLate = r.end_local && String(r.end_local) > '17:00:00';
        if (startLate || endLate) blockedSet.add(ymd(r.start_day));
      }
    }

    // date → "19:00–23:00" (first gig's range per day; multiple gigs join).
    const timesByDate = new Map();
    if (showTimes) {
      for (const r of gigsR.rows) {
        const key = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
        const t = [r.start_time, r.end_time].filter(Boolean).map(x => String(x).slice(0, 5));
        if (t.length === 0) continue;
        const label = t.join('–');
        timesByDate.set(key, timesByDate.has(key) ? timesByDate.get(key) + ', ' + label : label);
      }
    }

    // Build 12 months of calendar HTML (Mon-first). Headings are sticky-ish —
    // the month label sits above its grid so a long scroll still reads cleanly.
    const today = new Date();
    const monthsHtml = Array.from({ length: 12 }, (_, i) => i).map(offset => {
      const first = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      const monthLabel = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const firstDow = (first.getDay() + 6) % 7; // 0 = Mon, 6 = Sun
      let cells = '';
      cells += ['Mo','Tu','We','Th','Fr','Sa','Su'].map(d => `<div class="cal-hd">${d}</div>`).join('');
      for (let i = 0; i < firstDow; i++) cells += `<div></div>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dateObj = new Date(dateStr);
        const isPast = dateObj < new Date(today.getFullYear(), today.getMonth(), today.getDate());
        let cls = 'free';
        if (bookedSet.has(dateStr)) cls = 'booked';
        else if (blockedSet.has(dateStr)) cls = 'blocked';
        if (isPast) cls += ' past';
        const timeLabel = showTimes && timesByDate.has(dateStr) && !isPast
          ? `<div style="font-size:7px;line-height:1.1;opacity:.85;white-space:nowrap;overflow:hidden;">${esc(timesByDate.get(dateStr))}</div>`
          : '';
        // Book-me funnel: free future days are tappable and open the enquiry
        // form with the date preselected.
        const enquireAttr = (cls === 'free' && !isPast) ? ` onclick="enqOpen('${dateStr}')" style="cursor:pointer;"` : '';
        cells += `<div class="cal-cell ${cls}"${enquireAttr}${showTimes && timesByDate.has(dateStr) ? ` title="Booked ${esc(timesByDate.get(dateStr))}"` : ''}>${d}${timeLabel}</div>`;
      }
      return `<div class="cal-month">${esc(monthLabel)}</div><div class="cal-grid">${cells}</div>`;
    }).join('');

    const toggleHref = `/share/${esc(req.params.slug)}${showTimes ? '' : '?times=1'}`;
    const toggleLink = isEmbed ? '' : `
      <p style="text-align:center;margin:4px 0 12px;">
        <a href="${toggleHref}" style="font-size:12px;color:#F0A500;text-decoration:none;">${showTimes ? 'Hide gig times (free/busy only)' : 'Show gig times on booked days'}</a>
      </p>`;
    const body = `
      ${isEmbed ? '' : '<h1 style="text-align:center;">Availability</h1>\n      <p class="sub" style="text-align:center;">Next 12 months</p>'}
      ${toggleLink}
      <div class="legend">
        <span><span class="legend-dot" style="background:var(--card);border:1px solid var(--border);"></span>Free</span>
        <span><span class="legend-dot" style="background:var(--danger);"></span>Booked</span>
        <span><span class="legend-dot" style="background:#6E7681;"></span>Unavailable</span>
      </div>
      <p style="text-align:center;font-size:12px;color:#F0A500;margin:0 0 12px;">Tap a free day to request it</p>
      <div class="card">${monthsHtml}</div>
      <div id="enqOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;align-items:flex-end;justify-content:center;">
        <div style="background:#161B22;border-top:1px solid #30363D;border-radius:16px 16px 0 0;padding:18px 16px 26px;width:100%;max-width:480px;">
          <div id="enqFormWrap">
            <div style="font-size:16px;font-weight:700;color:#E6EDF3;margin-bottom:2px;">Request this date</div>
            <div id="enqDateLabel" style="font-size:13px;color:#F0A500;font-weight:600;margin-bottom:12px;"></div>
            <input id="enqName" placeholder="Your name" maxlength="100" style="width:100%;box-sizing:border-box;background:#0D1117;color:#E6EDF3;border:1px solid #30363D;border-radius:10px;padding:11px 12px;font-size:14px;margin-bottom:8px;">
            <input id="enqEmail" type="email" placeholder="Email" maxlength="200" style="width:100%;box-sizing:border-box;background:#0D1117;color:#E6EDF3;border:1px solid #30363D;border-radius:10px;padding:11px 12px;font-size:14px;margin-bottom:8px;">
            <input id="enqPhone" type="tel" placeholder="Phone (optional)" maxlength="30" style="width:100%;box-sizing:border-box;background:#0D1117;color:#E6EDF3;border:1px solid #30363D;border-radius:10px;padding:11px 12px;font-size:14px;margin-bottom:8px;">
            <select id="enqType" style="width:100%;box-sizing:border-box;background:#0D1117;color:#E6EDF3;border:1px solid #30363D;border-radius:10px;padding:11px 12px;font-size:14px;margin-bottom:8px;">
              <option>Wedding</option><option>Corporate</option><option>Private party</option><option>Pub / Club</option><option>Festival</option><option>Other</option>
            </select>
            <textarea id="enqMsg" placeholder="Tell them about your event (venue, times, what you need)" maxlength="1000" rows="3" style="width:100%;box-sizing:border-box;background:#0D1117;color:#E6EDF3;border:1px solid #30363D;border-radius:10px;padding:11px 12px;font-size:14px;margin-bottom:12px;resize:vertical;font-family:inherit;"></textarea>
            <div id="enqErr" style="display:none;font-size:12px;color:#F85149;margin-bottom:8px;"></div>
            <button onclick="enqSend()" id="enqSendBtn" style="width:100%;background:#F0A500;color:#000;border:none;border-radius:12px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;">Send request</button>
            <button onclick="enqClose()" style="width:100%;margin-top:8px;background:transparent;border:1px solid #30363D;color:#8B949E;border-radius:12px;padding:11px;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
          </div>
          <div id="enqDone" style="display:none;text-align:center;padding:14px 0 6px;">
            <div style="font-size:34px;margin-bottom:8px;">&#127881;</div>
            <div style="font-size:16px;font-weight:700;color:#E6EDF3;margin-bottom:4px;">Request sent</div>
            <div style="font-size:13px;color:#8B949E;margin-bottom:14px;">The date is pencilled in as an enquiry. You'll hear back soon.</div>
            <button onclick="enqClose()" style="width:100%;background:#F0A500;color:#000;border:none;border-radius:12px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;">Done</button>
          </div>
        </div>
      </div>
      <script>
        var enqDate = null;
        function enqOpen(d) {
          enqDate = d;
          var dt = new Date(d + 'T00:00:00');
          document.getElementById('enqDateLabel').textContent = dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
          document.getElementById('enqFormWrap').style.display = 'block';
          document.getElementById('enqDone').style.display = 'none';
          document.getElementById('enqErr').style.display = 'none';
          document.getElementById('enqOverlay').style.display = 'flex';
        }
        function enqClose() { document.getElementById('enqOverlay').style.display = 'none'; }
        document.getElementById('enqOverlay').addEventListener('click', function (e) { if (e.target === this) enqClose(); });
        async function enqSend() {
          var err = document.getElementById('enqErr');
          var name = document.getElementById('enqName').value.trim();
          var email = document.getElementById('enqEmail').value.trim();
          var phone = document.getElementById('enqPhone').value.trim();
          if (!name) { err.textContent = 'Add your name so they know who is asking.'; err.style.display = 'block'; return; }
          if (!email && !phone) { err.textContent = 'Add an email or phone so they can reply.'; err.style.display = 'block'; return; }
          var btn = document.getElementById('enqSendBtn');
          btn.disabled = true; btn.textContent = 'Sending...';
          try {
            var r = await fetch(window.location.pathname.replace(/\\/$/, '') + '/enquire', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ date: enqDate, name: name, email: email, phone: phone, event_type: document.getElementById('enqType').value, message: document.getElementById('enqMsg').value.trim() })
            });
            var j = await r.json().catch(function () { return {}; });
            if (!r.ok) { err.textContent = j.error || 'Could not send. Try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Send request'; return; }
            document.getElementById('enqFormWrap').style.display = 'none';
            document.getElementById('enqDone').style.display = 'block';
          } catch (e) {
            err.textContent = 'Could not send. Try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Send request';
          }
        }
      </script>`;

    // Anonymous OG: no name, no image, noindex so the link doesn't leak into
    // search engines. Bookers get a generic preview card when the link is
    // pasted into iMessage / WhatsApp.
    res.set('Content-Type', 'text/html').send(pageHtml('Availability', body, {
      description: 'Live availability for the next 12 months.',
      noindex: true,
      embed: isEmbed,
    }));
  } catch (err) {
    console.error('Public share error:', err);
    res.status(500).set('Content-Type', 'text/html').send(pageHtml('Error', `<div class="empty"><h1>Something went wrong</h1><p class="sub">Please try again.</p></div>`));
  }
});

// ── Book-me funnel: date enquiry from the public share page ─────────────────
// POST /share/:slug/enquire — a booker requests an open date. Lands as an
// enquiry-status gig holding the date (client contact on the gig row, message
// in the notes) and fires an email to the musician. Per-slug+IP throttle keeps
// drive-by abuse from flooding a diary.
const _enquiryHits = new Map();
function _enquiryThrottled(key) {
  const now = Date.now();
  const hits = (_enquiryHits.get(key) || []).filter(t => now - t < 3600000);
  if (hits.length >= 5) return true;
  hits.push(now);
  _enquiryHits.set(key, hits);
  if (_enquiryHits.size > 5000) _enquiryHits.clear();
  return false;
}

router.post('/share/:slug/enquire', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const user = await findUserBySlug(req.params.slug);
    if (!user) return res.status(404).json({ error: 'This link is no longer active.' });

    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (_enquiryThrottled(`${req.params.slug}|${ip}`)) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }

    const name = String(req.body.name || '').trim().slice(0, 100);
    const email = String(req.body.email || '').trim().slice(0, 200);
    const phone = String(req.body.phone || '').trim().slice(0, 30);
    const message = String(req.body.message || '').trim().slice(0, 1000);
    const date = String(req.body.date || '').slice(0, 10);
    const EVENT_TYPES = ['Wedding', 'Corporate', 'Private party', 'Pub / Club', 'Festival', 'Other'];
    const eventType = EVENT_TYPES.includes(req.body.event_type) ? req.body.event_type : 'Other';

    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!email && !phone) return res.status(400).json({ error: 'An email or phone number is required.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email does not look right.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Pick a date.' });
    const todayIso = new Date().toISOString().slice(0, 10);
    const maxIso = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    if (date < todayIso || date > maxIso) return res.status(400).json({ error: 'That date is out of range.' });

    // The date must still be open: no gig on it, not blocked. (Personal-event
    // evening nuance deliberately skipped; the musician triages the enquiry.)
    const clash = await db.query(
      `SELECT 1 FROM gigs WHERE user_id = $1 AND date = $2 AND status <> 'cancelled'
       UNION ALL
       SELECT 1 FROM blocked_dates WHERE user_id = $1 AND date = $2 LIMIT 1`,
      [user.id, date]
    );
    if (clash.rows.length > 0) return res.status(409).json({ error: 'That date has just been taken. Pick another.' });

    const ins = await db.query(
      `INSERT INTO gigs (user_id, band_name, date, status, source, client_name, client_email, client_phone, notes)
       VALUES ($1, $2, $3, 'enquiry', 'share-page', $4, $5, $6, $7)
       RETURNING id`,
      [user.id, `${eventType} — ${name}`, date, name, email || null, phone || null,
       message ? `Enquiry message:\n${message}` : null]
    );

    // Fire-and-forget notification; the in-app needs-you chip is the backstop.
    try {
      const { sendEmail, APP_NAME } = require('../lib/email');
      const prettyDate = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      sendEmail({
        to: user.email,
        subject: `New date enquiry: ${eventType} on ${prettyDate}`,
        text: `${name} has requested ${prettyDate} via your availability page.\n\nEvent: ${eventType}\nContact: ${[email, phone].filter(Boolean).join(' / ')}\n${message ? `\nMessage:\n${message}\n` : ''}\nThe date is held as an enquiry in your diary. Open ${APP_NAME} to confirm or decline.`,
      }).catch((e) => console.warn('[enquire] notify email failed (non-fatal):', e.message));
    } catch (_) {}

    res.json({ success: true, id: ins.rows[0].id });
  } catch (err) {
    console.error('Share enquiry error:', err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// ── Public "next gig" widget ────────────────────────────────────────────────
// /share/:slug/next-gig — single-card page showing the artist's next confirmed
// gig. Designed to be dropped into an email signature, link-in-bio, or sent
// directly to a venue/booker who wants to know when they can catch the act.
// Shows: artist name, photo, gig date + time, venue name, optional address.
// Hides: fees, personal contact info, notes, anything else. Privacy default
// is "next single confirmed future gig only" — never the full diary.
//
// Includes an "Add to calendar" download (.ics) so the recipient can pin
// the date in their own calendar with one tap. Open Graph tags give nice
// link previews when shared on WhatsApp / iMessage / socials.
router.get('/share/:slug/next-gig', async (req, res) => {
  try {
    const user = await findUserBySlug(req.params.slug);
    if (!user) {
      res.status(404).set('Content-Type', 'text/html').send(pageHtml('Not found', `<div class="empty"><h1>Not found</h1><p class="sub">This link is no longer active.</p></div>`));
      return;
    }

    const gigR = await db.query(
      `SELECT id, date, start_time, end_time, venue_name, venue_address, band_name
         FROM gigs
        WHERE user_id = $1
          AND status = 'confirmed'
          AND date >= CURRENT_DATE
        ORDER BY date ASC, start_time ASC NULLS LAST
        LIMIT 1`,
      [user.id]
    );

    const displayName = user.display_name || user.name || 'This musician';
    const photoUrl = user.epk_photo_url || user.avatar_url || '';
    const initial = (displayName || 'M').charAt(0).toUpperCase();
    const avatarHtml = photoUrl
      ? `<img class="avatar" src="${esc(photoUrl)}" alt="" style="object-fit:cover;border-radius:40px;width:80px;height:80px;" />`
      : `<div class="avatar">${esc(initial)}</div>`;

    let body;
    if (gigR.rows.length === 0) {
      body = `
        ${avatarHtml}
        <h1 style="text-align:center;">${esc(displayName)}</h1>
        <p class="sub" style="text-align:center;">No public gigs on the diary right now.</p>
        <div class="empty">
          <p>${esc(displayName)} hasn&#x2019;t got a confirmed gig coming up. Check back soon.</p>
        </div>`;
      res.set('Content-Type', 'text/html').send(pageHtml(displayName + " - Next gig", body, {
        description: 'No upcoming public gigs.',
        url: absoluteUrl(req),
        noindex: true,
      }));
      return;
    }

    const g = gigR.rows[0];
    const gigDate = g.date instanceof Date ? g.date.toISOString().slice(0, 10) : String(g.date).slice(0, 10);
    const dateObj = new Date(gigDate + 'T12:00:00');
    const dateLabel = dateObj.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const timePart = g.start_time
      ? String(g.start_time).slice(0, 5) + (g.end_time ? ' to ' + String(g.end_time).slice(0, 5) : '')
      : '';
    const venuePart = g.venue_name || g.band_name || 'Venue to be announced';
    const addressPart = g.venue_address && g.venue_address !== g.venue_name ? g.venue_address : '';

    // Google Maps universal link for the venue. Falls back to a search by
    // venue name when no address is set.
    const mapsQuery = encodeURIComponent(addressPart || venuePart);
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;

    body = `
      ${avatarHtml}
      <h1 style="text-align:center;">${esc(displayName)}</h1>
      <p class="sub" style="text-align:center;">Next public gig</p>
      <div class="card" style="text-align:center;padding:24px 16px;">
        <div style="font-size:11px;font-weight:700;color:var(--accent);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">${esc(dateLabel.split(',')[0])}</div>
        <div style="font-size:24px;font-weight:800;color:var(--text);margin-bottom:6px;letter-spacing:-.3px;">${esc(dateLabel.split(',').slice(1).join(',').trim())}</div>
        ${timePart ? `<div style="font-size:14px;color:var(--text-2);margin-bottom:14px;">${esc(timePart)}</div>` : '<div style="margin-bottom:14px;"></div>'}
        <div style="border-top:1px solid var(--border);padding-top:14px;">
          <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px;">${esc(venuePart)}</div>
          ${addressPart ? `<div style="font-size:13px;color:var(--text-2);margin-bottom:14px;">${esc(addressPart)}</div>` : '<div style="margin-bottom:14px;"></div>'}
          <a class="btn" href="/share/${esc(req.params.slug)}/next-gig.ics" download="trackmygigs-${esc(req.params.slug)}.ics">Add to calendar</a>
          <a class="btn btn-o" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Maps</a>
        </div>
      </div>
      <p class="sub" style="text-align:center;font-size:12px;margin-top:16px;">Want to see the full diary? <a href="/share/${esc(req.params.slug)}" style="color:var(--accent);text-decoration:none;">View availability</a></p>`;

    res.set('Content-Type', 'text/html').send(pageHtml(`${displayName} - ${venuePart} - ${dateLabel}`, body, {
      description: `${displayName} live at ${venuePart} on ${dateLabel}${timePart ? ' at ' + timePart : ''}.`,
      image: photoUrl || '',
      url: absoluteUrl(req),
      noindex: false, // Public-by-design; let it index for SEO
    }));
  } catch (err) {
    console.error('Public next-gig error:', err);
    res.status(500).set('Content-Type', 'text/html').send(pageHtml('Error', `<div class="empty"><h1>Something went wrong</h1><p class="sub">Please try again.</p></div>`));
  }
});

// /share/:slug/next-gig.ics — RFC5545 calendar download for the next gig.
// One VEVENT, no recurrence, no alarms. Same privacy rules as the HTML view.
router.get('/share/:slug/next-gig.ics', async (req, res) => {
  try {
    const user = await findUserBySlug(req.params.slug);
    if (!user) return res.status(404).send('Not found');

    const gigR = await db.query(
      `SELECT id, date, start_time, end_time, venue_name, venue_address, band_name
         FROM gigs
        WHERE user_id = $1
          AND status = 'confirmed'
          AND date >= CURRENT_DATE
        ORDER BY date ASC, start_time ASC NULLS LAST
        LIMIT 1`,
      [user.id]
    );
    if (gigR.rows.length === 0) return res.status(404).send('No upcoming gigs');

    const g = gigR.rows[0];
    const displayName = user.display_name || user.name || 'Musician';
    const gigDate = g.date instanceof Date ? g.date.toISOString().slice(0, 10) : String(g.date).slice(0, 10);

    function icsDateTime(dateStr, timeStr) {
      // Local floating time (no Z, no TZID) so the recipient's calendar
      // interprets it in their local time. iCal-compatible.
      const d = dateStr.replace(/-/g, '');
      if (!timeStr) return d;
      const t = String(timeStr).replace(/:/g, '').slice(0, 6).padEnd(6, '0');
      return `${d}T${t}`;
    }
    function icsEscape(s) {
      return String(s || '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
    }

    const dtStart = icsDateTime(gigDate, g.start_time);
    const dtEnd = icsDateTime(gigDate, g.end_time || g.start_time || '');
    const isAllDay = !g.start_time;
    const summary = icsEscape(`${displayName} live${g.venue_name ? ' at ' + g.venue_name : ''}`);
    const location = icsEscape(g.venue_address || g.venue_name || '');
    const description = icsEscape(`Powered by TrackMyGigs - https://trackmygigs.app/share/${req.params.slug}/next-gig`);
    const uid = `${g.id}@trackmygigs.app`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TrackMyGigs//Next gig widget//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      isAllDay ? `DTSTART;VALUE=DATE:${dtStart}` : `DTSTART:${dtStart}`,
      isAllDay ? `DTEND;VALUE=DATE:${dtEnd}` : `DTEND:${dtEnd}`,
      `SUMMARY:${summary}`,
      location ? `LOCATION:${location}` : null,
      `DESCRIPTION:${description}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="trackmygigs-next-gig.ics"`);
    res.send(lines);
  } catch (err) {
    console.error('Public next-gig.ics error:', err);
    res.status(500).send('Error generating calendar file');
  }
});

// ── Private iCal subscribe feed ──────────────────────────────────────────────
// /calendar-feed/<token>.ics — token-authed personal feed for Apple Calendar,
// Outlook, or anything that subscribes to iCal URLs. Carries the musician's
// gigs in full plus blocked dates and busy personal events as opaque "Busy"
// blocks. Free tier (Gigflow Pro-gates its one-way feed). The token is a
// per-user secret; a leaked URL is revocable via regenerate in Settings.
router.get('/calendar-feed/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').replace(/\.ics$/i, '');
    if (!/^[a-f0-9]{24,64}$/.test(token)) return res.status(404).send('Not found');
    const uR = await db.query(
      'SELECT id, display_name, name FROM users WHERE ical_feed_token = $1',
      [token]
    );
    if (uR.rows.length === 0) return res.status(404).send('Not found');
    const user = uR.rows[0];

    const [gigsR, blockedR, personalR] = await Promise.all([
      db.query(
        `SELECT id, date::text AS date, start_time, end_time, venue_name,
                venue_address, band_name, fee, status
           FROM gigs
          WHERE user_id = $1 AND status <> 'cancelled'
            AND date >= CURRENT_DATE - INTERVAL '30 days'
            AND date <= CURRENT_DATE + INTERVAL '400 days'
          ORDER BY date ASC`,
        [user.id]
      ),
      db.query('SELECT * FROM blocked_dates WHERE user_id = $1', [user.id]),
      // Opaque busy blocks only: times, never titles or details.
      db.query(
        `SELECT id, all_day, start_date::text AS sd,
                COALESCE(end_date, start_date)::text AS ed,
                to_char(start_at AT TIME ZONE 'Europe/London', 'YYYYMMDD"T"HH24MISS') AS s_local,
                to_char(COALESCE(end_at, start_at) AT TIME ZONE 'Europe/London', 'YYYYMMDD"T"HH24MISS') AS e_local
           FROM personal_events
          WHERE user_id = $1 AND deleted_at IS NULL AND status <> 'cancelled'
            AND is_recurring_master IS NOT TRUE
            AND transparency <> 'transparent'
            AND COALESCE(start_date, (start_at AT TIME ZONE 'Europe/London')::date)
                BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE + 400`,
        [user.id]
      ),
    ]);

    const { expandBlockedRow } = require('./api');
    const displayName = user.display_name || user.name || 'TrackMyGigs';
    const icsEsc = (s) => String(s || '')
      .replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const ymd = (s) => String(s).slice(0, 10).replace(/-/g, '');
    const nextDay = (dateStr) => {
      const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TrackMyGigs//Calendar feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsEsc(displayName + ' - gigs')}`,
      'X-PUBLISHED-TTL:PT1H',
    ];
    const pushEvent = (uid, dtLines, summary, extra) => {
      lines.push('BEGIN:VEVENT', `UID:${uid}@trackmygigs.app`, `DTSTAMP:${stamp}`, ...dtLines, `SUMMARY:${icsEsc(summary)}`);
      (extra || []).forEach((l) => l && lines.push(l));
      lines.push('END:VEVENT');
    };

    for (const g of gigsR.rows) {
      const title = g.band_name || g.venue_name || 'Gig';
      const descBits = [];
      if (g.fee != null && g.fee !== '') descBits.push(`Fee: £${g.fee}`);
      if (g.status) descBits.push(g.status);
      const dt = g.start_time
        ? [`DTSTART:${ymd(g.date)}T${String(g.start_time).replace(/:/g, '').slice(0, 6).padEnd(6, '0')}`,
           `DTEND:${ymd(g.date)}T${String(g.end_time || g.start_time).replace(/:/g, '').slice(0, 6).padEnd(6, '0')}`]
        : [`DTSTART;VALUE=DATE:${ymd(g.date)}`, `DTEND;VALUE=DATE:${nextDay(g.date)}`];
      pushEvent(`gig-${g.id}`, dt, title, [
        (g.venue_address || g.venue_name) ? `LOCATION:${icsEsc(g.venue_address || g.venue_name)}` : null,
        descBits.length ? `DESCRIPTION:${icsEsc(descBits.join(' · '))}` : null,
      ]);
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const maxIso = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    for (const row of blockedR.rows) {
      for (const d of expandBlockedRow(row)) {
        if (d < todayIso || d > maxIso) continue;
        pushEvent(`blocked-${row.id}-${d}`, [`DTSTART;VALUE=DATE:${ymd(d)}`, `DTEND;VALUE=DATE:${nextDay(d)}`], 'Busy', ['TRANSP:OPAQUE']);
      }
    }

    for (const p of personalR.rows) {
      const dt = p.all_day
        ? [`DTSTART;VALUE=DATE:${ymd(p.sd)}`, `DTEND;VALUE=DATE:${nextDay(p.ed)}`]
        : [`DTSTART:${p.s_local}`, `DTEND:${p.e_local}`];
      pushEvent(`pe-${p.id}`, dt, 'Busy', ['TRANSP:OPAQUE']);
    }

    lines.push('END:VCALENDAR');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('iCal feed error:', err);
    res.status(500).send('Error generating feed');
  }
});

// ── Public EPK (Electronic Press Kit) ────────────────────────────────────────
// /epk/:slug — artist bio, photo, video/audio links, recent gigs
router.get('/epk/:slug', async (req, res) => {
  try {
    const user = await findUserBySlug(req.params.slug);
    if (!user) {
      res.status(404).set('Content-Type', 'text/html').send(pageHtml('Not found', `<div class="empty"><h1>Not found</h1><p class="sub">This link is no longer active.</p></div>`));
      return;
    }

    const displayName = user.display_name || user.name || 'Artist';
    const bio = user.epk_bio || '';
    const photoUrl = user.epk_photo_url || user.avatar_url || '';
    const videoUrl = user.epk_video_url || '';
    const audioUrl = user.epk_audio_url || '';

    // Recent played gigs — social proof
    const recentR = await db.query(
      `SELECT date, venue_name FROM gigs
       WHERE user_id = $1 AND date < CURRENT_DATE
       ORDER BY date DESC LIMIT 6`,
      [user.id]
    );

    const instruments = formatInstruments(user.instruments);

    // Rate card (all optional; show the section only if at least one value is set)
    const rateStandard = user.rate_standard != null ? Number(user.rate_standard) : null;
    const ratePremium = user.rate_premium != null ? Number(user.rate_premium) : null;
    const rateDep = user.rate_dep != null ? Number(user.rate_dep) : null;
    const rateDepositPct = user.rate_deposit_pct != null ? Number(user.rate_deposit_pct) : null;
    const rateNotes = user.rate_notes || '';
    const hasRateCard = rateStandard != null || ratePremium != null || rateDep != null || rateDepositPct != null || rateNotes;
    const gbp = (n) => '\u00a3' + (Math.round(Number(n) * 100) / 100).toFixed(2).replace(/\.00$/, '');
    const rateRow = (label, value, note) => `<div class="row"><div style="flex:1;"><div>${esc(label)}</div>${note ? `<div style="color:var(--text-3);font-size:12px;">${esc(note)}</div>` : ''}</div><div style="font-weight:700;color:var(--accent);">${value}</div></div>`;
    const rateCardHtml = hasRateCard
      ? `<div class="section-label">Rates</div><div class="card">
          ${rateStandard != null ? rateRow('Standard rate', gbp(rateStandard), 'Typical booking') : ''}
          ${ratePremium != null ? rateRow('Premium rate', gbp(ratePremium), 'Weekends, peak season, black-tie') : ''}
          ${rateDep != null ? rateRow('Dep rate', gbp(rateDep), 'When depping with another band') : ''}
          ${rateDepositPct != null ? rateRow('Deposit', rateDepositPct + '%', 'Payable on booking to secure the date') : ''}
          ${rateNotes ? `<div style="padding:10px 0;color:var(--text-2);font-size:13px;line-height:1.5;white-space:pre-wrap;">${esc(rateNotes)}</div>` : ''}
        </div>`
      : '';

    let videoEmbed = '';
    if (videoUrl) {
      // Try to extract a YouTube/Vimeo ID for an iframe; otherwise just link it
      const yt = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
      const vimeo = videoUrl.match(/vimeo\.com\/(\d+)/);
      if (yt) {
        videoEmbed = `<div class="card"><iframe class="media" style="aspect-ratio:16/9;border:0;" src="https://www.youtube.com/embed/${esc(yt[1])}" allowfullscreen></iframe></div>`;
      } else if (vimeo) {
        videoEmbed = `<div class="card"><iframe class="media" style="aspect-ratio:16/9;border:0;" src="https://player.vimeo.com/video/${esc(vimeo[1])}" allowfullscreen></iframe></div>`;
      } else {
        videoEmbed = `<div class="card"><a class="btn btn-o" href="${esc(videoUrl)}" target="_blank" rel="noopener">Watch video</a></div>`;
      }
    }

    const body = `
      ${photoUrl
        ? `<img class="media" src="${esc(photoUrl)}" alt="${esc(displayName)}" style="max-height:300px;object-fit:cover;">`
        : `<div class="avatar">${esc((displayName[0] || 'M').toUpperCase())}</div>`}
      <h1 style="text-align:center;">${esc(displayName)}</h1>
      ${instruments ? `<p class="sub" style="text-align:center;">${esc(instruments)}</p>` : `<p class="sub" style="text-align:center;">Live music</p>`}

      ${bio ? `<div class="section-label">About</div><div class="card" style="white-space:pre-wrap;">${esc(bio)}</div>` : ''}

      ${videoEmbed ? `<div class="section-label">Video</div>${videoEmbed}` : ''}

      ${audioUrl ? `<div class="section-label">Listen</div><div class="card"><audio class="media" controls src="${esc(audioUrl)}"></audio></div>` : ''}

      ${(() => {
        const gallery = Array.isArray(user.epk_gallery) ? user.epk_gallery.filter(u => /^https?:\/\//i.test(String(u))) : [];
        if (gallery.length === 0) return '';
        return `<div class="section-label">Gallery</div>
          <div class="card" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;">
            ${gallery.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Gallery photo" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;display:block;"></a>`).join('')}
          </div>`;
      })()}

      ${(() => {
        const quotes = Array.isArray(user.epk_testimonials) ? user.epk_testimonials.filter(t => t && t.quote) : [];
        if (quotes.length === 0) return '';
        return `<div class="section-label">What people say</div>
          <div class="card">
            ${quotes.map(t => `<div style="padding:10px 0;border-bottom:1px solid var(--border);">
              <div style="font-size:14px;line-height:1.5;font-style:italic;">“${esc(t.quote)}”</div>
              ${t.author ? `<div style="color:var(--text-3);font-size:12px;margin-top:4px;">— ${esc(t.author)}</div>` : ''}
            </div>`).join('')}
          </div>`;
      })()}

      ${rateCardHtml}

      ${recentR.rows.length
        ? `<div class="section-label">Recent performances</div><div class="card">${recentR.rows.map(r => {
            const d = (r.date instanceof Date ? r.date : new Date(r.date)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            return `<div class="row"><div class="dot"></div><div style="flex:1;"><div>${esc(r.venue_name || 'Performance')}</div><div style="color:var(--text-3);font-size:12px;">${esc(d)}</div></div></div>`;
          }).join('')}</div>`
        : ''}

      <div class="section-label">Book</div>
      <div class="card" style="text-align:center;">
        ${emailLink(user.email, 'Booking enquiry for ' + displayName, 'Email to book')}
        <a class="btn btn-o" href="/share/${esc(user.public_slug || user.id)}">See availability</a>
      </div>`;

    // Build a concise OG description. Prefer a trimmed bio; otherwise a sensible default.
    const epkDesc = (bio && bio.trim())
      ? bio.trim().replace(/\s+/g, ' ').slice(0, 200)
      : `${displayName}${instruments ? ' - ' + instruments : ''}. Bio, video, audio, rates and availability.`;

    res.set('Content-Type', 'text/html').send(pageHtml(`${displayName} | Electronic Press Kit`, body, {
      description: epkDesc,
      image: photoUrl || '',
      url: absoluteUrl(req),
      type: 'profile',
    }));
  } catch (err) {
    console.error('Public EPK error:', err);
    res.status(500).set('Content-Type', 'text/html').send(pageHtml('Error', `<div class="empty"><h1>Something went wrong</h1><p class="sub">Please try again.</p></div>`));
  }
});

module.exports = router;
