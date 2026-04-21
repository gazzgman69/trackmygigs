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

    // S12-14: cast read_by seed array explicitly. Without the ::uuid[] cast
    // Postgres plans ARRAY[$2] as text[] and the insert into the uuid[] column
    // fails with "column read_by is of type uuid[] but expression is of type
    // text[]". Repros as a 500 on every send.
    const result = await db.query(
      `INSERT INTO messages (thread_id, sender_id, content, attachments, read_by)
       VALUES ($1, $2, $3, $4, ARRAY[$2]::uuid[])
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

    // Normalize participants: always include caller, dedupe, strip self from
    // "others" so the validation below is about the people being invited.
    const incoming = Array.isArray(participant_ids) ? participant_ids : [];
    const others = [...new Set(incoming.filter(id => id && id !== req.user.id))];
    const allParticipants = [req.user.id, ...others];

    if (gig_id) {
      // Gig-scoped thread: caller must own the gig or be on a live offer,
      // and every other participant must have the same association. This
      // blocks using a valid gig UUID to pull arbitrary users into a chat.
      const gigRow = await db.query('SELECT user_id FROM gigs WHERE id = $1', [gig_id]);
      if (gigRow.rows.length === 0) {
        return res.status(404).json({ error: 'Gig not found' });
      }
      const creatorId = gigRow.rows[0].user_id;
      const offerRows = await db.query(
        `SELECT DISTINCT sender_id, recipient_id FROM offers
         WHERE gig_id = $1 AND status <> 'cancelled'`,
        [gig_id]
      );
      const allowedParties = new Set();
      if (creatorId) allowedParties.add(creatorId);
      for (const r of offerRows.rows) {
        if (r.sender_id) allowedParties.add(r.sender_id);
        if (r.recipient_id) allowedParties.add(r.recipient_id);
      }
      if (!allowedParties.has(req.user.id)) {
        return res.status(404).json({ error: 'Gig not found' });
      }
      for (const pid of others) {
        if (!allowedParties.has(pid)) {
          return res.status(403).json({ error: 'Participant is not associated with this gig' });
        }
      }

      // Return an existing matching thread if one already covers this set.
      const existing = await db.query(
        `SELECT * FROM threads WHERE gig_id = $1 AND thread_type = $2
         AND participant_ids @> $3::uuid[]`,
        [gig_id, thread_type || 'gig', allParticipants]
      );
      if (existing.rows.length > 0) {
        return res.json({ thread: existing.rows[0], existing: true });
      }
    } else {
      // Non-gig thread (1-to-1 or group DM): each invitee must already be in
      // the caller's contacts as a linked TMG user. Prevents starting private
      // chats with strangers by guessing UUIDs.
      for (const pid of others) {
        const contactCheck = await db.query(
          `SELECT 1 FROM contacts WHERE owner_id = $1 AND contact_user_id = $2 LIMIT 1`,
          [req.user.id, pid]
        );
        if (contactCheck.rows.length === 0) {
          return res.status(403).json({ error: 'Participant is not in your contacts' });
        }
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
    // Look for an existing gig thread where the caller is already a participant
    let thread = await db.query(
      `SELECT * FROM threads WHERE gig_id = $1 AND thread_type = 'gig' AND $2 = ANY(participant_ids)`,
      [req.params.gigId, req.user.id]
    );

    if (thread.rows.length === 0) {
      // Authorization check: before we create or join a gig thread, the caller
      // must either own the gig or be party to a non-cancelled offer on it.
      // Without this guard any logged-in user could probe gig UUIDs and be
      // silently added to the thread, exposing participants and messages.
      const gigRow = await db.query('SELECT user_id FROM gigs WHERE id = $1', [req.params.gigId]);
      if (gigRow.rows.length === 0) {
        return res.status(404).json({ error: 'Gig not found' });
      }
      const creatorId = gigRow.rows[0].user_id;
      const offerRows = await db.query(
        `SELECT DISTINCT sender_id, recipient_id, status FROM offers
         WHERE gig_id = $1 AND status <> 'cancelled'`,
        [req.params.gigId]
      );
      const isCreator = creatorId === req.user.id;
      const isOfferParty = offerRows.rows.some(r =>
        r.sender_id === req.user.id || r.recipient_id === req.user.id
      );
      if (!isCreator && !isOfferParty) {
        return res.status(404).json({ error: 'Gig not found' });
      }

      // Caller is authorized. If a thread already exists for this gig, add
      // them to the participants list. Otherwise create a new thread seeded
      // with the creator, any live offer parties, and the caller.
      const existingThread = await db.query(
        `SELECT * FROM threads WHERE gig_id = $1 AND thread_type = 'gig' LIMIT 1`,
        [req.params.gigId]
      );

      if (existingThread.rows.length > 0) {
        thread = await db.query(
          `UPDATE threads SET participant_ids = array_append(participant_ids, $1)
           WHERE id = $2 RETURNING *`,
          [req.user.id, existingThread.rows[0].id]
        );
      } else {
        const participantSet = new Set();
        participantSet.add(req.user.id);
        if (creatorId) participantSet.add(creatorId);
        for (const r of offerRows.rows) {
          if (r.status === 'accepted' || r.status === 'pending') {
            if (r.sender_id) participantSet.add(r.sender_id);
            if (r.recipient_id) participantSet.add(r.recipient_id);
          }
        }
        const participantIds = Array.from(participantSet);

        thread = await db.query(
          `INSERT INTO threads (gig_id, thread_type, participant_ids)
           VALUES ($1, 'gig', $2::uuid[])
           RETURNING *`,
          [req.params.gigId, participantIds]
        );
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
