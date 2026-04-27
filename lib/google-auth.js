// Shared Google OAuth helper. Used by routes/calendar.js for Calendar API
// access AND routes/sheets.js for Sheets API access. Both surfaces share a
// single token set per user — the OAuth flow at /auth/google/sheets requests
// the union of calendar + spreadsheets scopes so a returning user only goes
// through consent once.
//
// Returns a configured google.auth.OAuth2 client that auto-refreshes its
// access token if the cached one is expired. Returns null if the user
// hasn't connected Google or the refresh failed (e.g. they revoked access
// from their Google security page) — callers should treat null as
// "needs reconnect" and surface a UI affordance.

const { google } = require('googleapis');
const db = require('../db');

async function getGoogleAuthClient(userId) {
  const result = await db.query(
    `SELECT google_access_token, google_refresh_token, google_token_expires_at
       FROM users WHERE id = $1`,
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

  // Refresh if expired. Same error-handling shape as routes/calendar.js so
  // the existing needs_reconnect UX kicks in if the refresh_token is dead.
  if (user.google_token_expires_at && new Date(user.google_token_expires_at) < new Date()) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await db.query(
        `UPDATE users SET google_access_token = $1, google_token_expires_at = $2,
           google_connection_state = NULL, google_connection_error = NULL
         WHERE id = $3`,
        [credentials.access_token, credentials.expiry_date ? new Date(credentials.expiry_date) : null, userId]
      );
    } catch (err) {
      console.error('[google-auth] Token refresh failed:', err.message);
      const reason = err && (err.message || err.code) ? String(err.message || err.code) : 'refresh_failed';
      const state = /invalid_grant/i.test(reason) ? 'revoked' : 'refresh_failed';
      try {
        await db.query(
          `UPDATE users SET google_connection_state = $1, google_connection_error = $2
           WHERE id = $3`,
          [state, reason.slice(0, 500), userId]
        );
      } catch (_) {}
      return null;
    }
  }

  return client;
}

// Extract the spreadsheet ID from a Google Sheets URL. Accepts the full edit
// URL (https://docs.google.com/spreadsheets/d/<id>/edit#gid=0) or just the ID
// pasted on its own. Returns null for anything we can't parse.
function extractSpreadsheetId(input) {
  if (!input) return null;
  const v = String(input).trim();
  // Already a bare ID: 44 chars, alphanumeric + dash + underscore
  if (/^[a-zA-Z0-9_-]{20,}$/.test(v)) return v;
  // URL form: /spreadsheets/d/<id>/...
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

module.exports = { getGoogleAuthClient, extractSpreadsheetId };
