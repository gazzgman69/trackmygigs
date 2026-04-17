const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// ── Get all threads for current user ─────────────────────────────────────────

router.get('/threads', async (req, res) => {
  try {
    // S12-07: Fold participant enrichment into the thread query so we issue
    // a single round-trip instead of 1 + N. We aggregate matching users as a
    // JSON array per thread via a LATERAL subquery.
    const result = await db.query(
      `SELECT t.*,
        (SELECT content FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
        (SELECT sender_id FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_sender_id,
        (SELECT COUNT(*) FROM messages WHERE thread_id = t.id AND NOT ($1 = ANY(read_by))) AS unread_count,
        g.band_name, g.venue_name, g.date AS gig_date,
        COALESCE(p.participants, '[]'::jsonb) AS participants
       FROM threads t
       LEFT JOIN gigs g ON t.gig_id = g.id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id', u.id,
           'name', u.name,
           'email', u.email,
           'avatar_url', u.avatar_url
         )) AS participants
         FROM users u
         WHERE u.id = ANY(t.participant_ids)
       ) p ON TRUE
       WHERE $1 = ANY(t.participant_ids)
       ORDER BY (SELECT MAX(created_at) FROM messages WHERE thread_id = t.id) DESC NULLS LAST`,
      [req.user.id]
    );

    res.json({ threads: result.rows });
  } catch (error) {
    console.error('Get threads error:', error);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ── Get messages for a thread ────────────────────────────────────────────────

router.get('/threads/:threadId/messages', async (req, res) => {
  try {
    // Verify user is a participant
    const threadCheck = await db.query(
      'SELECT * FROM threads WHERE id = $1 AND $2 = ANY(participant_ids)',
      [req.params.threadId, req.user.id]
    );
    if (threadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const result = await db.query(
      `SELECT m.*, u.name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.thread_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.threadId]
    );

    // Mark messages as read
    await db.query(
      `UPDATE messages SET read_by = array_append(read_by, $1)
       WHERE thread_id = $2 AND NOT ($1 = ANY(read_by))`,
      [req.user.id, req.params.threadId]
    );

    res.json({
      thread: threadCheck.rows[0],
      messages: result.rows,
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── Send a message ───────────────────────────────────────────────────────────

// S12-10: Hard cap on message size. 40 kB is comfortable for anything the user
// types by hand but blocks runaway bodies that would bloat the messages table
// and drag out thread fetches.
const MESSAGE_MAX_BYTES = 40 * 1024;

router.post('/threads/:threadId/messages', async (req, res) => {
  try {
    const { content, attachments } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }
    if (Buffer.byteLength(content, 'utf8') > MESSAGE_MAX_BYTES) {
      return res.status(413).json({ error: 'Message is too long. Please keep it under 40,000 characters.' });
    }

    // Verify user is a participant
    const threadCheck = await db.query(
      'SELECT * FROM threads WHERE id = $1 AND $2 = ANY(participant_ids)',
      [req.params.threadId, req.user.id]
    );
    if (threadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const result = await db.query(
      `INSERT INTO messages (thread_id, sender_id, content, attachments, read_by)
       VALUES ($1, $2, $3, $4, ARRAY[$2])
       RETURNING *`,
      [req.params.threadId, req.user.id, content.trim(), attachments || null]
    );

    // Get sender info for the response
    const msg = result.rows[0];
    const senderResult = await db.query(
      'SELECT name, avatar_url FROM users WHERE id = $1',
      [req.user.id]
    );
    msg.sender_name = senderResult.rows[0]?.name;
    msg.sender_avatar = senderResult.rows[0]?.avatar_url;

    res.json({ message: msg });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── Create a new thread (for a gig or 1-to-1) ──────────────────────────────

router.post('/threads', async (req, res) => {
  try {
    const { gig_id, thread_type, participant_ids } = req.body;

    // Ensure current user is included
    const allParticipants = [...new Set([req.user.id, ...(participant_ids || [])])];

    // Check if a thread already exists for this gig + type combo
    if (gig_id) {
      const existing = await db.query(
        `SELECT * FROM threads WHERE gig_id = $1 AND thread_type = $2
         AND participant_ids @> $3::uuid[]`,
        [gig_id, thread_type || 'gig', allParticipants]
      );
      if (existing.rows.length > 0) {
        return res.json({ thread: existing.rows[0], existing: true });
      }
    }

    const result = await db.query(
      `INSERT INTO threads (gig_id, thread_type, participant_ids)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [gig_id || null, thread_type || 'gig', allParticipants]
    );

    res.json({ thread: result.rows[0], existing: false });
  } catch (error) {
    console.error('Create thread error:', error);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// ── Get or create a thread for a specific gig ───────────────────────────────

router.get('/gig/:gigId', async (req, res) => {
  try {
    // Look for existing gig thread
    let thread = await db.query(
      `SELECT * FROM threads WHERE gig_id = $1 AND thread_type = 'gig' AND $2 = ANY(participant_ids)`,
      [req.params.gigId, req.user.id]
    );

    if (thread.rows.length === 0) {
      // Resolve all relevant participants for this gig:
      //   - gig creator (typically the band leader)
      //   - anyone on an accepted / pending offer for this gig (deps who were invited)
      //   - the current user
      const gigRow = await db.query('SELECT user_id FROM gigs WHERE id = $1', [req.params.gigId]);
      if (gigRow.rows.length === 0) {
        return res.status(404).json({ error: 'Gig not found' });
      }
      const creatorId = gigRow.rows[0].user_id;
      const offerRows = await db.query(
        `SELECT DISTINCT sender_id, recipient_id FROM offers
         WHERE gig_id = $1 AND status IN ('accepted','pending')`,
        [req.params.gigId]
      );
      const participantSet = new Set();
      participantSet.add(req.user.id);
      if (creatorId) participantSet.add(creatorId);
      for (const r of offerRows.rows) {
        if (r.sender_id) participantSet.add(r.sender_id);
        if (r.recipient_id) participantSet.add(r.recipient_id);
      }
      const participantIds = Array.from(participantSet);

      // Auto-create a thread for this gig with all resolved participants
      thread = await db.query(
        `INSERT INTO threads (gig_id, thread_type, participant_ids)
         VALUES ($1, 'gig', $2::uuid[])
         RETURNING *`,
        [req.params.gigId, participantIds]
      );
    } else {
      // Ensure the current user is listed; some legacy threads were created with
      // only the original creator.
      const existing = thread.rows[0];
      if (!existing.participant_ids.includes(req.user.id)) {
        const updated = await db.query(
          `UPDATE threads SET participant_ids = array_append(participant_ids, $1)
           WHERE id = $2 RETURNING *`,
          [req.user.id, existing.id]
        );
        thread = updated;
      }
    }

    const threadData = thread.rows[0];

    // Get messages
    const messages = await db.query(
      `SELECT m.*, u.name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.thread_id = $1
       ORDER BY m.created_at ASC`,
      [threadData.id]
    );

    // Mark as read
    await db.query(
      `UPDATE messages SET read_by = array_append(read_by, $1)
       WHERE thread_id = $2 AND NOT ($1 = ANY(read_by))`,
      [req.user.id, threadData.id]
    );

    // Get participants
    const participants = await db.query(
      'SELECT id, name, email, avatar_url FROM users WHERE id = ANY($1)',
      [threadData.participant_ids]
    );

    res.json({
      thread: threadData,
      messages: messages.rows,
      participants: participants.rows,
    });
  } catch (error) {
    console.error('Get gig thread error:', error);
    res.status(500).json({ error: 'Failed to fetch gig thread' });
  }
});

module.exports = router;
