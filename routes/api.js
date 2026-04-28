const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const calendarRouter = require('./calendar');
const { writeGigToSheets } = require('../lib/sheets-writer');
const { lookupPostcode, normalise: normalisePostcode } = require('../lib/postcodes');
const { haversineMiles } = require('../lib/geo');
const { normaliseE164 } = require('../lib/phone');
const { renderInvoicePdfBuffer, buildInvoiceFilename } = require('../lib/invoicePdf');

const router = express.Router();

router.use(authMiddleware);

// Coerce a client-supplied value into a Postgres text[] compatible array.
// Accepts an array (returned as-is), a comma-separated string (split on ,),
// or null/undefined (returned as null so COALESCE preserves existing value).
function toTextArray(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return null;
}

// 2026-04-28 dep-network batch: directory ranking that floats faces you
// already know to the top, then falls back to geo distance, with
// distance-nulls last. Reused by name / nearby / instrument_match modes so
// they stay in lockstep. Ties on count fall through to distance, ties on
// distance fall through to display name for stable ordering.
function networkRankComparator(a, b) {
  const ac = (a && a.gigs_together_count) || 0;
  const bc = (b && b.gigs_together_count) || 0;
  if (ac !== bc) return bc - ac;
  const ad = a && a.distance_miles, bd = b && b.distance_miles;
  if (ad == null && bd == null) {
    return String(a && a.display_name || '').localeCompare(String(b && b.display_name || ''));
  }
  if (ad == null) return 1;
  if (bd == null) return -1;
  if (ad !== bd) return ad - bd;
  return String(a && a.display_name || '').localeCompare(String(b && b.display_name || ''));
}

// 2026-04-28 dep-network batch: idempotent two-way contact upsert. Called
// inside the same transaction as Pick / FCFS take / dep-offer accept so the
// contact list stays in lockstep with the work agreement that triggered it.
// For each direction (A → B and B → A) we either INSERT a new contact row
// linked to the other user, or UPDATE notes to append the new gig context
// when one already exists. Failures are caught and logged: the chat thread
// already shipped, so a contact-write hiccup must never roll back the Pick.
async function upsertContactPair(client, userIdA, userIdB, contextNote) {
  if (!userIdA || !userIdB || userIdA === userIdB) return;
  try {
    // Snapshot both users at the moment of agreement. Using their current
    // display_name + instruments + outward postcode keeps the contact card
    // useful even if either side later edits their profile.
    const snap = await client.query(
      `SELECT id, COALESCE(display_name, name, email) AS name, instruments, home_postcode
         FROM users WHERE id = ANY($1::uuid[])`,
      [[userIdA, userIdB]]
    );
    const byId = {};
    for (const r of snap.rows) {
      const outward = r.home_postcode ? String(r.home_postcode).split(' ')[0] : null;
      byId[r.id] = { name: r.name || 'Musician', instruments: Array.isArray(r.instruments) ? r.instruments : [], outward };
    }
    const stamp = `Auto-added: ${contextNote}`;
    const note = `\n• ${contextNote}`;
    const pairs = [[userIdA, userIdB], [userIdB, userIdA]];
    for (const [owner, other] of pairs) {
      const target = byId[other];
      if (!target) continue;
      // Existing linked row? Append note (skip if already mentions this gig).
      const existing = await client.query(
        `SELECT id, notes FROM contacts
           WHERE owner_id = $1 AND linked_user_id = $2
           ORDER BY id ASC
           LIMIT 1`,
        [owner, other]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.notes && row.notes.includes(contextNote)) continue;
        const nextNotes = row.notes ? row.notes + note : stamp;
        await client.query(
          `UPDATE contacts SET notes = $1 WHERE id = $2`,
          [nextNotes, row.id]
        );
      } else {
        await client.query(
          `INSERT INTO contacts (owner_id, name, instruments, notes, location, linked_user_id)
           VALUES ($1, $2, $3::text[], $4, $5, $6)`,
          [owner, target.name, target.instruments, stamp, target.outward, other]
        );
      }
    }
  } catch (err) {
    console.warn('[upsertContactPair] non-fatal:', err && err.message);
  }
}

// Fire-and-forget helper — never let sync failures break API responses.
// The gig has already been saved locally; Google is a mirror. Phase D
// (2026-04-27) extends this to also mirror writes to the user's linked
// Google Sheet when one is configured. Both mirrors run in parallel; either
// can fail silently and the gig save still succeeds.
function syncGigSafely(action, userId, gig) {
  try {
    if (!gig) return;
    const fn = action === 'delete'
      ? calendarRouter.removeGigFromGoogle
      : calendarRouter.pushGigToGoogle;
    if (typeof fn === 'function') {
      Promise.resolve(fn(userId, gig)).catch((err) => {
        console.error(`Calendar ${action} sync failed (non-fatal):`, err.message || err);
      });
    }
    // Sheets write-back. action map: create→create, update→update,
    // delete→cancel (we mark cancelled rather than removing the row so the
    // user's sheet history stays intact).
    const sheetsAction = action === 'delete' ? 'cancel' : action;
    Promise.resolve(writeGigToSheets(sheetsAction, userId, gig)).catch((err) => {
      console.error(`Sheets ${sheetsAction} sync failed (non-fatal):`, err.message || err);
    });
  } catch (err) {
    console.error('syncGigSafely error:', err);
  }
}

// Same fire-and-forget shape as syncGigSafely, but for blocked_dates rows so
// manually-blocked unavailability mirrors to the user's Google Calendar as an
// all-day "Unavailable" event. `payload` is the full row on push and the
// google_event_id string on delete (since the row is already gone by then).
function syncBlockedDateSafely(action, userId, payload) {
  try {
    if (!payload) return;
    const fn = action === 'delete'
      ? calendarRouter.removeBlockedDateFromGoogle
      : calendarRouter.pushBlockedDateToGoogle;
    if (typeof fn !== 'function') return;
    Promise.resolve(fn(userId, payload)).catch((err) => {
      console.error(`Blocked-date ${action} sync failed (non-fatal):`, err.message || err);
    });
  } catch (err) {
    console.error('syncBlockedDateSafely error:', err);
  }
}

router.get('/gigs', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM gigs WHERE user_id = $1 ORDER BY date DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get gigs error:', error);
    res.status(500).json({ error: 'Failed to fetch gigs' });
  }
});

// Derive the stored fee from a rate per hour and the gig's start/end times.
// Kept server-side so a client that only sends rate_per_hour still lands a
// valid `fee` column (which Finance + invoicing read from).
function deriveTeachingFee({ fee, rate_per_hour, start_time, end_time }) {
  const feeNum = fee === null || fee === undefined || fee === '' ? NaN : parseFloat(fee);
  if (!isNaN(feeNum) && feeNum > 0) return feeNum;
  const rate = parseFloat(rate_per_hour);
  if (!rate || isNaN(rate) || rate <= 0) return null;
  if (!start_time || !end_time) return null;
  // Times arrive as 'HH:MM' or 'HH:MM:SS'. Split + reduce to minutes for a
  // lesson-safe duration (teaching slots are usually 30-60 min).
  const toMin = (t) => {
    const parts = String(t).split(':').map((n) => parseInt(n, 10));
    if (parts.length < 2 || parts.some((n) => isNaN(n))) return NaN;
    return parts[0] * 60 + parts[1];
  };
  const startMin = toMin(start_time);
  const endMin = toMin(end_time);
  if (isNaN(startMin) || isNaN(endMin) || endMin <= startMin) return null;
  const hours = (endMin - startMin) / 60;
  // Round to 2dp so 45 min at £50/hr lands on £37.50 cleanly.
  return Math.round(rate * hours * 100) / 100;
}

router.post('/gigs', async (req, res) => {
  try {
    const {
      band_name,
      venue_name,
      venue_address,
      date,
      start_time,
      end_time,
      load_in_time,
      fee,
      status,
      source,
      dress_code,
      notes,
      gig_type,
      parking_info,
      day_of_contact,
      mileage_miles,
      client_name,
      client_email,
      client_phone,
      rate_per_hour,
      venue_postcode,
    } = req.body;

    // Teaching: if the client didn't include an explicit fee but did include
    // a rate, compute the fee from rate x duration so Finance + the invoice
    // bundler agree with the wizard.
    const effectiveFee = gig_type === 'Teaching'
      ? deriveTeachingFee({ fee, rate_per_hour, start_time, end_time })
      : fee;

    // Distance filter: resolve venue_postcode to lat/lng if supplied. Unlike
    // the profile PATCH, we DON'T reject the save when the postcode is bogus
    // — the user might be typing an international venue or a rural "what3words
    // only" address. Bad postcode just leaves venue_lat/lng null, which means
    // broadcast distance filtering falls open for that gig. Good postcode gets
    // cached so broadcast doesn't re-geocode on every send.
    let gigPostcode = null;
    let venueLat = null;
    let venueLng = null;
    if (venue_postcode && String(venue_postcode).trim() !== '') {
      const n = normalisePostcode(venue_postcode);
      if (n) {
        gigPostcode = n;
        const loc = await lookupPostcode(n);
        if (loc) {
          venueLat = loc.lat;
          venueLng = loc.lng;
        }
      }
    }

    const result = await db.query(
      `INSERT INTO gigs (user_id, band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, gig_type, parking_info, day_of_contact, mileage_miles, client_name, client_email, client_phone, rate_per_hour, venue_postcode, venue_lat, venue_lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       RETURNING *`,
      [
        req.user.id,
        band_name,
        venue_name,
        venue_address,
        date,
        start_time,
        end_time,
        load_in_time,
        effectiveFee,
        status || 'confirmed',
        source || 'manual',
        dress_code,
        notes,
        gig_type || null,
        parking_info || null,
        day_of_contact || null,
        mileage_miles || null,
        client_name || null,
        client_email || null,
        client_phone || null,
        rate_per_hour || null,
        gigPostcode,
        venueLat,
        venueLng,
      ]
    );

    const gig = result.rows[0];
    syncGigSafely('create', req.user.id, gig);
    res.json(gig);
  } catch (error) {
    console.error('Create gig error:', error);
    // Postgres 23502 = not_null_violation, 22P02 = invalid_text_representation,
    // 22007 = invalid_datetime_format. All of these are client-input problems,
    // so surface them as 400 with the offending column rather than a generic
    // 500. Stress harness flagged this: POST /gigs with only { notes } was
    // triggering a NOT NULL on date and bubbling up as 500.
    if (error && (error.code === '23502' || error.code === '22P02' || error.code === '22007')) {
      return res.status(400).json({
        error: 'Missing or invalid field',
        field: error.column || null,
        detail: error.message,
      });
    }
    res.status(500).json({ error: 'Failed to create gig' });
  }
});

router.get('/gigs/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM gigs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get gig error:', error);
    res.status(500).json({ error: 'Failed to fetch gig' });
  }
});

router.patch('/gigs/:id', async (req, res) => {
  try {
    const { band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, checklist, gig_type, details_complete, set_times, parking_info, day_of_contact, mileage_miles, client_name, client_email, client_phone, rate_per_hour, venue_postcode } = req.body;
    // Teaching: recompute fee from rate if rate changed and fee wasn't sent
    // explicitly. We only substitute when the caller didn't pass a fee, so an
    // explicit £0 fee still wins (cancellation credits etc.).
    let effectiveFee = fee;
    if (gig_type === 'Teaching' && (fee === undefined || fee === null || fee === '') && rate_per_hour) {
      effectiveFee = deriveTeachingFee({ fee, rate_per_hour, start_time, end_time });
    }

    // Distance filter: re-geocode venue_postcode if the caller updated it.
    // Same "fall open on bad postcode" policy as POST /gigs.
    let gigPostcode = null;
    let venueLat = null;
    let venueLng = null;
    if (venue_postcode !== undefined && venue_postcode !== null && String(venue_postcode).trim() !== '') {
      const n = normalisePostcode(venue_postcode);
      if (n) {
        gigPostcode = n;
        const loc = await lookupPostcode(n);
        if (loc) {
          venueLat = loc.lat;
          venueLng = loc.lng;
        }
      }
    }

    const result = await db.query(
      `UPDATE gigs SET
        band_name = COALESCE($1, band_name), venue_name = COALESCE($2, venue_name),
        venue_address = COALESCE($3, venue_address), date = COALESCE($4, date),
        start_time = COALESCE($5, start_time), end_time = COALESCE($6, end_time),
        load_in_time = COALESCE($7, load_in_time), fee = COALESCE($8, fee),
        status = COALESCE($9, status), source = COALESCE($10, source),
        dress_code = COALESCE($11, dress_code), notes = COALESCE($12, notes),
        checklist = COALESCE($15, checklist), gig_type = COALESCE($16, gig_type),
        details_complete = COALESCE($17, details_complete),
        set_times = COALESCE($18, set_times),
        parking_info = COALESCE($19, parking_info),
        day_of_contact = COALESCE($20, day_of_contact),
        mileage_miles = COALESCE($21, mileage_miles),
        client_name = COALESCE($22, client_name),
        client_email = COALESCE($23, client_email),
        client_phone = COALESCE($24, client_phone),
        rate_per_hour = COALESCE($25, rate_per_hour),
        venue_postcode = COALESCE($26, venue_postcode),
        venue_lat = COALESCE($27, venue_lat),
        venue_lng = COALESCE($28, venue_lng),
        -- 2026-04-23: any user-initiated PATCH flips tmg_edited so sync-back
        -- to Google starts pushing changes. Imported-but-never-touched gigs
        -- stay read-only on the Google side until this flag flips.
        tmg_edited = TRUE
       WHERE id = $13 AND user_id = $14 RETURNING *`,
      [band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, effectiveFee, status, source, dress_code, notes, req.params.id, req.user.id, checklist ? JSON.stringify(checklist) : null, gig_type || null, details_complete != null ? details_complete : null, set_times ? JSON.stringify(set_times) : null, parking_info || null, day_of_contact || null, mileage_miles != null ? mileage_miles : null, client_name || null, client_email || null, client_phone || null, rate_per_hour || null, gigPostcode, venueLat, venueLng]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
    const gig = result.rows[0];
    syncGigSafely('update', req.user.id, gig);
    res.json(gig);
  } catch (error) {
    console.error('Update gig error:', error);
    res.status(500).json({ error: 'Failed to update gig' });
  }
});

router.delete('/gigs/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM gigs WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
    syncGigSafely('delete', req.user.id, result.rows[0]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete gig error:', error);
    res.status(500).json({ error: 'Failed to delete gig' });
  }
});

// ── BULK IMPORT FROM SPREADSHEET (CSV / XLSX) ────────────────────────────────
// Companion to /calendar/import-bulk for non-Google sources. The frontend
// parses the file in the browser (Papa Parse / SheetJS) and sends pre-mapped
// rows here. We dedupe on three axes:
//   1. Source-specific synthetic key — md5(user_id|date|venue_name|start_time)
//      stored in google_event_id. Re-importing the same file is idempotent.
//   2. Cross-source soft match — same user_id + same date + same venue_name
//      (case-insensitive). If found, MERGE rather than INSERT so a gig that
//      already arrived via Google Calendar doesn't duplicate when the same
//      booking shows up in a CSV.
//   3. Time conflict guard — if the candidate row has an explicit start_time
//      that DOESN'T match the existing row's start_time, treat it as a
//      separate gig (e.g. a teaching session in the morning + a dep gig in
//      the evening at the same venue).
//
// Body:
//   { source: 'csv' | 'xlsx', filename: string,
//     rows: [{ date, start_time?, end_time?, fee?, band_name?, venue_name?,
//              venue_address?, client_name?, notes? }, ...] }
// Returns: { imported, merged, skipped, errors, gigs, total }
router.post('/gigs/import-bulk', async (req, res) => {
  try {
    const sourceTag = ['csv', 'xlsx', 'sheets'].includes(req.body && req.body.source)
      ? req.body.source
      : 'csv';
    const filename = (req.body && req.body.filename) ? String(req.body.filename).slice(0, 200) : 'spreadsheet';
    const list = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];

    if (list.length === 0) return res.status(400).json({ error: 'No rows provided' });
    if (list.length > 1500) return res.status(413).json({ error: 'Too many rows (max 1500)' });

    let imported = 0;
    let merged = 0;
    let skipped = 0;
    const errors = [];
    const gigs = [];

    // Try ISO first, then DD/MM/YYYY (UK), then MM/DD/YYYY (US fallback).
    // Anything else returns null and the row is skipped with a clear reason.
    function parseDateLike(s) {
      if (!s) return null;
      const v = String(s).trim();
      // ISO: 2026-04-27 or 2026-04-27T10:00...
      const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
      // DD/MM/YYYY or DD-MM-YYYY (UK) — only if first segment is 1-31
      const uk = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (uk) {
        let day = parseInt(uk[1], 10);
        let month = parseInt(uk[2], 10);
        let year = parseInt(uk[3], 10);
        if (year < 100) year += 2000;
        if (day > 12 && month <= 12) {
          // Must be DD/MM
          return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        }
        // Ambiguous (both day and month <= 12): default to UK format since
        // app is UK-first. International users with US-format CSVs can save
        // their sheet with ISO dates to avoid the ambiguity.
        return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      }
      // Last-resort: let Date.parse have a go.
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
      return null;
    }

    function parseTimeLike(s) {
      if (!s) return null;
      const v = String(s).trim();
      // 24h: 19:30, 19.30, 1930
      const m24 = v.match(/^(\d{1,2})[:\.]?(\d{2})$/);
      if (m24) {
        const h = parseInt(m24[1], 10);
        const m = parseInt(m24[2], 10);
        if (h >= 0 && h < 24 && m >= 0 && m < 60) {
          return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        }
      }
      // 12h: 7:30 PM
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

    for (const ev of list) {
      try {
        const rowNum = ev._row || (list.indexOf(ev) + 1);
        const date = parseDateLike(ev.date);
        if (!date) {
          skipped++;
          errors.push({ row: rowNum, message: `Could not parse date "${ev.date}"` });
          continue;
        }
        const startTime = parseTimeLike(ev.start_time);
        const endTime = parseTimeLike(ev.end_time);
        const venueName = ev.venue_name ? String(ev.venue_name).trim() : null;
        const bandName = ev.band_name ? String(ev.band_name).trim() : null;

        // Synthetic dedup key — stable across re-imports of the same row.
        const dedupRaw = `${req.user.id}|${date}|${(venueName || '').toLowerCase()}|${startTime || ''}|${sourceTag}`;
        const dedupKey = `${sourceTag}:${crypto.createHash('md5').update(dedupRaw).digest('hex').slice(0, 16)}`;

        // Layer 1: same source repeat — if google_event_id already matches our
        // synthetic key, this row was already imported. Merge values in case
        // the user updated their spreadsheet between runs.
        const sameSrcExisting = await db.query(
          'SELECT * FROM gigs WHERE user_id = $1 AND google_event_id = $2 LIMIT 1',
          [req.user.id, dedupKey]
        );

        // Layer 2: cross-source soft match — same date + same venue (case-
        // insensitive). Skip the soft match if the candidate has an explicit
        // start_time that disagrees with the existing row's start_time.
        let crossSrcExisting = { rows: [] };
        if (sameSrcExisting.rows.length === 0 && venueName) {
          crossSrcExisting = await db.query(
            `SELECT * FROM gigs
              WHERE user_id = $1
                AND date = $2
                AND LOWER(TRIM(venue_name)) = LOWER(TRIM($3))
                AND ($4::time IS NULL
                     OR start_time IS NULL
                     OR start_time = $4::time)
              LIMIT 1`,
            [req.user.id, date, venueName, startTime]
          );
        }
        // Layer 2b (Demo 2026-04-28): venue-name match misses when calendar
        // and sheet name the venue differently (e.g. calendar location was
        // just the address "High St, Bicester" while the sheet has "The
        // Tythe Barn" as venue_name). Fall back to date + start_time +
        // band_name — a real user playing two gigs at the same time on the
        // same day with the same band name is essentially impossible. Only
        // fires when both rows have a band_name AND start_time, so generic
        // empty-band entries don't collapse together. Normalises band names
        // by stripping a leading "[Tag] " prefix and a trailing " @ <venue>"
        // suffix so the calendar's full event summary matches the sheet's
        // bare band name.
        if (sameSrcExisting.rows.length === 0
            && crossSrcExisting.rows.length === 0
            && bandName && startTime) {
          crossSrcExisting = await db.query(
            `SELECT * FROM gigs
              WHERE user_id = $1
                AND date = $2
                AND start_time = $3::time
                AND LOWER(regexp_replace(regexp_replace(TRIM(band_name), '^\\[[^\\]]+\\]\\s*', ''), '\\s+@\\s+.+$', ''))
                  = LOWER(regexp_replace(regexp_replace(TRIM($4::text), '^\\[[^\\]]+\\]\\s*', ''), '\\s+@\\s+.+$', ''))
              LIMIT 1`,
            [req.user.id, date, startTime, bandName]
          );
        }

        const existingRow = sameSrcExisting.rows[0] || crossSrcExisting.rows[0];

        if (existingRow) {
          // Merge: caller fills nulls, never overwrites a non-null. Preserves
          // hand-edited values. Append source tag if it's a different source.
          const newSource = existingRow.source && !existingRow.source.includes(sourceTag)
            ? `${existingRow.source}+${sourceTag}:${filename}`
            : (existingRow.source || `${sourceTag}:${filename}`);
          const updated = await db.query(
            `UPDATE gigs
               SET band_name = COALESCE(band_name, $1),
                   venue_name = COALESCE(venue_name, $2),
                   venue_address = COALESCE(venue_address, $3),
                   start_time = COALESCE(start_time, $4),
                   end_time = COALESCE(end_time, $5),
                   fee = COALESCE(fee, $6),
                   client_name = COALESCE(client_name, $7),
                   notes = COALESCE(notes, $8),
                   source = $9
             WHERE id = $10 AND user_id = $11
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
              existingRow.id,
              req.user.id,
            ]
          );
          gigs.push(updated.rows[0]);
          merged++;
        } else {
          const inserted = await db.query(
            `INSERT INTO gigs (user_id, band_name, venue_name, venue_address,
                               date, start_time, end_time, fee, status, source,
                               client_name, notes, google_event_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
            [
              req.user.id,
              bandName,
              venueName,
              ev.venue_address ? String(ev.venue_address).trim() : null,
              date,
              startTime,
              endTime,
              ev.fee != null && ev.fee !== '' ? parseFloat(ev.fee) : null,
              'confirmed',
              `${sourceTag}:${filename}`,
              ev.client_name ? String(ev.client_name).trim() : null,
              ev.notes ? String(ev.notes).trim() : null,
              dedupKey, // store synthetic key in google_event_id so the
                        // existing dedup index does its job
            ]
          );
          gigs.push(inserted.rows[0]);
          imported++;
        }
      } catch (rowErr) {
        console.error('[gigs/import-bulk] row error:', rowErr.message);
        errors.push({ row: ev && ev._row, message: rowErr.message });
        skipped++;
      }
    }

    res.json({ imported, merged, skipped, errors, gigs, total: list.length });
  } catch (error) {
    console.error('Spreadsheet bulk import error:', error);
    res.status(500).json({ error: 'Bulk import failed', detail: error.message });
  }
});

// Bulk-create teaching gigs from a weekly recurrence pattern. Example body:
//   { client_name, client_email, client_phone, rate_per_hour,
//     weekday: 1 /* 0=Sun..6=Sat */, start_time: '16:30', end_time: '17:30',
//     from_date: '2026-04-27', to_date: '2026-07-13',
//     venue_name, venue_address, notes, skip_dates: ['2026-05-25'] }
// Generates one Teaching gig per matching date in the range (inclusive), all
// with gig_type='Teaching' and fee derived from rate x duration. Returns the
// created gigs so the UI can refresh its cache. Bulk creation bypasses the
// Google Calendar sync helper per-row; the client should trigger a Sync Now
// after the response if they want to push the whole term to Google at once.
//
// Two input modes:
//   Weekly pattern: { weekday, from_date, to_date, skip_dates? }
//   Specific dates: { dates: ['2026-04-27', '2026-05-04', ...] }
// If `dates` is a non-empty array the weekly fields are ignored.
router.post('/gigs/teaching-term', async (req, res) => {
  try {
    const {
      client_name,
      client_email,
      client_phone,
      rate_per_hour,
      weekday,
      start_time,
      end_time,
      from_date,
      to_date,
      band_name,
      venue_name,
      venue_address,
      notes,
      skip_dates,
      dates: explicitDates,
    } = req.body || {};

    if (!start_time || !end_time) return res.status(400).json({ error: 'Start and end times required' });
    const rate = parseFloat(rate_per_hour);
    if (isNaN(rate) || rate <= 0) return res.status(400).json({ error: 'rate_per_hour required' });

    const MAX_LESSONS = 80; // a full academic year of weekly lessons, with headroom
    const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
    let dates;

    if (Array.isArray(explicitDates) && explicitDates.length > 0) {
      // Specific-dates mode: dedupe, validate, sort.
      const uniq = Array.from(new Set(explicitDates.map((d) => String(d).trim())));
      const bad = uniq.filter((d) => !ISO_RE.test(d));
      if (bad.length) return res.status(400).json({ error: `Invalid date format: ${bad[0]}` });
      dates = uniq.sort();
    } else {
      // Weekly-pattern mode.
      if (!from_date || !to_date) return res.status(400).json({ error: 'Date range required' });
      const wd = Number(weekday);
      if (isNaN(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: 'Weekday must be 0-6' });
      // Build the date list entirely in UTC to avoid DST shifts and off-by-one
      // errors when the server's local tz differs from the user's.
      const start = new Date(from_date + 'T00:00:00Z');
      const end = new Date(to_date + 'T00:00:00Z');
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
        return res.status(400).json({ error: 'Invalid date range' });
      }
      const skipSet = new Set(Array.isArray(skip_dates) ? skip_dates : []);
      dates = [];
      const cur = new Date(start);
      while (cur <= end) {
        if (cur.getUTCDay() === wd) {
          const iso = cur.toISOString().slice(0, 10);
          if (!skipSet.has(iso)) dates.push(iso);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      if (dates.length === 0) return res.status(400).json({ error: 'No dates match that weekday in the range' });
    }
    if (dates.length > MAX_LESSONS) return res.status(400).json({ error: `Produced ${dates.length} lessons; max is ${MAX_LESSONS}` });

    const fee = deriveTeachingFee({ rate_per_hour: rate, start_time, end_time });
    const band = band_name || (client_name ? client_name + ' (lesson)' : 'Teaching');
    const venue = venue_name || 'Lesson';

    // Per-row try/catch so a single bad row (e.g. unique-violation, bad DB
    // column) can't silently eat the other N-1 inserts. Any failures are
    // collected and returned to the client so the UI can show what actually
    // happened instead of just a generic 500.
    const created = [];
    const failed = [];
    for (const date of dates) {
      try {
        const row = await db.query(
          `INSERT INTO gigs (user_id, band_name, venue_name, venue_address, date, start_time, end_time, fee, status, source, notes, gig_type, client_name, client_email, client_phone, rate_per_hour)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', 'teaching_term', $9, 'Teaching', $10, $11, $12, $13)
           RETURNING *`,
          [
            req.user.id,
            band,
            venue,
            venue_address || null,
            date,
            start_time,
            end_time,
            fee,
            notes || null,
            client_name || null,
            client_email || null,
            client_phone || null,
            rate,
          ]
        );
        created.push(row.rows[0]);
      } catch (rowErr) {
        console.error(`Teaching-term insert failed for ${date}:`, rowErr && rowErr.message);
        failed.push({ date, error: rowErr && rowErr.message ? rowErr.message : 'insert failed' });
      }
    }
    console.log(`Teaching-term: requested=${dates.length} created=${created.length} failed=${failed.length} user=${req.user.id}`);
    // Fire Google Calendar syncs in the background but don't block the
    // response on them. The client shows a success toast and the pins
    // appear on the next Calendar refresh.
    for (const g of created) syncGigSafely('create', req.user.id, g);

    res.json({ count: created.length, requested: dates.length, failed, gigs: created });
  } catch (error) {
    console.error('Teaching-term bulk create error:', error);
    res.status(500).json({ error: 'Failed to create teaching term' });
  }
});

router.get('/invoices', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.post('/invoices', async (req, res) => {
  try {
    const { gig_id, band_name, amount, status, invoice_number, payment_terms, due_date,
            venue_address, venue_name, description, notes, recipient_email, recipient_address,
            payment_link_url_override } = req.body;

    const effectiveStatus = status || 'draft';
    const sentAt = effectiveStatus === 'sent' ? new Date() : null;

    // Universal pay-link (#292): mint a short public slug for every new
    // invoice so the email + PDF Pay Online button can resolve to a stable
    // /pay/<slug> URL without exposing the integer id. Slug is 10 hex chars
    // = ~40 bits of entropy, low collision probability across the lifetime
    // of a single account. Validation/normalisation of the override URL
    // mirrors the user-profile field — must be http(s), capped at 500 chars.
    const crypto = require('crypto');
    const publicPaySlug = crypto.randomBytes(5).toString('hex');
    let overrideValue = null;
    if (payment_link_url_override !== undefined && payment_link_url_override !== null) {
      const trimmed = String(payment_link_url_override).trim();
      if (trimmed) {
        if (!/^https?:\/\//i.test(trimmed)) {
          return res.status(400).json({ error: 'Pay link must start with http:// or https://', field: 'payment_link_url_override' });
        }
        overrideValue = trimmed.slice(0, 500);
      }
    }

    const result = await db.query(
      `INSERT INTO invoices (user_id, gig_id, band_name, amount, status, invoice_number, payment_terms, due_date,
                             venue_address, venue_name, description, notes, recipient_email, recipient_address, sent_at,
                             public_pay_slug, payment_link_url_override)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        req.user.id,
        gig_id,
        band_name,
        amount,
        effectiveStatus,
        invoice_number,
        payment_terms,
        due_date,
        venue_address || null,
        venue_name || null,
        description || null,
        notes || null,
        recipient_email || null,
        recipient_address || null,
        sentAt,
        publicPaySlug,
        overrideValue,
      ]
    );

    // Upsert into the saved client directory so the next invoice can
    // auto-suggest the name and auto-fill the address. Non-fatal: if this
    // fails we still return the invoice so the user's flow isn't blocked.
    const cleanClient = String(band_name || '').trim();
    if (cleanClient) {
      try {
        await db.query(
          `INSERT INTO invoice_clients (user_id, name, address, email, last_used_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, LOWER(name)) DO UPDATE
             SET address = COALESCE(EXCLUDED.address, invoice_clients.address),
                 email   = COALESCE(EXCLUDED.email, invoice_clients.email),
                 last_used_at = NOW()`,
          [req.user.id, cleanClient.slice(0, 255),
           recipient_address ? String(recipient_address) : null,
           recipient_email ? String(recipient_email).slice(0, 255) : null]
        );
      } catch (dirErr) {
        console.error('Invoice client upsert (non-fatal):', dirErr.message);
      }
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

router.get('/offers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         o.id, o.sender_id, o.recipient_id, o.gig_id, o.offer_type,
         o.status, o.fee, o.deadline, o.created_at, o.responded_at,
         o.snoozed_until, o.nudge_count, o.last_nudged_at,
         g.band_name, g.venue_name, g.venue_address,
         g.date as gig_date, g.start_time, g.end_time, g.dress_code,
         u.display_name as sender_display_name, u.name as sender_name
       FROM offers o
       LEFT JOIN gigs g ON g.id = o.gig_id
       LEFT JOIN users u ON u.id = o.sender_id
       WHERE o.recipient_id = $1 AND o.sender_id != $1
       ORDER BY COALESCE(o.last_nudged_at, o.created_at) DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get offers error:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

// Sent offers: same offer rows viewed from the sender side. Used by the
// Offers screen "Sent" tab so a user can see who they've sent dep offers
// to and the current status (pending / accepted / declined / expired /
// cancelled). Recipient display name is joined off users so the UI can
// show "Sent to Alex" without a second round-trip.
router.get('/offers/sent', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         o.id, o.sender_id, o.recipient_id, o.gig_id, o.offer_type,
         o.status, o.fee, o.deadline, o.created_at, o.responded_at,
         o.nudge_count, o.last_nudged_at,
         g.band_name, g.venue_name, g.venue_address,
         g.date as gig_date, g.start_time, g.end_time, g.dress_code,
         u.display_name as recipient_display_name, u.name as recipient_name
       FROM offers o
       LEFT JOIN gigs g ON g.id = o.gig_id
       LEFT JOIN users u ON u.id = o.recipient_id
       WHERE o.sender_id = $1
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get sent offers error:', error);
    res.status(500).json({ error: 'Failed to fetch sent offers' });
  }
});

// S7-08: snooze a single offer server-side. The client sends `hours` (float
// OK) and we stamp snoozed_until = NOW() + interval. Clearing a snooze is
// done by passing hours <= 0 (nullifies the column). Scoped by recipient_id
// so a sender can't snooze someone else's inbox.
router.post('/offers/:id/snooze', async (req, res) => {
  try {
    const { id } = req.params;
    const hoursRaw = Number(req.body && req.body.hours);
    const hours = Number.isFinite(hoursRaw) ? hoursRaw : 0;
    if (hours <= 0) {
      const cleared = await db.query(
        `UPDATE offers SET snoozed_until = NULL
           WHERE id = $1 AND recipient_id = $2 RETURNING *`,
        [id, req.user.id]
      );
      if (cleared.rows.length === 0) return res.status(404).json({ error: 'Offer not found' });
      return res.json(cleared.rows[0]);
    }
    const updated = await db.query(
      `UPDATE offers
         SET snoozed_until = NOW() + ($3 || ' hours')::interval
         WHERE id = $1 AND recipient_id = $2 RETURNING *`,
      [id, req.user.id, String(hours)]
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Offer not found' });
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('Snooze offer error:', error);
    res.status(500).json({ error: 'Failed to snooze offer' });
  }
});

router.patch('/offers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const result = await db.query(
      'UPDATE offers SET status = $1, responded_at = NOW() WHERE id = $2 AND recipient_id = $3 RETURNING *',
      [status, id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    // 2026-04-28 dep-network batch: when a dep accepts an offer, mirror the
    // Pick / FCFS auto-save behaviour so the band leader and dep both end up
    // in each other's contacts. Best-effort: a failure here must never roll
    // back the offer status flip, so it runs after the UPDATE has committed.
    if (status === 'accepted') {
      try {
        const offerRow = result.rows[0];
        const ctxRow = await db.query(
          `SELECT g.band_name, g.venue_name, g.date AS gig_date
             FROM gigs g WHERE g.id = $1`,
          [offerRow.gig_id]
        );
        const ctx = ctxRow.rows[0] || {};
        const dateStr = ctx.gig_date ? new Date(ctx.gig_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        const ctxNote = `Dep offer: ${ctx.band_name || 'gig'}${ctx.venue_name ? ' at ' + ctx.venue_name : ''}${dateStr ? ', ' + dateStr : ''}`;
        await upsertContactPair(db, offerRow.sender_id, offerRow.recipient_id, ctxNote);
      } catch (contactErr) {
        console.warn('[PATCH /offers/:id] contact upsert failed:', contactErr);
      }
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update offer error:', error);
    res.status(500).json({ error: 'Failed to update offer' });
  }
});

// Full offer details for the dep-accepted / dep-detail panels.
// Returns the offer joined with the gig and sender, plus lineup info.
router.get('/offers/:id/details', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT
         o.id, o.sender_id, o.recipient_id, o.gig_id, o.offer_type,
         o.status, o.fee, o.deadline, o.created_at, o.responded_at,
         g.band_name, g.venue_name, g.venue_address,
         g.date as gig_date, g.start_time, g.end_time, g.load_in_time,
         g.dress_code, g.day_of_contact, g.parking_info, g.set_times,
         g.notes as gig_notes,
         u.display_name as sender_display_name, u.name as sender_name,
         u.email as sender_email, u.phone as sender_phone
       FROM offers o
       LEFT JOIN gigs g ON g.id = o.gig_id
       LEFT JOIN users u ON u.id = o.sender_id
       WHERE o.id = $1 AND (o.recipient_id = $2 OR o.sender_id = $2)`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get offer details error:', error);
    res.status(500).json({ error: 'Failed to fetch offer details' });
  }
});

// Cancel an accepted dep. Optionally suggests a replacement, which creates
// a new pending dep offer on the same gig addressed to the replacement user.
// Notifies the band leader (sender of the original dep offer) via a system
// message in the gig thread so they know the dep has dropped out.
router.post('/offers/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, replacement_user_id } = req.body || {};

    const offerRes = await db.query(
      `SELECT o.*, g.band_name, g.venue_name, g.date as gig_date
         FROM offers o LEFT JOIN gigs g ON g.id = o.gig_id
         WHERE o.id = $1 AND o.recipient_id = $2 AND o.status = 'accepted'`,
      [id, req.user.id]
    );
    if (offerRes.rows.length === 0) {
      return res.status(404).json({ error: 'Accepted offer not found' });
    }
    const offer = offerRes.rows[0];

    // Validate replacement_user_id (if provided) BEFORE mutating anything.
    // The replacement becomes the recipient of a new offer issued under the
    // band leader's sender_id, so without validation a cancelling dep could
    // cause the leader to spam any user addressable by UUID. We require the
    // replacement to be in the cancelling dep's own contacts as a linked TMG
    // user; it must also not be the dep themselves or the original sender.
    if (replacement_user_id) {
      if (replacement_user_id === req.user.id) {
        return res.status(400).json({ error: 'Cannot suggest yourself as replacement' });
      }
      if (replacement_user_id === offer.sender_id) {
        return res.status(400).json({ error: 'Cannot suggest the original sender as replacement' });
      }
      const contactCheck = await db.query(
        `SELECT 1 FROM contacts
           WHERE owner_id = $1 AND contact_user_id = $2 LIMIT 1`,
        [req.user.id, replacement_user_id]
      );
      if (contactCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Replacement must be one of your contacts' });
      }
    }

    // Mark the original offer cancelled. Repeat the recipient filter here as
    // defense-in-depth so the UPDATE is still scoped even if the SELECT guard
    // above is ever refactored.
    await db.query(
      `UPDATE offers SET status = 'cancelled', responded_at = NOW()
         WHERE id = $1 AND recipient_id = $2 AND status = 'accepted'`,
      [id, req.user.id]
    );

    // If a replacement was suggested, create a new pending dep offer for them.
    let replacementOfferId = null;
    if (replacement_user_id) {
      const newOffer = await db.query(
        `INSERT INTO offers (sender_id, recipient_id, gig_id, offer_type, status, fee)
         VALUES ($1, $2, $3, 'dep', 'pending', $4)
         RETURNING id`,
        [offer.sender_id, replacement_user_id, offer.gig_id, offer.fee]
      );
      replacementOfferId = newOffer.rows[0].id;
    }

    // Notify band leader (original sender) by posting a system message into
    // any existing gig thread. If no thread exists yet, skip silently.
    try {
      const threadRes = await db.query(
        `SELECT id FROM threads WHERE gig_id = $1 AND participant_ids @> ARRAY[$2::uuid] LIMIT 1`,
        [offer.gig_id, offer.sender_id]
      );
      if (threadRes.rows.length > 0) {
        const tid = threadRes.rows[0].id;
        const reasonText = reason ? ` Reason: ${reason}.` : '';
        const replacementText = replacement_user_id
          ? ` A replacement offer has been sent.`
          : '';
        await db.query(
          `INSERT INTO messages (thread_id, sender_id, content) VALUES ($1, $2, $3)`,
          [tid, req.user.id, `I can no longer make ${offer.band_name || 'this gig'}.${reasonText}${replacementText}`]
        );
      }
    } catch (msgErr) {
      console.error('Cancel-dep notify error (non-fatal):', msgErr.message);
    }

    res.json({ success: true, replacement_offer_id: replacementOfferId });
  } catch (error) {
    console.error('Cancel dep error:', error);
    res.status(500).json({ error: 'Failed to cancel dep' });
  }
});

// Sender-side withdrawal of a PENDING offer. The existing /cancel route is
// scoped to recipients cancelling after they've accepted, so we can't reuse
// it here without breaking that semantics. This one only touches offers the
// current user sent and that are still pending; accepted offers must go
// through the recipient's cancel flow instead.
router.post('/offers/:id/withdraw', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await db.query(
      `UPDATE offers SET status = 'cancelled', responded_at = NOW()
         WHERE id = $1 AND sender_id = $2 AND status = 'pending'
         RETURNING id`,
      [id, req.user.id]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Pending offer not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Withdraw offer error:', error);
    res.status(500).json({ error: 'Failed to withdraw offer' });
  }
});

// Nudge cap (2026-04-23): sender reminds the recipient about an already-sent
// dep offer without creating a duplicate offer row. Hard cap of 2 nudges per
// offer (so the total touches on a single gig per recipient is 3: one initial
// send plus up to two nudges). After 2 nudges the endpoint returns 409 and
// the sender must wait for a response (accept / decline) or withdraw.
//
// Authorization: caller must be the sender; offer must still be 'pending'.
// If the recipient has blocked the sender (via user_blocks), the nudge is
// silently refused as 404 so we don't leak block state.
router.post('/offers/:id/nudge', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.query(
      `SELECT o.id, o.status, o.nudge_count, o.recipient_id, o.sender_id, o.gig_id
         FROM offers o
         WHERE o.id = $1 AND o.sender_id = $2
         LIMIT 1`,
      [id, req.user.id]
    );
    if (row.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }
    const offer = row.rows[0];

    // Block-check: if recipient has blocked the sender (or vice versa), pretend
    // the offer does not exist. Symmetric to how directory search handles blocks.
    const blockCheck = await db.query(
      `SELECT 1 FROM user_blocks
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)
         LIMIT 1`,
      [offer.sender_id, offer.recipient_id]
    );
    if (blockCheck.rows.length > 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    if (offer.status !== 'pending') {
      return res.status(409).json({
        error: 'Offer is no longer pending',
        status: offer.status,
      });
    }
    if (offer.nudge_count >= 2) {
      return res.status(409).json({
        error: 'No nudges left',
        nudge_count: offer.nudge_count,
        nudges_remaining: 0,
      });
    }

    const updated = await db.query(
      `UPDATE offers
         SET nudge_count = nudge_count + 1,
             last_nudged_at = NOW()
       WHERE id = $1 AND sender_id = $2 AND status = 'pending' AND nudge_count < 2
       RETURNING id, nudge_count, last_nudged_at`,
      [id, req.user.id]
    );
    if (updated.rows.length === 0) {
      // Race: another request raced past the cap check. Treat as 409.
      return res.status(409).json({ error: 'Nudge rejected by race-condition guard' });
    }
    const r = updated.rows[0];
    res.json({
      success: true,
      offer_id: r.id,
      nudge_count: r.nudge_count,
      nudges_remaining: Math.max(0, 2 - r.nudge_count),
      last_nudged_at: r.last_nudged_at,
    });
  } catch (error) {
    console.error('Nudge offer error:', error);
    res.status(500).json({ error: 'Failed to nudge offer' });
  }
});

router.get('/user/profile', async (req, res) => {
  try {
    // Demo 2026-04-28 bug 2: Profile screen rendered "0 Gigs / 0 Acts / £0
    // Earned" for users who clearly had data because /user/profile was
    // shipping the raw user row only — gigs_count, acts_count and
    // total_earned were never computed. Compute them here in one round
    // trip so the Profile card matches Home's tax-year totals (which are
    // confirmed-only per the financial-views memory). Acts count is the
    // distinct band_name values across all of the user's gigs.
    const userId = req.user.id;
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const taxYearStart = (month > 4 || (month === 4 && day >= 6))
      ? `${now.getFullYear()}-04-06`
      : `${now.getFullYear() - 1}-04-06`;
    const stats = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM gigs WHERE user_id = $1)                                      AS gigs_count,
         (SELECT COUNT(DISTINCT band_name)::int FROM gigs
            WHERE user_id = $1 AND band_name IS NOT NULL AND band_name <> '')                     AS acts_count,
         (SELECT COALESCE(SUM(fee), 0)::int FROM gigs
            WHERE user_id = $1 AND status = 'confirmed' AND date >= $2)                           AS total_earned`,
      [userId, taxYearStart]
    );
    const counts = stats.rows[0] || { gigs_count: 0, acts_count: 0, total_earned: 0 };
    res.json({ ...req.user, ...counts });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.patch('/user/profile', async (req, res) => {
  try {
    const { name, display_name, phone, instruments, home_postcode, avatar_url, google_review_url, facebook_review_url,
            bank_details, invoice_prefix, invoice_next_number, invoice_format, colour_theme,
            epk_bio, epk_photo_url, epk_video_url, epk_audio_url,
            rate_standard, rate_premium, rate_dep, rate_deposit_pct, rate_notes,
            travel_radius_miles,
            business_address, business_phone, vat_number,
            discoverable, bio, photo_url, genres,
            min_fee_pence, notify_free_gigs,
            payment_link_url, allow_direct_messages } = req.body;

    // Universal pay-link (#292): http(s) URLs only, capped at 500 chars.
    // Empty string clears the field (user opts out of the pay-link button).
    // Validate up front so the rest of the patch doesn't run if invalid.
    let payLinkProvided = false;
    let payLinkValue = null;
    if (payment_link_url !== undefined) {
      payLinkProvided = true;
      const trimmed = String(payment_link_url || '').trim();
      if (!trimmed) {
        payLinkValue = null;
      } else if (/^https?:\/\//i.test(trimmed)) {
        payLinkValue = trimmed.slice(0, 500);
      } else {
        return res.status(400).json({ error: 'Pay link must start with http:// or https://', field: 'payment_link_url' });
      }
    }

    // instruments comes as a comma-separated string from the client but the
    // column is TEXT[].  Convert it to a proper PG array (or null to keep
    // the existing value via COALESCE).
    let instrumentsArr = null;
    if (instruments) {
      instrumentsArr = instruments.split(',').map(s => s.trim()).filter(Boolean);
    }

    // Phase IX-E: Directory profile fields.
    // discoverable is a boolean so it can't ride the COALESCE trick (false would
    // be treated as "keep existing"). Use a CASE guarded by a provided-flag,
    // same pattern as phone_normalized above.
    let discoverableProvided = false;
    let discoverableValue = null;
    if (discoverable !== undefined) {
      discoverableProvided = true;
      discoverableValue = !!discoverable;
    }

    // bio: 280-char cap (matches Find Musicians card display). Trim whitespace,
    // collapse empties to NULL so the directory doesn't show a blank card.
    let bioValue = null;
    let bioProvided = false;
    if (bio !== undefined) {
      bioProvided = true;
      const trimmed = String(bio || '').trim();
      bioValue = trimmed ? trimmed.slice(0, 280) : null;
    }

    // photo_url: only accept http/https. Reject data: and javascript: URIs so a
    // compromised client can't smuggle an XSS payload into a directory card.
    let photoUrlValue = null;
    let photoUrlProvided = false;
    if (photo_url !== undefined) {
      photoUrlProvided = true;
      const trimmed = String(photo_url || '').trim();
      if (!trimmed) {
        photoUrlValue = null;
      } else if (/^https?:\/\//i.test(trimmed)) {
        photoUrlValue = trimmed.slice(0, 500);
      } else {
        return res.status(400).json({ error: 'Photo URL must start with http:// or https://', field: 'photo_url' });
      }
    }

    // genres: accept array or comma-separated string. Cap each tag at 40 chars
    // and the whole list at 8 entries so one user can't bloat the index.
    let genresArr = null;
    if (genres !== undefined) {
      let list = [];
      if (Array.isArray(genres)) {
        list = genres;
      } else if (typeof genres === 'string') {
        list = genres.split(',');
      }
      genresArr = list
        .map(s => String(s || '').trim())
        .filter(Boolean)
        .map(s => s.slice(0, 40))
        .slice(0, 8);
      // Empty array is meaningful (user cleared their genres); keep it as []
      // rather than NULL so the next COALESCE doesn't resurrect old values.
    }

    // Phase X: Urgent-gigs marketplace preferences. Both can be meaningfully
    // FALSE/0 so they ride provided-flag CASE-WHEN rather than COALESCE.
    // min_fee_pence is clamped 0..100000 (£0..£1000) - anything outside is
    // almost certainly a typo by someone who thinks the field is in pounds.
    let minFeeProvided = false;
    let minFeeValue = null;
    if (min_fee_pence !== undefined) {
      minFeeProvided = true;
      const n = parseInt(min_fee_pence, 10);
      if (!isFinite(n)) {
        return res.status(400).json({ error: 'Minimum fee must be a number', field: 'min_fee_pence' });
      }
      minFeeValue = Math.max(0, Math.min(100000, n));
    }
    let notifyFreeProvided = false;
    let notifyFreeValue = null;
    if (notify_free_gigs !== undefined) {
      notifyFreeProvided = true;
      notifyFreeValue = !!notify_free_gigs;
    }

    // 2026-04-28 chat batch: directory open-DM toggle. Same provided-flag
    // pattern as discoverable so a missing field doesn't get coerced to
    // FALSE (which would silently turn the toggle off on every other patch).
    let allowDmProvided = false;
    let allowDmValue = null;
    if (allow_direct_messages !== undefined) {
      allowDmProvided = true;
      allowDmValue = !!allow_direct_messages;
    }

    // Distance filter (roadmap Phase VI): whenever the user supplies a
    // home_postcode, resolve it to lat/lng via postcodes.io and store the
    // normalised postcode alongside. If the postcode is present but invalid,
    // return 400 so the client can show an inline error — we cannot accept a
    // bogus postcode and then silently skip the geocode, because every
    // broadcast would then fall open for that user.
    let normalisedPostcode = null;
    let homeLat = null;
    let homeLng = null;
    if (home_postcode !== undefined && home_postcode !== null && String(home_postcode).trim() !== '') {
      normalisedPostcode = normalisePostcode(home_postcode);
      if (!normalisedPostcode) {
        return res.status(400).json({ error: 'Invalid postcode format', field: 'home_postcode' });
      }
      const loc = await lookupPostcode(normalisedPostcode);
      if (!loc) {
        return res.status(400).json({ error: 'Postcode not found', field: 'home_postcode' });
      }
      homeLat = loc.lat;
      homeLng = loc.lng;
    }

    // travel_radius_miles: integer, 1..500. Anything outside the range gets
    // clamped so the UI slider can stay liberal without blowing up the SQL.
    let radius = null;
    if (travel_radius_miles !== undefined && travel_radius_miles !== null && travel_radius_miles !== '') {
      const r = parseInt(travel_radius_miles, 10);
      if (isFinite(r)) radius = Math.max(1, Math.min(500, r));
    }

    // Phase IX-A: whenever the user edits their phone number, derive the
    // E.164 canonical and store it in phone_normalized so the Phase IX-B
    // directory phone-mode lookup (exact match) finds the row regardless of
    // how it was typed. An unparseable phone clears phone_normalized to NULL
    // rather than leaving a stale canonical pointing at an old number.
    let phoneNormalized = null;
    let phoneNormalizedProvided = false;
    if (phone !== undefined) {
      phoneNormalizedProvided = true;
      phoneNormalized = phone ? normaliseE164(phone) : null;
    }

    const result = await db.query(
      `UPDATE users SET name = COALESCE($1, name),
       display_name = COALESCE($14, display_name),
       phone = COALESCE($2, phone), instruments = COALESCE($3::text[], instruments),
       home_postcode = COALESCE($4, home_postcode), avatar_url = COALESCE($5, avatar_url),
       google_review_url = COALESCE($6, google_review_url), facebook_review_url = COALESCE($7, facebook_review_url),
       bank_details = COALESCE($9, bank_details), invoice_prefix = COALESCE($10, invoice_prefix),
       invoice_next_number = COALESCE($11, invoice_next_number), invoice_format = COALESCE($12, invoice_format),
       colour_theme = COALESCE($13, colour_theme),
       epk_bio = COALESCE($15, epk_bio),
       epk_photo_url = COALESCE($16, epk_photo_url),
       epk_video_url = COALESCE($17, epk_video_url),
       epk_audio_url = COALESCE($18, epk_audio_url),
       rate_standard = COALESCE($19, rate_standard),
       rate_premium = COALESCE($20, rate_premium),
       rate_dep = COALESCE($21, rate_dep),
       rate_deposit_pct = COALESCE($22, rate_deposit_pct),
       rate_notes = COALESCE($23, rate_notes),
       home_lat = COALESCE($24, home_lat),
       home_lng = COALESCE($25, home_lng),
       travel_radius_miles = COALESCE($26, travel_radius_miles),
       phone_normalized = CASE WHEN $27::boolean THEN $28 ELSE phone_normalized END,
       discoverable = CASE WHEN $29::boolean THEN $30::boolean ELSE discoverable END,
       bio = CASE WHEN $31::boolean THEN $32 ELSE bio END,
       photo_url = CASE WHEN $33::boolean THEN $34 ELSE photo_url END,
       genres = CASE WHEN $35::boolean THEN $36::text[] ELSE genres END,
       business_address = COALESCE($37, business_address),
       business_phone = COALESCE($38, business_phone),
       vat_number = COALESCE($39, vat_number),
       min_fee_pence = CASE WHEN $40::boolean THEN $41::integer ELSE min_fee_pence END,
       notify_free_gigs = CASE WHEN $42::boolean THEN $43::boolean ELSE notify_free_gigs END,
       allow_direct_messages = CASE WHEN $44::boolean THEN $45::boolean ELSE allow_direct_messages END
       WHERE id = $8 RETURNING *`,
      [name, phone, instrumentsArr, normalisedPostcode, avatar_url, google_review_url, facebook_review_url, req.user.id,
       bank_details, invoice_prefix, invoice_next_number, invoice_format, colour_theme, display_name,
       epk_bio, epk_photo_url, epk_video_url, epk_audio_url,
       rate_standard || null, rate_premium || null, rate_dep || null,
       rate_deposit_pct != null && rate_deposit_pct !== '' ? parseInt(rate_deposit_pct, 10) : null,
       rate_notes, homeLat, homeLng, radius,
       phoneNormalizedProvided, phoneNormalized,
       discoverableProvided, discoverableValue,
       bioProvided, bioValue,
       photoUrlProvided, photoUrlValue,
       genresArr !== null, genresArr,
       (business_address !== undefined && business_address !== null) ? String(business_address) : null,
       (business_phone !== undefined && business_phone !== null) ? String(business_phone).slice(0, 64) : null,
       (vat_number !== undefined && vat_number !== null) ? String(vat_number).slice(0, 64) : null,
       minFeeProvided, minFeeValue,
       notifyFreeProvided, notifyFreeValue,
       allowDmProvided, allowDmValue]
    );

    // Apply payment_link_url as a follow-up UPDATE so we don't have to thread
    // it through the (already busy) main UPDATE's positional parameters. The
    // outer SELECT * RETURNING re-runs to keep the response fresh.
    let row = result.rows[0];
    if (payLinkProvided && row) {
      const r2 = await db.query(
        'UPDATE users SET payment_link_url = $1 WHERE id = $2 RETURNING *',
        [payLinkValue, req.user.id]
      );
      if (r2.rows[0]) row = r2.rows[0];
    }

    res.json(row);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Generate / set a public slug for share + EPK links
router.post('/user/slug', async (req, res) => {
  try {
    let { slug } = req.body;
    // If blank, derive from name / email
    if (!slug || !String(slug).trim()) {
      const base = (req.user.display_name || req.user.name || req.user.email || 'artist')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'artist';
      slug = base;
    } else {
      slug = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    }
    if (!slug) return res.status(400).json({ error: 'Invalid slug' });

    // Collision-safe: try base, then base-2, base-3, ...
    let candidate = slug;
    let attempt = 1;
    while (true) {
      const existing = await db.query('SELECT id FROM users WHERE public_slug = $1 AND id <> $2', [candidate, req.user.id]);
      if (existing.rows.length === 0) break;
      attempt += 1;
      candidate = `${slug}-${attempt}`;
      if (attempt > 50) return res.status(500).json({ error: 'Could not allocate slug' });
    }

    await db.query('UPDATE users SET public_slug = $1 WHERE id = $2', [candidate, req.user.id]);
    res.json({ slug: candidate });
  } catch (error) {
    console.error('Set slug error:', error);
    res.status(500).json({ error: 'Failed to set slug' });
  }
});

// Mark the user as onboarded (dismiss the tour)
router.post('/user/onboarded', async (req, res) => {
  try {
    await db.query('UPDATE users SET onboarded_at = COALESCE(onboarded_at, NOW()) WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Onboarded error:', error);
    res.status(500).json({ error: 'Failed to mark onboarded' });
  }
});

// BUG-AUDIT-01: notification preferences get/set.
// Defaults: every channel opted-in until the user says otherwise. A missing key is treated as true.
router.get('/user/notification-preferences', async (req, res) => {
  try {
    const result = await db.query('SELECT notification_preferences FROM users WHERE id = $1', [req.user.id]);
    const raw = (result.rows[0] && result.rows[0].notification_preferences) || {};
    const defaults = {
      dep_offers: true,
      chat: true,
      gig_reminders: true,
      invoices: true,
      weekly: true,
      email_important: true
    };
    // Merge stored prefs on top of defaults so a newly-added channel does not come back undefined.
    res.json(Object.assign({}, defaults, raw));
  } catch (error) {
    console.error('Get notification preferences error:', error);
    res.status(500).json({ error: 'Failed to load notification preferences' });
  }
});

router.post('/user/notification-preferences', async (req, res) => {
  try {
    const body = req.body || {};
    // Accept only the known boolean flags. Anything else is dropped so clients can not smuggle data into the JSONB.
    const allowed = ['dep_offers', 'chat', 'gig_reminders', 'invoices', 'weekly', 'email_important'];
    const prefs = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, key)) prefs[key] = !!body[key];
    }
    await db.query(
      'UPDATE users SET notification_preferences = $1::jsonb WHERE id = $2',
      [JSON.stringify(prefs), req.user.id]
    );
    res.json({ ok: true, prefs });
  } catch (error) {
    console.error('Save notification preferences error:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// Log nudge feedback so scoring can be tuned later
router.post('/nudge-feedback', async (req, res) => {
  try {
    const { nudge_type, gig_id, action } = req.body;
    if (!nudge_type || !action) return res.status(400).json({ error: 'nudge_type and action required' });
    await db.query(
      'INSERT INTO nudge_feedback (user_id, nudge_type, gig_id, action) VALUES ($1, $2, $3, $4)',
      [req.user.id, nudge_type, gig_id || null, action]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Nudge feedback error:', error);
    res.status(500).json({ error: 'Failed to log feedback' });
  }
});

// ── Expenses / Receipts ──────────────────────────────────────────────────────
// Uses the receipts table from schema (vendor=description, category, date, amount)

router.get('/expenses', async (req, res) => {
  try {
    // S13-09: include gig_id so the client can show "linked to Red Lion gig"
    // badges and so the Gig detail panel can surface receipts filed against it.
    const gigFilter = req.query.gig_id ? ' AND gig_id = $2' : '';
    const params = req.query.gig_id ? [req.user.id, req.query.gig_id] : [req.user.id];
    const result = await db.query(
      `SELECT id, vendor AS description, amount, category, date, gig_id
         FROM receipts
        WHERE user_id = $1${gigFilter}
        ORDER BY date DESC`,
      params
    );
    res.json({ expenses: result.rows });
  } catch (error) {
    console.error('Get expenses error:', error);
    res.json({ expenses: [] });
  }
});

// S13-14: Bound receipt description length server-side so the client can't
// post a runaway multi-megabyte string.
const RECEIPT_DESCRIPTION_MAX = 200;

// S13-16: Format the date server-side if the client didn't send one, using
// UTC as a stable fallback. For users in later timezones this still lands on
// the expected calendar day because we use the local now(), not new Date().
function todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

router.post('/expenses', async (req, res) => {
  try {
    const { amount, description, date, category, gig_id } = req.body;
    // S13-14: validate description length
    if (description && String(description).length > RECEIPT_DESCRIPTION_MAX) {
      return res.status(400).json({ error: `Description is too long. Keep it under ${RECEIPT_DESCRIPTION_MAX} characters.` });
    }
    // S13-09: persist the optional gig_id foreign key when the user logs an
    // expense from inside a gig detail screen. Falls through to NULL when not set.
    const gigIdValue = (gig_id === '' || gig_id === null || gig_id === undefined)
      ? null
      : gig_id;
    // S13-16: accept client-supplied ISO date; fall back to a local today string
    // rather than a raw Date object (which gets cast to UTC by node-postgres and
    // can land on the previous day for UK users after 00:00 local time in BST).
    const dateValue = date && /^\d{4}-\d{2}-\d{2}/.test(String(date))
      ? String(date).slice(0, 10)
      : todayIsoDate();
    const result = await db.query(
      `INSERT INTO receipts (user_id, vendor, amount, category, date, gig_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, vendor AS description, amount, category, date, gig_id`,
      [req.user.id, description, amount, category || 'Other', dateValue, gigIdValue]
    );
    res.json({ success: true, expense: result.rows[0] });
  } catch (error) {
    console.error('Create expense error:', error);
    res.status(500).json({ error: 'Failed to save expense' });
  }
});

// S13-13: Edit an existing expense. Required fields match POST; each one is
// optional and only applied if present. Ownership is enforced via WHERE user_id.
router.patch('/expenses/:id', async (req, res) => {
  try {
    const { amount, description, date, category, gig_id } = req.body;
    if (description && String(description).length > RECEIPT_DESCRIPTION_MAX) {
      return res.status(400).json({ error: `Description is too long. Keep it under ${RECEIPT_DESCRIPTION_MAX} characters.` });
    }
    const fields = [];
    const params = [];
    let idx = 1;
    if (amount !== undefined && amount !== null && amount !== '') { fields.push(`amount = $${idx++}`); params.push(amount); }
    if (description !== undefined) { fields.push(`vendor = $${idx++}`); params.push(description); }
    if (date !== undefined && /^\d{4}-\d{2}-\d{2}/.test(String(date))) { fields.push(`date = $${idx++}`); params.push(String(date).slice(0, 10)); }
    if (category !== undefined) { fields.push(`category = $${idx++}`); params.push(category); }
    if (gig_id !== undefined) {
      const v = (gig_id === '' || gig_id === null) ? null : gig_id;
      fields.push(`gig_id = $${idx++}`);
      params.push(v);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    params.push(req.params.id, req.user.id);
    const result = await db.query(
      `UPDATE receipts SET ${fields.join(', ')}
       WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING id, vendor AS description, amount, category, date, gig_id`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.json({ success: true, expense: result.rows[0] });
  } catch (error) {
    console.error('Update expense error:', error);
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// S13-13: Delete an expense. Ownership enforced via user_id.
router.delete('/expenses/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM receipts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete expense error:', error);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

// ── Blocked Dates ────────────────────────────────────────────────────────────
// Uses existing blocked_dates table; stores range start in date, reason, and
// recurring_pattern for recurring/range modes

// S13-02: expand recurring and range patterns server-side so every client gets
// the same list of blocked dates without re-implementing the expansion.
// Horizon is 18 months from today so calendar views one year out still work.
function expandBlockedRow(row, horizonMonths = 18) {
  const out = [];
  const startStr = row.date instanceof Date
    ? row.date.toISOString().slice(0, 10)
    : String(row.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr)) return out;

  const start = new Date(startStr + 'T00:00:00Z');
  const horizon = new Date(start);
  horizon.setUTCMonth(horizon.getUTCMonth() + horizonMonths);

  const pattern = row.recurring_pattern || null;

  // Single date
  if (!pattern) {
    out.push(startStr);
    return out;
  }

  // Range: "range:YYYY-MM-DD"
  if (pattern.startsWith('range:')) {
    const endStr = pattern.slice(6);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endStr)) { out.push(startStr); return out; }
    const end = new Date(endStr + 'T00:00:00Z');
    for (let d = new Date(start); d <= end && d <= horizon; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  // Recurring: "recurring:mon,tue,..." or "recurring:0,1,..." (0=Sun)
  if (pattern.startsWith('recurring:')) {
    const raw = pattern.slice(10).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const dow = raw.map(x => {
      if (map[x] !== undefined) return map[x];
      const n = parseInt(x, 10);
      return (!isNaN(n) && n >= 0 && n <= 6) ? n : null;
    }).filter(n => n !== null);
    if (dow.length === 0) { out.push(startStr); return out; }
    for (let d = new Date(start); d <= horizon; d.setUTCDate(d.getUTCDate() + 1)) {
      if (dow.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  out.push(startStr);
  return out;
}

router.get('/blocked-dates', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM blocked_dates WHERE user_id = $1 ORDER BY date ASC',
      [req.user.id]
    );
    // Keep the response a flat array (back-compat with clients that expect
    // Array.isArray(data) === true), but enrich each row with expanded_dates
    // and normalized start_date/end_date fields so the calendar can render
    // recurring and range blocks without re-implementing the expansion.
    const rowsOut = result.rows.map(row => {
      const dates = expandBlockedRow(row);
      const startIso = row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10);
      const endIso = dates.length > 0 ? dates[dates.length - 1] : startIso;
      return {
        ...row,
        start_date: startIso,
        end_date: endIso,
        expanded_dates: dates,
      };
    });
    res.json(rowsOut);
  } catch (error) {
    console.error('Get blocked dates error:', error);
    res.status(500).json({ error: 'Failed to fetch blocked dates' });
  }
});

router.post('/blocked-dates', async (req, res) => {
  try {
    const { mode, date, from, to, reason, days } = req.body;
    const dateValue = mode === 'single' ? date : from;
    const pattern = mode === 'recurring' && days ? `recurring:${days.join(',')}` :
                    mode === 'range' && to ? `range:${to}` : null;
    const inserted = await db.query(
      `INSERT INTO blocked_dates (user_id, date, reason, recurring_pattern)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [req.user.id, dateValue, reason || null, pattern]
    );
    // Mirror to Google only if a new row actually landed — ON CONFLICT DO NOTHING
    // is silent, and re-pushing an unchanged block would create duplicate events.
    if (inserted.rowCount > 0 && inserted.rows[0] && inserted.rows[0].id) {
      const rowRes = await db.query(
        'SELECT * FROM blocked_dates WHERE id = $1 AND user_id = $2',
        [inserted.rows[0].id, req.user.id]
      );
      if (rowRes.rows[0]) {
        syncBlockedDateSafely('push', req.user.id, rowRes.rows[0]);
      }
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Block date error:', error);
    res.status(500).json({ error: 'Failed to block date' });
  }
});

// S13-03: Bulk block multiple dates in a single transaction. Accepts
// { dates: ['2026-05-01', '2026-05-02', ...], reason? } and inserts all rows
// atomically so partial failures don't leave the calendar in a mixed state.
router.post('/blocked-dates/bulk', async (req, res) => {
  try {
    const { dates, reason } = req.body || {};
    if (!Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({ error: 'dates (non-empty array) is required' });
    }
    // Validate the shape so bad payloads can't poison the table.
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const clean = Array.from(new Set(dates.map(d => String(d).slice(0, 10)).filter(d => iso.test(d))));
    if (clean.length === 0) {
      return res.status(400).json({ error: 'No valid ISO dates supplied' });
    }

    const client = await db.getClient ? db.getClient() : null;
    let inserted = 0;
    // Collect every newly-inserted row so we can mirror each one to Google.
    // We rely on RETURNING * so duplicates (silent via ON CONFLICT) don't
    // produce phantom pushes that would spawn extra all-day events.
    const insertedRows = [];
    if (client) {
      // Prefer explicit transaction if the db adapter exposes getClient.
      try {
        await client.query('BEGIN');
        for (const d of clean) {
          const r = await client.query(
            `INSERT INTO blocked_dates (user_id, date, reason, recurring_pattern)
             VALUES ($1, $2, $3, NULL)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [req.user.id, d, reason || null]
          );
          inserted += r.rowCount || 0;
          for (const row of r.rows) insertedRows.push(row);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        if (client.release) client.release();
      }
    } else {
      // Fallback: multi-row INSERT via a VALUES list — still one round-trip.
      const values = [];
      const params = [req.user.id, reason || null];
      clean.forEach((d, i) => {
        values.push(`($1, $${i + 3}, $2, NULL)`);
        params.push(d);
      });
      const r = await db.query(
        `INSERT INTO blocked_dates (user_id, date, reason, recurring_pattern)
         VALUES ${values.join(', ')}
         ON CONFLICT DO NOTHING
         RETURNING *`,
        params
      );
      inserted = r.rowCount || 0;
      for (const row of r.rows) insertedRows.push(row);
    }

    // Fire-and-forget: Google failures must not break bulk block responses.
    for (const row of insertedRows) {
      syncBlockedDateSafely('push', req.user.id, row);
    }

    res.json({ success: true, inserted, attempted: clean.length });
  } catch (error) {
    console.error('Bulk block error:', error);
    res.status(500).json({ error: 'Failed to block dates' });
  }
});

// S13-05: DELETE a single blocked date by id. Required so users can unblock
// dates they added by mistake — previously they had to edit the DB directly.
router.delete('/blocked-dates/:id', async (req, res) => {
  try {
    const r = await db.query(
      'DELETE FROM blocked_dates WHERE id = $1 AND user_id = $2 RETURNING id, google_event_id',
      [req.params.id, req.user.id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    // If this block was mirrored to Google, tear down the event too so the
    // user's external calendar doesn't keep advertising them as busy.
    const googleEventId = r.rows[0] && r.rows[0].google_event_id;
    if (googleEventId) {
      syncBlockedDateSafely('delete', req.user.id, googleEventId);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Unblock date error:', error);
    res.status(500).json({ error: 'Failed to unblock date' });
  }
});

// ── Dep Offers ───────────────────────────────────────────────────────────────
// Uses the existing offers table (offer_type='dep', status='pending')

router.post('/dep-offers', async (req, res) => {
  try {
    const { gig_id, role, message, mode, contact_ids } = req.body;
    if (!gig_id) return res.status(400).json({ error: 'Gig is required' });

    // Load the gig's venue lat/lng once so we can filter recipients by the
    // distance each would have to travel. If the gig has no postcode on file
    // (pre-Phase VI rows or rural gigs), venueLat/lng are null and distance
    // filtering falls open for every recipient.
    const gigResult = await db.query(
      'SELECT venue_lat, venue_lng, venue_postcode FROM gigs WHERE id = $1 AND user_id = $2',
      [gig_id, req.user.id]
    );
    if (gigResult.rows.length === 0) {
      return res.status(404).json({ error: 'Gig not found' });
    }
    const venueLat = gigResult.rows[0].venue_lat;
    const venueLng = gigResult.rows[0].venue_lng;

    // Load candidate contacts for this user
    let contactRows = [];
    if (mode === 'pick' && Array.isArray(contact_ids) && contact_ids.length > 0) {
      const { rows } = await db.query(
        `SELECT id, contact_user_id, email, phone, instruments
           FROM contacts
          WHERE owner_id = $1 AND id = ANY($2::uuid[])`,
        [req.user.id, contact_ids]
      );
      contactRows = rows;
    } else if (mode === 'all') {
      // Broadcast to favourite contacts, optionally filtered by role keyword
      const { rows } = await db.query(
        `SELECT id, contact_user_id, email, phone, instruments
           FROM contacts
          WHERE owner_id = $1
            AND (is_favourite = true OR $2::text IS NULL
                 OR EXISTS (SELECT 1 FROM unnest(instruments) inst WHERE inst ILIKE '%' || $2 || '%'))`,
        [req.user.id, role || null]
      );
      contactRows = rows;
    } else {
      return res.status(400).json({ error: 'Select contacts or choose broadcast mode' });
    }

    if (contactRows.length === 0) {
      return res.status(400).json({ error: 'No matching contacts found' });
    }

    let sent = 0;
    let unresolved = 0;
    let filteredOutOfRange = 0;
    // Rich per-contact result so pick mode can show a "3 of 5 will see this"
    // summary modal. Broadcast ignores this payload; it only cares about
    // sent/unresolved counts.
    const outOfRangeContacts = [];
    // Nudge cap (2026-04-23): contacts with a still-pending offer for this gig
    // from this sender. Not counted as sent; UI should redirect to nudge.
    const alreadySent = [];

    for (const c of contactRows) {
      // Resolve to a users.id
      let recipientId = c.contact_user_id;
      if (!recipientId && c.email) {
        const { rows } = await db.query(
          'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
          [c.email]
        );
        if (rows[0]) {
          recipientId = rows[0].id;
          await db.query(
            'UPDATE contacts SET contact_user_id = $1 WHERE id = $2 AND owner_id = $3',
            [recipientId, c.id, req.user.id]
          );
        }
      }
      if (!recipientId && c.phone) {
        const normalised = String(c.phone).replace(/[^\d+]/g, '');
        const { rows } = await db.query(
          'SELECT id FROM users WHERE regexp_replace(coalesce(phone,$2), $1, $2, $3) = $4 LIMIT 1',
          ['[^0-9+]', '', 'g', normalised]
        );
        if (rows[0]) {
          recipientId = rows[0].id;
          await db.query(
            'UPDATE contacts SET contact_user_id = $1 WHERE id = $2 AND owner_id = $3',
            [recipientId, c.id, req.user.id]
          );
        }
      }
      if (!recipientId || recipientId === req.user.id) {
        unresolved++;
        continue;
      }

      // Block check (2026-04-23): if either side has blocked the other, the
      // send is silently dropped. No leak to the sender that a block exists;
      // the contact looks unresolved from their side. Mirrors directory and
      // nudge endpoint symmetry.
      const blockRow = await db.query(
        `SELECT 1 FROM user_blocks
           WHERE (blocker_id = $1 AND blocked_id = $2)
              OR (blocker_id = $2 AND blocked_id = $1)
           LIMIT 1`,
        [req.user.id, recipientId]
      );
      if (blockRow.rows.length > 0) {
        unresolved++;
        continue;
      }

      // Distance filter (roadmap Phase VI).
      //   - Broadcast (mode === 'all'): hard filter. Contacts outside their
      //     own stated travel radius never see the offer.
      //   - Pick (mode === 'pick'): soft warning. We still send the offer
      //     — the sender made a deliberate choice — but we flag it in the
      //     response so the frontend can show a "sent with override" toast.
      if (venueLat != null && venueLng != null) {
        const { rows: urows } = await db.query(
          'SELECT id, home_lat, home_lng, travel_radius_miles, display_name, name FROM users WHERE id = $1',
          [recipientId]
        );
        const u = urows[0];
        if (u && u.home_lat != null && u.home_lng != null) {
          const dist = haversineMiles(u.home_lat, u.home_lng, venueLat, venueLng);
          const radius = u.travel_radius_miles != null ? u.travel_radius_miles : 50;
          if (dist != null && dist > radius) {
            if (mode === 'all') {
              filteredOutOfRange++;
              outOfRangeContacts.push({
                recipient_id: recipientId,
                name: u.display_name || u.name || null,
                distance_miles: Math.round(dist),
                radius_miles: radius,
              });
              continue; // hard filter: do NOT insert the offer
            }
            // Pick mode: fall through and send, but note it on the response.
            outOfRangeContacts.push({
              recipient_id: recipientId,
              name: u.display_name || u.name || null,
              distance_miles: Math.round(dist),
              radius_miles: radius,
              overridden: true,
            });
          }
        }
      }

      // Nudge cap (2026-04-23): if an offer for this (sender, recipient, gig)
      // is already pending, do NOT create a duplicate row. The correct action
      // is to nudge the existing offer via POST /api/offers/:id/nudge. Track
      // as "already sent" on the response so pick-mode can surface "You've
      // already offered this to X — nudge them instead?" inline.
      const existing = await db.query(
        `SELECT id, nudge_count FROM offers
         WHERE sender_id = $1 AND recipient_id = $2 AND gig_id = $3 AND status = 'pending'
         LIMIT 1`,
        [req.user.id, recipientId, gig_id]
      );
      if (existing.rows.length > 0) {
        alreadySent.push({
          recipient_id: recipientId,
          existing_offer_id: existing.rows[0].id,
          nudge_count: existing.rows[0].nudge_count,
          nudges_remaining: Math.max(0, 2 - existing.rows[0].nudge_count),
        });
        continue;
      }

      await db.query(
        `INSERT INTO offers (sender_id, recipient_id, gig_id, offer_type, status, fee)
         VALUES ($1, $2, $3, 'dep', 'pending',
                 (SELECT fee FROM gigs WHERE id = $3 AND user_id = $1))`,
        [req.user.id, recipientId, gig_id]
      );
      sent++;
    }

    res.json({
      success: true,
      sent,
      unresolved,
      total: contactRows.length,
      filtered_out_of_range: filteredOutOfRange,
      out_of_range_contacts: outOfRangeContacts,
      already_sent: alreadySent,
    });
  } catch (error) {
    console.error('Create dep offer error:', error);
    res.status(500).json({ error: 'Failed to send dep offer' });
  }
});

// ── Google Places Proxy ─────────────────────────────────────────────────────
// Keeps the API key server-side. Frontend calls /api/places?q=...

router.get('/places', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return res.json({ predictions: [] });

  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ predictions: [] });

  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=establishment&components=country:gb&key=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json({ predictions: (data.predictions || []).slice(0, 5) });
  } catch (error) {
    console.error('Places autocomplete error:', error);
    res.json({ predictions: [] });
  }
});

router.get('/places/detail', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return res.json({ result: null });

  const placeId = req.query.place_id;
  if (!placeId) return res.json({ result: null });

  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,formatted_address,geometry&key=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json({ result: data.result || null });
  } catch (error) {
    console.error('Places detail error:', error);
    res.json({ result: null });
  }
});

// ── Distance Matrix Proxy ────────────────────────────────────────────────────
// Returns miles & drive time from user's home postcode to a venue address

// Format an ISO-8601-ish duration string from Routes API ("13578s") into
// human "X hr Y min" / "Y min" so the front-end can drop it straight in.
function formatRoutesDuration(durationStr) {
  if (!durationStr) return null;
  const seconds = parseInt(String(durationStr).replace(/[^0-9]/g, ''), 10);
  if (!seconds) return null;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  return `${minutes} min`;
}

router.get('/distance', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) {
    console.error('[distance] GOOGLE_PLACES_KEY not set');
    return res.json({ distance: null, error: 'key_missing' });
  }

  const origin = req.query.origin;
  const dest = req.query.destination;
  if (!origin || !dest) return res.json({ distance: null, error: 'missing_params' });

  // Try the modern Routes API first (Google's recommended replacement for
  // Distance Matrix). Falls back to legacy Distance Matrix only if Routes
  // returns a hard "API not enabled" error.
  try {
    const routesResp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: dest },
        travelMode: 'DRIVE',
        units: 'IMPERIAL',
      }),
    });
    const routesData = await routesResp.json();

    if (routesResp.ok && routesData.routes && routesData.routes[0]?.distanceMeters) {
      const meters = routesData.routes[0].distanceMeters;
      const miles = Math.round(meters / 1609.34);
      return res.json({
        distance: `${miles} mi`,
        duration: formatRoutesDuration(routesData.routes[0].duration),
        miles,
      });
    }

    // Routes API returned an error. Log + fall through to legacy.
    const routesErr = routesData?.error || {};
    console.error('[distance] Routes API error', {
      http: routesResp.status,
      code: routesErr.code,
      status: routesErr.status,
      message: routesErr.message,
    });

    // If Routes is genuinely not enabled, try the legacy Distance Matrix
    // as a last resort so users don't see a blank field while the GCP
    // project is being updated.
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(dest)}&units=imperial&key=${key}`;
    const legacyResp = await fetch(url);
    const legacyData = await legacyResp.json();
    const element = legacyData.rows?.[0]?.elements?.[0];
    if (element?.status === 'OK') {
      return res.json({
        distance: element.distance?.text || null,
        duration: element.duration?.text || null,
        miles: element.distance ? Math.round(element.distance.value / 1609.34) : null,
      });
    }

    console.error('[distance] Legacy Distance Matrix also failed', {
      top_status: legacyData.status,
      top_error: legacyData.error_message,
      element_status: element?.status,
    });
    return res.json({
      distance: null,
      error: routesErr.status || legacyData.status || 'unknown',
      error_message: routesErr.message || legacyData.error_message || null,
      hint: 'Enable Routes API (or legacy Distance Matrix API) in the Google Cloud project for this key.',
    });
  } catch (error) {
    console.error('[distance] fetch threw', error);
    return res.json({ distance: null, error: 'fetch_failed', error_message: String(error) });
  }
});

// ── Stats / Dashboard ───────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    // Calculate tax year (Apr 6 - Apr 5)
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();
    let taxYearStart;
    if (currentMonth > 4 || (currentMonth === 4 && currentDay >= 6)) {
      taxYearStart = `${now.getFullYear()}-04-06`;
    } else {
      taxYearStart = `${now.getFullYear() - 1}-04-06`;
    }

    // Run all queries in parallel instead of sequentially
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .split('T')[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString()
      .split('T')[0];

    const [
      nextGigResult,
      thisMonthResult,
      taxYearResult,
      overdueCombinedResult,
      draftCombinedResult,
      unreadResult,
      offersCombinedResult,
      activeDepResult,
      monthlyBreakdownResult,
      recentMessagesResult,
      missingFeeResult,
    ] = await Promise.all([
      // Next gig
      db.query(
        `SELECT * FROM gigs WHERE user_id = $1 AND date >= $2 AND status IN ('confirmed', 'enquiry')
         ORDER BY date ASC LIMIT 1`,
        [userId, today]
      ),
      // This month earnings & count
      db.query(
        `SELECT COALESCE(SUM(fee), 0) as earnings, COUNT(*) as count FROM gigs
         WHERE user_id = $1 AND date >= $2 AND date <= $3 AND status = 'confirmed'`,
        [userId, monthStart, monthEnd]
      ),
      // Tax year earnings & count
      db.query(
        `SELECT COALESCE(SUM(fee), 0) as earnings, COUNT(*) as count FROM gigs
         WHERE user_id = $1 AND date >= $2 AND status = 'confirmed'`,
        [userId, taxYearStart]
      ),
      // Overdue invoices: preview row (first overdue) + total count + total amount
      // in a single round-trip instead of two separate queries.
      db.query(
        `SELECT
           (SELECT COUNT(*) FROM invoices WHERE user_id = $1 AND status = 'sent' AND due_date < $2)::int AS count,
           (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE user_id = $1 AND status = 'sent' AND due_date < $2) AS total,
           (SELECT row_to_json(i) FROM (
              SELECT id, amount, band_name FROM invoices
              WHERE user_id = $1 AND status = 'sent' AND due_date < $2
              ORDER BY due_date ASC LIMIT 1
           ) i) AS preview`,
        [userId, today]
      ),
      // Draft invoices: preview row + count + total in a single round-trip.
      db.query(
        `SELECT
           (SELECT COUNT(*) FROM invoices WHERE user_id = $1 AND status = 'draft')::int AS count,
           (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE user_id = $1 AND status = 'draft') AS total,
           (SELECT row_to_json(i) FROM (
              SELECT id, amount, band_name FROM invoices
              WHERE user_id = $1 AND status = 'draft'
              ORDER BY created_at DESC LIMIT 1
           ) i) AS preview`,
        [userId]
      ),
      // Unread messages
      db.query(
        `SELECT COUNT(*) as count FROM messages
         WHERE thread_id IN (SELECT id FROM threads WHERE participant_ids @> ARRAY[$1::uuid])
         AND NOT (read_by @> ARRAY[$1::uuid])`,
        [userId]
      ),
      // Pending offers + dep-specific (network) subset in a single round-trip.
      db.query(
        `SELECT
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE offer_type = 'dep')::int AS dep_count
         FROM offers
         WHERE recipient_id = $1 AND status = 'pending'`,
        [userId]
      ),
      // Outgoing active dep request (user sent, awaiting cover)
      db.query(
        `SELECT o.id, o.created_at, o.deadline, g.id as gig_id, g.band_name,
                g.venue_name, g.date, g.start_time, g.end_time
         FROM offers o
         JOIN gigs g ON g.id = o.gig_id
         WHERE o.sender_id = $1 AND o.offer_type = 'dep'
           AND o.status = 'pending' AND g.date >= $2
         ORDER BY g.date ASC LIMIT 1`,
        [userId, today]
      ),
      // Monthly breakdown for Home forecast chart (past 6 months + next 6 months).
      // S11-FORECAST: split earnings by status so the client can render a stacked
      // chart (confirmed green + pending amber + forecast grey). generate_series
      // pre-fills all 12 months so empty months still appear as zero-height
      // columns instead of disappearing from the chart.
      db.query(
        `WITH months AS (
           SELECT (DATE_TRUNC('month', NOW()) + (n || ' month')::interval)::date AS month_start
           FROM generate_series(-6, 5) AS n
         ),
         monthly AS (
           SELECT DATE_TRUNC('month', date)::date AS month_start,
                  COALESCE(SUM(fee) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_earnings,
                  COALESCE(SUM(fee) FILTER (WHERE status = 'enquiry'),   0) AS pending_earnings,
                  COUNT(*) AS gigs
           FROM gigs
           WHERE user_id = $1
             AND date >= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
             AND date <  DATE_TRUNC('month', NOW()) + INTERVAL '6 months'
           GROUP BY DATE_TRUNC('month', date)
         )
         SELECT TO_CHAR(m.month_start, 'Mon YY') AS month_label,
                m.month_start,
                COALESCE(mo.confirmed_earnings, 0) AS confirmed_earnings,
                COALESCE(mo.pending_earnings,   0) AS pending_earnings,
                COALESCE(mo.gigs, 0) AS gigs
         FROM months m
         LEFT JOIN monthly mo ON mo.month_start = m.month_start
         ORDER BY m.month_start ASC`,
        [userId]
      ),
      // Recent messages preview (last 3 messages in threads the user participates in,
      // excluding messages the user sent themselves)
      db.query(
        `SELECT m.id, m.content, m.created_at, m.thread_id,
                u.name AS sender_name, u.avatar_url AS sender_avatar,
                t.gig_id, g.band_name
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN users u ON u.id = m.sender_id
         LEFT JOIN gigs g ON g.id = t.gig_id
         WHERE $1 = ANY(t.participant_ids)
           AND m.sender_id <> $1
         ORDER BY m.created_at DESC
         LIMIT 3`,
        [userId]
      ),
      // Imported-from-Google gigs that still need a fee. Drives the Home banner
      // + the persistent "fill in fees" entry point (task #291) so a musician
      // who skipped the first-import wizard can finish later. Only counts
      // gcal-sourced rows so we don't nag about manually-entered £0 gigs.
      db.query(
        `SELECT COUNT(*)::int AS count FROM gigs
         WHERE user_id = $1
           AND source LIKE 'gcal:%'
           AND (fee IS NULL OR fee = 0)`,
        [userId]
      ),
    ]);

    const overdueRow = overdueCombinedResult.rows[0] || {};
    const draftRow = draftCombinedResult.rows[0] || {};
    const offersRow = offersCombinedResult.rows[0] || {};
    const overdueInvoice = overdueRow.preview || null;
    const draftInvoice = draftRow.preview || null;
    const activeDep = activeDepResult.rows[0] || null;

    // Compute hours remaining from deadline (fallback: until gig start)
    let activeDepRequest = null;
    if (activeDep) {
      const deadline = activeDep.deadline
        ? new Date(activeDep.deadline)
        : new Date(activeDep.date + 'T' + (activeDep.start_time || '19:00'));
      const hoursLeft = Math.max(0, Math.floor((deadline - now) / 36e5));
      activeDepRequest = {
        offer_id: activeDep.id,
        gig_id: activeDep.gig_id,
        band_name: activeDep.band_name,
        venue_name: activeDep.venue_name,
        date: activeDep.date,
        start_time: activeDep.start_time,
        end_time: activeDep.end_time,
        hours_left: hoursLeft,
      };
    }

    const monthlyBreakdown = (monthlyBreakdownResult.rows || []).map((r) => ({
      month_label: r.month_label,
      month_start: r.month_start,
      confirmed_earnings: parseFloat(r.confirmed_earnings || 0),
      pending_earnings: parseFloat(r.pending_earnings || 0),
      // Legacy `earnings` field = total so older callers that still read it
      // get a single number to chart against.
      earnings: parseFloat(r.confirmed_earnings || 0) + parseFloat(r.pending_earnings || 0),
      gigs: parseInt(r.gigs || 0),
    }));

    const recentMessages = (recentMessagesResult.rows || []).map((r) => ({
      id: r.id,
      thread_id: r.thread_id,
      sender_name: r.sender_name,
      sender_avatar: r.sender_avatar,
      preview: (r.content || '').slice(0, 120),
      created_at: r.created_at,
      gig_id: r.gig_id,
      band_name: r.band_name,
    }));

    const overdueCount = parseInt(overdueRow.count || 0);
    const draftCount = parseInt(draftRow.count || 0);
    const pendingOfferCount = parseInt(offersRow.total_count || 0);
    const unreadMessageCount = parseInt(unreadResult.rows[0]?.count || 0);

    res.json({
      next_gig: nextGigResult.rows[0] || null,
      // Field names matching frontend expectations
      month_earnings: parseFloat(thisMonthResult.rows[0]?.earnings || 0),
      month_gigs: parseInt(thisMonthResult.rows[0]?.count || 0),
      year_earnings: parseFloat(taxYearResult.rows[0]?.earnings || 0),
      year_gigs: parseInt(taxYearResult.rows[0]?.count || 0),
      overdue_invoices: overdueCount,
      overdue_total: parseFloat(overdueRow.total || 0),
      draft_invoices: draftCount,
      draft_total: parseFloat(draftRow.total || 0),
      overdue_invoice_preview: overdueInvoice || null,
      draft_invoice_preview: draftInvoice || null,
      // S11-05: unread_notifications is a superset of unread_messages.
      // It combines chat unreads + pending offers + overdue invoices so the
      // header dot lights up for anything the user needs to attend to, not
      // just chat. Previously both fields were identical which meant paid
      // invoices, incoming offers, and calendar imports never triggered the dot.
      unread_notifications: unreadMessageCount + pendingOfferCount + overdueCount,
      unread_messages: unreadMessageCount,
      offer_count: pendingOfferCount,
      network_offers: parseInt(offersRow.dep_count || 0),
      monthly_breakdown: monthlyBreakdown,
      recent_messages: recentMessages,
      active_dep_request: activeDepRequest,
      gigs_missing_fee: parseInt(missingFeeResult.rows[0]?.count || 0),
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── Earnings / Finance ───────────────────────────────────────────────────────────

router.get('/earnings', async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = 'month', date } = req.query;
    const centerDate = date ? new Date(date) : new Date();

    // Calculate current + prior tax year (UK: starts 6 April)
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();
    let taxYearStart, taxYearEnd, taxYearLabel;
    if (currentMonth > 4 || (currentMonth === 4 && currentDay >= 6)) {
      const y = now.getFullYear();
      taxYearStart = `${y}-04-06`;
      taxYearEnd = `${y + 1}-04-05`;
      // S5-02: HMRC canonical format is YYYY/YY (e.g. "2026/27"), not "26/27".
      taxYearLabel = `${y}/${String(y + 1).slice(-2)}`;
    } else {
      const y = now.getFullYear();
      taxYearStart = `${y - 1}-04-06`;
      taxYearEnd = `${y}-04-05`;
      taxYearLabel = `${y - 1}/${String(y).slice(-2)}`;
    }
    // Previous tax year for year-over-year
    const prevYearStart = new Date(taxYearStart);
    prevYearStart.setFullYear(prevYearStart.getFullYear() - 1);
    const prevYearEnd = new Date(taxYearEnd);
    prevYearEnd.setFullYear(prevYearEnd.getFullYear() - 1);

    // Monthly breakdown (past 12 months)
    const monthlyResult = await db.query(
      `SELECT
         DATE_TRUNC('month', date)::date as month_start,
         EXTRACT(MONTH FROM date)::int as month,
         EXTRACT(YEAR FROM date)::int as year,
         COALESCE(SUM(fee) FILTER (WHERE status = 'confirmed'), 0) as confirmed_total,
         COALESCE(SUM(fee) FILTER (WHERE status = 'enquiry'), 0) as enquiry_total,
         COUNT(*) as gig_count
       FROM gigs
       WHERE user_id = $1 AND date >= DATE_TRUNC('month', NOW()) - INTERVAL '12 months'
       GROUP BY month_start, month, year
       ORDER BY year ASC, month ASC`,
      [userId]
    );

    // Expenses total this tax year
    const expensesResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM receipts
       WHERE user_id = $1 AND date >= $2 AND date <= $3`,
      [userId, taxYearStart, taxYearEnd]
    );

    // Mileage total this tax year
    const mileageResult = await db.query(
      `SELECT COALESCE(SUM(mileage_miles), 0) as total FROM gigs
       WHERE user_id = $1 AND date >= $2 AND date <= $3`,
      [userId, taxYearStart, taxYearEnd]
    );

    // Earnings + gig count this tax year
    const currentYearResult = await db.query(
      `SELECT COALESCE(SUM(fee), 0) as total, COUNT(*) as count FROM gigs
       WHERE user_id = $1 AND date >= $2 AND date <= $3 AND status = 'confirmed'`,
      [userId, taxYearStart, taxYearEnd]
    );

    // Previous tax year earnings for YoY comparison
    const prevYearResult = await db.query(
      `SELECT COALESCE(SUM(fee), 0) as total FROM gigs
       WHERE user_id = $1 AND date >= $2 AND date <= $3 AND status = 'confirmed'`,
      [userId, prevYearStart.toISOString().slice(0, 10), prevYearEnd.toISOString().slice(0, 10)]
    );

    // Invoice summary
    const invoiceSummaryResult = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) as paid,
         COALESCE(SUM(amount) FILTER (WHERE status = 'sent' AND due_date >= CURRENT_DATE), 0) as unpaid,
         COALESCE(SUM(amount) FILTER (WHERE status = 'sent' AND due_date < CURRENT_DATE), 0) as overdue,
         COALESCE(SUM(amount) FILTER (WHERE status = 'draft'), 0) as draft
       FROM invoices WHERE user_id = $1`,
      [userId]
    );

    const mileageClaimable = parseFloat(mileageResult.rows[0]?.total || 0) * 0.45;
    const totalEarnings = parseFloat(currentYearResult.rows[0]?.total || 0);
    const totalExpenses = parseFloat(expensesResult.rows[0]?.total || 0);
    const totalGigs = parseInt(currentYearResult.rows[0]?.count || 0);
    const totalMiles = parseFloat(mileageResult.rows[0]?.total || 0);
    const prevEarnings = parseFloat(prevYearResult.rows[0]?.total || 0);
    const yoyPct = prevEarnings > 0
      ? Math.round(((totalEarnings - prevEarnings) / prevEarnings) * 100)
      : null;

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthly_breakdown = monthlyResult.rows.map(row => ({
      month: row.month,
      year: row.year,
      month_label: `${monthNames[row.month - 1]} ${String(row.year).slice(-2)}`,
      earnings: parseFloat(row.confirmed_total),
      confirmed_total: parseFloat(row.confirmed_total),
      enquiry_total: parseFloat(row.enquiry_total),
      gig_count: parseInt(row.gig_count),
    }));

    res.json({
      // Fields used by the new finance panel
      tax_year: taxYearLabel,
      total_earnings: totalEarnings,
      total_gigs: totalGigs,
      total_expenses: totalExpenses,
      total_miles: totalMiles,
      year_over_year_pct: yoyPct,
      monthly_breakdown,
      // Legacy fields (kept for existing callers)
      expenses_total: totalExpenses,
      mileage_total: totalMiles,
      mileage_claimable: mileageClaimable,
      invoice_summary: {
        paid: parseFloat(invoiceSummaryResult.rows[0]?.paid || 0),
        unpaid: parseFloat(invoiceSummaryResult.rows[0]?.unpaid || 0),
        overdue: parseFloat(invoiceSummaryResult.rows[0]?.overdue || 0),
        draft: parseFloat(invoiceSummaryResult.rows[0]?.draft || 0),
      },
    });
  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// ── Monthly detail for the Finance panel insight card ───────────────────────
// Returns the raw gigs / invoices / expenses for the chosen month, plus a
// next-month gig count and the user's total outstanding invoice load. The
// client uses this to render the deterministic 12-variation Monthly Insight
// (no Haiku call), so this endpoint carries no narrative text itself.
router.get('/finance/month-detail', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const startISO = `${year}-${String(month).padStart(2, '0')}-01`;
    const endISO = new Date(year, month, 0).toISOString().substring(0, 10);
    const nextStart = new Date(year, month, 1);
    const nextStartISO = nextStart.toISOString().substring(0, 10);
    const nextEnd = new Date(nextStart.getFullYear(), nextStart.getMonth() + 1, 0);
    const nextEndISO = nextEnd.toISOString().substring(0, 10);

    const [gigsR, invR, expR, nextGigsR, outstandingR] = await Promise.all([
      db.query(
        `SELECT date, band_name, venue_name, fee, status
         FROM gigs
         WHERE user_id = $1 AND date BETWEEN $2 AND $3
         ORDER BY date ASC`,
        [req.user.id, startISO, endISO]
      ),
      db.query(
        `SELECT invoice_number, amount, status, due_date, created_at
         FROM invoices
         WHERE user_id = $1 AND created_at::date BETWEEN $2 AND $3
         ORDER BY created_at ASC`,
        [req.user.id, startISO, endISO]
      ),
      db.query(
        `SELECT category, amount, description, date
         FROM expenses
         WHERE user_id = $1 AND date BETWEEN $2 AND $3
         ORDER BY date ASC`,
        [req.user.id, startISO, endISO]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT COUNT(*)::int AS count
         FROM gigs
         WHERE user_id = $1 AND date BETWEEN $2 AND $3`,
        [req.user.id, nextStartISO, nextEndISO]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS total
         FROM invoices
         WHERE user_id = $1 AND status NOT IN ('paid', 'cancelled')`,
        [req.user.id]
      ),
    ]);

    res.json({
      year,
      month,
      gigs: gigsR.rows,
      invoices: invR.rows,
      expenses: expR.rows,
      next_month_gig_count: nextGigsR.rows[0]?.count || 0,
      outstanding_invoice_count: outstandingR.rows[0]?.count || 0,
      outstanding_invoice_total: outstandingR.rows[0]?.total || 0,
    });
  } catch (error) {
    console.error('Get month-detail error:', error);
    res.status(500).json({ error: 'Failed to load month detail' });
  }
});

// ── Threads / Chat inbox ────────────────────────────────────────────────────
// Returns an array shaped for the chat inbox panel. Dep threads are distinguished
// so the inbox can split them into "Active deps" vs "Gig bands".
router.get('/threads', async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await db.query(
      `SELECT
         t.id,
         t.thread_type,
         t.kind,
         t.created_at,
         g.id as gig_id,
         g.band_name,
         g.venue_name,
         g.date as gig_date,
         (
           SELECT content FROM messages m
           WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1
         ) as last_message,
         (
           SELECT created_at FROM messages m
           WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1
         ) as last_message_at,
         (
           SELECT COUNT(*)::int FROM messages m
           WHERE m.thread_id = t.id
             AND m.sender_id <> $1::uuid
             AND NOT COALESCE(m.read_by, ARRAY[]::uuid[]) @> ARRAY[$1::uuid]
         ) as unread
       FROM threads t
       LEFT JOIN gigs g ON g.id = t.gig_id
       WHERE t.participant_ids @> ARRAY[$1::uuid]
       ORDER BY COALESCE((
         SELECT MAX(created_at) FROM messages m WHERE m.thread_id = t.id
       ), t.created_at) DESC`,
      [userId]
    );

    const now = Date.now();
    const timeAgo = (d) => {
      if (!d) return '';
      const diff = Math.max(0, now - new Date(d).getTime());
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'now';
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h`;
      const days = Math.floor(h / 24);
      if (days < 7) return `${days}d`;
      return `${Math.floor(days / 7)}w`;
    };

    res.json(result.rows.map(r => ({
      id: r.id,
      kind: r.kind || (r.thread_type === 'dep' ? 'dep' : 'gig'),
      title: r.band_name || r.venue_name || 'Untitled',
      last_message: r.last_message || '',
      time_ago: timeAgo(r.last_message_at || r.created_at),
      unread: parseInt(r.unread || 0),
      gig_id: r.gig_id,
    })));
  } catch (error) {
    console.error('Get threads error:', error);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ── Contacts (Network) ──────────────────────────────────────────────────────────

router.get('/contacts', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM contacts WHERE owner_id = $1 ORDER BY name ASC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

router.get('/contacts/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM contacts WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

router.post('/contacts', async (req, res) => {
  try {
    const { name, email, phone, instruments, notes, location, is_favourite, linked_user_id } = req.body;
    const instrumentsArr = toTextArray(instruments);

    // Phase IX-D: linked_user_id may arrive from the Add Contact "Link" chip.
    // Don't trust the client — re-verify the target is (a) a real user, (b)
    // discoverable, (c) not the actor themselves, and (d) not on either side
    // of a block relation. If any check fails, drop the link and still save
    // the contact as a plain (unlinked) row so the user's typed fields aren't
    // lost. Never surface the specific reason (decision 10: no leak).
    let verifiedLinkedId = null;
    if (linked_user_id && typeof linked_user_id === 'string') {
      if (linked_user_id === req.user.id) {
        // Self-link attempt; silently drop.
      } else {
        try {
          const check = await db.query(
            `SELECT u.id FROM users u
               WHERE u.id = $1
                 AND u.discoverable = TRUE
                 AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $2 AND b.blocked_id = u.id)
                 AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $2)
               LIMIT 1`,
            [linked_user_id, req.user.id]
          );
          if (check.rows.length === 1) verifiedLinkedId = linked_user_id;
        } catch (linkErr) {
          console.error('[contacts] link validation error (non-fatal):', linkErr && linkErr.message);
        }
      }
    }

    const result = await db.query(
      `INSERT INTO contacts (owner_id, name, email, phone, instruments, notes, location, is_favourite, linked_user_id)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
       RETURNING *`,
      [req.user.id, name, email || null, phone || null, instrumentsArr, notes || null, location || null, !!is_favourite, verifiedLinkedId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create contact error:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

router.patch('/contacts/:id', async (req, res) => {
  try {
    const { name, email, phone, instruments, notes, location, is_favourite } = req.body;
    const instrumentsArr = instruments === undefined ? null : toTextArray(instruments);
    const result = await db.query(
      `UPDATE contacts SET
         name = COALESCE($1, name),
         email = COALESCE($2, email),
         phone = COALESCE($3, phone),
         instruments = COALESCE($4::text[], instruments),
         notes = COALESCE($5, notes),
         location = COALESCE($6, location),
         is_favourite = COALESCE($7, is_favourite)
       WHERE id = $8 AND owner_id = $9 RETURNING *`,
      [name || null, email || null, phone || null, instrumentsArr, notes || null, location || null, typeof is_favourite === 'boolean' ? is_favourite : null, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

router.patch('/contacts/:id/favourite', async (req, res) => {
  try {
    const { is_favourite } = req.body;
    const result = await db.query(
      'UPDATE contacts SET is_favourite = $1 WHERE id = $2 AND owner_id = $3 RETURNING *',
      [!!is_favourite, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Toggle favourite error:', error);
    res.status(500).json({ error: 'Failed to toggle favourite' });
  }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM contacts WHERE id = $1 AND owner_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// ── Songs (Repertoire) ──────────────────────────────────────────────────────────

router.get('/songs', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM songs WHERE user_id = $1 ORDER BY title ASC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get songs error:', error);
    res.status(500).json({ error: 'Failed to fetch songs' });
  }
});

router.get('/songs/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM songs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Song not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get song error:', error);
    res.status(500).json({ error: 'Failed to fetch song' });
  }
});

// Bulk import (used by ChordPro import). Body: { songs: [{ title, artist, key, lyrics, chords, tags }, ...] }
router.post('/songs/bulk', async (req, res) => {
  try {
    const { songs } = req.body || {};
    if (!Array.isArray(songs) || songs.length === 0) {
      return res.status(400).json({ error: 'songs array required' });
    }
    const inserted = [];
    for (const s of songs) {
      if (!s || !s.title) continue;
      const r = await db.query(
        `INSERT INTO songs (user_id, title, artist, key, tempo, duration, genre, tags, lyrics, chords)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10) RETURNING *`,
        [
          req.user.id,
          String(s.title).slice(0, 200),
          s.artist || null,
          s.key || null,
          s.tempo || null,
          s.duration || null,
          s.genre || null,
          toTextArray(s.tags),
          s.lyrics || null,
          s.chords || null,
        ]
      );
      inserted.push(r.rows[0]);
    }
    res.json({ count: inserted.length, songs: inserted });
  } catch (error) {
    console.error('Bulk import songs error:', error);
    res.status(500).json({ error: 'Failed to import songs' });
  }
});

router.post('/songs', async (req, res) => {
  try {
    const { title, artist, key, tempo, duration, genre, tags, lyrics, chords } = req.body;
    const tagsArr = toTextArray(tags);
    const result = await db.query(
      `INSERT INTO songs (user_id, title, artist, key, tempo, duration, genre, tags, lyrics, chords)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)
       RETURNING *`,
      [
        req.user.id,
        title,
        artist || null,
        key || null,
        tempo || null,
        duration || null,
        genre || null,
        tagsArr,
        lyrics || null,
        chords || null,
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create song error:', error);
    res.status(500).json({ error: 'Failed to create song' });
  }
});

router.patch('/songs/:id', async (req, res) => {
  try {
    const { title, artist, key, tempo, duration, genre, tags, lyrics, chords } = req.body;
    const tagsArr = tags === undefined ? null : toTextArray(tags);
    const result = await db.query(
      `UPDATE songs SET
         title = COALESCE($1, title),
         artist = COALESCE($2, artist),
         key = COALESCE($3, key),
         tempo = COALESCE($4, tempo),
         duration = COALESCE($5, duration),
         genre = COALESCE($6, genre),
         tags = COALESCE($7::text[], tags),
         lyrics = COALESCE($8, lyrics),
         chords = COALESCE($9, chords)
       WHERE id = $10 AND user_id = $11 RETURNING *`,
      [title, artist, key, tempo, duration, genre, tagsArr, lyrics, chords, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Song not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update song error:', error);
    res.status(500).json({ error: 'Failed to update song' });
  }
});

router.delete('/songs/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM songs WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Song not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete song error:', error);
    res.status(500).json({ error: 'Failed to delete song' });
  }
});

// ── Setlists ───────────────────────────────────────────────────────────────────

router.get('/setlists', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM setlists WHERE user_id = $1 ORDER BY name ASC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get setlists error:', error);
    res.status(500).json({ error: 'Failed to fetch setlists' });
  }
});

router.get('/setlists/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM setlists WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Setlist not found' });

    const setlist = result.rows[0];

    // Expand songs if song_ids array exists
    if (setlist.song_ids && setlist.song_ids.length > 0) {
      const songsResult = await db.query(
        'SELECT * FROM songs WHERE id = ANY($1)',
        [setlist.song_ids]
      );
      setlist.songs = songsResult.rows;
    } else {
      setlist.songs = [];
    }

    res.json(setlist);
  } catch (error) {
    console.error('Get setlist error:', error);
    res.status(500).json({ error: 'Failed to fetch setlist' });
  }
});

router.post('/setlists', async (req, res) => {
  try {
    const { name, description, song_ids, gig_id } = req.body;
    const result = await db.query(
      `INSERT INTO setlists (user_id, name, description, song_ids, gig_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, name, description || null, song_ids || [], gig_id || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create setlist error:', error);
    res.status(500).json({ error: 'Failed to create setlist' });
  }
});

router.patch('/setlists/:id', async (req, res) => {
  try {
    const { name, description, song_ids, gig_id } = req.body;
    const result = await db.query(
      `UPDATE setlists SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         song_ids = COALESCE($3, song_ids),
         gig_id = COALESCE($4, gig_id)
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [name, description, song_ids, gig_id, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Setlist not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update setlist error:', error);
    res.status(500).json({ error: 'Failed to update setlist' });
  }
});

router.delete('/setlists/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM setlists WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Setlist not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete setlist error:', error);
    res.status(500).json({ error: 'Failed to delete setlist' });
  }
});

// ── Notifications ──────────────────────────────────────────────────────────────

// S8-05: helper — compute the same notification key the client uses when
// dismissing. Keeping the algorithm identical on both sides lets the server
// filter dismissed rows without the client having to re-send the full list.
function _notifKey(n) {
  return `${n.type}:${n.action_type || ''}:${n.action_id || ''}:${n.timestamp || ''}`;
}

router.get('/notifications', async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];
    const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    // Helper: format a date/timestamp as "Thu 23 Apr 2026" for UK readability.
    // Accepts either a Date or ISO/YYYY-MM-DD string. Returns '' on failure so
    // subtitles never crash the panel.
    const fmtNotifDate = (val) => {
      if (!val) return '';
      try {
        const d = val instanceof Date ? val : new Date(val);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'Europe/London',
        });
      } catch (e) {
        return '';
      }
    };
    const fmtMoney = (val) => {
      const n = Number(val);
      if (!Number.isFinite(n)) return String(val);
      return `£${n.toFixed(2)}`;
    };

    const notifications = [];

    // Upcoming gigs in next 3 days. Skip cancelled so dismissed QA data
    // stops pinging real users.
    const gigsResult = await db.query(
      `SELECT id, band_name, venue_name, date FROM gigs
       WHERE user_id = $1 AND date > $2 AND date <= $3
         AND (status IS NULL OR status != 'cancelled')
       ORDER BY date ASC`,
      [userId, today, threeDaysFromNow]
    );

    gigsResult.rows.forEach(gig => {
      notifications.push({
        type: 'gig',
        title: 'Upcoming gig',
        subtitle: `${gig.band_name} at ${gig.venue_name} on ${fmtNotifDate(gig.date)}`,
        icon: 'calendar',
        timestamp: new Date(gig.date).toISOString(),
        action_type: 'gig',
        action_id: gig.id,
      });
    });

    // Overdue invoices
    const overdueResult = await db.query(
      `SELECT id, band_name, amount, due_date FROM invoices
       WHERE user_id = $1 AND status = 'sent' AND due_date < $2
       ORDER BY due_date ASC`,
      [userId, today]
    );

    overdueResult.rows.forEach(inv => {
      notifications.push({
        type: 'invoice',
        title: 'Overdue invoice',
        subtitle: `${inv.band_name} - ${fmtMoney(inv.amount)} due ${fmtNotifDate(inv.due_date)}`,
        icon: 'alert',
        timestamp: new Date(inv.due_date).toISOString(),
        action_type: 'invoice',
        action_id: inv.id,
      });
    });

    // Pending offers expiring soon
    const offersResult = await db.query(
      `SELECT id, gig_id, deadline FROM offers
       WHERE recipient_id = $1 AND status = 'pending' AND deadline <= $2 AND deadline > $3
       ORDER BY deadline ASC`,
      [userId, oneDayFromNow, today]
    );

    offersResult.rows.forEach(offer => {
      notifications.push({
        type: 'offer',
        title: 'Offer expiring soon',
        subtitle: `Offer deadline ${fmtNotifDate(offer.deadline)}`,
        icon: 'hourglass',
        timestamp: new Date(offer.deadline).toISOString(),
        action_type: 'offer',
        action_id: offer.id,
      });
    });

    // Unpaid invoices past due date
    const unpaidResult = await db.query(
      `SELECT id, band_name, amount, due_date FROM invoices
       WHERE user_id = $1 AND status = 'sent' AND due_date < $2
       ORDER BY due_date ASC`,
      [userId, today]
    );

    // Note: unpaid is same query as overdue, don't double-add them
    // They're already included above

    // Documents & certs expiry. Each doc with an expiry_date emits up to three
    // notifications — 30-day warning, 7-day warning, and expired-or-today. Each
    // threshold carries its own action_type suffix so dismissing the 30-day
    // ping doesn't mute the final "expired" alert. The client key includes the
    // action_type so the three rows dismiss independently.
    try {
      const docsResult = await db.query(
        `SELECT id, name, doc_type, expiry_date FROM user_documents
         WHERE user_id = $1 AND expiry_date IS NOT NULL
         ORDER BY expiry_date ASC`,
        [userId]
      );
      const todayMs = new Date(today + 'T00:00:00Z').getTime();
      docsResult.rows.forEach(doc => {
        const expStr = doc.expiry_date instanceof Date
          ? doc.expiry_date.toISOString().slice(0, 10)
          : String(doc.expiry_date).slice(0, 10);
        const expMs = new Date(expStr + 'T00:00:00Z').getTime();
        const daysLeft = Math.round((expMs - todayMs) / (24 * 60 * 60 * 1000));
        const thresholds = [];
        if (daysLeft <= 0) {
          thresholds.push({ key: 'expired', title: 'Document expired',
            subtitle: `${doc.name} expired on ${fmtNotifDate(expStr)}` });
        } else {
          if (daysLeft <= 7) thresholds.push({ key: 'expiring_7', title: 'Document expiring soon',
            subtitle: `${doc.name} expires ${fmtNotifDate(expStr)} (${daysLeft} day${daysLeft === 1 ? '' : 's'})` });
          else if (daysLeft <= 30) thresholds.push({ key: 'expiring_30', title: 'Document expiring',
            subtitle: `${doc.name} expires ${fmtNotifDate(expStr)}` });
        }
        thresholds.forEach(t => {
          notifications.push({
            type: 'document',
            title: t.title,
            subtitle: t.subtitle,
            icon: 'document',
            timestamp: new Date(expStr + 'T00:00:00Z').toISOString(),
            action_type: `document_${t.key}`,
            action_id: doc.id,
          });
        });
      });
    } catch (docsErr) {
      // Migration may not have run yet on a fresh deploy. Fall through so the
      // rest of the notifications still render.
      console.error('Docs notifications error (non-fatal):', docsErr.message);
    }

    // S8-05: filter out anything the user has dismissed server-side. Keeps
    // dismissals in sync across devices — a dismissal on the phone stays
    // dismissed on the iPad.
    try {
      const dismissedRes = await db.query(
        `SELECT notif_key FROM notification_dismissals WHERE user_id = $1`,
        [userId]
      );
      const dismissedSet = new Set(dismissedRes.rows.map(r => r.notif_key));
      const visible = notifications.filter(n => !dismissedSet.has(_notifKey(n)));
      return res.json(visible);
    } catch (dismissErr) {
      // If the dismissals table isn't there yet (fresh deploy before migration)
      // fall through to returning the full list — the client localStorage
      // fallback will still mask them visually.
      console.error('Notification dismiss-filter error (non-fatal):', dismissErr.message);
      return res.json(notifications);
    }
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// S8-05: dismiss one notification by its client-derived key. Idempotent — the
// UNIQUE (user_id, notif_key) index means a re-post is a no-op.
router.post('/notifications/dismiss', async (req, res) => {
  try {
    const key = req.body && req.body.key;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Missing key' });
    }
    await db.query(
      `INSERT INTO notification_dismissals (user_id, notif_key)
         VALUES ($1, $2)
         ON CONFLICT (user_id, notif_key) DO NOTHING`,
      [req.user.id, key]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss notification error:', error);
    res.status(500).json({ error: 'Failed to dismiss notification' });
  }
});

// S8-05: undo a dismissal. Removes one row from notification_dismissals so the
// reminder re-appears on the next /api/notifications fetch. Safe to call for a
// key that was never dismissed (rowCount will just be 0).
router.delete('/notifications/dismiss', async (req, res) => {
  try {
    const key = req.body && req.body.key;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Missing key' });
    }
    const r = await db.query(
      `DELETE FROM notification_dismissals WHERE user_id = $1 AND notif_key = $2`,
      [req.user.id, key]
    );
    res.json({ success: true, removed: r.rowCount });
  } catch (error) {
    console.error('Undismiss notification error:', error);
    res.status(500).json({ error: 'Failed to undismiss notification' });
  }
});

// S8-05: bulk dismiss. Takes an array of keys (what the client sees right now)
// so "Clear all" mirrors the visible set.
router.post('/notifications/dismiss-all', async (req, res) => {
  try {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    if (keys.length === 0) return res.json({ success: true, count: 0 });
    // Flatten (user_id, key) pairs for a single VALUES insert.
    const values = [];
    const params = [];
    keys.forEach((k, i) => {
      if (typeof k !== 'string' || !k) return;
      values.push(`($${params.length + 1}, $${params.length + 2})`);
      params.push(req.user.id, k);
    });
    if (values.length === 0) return res.json({ success: true, count: 0 });
    await db.query(
      `INSERT INTO notification_dismissals (user_id, notif_key)
         VALUES ${values.join(', ')}
         ON CONFLICT (user_id, notif_key) DO NOTHING`,
      params
    );
    res.json({ success: true, count: values.length });
  } catch (error) {
    console.error('Dismiss-all notifications error:', error);
    res.status(500).json({ error: 'Failed to dismiss notifications' });
  }
});

// ── Documents & Certs ────────────────────────────────────────────────────────
// Uploaders POST the file as base64 in a JSON body (there's no multer in the
// stack — adding one for a low-volume cert list felt like premature tooling).
// File sizes are capped server-side so a rogue upload can't wedge the Postgres
// row-size limit. Anything serious should migrate to S3/R2 later.

const DOC_MAX_BYTES = 8 * 1024 * 1024; // 8MB — fits a phone camera photo of a multi-page cert
const DOC_TYPES = new Set(['dbs', 'pli', 'risk_assessment', 'insurance', 'qualification', 'other']);

// Compact list view: never ship file_data back here — a 20-cert list would be
// tens of megabytes otherwise. /documents/:id/file serves bytes on demand.
router.get('/documents', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, doc_type, mime_type, file_name, file_size,
              issued_date, expiry_date, notes, uploaded_at, updated_at,
              (file_data IS NOT NULL) AS has_file
       FROM user_documents
       WHERE user_id = $1
       ORDER BY
         CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
         expiry_date ASC,
         uploaded_at DESC`,
      [req.user.id]
    );
    res.json({ documents: result.rows });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

router.get('/documents/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, doc_type, mime_type, file_name, file_size,
              issued_date, expiry_date, notes, uploaded_at, updated_at,
              (file_data IS NOT NULL) AS has_file
       FROM user_documents
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ document: result.rows[0] });
  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// Binary endpoint: used by the "View" button on the list. Sends the original
// mime type so PDFs preview inline and photos render as images.
router.get('/documents/:id/file', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT file_data, mime_type, file_name FROM user_documents
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0 || !result.rows[0].file_data) {
      return res.status(404).send('Not found');
    }
    const row = result.rows[0];
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    // `inline` so the browser previews. Download uses the save-as dialog from
    // the browser itself. filename fallback covers rows uploaded before we
    // started capturing it.
    const safeName = (row.file_name || 'document').replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.send(row.file_data);
  } catch (error) {
    console.error('Get document file error:', error);
    res.status(500).send('Failed to fetch file');
  }
});

function _docDecodeBase64(dataUrlOrB64) {
  if (!dataUrlOrB64 || typeof dataUrlOrB64 !== 'string') return null;
  // Strip data URL prefix if present ("data:application/pdf;base64,...")
  const m = dataUrlOrB64.match(/^data:([^;]+);base64,(.*)$/);
  const mime = m ? m[1] : null;
  const b64 = m ? m[2] : dataUrlOrB64;
  try {
    const buf = Buffer.from(b64, 'base64');
    return { buf, mime };
  } catch (e) {
    return null;
  }
}

router.post('/documents', async (req, res) => {
  try {
    const { name, doc_type, issued_date, expiry_date, notes, file_base64, file_name, mime_type } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const docType = DOC_TYPES.has(doc_type) ? doc_type : 'other';
    let fileData = null;
    let fileMime = null;
    let fileSize = null;
    let fileNameSafe = null;
    if (file_base64) {
      const decoded = _docDecodeBase64(file_base64);
      if (!decoded) return res.status(400).json({ error: 'Invalid file data' });
      if (decoded.buf.length > DOC_MAX_BYTES) {
        return res.status(400).json({ error: `File too large. Max ${DOC_MAX_BYTES / 1024 / 1024}MB.` });
      }
      fileData = decoded.buf;
      fileMime = mime_type || decoded.mime || 'application/octet-stream';
      fileSize = decoded.buf.length;
      fileNameSafe = file_name ? String(file_name).slice(0, 255) : null;
    }
    const issuedVal = issued_date && /^\d{4}-\d{2}-\d{2}/.test(String(issued_date))
      ? String(issued_date).slice(0, 10) : null;
    const expiryVal = expiry_date && /^\d{4}-\d{2}-\d{2}/.test(String(expiry_date))
      ? String(expiry_date).slice(0, 10) : null;
    const notesVal = notes ? String(notes).slice(0, 2000) : null;
    const result = await db.query(
      `INSERT INTO user_documents
         (user_id, name, doc_type, file_data, mime_type, file_name, file_size,
          issued_date, expiry_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, name, doc_type, mime_type, file_name, file_size,
                 issued_date, expiry_date, notes, uploaded_at, updated_at,
                 (file_data IS NOT NULL) AS has_file`,
      [req.user.id, name.trim().slice(0, 255), docType, fileData, fileMime,
       fileNameSafe, fileSize, issuedVal, expiryVal, notesVal]
    );
    res.json({ success: true, document: result.rows[0] });
  } catch (error) {
    console.error('Create document error:', error);
    res.status(500).json({ error: 'Failed to save document' });
  }
});

// Edit metadata or replace file. If the expiry_date moves forward (renewal),
// purge any notification_dismissals tied to this doc so the new 30/7-day
// warnings surface instead of staying silenced by the previous cycle.
router.put('/documents/:id', async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT expiry_date FROM user_documents WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const prevExpiry = existing.rows[0].expiry_date;
    const prevExpiryStr = prevExpiry
      ? (prevExpiry instanceof Date ? prevExpiry.toISOString().slice(0, 10) : String(prevExpiry).slice(0, 10))
      : null;

    const { name, doc_type, issued_date, expiry_date, notes, file_base64, file_name, mime_type, clear_expiry } = req.body || {};
    const fields = [];
    const params = [];
    let idx = 1;
    if (name !== undefined) {
      fields.push(`name = $${idx++}`);
      params.push(String(name).trim().slice(0, 255));
    }
    if (doc_type !== undefined) {
      fields.push(`doc_type = $${idx++}`);
      params.push(DOC_TYPES.has(doc_type) ? doc_type : 'other');
    }
    if (issued_date !== undefined) {
      const v = issued_date && /^\d{4}-\d{2}-\d{2}/.test(String(issued_date))
        ? String(issued_date).slice(0, 10) : null;
      fields.push(`issued_date = $${idx++}`);
      params.push(v);
    }
    // Allow explicit null via clear_expiry flag, or a new ISO date via expiry_date.
    if (clear_expiry) {
      fields.push(`expiry_date = NULL`);
    } else if (expiry_date !== undefined) {
      const v = expiry_date && /^\d{4}-\d{2}-\d{2}/.test(String(expiry_date))
        ? String(expiry_date).slice(0, 10) : null;
      fields.push(`expiry_date = $${idx++}`);
      params.push(v);
    }
    if (notes !== undefined) {
      fields.push(`notes = $${idx++}`);
      params.push(notes ? String(notes).slice(0, 2000) : null);
    }
    if (file_base64) {
      const decoded = _docDecodeBase64(file_base64);
      if (!decoded) return res.status(400).json({ error: 'Invalid file data' });
      if (decoded.buf.length > DOC_MAX_BYTES) {
        return res.status(400).json({ error: `File too large. Max ${DOC_MAX_BYTES / 1024 / 1024}MB.` });
      }
      fields.push(`file_data = $${idx++}`); params.push(decoded.buf);
      fields.push(`mime_type = $${idx++}`); params.push(mime_type || decoded.mime || 'application/octet-stream');
      fields.push(`file_size = $${idx++}`); params.push(decoded.buf.length);
      if (file_name) {
        fields.push(`file_name = $${idx++}`);
        params.push(String(file_name).slice(0, 255));
      }
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    fields.push(`updated_at = NOW()`);
    params.push(req.params.id, req.user.id);
    const result = await db.query(
      `UPDATE user_documents SET ${fields.join(', ')}
       WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING id, name, doc_type, mime_type, file_name, file_size,
                 issued_date, expiry_date, notes, uploaded_at, updated_at,
                 (file_data IS NOT NULL) AS has_file`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    // Renewal reset: if expiry moved forward (or a previously null expiry was
    // set), the old threshold dismissals are stale — wipe them so the new
    // 30/7-day pings can reach the user.
    try {
      const newExpiry = result.rows[0].expiry_date;
      const newExpiryStr = newExpiry
        ? (newExpiry instanceof Date ? newExpiry.toISOString().slice(0, 10) : String(newExpiry).slice(0, 10))
        : null;
      const forwardShift = newExpiryStr && (!prevExpiryStr || newExpiryStr > prevExpiryStr);
      if (forwardShift) {
        const keys = [
          `document:document_expired:${req.params.id}:`,
          `document:document_expiring_7:${req.params.id}:`,
          `document:document_expiring_30:${req.params.id}:`,
        ];
        // notif_key uses the timestamp suffix — use LIKE to cover both old and
        // new expiry timestamps.
        for (const prefix of keys) {
          await db.query(
            `DELETE FROM notification_dismissals
             WHERE user_id = $1 AND notif_key LIKE $2`,
            [req.user.id, prefix + '%']
          );
        }
      }
    } catch (dismissErr) {
      console.error('Docs dismiss reset (non-fatal):', dismissErr.message);
    }

    res.json({ success: true, document: result.rows[0] });
  } catch (error) {
    console.error('Update document error:', error);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

router.delete('/documents/:id', async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM user_documents WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    // Also sweep any dismissals for this doc — no point keeping rows that
    // reference a deleted cert.
    try {
      await db.query(
        `DELETE FROM notification_dismissals
         WHERE user_id = $1 AND notif_key LIKE $2`,
        [req.user.id, `document:%:${req.params.id}:%`]
      );
    } catch (dismissErr) {
      console.error('Docs dismiss cleanup (non-fatal):', dismissErr.message);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ── Invoice Details ────────────────────────────────────────────────────────────

router.get('/invoices/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.*, g.band_name as gig_band_name, g.venue_name, g.date as gig_date
       FROM invoices i
       LEFT JOIN gigs g ON i.gig_id = g.id
       WHERE i.id = $1 AND i.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

router.patch('/invoices/:id', async (req, res) => {
  try {
    const { status, sent_at, paid_at, recipient_email, payment_link_url_override } = req.body;

    // Auto-set transition timestamps so the client never has to remember.
    // If the client explicitly sends a value we keep it; otherwise we stamp NOW()
    // on the first transition into 'sent' or 'paid'.
    const effectiveSentAt = sent_at || (status === 'sent' ? new Date().toISOString() : null);
    const effectivePaidAt = paid_at || (status === 'paid' ? new Date().toISOString() : null);

    // Pay-link override (#292): same validation rules as the user-profile
    // field. Empty string clears the override (falls back to the user-level
    // default). undefined leaves the existing value intact.
    let overrideProvided = false;
    let overrideValue = null;
    if (payment_link_url_override !== undefined) {
      overrideProvided = true;
      const trimmed = String(payment_link_url_override || '').trim();
      if (!trimmed) {
        overrideValue = null;
      } else if (/^https?:\/\//i.test(trimmed)) {
        overrideValue = trimmed.slice(0, 500);
      } else {
        return res.status(400).json({ error: 'Pay link must start with http:// or https://', field: 'payment_link_url_override' });
      }
    }

    const result = await db.query(
      `UPDATE invoices SET
         status = COALESCE($1, status),
         sent_at = COALESCE($2, sent_at),
         paid_at = COALESCE($3, paid_at),
         recipient_email = COALESCE($4, recipient_email),
         payment_link_url_override = CASE WHEN $7::boolean THEN $8 ELSE payment_link_url_override END
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [status, effectiveSentAt, effectivePaidAt, recipient_email || null, req.params.id, req.user.id,
       overrideProvided, overrideValue]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// Record a chase attempt: increment chase_count, set last_chase_at.
router.post('/invoices/:id/chase', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE invoices SET
         chase_count = COALESCE(chase_count, 0) + 1,
         last_chase_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Chase invoice error:', error);
    res.status(500).json({ error: 'Failed to record chase' });
  }
});

router.delete('/invoices/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM invoices WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// ── Saved client directory ───────────────────────────────────────────────────
// Lightweight address book for invoice billing. On invoice submit the client
// is upserted (match by user_id + case-insensitive name) so the Bill-to field
// can auto-suggest + auto-fill the address on the next invoice. All routes
// scope to req.user.id so a user only ever sees their own directory.

router.get('/invoice-clients', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, address, email, phone, last_used_at
         FROM invoice_clients
        WHERE user_id = $1
        ORDER BY last_used_at DESC NULLS LAST, LOWER(name) ASC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('List invoice clients error:', error);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

router.post('/invoice-clients', async (req, res) => {
  try {
    const { name, address, email, phone } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'Client name is required' });

    // Upsert by (user_id, lower(name)) so repeated submits update the same row
    // instead of silently failing on the unique index. COALESCE keeps existing
    // address/email/phone if the caller sends null for them.
    const result = await db.query(
      `INSERT INTO invoice_clients (user_id, name, address, email, phone, last_used_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, LOWER(name)) DO UPDATE
         SET address = COALESCE(EXCLUDED.address, invoice_clients.address),
             email   = COALESCE(EXCLUDED.email, invoice_clients.email),
             phone   = COALESCE(EXCLUDED.phone, invoice_clients.phone),
             last_used_at = NOW()
       RETURNING id, name, address, email, phone, last_used_at`,
      [req.user.id, cleanName.slice(0, 255),
       address ? String(address) : null,
       email ? String(email).slice(0, 255) : null,
       phone ? String(phone).slice(0, 64) : null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Upsert invoice client error:', error);
    res.status(500).json({ error: 'Failed to save client' });
  }
});

router.patch('/invoice-clients/:id', async (req, res) => {
  try {
    const { name, address, email, phone } = req.body;
    const result = await db.query(
      `UPDATE invoice_clients SET
         name    = COALESCE($1, name),
         address = COALESCE($2, address),
         email   = COALESCE($3, email),
         phone   = COALESCE($4, phone)
       WHERE id = $5 AND user_id = $6
       RETURNING id, name, address, email, phone, last_used_at`,
      [name ? String(name).trim().slice(0, 255) : null,
       address != null ? String(address) : null,
       email != null ? String(email).slice(0, 255) : null,
       phone != null ? String(phone).slice(0, 64) : null,
       req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update invoice client error:', error);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

router.delete('/invoice-clients/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM invoice_clients WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete invoice client error:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// ── Printable export pages (Save as PDF via browser) ──────────────────────────
// Zero-dependency PDF: we return a clean printable HTML page and the user hits
// their browser Print > Save as PDF. Auto-triggers window.print() on load.
// Scoped under /api/print so authMiddleware protects them.

function _printEscape(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PRINT_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; margin: 24px; font-size: 12px; line-height: 1.4; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #000; }
  .sub { color: #555; font-size: 12px; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f6f6f6; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #333; }
  .right { text-align: right; }
  .totals { margin-top: 12px; border-top: 2px solid #000; padding-top: 10px; display: flex; justify-content: space-between; font-weight: 600; }
  .meta { color: #666; font-size: 11px; margin-bottom: 14px; }
  .section-title { font-size: 14px; font-weight: 700; margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #000; }
  .btn-bar { margin-bottom: 18px; }
  .btn-bar button { background: #000; color: #fff; border: 0; padding: 8px 14px; font-size: 12px; border-radius: 4px; cursor: pointer; margin-right: 8px; }
  @media print { .btn-bar { display: none; } body { margin: 12mm; } }
`;

function printPage(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_printEscape(title)}</title><style>${PRINT_STYLES}</style></head><body>
  <div class="btn-bar"><button onclick="window.print()">Print / Save as PDF</button><button onclick="window.close()" style="background:#666;">Close</button></div>
  ${bodyHtml}
  <script>window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 400); });</script>
  </body></html>`;
}

function _gbp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return '\u00a3' + (Math.round(v * 100) / 100).toFixed(2);
}

function _fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

router.get('/print/gigs', async (req, res) => {
  try {
    const userR = await db.query('SELECT display_name, name FROM users WHERE id = $1', [req.user.id]);
    const me = userR.rows[0] || {};
    const gigsR = await db.query('SELECT * FROM gigs WHERE user_id = $1 ORDER BY date DESC', [req.user.id]);
    const gigs = gigsR.rows;

    const totalFee = gigs.reduce((s, g) => s + (Number(g.fee) || 0), 0);
    const paidCount = gigs.filter(g => g.status === 'paid' || g.invoice_status === 'paid').length;

    const rows = gigs.length
      ? gigs.map(g => `<tr>
          <td>${_printEscape(_fmtDate(g.date))}</td>
          <td>${_printEscape(g.start_time || '')}</td>
          <td>${_printEscape(g.venue_name || '')}</td>
          <td>${_printEscape(g.act_name || g.band_name || '')}</td>
          <td>${_printEscape(g.gig_type || '')}</td>
          <td>${_printEscape(g.status || '')}</td>
          <td class="right">${g.fee != null ? _printEscape(_gbp(g.fee)) : ''}</td>
        </tr>`).join('')
      : `<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">No gigs yet</td></tr>`;

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const owner = me.display_name || me.name || 'TrackMyGigs user';
    const body = `
      <h1>Gig log</h1>
      <div class="sub">${_printEscape(owner)} \u00b7 exported ${_printEscape(today)}</div>
      <div class="meta">${gigs.length} gigs total, ${paidCount} paid, total fee value ${_printEscape(_gbp(totalFee))}</div>
      <table>
        <thead><tr><th>Date</th><th>Time</th><th>Venue</th><th>Act</th><th>Type</th><th>Status</th><th class="right">Fee</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="totals"><span>Total fee value (all statuses)</span><span>${_printEscape(_gbp(totalFee))}</span></div>`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(printPage('Gig log \u00b7 TrackMyGigs', body));
  } catch (err) {
    console.error('Print gigs error:', err);
    res.status(500).send('Failed to build print page');
  }
});

router.get('/print/invoice/:id', async (req, res) => {
  try {
    const userR = await db.query(
      `SELECT display_name, name, business_address, business_phone, vat_number, bank_details, payment_link_url
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const me = userR.rows[0] || {};

    const invR = await db.query(
      `SELECT i.*, g.venue_name AS g_venue, g.date AS g_date, g.band_name AS g_band
       FROM invoices i
       LEFT JOIN gigs g ON i.gig_id = g.id
       WHERE i.id = $1 AND i.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (invR.rows.length === 0) return res.status(404).send('Invoice not found');
    const inv = invR.rows[0];

    const fromName = me.display_name || me.name || 'TrackMyGigs user';
    const fromMetaBits = [];
    if (me.business_address) fromMetaBits.push(_printEscape(me.business_address).replace(/\n/g, '<br>'));
    if (me.business_phone) fromMetaBits.push(_printEscape(me.business_phone));
    if (me.vat_number) fromMetaBits.push(`VAT: ${_printEscape(me.vat_number)}`);

    const billTo = inv.band_name || inv.g_band || '';
    const billToAddress = inv.recipient_address ? _printEscape(inv.recipient_address).replace(/\n/g, '<br>') : '';
    const invDate = _fmtDate(inv.created_at || new Date());
    const dueDate = inv.due_date ? _fmtDate(inv.due_date) : (inv.payment_terms || 'On receipt');
    const desc = inv.description || (inv.g_venue
      ? `Performance fee \u00b7 ${inv.g_venue}${inv.g_date ? ' \u00b7 ' + _fmtDate(inv.g_date) : ''}`
      : 'Performance fee');
    const amount = _gbp(inv.amount || 0);

    const venueLine = inv.venue_name || inv.g_venue || '';
    const venueRow = venueLine
      ? `<tr><td colspan="2" style="padding:4px 6px 12px;font-size:11px;color:#666;">${_printEscape(venueLine)}${inv.g_date ? ' \u00b7 ' + _printEscape(_fmtDate(inv.g_date)) : ''}</td></tr>`
      : '';

    const bankBlock = me.bank_details
      ? `<div style="margin-top:18px;padding:12px;background:#f6f7f9;border-radius:6px;">
           <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#777;margin-bottom:6px;">Payment details</div>
           <div style="font-size:12px;color:#111;white-space:pre-line;line-height:1.5;">${_printEscape(me.bank_details)}</div>
         </div>`
      : '';

    // #292: Pay this invoice online button. Routes through the public
    // /pay/<slug> redirect so click telemetry fires regardless of which
    // payment provider the URL ultimately points to.
    const _directLink = inv.payment_link_url_override || me.payment_link_url || null;
    const _origin = (process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const _payUrl = _directLink && inv.public_pay_slug ? `${_origin}/pay/${inv.public_pay_slug}` : null;
    const payBlock = _payUrl
      ? `<div style="margin-top:20px;text-align:center;">
           <a href="${_printEscape(_payUrl)}" style="display:inline-block;background:#F0A500;color:#111;font-weight:700;font-size:14px;text-decoration:none;padding:12px 28px;border-radius:8px;">Pay this invoice online &rsaquo;</a>
           <div style="font-size:10px;color:#888;margin-top:6px;">or use the bank details below</div>
         </div>`
      : '';

    // Strip bank_details out of notes before rendering. Older invoices were
    // auto-populated with bank_details in the Notes field (the frontend did
    // this before a dedicated Payment Details panel existed), so rendering
    // notes as-is would show the same text twice.
    let renderedNotes = inv.notes || '';
    if (renderedNotes && me.bank_details) {
      const bank = String(me.bank_details).trim();
      renderedNotes = renderedNotes.split(bank).join('').replace(/\n{3,}/g, '\n\n').trim();
    }

    const body = `
      <div style="max-width:680px;margin:0 auto;color:#111;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;">
          <div>
            <div style="font-size:22px;font-weight:800;color:#111;">${_printEscape(fromName)}</div>
            <div style="font-size:11px;color:#555;margin-top:4px;line-height:1.5;">${fromMetaBits.join('<br>')}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:28px;font-weight:900;letter-spacing:2px;color:#111;">INVOICE</div>
            <div style="font-size:12px;color:#555;margin-top:4px;">${_printEscape(inv.invoice_number || 'INV-001')}</div>
            <div style="font-size:11px;color:#555;margin-top:2px;">${_printEscape(invDate)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px;padding:12px;background:#f6f7f9;border-radius:6px;">
          <div>
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#777;">Bill to</div>
            <div style="font-size:13px;font-weight:600;color:#111;margin-top:4px;">${_printEscape(billTo)}</div>
            ${billToAddress ? `<div style="font-size:11px;color:#555;margin-top:4px;line-height:1.5;">${billToAddress}</div>` : ''}
          </div>
          <div>
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#777;">Payment due</div>
            <div style="font-size:13px;font-weight:600;color:#111;margin-top:4px;">${_printEscape(dueDate)}</div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
          <thead>
            <tr style="border-bottom:2px solid #111;">
              <th style="text-align:left;padding:8px 6px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#555;">Description</th>
              <th style="text-align:right;padding:8px 6px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#555;width:110px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:12px 6px;font-size:13px;color:#111;">${_printEscape(desc)}</td>
              <td style="padding:12px 6px;text-align:right;font-size:13px;color:#111;font-weight:600;">${_printEscape(amount)}</td>
            </tr>
            ${venueRow}
          </tbody>
          <tfoot>
            <tr>
              <td style="padding:14px 6px 4px;text-align:right;font-size:13px;color:#555;">Total due</td>
              <td style="padding:14px 6px 4px;text-align:right;font-size:20px;font-weight:800;color:#111;">${_printEscape(amount)}</td>
            </tr>
          </tfoot>
        </table>
        ${payBlock}
        ${bankBlock}
        ${renderedNotes ? `<div style="margin-top:14px;font-size:11px;color:#555;white-space:pre-line;">${_printEscape(renderedNotes)}</div>` : ''}
        <div style="margin-top:22px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:10px;color:#888;text-align:center;">
          Generated with TrackMyGigs \u00b7 trackmygigs.app
        </div>
      </div>`;

    res.set('Content-Type', 'text/html; charset=utf-8')
      .send(printPage(`Invoice ${inv.invoice_number || ''} \u00b7 TrackMyGigs`, body));
  } catch (err) {
    console.error('Print invoice error:', err);
    res.status(500).send('Failed to build invoice PDF');
  }
});

// Server-rendered PDF for the invoice. Used by the Download button on the
// invoice detail screen, the initial Send flow, and the AI chase email's
// Web Share file attachment. Mirrors the layout of /print/invoice/:id.
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const userR = await db.query(
      `SELECT display_name, name, business_address, business_phone, vat_number, bank_details, payment_link_url
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const me = userR.rows[0] || {};

    const invR = await db.query(
      `SELECT i.*, g.venue_name AS g_venue, g.date AS g_date, g.band_name AS g_band
       FROM invoices i
       LEFT JOIN gigs g ON i.gig_id = g.id
       WHERE i.id = $1 AND i.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (invR.rows.length === 0) return res.status(404).send('Invoice not found');
    const inv = invR.rows[0];

    // Resolve the pay URL: per-invoice override first, otherwise the user's
    // profile-level default. Always route through the public /pay/<slug>
    // redirect so click telemetry fires even when the user pasted a direct
    // Stripe / PayPal URL into the override field.
    const directLink = inv.payment_link_url_override || me.payment_link_url || null;
    const origin = (process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const payUrl = directLink && inv.public_pay_slug
      ? `${origin}/pay/${inv.public_pay_slug}`
      : null;

    const pdf = await renderInvoicePdfBuffer(inv, me, { payUrl });
    const filename = buildInvoiceFilename(inv);
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.set('Content-Type', 'application/pdf')
      .set('Content-Disposition', `${disposition}; filename="${filename}"`)
      .set('Cache-Control', 'private, no-store')
      .send(pdf);
  } catch (err) {
    console.error('Invoice PDF error:', err);
    res.status(500).send('Failed to build invoice PDF');
  }
});

router.get('/print/finance', async (req, res) => {
  try {
    const userR = await db.query('SELECT display_name, name FROM users WHERE id = $1', [req.user.id]);
    const me = userR.rows[0] || {};

    // UK tax year runs 6 April to 5 April. Work out the current tax year window.
    const now = new Date();
    const taxYearStartYear = now.getMonth() < 3 || (now.getMonth() === 3 && now.getDate() < 6)
      ? now.getFullYear() - 1
      : now.getFullYear();
    const taxYearStart = `${taxYearStartYear}-04-06`;
    const taxYearEnd = `${taxYearStartYear + 1}-04-05`;

    const [gigsR, expensesR] = await Promise.all([
      db.query(
        `SELECT date, venue_name, fee, status FROM gigs
         WHERE user_id = $1 AND date >= $2 AND date <= $3
         ORDER BY date ASC`,
        [req.user.id, taxYearStart, taxYearEnd]
      ),
      db.query(
        `SELECT date, vendor AS description, category, amount FROM receipts
         WHERE user_id = $1 AND date >= $2 AND date <= $3
         ORDER BY date ASC`,
        [req.user.id, taxYearStart, taxYearEnd]
      ).catch(() => ({ rows: [] })),
    ]);

    const gigs = gigsR.rows;
    const expenses = expensesR.rows;
    const totalIncome = gigs.reduce((s, g) => s + (Number(g.fee) || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const net = totalIncome - totalExpenses;
    // S5-02: full-year format matches /api/earnings (e.g. "2026/27").
    const taxYearLabel = `${taxYearStartYear}/${String(taxYearStartYear + 1).slice(-2)}`;

    const gigRows = gigs.length
      ? gigs.map(g => `<tr>
          <td>${_printEscape(_fmtDate(g.date))}</td>
          <td>${_printEscape(g.venue_name || '')}</td>
          <td>${_printEscape(g.status || '')}</td>
          <td class="right">${g.fee != null ? _printEscape(_gbp(g.fee)) : ''}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" style="text-align:center;color:#888;padding:20px;">No gigs in this tax year</td></tr>`;

    const expenseRows = expenses.length
      ? expenses.map(e => `<tr>
          <td>${_printEscape(_fmtDate(e.date))}</td>
          <td>${_printEscape(e.description || '')}</td>
          <td>${_printEscape(e.category || '')}</td>
          <td class="right">${e.amount != null ? _printEscape(_gbp(e.amount)) : ''}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" style="text-align:center;color:#888;padding:20px;">No expenses in this tax year</td></tr>`;

    // HMRC category subtotals (aligned to SA103)
    const catTotals = {};
    expenses.forEach(e => {
      const k = (e.category || 'Other').trim() || 'Other';
      catTotals[k] = (catTotals[k] || 0) + (Number(e.amount) || 0);
    });
    const catRows = Object.keys(catTotals).length
      ? Object.entries(catTotals)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, total]) => `<tr>
            <td>${_printEscape(cat)}</td>
            <td class="right">${_printEscape(_gbp(total))}</td>
          </tr>`).join('')
      : '';

    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const owner = me.display_name || me.name || 'TrackMyGigs user';
    const body = `
      <h1>Finance summary</h1>
      <div class="sub">${_printEscape(owner)} \u00b7 tax year ${_printEscape(taxYearLabel)} \u00b7 exported ${_printEscape(today)}</div>
      <table>
        <thead><tr><th>Metric</th><th class="right">Value</th></tr></thead>
        <tbody>
          <tr><td>Income (gig fees)</td><td class="right">${_printEscape(_gbp(totalIncome))}</td></tr>
          <tr><td>Expenses</td><td class="right">${_printEscape(_gbp(totalExpenses))}</td></tr>
          <tr><td><strong>Net (taxable profit)</strong></td><td class="right"><strong>${_printEscape(_gbp(net))}</strong></td></tr>
        </tbody>
      </table>
      <div class="section-title">Income \u00b7 ${gigs.length} gigs</div>
      <table>
        <thead><tr><th>Date</th><th>Venue</th><th>Status</th><th class="right">Fee</th></tr></thead>
        <tbody>${gigRows}</tbody>
      </table>
      <div class="section-title">Expenses \u00b7 ${expenses.length} entries</div>
      <table>
        <thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="right">Amount</th></tr></thead>
        <tbody>${expenseRows}</tbody>
      </table>
      ${catRows ? `<div class="section-title">HMRC category totals (SA103)</div>
        <table>
          <thead><tr><th>Category</th><th class="right">Total</th></tr></thead>
          <tbody>${catRows}</tbody>
        </table>` : ''}
      <div class="totals"><span>Net for tax year ${_printEscape(taxYearLabel)}</span><span>${_printEscape(_gbp(net))}</span></div>
      <div class="meta" style="margin-top:18px;">Figures are indicative. This is not a replacement for filing a tax return. Keep source receipts and invoices for HMRC records.</div>`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(printPage('Finance summary \u00b7 TrackMyGigs', body));
  } catch (err) {
    console.error('Print finance error:', err);
    res.status(500).send('Failed to build print page');
  }
});

// =============================================================================
// 2026-04-28 dep-network batch: suggested deps for a given instrument set.
// Used by the marketplace compose rail and (later) the Send Dep panel to
// remind the user which of their existing contacts plays the instrument
// they're trying to fill. Returns up to `limit` (default 5) contacts that
// (a) are linked to a real TMG user, (b) have at least one matching
// instrument, ordered by completed gigs together with the actor (most
// reliable deps first), then name. Only contacts with notes auto-stamped
// from accepted work get the count baked in via marketplace_applications +
// offers, so brand-new contacts who've not yet worked together still show
// (count = 0) but rank below actual collaborators.
router.get('/network/suggested-deps', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 5));
    const raw = String(req.query.instruments || '').trim();
    if (!raw) return res.json({ suggestions: [] });
    const instruments = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
    if (instruments.length === 0) return res.json({ suggestions: [] });

    const q = await db.query(
      `SELECT
         c.id AS contact_id,
         c.name,
         c.instruments,
         c.linked_user_id,
         u.photo_url,
         u.allow_direct_messages,
         (
           (SELECT COUNT(*)::int FROM marketplace_applications ma2
              JOIN marketplace_gigs mg2 ON mg2.id = ma2.marketplace_gig_id
              WHERE ma2.status = 'accepted'
                AND ((mg2.poster_user_id = $1 AND ma2.applicant_user_id = u.id)
                  OR (mg2.poster_user_id = u.id AND ma2.applicant_user_id = $1)))
           +
           (SELECT COUNT(*)::int FROM offers o2
              WHERE o2.status = 'accepted'
                AND ((o2.sender_id = $1 AND o2.recipient_id = u.id)
                  OR (o2.sender_id = u.id AND o2.recipient_id = $1)))
         ) AS gigs_together_count
       FROM contacts c
       LEFT JOIN users u ON u.id = c.linked_user_id
       WHERE c.owner_id = $1
         AND c.linked_user_id IS NOT NULL
         AND c.instruments && $2::text[]
       ORDER BY gigs_together_count DESC, LOWER(c.name) ASC
       LIMIT $3`,
      [req.user.id, instruments, limit]
    );
    res.json({
      suggestions: q.rows.map(r => ({
        contact_id: r.contact_id,
        user_id: r.linked_user_id,
        name: r.name,
        instruments: Array.isArray(r.instruments) ? r.instruments : [],
        photo_url: r.photo_url || null,
        gigs_together_count: parseInt(r.gigs_together_count || 0, 10),
        accepts_dms: r.allow_direct_messages !== false
      }))
    });
  } catch (err) {
    console.error('[GET /network/suggested-deps]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// 2026-04-28 dep-network batch: top deps over the last 90 days. Drives
// the Home insights card "Your top deps this quarter" — counts accepted
// marketplace fills + accepted dep offers in either direction over the
// rolling 90-day window, returns the top N (default 3) other users by
// frequency. Skipping anything older keeps the card feeling current and
// stops it from ossifying around a relationship that's gone cold.
router.get('/network/top-deps', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(10, parseInt(req.query.limit, 10) || 3));
    const sinceDays = Math.max(7, Math.min(365, parseInt(req.query.since_days, 10) || 90));
    const rows = await db.query(
      `WITH events AS (
         SELECT
           CASE WHEN mg.poster_user_id = $1 THEN ma.applicant_user_id ELSE mg.poster_user_id END AS other_id,
           mg.gig_date AS event_date
           FROM marketplace_applications ma
           JOIN marketplace_gigs mg ON mg.id = ma.marketplace_gig_id
          WHERE ma.status = 'accepted'
            AND ((mg.poster_user_id = $1 AND ma.applicant_user_id IS NOT NULL)
              OR (ma.applicant_user_id = $1))
            AND mg.gig_date >= (CURRENT_DATE - $2::int)
         UNION ALL
         SELECT
           CASE WHEN o.sender_id = $1 THEN o.recipient_id ELSE o.sender_id END AS other_id,
           g.date AS event_date
           FROM offers o
           JOIN gigs g ON g.id = o.gig_id
          WHERE o.status = 'accepted'
            AND (o.sender_id = $1 OR o.recipient_id = $1)
            AND g.date >= (CURRENT_DATE - $2::int)
       )
       SELECT
         e.other_id,
         COALESCE(u.display_name, u.name, u.email) AS name,
         u.photo_url,
         u.instruments,
         COUNT(*)::int AS gig_count,
         MAX(e.event_date) AS most_recent
       FROM events e
       JOIN users u ON u.id = e.other_id
       WHERE e.other_id IS NOT NULL AND e.other_id <> $1
       GROUP BY e.other_id, u.display_name, u.name, u.email, u.photo_url, u.instruments
       ORDER BY gig_count DESC, most_recent DESC NULLS LAST
       LIMIT $3`,
      [req.user.id, sinceDays, limit]
    );
    res.json({
      since_days: sinceDays,
      top: rows.rows.map(r => ({
        user_id: r.other_id,
        name: r.name,
        photo_url: r.photo_url || null,
        instruments: Array.isArray(r.instruments) ? r.instruments.slice(0, 3) : [],
        gig_count: r.gig_count,
        most_recent: r.most_recent
      }))
    });
  } catch (err) {
    console.error('[GET /network/top-deps]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// 2026-04-28 dep-network batch: shared work history between the actor and
// another TMG user. Lists every accepted marketplace fill + accepted dep
// offer in either direction, newest first, capped at 25. Used by the
// directory kebab sheet so the actor can answer "what have we worked on
// together?" without leaving the directory.
router.get('/network/shared-history/:userId', async (req, res) => {
  try {
    const otherId = req.params.userId;
    if (!otherId || otherId === req.user.id) {
      return res.status(400).json({ error: 'invalid_target' });
    }
    const exists = await db.query('SELECT id FROM users WHERE id = $1', [otherId]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'not_found' });

    // Marketplace history. Either side might be poster vs applicant.
    const mp = await db.query(
      `SELECT mg.id, mg.title, mg.venue_name, mg.gig_date, mg.fee_pence, mg.is_free,
              CASE WHEN mg.poster_user_id = $1 THEN 'posted' ELSE 'applied' END AS my_role,
              ma.created_at AS event_at
         FROM marketplace_applications ma
         JOIN marketplace_gigs mg ON mg.id = ma.marketplace_gig_id
        WHERE ma.status = 'accepted'
          AND ((mg.poster_user_id = $1 AND ma.applicant_user_id = $2)
            OR (mg.poster_user_id = $2 AND ma.applicant_user_id = $1))
        ORDER BY mg.gig_date DESC NULLS LAST
        LIMIT 25`,
      [req.user.id, otherId]
    );

    // Dep offer history. The offer carries the gig FK; reach through to gigs
    // for venue + date the same way.
    const off = await db.query(
      `SELECT g.id AS gig_id, g.band_name, g.venue_name, g.date AS gig_date, g.fee,
              CASE WHEN o.sender_id = $1 THEN 'sent_offer' ELSE 'accepted_offer' END AS my_role,
              o.responded_at AS event_at
         FROM offers o
         JOIN gigs g ON g.id = o.gig_id
        WHERE o.status = 'accepted'
          AND ((o.sender_id = $1 AND o.recipient_id = $2)
            OR (o.sender_id = $2 AND o.recipient_id = $1))
        ORDER BY g.date DESC NULLS LAST
        LIMIT 25`,
      [req.user.id, otherId]
    );

    const items = [
      ...mp.rows.map(r => ({
        kind: 'marketplace',
        title: r.title,
        venue_name: r.venue_name,
        gig_date: r.gig_date,
        fee_pence: r.fee_pence,
        is_free: r.is_free,
        my_role: r.my_role
      })),
      ...off.rows.map(r => ({
        kind: 'offer',
        title: r.band_name,
        venue_name: r.venue_name,
        gig_date: r.gig_date,
        fee_pence: r.fee != null ? Math.round(parseFloat(r.fee) * 100) : null,
        is_free: false,
        my_role: r.my_role
      }))
    ].sort((a, b) => {
      const ad = a.gig_date ? new Date(a.gig_date).getTime() : 0;
      const bd = b.gig_date ? new Date(b.gig_date).getTime() : 0;
      return bd - ad;
    }).slice(0, 25);

    res.json({ count: items.length, items });
  } catch (err) {
    console.error('[GET /network/shared-history]', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Phase IX-B: GET /api/discover — Find Musicians directory.
//
// Modes:
//   name             fuzzy match on users.name, geo-ranked by distance from
//                    the searcher's home_lat/home_lng
//   email            exact (case-insensitive) match on users.email
//   phone            exact match on users.phone_normalized after E.164 parse
//   nearby           empty-state rail: discoverable users within 30 mi of the
//                    searcher's home
//   instrument_match empty-state rail: discoverable users whose instruments
//                    array overlaps the searcher's primary instruments
//
// Every mode applies:
//   - u.discoverable = TRUE
//   - u.id != actor.id
//   - NOT EXISTS user_blocks (actor blocks target)
//   - NOT EXISTS user_blocks (target blocks actor)  // decision 10: no leak
//
// Rate limits (decision 12):
//   - 30 name lookups / hour
//   - 20 email+phone lookups / hour (shared bucket)
// Over limit => 429 with Retry-After in seconds until the oldest counted
// lookup falls out of the window.
//
// Every successful call writes a discovery_lookups row with a SHA-256 hash of
// the normalised query so rate limiting and forensic review never store the
// raw email / phone / name.
//
// Response never includes email, phone, home_lat, home_lng, or full postcode
// (decision 5: outward code only).
// =============================================================================

const DISCOVER_LIMIT_NAME_PER_HOUR = 30;
const DISCOVER_LIMIT_EMAIL_PHONE_PER_HOUR = 20;
const DISCOVER_WINDOW_MS = 60 * 60 * 1000;
const DISCOVER_NEARBY_RADIUS_MILES = 30;
const DISCOVER_PAGE_SIZE = 25;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function outwardOnly(postcode) {
  if (!postcode) return null;
  const normalised = normalisePostcode(postcode);
  if (!normalised) return null;
  return normalised.split(' ')[0];
}

function gigsBucket(n) {
  const c = Number(n) || 0;
  if (c === 0) return '0';
  if (c < 10) return '1-9';
  if (c < 50) return '10-49';
  if (c < 200) return '50-199';
  return '200+';
}

// Map a raw row from the SELECT to the public card shape. Intentionally drops
// email, phone, phone_normalized, home_lat, home_lng, full postcode.
function toCardRow(row, actorLat, actorLng) {
  let distanceMiles = null;
  if (actorLat != null && actorLng != null && row.home_lat != null && row.home_lng != null) {
    const d = haversineMiles(Number(actorLat), Number(actorLng), Number(row.home_lat), Number(row.home_lng));
    if (isFinite(d)) distanceMiles = Math.round(d * 10) / 10;
  }

  const offersInvolved = Number(row.offers_involved) || 0;
  const offersAccepted = Number(row.offers_accepted) || 0;
  const acceptancePct = offersInvolved >= 5 ? Math.round((offersAccepted / offersInvolved) * 100) : null;

  return {
    id: row.id,
    display_name: row.name || 'Unnamed musician',
    instruments: Array.isArray(row.instruments) ? row.instruments.slice(0, 3) : [],
    genres: Array.isArray(row.genres) ? row.genres.slice(0, 5) : [],
    bio: row.bio || null,
    photo_url: row.photo_url || null,
    outward_postcode: outwardOnly(row.home_postcode),
    travel_radius_miles: row.travel_radius_miles != null ? Number(row.travel_radius_miles) : null,
    premium: row.subscription_tier === 'premium',
    badges: {
      email_verified: !!row.email_verified,
      joined_year: row.created_at ? new Date(row.created_at).getUTCFullYear() : null,
      gigs_bucket: gigsBucket(row.gigs_count),
      acceptance_pct: acceptancePct
    },
    distance_miles: distanceMiles,
    // 2026-04-28 chat batch: directory cards expose the open-DM flag so the
    // Find Musicians card can show Message vs Send dep contextually. Cards
    // never see other private fields (email, phone, etc.).
    allow_direct_messages: row.allow_direct_messages !== false,
    // 2026-04-28 dep-network batch: shared work history with the actor.
    // Drives the "Worked together · N gigs" pill and the "people you know"
    // sort boost in Find Musicians.
    gigs_together_count: parseInt(row.gigs_together_count || 0, 10),
    worked_with_you: parseInt(row.gigs_together_count || 0, 10) > 0
  };
}

// Central row selector. Returns the common SELECT + joins used by every mode.
// The caller appends a mode-specific WHERE clause and ORDER/LIMIT.
//
// Parameter numbering: $1 = actor_id. Caller extends with its own params.
const DISCOVER_SELECT = `
  SELECT
    u.id,
    u.name,
    u.instruments,
    u.genres,
    u.bio,
    u.photo_url,
    u.home_postcode,
    u.home_lat,
    u.home_lng,
    u.travel_radius_miles,
    u.subscription_tier,
    u.created_at,
    u.allow_direct_messages,
    (u.google_id IS NOT NULL) AS email_verified,
    (SELECT COUNT(*)::int FROM gigs g WHERE g.user_id = u.id) AS gigs_count,
    (SELECT COUNT(*)::int FROM offers o
       WHERE (o.sender_id = u.id OR o.recipient_id = u.id)) AS offers_involved,
    (SELECT COUNT(*)::int FROM offers o
       WHERE (o.sender_id = u.id OR o.recipient_id = u.id)
         AND o.status = 'accepted') AS offers_accepted,
    -- 2026-04-28 dep-network batch: shared work history with the actor.
    -- Same pair-matching as the marketplace applicant list so the Find
    -- Musicians card and the Pick row tell a consistent story.
    (
      (SELECT COUNT(*)::int FROM marketplace_applications ma2
         JOIN marketplace_gigs mg2 ON mg2.id = ma2.marketplace_gig_id
         WHERE ma2.status = 'accepted'
           AND ((mg2.poster_user_id = $1 AND ma2.applicant_user_id = u.id)
             OR (mg2.poster_user_id = u.id AND ma2.applicant_user_id = $1)))
      +
      (SELECT COUNT(*)::int FROM offers o2
         WHERE o2.status = 'accepted'
           AND ((o2.sender_id = $1 AND o2.recipient_id = u.id)
             OR (o2.sender_id = u.id AND o2.recipient_id = $1)))
    ) AS gigs_together_count
  FROM users u
  WHERE u.discoverable = TRUE
    AND u.id <> $1
    AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
`;


async function countRecentLookups(actorId, modes) {
  const rows = await db.query(
    `SELECT created_at FROM discovery_lookups
       WHERE actor_id = $1 AND mode = ANY($2::text[]) AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY created_at ASC`,
    [actorId, modes]
  );
  return rows.rows;
}

async function logLookup(actorId, mode, normalisedQuery) {
  try {
    await db.query(
      `INSERT INTO discovery_lookups (actor_id, mode, query_hash) VALUES ($1, $2, $3)`,
      [actorId, mode, sha256(normalisedQuery || '')]
    );
  } catch (err) {
    // Audit failure is non-fatal; log and move on so a temporary DB hiccup
    // cannot wedge the search endpoint.
    console.error('[discover] audit log insert failed:', err && err.message);
  }
}

// Return 429 payload + set Retry-After header, calculated from the oldest
// in-window lookup so the client gets a real countdown, not a flat 3600.
function respondRateLimited(res, rows, limit) {
  const oldest = rows[0]; // ORDER BY created_at ASC
  let retryAfter = 60;
  if (oldest && oldest.created_at) {
    const ageMs = Date.now() - new Date(oldest.created_at).getTime();
    retryAfter = Math.max(1, Math.ceil((DISCOVER_WINDOW_MS - ageMs) / 1000));
  }
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({
    error: 'rate_limited',
    message: 'Too many searches in the last hour. Try again soon.',
    limit,
    retry_after_seconds: retryAfter
  });
}

router.get('/discover', async (req, res) => {
  try {
    const actorId = req.user.id;
    const modeRaw = String(req.query.mode || '').toLowerCase();
    const validModes = ['name', 'email', 'phone', 'nearby', 'instrument_match'];
    if (!validModes.includes(modeRaw)) {
      return res.status(400).json({ error: 'invalid_mode', valid: validModes });
    }

    // Fetch actor profile for self-checks, geo ranking, and empty-state rails.
    const actorRows = await db.query(
      `SELECT id, email, home_lat, home_lng, instruments FROM users WHERE id = $1 LIMIT 1`,
      [actorId]
    );
    const actor = actorRows.rows[0];
    if (!actor) return res.status(401).json({ error: 'unknown_actor' });

    // Rate-limit check up front. name has its own 30/hr bucket; email + phone
    // share a 20/hr bucket (decision 12). nearby and instrument_match have no
    // dedicated cap but still write audit rows.
    let rateBucket = null;
    let rateLimit = 0;
    if (modeRaw === 'name') {
      rateBucket = ['name'];
      rateLimit = DISCOVER_LIMIT_NAME_PER_HOUR;
    } else if (modeRaw === 'email' || modeRaw === 'phone') {
      rateBucket = ['email', 'phone'];
      rateLimit = DISCOVER_LIMIT_EMAIL_PHONE_PER_HOUR;
    }
    if (rateBucket) {
      const recent = await countRecentLookups(actorId, rateBucket);
      if (recent.length >= rateLimit) {
        return respondRateLimited(res, recent, rateLimit);
      }
    }

    // Dispatch per mode.
    if (modeRaw === 'email') {
      const q = String(req.query.q || '').trim().toLowerCase();
      if (!q || !q.includes('@')) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      if (q === String(actor.email || '').toLowerCase()) {
        await logLookup(actorId, 'email', q);
        return res.json({
          mode: 'email',
          results: [],
          total: 0,
          self_lookup: true,
          message: "That's your own email."
        });
      }
      const rows = await db.query(
        DISCOVER_SELECT + ` AND LOWER(u.email) = $2 LIMIT 1`,
        [actorId, q]
      );
      await logLookup(actorId, 'email', q);
      return res.json({
        mode: 'email',
        results: rows.rows.map(r => toCardRow(r, actor.home_lat, actor.home_lng)),
        total: rows.rows.length
      });
    }

    if (modeRaw === 'phone') {
      const raw = String(req.query.q || '').trim();
      const normalised = normaliseE164(raw);
      if (!normalised) {
        return res.status(400).json({ error: 'invalid_phone', message: 'Enter a valid UK or international number.' });
      }
      const rows = await db.query(
        DISCOVER_SELECT + ` AND u.phone_normalized = $2 LIMIT 1`,
        [actorId, normalised]
      );
      await logLookup(actorId, 'phone', normalised);
      return res.json({
        mode: 'phone',
        results: rows.rows.map(r => toCardRow(r, actor.home_lat, actor.home_lng)),
        total: rows.rows.length
      });
    }

    if (modeRaw === 'name') {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) {
        return res.status(400).json({ error: 'query_too_short', message: 'Enter at least 2 characters.' });
      }
      // Optional instrument filter (decision 7).
      const instrumentsRaw = String(req.query.instruments || '').trim();
      const instruments = instrumentsRaw ? instrumentsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      let sql = DISCOVER_SELECT + ` AND u.name ILIKE $2`;
      const params = [actorId, `%${q}%`];
      if (instruments.length > 0) {
        params.push(instruments);
        sql += ` AND u.instruments && $${params.length}::text[]`;
      }
      // Cap at a reasonable set; we sort by distance in JS afterwards.
      sql += ` LIMIT 100`;

      const rows = await db.query(sql, params);
      const cards = rows.rows.map(r => toCardRow(r, actor.home_lat, actor.home_lng));

      // 2026-04-28 dep-network batch: rank by shared work history first
      // (so faces you already know float to the top), then geo distance,
      // then distance nulls last. Same key reused in nearby + instrument_match.
      cards.sort(networkRankComparator);

      await logLookup(actorId, 'name', q.toLowerCase());
      return res.json({
        mode: 'name',
        results: cards.slice(0, DISCOVER_PAGE_SIZE),
        total: cards.length
      });
    }

    if (modeRaw === 'nearby') {
      if (actor.home_lat == null || actor.home_lng == null) {
        return res.json({
          mode: 'nearby',
          results: [],
          total: 0,
          hint: 'Add your home postcode in Profile Settings to see musicians near you.'
        });
      }
      // Pull discoverable users with coords; filter to 30 mi in JS. Small user
      // base for MVP, can upgrade to a PostGIS GIST box filter later.
      const rows = await db.query(
        DISCOVER_SELECT + ` AND u.home_lat IS NOT NULL AND u.home_lng IS NOT NULL LIMIT 500`,
        [actorId]
      );
      const cards = rows.rows
        .map(r => toCardRow(r, actor.home_lat, actor.home_lng))
        .filter(c => c.distance_miles != null && c.distance_miles <= DISCOVER_NEARBY_RADIUS_MILES)
        .sort(networkRankComparator);

      await logLookup(actorId, 'nearby', 'rail');
      return res.json({
        mode: 'nearby',
        results: cards.slice(0, DISCOVER_PAGE_SIZE),
        total: cards.length
      });
    }

    if (modeRaw === 'instrument_match') {
      const actorInstruments = Array.isArray(actor.instruments) ? actor.instruments : [];
      if (actorInstruments.length === 0) {
        return res.json({
          mode: 'instrument_match',
          results: [],
          total: 0,
          hint: 'Add your primary instruments in Profile Settings to see musicians who play what you play.'
        });
      }
      const rows = await db.query(
        DISCOVER_SELECT + ` AND u.instruments && $2::text[] LIMIT 200`,
        [actorId, actorInstruments]
      );
      const cards = rows.rows
        .map(r => toCardRow(r, actor.home_lat, actor.home_lng))
        .sort(networkRankComparator);

      await logLookup(actorId, 'instrument_match', actorInstruments.slice().sort().join(','));
      return res.json({
        mode: 'instrument_match',
        results: cards.slice(0, DISCOVER_PAGE_SIZE),
        total: cards.length
      });
    }

    return res.status(400).json({ error: 'unreachable_mode' });
  } catch (err) {
    console.error('[discover] error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// =============================================================================
// Phase IX-D: GET /api/discover-mini — slim preview lookup for the Add Contact
// auto-suggest bridge.
//
// Modes: 'email' or 'phone' only. Returns either a single preview object
// (not a full card) or null when there is no match. The caller uses this to
// render a "Link to X on TrackMyGigs" chip above the Add Contact form.
//
// Differences vs /api/discover:
//   - No subqueries for gigs_count / offers_involved. A chip doesn't need
//     trust badges; that's the Find Musicians screen's job.
//   - Returns { match: {...} } or { match: null }, not a results array.
//   - Same rate-limit bucket (email+phone combined, 20/hr) as /api/discover.
//     A chip lookup is a discovery event, same abuse surface, so one bucket.
//   - Writes the same discovery_lookups audit row (mode='email'|'phone').
//
// Block filtering and discoverable filtering identical to /api/discover so
// an undiscoverable or blocked user never surfaces a chip.
// =============================================================================

router.get('/discover-mini', async (req, res) => {
  try {
    const actorId = req.user.id;
    const modeRaw = String(req.query.mode || '').toLowerCase();
    if (modeRaw !== 'email' && modeRaw !== 'phone') {
      return res.status(400).json({ error: 'invalid_mode', valid: ['email', 'phone'] });
    }

    const actorRows = await db.query(
      `SELECT id, email FROM users WHERE id = $1 LIMIT 1`,
      [actorId]
    );
    const actor = actorRows.rows[0];
    if (!actor) return res.status(401).json({ error: 'unknown_actor' });

    // Shared email+phone rate bucket. Same limit as /api/discover — a chip
    // lookup is still a discovery lookup, just with a lighter response.
    const recent = await countRecentLookups(actorId, ['email', 'phone']);
    if (recent.length >= DISCOVER_LIMIT_EMAIL_PHONE_PER_HOUR) {
      return respondRateLimited(res, recent, DISCOVER_LIMIT_EMAIL_PHONE_PER_HOUR);
    }

    let normalisedQuery = null;
    let whereClause = '';
    let whereParam = null;

    if (modeRaw === 'email') {
      const q = String(req.query.q || '').trim().toLowerCase();
      if (!q || !q.includes('@')) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      if (q === String(actor.email || '').toLowerCase()) {
        await logLookup(actorId, 'email', q);
        return res.json({ match: null, self_lookup: true });
      }
      normalisedQuery = q;
      whereClause = `LOWER(u.email) = $2`;
      whereParam = q;
    } else {
      const raw = String(req.query.q || '').trim();
      const normalised = normaliseE164(raw);
      if (!normalised) {
        return res.status(400).json({ error: 'invalid_phone' });
      }
      normalisedQuery = normalised;
      whereClause = `u.phone_normalized = $2`;
      whereParam = normalised;
    }

    // Slim SELECT: id, name, instruments, photo_url, home_postcode only. No
    // subqueries, no trust badges — a chip doesn't need them.
    const rows = await db.query(
      `SELECT u.id, u.name, u.instruments, u.photo_url, u.home_postcode
         FROM users u
         WHERE u.discoverable = TRUE
           AND u.id <> $1
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
           AND ${whereClause}
         LIMIT 1`,
      [actorId, whereParam]
    );

    await logLookup(actorId, modeRaw, normalisedQuery);

    if (rows.rows.length === 0) {
      return res.json({ match: null });
    }
    const r = rows.rows[0];
    return res.json({
      match: {
        id: r.id,
        display_name: r.name || 'TrackMyGigs user',
        instruments: Array.isArray(r.instruments) ? r.instruments.slice(0, 3) : [],
        photo_url: r.photo_url || null,
        outward_postcode: outwardOnly(r.home_postcode)
      }
    });
  } catch (err) {
    console.error('[discover-mini] error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// =============================================================================
// POST /api/user-blocks — add a block, symmetric effect (decision 10).
// POST /api/user-reports — file a report.
// These are minimal writes needed for the IX-C card kebab menu; full UI
// lands with IX-C/IX-E.
// =============================================================================

router.post('/user-blocks', async (req, res) => {
  try {
    const { blocked_id } = req.body || {};
    if (!blocked_id || typeof blocked_id !== 'string') {
      return res.status(400).json({ error: 'blocked_id required' });
    }
    if (blocked_id === req.user.id) {
      return res.status(400).json({ error: 'cannot_block_self' });
    }
    await db.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [req.user.id, blocked_id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[user-blocks] error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/user-blocks/:blocked_id', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [req.user.id, req.params.blocked_id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[user-blocks] delete error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

router.post('/user-reports', async (req, res) => {
  try {
    const { target_id, reason_category, reason_text } = req.body || {};
    const validCategories = ['spam', 'impersonation', 'harassment', 'fake', 'other'];
    if (!target_id || typeof target_id !== 'string') {
      return res.status(400).json({ error: 'target_id required' });
    }
    if (target_id === req.user.id) {
      return res.status(400).json({ error: 'cannot_report_self' });
    }
    if (!validCategories.includes(reason_category)) {
      return res.status(400).json({ error: 'invalid_reason_category', valid: validCategories });
    }
    const text = (reason_text || '').toString().slice(0, 1000);
    await db.query(
      `INSERT INTO user_reports (reporter_id, target_id, reason_category, reason_text)
         VALUES ($1, $2, $3, $4)`,
      [req.user.id, target_id, reason_category, text]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[user-reports] error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Phase IX-G: Admin review queue for directory reports.
// requireAdmin piggybacks on authMiddleware (already applied at router level)
// and checks the is_admin column set by the migration bootstrap.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.is_admin !== true) {
    return res.status(403).json({ error: 'admin_required' });
  }
  next();
}

router.get('/admin/reports', requireAdmin, async (req, res) => {
  try {
    const status = (req.query.status || 'open').toString();
    let whereClause;
    if (status === 'all') {
      whereClause = '';
    } else if (status === 'resolved' || status === 'dismissed') {
      whereClause = `WHERE r.resolution_status = $1`;
    } else {
      // default: open = not yet acted on
      whereClause = `WHERE r.resolution_status IS NULL`;
    }
    const params = (status === 'resolved' || status === 'dismissed') ? [status] : [];
    const result = await db.query(
      `SELECT r.id, r.reason_category, r.reason_text, r.created_at,
              r.resolution_status, r.resolved_at, r.resolver_id,
              r.reporter_id, r.target_id,
              reporter.email AS reporter_email,
              reporter.name  AS reporter_name,
              target.email   AS target_email,
              target.name    AS target_name,
              resolver.email AS resolver_email,
              resolver.name  AS resolver_name
         FROM user_reports r
         LEFT JOIN users reporter ON reporter.id = r.reporter_id
         LEFT JOIN users target   ON target.id = r.target_id
         LEFT JOIN users resolver ON resolver.id = r.resolver_id
         ${whereClause}
         ORDER BY r.created_at DESC
         LIMIT 200`,
      params
    );
    return res.json({ reports: result.rows });
  } catch (err) {
    console.error('[admin/reports] list error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

async function setReportStatus(req, res, status) {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'id_required' });
    const result = await db.query(
      `UPDATE user_reports
          SET resolution_status = $1,
              resolved_at = NOW(),
              resolver_id = $2
        WHERE id = $3
          AND resolution_status IS NULL
        RETURNING id`,
      [status, req.user.id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'report_not_found_or_already_actioned' });
    }
    return res.json({ ok: true, id: result.rows[0].id, status });
  } catch (err) {
    console.error('[admin/reports] update error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
}

router.post('/admin/reports/:id/resolve', requireAdmin, (req, res) =>
  setReportStatus(req, res, 'resolved')
);

router.post('/admin/reports/:id/dismiss', requireAdmin, (req, res) =>
  setReportStatus(req, res, 'dismissed')
);

// ---------------------------------------------------------------------------
// Phase X: Urgent-gigs marketplace
//
// Two tabs on the Browse screen: Paid (fee_pence >= 3000, is_free = FALSE) and
// Free (is_free = TRUE with a required free_reason). Shared pick/FCFS flow,
// shared applicant model, shared chat. Tab routing is a single is_free boolean
// on the row, not a forked schema.
// ---------------------------------------------------------------------------

const MARKETPLACE_FREE_REASONS = new Set([
  'charity', 'open_mic', 'promo_slot', 'favour', 'student_showcase', 'other'
]);
const MARKETPLACE_MODES = new Set(['pick', 'fcfs']);
const MARKETPLACE_SORTS = new Set([
  'nearest', 'newest', 'fee_high', 'fee_low', 'soonest'
]);
const PAID_FLOOR_PENCE = 3000;

// Shared SELECT fragment. Keeps the list/detail/mine endpoints returning the
// same shape so the frontend can pass cards from one screen to another without
// re-fetching. applicant_count is scoped to pending+accepted so withdrawn rows
// don't inflate the number the poster sees on My Posts.
const MARKETPLACE_SELECT = `
  SELECT
    mg.id,
    mg.poster_user_id,
    mg.title,
    mg.description,
    mg.venue_name,
    mg.venue_address,
    mg.venue_postcode,
    mg.venue_lat,
    mg.venue_lng,
    mg.gig_date,
    mg.start_time,
    mg.end_time,
    mg.instruments,
    mg.fee_pence,
    mg.is_free,
    mg.free_reason,
    mg.mode,
    mg.status,
    mg.filled_by_user_id,
    mg.filled_at,
    mg.expires_at,
    mg.created_at,
    mg.updated_at,
    COALESCE(u.display_name, u.name, u.email) AS poster_name,
    u.photo_url AS poster_photo_url,
    (
      SELECT COUNT(*) FROM marketplace_applications ma
      WHERE ma.marketplace_gig_id = mg.id
        AND ma.status IN ('pending', 'accepted')
    ) AS applicant_count
  FROM marketplace_gigs mg
  LEFT JOIN users u ON u.id = mg.poster_user_id
`;

// Decorate a raw marketplace_gigs row with distance_miles relative to the
// current user's home lat/lng. Used by list + detail so cards know how far
// away the gig is without a per-row round-trip on the frontend.
async function attachDistance(rows, userId) {
  if (!rows || rows.length === 0) return rows;
  const homeRes = await db.query(
    `SELECT home_lat, home_lng FROM users WHERE id = $1`,
    [userId]
  );
  const home = homeRes.rows[0] || {};
  const lat = home.home_lat, lng = home.home_lng;
  return rows.map((row) => {
    const dist = haversineMiles(lat, lng, row.venue_lat, row.venue_lng);
    return { ...row, distance_miles: dist == null ? null : Math.round(dist * 10) / 10 };
  });
}

// POST /api/marketplace
//
// Create a marketplace gig. Paid posts require fee_pence >= PAID_FLOOR_PENCE
// and is_free = FALSE. Free posts require is_free = TRUE plus a free_reason.
// Venue geocoding reuses the existing postcodes.io helper so the radius-
// badge matcher has a lat/lng to distance-check against. Default mode is
// Pick for paid, FCFS for free (can be overridden by the poster).
router.post('/marketplace', async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      title,
      description,
      venue_name,
      venue_address,
      venue_postcode,
      gig_date,
      start_time,
      end_time,
      instruments,
      fee_pence,
      is_free,
      free_reason,
      mode,
      expires_at,
    } = req.body || {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title_required' });
    }
    if (!gig_date) {
      return res.status(400).json({ error: 'gig_date_required' });
    }
    const instrumentList = toTextArray(instruments) || [];
    if (instrumentList.length === 0) {
      return res.status(400).json({ error: 'instruments_required' });
    }

    const isFree = !!is_free;
    let feeP = parseInt(fee_pence, 10);
    if (!Number.isFinite(feeP) || feeP < 0) feeP = 0;

    let reason = null;
    if (isFree) {
      reason = typeof free_reason === 'string' ? free_reason.trim().toLowerCase() : '';
      if (!MARKETPLACE_FREE_REASONS.has(reason)) {
        return res.status(400).json({ error: 'invalid_free_reason' });
      }
      feeP = 0; // normalise: a free post has no fee regardless of what was sent
    } else {
      if (feeP < PAID_FLOOR_PENCE) {
        return res.status(400).json({ error: 'below_paid_floor', floor_pence: PAID_FLOOR_PENCE });
      }
    }

    // Mode default: pick for paid, fcfs for free. Explicit value overrides.
    let modeFinal = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
    if (!MARKETPLACE_MODES.has(modeFinal)) {
      modeFinal = isFree ? 'fcfs' : 'pick';
    }

    // Expiry default: end of gig date at 23:59. If the poster supplied an
    // explicit ISO timestamp, use that.
    let expiresAt = null;
    if (expires_at) {
      const d = new Date(expires_at);
      if (!isNaN(d)) expiresAt = d.toISOString();
    }
    if (!expiresAt) {
      expiresAt = new Date(`${gig_date}T23:59:00Z`).toISOString();
    }

    // Best-effort geocode. Failure to geocode doesn't block the post — the
    // distance filter just won't work for this gig. The poster still has a
    // venue_name and venue_address for display.
    let venueLat = null, venueLng = null, venuePostcodeNorm = null;
    if (venue_postcode) {
      venuePostcodeNorm = normalisePostcode(venue_postcode);
      try {
        const geo = await lookupPostcode(venuePostcodeNorm);
        if (geo && geo.latitude && geo.longitude) {
          venueLat = geo.latitude;
          venueLng = geo.longitude;
        }
      } catch (_) { /* non-fatal */ }
    }

    const result = await db.query(
      `INSERT INTO marketplace_gigs
        (poster_user_id, title, description, venue_name, venue_address, venue_postcode,
         venue_lat, venue_lng, gig_date, start_time, end_time, instruments,
         fee_pence, is_free, free_reason, mode, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'open', $17)
       RETURNING id`,
      [
        userId,
        title.trim().slice(0, 200),
        description ? String(description).slice(0, 4000) : null,
        venue_name ? String(venue_name).slice(0, 200) : null,
        venue_address ? String(venue_address).slice(0, 500) : null,
        venuePostcodeNorm,
        venueLat,
        venueLng,
        gig_date,
        start_time || null,
        end_time || null,
        instrumentList,
        feeP,
        isFree,
        reason,
        modeFinal,
        expiresAt,
      ]
    );

    return res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[POST /marketplace]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/marketplace
//
// Browse list. Query params:
//   is_free: "true" | "false" (defaults to "false" = Paid tab)
//   instrument: comma-separated list; defaults to the user's own instruments
//   min_fee_pence: integer; defaults to user's min_fee_pence
//   max_distance_miles: integer; defaults to user's travel_radius_miles
//   show_outside_radius: "true" to drop the distance cap
//   mode: "pick" | "fcfs" (optional)
//   date_from, date_to: YYYY-MM-DD (optional)
//   sort: one of MARKETPLACE_SORTS (default "nearest")
//   limit, offset: pagination
router.get('/marketplace', async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      is_free,
      instrument,
      min_fee_pence,
      max_distance_miles,
      show_outside_radius,
      mode,
      date_from,
      date_to,
      sort,
      q,
    } = req.query || {};

    // Load user defaults so filter omissions fall back to personal prefs.
    const prefs = await db.query(
      `SELECT instruments, home_lat, home_lng, travel_radius_miles, min_fee_pence, notify_free_gigs
       FROM users WHERE id = $1`,
      [userId]
    );
    const u = prefs.rows[0] || {};

    const tabFree = String(is_free || '').toLowerCase() === 'true';
    const userInstruments = Array.isArray(u.instruments) ? u.instruments : [];
    const filterInstruments = toTextArray(instrument) || userInstruments;
    const minFee = Number.isFinite(parseInt(min_fee_pence, 10))
      ? parseInt(min_fee_pence, 10)
      : (tabFree ? 0 : (u.min_fee_pence || PAID_FLOOR_PENCE));
    const maxDistance = Number.isFinite(parseInt(max_distance_miles, 10))
      ? parseInt(max_distance_miles, 10)
      : (u.travel_radius_miles || 50);
    const showOutside = String(show_outside_radius || '').toLowerCase() === 'true';

    // Browse now includes the caller's own open posts (2026-04-23). Seeing
    // your own listing alongside everyone else's confirms it went live and
    // lets you eyeball how it reads to others. The client renders own posts
    // with a distinct "YOUR POST" chip.
    const clauses = [`mg.status = 'open'`];
    const params = [userId];
    let p = 2;

    clauses.push(`mg.is_free = $${p++}`);
    params.push(tabFree);

    if (!tabFree) {
      clauses.push(`mg.fee_pence >= $${p++}`);
      params.push(minFee);
    }

    if (filterInstruments.length > 0) {
      clauses.push(`mg.instruments && $${p++}::text[]`);
      params.push(filterInstruments);
    }

    if (mode && MARKETPLACE_MODES.has(String(mode).toLowerCase())) {
      clauses.push(`mg.mode = $${p++}`);
      params.push(String(mode).toLowerCase());
    }

    if (date_from) { clauses.push(`mg.gig_date >= $${p++}`); params.push(date_from); }
    if (date_to)   { clauses.push(`mg.gig_date <= $${p++}`); params.push(date_to); }

    // Free-text search across title + venue name (case-insensitive).
    const qTrim = typeof q === 'string' ? q.trim() : '';
    if (qTrim) {
      clauses.push(`(mg.title ILIKE $${p} OR mg.venue_name ILIKE $${p})`);
      params.push(`%${qTrim}%`);
      p++;
    }

    // Hide from users already blocked by / blocking the poster, matching the
    // directory search contract. Keeps abuse-report flows consistent across
    // surfaces.
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM user_blocks ub
      WHERE (ub.blocker_id = $1 AND ub.blocked_id = mg.poster_user_id)
         OR (ub.blocked_id = $1 AND ub.blocker_id = mg.poster_user_id)
    )`);

    // Distance is computed post-query because the haversine would need a
    // PostGIS extension to run in SQL. For the typical case (a few hundred
    // open posts at a time) the in-JS pass is fine.
    // Default sort is now 'soonest' (gig_date ASC). The Browse list reads as
    // a timeline: the next thing you could apply to sits at the top. The
    // client groups the rows into date buckets with sticky headers on top of
    // this ordering.
    const sortKey = MARKETPLACE_SORTS.has(String(sort || '').toLowerCase())
      ? String(sort).toLowerCase()
      : 'soonest';

    // SQL ORDER BY covers what we can do without distance. Distance-based
    // sorts ("nearest") are applied in JS after attachDistance.
    let orderSql = '';
    switch (sortKey) {
      case 'newest':   orderSql = 'ORDER BY mg.created_at DESC'; break;
      case 'fee_high': orderSql = 'ORDER BY mg.fee_pence DESC, mg.gig_date ASC'; break;
      case 'fee_low':  orderSql = 'ORDER BY mg.fee_pence ASC, mg.gig_date ASC'; break;
      case 'soonest':  orderSql = 'ORDER BY mg.gig_date ASC, mg.start_time ASC NULLS LAST'; break;
      default:         orderSql = 'ORDER BY mg.gig_date ASC, mg.start_time ASC NULLS LAST';
    }

    const sql = `${MARKETPLACE_SELECT}
      WHERE ${clauses.join(' AND ')}
      ${orderSql}
      LIMIT 200`;

    const result = await db.query(sql, params);
    let rows = await attachDistance(result.rows, userId);

    // Mark rows outside the user's travel radius so the UI can surface a
    // "farther than your usual radius" flag when show_outside_radius is on.
    if (u.home_lat != null && u.home_lng != null) {
      rows = rows.map((r) => ({
        ...r,
        outside_radius: r.distance_miles != null && r.distance_miles > maxDistance,
      }));
    }

    if (!showOutside && u.home_lat != null && u.home_lng != null) {
      rows = rows.filter((r) => r.distance_miles == null || r.distance_miles <= maxDistance);
    }

    if (sortKey === 'nearest') {
      rows.sort((a, b) => {
        const da = a.distance_miles == null ? Infinity : a.distance_miles;
        const db = b.distance_miles == null ? Infinity : b.distance_miles;
        return da - db;
      });
    }

    return res.json({ gigs: rows });
  } catch (err) {
    console.error('[GET /marketplace]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/marketplace/mine — poster's own posts with applicant counts.
// Ordered newest-first so the composer lands above older posts.
router.get('/marketplace/mine', async (req, res) => {
  try {
    const result = await db.query(
      `${MARKETPLACE_SELECT}
       WHERE mg.poster_user_id = $1
       ORDER BY mg.created_at DESC
       LIMIT 200`,
      [req.user.id]
    );
    return res.json({ gigs: result.rows });
  } catch (err) {
    console.error('[GET /marketplace/mine]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/marketplace/applications/mine — user's own applications with the
// gig inlined. Lets My Applications render in one round-trip.
router.get('/marketplace/applications/mine', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        ma.id AS application_id,
        ma.status AS application_status,
        ma.note,
        ma.created_at AS applied_at,
        mg.id, mg.title, mg.venue_name, mg.gig_date, mg.start_time, mg.end_time,
        mg.instruments, mg.fee_pence, mg.is_free, mg.free_reason, mg.mode,
        mg.status AS gig_status, mg.expires_at, mg.filled_by_user_id,
        COALESCE(u.display_name, u.name, u.email) AS poster_name
       FROM marketplace_applications ma
       JOIN marketplace_gigs mg ON mg.id = ma.marketplace_gig_id
       LEFT JOIN users u ON u.id = mg.poster_user_id
       WHERE ma.applicant_user_id = $1
       ORDER BY ma.created_at DESC
       LIMIT 200`,
      [req.user.id]
    );
    return res.json({ applications: result.rows });
  } catch (err) {
    console.error('[GET /marketplace/applications/mine]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/marketplace/badge-count — count of open posts matching the user's
// instruments + within travel radius + at or above their min fee. Free posts
// are included only if notify_free_gigs is on. Fast-path: if the user has
// no home lat/lng we return the instrument-matched count with no distance
// filter rather than zero, so a user who never typed a postcode still sees
// something to click.
router.get('/marketplace/badge-count', async (req, res) => {
  try {
    const userId = req.user.id;
    const prefs = await db.query(
      `SELECT instruments, home_lat, home_lng, travel_radius_miles, min_fee_pence, notify_free_gigs
       FROM users WHERE id = $1`,
      [userId]
    );
    const u = prefs.rows[0] || {};
    const instruments = Array.isArray(u.instruments) ? u.instruments : [];
    if (instruments.length === 0) return res.json({ count: 0 });

    const clauses = [
      `mg.status = 'open'`,
      `mg.poster_user_id <> $1`,
      `mg.instruments && $2::text[]`,
    ];
    const params = [userId, instruments];
    let p = 3;

    // Paid or Free-when-opted-in.
    if (u.notify_free_gigs) {
      clauses.push(`(
        (mg.is_free = FALSE AND mg.fee_pence >= $${p})
        OR mg.is_free = TRUE
      )`);
      params.push(u.min_fee_pence || PAID_FLOOR_PENCE);
      p++;
    } else {
      clauses.push(`mg.is_free = FALSE`);
      clauses.push(`mg.fee_pence >= $${p++}`);
      params.push(u.min_fee_pence || PAID_FLOOR_PENCE);
    }

    clauses.push(`NOT EXISTS (
      SELECT 1 FROM user_blocks ub
      WHERE (ub.blocker_id = $1 AND ub.blocked_id = mg.poster_user_id)
         OR (ub.blocked_id = $1 AND ub.blocker_id = mg.poster_user_id)
    )`);

    const result = await db.query(
      `SELECT mg.id, mg.venue_lat, mg.venue_lng FROM marketplace_gigs mg
       WHERE ${clauses.join(' AND ')}
       LIMIT 500`,
      params
    );

    // Distance filter in JS.
    let rows = result.rows;
    if (u.home_lat != null && u.home_lng != null) {
      const radius = u.travel_radius_miles || 50;
      rows = rows.filter((r) => {
        const d = haversineMiles(u.home_lat, u.home_lng, r.venue_lat, r.venue_lng);
        return d == null || d <= radius;
      });
    }

    return res.json({ count: rows.length });
  } catch (err) {
    console.error('[GET /marketplace/badge-count]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/marketplace/:id — single gig with poster info + distance. Does not
// expose applicant list unless the caller is the poster; applicants-list has
// its own endpoint so we can audit that access path separately.
router.get('/marketplace/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await db.query(
      `${MARKETPLACE_SELECT} WHERE mg.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    const [gig] = await attachDistance(result.rows, userId);

    // Has the current user already applied? Populates the "Applied" state
    // on the detail screen without a second round-trip.
    const appRes = await db.query(
      `SELECT id, status, note, created_at FROM marketplace_applications
       WHERE marketplace_gig_id = $1 AND applicant_user_id = $2`,
      [id, userId]
    );
    gig.my_application = appRes.rows[0] || null;
    gig.is_poster = gig.poster_user_id === userId;

    return res.json({ gig });
  } catch (err) {
    console.error('[GET /marketplace/:id]', err);
    // Surface the message so we can debug from the client during the demo —
    // applicants were getting a generic server_error on filled gigs and we
    // need to see why. Stack stays in server logs.
    return res.status(500).json({ error: 'server_error', message: err && err.message });
  }
});

// GET /api/marketplace/:id/applicants — poster-only list. Rows include
// applicant profile snippet (name, photo, bio, rating stub, gigs_completed)
// so the applicant preview modal renders without a second round-trip.
router.get('/marketplace/:id/applicants', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const own = await db.query(
      `SELECT poster_user_id FROM marketplace_gigs WHERE id = $1`,
      [id]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    if (own.rows[0].poster_user_id !== userId) {
      return res.status(403).json({ error: 'not_poster' });
    }

    const apps = await db.query(
      `SELECT
        ma.id AS application_id,
        ma.status,
        ma.note,
        ma.created_at AS applied_at,
        u.id AS user_id,
        COALESCE(u.display_name, u.name, u.email) AS name,
        u.photo_url,
        u.bio,
        u.instruments,
        u.home_lat,
        u.home_lng,
        (
          -- gigs.date is the actual column name (marketplace_gigs uses
          -- gig_date, they were crossed). Old query used g.gig_date which
          -- silently 500-ed the applicants endpoint on any post that
          -- had applicants. Caught by the 2026-04-23 stress harness.
          SELECT COUNT(*) FROM gigs g
          WHERE g.user_id = u.id AND g.date < CURRENT_DATE
        ) AS gigs_completed,
        -- 2026-04-28 dep-network batch: have the poster and this applicant
        -- worked together before? Counts accepted marketplace fills + accepted
        -- dep offers in either direction so a single applicant who has both
        -- band-led and dep'd for the poster shows the full history. Used by
        -- the Pick screen to surface a "Worked together · N gigs" pill.
        (
          (SELECT COUNT(*)::int FROM marketplace_applications ma2
             JOIN marketplace_gigs mg2 ON mg2.id = ma2.marketplace_gig_id
             WHERE ma2.status = 'accepted'
               AND ma2.id <> ma.id
               AND ((mg2.poster_user_id = $2 AND ma2.applicant_user_id = u.id)
                 OR (mg2.poster_user_id = u.id AND ma2.applicant_user_id = $2)))
          +
          (SELECT COUNT(*)::int FROM offers o2
             WHERE o2.status = 'accepted'
               AND ((o2.sender_id = $2 AND o2.recipient_id = u.id)
                 OR (o2.sender_id = u.id AND o2.recipient_id = $2)))
        ) AS gigs_together_count
       FROM marketplace_applications ma
       JOIN users u ON u.id = ma.applicant_user_id
       WHERE ma.marketplace_gig_id = $1
         AND ma.status <> 'withdrawn'
       ORDER BY
         CASE ma.status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
         ma.created_at ASC`,
      [id, userId]
    );

    // Decorate with distance from gig venue so the poster sees how far each
    // applicant is from the gig.
    const gigRes = await db.query(
      `SELECT venue_lat, venue_lng FROM marketplace_gigs WHERE id = $1`, [id]
    );
    const venue = gigRes.rows[0] || {};
    const decorated = apps.rows.map((a) => {
      const d = haversineMiles(venue.venue_lat, venue.venue_lng, a.home_lat, a.home_lng);
      const togetherCount = parseInt(a.gigs_together_count || 0, 10);
      return {
        ...a,
        distance_miles: d == null ? null : Math.round(d * 10) / 10,
        is_new_to_tmg: (a.gigs_completed == null ? 0 : parseInt(a.gigs_completed, 10)) === 0,
        worked_with_you: togetherCount > 0,
        gigs_together_count: togetherCount,
      };
    });
    // Strip raw lat/lng from the response — the applicant's home location
    // isn't the poster's business, only the resulting distance.
    decorated.forEach((a) => { delete a.home_lat; delete a.home_lng; });

    return res.json({ applicants: decorated });
  } catch (err) {
    console.error('[GET /marketplace/:id/applicants]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/marketplace/:id/apply — applicant submits a note. In FCFS mode
// the first successful apply auto-fills the gig inside a transaction so two
// simultaneous applies can't both win. In Pick mode the row lands as
// 'pending' and the poster picks later.
router.post('/marketplace/:id/apply', async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { note } = req.body || {};
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const lock = await client.query(
      `SELECT id, poster_user_id, mode, status, is_free, instruments
       FROM marketplace_gigs WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (lock.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    const gig = lock.rows[0];
    if (gig.poster_user_id === userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'own_post' });
    }
    if (gig.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'not_open', gig_status: gig.status });
    }

    // FCFS path: mark gig filled inside the same transaction the application
    // inserts in. Any losing parallel request sees status != 'open' and bails
    // with the locked-FCFS error.
    if (gig.mode === 'fcfs') {
      await client.query(
        `INSERT INTO marketplace_applications (marketplace_gig_id, applicant_user_id, note, status)
         VALUES ($1, $2, $3, 'accepted')
         ON CONFLICT (marketplace_gig_id, applicant_user_id)
         DO UPDATE SET note = EXCLUDED.note, status = 'accepted'`,
        [id, userId, note ? String(note).slice(0, 1000) : null]
      );
      await client.query(
        `UPDATE marketplace_gigs
         SET status = 'filled', filled_by_user_id = $2, filled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [id, userId]
      );

      // 2026-04-28 dep-network batch: auto-add the contact pair on a successful
      // first-come-first-served take. Symmetric with the Pick path above.
      try {
        const ctxRow = await client.query(
          `SELECT title, venue_name, gig_date FROM marketplace_gigs WHERE id = $1`,
          [id]
        );
        const ctx = ctxRow.rows[0] || {};
        const dateStr = ctx.gig_date ? new Date(ctx.gig_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        const ctxNote = `Marketplace: ${ctx.title || 'gig'} at ${ctx.venue_name || 'venue'}${dateStr ? ', ' + dateStr : ''}`;
        await upsertContactPair(client, gig.poster_user_id, userId, ctxNote);
      } catch (contactErr) {
        console.warn('[POST /marketplace/:id/apply fcfs] contact upsert failed:', contactErr);
      }

      await client.query('COMMIT');
      return res.json({ ok: true, mode: 'fcfs', status: 'accepted' });
    }

    // Pick path: pending application, poster picks later.
    await client.query(
      `INSERT INTO marketplace_applications (marketplace_gig_id, applicant_user_id, note, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (marketplace_gig_id, applicant_user_id)
       DO UPDATE SET note = EXCLUDED.note, status = 'pending'`,
      [id, userId, note ? String(note).slice(0, 1000) : null]
    );
    await client.query('COMMIT');
    return res.json({ ok: true, mode: 'pick', status: 'pending' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /marketplace/:id/apply]', err);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// POST /api/marketplace/:id/pick — poster accepts an applicant (Pick mode).
// All other pending applicants get marked 'rejected' in the same transaction
// so the My Applications screen shows a clean outcome to everyone.
router.post('/marketplace/:id/pick', async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const { applicant_user_id } = req.body || {};
  if (!applicant_user_id) return res.status(400).json({ error: 'applicant_required' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const own = await client.query(
      `SELECT poster_user_id, status, mode FROM marketplace_gigs WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (own.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
    if (own.rows[0].poster_user_id !== userId) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'not_poster' }); }
    if (own.rows[0].status !== 'open') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'not_open' }); }

    // Ensure the applicant actually applied to this gig.
    const appCheck = await client.query(
      `SELECT id FROM marketplace_applications
       WHERE marketplace_gig_id = $1 AND applicant_user_id = $2 AND status = 'pending'`,
      [id, applicant_user_id]
    );
    if (appCheck.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'applicant_not_pending' }); }

    await client.query(
      `UPDATE marketplace_applications
       SET status = CASE
         WHEN applicant_user_id = $2 THEN 'accepted'
         ELSE 'rejected'
       END
       WHERE marketplace_gig_id = $1 AND status = 'pending'`,
      [id, applicant_user_id]
    );
    await client.query(
      `UPDATE marketplace_gigs
       SET status = 'filled', filled_by_user_id = $2, filled_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, applicant_user_id]
    );

    // 2026-04-28 chat batch: open a chat thread between poster and applicant
    // so both parties can sort logistics (load-in, dress code, fee confirm)
    // without leaving the app. Re-uses any existing 1-to-1 thread between the
    // pair so back-and-forth Pick/Cancel/Pick cycles don't pile up empties.
    let threadId = null;
    const posterIdForChat = own.rows[0].poster_user_id;
    try {
      const posterId = posterIdForChat;
      const pair = [posterId, applicant_user_id].sort();
      const existing = await client.query(
        `SELECT id FROM threads
         WHERE gig_id IS NULL
           AND participant_ids @> $1::uuid[]
           AND participant_ids <@ $1::uuid[]
         ORDER BY created_at DESC
         LIMIT 1`,
        [pair]
      );
      if (existing.rows.length > 0) {
        threadId = existing.rows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO threads (gig_id, thread_type, participant_ids)
           VALUES (NULL, 'dep', $1::uuid[])
           RETURNING id`,
          [pair]
        );
        threadId = ins.rows[0].id;
      }
    } catch (threadErr) {
      // Don't roll back the Pick if thread bootstrap fails — the user can
      // still open the conversation manually from the directory or inbox.
      console.warn('[POST /marketplace/:id/pick] thread bootstrap failed:', threadErr);
    }

    // 2026-04-28 dep-network batch: auto-save the dep relationship on both
    // sides. Pull venue + date from the just-locked marketplace row so the
    // note has real context the user will recognise next time they see it.
    try {
      const ctxRow = await client.query(
        `SELECT title, venue_name, gig_date FROM marketplace_gigs WHERE id = $1`,
        [id]
      );
      const ctx = ctxRow.rows[0] || {};
      const dateStr = ctx.gig_date ? new Date(ctx.gig_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      const ctxNote = `Marketplace: ${ctx.title || 'gig'} at ${ctx.venue_name || 'venue'}${dateStr ? ', ' + dateStr : ''}`;
      await upsertContactPair(client, posterIdForChat, applicant_user_id, ctxNote);
    } catch (contactErr) {
      console.warn('[POST /marketplace/:id/pick] contact upsert failed:', contactErr);
    }

    await client.query('COMMIT');
    return res.json({ ok: true, thread_id: threadId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /marketplace/:id/pick]', err);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// POST /api/marketplace/:id/cancel — poster withdraws an open post. Applicants
// are not notified automatically; the status change is enough because My
// Applications reads the gig status live. Not available once the gig is
// filled (use Cancel gig from the booked flow instead).
router.post('/marketplace/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE marketplace_gigs
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND poster_user_id = $2 AND status = 'open'
       RETURNING id`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found_or_not_cancellable' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /marketplace/:id/cancel]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/marketplace/:id/withdraw — applicant pulls their pending application.
// Only valid while the application is still pending and the gig is still open:
// once picked or filled the row is locked in as the booking record.
router.post('/marketplace/:id/withdraw', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await db.query(
      `UPDATE marketplace_applications
       SET status = 'withdrawn'
       WHERE marketplace_gig_id = $1
         AND applicant_user_id = $2
         AND status = 'pending'
       RETURNING id`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found_or_not_pending' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /marketplace/:id/withdraw]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// PATCH /api/marketplace/:id/application — applicant edits the note on their
// pending application. Locked once the application is picked or the gig fills.
router.patch('/marketplace/:id/application', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { note } = req.body || {};
    const clean = note == null ? null : String(note).slice(0, 1000);
    const result = await db.query(
      `UPDATE marketplace_applications
       SET note = $3
       WHERE marketplace_gig_id = $1
         AND applicant_user_id = $2
         AND status = 'pending'
       RETURNING id, note`,
      [id, userId, clean]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found_or_not_pending' });
    }
    return res.json({ ok: true, note: result.rows[0].note });
  } catch (err) {
    console.error('[PATCH /marketplace/:id/application]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/marketplace/:id/repost — duplicate an expired or cancelled post
// with a fresh expires_at window. The poster can PATCH fee_pence / expires_at
// in the body to tweak before republishing. Returns the new gig id.
router.post('/marketplace/:id/repost', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { fee_pence, expires_at, gig_date } = req.body || {};

    const src = await db.query(
      `SELECT * FROM marketplace_gigs WHERE id = $1 AND poster_user_id = $2`,
      [id, userId]
    );
    if (src.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const g = src.rows[0];

    const newFee = Number.isFinite(parseInt(fee_pence, 10)) ? parseInt(fee_pence, 10) : g.fee_pence;
    if (!g.is_free && newFee < PAID_FLOOR_PENCE) {
      return res.status(400).json({ error: 'below_paid_floor', floor_pence: PAID_FLOOR_PENCE });
    }

    const newGigDate = gig_date || g.gig_date;
    let newExpiresAt = null;
    if (expires_at) {
      const d = new Date(expires_at);
      if (!isNaN(d)) newExpiresAt = d.toISOString();
    }
    if (!newExpiresAt) {
      newExpiresAt = new Date(`${newGigDate instanceof Date ? newGigDate.toISOString().slice(0,10) : newGigDate}T23:59:00Z`).toISOString();
    }

    const ins = await db.query(
      `INSERT INTO marketplace_gigs
        (poster_user_id, title, description, venue_name, venue_address, venue_postcode,
         venue_lat, venue_lng, gig_date, start_time, end_time, instruments,
         fee_pence, is_free, free_reason, mode, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'open', $17)
       RETURNING id`,
      [
        userId, g.title, g.description, g.venue_name, g.venue_address, g.venue_postcode,
        g.venue_lat, g.venue_lng, newGigDate, g.start_time, g.end_time, g.instruments,
        newFee, g.is_free, g.free_reason, g.mode, newExpiresAt,
      ]
    );

    return res.json({ ok: true, id: ins.rows[0].id });
  } catch (err) {
    console.error('[POST /marketplace/:id/repost]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/marketplace/:id/similar — three other open gigs matching the
// locked gig's instruments and within the user's travel radius. Feeds the
// softer locked-FCFS state ("someone got there first — here are three
// similar nearby gigs").
router.get('/marketplace/:id/similar', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const src = await db.query(
      `SELECT instruments, is_free FROM marketplace_gigs WHERE id = $1`, [id]
    );
    if (src.rows.length === 0) return res.json({ gigs: [] });
    const g = src.rows[0];

    const u = (await db.query(
      `SELECT home_lat, home_lng, travel_radius_miles, min_fee_pence FROM users WHERE id = $1`,
      [userId]
    )).rows[0] || {};

    const result = await db.query(
      `${MARKETPLACE_SELECT}
       WHERE mg.id <> $1
         AND mg.status = 'open'
         AND mg.poster_user_id <> $2
         AND mg.is_free = $3
         AND mg.instruments && $4::text[]
       ORDER BY mg.created_at DESC
       LIMIT 20`,
      [id, userId, g.is_free, g.instruments || []]
    );
    let rows = await attachDistance(result.rows, userId);
    if (u.home_lat != null) {
      const radius = u.travel_radius_miles || 50;
      rows = rows.filter((r) => r.distance_miles == null || r.distance_miles <= radius);
    }
    rows.sort((a, b) => {
      const da = a.distance_miles == null ? Infinity : a.distance_miles;
      const db = b.distance_miles == null ? Infinity : b.distance_miles;
      return da - db;
    });

    return res.json({ gigs: rows.slice(0, 3) });
  } catch (err) {
    console.error('[GET /marketplace/:id/similar]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
