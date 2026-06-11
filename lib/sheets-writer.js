// Outbound Google Sheets write-back (Phase D).
//
// Mirrors gig CRUD from TMG into the user's linked Sheet. Called fire-and-
// forget from the gig route handlers so a Sheets API hiccup never blocks a
// user's gig save. Same shape as syncGigSafely in routes/api.js for Calendar.
//
// Three actions:
//   create — append a new row at the bottom of the user's tab. Stamps the
//            assigned row number into gigs.sheets_row_id so future updates
//            target the right row.
//   update — write the current gig values into the row identified by
//            sheets_row_id. No-op if the gig has no sheets_row_id (i.e.
//            wasn't imported from a sheet).
//   cancel — per Gareth's spec we DO NOT delete the sheet row. We mark it
//            as cancelled so the user's spreadsheet keeps its history and
//            row positions intact. If a "status" column exists we set it
//            to "Cancelled". Otherwise we prepend "[CANCELLED] " to the
//            band/act column. Notes column gets "TMG cancelled YYYY-MM-DD"
//            appended if mapped.

const { google } = require('googleapis');
const db = require('../db');
const { getGoogleAuthClient } = require('./google-auth');

// Cell value coercion: Sheets accepts strings; we format times and dates so
// they look right in the user's tab regardless of locale settings.
function formatGigField(gig, field) {
  if (gig == null) return '';
  const v = gig[field];
  if (v == null) return '';
  // Postgres TIME comes back as 'HH:MM:SS' — trim seconds for cleaner display.
  if (typeof v === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(v)) return v.slice(0, 5);
  // DATE comes back as 'YYYY-MM-DD' or as a Date object (depending on driver).
  if (v instanceof Date) {
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  if (typeof v === 'number') return String(v);
  return String(v);
}

// Build the row array using the user's column map. Unmapped columns get
// empty strings so the user's existing column count is preserved (Sheets
// otherwise won't write past the end of the existing data range).
function gigToRow(gig, columnMap, headers, opts) {
  const width = Math.max(
    Array.isArray(headers) ? headers.length : 0,
    ...Object.values(columnMap || {}).filter(n => typeof n === 'number')
  );
  const row = new Array(width + 1).fill('');
  const safeSet = (idx, val) => {
    if (typeof idx === 'number' && idx >= 0) row[idx] = val;
  };
  safeSet(columnMap.date, formatGigField(gig, 'date'));
  safeSet(columnMap.start_time, formatGigField(gig, 'start_time'));
  safeSet(columnMap.end_time, formatGigField(gig, 'end_time'));
  safeSet(columnMap.fee, gig.fee != null ? String(gig.fee) : '');
  safeSet(columnMap.band_name, formatGigField(gig, 'band_name'));
  safeSet(columnMap.venue_name, formatGigField(gig, 'venue_name'));
  safeSet(columnMap.venue_address, formatGigField(gig, 'venue_address'));
  safeSet(columnMap.client_name, formatGigField(gig, 'client_name'));
  safeSet(columnMap.notes, formatGigField(gig, 'notes'));
  // Cancellation handling: caller passes opts.cancelled when the gig is
  // being deleted in TMG. We mark the row visibly without removing it so
  // the user can see what TMG did (and undo from the sheet if they want).
  if (opts && opts.cancelled) {
    if (typeof columnMap.status === 'number' && columnMap.status >= 0) {
      safeSet(columnMap.status, 'Cancelled');
    } else if (typeof columnMap.band_name === 'number' && columnMap.band_name >= 0) {
      const existing = row[columnMap.band_name] || '';
      if (!existing.startsWith('[CANCELLED]')) {
        row[columnMap.band_name] = '[CANCELLED] ' + existing;
      }
    }
    if (typeof columnMap.notes === 'number' && columnMap.notes >= 0) {
      const stamp = new Date().toISOString().slice(0, 10);
      const existing = row[columnMap.notes] || '';
      const cancelNote = `(TMG cancelled ${stamp})`;
      row[columnMap.notes] = existing
        ? `${existing} ${cancelNote}`
        : cancelNote;
    }
  }
  return row;
}

// Pull the user's link record. Returns null if not linked or no map saved
// (which means write-back is intentionally off).
async function getLinkRecord(userId) {
  const r = await db.query(
    `SELECT google_sheets_id, google_sheets_tab, google_sheets_column_map,
            google_sheets_headers, google_sheets_drift
       FROM users WHERE id = $1`,
    [userId]
  );
  const row = r.rows[0];
  if (!row || !row.google_sheets_id || !row.google_sheets_tab) return null;
  if (!row.google_sheets_column_map) return null;
  return {
    spreadsheet_id: row.google_sheets_id,
    tab_name: row.google_sheets_tab,
    column_map: typeof row.google_sheets_column_map === 'string'
      ? JSON.parse(row.google_sheets_column_map)
      : row.google_sheets_column_map,
    headers: row.google_sheets_headers || [],
    drift: row.google_sheets_drift || null,
  };
}

// Layout-drift guard. The column map stores fixed indices, so a user who
// inserts, deletes, or reorders columns (or renames the tab) would otherwise
// have gig data written into the wrong cells with no warning. Compare the
// sheet's current header row against the one captured at link time; on any
// mismatch, flag drift and pause sync until the user re-links.
function _normHeaders(arr) {
  const out = (Array.isArray(arr) ? arr : []).map(v => String(v == null ? '' : v).trim());
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

function headersMatch(stored, current) {
  const s = _normHeaders(stored);
  const c = _normHeaders(current);
  if (s.length !== c.length) return false;
  return s.every((v, i) => v.toLowerCase() === c[i].toLowerCase());
}

async function setSheetsDrift(userId, kind) {
  try {
    await db.query('UPDATE users SET google_sheets_drift = $1 WHERE id = $2', [kind, userId]);
  } catch (_) {}
}

async function verifySheetLayout(sheets, link, userId) {
  // Links made before headers were captured can't be verified — let them
  // through rather than blocking sync they've always had.
  if (!Array.isArray(link.headers) || _normHeaders(link.headers).length === 0) return true;
  const safeTab = link.tab_name.replace(/'/g, "''");
  let current;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: link.spreadsheet_id,
      range: `'${safeTab}'!A1:Z1`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    current = (resp.data.values && resp.data.values[0]) || [];
  } catch (err) {
    // The range failing to parse means the tab was renamed or deleted.
    await setSheetsDrift(userId, 'tab_missing');
    console.error('[sheets-writer] layout check failed (tab renamed/deleted?), sync paused:', err && err.message);
    return false;
  }
  if (!headersMatch(link.headers, current)) {
    await setSheetsDrift(userId, 'headers_changed');
    console.error('[sheets-writer] header row changed since link, sync paused');
    return false;
  }
  if (link.drift) await setSheetsDrift(userId, null);
  return true;
}

async function getSheetsClient(userId) {
  const auth = await getGoogleAuthClient(userId, 'sheets');
  if (!auth) return null;
  return google.sheets({ version: 'v4', auth });
}

// Convert a row index (1-based, including header) to A1 range covering all
// of row N for our tab. We intentionally write to A:Z so any extra columns
// the user has beyond what we map stay untouched.
function rangeForRow(tabName, rowNum, width) {
  const safeTab = tabName.replace(/'/g, "''");
  const lastCol = colNumberToLetter(Math.max(width || 1, 1));
  return `'${safeTab}'!A${rowNum}:${lastCol}${rowNum}`;
}

function colNumberToLetter(n) {
  // 1 = A, 26 = Z, 27 = AA, etc. n here is 1-based.
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

// Main entry. action: 'create' | 'update' | 'cancel'.
async function writeGigToSheets(action, userId, gig) {
  if (!gig) return;
  try {
    const link = await getLinkRecord(userId);
    if (!link) return; // user not linked or no column map — silent no-op
    const sheets = await getSheetsClient(userId);
    if (!sheets) return; // token revoked / refresh failed — surfaced
                          // elsewhere via google_connection_state
    // Drift already flagged: stay paused until the user re-links. Otherwise
    // verify the layout right before writing (one cheap header read).
    if (link.drift) return;
    if (!(await verifySheetLayout(sheets, link, userId))) return;
    const safeTab = link.tab_name.replace(/'/g, "''");

    if (action === 'create') {
      // Append at the bottom. spreadsheets.values.append finds the next
      // empty row in the table region and writes there.
      const row = gigToRow(gig, link.column_map, link.headers);
      const resp = await sheets.spreadsheets.values.append({
        spreadsheetId: link.spreadsheet_id,
        range: `'${safeTab}'!A:A`, // append starts looking at column A
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
      // Pull the row number from the returned updatedRange so we can
      // round-trip future edits. updatedRange looks like
      // "'TabName'!A47:G47" — extract 47.
      const updated = resp.data && resp.data.updates && resp.data.updates.updatedRange;
      const m = updated && updated.match(/!A?(\d+):/);
      let rowNum = m ? parseInt(m[1], 10) : null;
      if (!rowNum) {
        // The row landed in the sheet but the response didn't tell us where.
        // Without a row number the gig would be orphaned (future edits
        // silently skipped), so fall back to reading the tab and taking the
        // last occupied row.
        try {
          const colResp = await sheets.spreadsheets.values.get({
            spreadsheetId: link.spreadsheet_id,
            range: `'${safeTab}'!A:Z`,
          });
          const count = (colResp.data.values || []).length;
          if (count >= 2) rowNum = count;
        } catch (e) {
          console.error('[sheets-writer] append row-number fallback failed:', e && e.message);
        }
      }
      if (rowNum) {
        await db.query(
          `UPDATE gigs SET sheets_row_id = $1, sheets_synced_at = NOW(),
                          sheets_updated_at = NOW()
            WHERE id = $2 AND user_id = $3`,
          [String(rowNum), gig.id, userId]
        );
      }
      return;
    }

    if (action === 'update') {
      if (!gig.sheets_row_id) return; // not previously imported from a sheet
      const rowNum = parseInt(gig.sheets_row_id, 10);
      if (!rowNum || rowNum < 2) return;
      const row = gigToRow(gig, link.column_map, link.headers);
      await sheets.spreadsheets.values.update({
        spreadsheetId: link.spreadsheet_id,
        range: rangeForRow(link.tab_name, rowNum, row.length),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });
      await db.query(
        `UPDATE gigs SET sheets_synced_at = NOW(), sheets_updated_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [gig.id, userId]
      );
      return;
    }

    if (action === 'cancel') {
      if (!gig.sheets_row_id) return;
      const rowNum = parseInt(gig.sheets_row_id, 10);
      if (!rowNum || rowNum < 2) return;
      const row = gigToRow(gig, link.column_map, link.headers, { cancelled: true });
      await sheets.spreadsheets.values.update({
        spreadsheetId: link.spreadsheet_id,
        range: rangeForRow(link.tab_name, rowNum, row.length),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });
      // No DB update needed — gig is being deleted by the caller and
      // sheets_synced_at on a deleted row is moot.
      return;
    }
  } catch (err) {
    // Never throw upward. We don't want a Sheets API failure to block a
    // gig save. Log loudly so we can spot patterns.
    console.error(`[sheets-writer] ${action} for gig ${gig && gig.id} failed:`, err && (err.message || err));
  }
}

module.exports = { writeGigToSheets, headersMatch };
