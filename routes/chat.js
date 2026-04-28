const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// 2026-04-29 contextual-send batch: take a client-supplied attachment hint
// (e.g. {kind:'gig', gig_id}) and turn it into a fully-snapshotted server
// object the receiver can render without trusting client data. Returns null
// if the user doesn't own the referenced object (or it doesn't exist) so
// the message endpoint can refuse the send. More kinds (setlist, contact)
// will follow the same pattern — keep the dispatch flat for readability.
async function buildAttachmentSnapshot(attachment, actorId) {
  if (!attachment || typeof attachment !== 'object') return null;
  if (attachment.kind === 'gig') {
    const gigId = attachment.gig_id;
    if (!gigId) return null;
    // Sender must own the gig to share it. Read-side permission for the
    // receiver is handled by the snapshot itself — they only see what was
    // captured at send time, not the live gig row.
    const r = await db.query(
      `SELECT id, band_name, venue_name, venue_address, venue_postcode,
              date, start_time, end_time, fee, dress_code, load_in_notes,
              status, gig_type, client_name, rate_per_hour
         FROM gigs
        WHERE id = $1 AND user_id = $2
        LIMIT 1`,
      [gigId, actorId]
    );
    if (r.rows.length === 0) return null;
    const g = r.rows[0];
    return {
      kind: 'gig',
      gig_id: g.id,
      sent_at: new Date().toISOString(),
      snapshot: {
        band_name: g.band_name || null,
        venue_name: g.venue_name || null,
        venue_address: g.venue_address || null,
        venue_postcode: g.venue_postcode || null,
        date: g.date || null,
        start_time: g.start_time || null,
        end_time: g.end_time || null,
        fee: g.fee != null ? Number(g.fee) : null,
        dress_code: g.dress_code || null,
        load_in_notes: g.load_in_notes || null,
        status: g.status || null,
        gig_type: g.gig_type || null,
        client_name: g.client_name || null,
        rate_per_hour: g.rate_per_hour != null ? Number(g.rate_per_hour) : null
      }
    };
  }
  if (attachment.kind === 'contact') {
    const contactId = attachment.contact_id;
    if (!contactId) return null;
    // Sender must own the contact row. We only expose name + instruments +
    // linked_user_id in the snapshot — phone and email are intentionally
    // withheld even if the sender has them, so contact-sharing doesn't
    // bypass the contact owner's privacy. The receiver can always look up
    // the linked_user_id in the directory if they want richer info.
    const r = await db.query(
      `SELECT c.id, c.name, c.instruments, c.linked_user_id,
              u.photo_url, u.allow_direct_messages, u.discoverable
         FROM contacts c
         LEFT JOIN users u ON u.id = c.linked_user_id
        WHERE c.id = $1 AND c.owner_id = $2
        LIMIT 1`,
      [contactId, actorId]
    );
    if (r.rows.length === 0) return null;
    const c = r.rows[0];
    return {
      kind: 'contact',
      contact_id: c.id,
      sent_at: new Date().toISOString(),
      snapshot: {
        name: c.name || null,
        instruments: Array.isArray(c.instruments) ? c.instruments.slice(0, 6) : [],
        linked_user_id: c.linked_user_id || null,
        photo_url: c.photo_url || null,
        is_tmg_user: !!c.linked_user_id,
        accepts_dms: c.allow_direct_messages !== false,
        discoverable: c.discoverable === true
      }
    };
  }
  // Unknown kind — refuse rather than store untrusted shape.
  return null;
}

// ── Get all threads for current user ─────────────────────────────────────────

router.get('/threads', async (req, res) => {
  try {
    // S12-07: Fold participant enrichment into the thread query so we issue
    // a single round-trip instead of 1 + N. We aggregate matching users as a
    // JSON array per thread via a LATERAL subquery.
    const result = await db.query(
      `SELECT t.*,
        (SELECT content FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT attachments FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS last_attachments,
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
    // 2026-04-29 chat-info batch: pull thread + joined participants in one
    // shot so the chat info sheet has photos/names without an extra round
    // trip. Membership check is now folded into the same query — earlier
    // shape returned the raw thread row with only participant_ids, which
    // left the info sheet showing "No members loaded".
    const threadRes = await db.query(
      `SELECT t.*,
         COALESCE(p.participants, '[]'::jsonb) AS participants
         FROM threads t
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
        WHERE t.id = $1 AND $2 = ANY(t.participant_ids)`,
      [req.params.threadId, req.user.id]
    );
    if (threadRes.rows.length === 0) {
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
      thread: threadRes.rows[0],
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
    const { content, attachment } = req.body;
    const trimmedContent = (content || '').trim();
    // 2026-04-29 contextual-send batch: messages can carry an attachment
    // payload (kind:'gig' for now, more kinds to follow). Either content OR
    // an attachment is required — not both. We snapshot the referenced
    // object server-side so the receiver always sees what was sent even if
    // the sender later edits or deletes it.
    //
    // 2026-04-29 multi-tenant audit: do NOT accept a raw `attachments` field
    // from the client. Older code merged req.body.attachments straight into
    // the JSONB column, which would let any thread participant inject a
    // hand-crafted snapshot (fake fee, fake band_name, fake gig_id) that the
    // receiver renders verbatim. Forcing every send through
    // buildAttachmentSnapshot guarantees ownership validation and a trusted
    // shape. New attachment kinds register here, not via raw body.
    let stagedAttachment = null;
    if (attachment && typeof attachment === 'object' && attachment.kind) {
      stagedAttachment = await buildAttachmentSnapshot(attachment, req.user.id);
      if (!stagedAttachment) {
        return res.status(400).json({ error: 'Could not attach that item.' });
      }
    }
    if (!trimmedContent && !stagedAttachment) {
      return res.status(400).json({ error: 'Message content is required' });
    }
    if (trimmedContent && Buffer.byteLength(trimmedContent, 'utf8') > MESSAGE_MAX_BYTES) {
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

    // Wrap the validated snapshot (if any) into the JSONB column. Single
    // attachment is stored as a one-element array so the column shape stays
    // uniform regardless of how many we attach in the future.
    const finalAttachments = stagedAttachment ? [stagedAttachment] : null;

    // S12-14: cast read_by seed array explicitly. Without the ::uuid[] cast
    // Postgres plans ARRAY[$2] as text[] and the insert into the uuid[] column
    // fails with "column read_by is of type uuid[] but expression is of type
    // text[]". Repros as a 500 on every send.
    // 2026-04-29 — pg can't auto-bind a JS array of objects to a JSONB
    // column (it tries to coerce to a Postgres ARRAY and the insert fails
    // with "could not determine data type"). Stringify so the driver
    // treats it as text and Postgres parses it as JSONB. Cast to ::jsonb
    // explicitly because $4 starts as text otherwise.
    const result = await db.query(
      `INSERT INTO messages (thread_id, sender_id, content, attachments, read_by)
       VALUES ($1, $2, $3, $4::jsonb, ARRAY[$2]::uuid[])
       RETURNING *`,
      [
        req.params.threadId,
        req.user.id,
        trimmedContent || '',
        finalAttachments ? JSON.stringify(finalAttachments) : null
      ]
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
    // Log the real error shape so attachment-shape regressions don't hide
    // behind the generic "Failed to send message" toast next time.
    console.error('Send message error:', error.code || '', error.message || error);
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
      // Non-gig thread (1-to-1 or group DM): each invitee must either
      //   (a) already be in the caller's contacts as a linked TMG user, OR
      //   (b) have allow_direct_messages = TRUE (directory open-DM toggle).
      // The actor must also have allow_direct_messages = TRUE to send a
      // cold DM, otherwise users could DM strangers without exposing a
      // reverse channel. Same gate applies on both sides.
      for (const pid of others) {
        const contactCheck = await db.query(
          `SELECT 1 FROM contacts WHERE owner_id = $1 AND contact_user_id = $2 LIMIT 1`,
          [req.user.id, pid]
        );
        if (contactCheck.rows.length > 0) continue;
        // Not a contact -> fall back to the open-DM toggle. Both ends must
        // have it on. We also verify the target is a real, non-blocked user
        // so a guessed UUID can't slip through.
        const dmCheck = await db.query(
          `SELECT
             (SELECT allow_direct_messages FROM users WHERE id = $1) AS actor_open,
             (SELECT allow_direct_messages FROM users WHERE id = $2) AS target_open,
             EXISTS (SELECT 1 FROM users WHERE id = $2) AS target_exists,
             EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2) AS actor_blocks_target,
             EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $2 AND blocked_id = $1) AS target_blocks_actor`,
          [req.user.id, pid]
        );
        const r = dmCheck.rows[0] || {};
        if (!r.target_exists) {
          return res.status(404).json({ error: 'User not found' });
        }
        if (r.actor_blocks_target || r.target_blocks_actor) {
          return res.status(403).json({ error: 'Cannot message this user' });
        }
        if (r.actor_open !== true || r.target_open !== true) {
          return res.status(403).json({ error: 'This user is not accepting direct messages' });
        }
      }

      // For 1-to-1 DMs, return any existing thread between the same two
      // people so we don't pile up empty threads when the user clicks
      // Message twice. Group DMs (>2 participants) always create a fresh
      // thread because the set semantics get fiddly fast.
      if (allParticipants.length === 2) {
        const existing = await db.query(
          `SELECT * FROM threads
           WHERE gig_id IS NULL
             AND participant_ids @> $1::uuid[]
             AND participant_ids <@ $1::uuid[]
           ORDER BY created_at DESC
           LIMIT 1`,
          [allParticipants]
        );
        if (existing.rows.length > 0) {
          return res.json({ thread: existing.rows[0], existing: true });
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

// ── Rename a thread ─────────────────────────────────────────────────────────
//
// Any participant can rename. Pass { name: "..." } to set; pass null or empty
// string to clear (UI falls back to derived name). Cap at 80 chars so the
// header stays readable. Returns the updated thread row so the client can
// re-render without a refetch.
router.patch('/threads/:threadId', async (req, res) => {
  try {
    const { name } = req.body || {};
    const threadCheck = await db.query(
      'SELECT id FROM threads WHERE id = $1 AND $2 = ANY(participant_ids)',
      [req.params.threadId, req.user.id]
    );
    if (threadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    let trimmed = null;
    if (name !== undefined && name !== null) {
      trimmed = String(name).trim().slice(0, 80);
      if (!trimmed) trimmed = null;
    }
    const result = await db.query(
      'UPDATE threads SET name = $1 WHERE id = $2 RETURNING *',
      [trimmed, req.params.threadId]
    );
    res.json({ thread: result.rows[0] });
  } catch (error) {
    console.error('Rename thread error:', error);
    res.status(500).json({ error: 'Failed to rename thread' });
  }
});

// ── Delete one of your own messages ─────────────────────────────────────────
//
// Soft-delete pattern would be nicer (preserve "Message deleted" placeholder
// the way iMessage does) but we don't have a deleted_at column on messages
// yet. Hard delete + UI tombstone via the next render is fine for v1; users
// only ever see a thread-list refresh, never a phantom row. Caller must own
// the message — no admin-style deletes via this endpoint.
router.delete('/threads/:threadId/messages/:messageId', async (req, res) => {
  try {
    const { threadId, messageId } = req.params;
    // Confirm caller is in the thread first so we don't leak existence of
    // foreign messageIds via a different error code.
    const threadCheck = await db.query(
      'SELECT 1 FROM threads WHERE id = $1 AND $2 = ANY(participant_ids)',
      [threadId, req.user.id]
    );
    if (threadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    const result = await db.query(
      `DELETE FROM messages
       WHERE id = $1 AND thread_id = $2 AND sender_id = $3
       RETURNING id`,
      [messageId, threadId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ── Leave / delete a thread ─────────────────────────────────────────────────
//
// Semantics:
//   - 1-to-1 / group with messages: caller is removed from participant_ids
//     (they "leave" the thread) so the other side keeps history. If they were
//     the last participant, the thread + messages are wiped.
//   - 1-to-1 with zero messages: hard-delete (it's basically a stale draft).
// Either way, caller no longer sees the thread in their inbox after the call.
router.delete('/threads/:threadId', async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const tRow = await client.query(
      'SELECT * FROM threads WHERE id = $1 FOR UPDATE',
      [req.params.threadId]
    );
    if (tRow.rows.length === 0 || !tRow.rows[0].participant_ids.includes(req.user.id)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Thread not found' });
    }
    const remaining = tRow.rows[0].participant_ids.filter(id => id !== req.user.id);
    const msgCount = await client.query(
      'SELECT COUNT(*)::int AS n FROM messages WHERE thread_id = $1',
      [req.params.threadId]
    );
    const hasMessages = (msgCount.rows[0]?.n || 0) > 0;
    if (remaining.length === 0 || !hasMessages) {
      await client.query('DELETE FROM messages WHERE thread_id = $1', [req.params.threadId]);
      await client.query('DELETE FROM threads WHERE id = $1', [req.params.threadId]);
    } else {
      await client.query(
        'UPDATE threads SET participant_ids = $1 WHERE id = $2',
        [remaining, req.params.threadId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete thread error:', error);
    res.status(500).json({ error: 'Failed to delete thread' });
  } finally {
    client.release();
  }
});

// ── Contact picker for compose-new ──────────────────────────────────────────
//
// Returns DM-eligible candidates for the inbox "+ New" button:
//   - everyone in the caller's contacts table that's linked to a TMG user
//   - plus directory users with allow_direct_messages = TRUE (only if the
//     caller themselves has the toggle on; otherwise contacts-only)
// Includes a `q` substring filter (case-insensitive on name + email) so the
// list scales as the user types. Caps at 50 results to keep payloads small.
router.get('/contacts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const like = q ? `%${q}%` : '%';

    const me = await db.query(
      'SELECT allow_direct_messages FROM users WHERE id = $1',
      [req.user.id]
    );
    const actorOpen = !!(me.rows[0] && me.rows[0].allow_direct_messages);

    const params = [req.user.id, like];
    let directoryClause = '';
    if (actorOpen) {
      directoryClause = `
        UNION
        SELECT u.id, u.name, u.email, u.avatar_url, 'directory'::text AS source
          FROM users u
         WHERE u.id <> $1
           AND u.allow_direct_messages = TRUE
           AND u.discoverable = TRUE
           AND (LOWER(u.name) LIKE $2 OR LOWER(u.email) LIKE $2)
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
      `;
    }

    const sql = `
      SELECT * FROM (
        SELECT u.id, u.name, u.email, u.avatar_url, 'contact'::text AS source
          FROM contacts c
          JOIN users u ON u.id = c.contact_user_id
         WHERE c.owner_id = $1
           AND c.contact_user_id IS NOT NULL
           AND (LOWER(u.name) LIKE $2 OR LOWER(u.email) LIKE $2 OR LOWER(c.name) LIKE $2)
        ${directoryClause}
      ) s
      ORDER BY (source = 'contact') DESC, name ASC
      LIMIT 50
    `;
    const rows = await db.query(sql, params);
    res.json({ candidates: rows.rows });
  } catch (error) {
    console.error('Chat contacts error:', error);
    res.status(500).json({ error: 'Failed to load contacts' });
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
