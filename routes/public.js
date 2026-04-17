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

// Wrap body in full HTML document with shared styles
function pageHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="robots" content="index, follow">
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="wrap">${bodyHtml}</div>
  <div class="foot">Powered by <a href="https://trackmygigs.app">TrackMyGigs</a></div>
</body>
</html>`;
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

// ── Public availability calendar ────────────────────────────────────────────
// /share/:slug — shows the next ~3 months with busy/free/blocked dates
router.get('/share/:slug', async (req, res) => {
  try {
    const user = await findUserBySlug(req.params.slug);
    if (!user) {
      res.status(404).set('Content-Type', 'text/html').send(pageHtml('Not found', `<div class="empty"><h1>Not found</h1><p class="sub">This link is no longer active.</p></div>`));
      return;
    }

    const displayName = user.display_name || user.name || 'Artist';

    // Pull next 120 days of gigs and blocked dates
    const [gigsR, blockedR] = await Promise.all([
      db.query(
        `SELECT date FROM gigs
         WHERE user_id = $1 AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '120 days'`,
        [user.id]
      ),
      db.query(
        `SELECT date FROM blocked_dates
         WHERE user_id = $1 AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '120 days'`,
        [user.id]
      ).catch(() => ({ rows: [] })),
    ]);

    const bookedSet = new Set(gigsR.rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))));
    const blockedSet = new Set(blockedR.rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))));

    // Build 3 months of calendar HTML (Mon-first)
    const today = new Date();
    const monthsHtml = [0, 1, 2].map(offset => {
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
        cells += `<div class="cal-cell ${cls}">${d}</div>`;
      }
      return `<div class="cal-month">${esc(monthLabel)}</div><div class="cal-grid">${cells}</div>`;
    }).join('');

    const body = `
      <div class="avatar">${esc((displayName[0] || 'M').toUpperCase())}</div>
      <h1 style="text-align:center;">${esc(displayName)}</h1>
      <p class="sub" style="text-align:center;">Availability &mdash; next 3 months</p>
      <div class="legend">
        <span><span class="legend-dot" style="background:var(--card);border:1px solid var(--border);"></span>Free</span>
        <span><span class="legend-dot" style="background:var(--danger);"></span>Booked</span>
        <span><span class="legend-dot" style="background:#6E7681;"></span>Unavailable</span>
      </div>
      <div class="card">${monthsHtml}</div>
      ${user.epk_bio || user.epk_photo_url ? `<div style="text-align:center;"><a class="btn btn-o" href="/epk/${esc(user.public_slug || user.id)}">View full EPK</a></div>` : ''}
      <div style="text-align:center;margin-top:20px;">
        <a class="btn" href="mailto:${esc(user.email || '')}?subject=${encodeURIComponent('Gig enquiry for ' + displayName)}">Enquire about a date</a>
      </div>`;

    res.set('Content-Type', 'text/html').send(pageHtml(`${displayName} Availability`, body));
  } catch (err) {
    console.error('Public share error:', err);
    res.status(500).set('Content-Type', 'text/html').send(pageHtml('Error', `<div class="empty"><h1>Something went wrong</h1><p class="sub">Please try again.</p></div>`));
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

    const instruments = Array.isArray(user.instruments) ? user.instruments.join(', ') : (user.instruments || '');

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

      ${rateCardHtml}

      ${recentR.rows.length
        ? `<div class="section-label">Recent performances</div><div class="card">${recentR.rows.map(r => {
            const d = (r.date instanceof Date ? r.date : new Date(r.date)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            return `<div class="row"><div class="dot"></div><div style="flex:1;"><div>${esc(r.venue_name || 'Performance')}</div><div style="color:var(--text-3);font-size:12px;">${esc(d)}</div></div></div>`;
          }).join('')}</div>`
        : ''}

      <div class="section-label">Book</div>
      <div class="card" style="text-align:center;">
        <a class="btn" href="mailto:${esc(user.email || '')}?subject=${encodeURIComponent('Booking enquiry for ' + displayName)}">Email to book</a>
        <a class="btn btn-o" href="/share/${esc(user.public_slug || user.id)}">See availability</a>
      </div>`;

    res.set('Content-Type', 'text/html').send(pageHtml(`${displayName} EPK`, body));
  } catch (err) {
    console.error('Public EPK error:', err);
    res.status(500).set('Content-Type', 'text/html').send(pageHtml('Error', `<div class="empty"><h1>Something went wrong</h1><p class="sub">Please try again.</p></div>`));
  }
});

// ── Public calendar feed (token-gated) ───────────────────────────────────────
// /cal/:token — friendly HTML calendar (like /share/:slug but token-based)
// /cal/:token.ics — RFC 5545 ICS feed for subscribe-in-calendar-app

async function findUserByShareToken(token) {
  if (!token) return null;
  const r = await db.query(
    'SELECT * FROM users WHERE share_token = $1 AND share_token_enabled = true',
    [token]
  );
  return r.rows[0] || null;
}

function escIcs(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function pad(n) { return String(n).padStart(2, '0'); }

function toIcsDate(date, time) {
  // date is a JS Date or yyyy-mm-dd; time is "HH:MM" or null
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  if (!time) {
    return { value: `${y}${m}${day}`, allDay: true };
  }
  const [hh, mm] = String(time).split(':');
  return { value: `${y}${m}${day}T${pad(hh || 0)}${pad(mm || 0)}00`, allDay: false };
}

router.get('/cal/:token.ics', async (req, res) => {
  try {
    const user = await findUserByShareToken(req.params.token);
    if (!user) return res.status(404).type('text/plain').send('Not found');

    const gigsR = await db.query(
      `SELECT id, date, start_time, end_time, venue_name FROM gigs
       WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days' AND date <= CURRENT_DATE + INTERVAL '365 days'
       ORDER BY date ASC`,
      [user.id]
    );

    const stamp = new Date();
    const dtstamp = `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}T${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}Z`;

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TrackMyGigs//Availability Feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escIcs((user.display_name || user.name || 'Artist') + ' - Busy')}`,
      'X-PUBLISHED-TTL:PT1H',
    ];

    for (const g of gigsR.rows) {
      const start = toIcsDate(g.date, g.start_time);
      const endBase = toIcsDate(g.date, g.end_time || g.start_time || null);
      // If no start_time at all, make it an all-day event
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:gig-${g.id}@trackmygigs.app`);
      lines.push(`DTSTAMP:${dtstamp}`);
      if (start.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${start.value}`);
        // all-day end is exclusive; add 1 day
        const d = new Date(g.date); d.setDate(d.getDate() + 1);
        lines.push(`DTEND;VALUE=DATE:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);
      } else {
        lines.push(`DTSTART:${start.value}`);
        lines.push(`DTEND:${endBase.value}`);
      }
      lines.push('SUMMARY:Busy');
      lines.push('TRANSP:OPAQUE');
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('ICS feed error:', err);
    res.status(500).type('text/plain').send('Error');
  }
});

router.get('/cal/:token', async (req, res) => {
  try {
    const user = await findUserByShareToken(req.params.token);
    if (!user) {
      res.status(404).set('Content-Type', 'text/html').send(pageHtml('Not found', `<div class="empty"><h1>Not found</h1><p class="sub">This link is no longer active.</p></div>`));
      return;
    }

    const displayName = user.display_name || user.name || 'Artist';

    const [gigsR, blockedR] = await Promise.all([
      db.query(
        `SELECT date FROM gigs
         WHERE user_id = $1 AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '120 days'`,
        [user.id]
      ),
      db.query(
        `SELECT date FROM blocked_dates
         WHERE user_id = $1 AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '120 days'`,
        [user.id]
      ).catch(() => ({ rows: [] })),
    ]);

    const bookedSet = new Set(gigsR.rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))));
    const blockedSet = new Set(blockedR.rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))));

    const today = new Date();
    const monthsHtml = [0, 1, 2].map(offset => {
      const first = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      const monthLabel = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const firstDow = (first.getDay() + 6) % 7;
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
        cells += `<div class="cal-cell ${cls}">${d}</div>`;
      }
      return `<div class="cal-month">${esc(monthLabel)}</div><div class="cal-grid">${cells}</div>`;
    }).join('');

    const icsUrl = `/cal/${esc(req.params.token)}.ics`;

    const body = `
      <div class="avatar">${esc((displayName[0] || 'M').toUpperCase())}</div>
      <h1 style="text-align:center;">${esc(displayName)}</h1>
      <p class="sub" style="text-align:center;">Availability &mdash; next 3 months</p>
      <div class="legend">
        <span><span class="legend-dot" style="background:var(--card);border:1px solid var(--border);"></span>Free</span>
        <span><span class="legend-dot" style="background:var(--danger);"></span>Booked</span>
        <span><span class="legend-dot" style="background:#6E7681;"></span>Unavailable</span>
      </div>
      <div class="card">${monthsHtml}</div>
      <div style="text-align:center;margin-top:20px;">
        <a class="btn btn-o" href="${icsUrl}">Subscribe (ICS)</a>
      </div>`;

    res.set('Content-Type', 'text/html').send(pageHtml(`${displayName} Availability`, body));
  } catch (err) {
    console.error('Public /cal error:', err);
    res.status(500).set('Content-Type', 'text/html').send(pageHtml('Error', `<div class="empty"><h1>Something went wrong</h1><p class="sub">Please try again.</p></div>`));
  }
});

module.exports = router;
