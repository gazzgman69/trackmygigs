const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

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
    } = req.body;

    const result = await db.query(
      `INSERT INTO gigs (user_id, band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, gig_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
      ]
    );

    res.json(result.rows[0]);
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
    const { band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, checklist, gig_type, details_complete } = req.body;
    const result = await db.query(
      `UPDATE gigs SET
        band_name = COALESCE($1, band_name), venue_name = COALESCE($2, venue_name),
        venue_address = COALESCE($3, venue_address), date = COALESCE($4, date),
        start_time = COALESCE($5, start_time), end_time = COALESCE($6, end_time),
        load_in_time = COALESCE($7, load_in_time), fee = COALESCE($8, fee),
        status = COALESCE($9, status), source = COALESCE($10, source),
        dress_code = COALESCE($11, dress_code), notes = COALESCE($12, notes),
        checklist = COALESCE($15, checklist), gig_type = COALESCE($16, gig_type),
        details_complete = COALESCE($17, details_complete)
       WHERE id = $13 AND user_id = $14 RETURNING *`,
      [band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes, req.params.id, req.user.id, checklist ? JSON.stringify(checklist) : null, gig_type || null, details_complete != null ? details_complete : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update gig error:', error);
    res.status(500).json({ error: 'Failed to update gig' });
  }
});

router.delete('/gigs/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM gigs WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Gig not found' });
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
            venue_address, venue_name, description, notes } = req.body;

    const result = await db.query(
      `INSERT INTO invoices (user_id, gig_id, band_name, amount, status, invoice_number, payment_terms, due_date,
                             venue_address, venue_name, description, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        req.user.id,
        gig_id,
        band_name,
        amount,
        status || 'draft',
        invoice_number,
        payment_terms,
        due_date,
        venue_address || null,
        venue_name || null,
        description || null,
        notes || null,
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
      'SELECT * FROM offers WHERE recipient_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get offers error:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
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
    const { name, phone, instruments, home_postcode, avatar_url, google_review_url, facebook_review_url } = req.body;

    const result = await db.query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), instruments = COALESCE($3, instruments),
       home_postcode = COALESCE($4, home_postcode), avatar_url = COALESCE($5, avatar_url),
       google_review_url = COALESCE($6, google_review_url), facebook_review_url = COALESCE($7, facebook_review_url)
       WHERE id = $8 RETURNING *`,
      [name, phone, instruments, home_postcode, avatar_url, google_review_url, facebook_review_url, req.user.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── Expenses / Receipts ──────────────────────────────────────────────────────
// Uses the receipts table from schema (vendor=description, category, date, amount)

router.get('/expenses', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, vendor AS description, amount, category, date FROM receipts WHERE user_id = $1 ORDER BY date DESC',
      [req.user.id]
    );
    res.json({ expenses: result.rows });
  } catch (error) {
    console.error('Get expenses error:', error);
    res.json({ expenses: [] });
  }
});

router.post('/expenses', async (req, res) => {
  try {
    const { amount, description, date, category } = req.body;
    await db.query(
      `INSERT INTO receipts (user_id, vendor, amount, category, date)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, description, amount, category || 'Other', date || new Date()]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Create expense error:', error);
    res.status(500).json({ error: 'Failed to save expense' });
  }
});

// ── Blocked Dates ────────────────────────────────────────────────────────────
// Uses existing blocked_dates table; stores range start in date, reason, and
// recurring_pattern for recurring/range modes

router.get('/blocked-dates', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM blocked_dates WHERE user_id = $1 ORDER BY date ASC',
      [req.user.id]
    );
    res.json(result.rows);
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
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, dateValue, reason || null, pattern]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Block date error:', error);
    res.status(500).json({ error: 'Failed to block date' });
  }
});

// ── Dep Offers ───────────────────────────────────────────────────────────────
// Uses the existing offers table (offer_type='dep', status='pending')

router.post('/dep-offers', async (req, res) => {
  try {
    const { gig_id, role, message, mode } = req.body;
    // Store dep offer using offers table; sender=recipient=self until network exists
    await db.query(
      `INSERT INTO offers (sender_id, recipient_id, gig_id, offer_type, status, fee)
       VALUES ($1, $1, $2, 'dep', 'pending', (SELECT fee FROM gigs WHERE id=$2 AND user_id=$1))`,
      [req.user.id, gig_id]
    );
    res.json({ success: true });
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
    ]);

    const overdueInvoice = overdueResult.rows[0] || null;
    const draftInvoice = draftResult.rows[0] || null;

    res.json({
      next_gig: nextGigResult.rows[0] || null,
      // Field names matching frontend expectations
      month_earnings: parseFloat(thisMonthResult.rows[0]?.earnings || 0),
      month_gigs: parseInt(thisMonthResult.rows[0]?.count || 0),
      year_earnings: parseFloat(taxYearResult.rows[0]?.earnings || 0),
      year_gigs: parseInt(taxYearResult.rows[0]?.count || 0),
      overdue_invoices: overdueInvoice ? 1 : 0,
      overdue_total: overdueInvoice ? parseFloat(overdueInvoice.amount || 0) : 0,
      draft_invoices: draftInvoice ? 1 : 0,
      draft_total: draftInvoice ? parseFloat(draftInvoice.amount || 0) : 0,
      unread_notifications: parseInt(unreadResult.rows[0]?.count || 0),
      unread_messages: parseInt(unreadResult.rows[0]?.count || 0),
      offer_count: parseInt(offersResult.rows[0]?.count || 0),
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

    // Calculate tax year
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();
    let taxYearStart;
    if (currentMonth > 4 || (currentMonth === 4 && currentDay >= 6)) {
      taxYearStart = `${now.getFullYear()}-04-06`;
    } else {
      taxYearStart = `${now.getFullYear() - 1}-04-06`;
    }

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
       ORDER BY year DESC, month DESC`,
      [userId]
    );

    // Expenses total this tax year
    const expensesResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM receipts
       WHERE user_id = $1 AND date >= $2`,
      [userId, taxYearStart]
    );

    // Mileage total this tax year
    const mileageResult = await db.query(
      `SELECT COALESCE(SUM(mileage_miles), 0) as total FROM gigs
       WHERE user_id = $1 AND date >= $2`,
      [userId, taxYearStart]
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

    res.json({
      monthly_breakdown: monthlyResult.rows.map(row => ({
        month: row.month,
        year: row.year,
        confirmed_total: parseFloat(row.confirmed_total),
        enquiry_total: parseFloat(row.enquiry_total),
        gig_count: parseInt(row.gig_count),
      })),
      expenses_total: parseFloat(expensesResult.rows[0]?.total || 0),
      mileage_total: parseFloat(mileageResult.rows[0]?.total || 0),
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

router.post('/contacts', async (req, res) => {
  try {
    const { name, email, phone, instruments, notes } = req.body;
    const result = await db.query(
      `INSERT INTO contacts (owner_id, name, email, phone, instruments, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, name, email, phone, instruments || null, notes || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create contact error:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

router.patch('/contacts/:id', async (req, res) => {
  try {
    const { name, email, phone, instruments, notes } = req.body;
    const result = await db.query(
      `UPDATE contacts SET
         name = COALESCE($1, name),
         email = COALESCE($2, email),
         phone = COALESCE($3, phone),
         instruments = COALESCE($4, instruments),
         notes = COALESCE($5, notes)
       WHERE id = $6 AND owner_id = $7 RETURNING *`,
      [name, email, phone, instruments, notes, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
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

router.post('/songs', async (req, res) => {
  try {
    const { title, artist, key, tempo, duration, genre, tags, lyrics, chords } = req.body;
    const result = await db.query(
      `INSERT INTO songs (user_id, title, artist, key, tempo, duration, genre, tags, lyrics, chords)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        req.user.id,
        title,
        artist || null,
        key || null,
        tempo || null,
        duration || null,
        genre || null,
        tags || null,
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
    const result = await db.query(
      `UPDATE songs SET
         title = COALESCE($1, title),
         artist = COALESCE($2, artist),
         key = COALESCE($3, key),
         tempo = COALESCE($4, tempo),
         duration = COALESCE($5, duration),
         genre = COALESCE($6, genre),
         tags = COALESCE($7, tags),
         lyrics = COALESCE($8, lyrics),
         chords = COALESCE($9, chords)
       WHERE id = $10 AND user_id = $11 RETURNING *`,
      [title, artist, key, tempo, duration, genre, tags, lyrics, chords, req.params.id, req.user.id]
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

    res.json(notifications);
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
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
    const { status, sent_at, paid_at } = req.body;
    const result = await db.query(
      `UPDATE invoices SET
         status = COALESCE($1, status),
         sent_at = COALESCE($2, sent_at),
         paid_at = COALESCE($3, paid_at)
       WHERE id = $4 AND user_id = $5 RETURNING *`,
      [status, sent_at, paid_at, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

module.exports = router;
