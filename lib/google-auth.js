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

async function getGoogleAuthClient(userId, purpose) {
  const result = await db.query(
    `SELECT google_access_token, google_refresh_token, google_token_expires_at,
            sheets_access_token, sheets_refresh_token, sheets_token_expires_at
       FROM users WHERE id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user) return null;
  // Sheets calls prefer the dedicated Sheets connection (possibly a
  // different Google account than the calendar), falling back to the shared
  // token for users who connected before the split.
  const prefix = (purpose === 'sheets' && user.sheets_access_token) ? 'sheets' : 'google';
  const accessToken = user[prefix + '_access_token'];
  const refreshToken = user[prefix + '_refresh_token'];
  const expiresAt = user[prefix + '_token_expires_at'];
  const stateCols = prefix === 'sheets'
    ? { state: 'sheets_connection_state', error: 'sheets_connection_error' }
    : { state: 'google_connection_state', error: 'google_connection_error' };
  if (!accessToken) return null;

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || 'https://trackmygigs.app') + '/auth/google/callback'
  );

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiresAt ? new Date(expiresAt).getTime() : null,
  });

  // Refresh if expired. Same error-handling shape as routes/calendar.js so
  // the existing needs_reconnect UX kicks in if the refresh_token is dead.
  // Refresh results and failure markers land on whichever token set is in
  // use so a dead Sheets connection never poisons the calendar one.
  if (expiresAt && new Date(expiresAt) < new Date()) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await db.query(
        `UPDATE users SET ${prefix}_access_token = $1, ${prefix}_token_expires_at = $2,
           ${stateCols.state} = NULL, ${stateCols.error} = NULL
         WHERE id = $3`,
        [credentials.access_token, credentials.expiry_date ? new Date(credentials.expiry_date) : null, userId]
      );
    } catch (err) {
      console.error('[google-auth] Token refresh failed:', err.message);
      const reason = err && (err.message || err.code) ? String(err.message || err.code) : 'refresh_failed';
      const state = /invalid_grant/i.test(reason) ? 'revoked' : 'refresh_failed';
      try {
        await db.query(
          `UPDATE users SET ${stateCols.state} = $1, ${stateCols.error} = $2
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
