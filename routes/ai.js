// ── AI FEATURES (Claude Haiku 4.5) ───────────────────────────────────────────
// Ten authenticated endpoints, one Haiku call each. All auth-gated via
// authMiddleware, all return 503 when AI is disabled so the frontend can
// gracefully hide the buttons.
//
// Rollout note (2026-04-18): every feature is enabled for all logged-in
// users. Premium gating arrives as a flag on req.user later; for now the
// standing call is "all on for everyone, we'll flip individual features to
// premium by toggling a feature flag after Gareth finishes testing."

const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { callHaiku, isEnabled } = require('../lib/ai');

const router = express.Router();
router.use(authMiddleware);

// Every endpoint funnels through this. Keeps the "AI is disabled" branch and
// the "Haiku returned null" branch in one place.
function aiGuard(res) {
  if (!isEnabled()) {
    res.status(503).json({ error: 'AI features unavailable. Anthropic client not configured.' });
    return false;
  }
  return true;
}

function sendAIResult(res, data, fallbackStatus = 502) {
  if (data == null) {
    return res.status(fallbackStatus).json({ error: 'AI call failed. Try again in a moment.' });
  }
  res.json(data);
}

// ── HMRC expense categories (mirrors the canonical list used by Expenses) ───
const HMRC_CATEGORIES = [
  'Travel',
  'Equipment',
  'Rehearsal & studio hire',
  'Session fees paid out',
  'Subsistence',
  'Mobile phone & internet',
  'Insurance',
  'Accountancy & legal',
  'Stationery & postage',
  'Marketing & promotion',
  'Subscriptions',
  'Training & development',
  'Other',
];

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Smart Paste to Gig Wizard
// POST /api/ai/extract-gig  { text }
// Returns: { date, start_time, finish_time, venue_name, venue_address,
//            fee, contact_name, contact_phone, band_name, notes,
//            set_length_minutes, confidence, reasoning }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/extract-gig', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const text = String(req.body?.text || '').slice(0, 6000);
    if (!text.trim()) {
      return res.status(400).json({ error: 'Paste some booking text first.' });
    }
    const system = `You extract musician gig booking details from unstructured text (emails, WhatsApp, contracts, notes).

Return ONLY a single JSON object with this shape. Use null when a field is not present in the text. Do NOT invent.

{
  "date": "YYYY-MM-DD" | null,
  "start_time": "HH:MM" | null,
  "finish_time": "HH:MM" | null,
  "venue_name": string | null,
  "venue_address": string | null,
  "fee": number | null,
  "contact_name": string | null,
  "contact_phone": string | null,
  "contact_email": string | null,
  "band_name": string | null,
  "notes": string | null,
  "set_length_minutes": integer | null,
  "confidence": 0-100 integer,
  "reasoning": short string explaining what signals you saw
}

Date rules: today is ${new Date().toISOString().substring(0, 10)}. Interpret "Saturday" or "next Friday" relative to today. If only a date is given without a year, assume the nearest future occurrence.

Return ONLY the JSON. No prose, no markdown.`;
    const data = await callHaiku({ system, user: text, json: true, maxTokens: 800 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/extract-gig] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Receipt OCR + HMRC categoriser
// POST /api/ai/extract-receipt  { image?: base64, mediaType?: string, text?: string }
// Returns: { merchant, amount, currency, vat, date, category, notes, confidence }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/extract-receipt', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const imageB64 = req.body?.image;
    const mediaType = req.body?.mediaType || 'image/jpeg';
    const textInput = req.body?.text;

    if (!imageB64 && !textInput) {
      return res.status(400).json({ error: 'Provide a receipt image or pasted text.' });
    }

    const system = `You extract expense receipt data for a UK-based self-employed musician doing HMRC self-assessment.

Return ONLY a single JSON object with this shape. Use null when unknown.

{
  "merchant": string | null,
  "amount": number (total including VAT, in the receipt's currency),
  "currency": "GBP" | "EUR" | "USD" | other ISO code,
  "vat": number | null,
  "date": "YYYY-MM-DD" | null,
  "category": one of ${JSON.stringify(HMRC_CATEGORIES)},
  "notes": short string describing what was bought,
  "confidence": 0-100 integer
}

Category guidance:
- Petrol, train, taxi, flights, parking, tolls, congestion charge: "Travel"
- Guitar strings, cables, mics, stands, cases, instruments: "Equipment"
- Rehearsal rooms, studio sessions, recording time: "Rehearsal & studio hire"
- Meals on the road, hotel breakfast while gigging: "Subsistence"
- Zoom, Gmail, Canva, Dropbox, web hosting, software: "Subscriptions"
- Stamps, envelopes, printing costs: "Stationery & postage"
- Anything unclear: "Other"

If amounts are ambiguous, prefer the final total. If VAT is not separately itemised, return null for vat (not 0).

Return ONLY the JSON. No prose, no markdown.`;

    const userContent = imageB64
      ? [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
          { type: 'text', text: 'Extract the receipt fields as JSON.' },
        ]
      : String(textInput).slice(0, 4000);

    const data = await callHaiku({ system, user: userContent, json: true, maxTokens: 600 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/extract-receipt] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — Set List Generator
// POST /api/ai/generate-setlist  { durationMinutes, venueType, crowd?, mood? }
// Returns: { setlist: [{ position, song_id, title, artist, key, tempo, duration, reason }], notes }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/generate-setlist', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const durationMinutes = parseInt(req.body?.durationMinutes, 10) || 90;
    const venueType = String(req.body?.venueType || 'pub').slice(0, 50);
    const crowd = String(req.body?.crowd || '').slice(0, 200);
    const mood = String(req.body?.mood || '').slice(0, 200);

    const songs = await db.query(
      `SELECT id, title, artist, key, tempo, duration, tags
       FROM songs WHERE user_id = $1 ORDER BY title ASC`,
      [req.user.id]
    );

    if (songs.rows.length === 0) {
      return res.status(400).json({ error: 'Add songs to your Repertoire first.' });
    }

    const songList = songs.rows
      .map(s => `  {"id": ${s.id}, "title": ${JSON.stringify(s.title)}, "artist": ${JSON.stringify(s.artist || '')}, "key": ${JSON.stringify(s.key || '')}, "tempo": ${s.tempo || 'null'}, "duration_seconds": ${s.duration || 'null'}}`)
      .join(',\n');

    const system = `You build a musician's live set from their existing repertoire.

Return ONLY a JSON object:

{
  "setlist": [
    { "position": 1, "song_id": <id from repertoire>, "title": string, "artist": string, "key": string, "tempo": number|null, "duration_seconds": number|null, "reason": short string }
  ],
  "notes": short string with any caveats, gaps, or suggestions (e.g. "consider adding a slower opener", "no Latin tracks in repertoire")
}

Rules:
- Target duration: ${durationMinutes} minutes. Sum of song durations should be within 10% of target; if durations are missing, assume 4 minutes each.
- Open with something energising but not the biggest song.
- Arc: build, peak mid-to-late, wind down or leave one big closer.
- Vary keys: no more than two songs in a row in the same key.
- Vary tempo: no more than three mid-tempo songs in a row.
- Match venue type (${venueType}) and crowd (${crowd || 'general'}).
- Use ONLY song_ids from the repertoire provided.
- Do not invent songs.`;

    const userPrompt = `Venue type: ${venueType}
Target duration: ${durationMinutes} minutes
Crowd notes: ${crowd || '(none)'}
Mood notes: ${mood || '(none)'}

Repertoire (JSON array of available songs, use only these):
[
${songList}
]

Build the set.`;

    const data = await callHaiku({ system, user: userPrompt, json: true, maxTokens: 2000 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/generate-setlist] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 5 — Invoice Chase Drafter
// POST /api/ai/draft-invoice-chase  { invoiceId }
// Returns: { polite, firm, final }  (three email drafts)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/draft-invoice-chase', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const invoiceId = String(req.body?.invoiceId || '').trim();
    if (!invoiceId) return res.status(400).json({ error: 'Pass an invoiceId.' });
    // Validate UUID shape so Postgres doesn't throw type errors
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId)) {
      return res.status(400).json({ error: 'invoiceId must be a UUID.' });
    }

    const r = await db.query(
      `SELECT id, invoice_number, band_name, amount, due_date, status, recipient_email, notes
       FROM invoices WHERE id = $1 AND user_id = $2`,
      [invoiceId, req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Invoice not found.' });

    const invoice = r.rows[0];
    const today = new Date();
    const due = invoice.due_date ? new Date(invoice.due_date) : null;
    const daysOverdue = due ? Math.max(0, Math.floor((today - due) / 86400000)) : 0;

    const system = `You draft three payment chase emails for an invoice that is overdue.

Return ONLY a JSON object:

{
  "polite":  { "subject": string, "body": string },  // friendly nudge
  "firm":    { "subject": string, "body": string },  // firmer, references terms
  "final":   { "subject": string, "body": string }   // final demand before escalation
}

Rules:
- Musician's voice: warm, professional, no corporate-speak. No em dashes.
- Each body: 60-120 words.
- Always include invoice number, amount, and days overdue in every draft.
- Final version references "next steps" (small-claims, collections) but does not threaten with legalese.
- Subjects under 60 characters.
- Sign off with "${req.user.name || 'Best'}".`;

    const userPrompt = `Invoice: #${invoice.invoice_number || invoice.id}
Band: ${invoice.band_name || '(not specified)'}
Bill to: ${invoice.recipient_email || '(unknown)'}
Amount: £${invoice.amount}
Due date: ${invoice.due_date || '(not set)'}
Days overdue: ${daysOverdue}
Original notes: ${invoice.notes || '(none)'}

Draft three chase versions.`;

    const data = await callHaiku({ system, user: userPrompt, json: true, maxTokens: 1200 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/draft-invoice-chase] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE — Thank-you draft for a venue / gig leader after a played gig
// POST /api/ai/draft-thank-you  { gig_id }
// Returns: { subject, body }
// Pulls the gig + venue + gig-leader fields and drafts a warm, short
// follow-up the musician can send the day after. Builds long-term
// relationships with bookers + venues.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/draft-thank-you', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const gigId = String(req.body?.gig_id || '').trim();
    if (!gigId) return res.status(400).json({ error: 'Pass a gig_id.' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gigId)) {
      return res.status(400).json({ error: 'gig_id must be a UUID.' });
    }

    const r = await db.query(
      `SELECT id, band_name, venue_name, venue_address, date, start_time, end_time,
              fee, gig_leader_name, gig_leader_email, gig_leader_phone, notes, dress_code
         FROM gigs WHERE id = $1 AND user_id = $2`,
      [gigId, req.user.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Gig not found.' });

    const gig = r.rows[0];
    const senderName = req.user.display_name || req.user.name || 'The band';
    const dateStr = gig.date
      ? new Date(gig.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
      : '(date)';
    const leaderFirstName = gig.gig_leader_name
      ? String(gig.gig_leader_name).split(/\s+/)[0]
      : '';

    const system = `You draft a single short thank-you message a gigging musician sends to a venue or gig leader after the show.

Return ONLY a JSON object:

{
  "subject": string,   // under 60 chars
  "body":    string    // 50-120 words, plain text, no markdown
}

Rules:
- Warm, professional, no corporate-speak. No em dashes. No exclamation marks beyond one in the body if it fits naturally.
- Address the recipient by first name when one is provided, otherwise open with "Hi there".
- Reference the gig date and venue specifically so it doesn't read as a generic template.
- Briefly acknowledge something positive about the gig (the crowd / the room / smooth load-in / the sound) but keep it credible, not flattering.
- Close with a soft invitation to keep in touch / book again. Don't pitch hard.
- Sign off "Cheers,\n${senderName}".`;

    const userPrompt = `Recipient: ${gig.gig_leader_name || '(unknown name)'}${leaderFirstName ? ' (first name: ' + leaderFirstName + ')' : ''}
Venue: ${gig.venue_name || '(unknown)'}
Date: ${dateStr}
Band / act: ${gig.band_name || '(unknown)'}
Recipient role: gig leader / booker / venue contact
Sender's name: ${senderName}
Gig notes (sender's own): ${gig.notes || '(none)'}

Draft the thank-you.`;

    const data = await callHaiku({ system, user: userPrompt, json: true, maxTokens: 600 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/draft-thank-you] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 6 — EPK / Bio Writer
// POST /api/ai/generate-bio  { facts, style? }
// Returns: { short50, medium150, long300 }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/generate-bio', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const facts = String(req.body?.facts || '').slice(0, 3000);
    const style = String(req.body?.style || 'warm and professional').slice(0, 80);

    const u = await db.query(
      `SELECT name, display_name, instruments, home_postcode, public_slug FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = u.rows[0] || {};
    const instruments = Array.isArray(user.instruments) ? user.instruments.join(', ') : '';

    const system = `You write musician EPK bios in three lengths. No em dashes. No cliches like "passionate" or "unique sound". Concrete details only.

Return ONLY a JSON object:

{
  "short50":    string (~50 words, ±5),
  "medium150":  string (~150 words, ±15),
  "long300":    string (~300 words, ±25)
}

Tone: ${style}. Third-person unless the facts clearly indicate otherwise. Lead with the strongest concrete credit or fact. Avoid superlatives. Mention venues, artists worked with, or measurable reach when possible.

If the musician's extra facts conflict with the stored profile (for example different instruments), the extra facts ALWAYS win; the profile may be stale. Never include a postcode in the bio. If location matters, name the town, county or region only.`;

    const userPrompt = `Musician profile:
Name: ${user.display_name || user.name || '(unknown)'}
Instruments (may be stale, facts below override): ${instruments || '(unspecified)'}
Home area (postcode for region inference ONLY, never print it): ${user.home_postcode || '(unspecified)'}
Public booking page: ${user.public_slug ? `trackmygigs.app/@${user.public_slug}` : '(none)'}

Extra facts from the musician:
${facts || '(none provided; use only the profile above)'}

Write the three bios.`;

    const data = await callHaiku({ system, user: userPrompt, json: true, maxTokens: 1400 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/generate-bio] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 7 — Calendar Sanity Check
// POST /api/ai/sanity-check  { date, start_time, finish_time, venue_address?, band_name? }
// Returns: { warnings: [{ severity, message }], ok: bool }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/sanity-check', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const { date, start_time, finish_time, venue_address, band_name } = req.body || {};
    if (!date) return res.status(400).json({ error: 'Pass at least a date.' });

    const [sameDayR, prevDayR, nextDayR, blockedR] = await Promise.all([
      db.query(
        `SELECT id, band_name, venue_name, venue_address, start_time, end_time AS finish_time
         FROM gigs WHERE user_id = $1 AND date = $2 AND status IN ('confirmed', 'enquiry')`,
        [req.user.id, date]
      ),
      db.query(
        `SELECT id, band_name, venue_name, venue_address, end_time AS finish_time
         FROM gigs WHERE user_id = $1 AND date = $2::date - INTERVAL '1 day' AND status IN ('confirmed', 'enquiry')`,
        [req.user.id, date]
      ),
      db.query(
        `SELECT id, band_name, venue_name, venue_address, start_time
         FROM gigs WHERE user_id = $1 AND date = $2::date + INTERVAL '1 day' AND status IN ('confirmed', 'enquiry')`,
        [req.user.id, date]
      ),
      db.query(
        `SELECT reason FROM blocked_dates WHERE user_id = $1 AND date = $2`,
        [req.user.id, date]
      ).catch(() => ({ rows: [] })),
    ]);

    const system = `You sanity-check a musician's new gig booking against their calendar.

Return ONLY a JSON object:

{
  "ok": boolean (false if any warnings at "high" severity, true otherwise),
  "warnings": [
    { "severity": "low"|"medium"|"high", "message": short string }
  ]
}

Check:
- Same-day clash (another gig already on this date): "high"
- Blocked date on this date: "high"
- Back-to-back gigs with impossible drive times based on addresses (UK: >80mph unrealistic; use rough UK geography): "medium" or "high"
- Late finish previous day + early start this day (<8 hours rest): "medium"

Be specific and short. No em dashes. No prose outside the JSON.`;

    const userPrompt = `Proposed gig:
Date: ${date}
Times: ${start_time || '?'} to ${finish_time || '?'}
Band: ${band_name || '(not specified)'}
Venue address: ${venue_address || '(not specified)'}

Same-day existing gigs: ${JSON.stringify(sameDayR.rows)}
Previous-day gigs: ${JSON.stringify(prevDayR.rows)}
Next-day gigs: ${JSON.stringify(nextDayR.rows)}
Blocked date reason (if any): ${blockedR.rows[0]?.reason || '(not blocked)'}

Return the sanity check.`;

    const data = await callHaiku({ system, user: userPrompt, json: true, maxTokens: 800 });
    sendAIResult(res, data || { ok: true, warnings: [] });
  } catch (err) {
    console.error(`[ai/sanity-check] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 8 — ChordPro Normaliser
// POST /api/ai/normalize-chordpro  { text }
// Returns: { cleaned, key, tempo, time_signature, notes }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/normalize-chordpro', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const text = String(req.body?.text || '').slice(0, 15000);
    if (!text.trim()) return res.status(400).json({ error: 'Paste ChordPro text first.' });

    const system = `You normalise ChordPro chord-sheets. Input is messy pasted text (from websites, PDFs, Word). Output is clean ChordPro.

Return ONLY a JSON object:

{
  "cleaned":  string (the cleaned ChordPro),
  "key":      string | null (detected or given, e.g. "G" or "Am"),
  "tempo":    integer | null (BPM if present or inferable from style notes),
  "time_signature": string | null (e.g. "4/4", "6/8"),
  "notes":    short string describing what you changed
}

Rules:
- Normalise chord notation: [G], [Am], [D7], [F#m7]. Replace alternative notations (e.g. "G maj7" -> "[Gmaj7]").
- Preserve section labels using ChordPro directives: {start_of_verse}, {end_of_verse}, {start_of_chorus}, {end_of_chorus}, {start_of_bridge}, {end_of_bridge}.
- If the input has chord-over-lyric two-line format, convert to inline [Chord]lyric form.
- Add {title:}, {artist:}, {key:}, {tempo:} directives at the top if known.
- Preserve original lyric line breaks. Do not add verses that aren't there.
- NEVER drop a chord. First count the chord tokens in the input; your output must contain exactly the same number of chord tokens in the same order. When chord-over-lyric alignment is ambiguous, place the chord at your best estimate within the line rather than omitting it; mention uncertain placements in "notes".
- If unsure, note it in "notes" rather than guessing.`;

    // Chord sheets punish dropped chords, and the small model fumbles
    // chord-over-lyric alignment when two lines share a pattern. Sonnet
    // handles it; this endpoint is low-volume so the cost difference is
    // pennies.
    const data = await callHaiku({ system, user: text, json: true, maxTokens: 4000, model: 'claude-sonnet-4-6' });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/normalize-chordpro] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ── POST /api/ai/transcribe ─────────────────────────────────────────────────
// Premium voice-memo path. Free users get browser-native Web Speech API
// transcription on the client; premium users with OPENAI_API_KEY set on
// the server can route through OpenAI Whisper for better accuracy in
// noisy venue environments. Audio arrives base64-encoded in the JSON body
// to avoid wiring in multer just for one endpoint. Capped at 25MB (~3 min
// of webm/opus) which covers any realistic in-the-moment voice note.
router.post('/transcribe', async (req, res) => {
  try {
    if (req.user.subscription_tier !== 'premium') {
      return res.status(402).json({
        error: 'premium_only',
        message: 'Server transcription is a Premium feature. Free users get browser-native voice notes.',
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      // Graceful degradation: feature exists but the key isn't configured.
      // Client falls back to Web Speech API so the user still gets a working
      // mic; the message is just for diagnostics in the network tab.
      return res.status(503).json({
        error: 'not_configured',
        message: 'Whisper transcription needs OPENAI_API_KEY set on the server.',
      });
    }
    const audioB64 = (req.body && req.body.audio_base64) || '';
    const mimeType = (req.body && req.body.mime_type) || 'audio/webm';
    if (!audioB64 || typeof audioB64 !== 'string') {
      return res.status(400).json({ error: 'missing_audio', message: 'audio_base64 is required' });
    }
    // Cap the payload server-side. Browser-side cap should match.
    if (audioB64.length > 25 * 1024 * 1024 / 0.75) {
      return res.status(413).json({ error: 'too_large', message: 'Audio over 25MB. Keep it under 3 minutes.' });
    }

    // Decode base64 to a Buffer, wrap as a Blob in FormData and forward to
    // Whisper. Node 18+ has fetch + FormData + Blob globally; no new dep.
    const audioBuf = Buffer.from(audioB64, 'base64');
    const ext = mimeType.includes('mp4') ? 'mp4'
              : mimeType.includes('wav') ? 'wav'
              : mimeType.includes('mp3') ? 'mp3'
              : mimeType.includes('mpeg') ? 'mp3'
              : 'webm';
    const form = new FormData();
    form.append('file', new Blob([audioBuf], { type: mimeType }), `memo.${ext}`);
    form.append('model', 'whisper-1');
    // Bias the model toward UK gigging vocabulary so it doesn't hear "set
    // list" as "satellite" or "DI box" as "DI bots."
    form.append('prompt', 'Gig notes for a working musician: venue, load-in, sound check, set list, DI box, PA, monitors, mileage, parking, dress code.');

    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!whisperResp.ok) {
      const errText = await whisperResp.text().catch(() => '');
      console.error('[ai/transcribe] whisper error', whisperResp.status, errText.slice(0, 300));
      return res.status(502).json({ error: 'whisper_failed', message: 'Transcription provider failed. Try again in a moment.' });
    }
    const whisperJson = await whisperResp.json();
    res.json({ text: whisperJson.text || '', engine: 'whisper-1' });
  } catch (err) {
    console.error('[ai/transcribe] error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Transcription request failed' });
  }
});

// ── Status endpoint so the frontend can feature-detect ──────────────────────
router.get('/status', (req, res) => {
  res.json({
    enabled: isEnabled(),
    features: [
      'extract-gig',
      'extract-receipt',
      'generate-setlist',
      'draft-invoice-chase',
      'generate-bio',
      'sanity-check',
      'normalize-chordpro',
      'transcribe',
    ],
    transcribe_premium_available: !!process.env.OPENAI_API_KEY,
  });
});

module.exports = router;
