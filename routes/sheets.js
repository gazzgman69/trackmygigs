// Google Sheets two-way sync routes (Phase C+D+E).
//
// Phase C (this file, inbound):
//   POST /api/sheets/preview — given a Sheets URL/ID, return the tab list
//                              plus the first 10 rows of the chosen tab so
//                              the user can map columns.
//   POST /api/sheets/import  — given spreadsheet_id + tab + column_map,
//                              read every row and create gigs via the same
//                              dedup-aware logic the CSV importer uses.
//
// Phase D (outbound, separate file hooks):
//   gigs route hooks call helpers in this file to append/update/cancel
//   rows in the linked sheet on POST/PATCH/DELETE.
//
// Phase E (bidirectional):
//   POST /api/sheets/pull    — re-read the sheet, apply changes via
//                              last-write-wins by sheets_updated_at.
//
// Important: gigs imported via this surface DO NOT use the gcal:<id> source
// tag. They use sheets:<spreadsheet_id> so the cross-source dedup in
// /calendar/import-bulk and /api/gigs/import-bulk can soft-match against
// them on date+venue.

const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { getGoogleAuthClient, extractSpreadsheetId } = require('../lib/google-auth');

const router = express.Router();
router.use(authMiddleware);

// Resolve the user's Sheets API client. Returns null if Google isn't
// connected or refresh failed; callers should respond 401-ish so the UI
// can prompt a reconnect.
async function getSheetsClient(userId) {
  const auth = await getGoogleAuthClient(userId);
  if (!auth) return null;
  return google.sheets({ version: 'v4', auth });
}

// GET /api/sheets/status — is the current user linked to a sheet?
router.get('/status', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT google_sheets_id, google_sheets_tab, google_sheets_last_pulled_at,
              google_access_token IS NOT NULL AS has_token
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = r.rows[0] || {};
    res.json({
      connected: !!row.google_sheets_id,
      has_google_token: !!row.has_token,
      spreadsheet_id: row.google_sheets_id || null,
      tab_name: row.google_sheets_tab || null,
      last_pulled_at: row.google_sheets_last_pulled_at || null,
    });
  } catch (err) {
    console.error('[sheets] status error:', err.message);
    res.status(500).json({ error: 'Failed to read sheets status' });
  }
});

// POST /api/sheets/preview
// Body: { url_or_id: string, tab_name?: string }
// Returns: { spreadsheet_id, spreadsheet_title, tabs: [{name, row_count}],
//            tab_name: string, headers: string[], sample_rows: any[][] }
router.post('/preview', async (req, res) => {
  try {
    const sheetsClient = await getSheetsClient(req.user.id);
    if (!sheetsClient) {
      return res.status(401).json({ error: 'Google account not connected', needs_connect: true });
    }
    const spreadsheetId = extractSpreadsheetId(req.body && req.body.url_or_id);
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'Could not parse spreadsheet ID. Paste the full Google Sheets URL or just the ID.' });
    }

    // Fetch metadata: title + tab list with row counts.
    const meta = await sheetsClient.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets.properties(title,gridProperties(rowCount))',
    });
    const title = meta.data.properties && meta.data.properties.title || 'Untitled spreadsheet';
    const tabs = (meta.data.sheets || []).map(s => ({
      name: s.properties.title,
      row_count: (s.properties.gridProperties && s.properties.gridProperties.rowCount) || 0,
    }));
    if (tabs.length === 0) {
      return res.status(400).json({ error: 'That spreadsheet has no tabs' });
    }
    const tabName = (req.body && req.body.tab_name) || tabs[0].name;
    if (!tabs.find(t => t.name === tabName)) {
      return res.status(400).json({ error: `Tab "${tabName}" not found in this spreadsheet`, tabs });
    }

    // Pull first 11 rows (1 header + 10 sample). A1-style range, escape
    // single quotes in the tab name.
    const safeTab = tabName.replace(/'/g, "''");
    const range = `'${safeTab}'!A1:Z11`;
    const valuesResp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const rows = valuesResp.data.values || [];
    const headers = rows[0] || [];
    const sampleRows = rows.slice(1, 11);

    res.json({
      spreadsheet_id: spreadsheetId,
      spreadsheet_title: title,
      tabs,
      tab_name: tabName,
      headers,
      sample_rows: sampleRows,
    });
  } catch (err) {
    console.error('[sheets] preview error:', err && (err.message || err));
    const msg = err && err.errors && err.errors[0] && err.errors[0].message
      ? err.errors[0].message
      : (err.message || 'Failed to read spreadsheet');
    // 404 = wrong ID or not shared with this account; 403 = permission.
    if (err.code === 404) return res.status(404).json({ error: 'Spreadsheet not found. Check the URL is right and the file is owned by, or shared with, the Google account you connected.' });
    if (err.code === 403) return res.status(403).json({ error: 'No permission to read this spreadsheet. Share it with the connected Google account.' });
    res.status(500).json({ error: msg });
  }
});

// POST /api/sheets/import
// Body: { spreadsheet_id, tab_name, column_map: { date, start_time, ... },
//         link_for_sync?: boolean }
// If link_for_sync is true, this user becomes linked to this sheet (Phase D
// write-back will mirror future TMG edits back to the sheet rows).
router.post('/import', async (req, res) => {
  try {
    const sheetsClient = await getSheetsClient(req.user.id);
    if (!sheetsClient) {
      return res.status(401).json({ error: 'Google account not connected', needs_connect: true });
    }
    const spreadsheetId = req.body && req.body.spreadsheet_id;
    const tabName = req.body && req.body.tab_name;
    const columnMap = req.body && req.body.column_map;
    const linkForSync = req.body && req.body.link_for_sync !== false; // default true
    if (!spreadsheetId || !tabName || !columnMap || typeof columnMap.date !== 'number') {
      return res.status(400).json({ error: 'spreadsheet_id, tab_name, and column_map.date are required' });
    }

    const safeTab = tabName.replace(/'/g, "''");
    const valuesResp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${safeTab}'!A2:Z10000`, // skip header row, cap 10k data rows
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const rows = valuesResp.data.values || [];
    if (rows.length === 0) {
      return res.json({ imported: 0, merged: 0, skipped: 0, errors: [], gigs: [], total: 0 });
    }
    if (rows.length > 1500) {
      return res.status(413).json({ error: `Sheet has ${rows.length} data rows; cap is 1500. Split it across multiple imports.` });
    }

    // Translate Sheets rows into the same shape /api/gigs/import-bulk
    // accepts, then forward via the shared importer for consistent dedup.
    // Each row also gets a sheets_row_id (the absolute row number, 2-based
    // since row 1 is the header) so Phase D can find the row to update on
    // outbound writes.
    const events = rows.map((row, i) => {
      const get = (key) => {
        const idx = columnMap[key];
        if (typeof idx !== 'number' || idx < 0) return null;
        const v = row[idx];
        return v == null ? null : String(v).trim();
      };
      const feeRaw = get('fee');
      const fee = feeRaw ? feeRaw.replace(/[^0-9.\-]/g, '') : null;
      return {
        _row: i + 2,           // sheets row number (1 = header, 2 = first data)
        _sheets_row_id: i + 2, // saved into gigs.sheets_row_id below
        date: get('date'),
        start_time: get('start_time'),
        end_time: get('end_time'),
        fee: fee && fee !== '' ? parseFloat(fee) : null,
        band_name: get('band_name'),
        venue_name: get('venue_name'),
        venue_address: get('venue_address'),
        client_name: get('client_name'),
        notes: get('notes'),
      };
    });

    // Import via the shared bulk path. We call the same dedup + parsing
    // logic by invoking the helper inline rather than chaining HTTP. To do
    // that cleanly we replicate the loop here against the same library
    // functions.
    const result = await runSheetsImport({
      userId: req.user.id,
      spreadsheetId,
      filename: tabName,
      events,
    });

    // Optional: stamp the user record so future Phase D writes know which
    // sheet to mirror to.
    if (linkForSync) {
      await db.query(
        `UPDATE users
            SET google_sheets_id = $1,
                google_sheets_tab = $2,
                google_sheets_last_pulled_at = NOW()
          WHERE id = $3`,
        [spreadsheetId, tabName, req.user.id]
      );
    }

    res.json(result);
  } catch (err) {
    console.error('[sheets] import error:', err && (err.message || err));
    if (err.code === 404) return res.status(404).json({ error: 'Spreadsheet not found' });
    if (err.code === 403) return res.status(403).json({ error: 'No permission to read this spreadsheet' });
    res.status(500).json({ error: err.message || 'Sheets import failed' });
  }
});

// Shared dedup-aware bulk insert. Mirrors the logic in
// /api/gigs/import-bulk so Sheets imports get the exact same three-layer
// dedup behaviour. Stamps gigs.sheets_row_id on insert + merge so Phase D
// can locate the row to update on outbound writes.
async function runSheetsImport({ userId, spreadsheetId, filename, events }) {
  let imported = 0, merged = 0, skipped = 0;
  const errors = [];
  const gigs = [];

  function parseDateLike(s) {
    if (!s) return null;
    const v = String(s).trim();
    const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
    const uk = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (uk) {
      let day = parseInt(uk[1], 10);
      let month = parseInt(uk[2], 10);
      let year = parseInt(uk[3], 10);
      if (year < 100) year += 2000;
      if (day > 12 && month <= 12) {
        return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      }
      return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }

  function parseTimeLike(s) {
    if (!s) return null;
    const v = String(s).trim();
    const m24 = v.match(/^(\d{1,2})[:\.]?(\d{2})$/);
    if (m24) {
      const h = parseInt(m24[1], 10);
      const m = parseInt(m24[2], 10);
      if (h >= 0 && h < 24 && m >= 0 && m < 60) {
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      }
    }
    const m12 = v.match(/^(\d{1,2})[:\.](\d{2})\s*(am|pm)$/i);
    if (m12) {
      let h = parseInt(m12[1], 10);
      const m = parseInt(m12[2], 10);
      const ap = m12[3].toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    }
    return null;
  }

  for (const ev of events) {
    try {
      const rowNum = ev._row;
      const sheetsRowId = String(ev._sheets_row_id || rowNum);
      const date = parseDateLike(ev.date);
      if (!date) { skipped++; errors.push({ row: rowNum, message: `Could not parse date "${ev.date}"` }); continue; }
      const startTime = parseTimeLike(ev.start_time);
      const endTime = parseTimeLike(ev.end_time);
      const venueName = ev.venue_name ? String(ev.venue_name).trim() : null;
      const bandName = ev.band_name ? String(ev.band_name).trim() : null;

      // Synthetic key — md5 over user|date|venue|time|sheet so re-importing
      // the same sheet hits the existing row.
      const dedupRaw = `${userId}|${date}|${(venueName || '').toLowerCase()}|${startTime || ''}|sheets:${spreadsheetId}`;
      const dedupKey = `sheets:${crypto.createHash('md5').update(dedupRaw).digest('hex').slice(0, 16)}`;

      // Layer 1: same-sheet dedup
      let existing = await db.query(
        'SELECT * FROM gigs WHERE user_id = $1 AND google_event_id = $2 LIMIT 1',
        [userId, dedupKey]
      );

      // Layer 2: cross-source soft match (date + venue)
      if (existing.rows.length === 0 && venueName) {
        const soft = await db.query(
          `SELECT * FROM gigs
            WHERE user_id = $1
              AND date = $2
              AND LOWER(TRIM(venue_name)) = LOWER(TRIM($3))
              AND ($4::time IS NULL
                   OR start_time IS NULL
                   OR start_time = $4::time)
            LIMIT 1`,
          [userId, date, venueName, startTime]
        );
        if (soft.rows.length) existing = soft;
      }

      if (existing.rows.length) {
        const g = existing.rows[0];
        const newSource = g.source && !String(g.source).includes('sheets:')
          ? `${g.source}+sheets:${filename}`
          : (g.source || `sheets:${filename}`);
        const upd = await db.query(
          `UPDATE gigs
             SET band_name = COALESCE(band_name, $1),
                 venue_name = COALESCE(venue_name, $2),
                 venue_address = COALESCE(venue_address, $3),
                 start_time = COALESCE(start_time, $4),
                 end_time = COALESCE(end_time, $5),
                 fee = COALESCE(fee, $6),
                 client_name = COALESCE(client_name, $7),
                 notes = COALESCE(notes, $8),
                 source = $9,
                 sheets_row_id = COALESCE(sheets_row_id, $10),
                 sheets_updated_at = NOW()
           WHERE id = $11 AND user_id = $12
           RETURNING *`,
          [
            bandName,
            venueName,
            ev.venue_address ? String(ev.venue_address).trim() : null,
            startTime,
            endTime,
            ev.fee != null && ev.fee !== '' ? parseFloat(ev.fee) : null,
            ev.client_name ? String(ev.client_name).trim() : null,
            ev.notes ? String(ev.notes).trim() : null,
            newSource,
            sheetsRowId,
            g.id,
            userId,
          ]
        );
        gigs.push(upd.rows[0]);
        merged++;
      } else {
        const ins = await db.query(
          `INSERT INTO gigs (user_id, band_name, venue_name, venue_address,
                             date, start_time, end_time, fee, status, source,
                             client_name, notes, google_event_id, sheets_row_id,
                             sheets_updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
           RETURNING *`,
          [
            userId,
            bandName,
            venueName,
            ev.venue_address ? String(ev.venue_address).trim() : null,
            date,
            startTime,
            endTime,
            ev.fee != null && ev.fee !== '' ? parseFloat(ev.fee) : null,
            'confirmed',
            `sheets:${filename}`,
            ev.client_name ? String(ev.client_name).trim() : null,
            ev.notes ? String(ev.notes).trim() : null,
            dedupKey,
            sheetsRowId,
          ]
        );
        gigs.push(ins.rows[0]);
        imported++;
      }
    } catch (rowErr) {
      console.error('[sheets/import] row error:', rowErr.message);
      errors.push({ row: ev && ev._row, message: rowErr.message });
      skipped++;
    }
  }

  return { imported, merged, skipped, errors, gigs, total: events.length };
}

// POST /api/sheets/disconnect — clear the linked sheet record. Doesn't
// delete the imported gigs (those stay with their sheets:<file> source tag);
// just turns off Phase D outbound write-back.
router.post('/disconnect', async (req, res) => {
  try {
    await db.query(
      `UPDATE users SET google_sheets_id = NULL, google_sheets_tab = NULL,
                       google_sheets_last_pulled_at = NULL
        WHERE id = $1`,
      [req.user.id]
    );
    res.json({ disconnected: true });
  } catch (err) {
    console.error('[sheets] disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect sheet' });
  }
});

module.exports = router;
module.exports.runSheetsImport = runSheetsImport;
