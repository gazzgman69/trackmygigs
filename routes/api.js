const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const calendarRouter = require('./calendar');

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

// Fire-and-forget helper — never let sync failures break API responses.
// The gig has already been saved locally; Google is a mirror.
function syncGigSafely(action, userId, gig) {
  try {
    if (!gig) return;
    const fn = action === 'delete'
      ? calendarRouter.removeGigFromGoogle
      : calendarRouter.pushGigToGoogle;
    if (typeof fn !== 'function') return;
    Promise.resolve(fn(userId, gig)).catch((err) => {
      console.error(`Calendar ${action} sync failed (non-fatal):`, err.message || err);
    });
  } catch (err) {
    console.error('syncGigSafely error:', err);
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
    } = req.body;

    const result = await db.query(
      `INSERT INTO gigs (user_id, band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, gig_type, parking_info, day_of_contact, mileage_miles)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        fee,
        status || 'confirmed',
        source || 'manual',
        dress_code,
        notes,
        gig_type || null,
        parking_info || null,
        day_of_contact || null,
        mileage_miles || null,
      ]
    );

    const gig = result.rows[0];
    syncGigSafely('create', req.user.id, gig);
    res.json(gig);
  } catch (error) {
    console.error('Create gig error:', error);
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
    const { band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, checklist, gig_type, details_complete, set_times, parking_info, day_of_contact, mileage_miles } = req.body;
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
        mileage_miles = COALESCE($21, mileage_miles)
       WHERE id = $13 AND user_id = $14 RETURNING *`,
      [band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, req.params.id, req.user.id, checklist ? JSON.stringify(checklist) : null, gig_type || null, details_complete != null ? details_complete : null, set_times ? JSON.stringify(set_times) : null, parking_info || null, day_of_contact || null, mileage_miles != null ? mileage_miles : null]
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
            venue_address, venue_name, description, notes, recipient_email } = req.body;

    const effectiveStatus = status || 'draft';
    const sentAt = effectiveStatus === 'sent' ? new Date() : null;

    const result = await db.query(
      `INSERT INTO invoices (user_id, gig_id, band_name, amount, status, invoice_number, payment_terms, due_date,
                             venue_address, venue_name, description, notes, recipient_email, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
        sentAt,
      ]
    );

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
         o.snoozed_until,
         g.band_name, g.venue_name, g.venue_address,
         g.date as gig_date, g.start_time, g.end_time, g.dress_code,
         u.display_name as sender_display_name, u.name as sender_name
       FROM offers o
       LEFT JOIN gigs g ON g.id = o.gig_id
       LEFT JOIN users u ON u.id = o.sender_id
       WHERE o.recipient_id = $1 AND o.sender_id != $1
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get offers error:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
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

    // Mark the original offer cancelled.
    await db.query(
      `UPDATE offers SET status = 'cancelled', responded_at = NOW() WHERE id = $1`,
      [id]
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

router.get('/user/profile', async (req, res) => {
  try {
    res.json(req.user);
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
            rate_standard, rate_premium, rate_dep, rate_deposit_pct, rate_notes } = req.body;

    // instruments comes as a comma-separated string from the client but the
    // column is TEXT[].  Convert it to a proper PG array (or null to keep
    // the existing value via COALESCE).
    let instrumentsArr = null;
    if (instruments) {
      instrumentsArr = instruments.split(',').map(s => s.trim()).filter(Boolean);
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
       rate_notes = COALESCE($23, rate_notes)
       WHERE id = $8 RETURNING *`,
      [name, phone, instrumentsArr, home_postcode, avatar_url, google_review_url, facebook_review_url, req.user.id,
       bank_details, invoice_prefix, invoice_next_number, invoice_format, colour_theme, display_name,
       epk_bio, epk_photo_url, epk_video_url, epk_audio_url,
       rate_standard || null, rate_premium || null, rate_dep || null,
       rate_deposit_pct != null && rate_deposit_pct !== '' ? parseInt(rate_deposit_pct, 10) : null,
       rate_notes]
    );

    res.json(result.rows[0]);
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
    await db.query(
      `INSERT INTO blocked_dates (user_id, date, reason, recurring_pattern)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [req.user.id, dateValue, reason || null, pattern]
    );
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
    if (client) {
      // Prefer explicit transaction if the db adapter exposes getClient.
      try {
        await client.query('BEGIN');
        for (const d of clean) {
          const r = await client.query(
            `INSERT INTO blocked_dates (user_id, date, reason, recurring_pattern)
             VALUES ($1, $2, $3, NULL)
             ON CONFLICT DO NOTHING`,
            [req.user.id, d, reason || null]
          );
          inserted += r.rowCount || 0;
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
         ON CONFLICT DO NOTHING`,
        params
      );
      inserted = r.rowCount || 0;
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
      'DELETE FROM blocked_dates WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Not found' });
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
      await db.query(
        `INSERT INTO offers (sender_id, recipient_id, gig_id, offer_type, status, fee)
         VALUES ($1, $2, $3, 'dep', 'pending',
                 (SELECT fee FROM gigs WHERE id = $3 AND user_id = $1))`,
        [req.user.id, recipientId, gig_id]
      );
      sent++;
    }

    res.json({ success: true, sent, unresolved, total: contactRows.length });
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

router.get('/distance', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return res.json({ distance: null });

  const origin = req.query.origin;
  const dest = req.query.destination;
  if (!origin || !dest) return res.json({ distance: null });

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(dest)}&units=imperial&key=${key}`;
    const response = await fetch(url);
    const data = await response.json();
    const element = data.rows?.[0]?.elements?.[0];
    if (element?.status === 'OK') {
      res.json({
        distance: element.distance?.text || null,
        duration: element.duration?.text || null,
        miles: element.distance ? Math.round(element.distance.value / 1609.34) : null,
      });
    } else {
      res.json({ distance: null });
    }
  } catch (error) {
    console.error('Distance matrix error:', error);
    res.json({ distance: null });
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
      overdueResult,
      draftResult,
      unreadResult,
      offersResult,
      activeDepResult,
      monthlyBreakdownResult,
      recentMessagesResult,
      networkOffersResult,
      overdueCountResult,
      draftCountResult,
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
      // Overdue invoice
      db.query(
        `SELECT id, amount, band_name FROM invoices
         WHERE user_id = $1 AND status = 'sent' AND due_date < $2
         ORDER BY due_date ASC LIMIT 1`,
        [userId, today]
      ),
      // Draft invoice
      db.query(
        `SELECT id, amount, band_name FROM invoices
         WHERE user_id = $1 AND status = 'draft'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      ),
      // Unread messages
      db.query(
        `SELECT COUNT(*) as count FROM messages
         WHERE thread_id IN (SELECT id FROM threads WHERE participant_ids @> ARRAY[$1::uuid])
         AND NOT (read_by @> ARRAY[$1::uuid])`,
        [userId]
      ),
      // Pending offers
      db.query(
        `SELECT COUNT(*) as count FROM offers
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
      // Monthly breakdown for Home forecast chart (past 6 months + next 6 months)
      db.query(
        `SELECT TO_CHAR(DATE_TRUNC('month', date), 'Mon YY') AS month_label,
                DATE_TRUNC('month', date)::date AS month_start,
                COALESCE(SUM(fee) FILTER (WHERE status = 'confirmed'), 0) AS earnings,
                COUNT(*) AS gigs
         FROM gigs
         WHERE user_id = $1
           AND date >= DATE_TRUNC('month', NOW()) - INTERVAL '6 months'
           AND date <  DATE_TRUNC('month', NOW()) + INTERVAL '6 months'
         GROUP BY DATE_TRUNC('month', date)
         ORDER BY DATE_TRUNC('month', date) ASC`,
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
      // Network offers (pending dep offers sent to the user - same as offer_count,
      // but kept separately so the UI chip can read the expected key)
      db.query(
        `SELECT COUNT(*) as count FROM offers
         WHERE recipient_id = $1 AND status = 'pending' AND offer_type = 'dep'`,
        [userId]
      ),
      // Real overdue invoice count (not the LIMIT-1 proxy)
      db.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM invoices
         WHERE user_id = $1 AND status = 'sent' AND due_date < $2`,
        [userId, today]
      ),
      // Real draft invoice count (not the LIMIT-1 proxy)
      db.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM invoices
         WHERE user_id = $1 AND status = 'draft'`,
        [userId]
      ),
    ]);

    const overdueInvoice = overdueResult.rows[0] || null;
    const draftInvoice = draftResult.rows[0] || null;
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
      earnings: parseFloat(r.earnings || 0),
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

    res.json({
      next_gig: nextGigResult.rows[0] || null,
      // Field names matching frontend expectations
      month_earnings: parseFloat(thisMonthResult.rows[0]?.earnings || 0),
      month_gigs: parseInt(thisMonthResult.rows[0]?.count || 0),
      year_earnings: parseFloat(taxYearResult.rows[0]?.earnings || 0),
      year_gigs: parseInt(taxYearResult.rows[0]?.count || 0),
      overdue_invoices: parseInt(overdueCountResult.rows[0]?.count || 0),
      overdue_total: parseFloat(overdueCountResult.rows[0]?.total || 0),
      draft_invoices: parseInt(draftCountResult.rows[0]?.count || 0),
      draft_total: parseFloat(draftCountResult.rows[0]?.total || 0),
      overdue_invoice_preview: overdueInvoice || null,
      draft_invoice_preview: draftInvoice || null,
      // S11-05: unread_notifications is a superset of unread_messages.
      // It combines chat unreads + pending offers + overdue invoices so the
      // header dot lights up for anything the user needs to attend to, not
      // just chat. Previously both fields were identical which meant paid
      // invoices, incoming offers, and calendar imports never triggered the dot.
      unread_notifications:
        parseInt(unreadResult.rows[0]?.count || 0) +
        parseInt(offersResult.rows[0]?.count || 0) +
        parseInt(overdueCountResult.rows[0]?.count || 0),
      unread_messages: parseInt(unreadResult.rows[0]?.count || 0),
      offer_count: parseInt(offersResult.rows[0]?.count || 0),
      network_offers: parseInt(networkOffersResult.rows[0]?.count || 0),
      monthly_breakdown: monthlyBreakdown,
      recent_messages: recentMessages,
      active_dep_request: activeDepRequest,
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

// ── Public share token (calendar ICS feed) ───────────────────────────────────
// GET returns { token, enabled }; POST toggles on/off and generates a token on demand.
router.get('/share-token', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT share_token, share_token_enabled FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = r.rows[0] || {};
    res.json({
      token: row.share_token_enabled ? (row.share_token || null) : null,
      enabled: !!row.share_token_enabled,
    });
  } catch (error) {
    console.error('Get share-token error:', error);
    res.status(500).json({ error: 'Failed to fetch share token' });
  }
});

router.post('/share-token', async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (!enabled) {
      await db.query(
        'UPDATE users SET share_token_enabled = false WHERE id = $1',
        [req.user.id]
      );
      return res.json({ token: null, enabled: false });
    }
    // Enabling: ensure a token exists (rotate-safe: only generates if missing)
    const existing = await db.query(
      'SELECT share_token FROM users WHERE id = $1',
      [req.user.id]
    );
    let token = existing.rows[0]?.share_token;
    if (!token) {
      // 32-char url-safe token
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      token = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }
    await db.query(
      'UPDATE users SET share_token = $1, share_token_enabled = true WHERE id = $2',
      [token, req.user.id]
    );
    res.json({ token, enabled: true });
  } catch (error) {
    console.error('Set share-token error:', error);
    res.status(500).json({ error: 'Failed to update share token' });
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
    const { name, email, phone, instruments, notes, location, is_favourite } = req.body;
    const instrumentsArr = toTextArray(instruments);
    const result = await db.query(
      `INSERT INTO contacts (owner_id, name, email, phone, instruments, notes, location, is_favourite)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8)
       RETURNING *`,
      [req.user.id, name, email || null, phone || null, instrumentsArr, notes || null, location || null, !!is_favourite]
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

    const notifications = [];

    // Upcoming gigs in next 3 days
    const gigsResult = await db.query(
      `SELECT id, band_name, venue_name, date FROM gigs
       WHERE user_id = $1 AND date > $2 AND date <= $3
       ORDER BY date ASC`,
      [userId, today, threeDaysFromNow]
    );

    gigsResult.rows.forEach(gig => {
      notifications.push({
        type: 'gig',
        title: 'Upcoming gig',
        subtitle: `${gig.band_name} at ${gig.venue_name} on ${gig.date}`,
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
        subtitle: `${inv.band_name} - ${inv.amount} due ${inv.due_date}`,
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
        subtitle: `Offer deadline ${offer.deadline}`,
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
    const { status, sent_at, paid_at, recipient_email } = req.body;

    // Auto-set transition timestamps so the client never has to remember.
    // If the client explicitly sends a value we keep it; otherwise we stamp NOW()
    // on the first transition into 'sent' or 'paid'.
    const effectiveSentAt = sent_at || (status === 'sent' ? new Date().toISOString() : null);
    const effectivePaidAt = paid_at || (status === 'paid' ? new Date().toISOString() : null);

    const result = await db.query(
      `UPDATE invoices SET
         status = COALESCE($1, status),
         sent_at = COALESCE($2, sent_at),
         paid_at = COALESCE($3, paid_at),
         recipient_email = COALESCE($4, recipient_email)
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [status, effectiveSentAt, effectivePaidAt, recipient_email || null, req.params.id, req.user.id]
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
      `SELECT display_name, name, business_address, vat_number, bank_details
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
    if (me.vat_number) fromMetaBits.push(`VAT: ${_printEscape(me.vat_number)}`);

    const billTo = inv.band_name || inv.g_band || '';
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
        ${bankBlock}
        ${inv.notes ? `<div style="margin-top:14px;font-size:11px;color:#555;white-space:pre-line;">${_printEscape(inv.notes)}</div>` : ''}
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

module.exports = router;
