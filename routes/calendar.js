const express = require('express');
const { google } = require('googleapis');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ── LONDON-LOCAL DATE/TIME PARTS ─────────────────────────────────────────────
// Google events arrive as RFC3339 strings like "2026-04-23T00:00:00+01:00".
// `new Date(...)` produces a correct UTC instant, but `.toISOString()` and
// `.toTimeString()` then return UTC parts (on Replit the server TZ is UTC),
// which shifts late-evening events onto the wrong calendar day. Gigs are
// scheduled and displayed in London local time, so we extract date + time
// in 'Europe/London' regardless of what the server thinks the local zone is.
function londonDateTime(isoOrDate) {
  if (!isoOrDate) return { date: null, time: null };
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d.getTime())) return { date: null, time: null };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  let hour = get('hour');
  if (hour === '24') hour = '00'; // en-GB midnight quirk on some Node versions
  const minute = get('minute');
  return {
    date: year && month && day ? `${year}-${month}-${day}` : null,
    time: hour && minute ? `${hour}:${minute}` : null,
  };
}

// ── AI CLASSIFICATION (Claude Haiku 4.5) ─────────────────────────────────────
// Given a batch of Google Calendar events, classify each as gig / not-gig with
// confidence + extracted metadata. Falls back to the deterministic keyword
// scorer below if the Anthropic API is unavailable or fails.

let _anthropicClient = null;
let _anthropicDisabled = false;
let _anthropicSource = null; // 'replit' | 'direct' | null

// Inspect env to decide how (and whether) to reach Anthropic. Replit's AI
// integration proxy is preferred when present: it lets the app call Claude
// without the app owner managing a key or billing, because Replit handles
// auth behind the proxy and bills usage to the Replit account. If that isn't
// configured, fall back to a direct ANTHROPIC_API_KEY so the classifier still
// works in non-Replit environments. If neither is set, classifier disables
// itself and the deterministic keyword scorer takes over.
function resolveAnthropicConfig() {
  const replitBaseUrl = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const replitApiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (replitBaseUrl && replitApiKey) {
    return { source: 'replit', config: { apiKey: replitApiKey, baseURL: replitBaseUrl } };
  }
  const directKey = process.env.ANTHROPIC_API_KEY;
  if (directKey) {
    return { source: 'direct', config: { apiKey: directKey } };
  }
  return null;
}

function getAnthropic() {
  if (_anthropicClient) return _anthropicClient;
  if (_anthropicDisabled) return null;
  const resolved = resolveAnthropicConfig();
  if (!resolved) {
    _anthropicDisabled = true;
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropicClient = new Anthropic(resolved.config);
    _anthropicSource = resolved.source;
    console.log(`[ai] Anthropic classifier enabled via ${resolved.source} path`);
    return _anthropicClient;
  } catch (e) {
    console.error('[ai] Failed to init Anthropic SDK:', e.message || e);
    _anthropicDisabled = true;
    return null;
  }
}

// Lets /status report which route is live without re-initialising the client.
function getAnthropicSource() {
  if (_anthropicSource) return _anthropicSource;
  if (_anthropicDisabled) return null;
  const resolved = resolveAnthropicConfig();
  return resolved ? resolved.source : null;
}

function eventSummaryForAI(event, index) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;
  const day = startDate
    ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][startDate.getDay()]
    : 'Unknown';
  const durationHours = startDate && endDate ? ((endDate - startDate) / 3600000).toFixed(1) : null;
  const startStr = startDate ? startDate.toISOString().replace('T', ' ').substring(0, 16) : 'unknown';
  const allDay = !!(event.start?.date && !event.start?.dateTime);

  const lines = [
    `[${index}] Title: ${event.summary || '(no title)'}`,
    `    Start: ${startStr} (${day})${allDay ? ' [all-day]' : ''}`,
    durationHours ? `    Duration: ${durationHours}h` : null,
    event.location ? `    Location: ${event.location}` : null,
    event.description ? `    Description: ${String(event.description).slice(0, 200)}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

async function classifyEventsBatch(events) {
  const client = getAnthropic();
  if (!client || !events || events.length === 0) return null;

  const systemPrompt = `You are a gig detection classifier for a working musician's calendar.

Given a list of calendar events, decide which are professional music work: performances, rehearsals, recording sessions, teaching, dep (depp/sub) work, or similar paid music activity.

Return a JSON array, one object per input event, in the SAME ORDER as input. Use this shape exactly:

[
  {
    "index": <integer matching the [N] prefix in the input>,
    "is_gig": <boolean>,
    "confidence": <0-100 integer>,
    "gig_type": "performance" | "rehearsal" | "session" | "teaching" | "dep" | "other" | null,
    "reasons": [<short phrases explaining the decision>],
    "suggested_band_name": <string or null>,
    "suggested_venue": <string or null>
  }
]

Signal guidance:
- Weddings, functions, corporate events, pub gigs, private parties at hotels/halls/restaurants are performances
- Band names, soundcheck, setlist, load-in, dep, function, reception, ceremony, residency are strong signals
- Pub/hotel/venue/church/hall/club names in location are strong signals
- Evening (17:00+) and weekend timing increase confidence but are not required
- All-day events are usually NOT gigs unless title says festival, tour day, residency
- Medical, personal, holiday, family, business meetings, commutes, admin = confidence below 20

Return ONLY the JSON array. No markdown fences. No prose. No explanation.`;

  const userContent = events.map((e, i) => eventSummaryForAI(e, i)).join('\n\n');

  try {
    const response = await client.messages.create({
      // Short alias: works on both direct Anthropic API and Replit's proxy.
      // Replit proxy only accepts the short form; direct API accepts both.
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    let text = response.content?.[0]?.text || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    console.error('[ai] classifyEventsBatch failed:', err.message || err);
    return null;
  }
}

// ── Gig-detection keywords & patterns ────────────────────────────────────────

const GIG_KEYWORDS = [
  'gig', 'band', 'wedding', 'function', 'corporate', 'live music', 'set',
  'soundcheck', 'sound check', 'rehearsal', 'dep', 'session', 'show',
  'concert', 'festival', 'performance', 'keys', 'guitar', 'drums', 'bass',
  'vocals', 'singer', 'musician', 'DJ', 'reception', 'ceremony',
];

const VENUE_KEYWORDS = [
  'hotel', 'hall', 'church', 'cathedral', 'pub', 'bar', 'club', 'theatre',
  'theater', 'arena', 'pavilion', 'centre', 'center', 'stadium', 'NEC',
  'venue', 'garden', 'manor', 'castle', 'barn', 'restaurant',
];

function scoreEvent(event) {
  const title = (event.summary || '').toLowerCase();
  const location = (event.location || '').toLowerCase();
  const description = (event.description || '').toLowerCase();
  const allText = title + ' ' + location + ' ' + description;

  let score = 0;
  const reasons = [];

  // Keyword matches in title (highest weight)
  for (const kw of GIG_KEYWORDS) {
    if (title.includes(kw)) {
      score += 30;
      reasons.push(`"${kw}" in title`);
    }
  }

  // Keyword matches in description
  for (const kw of GIG_KEYWORDS) {
    if (description.includes(kw) && !title.includes(kw)) {
      score += 10;
    }
  }

  // Venue keywords
  for (const kw of VENUE_KEYWORDS) {
    if (allText.includes(kw)) {
      score += 15;
      reasons.push('Known venue');
      break;
    }
  }

  // Location present
  if (event.location) {
    score += 10;
    reasons.push('Venue detected');
  }

  // Evening time slot (17:00+)
  const start = event.start?.dateTime;
  if (start) {
    const hour = new Date(start).getHours();
    if (hour >= 17) {
      score += 20;
      reasons.push('Evening slot');
    } else if (hour >= 14) {
      score += 5;
      reasons.push('Afternoon slot');
    } else {
      reasons.push('Daytime - lower confidence');
    }
  }

  // Duration > 2 hours (typical for gigs)
  if (event.start?.dateTime && event.end?.dateTime) {
    const durationHours = (new Date(event.end.dateTime) - new Date(event.start.dateTime)) / 3600000;
    if (durationHours >= 2) {
      score += 10;
    }
  }

  // Weekend bonus
  if (start) {
    const day = new Date(start).getDay();
    if (day === 0 || day === 5 || day === 6) {
      score += 10;
    }
  }

  return { score, reasons };
}

// ── Helper: get authenticated Google client ──────────────────────────────────

async function getGoogleAuth(userId) {
  const result = await db.query(
    'SELECT google_access_token, google_refresh_token, google_token_expires_at FROM users WHERE id = $1',
    [userId]
  );
  const user = result.rows[0];
  if (!user || !user.google_access_token) return null;

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || 'https://trackmygigs.app') + '/auth/google/callback'
  );

  client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token,
    expiry_date: user.google_token_expires_at ? new Date(user.google_token_expires_at).getTime() : null,
  });

  // Refresh if expired
  if (user.google_token_expires_at && new Date(user.google_token_expires_at) < new Date()) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await db.query(
        'UPDATE users SET google_access_token = $1, google_token_expires_at = $2 WHERE id = $3',
        [credentials.access_token, credentials.expiry_date ? new Date(credentials.expiry_date) : null, userId]
      );
    } catch (err) {
      console.error('Token refresh failed:', err);
      return null;
    }
  }

  return client;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Check if calendar is connected + when we last pulled changes from Google
router.get('/status', async (req, res) => {
  const result = await db.query(
    'SELECT google_access_token, google_calendar_email, google_last_pull_at FROM users WHERE id = $1',
    [req.user.id]
  );
  const row = result.rows[0] || {};
  const aiSource = getAnthropicSource();
  res.json({
    connected: !!row.google_access_token,
    calendar_email: row.google_calendar_email || null,
    last_synced_at: row.google_last_pull_at || null,
    ai_enabled: !!aiSource,
    ai_source: aiSource, // 'replit' | 'direct' | null
  });
});

// Minimal end-to-end test of the AI classifier path. Fires a tiny prompt
// (16 tokens max) and reports whether the proxy/SDK responded. Useful after
// changing env vars, rotating keys, or debugging a dead classifier without
// having to wait for a calendar event to trigger it.
router.get('/ai-ping', async (req, res) => {
  const source = getAnthropicSource();
  if (!source) {
    return res.json({
      ok: false,
      ai_enabled: false,
      ai_source: null,
      error: 'No Anthropic config: neither AI_INTEGRATIONS_ANTHROPIC_* nor ANTHROPIC_API_KEY is set',
    });
  }
  const client = getAnthropic();
  if (!client) {
    return res.json({
      ok: false,
      ai_enabled: false,
      ai_source: source,
      error: 'SDK failed to initialise (check server logs)',
    });
  }
  const start = Date.now();
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    });
    const reply = response.content?.[0]?.text || '';
    res.json({
      ok: true,
      ai_enabled: true,
      ai_source: source,
      model: 'claude-haiku-4-5',
      latency_ms: Date.now() - start,
      reply: reply.trim(),
    });
  } catch (err) {
    res.json({
      ok: false,
      ai_enabled: true,
      ai_source: source,
      model: 'claude-haiku-4-5',
      latency_ms: Date.now() - start,
      error: err.message || String(err),
      status: err.status || null,
    });
  }
});

// Disconnect the linked Google Calendar.
// - Revoke the token with Google so access is killed on their side too.
// - Null the token + email columns on our side.
// Failure to revoke (network, already-revoked token) is logged but not fatal;
// we still clear local state because the user asked us to.
router.post('/disconnect', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0] || {};
    const tokenToRevoke = row.google_refresh_token || row.google_access_token;

    if (tokenToRevoke) {
      try {
        const resp = await fetch(
          'https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tokenToRevoke),
          { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          console.warn('[calendar disconnect] revoke returned', resp.status, body);
        }
      } catch (e) {
        console.warn('[calendar disconnect] revoke fetch failed:', e.message);
      }
    }

    await db.query(
      `UPDATE users SET
         google_access_token = NULL,
         google_refresh_token = NULL,
         google_token_expires_at = NULL,
         google_calendar_email = NULL
       WHERE id = $1`,
      [req.user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Calendar disconnect failed:', err);
    res.status(500).json({ error: 'disconnect_failed' });
  }
});

// Fetch upcoming events and classify them for gig likelihood.
// Primary classifier is Claude Haiku 4.5 in batch. If the AI call fails or is
// not configured, we fall back to the deterministic keyword scorer.
router.get('/events', async (req, res) => {
  try {
    const auth = await getGoogleAuth(req.user.id);
    if (!auth) {
      return res.json({ events: [], connected: false });
    }

    const calendar = google.calendar({ version: 'v3', auth });

    // Window: now to 60 days ahead
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + 60);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const items = response.data.items || [];

    // Already-linked Google event ids. Covers both directions:
    //   (1) Gigs pulled IN from Google Calendar (source = 'gcal:<id>')
    //   (2) Gigs created in the app and pushed OUT to Google (google_event_id set)
    // Missing case (2) caused the app's own pushed gigs to show up as nudges
    // every time the Calendar screen refreshed.
    const existingGigs = await db.query(
      `SELECT source, google_event_id
         FROM gigs
        WHERE user_id = $1
          AND (source LIKE 'gcal:%' OR google_event_id IS NOT NULL)`,
      [req.user.id]
    );
    const importedIds = new Set();
    for (const g of existingGigs.rows) {
      if (g.google_event_id) importedIds.add(g.google_event_id);
      if (g.source && g.source.startsWith('gcal:')) {
        importedIds.add(g.source.slice('gcal:'.length));
      }
    }

    const candidates = items.filter(ev => !importedIds.has(ev.id));

    // Try AI classification (batch call)
    const aiResults = await classifyEventsBatch(candidates);
    const classifier = aiResults ? 'ai' : 'keyword';

    const events = candidates.map((ev, i) => {
      const start = ev.start?.dateTime || ev.start?.date;
      const end = ev.end?.dateTime || ev.end?.date;
      const startDate = start ? new Date(start) : null;
      const endDate = end ? new Date(end) : null;

      let score;
      let reasons;
      let gig_type = null;
      let suggested_band_name = null;
      let suggested_venue_name = null;

      if (aiResults && aiResults[i]) {
        const ai = aiResults[i];
        score = ai.is_gig ? (typeof ai.confidence === 'number' ? ai.confidence : 50) : Math.min(ai.confidence || 0, 10);
        reasons = Array.isArray(ai.reasons) ? ai.reasons : [];
        gig_type = ai.gig_type || null;
        suggested_band_name = ai.suggested_band_name || null;
        suggested_venue_name = ai.suggested_venue || null;
      } else {
        const kw = scoreEvent(ev);
        score = kw.score;
        reasons = kw.reasons;
      }

      // London-local components so a 23:00+01:00 event doesn't get labelled
      // 22:00 the day before on a UTC server.
      const startLondon = ev.start?.dateTime ? londonDateTime(start) : { date: null, time: null };
      const endLondon = ev.end?.dateTime ? londonDateTime(end) : { date: null, time: null };
      return {
        id: ev.id,
        title: ev.summary || 'Untitled event',
        location: ev.location || null,
        start,
        end,
        start_time: startLondon.time,
        end_time: endLondon.time,
        date_formatted: startDate ? startDate.toLocaleDateString('en-GB', {
          weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London',
        }) : null,
        calendar_email: ev.organizer?.email || null,
        score,
        reasons,
        gig_type,
        suggested_band_name,
        suggested_venue_name,
        classifier_used: aiResults ? 'ai' : 'keyword',
        source: 'google_calendar',
        already_imported: false,
      };
    });

    const filtered = events
      .filter(e => e.score >= 20)
      .sort((a, b) => b.score - a.score);

    res.json({ events: filtered, connected: true, classifier });
  } catch (error) {
    console.error('Calendar events error:', error);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      return res.json({ events: [], connected: false, needs_reauth: true });
    }
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// Import a calendar event as a gig
// Lightweight events feed for rendering pins on the Calendar month/week views.
// Returns ALL events in a date range (not filtered by gig-nudge score).
// Query: ?start=YYYY-MM-DD&end=YYYY-MM-DD (defaults to today..+35 days).
router.get('/pins', async (req, res) => {
  try {
    const auth = await getGoogleAuth(req.user.id);
    if (!auth) return res.json({ pins: [], connected: false });

    const start = req.query.start ? new Date(req.query.start) : new Date();
    const end = req.query.end ? new Date(req.query.end) : new Date(Date.now() + 35 * 24 * 60 * 60 * 1000);

    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    // Exclude events already linked to a gig. Covers BOTH directions:
    //   (1) Gigs pulled IN from Google Calendar (source = 'gcal:<id>')
    //   (2) Gigs created in the app and pushed OUT to Google (google_event_id set,
    //       but source stays 'manual' / 'crm' etc.)
    // Missing case (2) was the cause of every app-created gig showing up twice
    // on the calendar: once as the TMG gig row, once as its own Google pin.
    const existingGigs = await db.query(
      `SELECT source, google_event_id
         FROM gigs
        WHERE user_id = $1
          AND (source LIKE 'gcal:%' OR google_event_id IS NOT NULL)`,
      [req.user.id]
    );
    const importedIds = new Set();
    for (const g of existingGigs.rows) {
      if (g.google_event_id) importedIds.add(g.google_event_id);
      if (g.source && g.source.startsWith('gcal:')) {
        importedIds.add(g.source.slice('gcal:'.length));
      }
    }

    const pins = (response.data.items || [])
      .filter(ev => !importedIds.has(ev.id))
      .map(ev => {
        const s = ev.start?.dateTime || ev.start?.date;
        const e = ev.end?.dateTime || ev.end?.date;
        const isAllDay = !!(ev.start?.date && !ev.start?.dateTime);
        // All-day events already carry a bare YYYY-MM-DD. Timed events get
        // their date + time resolved in Europe/London so the pin lands on the
        // user-visible day, not the server's UTC day.
        let date = null;
        let startTime = null;
        if (isAllDay) {
          date = ev.start?.date || null;
        } else if (s) {
          const parts = londonDateTime(s);
          date = parts.date;
          startTime = parts.time;
        }
        return {
          id: ev.id,
          title: ev.summary || 'Untitled event',
          location: ev.location || null,
          date,
          start: s,
          end: e,
          start_time: startTime,
          all_day: isAllDay,
        };
      })
      .filter(p => p.date);

    res.json({ pins, connected: true });
  } catch (error) {
    console.error('Calendar pins error:', error);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      return res.json({ pins: [], connected: false, needs_reauth: true });
    }
    res.status(500).json({ error: 'Failed to fetch calendar pins' });
  }
});

router.post('/import', async (req, res) => {
  try {
    const { event_id, title, location, start, end, fee, band_name, dress_code } = req.body;

    // `start` / `end` may be either a full dateTime ("2026-04-23T00:00:00+01:00")
    // or an all-day bare date ("2026-04-23"). Split parts in Europe/London so
    // an event that runs 23:00→01:00 lands on the correct day for the user.
    const isAllDayStart = typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start);
    const startParts = start
      ? (isAllDayStart ? { date: start, time: null } : londonDateTime(start))
      : londonDateTime(new Date());
    const isAllDayEnd = typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end);
    const endParts = end
      ? (isAllDayEnd ? { date: end, time: null } : londonDateTime(end))
      : { date: null, time: null };

    // IMPORTANT: populate google_event_id at import time (in addition to the
    // `source='gcal:<id>'` tag). Without this, Google-side cancellations and
    // TMG-side deletes silently miss imported gigs, because both the pull
    // cancellation handler and removeGigFromGoogle key on google_event_id.
    // source is kept for backwards compat + provenance labeling.
    const result = await db.query(
      `INSERT INTO gigs (user_id, band_name, venue_name, venue_address, date, start_time, end_time, fee, status, source, dress_code, google_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        req.user.id,
        band_name || title,
        location ? location.split(',')[0] : null,
        location || null,
        startParts.date,
        startParts.time,
        endParts.time,
        fee ? parseFloat(fee) : null,
        'confirmed',
        `gcal:${event_id}`,
        dress_code || null,
        event_id,
      ]
    );

    // Refresh cached gigs
    res.json({ gig: result.rows[0], success: true });
  } catch (error) {
    console.error('Import calendar event error:', error);
    res.status(500).json({ error: 'Failed to import event' });
  }
});

// Dismiss a calendar event (don't show it again)
router.post('/dismiss', async (req, res) => {
  try {
    const { event_id } = req.body;
    // Store as a "dismissed" source entry so we don't show it again
    await db.query(
      `INSERT INTO calendar_syncs (user_id, provider, calendar_id, sync_direction)
       VALUES ($1, 'google', $2, 'dismissed')
       ON CONFLICT DO NOTHING`,
      [req.user.id, event_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss event error:', error);
    res.status(500).json({ error: 'Failed to dismiss event' });
  }
});

// ── TWO-WAY SYNC: push TrackMyGigs gigs back to Google Calendar ─────────────
//
// We keep the logic tolerant: failures never break the app, Google is treated
// as a mirror. Calls are safe to fire-and-forget from api.js.

function buildEventResource(gig) {
  const title = gig.band_name
    ? `🎵 ${gig.band_name}${gig.venue_name ? ' @ ' + gig.venue_name : ''}`
    : (gig.venue_name ? `🎵 Gig @ ${gig.venue_name}` : '🎵 Gig');

  // Rich description: every piece of gig info the app knows about, formatted
  // for the Google Calendar event body so users get the full gig picture in
  // their phone's default calendar without opening TrackMyGigs.
  const descLines = [];
  if (gig.status && gig.status !== 'confirmed') descLines.push(`Status: ${gig.status}`);
  if (gig.gig_type) descLines.push(`🎤 Type: ${gig.gig_type}`);
  if (gig.fee != null && gig.fee !== '') descLines.push(`💷 Fee: £${gig.fee}`);
  if (gig.load_in_time) descLines.push(`🚪 Load-in: ${String(gig.load_in_time).substring(0, 5)}`);
  if (gig.dress_code) descLines.push(`👔 Dress: ${gig.dress_code}`);
  if (gig.day_of_contact) descLines.push(`📞 Contact: ${gig.day_of_contact}`);
  if (gig.parking_info) descLines.push(`🅿️ Parking: ${gig.parking_info}`);
  if (gig.mileage_miles != null && gig.mileage_miles !== '') descLines.push(`🚗 Distance: ${gig.mileage_miles} mi`);

  // Set times (JSONB array of {label, time})
  if (gig.set_times) {
    try {
      const sets = Array.isArray(gig.set_times) ? gig.set_times : JSON.parse(gig.set_times);
      if (sets && sets.length) {
        const parts = sets
          .filter(s => s && (s.label || s.time))
          .map(s => `${s.label || 'Set'}: ${s.time || ''}`.trim());
        if (parts.length) descLines.push(`🎶 Sets: ${parts.join(' · ')}`);
      }
    } catch (_) {}
  }

  // Checklist summary (how many items ticked)
  if (gig.checklist) {
    try {
      const list = Array.isArray(gig.checklist) ? gig.checklist : JSON.parse(gig.checklist);
      if (list && list.length) {
        const done = list.filter(c => c && c.done).length;
        descLines.push(`✅ Checklist: ${done}/${list.length} done`);
      }
    } catch (_) {}
  }

  if (gig.invoice_id) descLines.push(`🧾 Invoice attached`);
  if (gig.setlist_id) descLines.push(`📋 Setlist attached`);

  if (gig.notes) {
    descLines.push('');
    descLines.push('📝 Notes:');
    descLines.push(String(gig.notes));
  }

  descLines.push('');
  descLines.push('─────────────');
  descLines.push('Synced from TrackMyGigs · https://trackmygigs.app');

  // Date + times → RFC3339 strings. If no times, treat as all-day event.
  const dateStr = gig.date instanceof Date
    ? gig.date.toISOString().split('T')[0]
    : String(gig.date).split('T')[0];

  const event = {
    summary: title,
    description: descLines.join('\n'),
    location: gig.venue_address || gig.venue_name || undefined,
  };

  if (gig.start_time) {
    const start = `${dateStr}T${gig.start_time.length === 5 ? gig.start_time + ':00' : gig.start_time}`;
    let end;
    if (gig.end_time) {
      // Cross-midnight gigs (end_time numerically earlier than start_time)
      // need the end date bumped by one day, otherwise Google rejects the event
      // because end < start. Compared as "HH:MM" strings lexicographically —
      // '01:30' < '23:30' flags the cross-midnight case correctly.
      let endDateStr = dateStr;
      const startHM = gig.start_time.slice(0, 5);
      const endHM = gig.end_time.slice(0, 5);
      if (endHM < startHM) {
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        const pad = (n) => String(n).padStart(2, '0');
        endDateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
      end = `${endDateStr}T${gig.end_time.length === 5 ? gig.end_time + ':00' : gig.end_time}`;
    } else {
      // Default 2hr duration if no end supplied
      const startDt = new Date(start);
      const endDt = new Date(startDt.getTime() + 2 * 3600000);
      const pad = (n) => String(n).padStart(2, '0');
      end = `${endDt.getFullYear()}-${pad(endDt.getMonth() + 1)}-${pad(endDt.getDate())}T${pad(endDt.getHours())}:${pad(endDt.getMinutes())}:00`;
    }
    event.start = { dateTime: start, timeZone: 'Europe/London' };
    event.end = { dateTime: end, timeZone: 'Europe/London' };
  } else {
    // All-day
    event.start = { date: dateStr };
    // Google requires end.date to be the day AFTER for all-day events
    const next = new Date(dateStr + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    event.end = { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` };
  }

  return event;
}

async function pushGigToGoogle(userId, gig) {
  try {
    const auth = await getGoogleAuth(userId);
    if (!auth) return null;

    const calendar = google.calendar({ version: 'v3', auth });
    const resource = buildEventResource(gig);

    // Determine target Google event id:
    //   - google_event_id column (set on first push or first pull link)
    //   - source tagged 'gcal:<id>' (event that was originally imported from Google)
    // For gigs that originated in Google, push-back means UPDATING that same event
    // so edits made in the app propagate to the user's Google Calendar.
    let targetEventId = gig.google_event_id;
    if (!targetEventId && gig.source && String(gig.source).startsWith('gcal:')) {
      targetEventId = String(gig.source).slice('gcal:'.length);
    }

    if (targetEventId) {
      const resp = await calendar.events.update({
        calendarId: 'primary',
        eventId: targetEventId,
        requestBody: resource,
      });
      const resolvedId = resp.data.id || targetEventId;
      // Persist id if it wasn't on the row yet (originated from gcal: source)
      if (!gig.google_event_id && resolvedId) {
        try {
          await db.query(
            'UPDATE gigs SET google_event_id = $1 WHERE id = $2 AND user_id = $3',
            [resolvedId, gig.id, userId]
          );
        } catch (_) {}
      }
      return resolvedId;
    }

    // Create new event
    const resp = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: resource,
    });
    const newId = resp.data.id;
    if (newId) {
      await db.query('UPDATE gigs SET google_event_id = $1 WHERE id = $2 AND user_id = $3', [newId, gig.id, userId]);
    }
    return newId;
  } catch (err) {
    // If event was deleted on Google's side, wipe local id so next push re-creates
    if (err && (err.code === 404 || err.code === 410)) {
      try { await db.query('UPDATE gigs SET google_event_id = NULL WHERE id = $1 AND user_id = $2', [gig.id, userId]); } catch (_) {}
    }
    console.error('pushGigToGoogle error:', err.message || err);
    return null;
  }
}

async function removeGigFromGoogle(userId, gig) {
  try {
    if (!gig) return false;
    // Same fallback chain as pushGigToGoogle: google_event_id is the canonical
    // link, but gigs imported via /api/calendar/import only have source='gcal:<id>'
    // until first edit backfills google_event_id. Without this fallback, deleting
    // an imported-but-never-edited gig in TMG left the Google event orphaned.
    let targetEventId = gig.google_event_id;
    if (!targetEventId && gig.source && String(gig.source).startsWith('gcal:')) {
      targetEventId = String(gig.source).slice('gcal:'.length);
    }
    if (!targetEventId) return false;

    const auth = await getGoogleAuth(userId);
    if (!auth) return false;
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: targetEventId,
    });
    return true;
  } catch (err) {
    if (err && (err.code === 404 || err.code === 410)) return true; // already gone
    console.error('removeGigFromGoogle error:', err.message || err);
    return false;
  }
}

// Explicit client-triggered sync: push a single gig (create or update)
router.post('/push/:gigId', async (req, res) => {
  try {
    const gigResult = await db.query('SELECT * FROM gigs WHERE id = $1 AND user_id = $2', [req.params.gigId, req.user.id]);
    if (gigResult.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
    const eventId = await pushGigToGoogle(req.user.id, gigResult.rows[0]);
    if (!eventId) return res.status(400).json({ error: 'Sync failed. Is your Google Calendar connected?' });
    res.json({ success: true, google_event_id: eventId });
  } catch (err) {
    console.error('Manual push error:', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// Push every active local gig to Google Calendar. Includes gigs that were
// originally imported from Google so rich app metadata (fee, contact, gear,
// set times, notes) is mirrored back into the Google event.
router.post('/push-all', async (req, res) => {
  try {
    const auth = await getGoogleAuth(req.user.id);
    if (!auth) return res.status(400).json({ error: 'Calendar not connected' });
    const gigs = await db.query(
      "SELECT * FROM gigs WHERE user_id = $1 AND (status IS NULL OR status != 'cancelled')",
      [req.user.id]
    );
    let ok = 0, fail = 0;
    for (const g of gigs.rows) {
      const id = await pushGigToGoogle(req.user.id, g);
      if (id) ok++; else fail++;
    }
    res.json({ success: true, pushed: ok, failed: fail, total: gigs.rows.length });
  } catch (err) {
    console.error('Push-all error:', err);
    res.status(500).json({ error: 'Bulk sync failed' });
  }
});

// ── INBOUND SYNC: pull Google Calendar changes into TrackMyGigs ─────────────
//
// Uses Google's incremental sync via syncToken. On first call we establish a
// token from a baseline window (past month onwards). On subsequent calls we
// only fetch what changed since last pull. If the token is invalidated (410)
// we reset and do a fresh baseline fetch.
//
// Scope: we ONLY update gigs that are already linked to a Google event via
// google_event_id. New/unknown events flow through the existing nudge system
// (/events) so the user stays in control of what becomes a gig.

async function pullFromGoogle(userId) {
  const auth = await getGoogleAuth(userId);
  if (!auth) return { error: 'not_connected' };

  const userRow = await db.query('SELECT google_sync_token FROM users WHERE id = $1', [userId]);
  let syncToken = userRow.rows[0]?.google_sync_token || null;

  const calendar = google.calendar({ version: 'v3', auth });
  const listParams = { calendarId: 'primary', singleEvents: true, showDeleted: true };

  if (syncToken) {
    listParams.syncToken = syncToken;
  } else {
    const past = new Date();
    past.setMonth(past.getMonth() - 1);
    listParams.timeMin = past.toISOString();
  }

  let pageToken = null;
  let nextSyncToken = null;
  let updated = 0;
  let cancelled = 0;

  try {
    do {
      if (pageToken) listParams.pageToken = pageToken;

      const response = await calendar.events.list(listParams);
      const events = response.data.items || [];

      for (const event of events) {
        if (event.status === 'cancelled') {
          const r = await db.query(
            `UPDATE gigs SET status = 'cancelled'
             WHERE user_id = $1 AND google_event_id = $2 AND status != 'cancelled'
             RETURNING id`,
            [userId, event.id]
          );
          if (r.rowCount > 0) cancelled++;
          continue;
        }

        const startDT = event.start?.dateTime || event.start?.date;
        if (!startDT) continue;
        // All-day events already come as bare YYYY-MM-DD; timed events get
        // resolved to London-local parts so the gig lands on the correct day.
        const isAllDay = !!(event.start?.date && !event.start?.dateTime);
        let dateStr = null;
        let startTime = null;
        let endTime = null;
        if (isAllDay) {
          dateStr = event.start.date;
        } else {
          const startLondon = londonDateTime(event.start.dateTime);
          dateStr = startLondon.date;
          startTime = startLondon.time;
          if (event.end?.dateTime) {
            endTime = londonDateTime(event.end.dateTime).time;
          }
        }
        if (!dateStr) continue;

        const r = await db.query(
          `UPDATE gigs
             SET date = $1,
                 start_time = COALESCE($2, start_time),
                 end_time = COALESCE($3, end_time),
                 venue_name = COALESCE($4, venue_name),
                 venue_address = COALESCE($5, venue_address)
           WHERE user_id = $6 AND google_event_id = $7
           RETURNING id`,
          [
            dateStr,
            startTime,
            endTime,
            event.location ? event.location.split(',')[0] : null,
            event.location || null,
            userId,
            event.id,
          ]
        );
        if (r.rowCount > 0) updated++;
      }

      pageToken = response.data.nextPageToken;
      if (response.data.nextSyncToken) nextSyncToken = response.data.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    // Sync token invalidated — clear it so the next pull re-baselines
    if (err && err.code === 410) {
      await db.query('UPDATE users SET google_sync_token = NULL WHERE id = $1', [userId]);
      return { error: 'sync_token_expired', retry: true };
    }
    console.error('pullFromGoogle error:', err.message || err);
    return { error: err.message || 'pull_failed' };
  }

  if (nextSyncToken) {
    await db.query(
      'UPDATE users SET google_sync_token = $1, google_last_pull_at = NOW() WHERE id = $2',
      [nextSyncToken, userId]
    );
  }

  return { success: true, updated, cancelled };
}

// POST /calendar/pull — fetch changes from Google and apply to linked gigs
router.post('/pull', async (req, res) => {
  try {
    // Optional full resync: clears the per-user sync token so pullFromGoogle
    // re-baselines against Google and re-reads every linked event from scratch.
    // Needed after a parsing-layer fix so existing rows get rewritten with the
    // corrected values. POST /calendar/pull?full=1
    if (req.query.full === '1' || req.query.full === 'true') {
      await db.query('UPDATE users SET google_sync_token = NULL WHERE id = $1', [req.user.id]);
    }
    let result = await pullFromGoogle(req.user.id);
    if (result.retry) {
      result = await pullFromGoogle(req.user.id);
    }
    res.json(result);
  } catch (err) {
    console.error('Pull route error:', err);
    res.status(500).json({ error: 'Pull failed' });
  }
});

// POST /calendar/sync-now — full two-way sync triggered by the Sync Now button.
// Pulls changes from Google, then pushes every active local gig so the
// description and logistics stay mirrored to the Google event.
// Returns a detailed status payload for the client to display.
router.post('/sync-now', async (req, res) => {
  const startedAt = Date.now();
  try {
    const auth = await getGoogleAuth(req.user.id);
    if (!auth) {
      return res.json({
        ok: false,
        error: 'not_connected',
        needs_reauth: true,
        message: 'Google Calendar is not connected. Open Settings to re-connect.',
      });
    }

    // Pull phase
    let pull = await pullFromGoogle(req.user.id);
    if (pull.retry) pull = await pullFromGoogle(req.user.id);

    // Push phase
    const gigs = await db.query(
      "SELECT * FROM gigs WHERE user_id = $1 AND (status IS NULL OR status != 'cancelled')",
      [req.user.id]
    );
    let pushed = 0;
    let pushFailed = 0;
    for (const g of gigs.rows) {
      const id = await pushGigToGoogle(req.user.id, g);
      if (id) pushed++; else pushFailed++;
    }

    // Stamp last-sync timestamp (pullFromGoogle only updates on a fresh syncToken)
    await db.query('UPDATE users SET google_last_pull_at = NOW() WHERE id = $1', [req.user.id]);

    res.json({
      ok: true,
      duration_ms: Date.now() - startedAt,
      synced_at: new Date().toISOString(),
      pulled: {
        updated: pull.updated || 0,
        cancelled: pull.cancelled || 0,
        error: pull.error || null,
      },
      pushed: {
        ok: pushed,
        failed: pushFailed,
        total: gigs.rows.length,
      },
    });
  } catch (err) {
    console.error('Sync-now route error:', err);
    res.status(500).json({
      ok: false,
      error: 'sync_failed',
      message: err.message || 'Sync failed',
    });
  }
});

// GET /calendar/diag-gig?q=... — diagnostic: show DB state + Google state for
// gigs whose band_name or venue_name matches the query. Useful for debugging
// date-mismatch bugs between TMG and Google Calendar without shell access.
// Not linked from the UI; access via URL only.
router.get('/diag-gig', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'q required' });

    const gigs = await db.query(
      `SELECT id, band_name, venue_name, date, start_time, end_time, source, google_event_id
         FROM gigs
        WHERE user_id = $1
          AND (band_name ILIKE $2 OR venue_name ILIKE $2)
        ORDER BY date ASC
        LIMIT 25`,
      [req.user.id, `%${q}%`]
    );

    const auth = await getGoogleAuth(req.user.id);
    const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;

    const out = [];
    for (const g of gigs.rows) {
      const row = {
        id: g.id,
        band_name: g.band_name,
        venue_name: g.venue_name,
        db_date_raw: g.date,
        db_date_iso: g.date instanceof Date ? g.date.toISOString() : String(g.date),
        db_date_slice10: g.date instanceof Date
          ? g.date.toISOString().slice(0, 10)
          : String(g.date).slice(0, 10),
        start_time: g.start_time,
        end_time: g.end_time,
        source: g.source,
        google_event_id: g.google_event_id,
        google: null,
      };

      let targetEventId = g.google_event_id;
      if (!targetEventId && g.source && String(g.source).startsWith('gcal:')) {
        targetEventId = String(g.source).slice('gcal:'.length);
      }

      if (calendar && targetEventId) {
        try {
          const r = await calendar.events.get({ calendarId: 'primary', eventId: targetEventId });
          row.google = {
            id: r.data.id,
            summary: r.data.summary,
            start: r.data.start,
            end: r.data.end,
          };
        } catch (e) {
          row.google = { error: e.message || String(e) };
        }
      }

      out.push(row);
    }

    res.json({ ok: true, server_tz_offset_min: new Date().getTimezoneOffset(), count: out.length, gigs: out });
  } catch (err) {
    console.error('diag-gig error:', err);
    res.status(500).json({ error: err.message || 'diag failed' });
  }
});

// Export helpers for fire-and-forget use in api.js
module.exports = router;
module.exports.pushGigToGoogle = pushGigToGoogle;
module.exports.removeGigFromGoogle = removeGigFromGoogle;
module.exports.pullFromGoogle = pullFromGoogle;
