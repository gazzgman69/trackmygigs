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

module.exports = router;
