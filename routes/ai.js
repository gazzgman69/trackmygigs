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
// FEATURE 3 — Dep Offer Reply Drafter
// POST /api/ai/draft-dep-reply  { offerText, gigDate?, userName? }
// Returns: { accept, decline, ask_fee }  (three short plain-text drafts)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/draft-dep-reply', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const offerText = String(req.body?.offerText || '').slice(0, 2000);
    const gigDate = req.body?.gigDate || null;
    const userName = req.user.name || 'the musician';

    if (!offerText.trim()) {
      return res.status(400).json({ error: 'Pass the offer text.' });
    }

    // Pull the user's calendar for the target date so the AI can check for
    // clashes without assuming anything.
    let sameDayGigs = [];
    if (gigDate) {
      try {
        const r = await db.query(
          `SELECT band_name, venue_name, start_time FROM gigs
           WHERE user_id = $1 AND date = $2 AND status IN ('confirmed', 'enquiry')`,
          [req.user.id, gigDate]
        );
        sameDayGigs = r.rows;
      } catch (_) { /* non-fatal */ }
    }
    const alreadyBooked = sameDayGigs.length > 0;

    const system = `You draft three reply options to a dep (sub) gig offer that a working musician has just received.

Write in the first person, warm but direct, suited for WhatsApp or email. Short (1-3 sentences each). No em dashes.

Return ONLY a JSON object:

{
  "accept": string,        // accepting the offer, confirming the date
  "decline": string,       // polite decline; mention alternative if appropriate
  "ask_fee": string        // polite ask about fee before committing
}

Context:
- Musician name: ${userName}
- ${alreadyBooked ? `ALREADY BOOKED this date at: ${sameDayGigs.map(g => g.band_name || g.venue_name).join(', ')}. Decline should mention this gently.` : 'Date appears free on the calendar.'}

No prose outside the JSON. No markdown fences.`;

    const data = await callHaiku({ system, user: offerText, json: true, maxTokens: 500 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/draft-dep-reply] error:`, err);
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

Tone: ${style}. Third-person unless the facts clearly indicate otherwise. Lead with the strongest concrete credit or fact. Avoid superlatives. Mention venues, artists worked with, or measurable reach when possible.`;

    const userPrompt = `Musician profile:
Name: ${user.display_name || user.name || '(unknown)'}
Instruments: ${instruments || '(unspecified)'}
Home area: ${user.home_postcode || '(unspecified)'}
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
// FEATURE 7 — Monthly Insight Narrative
// POST /api/ai/month-summary  { year, month }
// Returns: { headline, summary, highlights: [...], suggestions: [...] }
// ═════════════════════════════════════════════════════════════════════════════
router.post('/month-summary', async (req, res) => {
  if (!aiGuard(res)) return;
  try {
    const year = parseInt(req.body?.year, 10) || new Date().getFullYear();
    const month = parseInt(req.body?.month, 10) || (new Date().getMonth() + 1);
    const startISO = `${year}-${String(month).padStart(2, '0')}-01`;
    const endISO = new Date(year, month, 0).toISOString().substring(0, 10);

    const [gigsR, invR, expR] = await Promise.all([
      db.query(
        `SELECT date, band_name, venue_name, fee, status FROM gigs
         WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date ASC`,
        [req.user.id, startISO, endISO]
      ),
      db.query(
        `SELECT invoice_number, amount, status, due_date FROM invoices
         WHERE user_id = $1 AND created_at::date BETWEEN $2 AND $3 ORDER BY created_at ASC`,
        [req.user.id, startISO, endISO]
      ),
      db.query(
        `SELECT category, amount, description, date FROM expenses
         WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date ASC`,
        [req.user.id, startISO, endISO]
      ).catch(() => ({ rows: [] })),
    ]);

    const gigs = gigsR.rows;
    const invoices = invR.rows;
    const expenses = expR.rows;

    const totalFees = gigs.reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    const system = `You write a short friendly insight narrative for a musician's monthly finance view. No em dashes. No corporate-speak.

Return ONLY a JSON object:

{
  "headline":  short string (6-10 words),
  "summary":   2-3 short sentences describing the month,
  "highlights": [2-4 short bullet-point strings],
  "suggestions": [1-3 short, specific, actionable suggestions]
}

Use the numbers provided. Don't invent. If the month is quiet, say so plainly.`;

    const userPrompt = `Month: ${year}-${String(month).padStart(2, '0')}
Gigs played/booked: ${gigs.length} (total fees £${totalFees.toFixed(2)})
Invoices issued: ${invoices.length}
Expenses logged: ${expenses.length} (total £${totalExpenses.toFixed(2)})

Gig detail:
${gigs.map(g => `- ${g.date} | ${g.band_name || ''} @ ${g.venue_name || ''} | £${g.fee || 0} | ${g.status}`).join('\n') || '(no gigs)'}

Write the monthly insight.`;

    const data = await callHaiku({ system, user: userPrompt, json: true, maxTokens: 900 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/month-summary] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 8 — Calendar Sanity Check
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
// FEATURE 9 — ChordPro Normaliser
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
- If unsure, note it in "notes" rather than guessing.`;

    const data = await callHaiku({ system, user: text, json: true, maxTokens: 4000 });
    sendAIResult(res, data);
  } catch (err) {
    console.error(`[ai/normalize-chordpro] error:`, err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'AI request failed' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 10 — Booking Enquiry Triage — RETIRED
// ═════════════════════════════════════════════════════════════════════════════
// POST /api/ai/triage-enquiry was deleted along with its frontend modal and
// nav-quick-btn. TMG has no inbox or contact-form intake, so a paste-an-
// enquiry endpoint asks the user to copy from Gmail and POST into the app
// just to get a draft reply. That is strictly worse UX than asking ChatGPT
// directly, so the feature stays retired until a proper enquiry intake
// (public booking form or inbound email) is built.

// ── Status endpoint so the frontend can feature-detect ──────────────────────
router.get('/status', (req, res) => {
  res.json({
    enabled: isEnabled(),
    features: [
      'extract-gig',
      'extract-receipt',
      'draft-dep-reply',
      'generate-setlist',
      'draft-invoice-chase',
      'generate-bio',
      'month-summary',
      'sanity-check',
      'normalize-chordpro',
    ],
  });
});

module.exports = router;
