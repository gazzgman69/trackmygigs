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
    } = req.body;

    const result = await db.query(
      `INSERT INTO gigs (user_id, band_name, venue_name, venue_address, date, start_time, end_time, load_in_time, fee, status, source, dress_code, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create gig error:', error);
    res.status(500).json({ error: 'Failed to create gig' });
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
    const { gig_id, band_name, amount, status, invoice_number, payment_terms, due_date } =
      req.body;

    const result = await db.query(
      `INSERT INTO invoices (user_id, gig_id, band_name, amount, status, invoice_number, payment_terms, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    const { name, phone, instruments, home_postcode, avatar_url } = req.body;

    const result = await db.query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), instruments = COALESCE($3, instruments),
       home_postcode = COALESCE($4, home_postcode), avatar_url = COALESCE($5, avatar_url)
       WHERE id = $6 RETURNING *`,
      [name, phone, instruments, home_postcode, avatar_url, req.user.id]
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

module.exports = router;
