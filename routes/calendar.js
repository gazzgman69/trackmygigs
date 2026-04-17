const express = require('express');
const { google } = require('googleapis');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

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

function formatEventForNudge(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;

  const { score, reasons } = scoreEvent(event);

  return {
    id: event.id,
    title: event.summary || 'Untitled event',
    location: event.location || null,
    start: start,
    end: end,
    start_time: startDate ? startDate.toTimeString().substring(0, 5) : null,
    end_time: endDate ? endDate.toTimeString().substring(0, 5) : null,
    date_formatted: startDate ? startDate.toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short',
    }) : null,
    calendar_email: event.organizer?.email || null,
    score,
    reasons,
    source: 'google_calendar',
  };
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

// Check if calendar is connected
router.get('/status', async (req, res) => {
  const result = await db.query(
    'SELECT google_access_token FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json({ connected: !!(result.rows[0]?.google_access_token) });
});

// Fetch upcoming events and score them for gig likelihood
router.get('/events', async (req, res) => {
  try {
    const auth = await getGoogleAuth(req.user.id);
    if (!auth) {
      return res.json({ events: [], connected: false });
    }

    const calendar = google.calendar({ version: 'v3', auth });

    // Get events from now to 60 days ahead
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

    const events = (response.data.items || [])
      .map(formatEventForNudge)
      .filter(e => e.score >= 20) // Only show events with some gig likelihood
      .sort((a, b) => b.score - a.score);

    // Check which events are already imported as gigs
    const existingGigs = await db.query(
      "SELECT source FROM gigs WHERE user_id = $1 AND source LIKE 'gcal:%'",
      [req.user.id]
    );
    const importedIds = new Set(existingGigs.rows.map(g => g.source.replace('gcal:', '')));

    const enrichedEvents = events.map(e => ({
      ...e,
      already_imported: importedIds.has(e.id),
    }));

    res.json({ events: enrichedEvents, connected: true });
  } catch (error) {
    console.error('Calendar events error:', error);
    if (error.code === 401 || error.message?.includes('invalid_grant')) {
      // Token revoked or expired beyond refresh
      return res.json({ events: [], connected: false, needs_reauth: true });
    }
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// Import a calendar event as a gig
router.post('/import', async (req, res) => {
  try {
    const { event_id, title, location, start, end, fee, band_name, dress_code } = req.body;

    const startDate = start ? new Date(start) : new Date();
    const endDate = end ? new Date(end) : null;

    const result = await db.query(
      `INSERT INTO gigs (user_id, band_name, venue_name, venue_address, date, start_time, end_time, fee, status, source, dress_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.user.id,
        band_name || title,
        location ? location.split(',')[0] : null,
        location || null,
        startDate.toISOString().split('T')[0],
        startDate.toTimeString().substring(0, 5),
        endDate ? endDate.toTimeString().substring(0, 5) : null,
        fee ? parseFloat(fee) : null,
        'confirmed',
        `gcal:${event_id}`,
        dress_code || null,
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

  const descLines = [];
  if (gig.fee != null && gig.fee !== '') descLines.push(`Fee: £${gig.fee}`);
  if (gig.dress_code) descLines.push(`Dress: ${gig.dress_code}`);
  if (gig.gig_type) descLines.push(`Type: ${gig.gig_type}`);
  if (gig.day_of_contact) descLines.push(`Contact: ${gig.day_of_contact}`);
  if (gig.parking_info) descLines.push(`Parking: ${gig.parking_info}`);
  if (gig.notes) descLines.push(gig.notes);
  descLines.push('');
  descLines.push('(Synced from TrackMyGigs)');

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
      end = `${dateStr}T${gig.end_time.length === 5 ? gig.end_time + ':00' : gig.end_time}`;
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
    // Don't push gigs that came FROM Google in the first place (avoid round-trip)
    if (gig.source && String(gig.source).startsWith('gcal:')) return null;

    const calendar = google.calendar({ version: 'v3', auth });
    const resource = buildEventResource(gig);

    if (gig.google_event_id) {
      // Update existing event
      const resp = await calendar.events.update({
        calendarId: 'primary',
        eventId: gig.google_event_id,
        requestBody: resource,
      });
      return resp.data.id || gig.google_event_id;
    }

    // Create new
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
    if (!gig || !gig.google_event_id) return false;
    const auth = await getGoogleAuth(userId);
    if (!auth) return false;
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: gig.google_event_id,
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

// Push every local gig (that didn't originate from Google) to Google Calendar
router.post('/push-all', async (req, res) => {
  try {
    const auth = await getGoogleAuth(req.user.id);
    if (!auth) return res.status(400).json({ error: 'Calendar not connected' });
    const gigs = await db.query(
      "SELECT * FROM gigs WHERE user_id = $1 AND (source IS NULL OR source NOT LIKE 'gcal:%')",
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
        const start = new Date(startDT);
        const end = event.end?.dateTime || event.end?.date ? new Date(event.end.dateTime || event.end.date) : null;
        const dateStr = start.toISOString().split('T')[0];
        const startTime = event.start?.dateTime ? start.toTimeString().substring(0, 5) : null;
        const endTime = event.end?.dateTime && end ? end.toTimeString().substring(0, 5) : null;

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

// Export helpers for fire-and-forget use in api.js
module.exports = router;
module.exports.pushGigToGoogle = pushGigToGoogle;
module.exports.removeGigFromGoogle = removeGigFromGoogle;
module.exports.pullFromGoogle = pullFromGoogle;
