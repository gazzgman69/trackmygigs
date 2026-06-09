#!/usr/bin/env node
// Full-coverage functional test campaign for TrackMyGigs.
//
//   node sim/campaign.js --base <URL> --secret <RELOAD_SECRET> --users 150 --concurrency 12
//
// Mints ~150 synthetic musicians (sim+*@trackmygigs.app so the existing
// wipe endpoint clears them), drives every feature surface with real
// assertions, and writes sim/results/<timestamp>-campaign/ containing:
//   findings.json   every assertion failure / surprise, sorted bug > improvement > note
//   report.md       counts, pass/fail per module, findings table, latency table
//   events.jsonl    raw per-request event log (same shape as the simulator)
//
// Hard rules:
//   - NEVER calls /api/ai/* (AI is deliberately untested; guard enforced in code)
//   - NEVER touches non-synthetic accounts (all activity is between minted sim users)
//   - assertion failures are non-fatal; the report is the product; exit code is 0

const path = require('path');
const fs = require('fs');
const { SimClient, sleep, makeJsonlWriter } = require('./client');
const { pickPostcode, fullPostcode, pickVenuePostcode } = require('./lib/postcodes');
const { pickInstruments, pickGenres } = require('./lib/instruments');
const { pickName } = require('./lib/names');

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    base: 'https://trackmygigs.replit.app',
    secret: process.env.RELOAD_SECRET || 'LEROADSECRET!',
    users: 150,
    concurrency: 12,
    seed: undefined,
    outDir: undefined,
    maxMinutes: 38,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--base') { out.base = next; i++; }
    else if (a === '--secret' || a === '--admin-key') { out.secret = next; i++; }
    else if (a === '--users') { out.users = parseInt(next, 10); i++; }
    else if (a === '--concurrency') { out.concurrency = parseInt(next, 10); i++; }
    else if (a === '--seed') { out.seed = parseInt(next, 10); i++; }
    else if (a === '--out-dir') { out.outDir = next; i++; }
    else if (a === '--max-minutes') { out.maxMinutes = parseFloat(next); i++; }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Small utilities (seeded RNG, semaphore, dates, money)
// ───────────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Semaphore {
  constructor(max) { this.max = max; this.cur = 0; this.q = []; }
  acquire() {
    return new Promise((resolve) => {
      const tryNow = () => {
        if (this.cur < this.max) {
          this.cur++;
          resolve(() => { this.cur--; if (this.q.length) this.q.shift()(); });
        } else this.q.push(tryNow);
      };
      tryNow();
    });
  }
}

async function runLimited(sem, fns) {
  const tasks = fns.map(async (fn) => {
    const release = await sem.acquire();
    try { return await fn(); } finally { release(); }
  });
  return Promise.allSettled(tasks);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function isoFromUtc(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function todayIso() { return isoFromUtc(new Date()); }

function isoPlusDays(n) {
  return isoFromUtc(new Date(Date.now() + n * 86400000));
}

// UK tax year (6 April to 5 April), mirroring the server's logic.
function taxYearRange() {
  const now = new Date();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  const startYear = (m > 4 || (m === 4 && d >= 6)) ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return { start: `${startYear}-04-06`, end: `${startYear + 1}-04-05` };
}

// Random date between two ISO dates, with day-of-month clamped to 5..25 so
// timezone-shifted DATE serialisation can never flip a gig across a month or
// tax-year boundary and poison the reconciliation maths.
function randDateBetween(rand, fromIso, toIso) {
  const from = Date.parse(fromIso + 'T12:00:00Z');
  const to = Date.parse(toIso + 'T12:00:00Z');
  const t = from + Math.floor(rand() * Math.max(1, to - from));
  const d = new Date(t);
  let day = d.getUTCDate();
  if (day < 5) day = 5 + Math.floor(rand() * 5);
  if (day > 25) day = 15 + Math.floor(rand() * 10);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(day)}`;
}

function moneyEq(a, b) { return Math.abs(Number(a) - Number(b)) < 0.011; }

function dateStr(v) { return v == null ? '' : String(v).slice(0, 10); }

function snippet(v, max) {
  try { return JSON.stringify(v).slice(0, max || 400); } catch (_) { return String(v).slice(0, max || 400); }
}

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URL = 'data:image/png;base64,' + TINY_PNG_B64;

const EXPENSE_CATEGORIES = [
  'Travel & vehicle', 'Equipment & instruments', 'Accommodation', 'Subsistence',
  'Mobile phone & internet', 'Insurance', 'Subscriptions', 'Rehearsal & studio hire', 'Other',
];

const GIG_TYPES = ['Function', 'Wedding', 'Pub gig', 'Festival', 'Corporate', 'Theatre'];
const BAND_NAMES = [
  'The Midnight Foxes', 'Soul Provider', 'Velvet Underground Tribute', 'The Brass Section',
  'Funk Injection', 'Northern Soul Collective', 'The Wedding Crashers', 'Smooth Operators',
  'Electric Avenue', 'The Deps', 'Groove Theory', 'Brasshouse', 'The Late Shift',
];
const VENUE_NAMES = [
  'The Red Lion', 'Grand Hotel Ballroom', 'The Jazz Cellar', 'Riverside Marquee',
  'The Old Crown', 'Civic Hall', 'The Boathouse', 'Vault 21', 'The Corn Exchange',
  'Masonic Hall', 'The White Hart', 'Pier Pavilion',
];

// ───────────────────────────────────────────────────────────────────────────
// Campaign state
// ───────────────────────────────────────────────────────────────────────────

const findings = [];          // global, deduped by title
const moduleStats = {};       // module -> { pass, fail, notes }
const memEvents = [];         // in-memory copy of every HTTP event (for latency)
let eventsLog = null;         // jsonl writer
let RUN_START = 0;
let DEADLINE = 0;

function statsFor(module) {
  return moduleStats[module] || (moduleStats[module] = { pass: 0, fail: 0, notes: 0 });
}

function addFinding(f) {
  const sev = f.severity || 'note';
  const existing = findings.find((x) => x.title === f.title);
  if (existing) { existing.occurrences++; return; }
  findings.push({
    severity: sev,
    area: f.area || 'general',
    title: f.title,
    detail: f.detail || '',
    repro: f.repro || null,
    occurrences: 1,
  });
}

// Assert helper. Returns the condition so callers can branch. A failed check
// records a finding (default severity 'bug') and increments the module's
// fail counter, but never throws.
function check(module, cond, f) {
  const m = statsFor(module);
  if (cond) { m.pass++; return true; }
  m.fail++;
  addFinding({ severity: 'bug', area: module, ...f });
  return false;
}

function note(module, f) {
  statsFor(module).notes++;
  addFinding({ severity: 'note', area: module, ...f });
}

function repro(method, p, payload, r) {
  return {
    method,
    endpoint: p,
    payload: payload === undefined ? null : payload,
    status: r ? r.status : null,
    body_snippet: r ? snippet(r.body != null ? r.body : (r.errorEvent && r.errorEvent.body_sample)) : null,
  };
}

function timeLeft() { return DEADLINE - Date.now(); }
function expired() { return Date.now() > DEADLINE; }

// SimClient subclass that hard-refuses AI routes so no flow can ever drift
// into /api/ai/* by accident.
class CampaignClient extends SimClient {
  async request(method, urlPath, opts) {
    if (String(urlPath).startsWith('/api/ai')) {
      throw new Error(`AI endpoint blocked by campaign policy: ${urlPath}`);
    }
    return super.request(method, urlPath, opts);
  }
}

// Raw fetch for non-JSON bodies (CSV, PDF, zip, HTML, ICS, public pages).
// SimClient truncates OK bodies to 200 chars, which is useless for parsing a
// CSV export, so this helper does its own fetch (with the user's session
// cookie when given) and records a compatible event into the same log.
async function rawGet(baseUrl, urlPath, user) {
  if (String(urlPath).startsWith('/api/ai')) throw new Error('AI endpoint blocked');
  const started = Date.now();
  let status = 0, contentType = '', text = '', bytes = 0, err = null;
  try {
    const headers = {};
    if (user && user.sessionToken) headers.cookie = `sessionToken=${user.sessionToken}`;
    const res = await fetch(baseUrl + urlPath, { headers, signal: AbortSignal.timeout(30000) });
    status = res.status;
    contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    bytes = buf.length;
    if (/text|json|csv|html|calendar|xml/.test(contentType) || contentType === '') {
      text = buf.toString('utf8');
    }
  } catch (e) {
    err = e.message || String(e);
  }
  const elapsed = Date.now() - started;
  const event = {
    ts: Date.now(),
    user_id: user ? user.userId : null,
    sim_index: user ? user.idx : -1,
    persona: user ? user.persona : 'public',
    method: 'GET',
    path: urlPath,
    status,
    ok: status >= 200 && status < 300,
    elapsed_ms: elapsed,
    attempt: 0,
    err_kind: err ? 'network' : null,
    err_message: err,
    body_sample: text.slice(0, 200),
  };
  if (eventsLog) eventsLog(event);
  memEvents.push(event);
  return { status, contentType, text, bytes, ok: event.ok, error: err };
}

// ───────────────────────────────────────────────────────────────────────────
// Fleet setup
// ───────────────────────────────────────────────────────────────────────────

const PERSONAS = [
  { kind: 'active_gigger', weight: 40 },
  { kind: 'hobbyist', weight: 35 },
  { kind: 'dep_specialist', weight: 15 },
  { kind: 'band_leader', weight: 5 },
  { kind: 'lurker', weight: 5 },
];
const PERSONA_WEIGHT = PERSONAS.reduce((s, p) => s + p.weight, 0);

function pickPersona(rand) {
  const r = rand() * PERSONA_WEIGHT;
  let acc = 0;
  for (const p of PERSONAS) { acc += p.weight; if (r <= acc) return p.kind; }
  return 'hobbyist';
}

function quotasFor(persona, rand) {
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  switch (persona) {
    case 'active_gigger': return { gigs: between(4, 7), invoices: between(2, 3), expenses: between(2, 3) };
    case 'hobbyist': return { gigs: between(1, 3), invoices: 1, expenses: 1 };
    case 'dep_specialist': return { gigs: between(0, 1), invoices: 1, expenses: 2 };
    case 'band_leader': return { gigs: between(3, 5), invoices: 2, expenses: 1 };
    default: return { gigs: 0, invoices: 0, expenses: 0 }; // lurker
  }
}

function makeFleetSpec(count, rand, runTag) {
  const fleet = [];
  for (let i = 0; i < count; i++) {
    const { display_name, name } = pickName(rand);
    const home = pickPostcode(rand);
    const persona = pickPersona(rand);
    fleet.push({
      idx: i,
      email: `sim+c${runTag}n${i}@trackmygigs.app`,
      name,
      display_name,
      persona,
      home,
      home_postcode: fullPostcode(home.outward, rand),
      travel_radius_miles: 15 + Math.floor(rand() * 85),
      instruments: pickInstruments(rand),
      genres: pickGenres(rand),
      hasEpk: i % 5 < 2, // ~40%
      quotas: quotasFor(persona, rand),
      // filled in later:
      userId: null, sessionToken: null, client: null, slug: null, premium: false,
      gigs: [], invoices: [], receipts: [], songs: [], setlists: [], contacts: [],
    });
  }
  return fleet;
}

async function mintUser(u, ctx) {
  const MODULE = 'fleet';
  const createUrl = `${ctx.baseUrl}/api/admin/sim-create-user?key=${encodeURIComponent(ctx.secret)}`;
  const body = {
    email: u.email,
    name: u.name,
    display_name: u.display_name,
    home_postcode: u.home_postcode,
    home_lat: u.home.lat,
    home_lng: u.home.lng,
    travel_radius_miles: u.travel_radius_miles,
    instruments: u.instruments,
    genres: u.genres,
    discoverable: true,
    allow_direct_messages: true,
  };
  let json = null, status = 0;
  try {
    const r = await fetch(createUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    status = r.status;
    json = await r.json().catch(() => null);
  } catch (e) {
    json = { error: e.message };
  }
  if (!json || !json.user_id || !json.session_token) {
    check(MODULE, false, {
      area: 'fleet',
      title: 'sim-create-user failed to mint a user',
      detail: `status=${status} body=${snippet(json)}`,
      repro: { method: 'POST', endpoint: '/api/admin/sim-create-user', payload: { email: u.email }, status, body_snippet: snippet(json) },
    });
    return false;
  }
  u.userId = json.user_id;
  u.sessionToken = json.session_token;
  u.client = new CampaignClient({
    baseUrl: ctx.baseUrl,
    userId: u.userId,
    simIndex: u.idx,
    persona: u.persona,
    sessionToken: u.sessionToken,
    recordEvent: (ev) => { eventsLog(ev); memEvents.push(ev); },
    errorLogger: () => {},
  });
  statsFor(MODULE).pass++;

  // Profile: every user gets avatar (photo_url AND avatar_url), bio,
  // discoverable + open DMs. instruments goes up as a comma-joined string
  // because PATCH /api/user/profile calls .split(',') on it.
  const avatar = `https://i.pravatar.cc/300?u=sim${u.idx}`;
  const profilePayload = {
    bio: `${u.instruments[0]} player on the ${u.home.region} circuit. ${u.genres.join(', ')}.`,
    photo_url: avatar,
    avatar_url: avatar,
    discoverable: true,
    allow_direct_messages: true,
    instruments: u.instruments.join(','),
    genres: u.genres,
    travel_radius_miles: u.travel_radius_miles,
  };
  const pr = await u.client.patch('/api/user/profile', { body: profilePayload });
  check(MODULE, pr.ok, {
    area: 'profile',
    title: 'PATCH /api/user/profile rejected a standard fleet profile',
    detail: `status=${pr.status}`,
    repro: repro('PATCH', '/api/user/profile', profilePayload, pr),
  });

  // ~40% get the full EPK treatment plus a public slug.
  if (u.hasEpk) {
    const epkPayload = {
      epk_bio: `Professional ${u.instruments.join(' / ')} available for functions, weddings and dep work across ${u.home.region}.`,
      epk_photo_url: `https://picsum.photos/seed/sim${u.idx}/800/500`,
      epk_video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      epk_audio_url: `https://example.com/audio/sim${u.idx}.mp3`,
      epk_gallery: [
        `https://picsum.photos/seed/sim${u.idx}a/600/400`,
        `https://picsum.photos/seed/sim${u.idx}b/600/400`,
        `https://picsum.photos/seed/sim${u.idx}c/600/400`,
      ],
      epk_testimonials: [
        { quote: 'Absolutely made our night. Tight, professional, great reading of the room.', author: 'Wedding client, 2026' },
        { quote: 'First-call dep. Learned the set in two days.', author: 'Band leader' },
      ],
    };
    const er = await u.client.patch('/api/user/profile', { body: epkPayload });
    check(MODULE, er.ok, {
      area: 'epk',
      title: 'PATCH /api/user/profile rejected EPK fields',
      detail: `status=${er.status}`,
      repro: repro('PATCH', '/api/user/profile', epkPayload, er),
    });
    const sr = await u.client.post('/api/user/slug', { body: {} });
    if (check(MODULE, sr.ok && sr.body && sr.body.slug, {
      area: 'epk',
      title: 'POST /api/user/slug failed to mint a public slug',
      detail: `status=${sr.status}`,
      repro: repro('POST', '/api/user/slug', {}, sr),
    })) {
      u.slug = sr.body.slug;
    }
  }
  return true;
}

async function grantPremium(u) {
  const MODULE = 'fleet';
  const r = await u.client.get('/auth/dev-set-premium?on=1');
  if (check(MODULE, r.ok && r.body && r.body.premium === true, {
    area: 'premium',
    title: 'GET /auth/dev-set-premium did not grant premium',
    detail: `status=${r.status}`,
    repro: repro('GET', '/auth/dev-set-premium?on=1', null, r),
  })) {
    u.premium = true;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Module 1: GIGS
// ───────────────────────────────────────────────────────────────────────────

async function moduleGigs(u, rand) {
  const MODULE = 'gigs';
  const ty = taxYearRange();
  const today = todayIso();
  for (let i = 0; i < u.quotas.gigs; i++) {
    const inPast = rand() < 0.4;
    const date = inPast
      ? randDateBetween(rand, ty.start, isoPlusDays(-3))
      : randDateBetween(rand, isoPlusDays(3), randMin(ty.end, isoPlusDays(220)));
    const venue = pickVenuePostcode(u.home, { radius_miles: u.travel_radius_miles, rand });
    const payload = {
      band_name: BAND_NAMES[Math.floor(rand() * BAND_NAMES.length)],
      venue_name: VENUE_NAMES[Math.floor(rand() * VENUE_NAMES.length)],
      venue_address: `${1 + Math.floor(rand() * 120)} High Street`,
      venue_postcode: fullPostcode(venue.outward, rand),
      date,
      start_time: '19:30',
      end_time: '23:00',
      fee: 80 + Math.floor(rand() * 13) * 25,
      gig_type: GIG_TYPES[Math.floor(rand() * GIG_TYPES.length)],
      notes: 'Two 45-minute sets. PA provided.',
      status: rand() < 0.8 ? 'confirmed' : 'enquiry',
    };
    const r = await u.client.post('/api/gigs', { body: payload });
    if (!check(MODULE, r.ok && r.body && r.body.id, {
      title: 'POST /api/gigs failed for a well-formed gig',
      detail: `status=${r.status}`,
      repro: repro('POST', '/api/gigs', payload, r),
    })) continue;
    const g = r.body;
    check(MODULE, g.band_name === payload.band_name && g.venue_name === payload.venue_name
      && moneyEq(g.fee, payload.fee) && dateStr(g.date) === payload.date, {
      title: 'POST /api/gigs response does not echo the created fields',
      detail: `sent band=${payload.band_name} fee=${payload.fee} date=${payload.date}; got band=${g.band_name} fee=${g.fee} date=${dateStr(g.date)}`,
      repro: repro('POST', '/api/gigs', payload, r),
    });
    u.gigs.push(g);
  }

  if (u.gigs.length > 0) {
    // Detail round-trip
    const g0 = u.gigs[0];
    const dr = await u.client.get(`/api/gigs/${g0.id}`);
    check(MODULE, dr.ok && dr.body && dr.body.id === g0.id && dr.body.band_name === g0.band_name, {
      title: 'GET /api/gigs/:id detail does not match the created gig',
      detail: `status=${dr.status} expected id=${g0.id}`,
      repro: repro('GET', `/api/gigs/${g0.id}`, null, dr),
    });

    // PATCH round-trip
    const newFee = Number(g0.fee) + 25;
    const pr = await u.client.patch(`/api/gigs/${g0.id}`, { body: { fee: newFee, notes: 'Updated: bring DI box.' } });
    if (check(MODULE, pr.ok && pr.body && moneyEq(pr.body.fee, newFee), {
      title: 'PATCH /api/gigs/:id does not echo updated fields',
      detail: `status=${pr.status} expected fee=${newFee} got=${pr.body && pr.body.fee}`,
      repro: repro('PATCH', `/api/gigs/${g0.id}`, { fee: newFee }, pr),
    })) {
      g0.fee = pr.body.fee;
      g0.notes = pr.body.notes;
    }
  }

  // DELETE one gig when there are several
  if (u.gigs.length >= 3) {
    const victim = u.gigs.pop();
    const dr = await u.client.delete(`/api/gigs/${victim.id}`);
    check(MODULE, dr.ok, {
      title: 'DELETE /api/gigs/:id failed for an owned gig',
      detail: `status=${dr.status}`,
      repro: repro('DELETE', `/api/gigs/${victim.id}`, null, dr),
    });
  }

  // Validation sanity: a gig with only notes must 400, never 500.
  if (u.idx % 10 === 0) {
    const bad = await u.client.post('/api/gigs', { body: { notes: 'just notes, nothing else' } });
    if (bad.status === 500) {
      check(MODULE, false, {
        title: 'POST /api/gigs with only {notes} returns 500 (should be 400)',
        detail: 'Regression: missing-field validation should map NOT NULL violations to 400.',
        repro: repro('POST', '/api/gigs', { notes: 'just notes, nothing else' }, bad),
      });
    } else {
      check(MODULE, bad.status === 400, {
        severity: 'improvement',
        title: `POST /api/gigs with only {notes} returned ${bad.status}, expected 400`,
        detail: 'Not a 500, but also not a clean validation reject.',
        repro: repro('POST', '/api/gigs', { notes: 'just notes, nothing else' }, bad),
      });
    }
  }
}

function randMin(a, b) { return a < b ? a : b; }

// ───────────────────────────────────────────────────────────────────────────
// Module 2: DEP OFFERS
// ───────────────────────────────────────────────────────────────────────────

async function ensureFutureGig(u, rand) {
  let gig = u.gigs.find((g) => dateStr(g.date) > todayIso() && g.status === 'confirmed');
  if (gig) return gig;
  const payload = {
    band_name: BAND_NAMES[Math.floor(rand() * BAND_NAMES.length)],
    venue_name: VENUE_NAMES[Math.floor(rand() * VENUE_NAMES.length)],
    venue_address: '10 Market Square',
    venue_postcode: u.home_postcode,
    date: randDateBetween(rand, isoPlusDays(10), isoPlusDays(90)),
    start_time: '20:00',
    end_time: '23:30',
    fee: 150 + Math.floor(rand() * 8) * 25,
    gig_type: 'Function',
    notes: 'Dep cover needed.',
    status: 'confirmed',
  };
  const r = await u.client.post('/api/gigs', { body: payload });
  if (r.ok && r.body && r.body.id) { u.gigs.push(r.body); return r.body; }
  return null;
}

async function addContactFor(owner, target) {
  const r = await owner.client.post('/api/contacts', {
    body: { name: target.display_name, email: target.email, instruments: target.instruments },
  });
  if (r.ok && r.body && r.body.id) { owner.contacts.push(r.body); return r.body; }
  return null;
}

async function scenarioDepOffers(leader, recipients, rand, opts) {
  const MODULE = 'dep-offers';
  opts = opts || {};
  const gig = await ensureFutureGig(leader, rand);
  if (!gig) {
    note(MODULE, { title: 'Dep offer scenario skipped: could not create a host gig', detail: `leader sim_index=${leader.idx}` });
    return;
  }

  const contactIds = [];
  for (const r of recipients) {
    const c = await addContactFor(leader, r);
    if (!check(MODULE, !!c, {
      title: 'POST /api/contacts failed while staging dep recipients',
      detail: `leader=${leader.idx} target=${r.idx}`,
      repro: { method: 'POST', endpoint: '/api/contacts', payload: { name: r.display_name, email: r.email }, status: null, body_snippet: null },
    })) continue;
    contactIds.push(c.id);
  }
  if (contactIds.length === 0) return;

  const offerPayload = {
    gig_id: gig.id,
    role: leader.instruments[0] || 'Dep',
    mode: 'pick',
    contact_ids: contactIds,
    message: 'Can you cover this one?',
  };
  const or = await leader.client.post('/api/dep-offers', { body: offerPayload });
  if (!check(MODULE, or.ok && or.body && or.body.success, {
    title: 'POST /api/dep-offers failed in pick mode',
    detail: `status=${or.status}`,
    repro: repro('POST', '/api/dep-offers', offerPayload, or),
  })) return;
  check(MODULE, Number(or.body.sent) === contactIds.length, {
    severity: 'improvement',
    title: 'Dep offer pick-mode sent count did not match selected contacts',
    detail: `expected sent=${contactIds.length}, got sent=${or.body.sent} unresolved=${or.body.unresolved} filtered=${or.body.filtered_out_of_range || 0}. All recipients are real sim users resolvable by email.`,
    repro: repro('POST', '/api/dep-offers', offerPayload, or),
  });

  // Each recipient finds their offer in the inbox.
  const offersByRecipient = [];
  for (const r of recipients) {
    const ir = await r.client.get('/api/offers');
    const list = Array.isArray(ir.body) ? ir.body : [];
    const mine = list.find((o) => o.gig_id === gig.id && o.sender_id === leader.userId);
    check(MODULE, !!mine, {
      title: 'Dep offer missing from recipient GET /api/offers inbox',
      detail: `gig_id=${gig.id} recipient sim_index=${r.idx} inbox size=${list.length}`,
      repro: repro('GET', '/api/offers', null, ir),
    });
    offersByRecipient.push(mine || null);
  }

  // Recipient 0 accepts. CRITICAL regression assert: the accepted gig must
  // land in their own diary with source='dep-accept'.
  const acceptor = recipients[0];
  const acceptOffer = offersByRecipient[0];
  if (acceptor && acceptOffer) {
    const ar = await acceptor.client.patch(`/api/offers/${acceptOffer.id}`, { body: { status: 'accepted' } });
    check(MODULE, ar.ok && ar.body && ar.body.status === 'accepted', {
      title: 'PATCH /api/offers/:id accept failed',
      detail: `status=${ar.status}`,
      repro: repro('PATCH', `/api/offers/${acceptOffer.id}`, { status: 'accepted' }, ar),
    });

    const gigsR = await acceptor.client.get('/api/gigs');
    const gl = Array.isArray(gigsR.body) ? gigsR.body : [];
    const stamped = gl.filter((g) => g.source === 'dep-accept' && g.origin_offer_id === acceptOffer.id);
    if (check(MODULE, stamped.length >= 1, {
      title: "Accepted dep offer did not stamp a source='dep-accept' gig into the recipient's diary (regression)",
      detail: `offer_id=${acceptOffer.id} recipient gigs=${gl.length}; none with source='dep-accept' + origin_offer_id match. This was fixed on 2026-06-09 and must not regress.`,
      repro: repro('GET', '/api/gigs', null, gigsR),
    })) {
      const sg = stamped[0];
      const sameBand = sg.band_name === gig.band_name;
      const dayDiff = Math.abs(Date.parse(dateStr(sg.date)) - Date.parse(dateStr(gig.date))) / 86400000;
      check(MODULE, sameBand && dayDiff === 0, {
        severity: dayDiff <= 1 && sameBand ? 'note' : 'bug',
        title: 'Stamped dep-accept gig band/date does not match the source gig',
        detail: `expected band=${gig.band_name} date=${dateStr(gig.date)}; got band=${sg.band_name} date=${dateStr(sg.date)} (a 1-day drift is likely DATE/timezone serialisation, not data loss)`,
        repro: repro('GET', '/api/gigs', null, gigsR),
      });
      // Track in the acceptor's local books for reconciliation realism.
      acceptor.gigs.push(sg);

      // Re-accept must not duplicate the stamped gig.
      await acceptor.client.patch(`/api/offers/${acceptOffer.id}`, { body: { status: 'accepted' } });
      const gigsR2 = await acceptor.client.get('/api/gigs');
      const gl2 = Array.isArray(gigsR2.body) ? gigsR2.body : [];
      const dupes = gl2.filter((g) => g.origin_offer_id === acceptOffer.id);
      check(MODULE, dupes.length === 1, {
        title: 'Re-accepting a dep offer duplicated the stamped diary gig',
        detail: `offer_id=${acceptOffer.id} stamped copies=${dupes.length}, expected exactly 1 (idempotency via origin_offer_id)`,
        repro: repro('PATCH', `/api/offers/${acceptOffer.id}`, { status: 'accepted' }, gigsR2),
      });
    }
  }

  // Recipient 1 declines.
  if (recipients[1] && offersByRecipient[1]) {
    const dr = await recipients[1].client.patch(`/api/offers/${offersByRecipient[1].id}`, { body: { status: 'declined' } });
    check(MODULE, dr.ok && dr.body && dr.body.status === 'declined', {
      title: 'PATCH /api/offers/:id decline failed',
      detail: `status=${dr.status}`,
      repro: repro('PATCH', `/api/offers/${offersByRecipient[1].id}`, { status: 'declined' }, dr),
    });
  }

  // Recipient 2: snooze, then the sender nudges to the 2-nudge cap.
  if (recipients[2] && offersByRecipient[2]) {
    const offerId = offersByRecipient[2].id;
    const sr = await recipients[2].client.post(`/api/offers/${offerId}/snooze`, { body: { hours: 24 } });
    check(MODULE, sr.ok && sr.body && sr.body.snoozed_until, {
      title: 'POST /api/offers/:id/snooze did not set snoozed_until',
      detail: `status=${sr.status}`,
      repro: repro('POST', `/api/offers/${offerId}/snooze`, { hours: 24 }, sr),
    });
    const n1 = await leader.client.post(`/api/offers/${offerId}/nudge`, { body: {} });
    check(MODULE, n1.ok && n1.body && n1.body.nudge_count === 1, {
      title: 'First nudge on a pending offer failed',
      detail: `status=${n1.status} body=${snippet(n1.body)}`,
      repro: repro('POST', `/api/offers/${offerId}/nudge`, {}, n1),
    });
    await leader.client.post(`/api/offers/${offerId}/nudge`, { body: {} });
    const n3 = await leader.client.post(`/api/offers/${offerId}/nudge`, { body: {} });
    check(MODULE, n3.status === 409, {
      title: 'Third nudge was not rejected with 409 (cap is 2 nudges per offer)',
      detail: `status=${n3.status}`,
      repro: repro('POST', `/api/offers/${offerId}/nudge`, {}, n3),
    });
  }

  // Sender-side counters in GET /api/offers/sent.
  const sentR = await leader.client.get('/api/offers/sent');
  const sentList = Array.isArray(sentR.body) ? sentR.body : [];
  const forGig = sentList.filter((o) => o.gig_id === gig.id);
  check(MODULE, forGig.length >= contactIds.length, {
    title: 'GET /api/offers/sent is missing offers the sender just created',
    detail: `expected >=${contactIds.length} rows for gig ${gig.id}, got ${forGig.length}`,
    repro: repro('GET', '/api/offers/sent', null, sentR),
  });
  if (recipients[1] && offersByRecipient[1]) {
    const declinedRow = forGig.find((o) => o.recipient_id === recipients[1].userId);
    check(MODULE, declinedRow && declinedRow.status === 'declined', {
      title: "Sender's GET /api/offers/sent does not reflect a decline",
      detail: `recipient=${recipients[1].userId} status=${declinedRow && declinedRow.status}`,
      repro: repro('GET', '/api/offers/sent', null, sentR),
    });
  }

  // Cancel flows: the acceptor cancels the accepted offer.
  if (acceptor && acceptOffer) {
    if (opts.withReplacement && opts.replacementUser) {
      // The replacement must be in the cancelling dep's contacts with
      // contact_user_id resolved. Resolution only happens when a dep offer
      // is sent to that contact, so stage that first: acceptor sends (then
      // withdraws) a throwaway offer to the replacement.
      const ownGig = await ensureFutureGig(acceptor, rand);
      const repContact = await addContactFor(acceptor, opts.replacementUser);
      if (ownGig && repContact) {
        await acceptor.client.post('/api/dep-offers', {
          body: { gig_id: ownGig.id, role: 'Dep', mode: 'pick', contact_ids: [repContact.id], message: 'placeholder' },
        });
        const sent2 = await acceptor.client.get('/api/offers/sent');
        const throwaway = (Array.isArray(sent2.body) ? sent2.body : [])
          .find((o) => o.gig_id === ownGig.id && o.recipient_id === opts.replacementUser.userId && o.status === 'pending');
        if (throwaway) await acceptor.client.post(`/api/offers/${throwaway.id}/withdraw`, { body: {} });

        const cr = await acceptor.client.post(`/api/offers/${acceptOffer.id}/cancel`, {
          body: { reason: 'Double booked, sorry', replacement_user_id: opts.replacementUser.userId },
        });
        if (check(MODULE, cr.ok && cr.body && cr.body.success, {
          title: 'Cancel-accepted-offer with replacement failed',
          detail: `status=${cr.status} body=${snippet(cr.body)}. Note: the contacts row was created via POST /api/contacts then resolved via a dep-offer send; if this 403s, check contact_user_id vs linked_user_id population.`,
          repro: repro('POST', `/api/offers/${acceptOffer.id}/cancel`, { reason: 'Double booked, sorry', replacement_user_id: opts.replacementUser.userId }, cr),
        })) {
          check(MODULE, !!cr.body.replacement_offer_id, {
            title: 'Cancel with replacement did not create a replacement offer',
            detail: `replacement_offer_id=${cr.body.replacement_offer_id}`,
            repro: repro('POST', `/api/offers/${acceptOffer.id}/cancel`, null, cr),
          });
        }
      }
    } else {
      const cr = await acceptor.client.post(`/api/offers/${acceptOffer.id}/cancel`, { body: { reason: 'Family thing came up' } });
      check(MODULE, cr.ok && cr.body && cr.body.success, {
        title: 'Recipient cancel of an accepted offer (no replacement) failed',
        detail: `status=${cr.status}`,
        repro: repro('POST', `/api/offers/${acceptOffer.id}/cancel`, { reason: 'Family thing came up' }, cr),
      });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Module 3: MESSAGING
// ───────────────────────────────────────────────────────────────────────────

async function ensureSetlist(u, rand) {
  if (u.setlists.length > 0 && u.songs.length >= 3) return u.setlists[0];
  const titles = ['Superstition', 'Valerie', 'Mr Brightside'];
  const ids = [];
  for (const t of titles) {
    const r = await u.client.post('/api/songs', { body: { title: t, artist: 'Various', key: 'C', duration: 240 } });
    if (r.ok && r.body && r.body.id) { u.songs.push(r.body); ids.push(r.body.id); }
  }
  if (ids.length === 0) return null;
  const sr = await u.client.post('/api/setlists', { body: { name: 'Function set A', description: 'Crowd pleasers', song_ids: ids, total_duration: 720 } });
  if (sr.ok && sr.body && sr.body.id) { u.setlists.push(sr.body); return sr.body; }
  return null;
}

function threadsList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.threads)) return body.threads;
  return [];
}

async function scenarioMessaging(a, b, c, rand) {
  const MODULE = 'messaging';

  // 1-to-1 thread
  const tr = await a.client.post('/api/chat/threads', { body: { thread_type: 'dep', participant_ids: [b.userId] } });
  if (!check(MODULE, tr.ok && tr.body && tr.body.thread && tr.body.thread.id, {
    title: 'POST /api/chat/threads failed for a 1-to-1 open-DM pair',
    detail: `status=${tr.status}`,
    repro: repro('POST', '/api/chat/threads', { thread_type: 'dep', participant_ids: [b.userId] }, tr),
  })) return;
  const threadId = tr.body.thread.id;

  // Plain message: sender_name must come back on the response.
  const m1 = await a.client.post(`/api/chat/threads/${threadId}/messages`, { body: { content: 'Hey, are you free for the 14th?' } });
  let msg1 = null;
  if (check(MODULE, m1.ok && m1.body && m1.body.message && m1.body.message.id, {
    title: 'POST message into a 1-to-1 thread failed',
    detail: `status=${m1.status}`,
    repro: repro('POST', `/api/chat/threads/${threadId}/messages`, { content: '...' }, m1),
  })) {
    msg1 = m1.body.message;
    check(MODULE, !!msg1.sender_name, {
      title: 'Message response is missing sender_name',
      detail: `message id=${msg1.id} sender_name=${msg1.sender_name}`,
      repro: repro('POST', `/api/chat/threads/${threadId}/messages`, { content: '...' }, m1),
    });
  }

  // Receiver reads (marks read), then sender re-fetches and read_by must grow.
  await b.client.get(`/api/chat/threads/${threadId}/messages`);
  const aView = await a.client.get(`/api/chat/threads/${threadId}/messages`);
  if (msg1 && aView.ok && aView.body && Array.isArray(aView.body.messages)) {
    const mine = aView.body.messages.find((m) => m.id === msg1.id);
    check(MODULE, mine && Array.isArray(mine.read_by) && mine.read_by.length >= 2, {
      title: 'read_by did not grow after the receiver opened the thread',
      detail: `read_by=${snippet(mine && mine.read_by)}; expected both participants after receiver GET`,
      repro: repro('GET', `/api/chat/threads/${threadId}/messages`, null, aView),
    });
  }

  // Attachments: gig, contact, setlist. Assert snapshot shape on each.
  const gig = await ensureFutureGig(a, rand);
  if (gig) {
    const ga = await a.client.post(`/api/chat/threads/${threadId}/messages`, { body: { attachment: { kind: 'gig', gig_id: gig.id } } });
    const att = ga.ok && ga.body && ga.body.message && Array.isArray(ga.body.message.attachments) ? ga.body.message.attachments[0] : null;
    check(MODULE, att && att.kind === 'gig' && att.snapshot && (att.snapshot.band_name || att.snapshot.venue_name || att.snapshot.date), {
      title: 'Gig attachment did not return a server-side snapshot',
      detail: `status=${ga.status} attachment=${snippet(att)}`,
      repro: repro('POST', `/api/chat/threads/${threadId}/messages`, { attachment: { kind: 'gig', gig_id: gig.id } }, ga),
    });
  }
  let contact = a.contacts[0];
  if (!contact) contact = await addContactFor(a, c || b);
  if (contact) {
    const ca = await a.client.post(`/api/chat/threads/${threadId}/messages`, { body: { attachment: { kind: 'contact', contact_id: contact.id } } });
    const att = ca.ok && ca.body && ca.body.message && Array.isArray(ca.body.message.attachments) ? ca.body.message.attachments[0] : null;
    check(MODULE, att && att.kind === 'contact' && att.snapshot, {
      title: 'Contact attachment did not return a server-side snapshot',
      detail: `status=${ca.status} attachment=${snippet(att)}`,
      repro: repro('POST', `/api/chat/threads/${threadId}/messages`, { attachment: { kind: 'contact', contact_id: contact.id } }, ca),
    });
  }
  const setlist = await ensureSetlist(a, rand);
  let setlistMsgId = null;
  if (setlist) {
    const sa = await a.client.post(`/api/chat/threads/${threadId}/messages`, { body: { attachment: { kind: 'setlist', setlist_id: setlist.id } } });
    const att = sa.ok && sa.body && sa.body.message && Array.isArray(sa.body.message.attachments) ? sa.body.message.attachments[0] : null;
    if (check(MODULE, att && att.kind === 'setlist' && att.snapshot && Array.isArray(att.snapshot.songs), {
      title: 'Setlist attachment did not return a snapshot with songs',
      detail: `status=${sa.status} attachment=${snippet(att)}`,
      repro: repro('POST', `/api/chat/threads/${threadId}/messages`, { attachment: { kind: 'setlist', setlist_id: setlist.id } }, sa),
    })) {
      setlistMsgId = sa.body.message.id;
    }
  }

  // Receiver saves the shared setlist. Saving twice must not duplicate songs.
  if (setlistMsgId) {
    const songCount = async () => {
      const r = await b.client.get('/api/songs');
      return Array.isArray(r.body) ? r.body.length : (r.body && Array.isArray(r.body.songs) ? r.body.songs.length : -1);
    };
    const s1 = await b.client.post('/api/setlists/save-shared', { body: { thread_id: threadId, message_id: setlistMsgId } });
    check(MODULE, s1.ok && s1.body && s1.body.setlist && s1.body.song_count === 3, {
      title: 'save-shared did not create the setlist + songs from the snapshot',
      detail: `status=${s1.status} song_count=${s1.body && s1.body.song_count} expected 3`,
      repro: repro('POST', '/api/setlists/save-shared', { thread_id: threadId, message_id: setlistMsgId }, s1),
    });
    const afterFirst = await songCount();
    await b.client.post('/api/setlists/save-shared', { body: { thread_id: threadId, message_id: setlistMsgId } });
    const afterSecond = await songCount();
    check(MODULE, afterFirst >= 0 && afterFirst === afterSecond, {
      title: 'Saving a shared setlist twice duplicated songs in the receiver library',
      detail: `song count after first save=${afterFirst}, after second save=${afterSecond} (must dedupe on title+artist)`,
      repro: repro('POST', '/api/setlists/save-shared', { thread_id: threadId, message_id: setlistMsgId }, s1),
    });
  }

  // Oversized message must be a 413.
  const big = await a.client.post(`/api/chat/threads/${threadId}/messages`, { body: { content: 'x'.repeat(41 * 1024) } });
  check(MODULE, big.status === 413, {
    title: `Oversized (>40KB) message returned ${big.status}, expected 413`,
    detail: 'MESSAGE_MAX_BYTES cap should reject with 413.',
    repro: repro('POST', `/api/chat/threads/${threadId}/messages`, { content: '<41KB of x>' }, big),
  });

  // Delete own message, then verify it is gone.
  if (msg1) {
    const del = await a.client.delete(`/api/chat/threads/${threadId}/messages/${msg1.id}`);
    check(MODULE, del.ok, {
      title: 'Deleting own message failed',
      detail: `status=${del.status}`,
      repro: repro('DELETE', `/api/chat/threads/${threadId}/messages/${msg1.id}`, null, del),
    });
    const after = await a.client.get(`/api/chat/threads/${threadId}/messages`);
    const still = after.ok && after.body && Array.isArray(after.body.messages)
      && after.body.messages.some((m) => m.id === msg1.id && m.content === 'Hey, are you free for the 14th?');
    check(MODULE, !still, {
      severity: 'improvement',
      title: 'Deleted message still appears verbatim in the thread',
      detail: 'Either hard-delete or redact; the original content should not survive a delete.',
      repro: repro('GET', `/api/chat/threads/${threadId}/messages`, null, after),
    });
  }

  // Rename the thread.
  const rn = await a.client.patch(`/api/chat/threads/${threadId}`, { body: { name: 'Gig logistics' } });
  check(MODULE, rn.ok && rn.body && (rn.body.name === 'Gig logistics' || (rn.body.thread && rn.body.thread.name === 'Gig logistics')), {
    title: 'PATCH thread rename did not round-trip the name',
    detail: `status=${rn.status} body=${snippet(rn.body)}`,
    repro: repro('PATCH', `/api/chat/threads/${threadId}`, { name: 'Gig logistics' }, rn),
  });

  // Group thread with a third participant + leave-thread behaviour.
  if (c) {
    const gt = await a.client.post('/api/chat/threads', { body: { thread_type: 'dep', participant_ids: [b.userId, c.userId] } });
    if (check(MODULE, gt.ok && gt.body && gt.body.thread && gt.body.thread.id, {
      title: 'Group thread creation (2+ others) failed',
      detail: `status=${gt.status}`,
      repro: repro('POST', '/api/chat/threads', { thread_type: 'dep', participant_ids: [b.userId, c.userId] }, gt),
    })) {
      const gid = gt.body.thread.id;
      const gm = await a.client.post(`/api/chat/threads/${gid}/messages`, { body: { content: 'Band call 6pm, sound check 6:30.' } });
      check(MODULE, gm.ok, {
        title: 'Sending into a group thread failed',
        detail: `status=${gm.status}`,
        repro: repro('POST', `/api/chat/threads/${gid}/messages`, { content: '...' }, gm),
      });
      await b.client.get(`/api/chat/threads/${gid}/messages`);
      await c.client.get(`/api/chat/threads/${gid}/messages`);
      const av = await a.client.get(`/api/chat/threads/${gid}/messages`);
      const gmRow = av.ok && av.body && Array.isArray(av.body.messages) && gm.body && gm.body.message
        ? av.body.messages.find((m) => m.id === gm.body.message.id) : null;
      check(MODULE, gmRow && Array.isArray(gmRow.read_by) && gmRow.read_by.length >= 3, {
        title: 'Group thread read_by did not reach all readers',
        detail: `read_by=${snippet(gmRow && gmRow.read_by)}; expected 3 of 3 after both receivers opened`,
        repro: repro('GET', `/api/chat/threads/${gid}/messages`, null, av),
      });

      // c leaves; the thread must vanish from c's inbox.
      const lv = await c.client.delete(`/api/chat/threads/${gid}`);
      check(MODULE, lv.ok, {
        title: 'Leaving a thread (DELETE /api/chat/threads/:id) failed',
        detail: `status=${lv.status}`,
        repro: repro('DELETE', `/api/chat/threads/${gid}`, null, lv),
      });
      const inbox = await c.client.get('/api/chat/threads');
      const stillThere = threadsList(inbox.body).some((t) => t.id === gid);
      check(MODULE, !stillThere, {
        title: 'Thread still visible in inbox after leaving it',
        detail: `thread_id=${gid} remains in GET /api/chat/threads for the departed user`,
        repro: repro('GET', '/api/chat/threads', null, inbox),
      });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Module 4: MARKETPLACE
// ───────────────────────────────────────────────────────────────────────────

async function postMarketplaceGig(poster, rand, overrides) {
  const venue = pickVenuePostcode(poster.home, { radius_miles: 40, rand });
  const payload = Object.assign({
    title: `Dep needed: ${poster.instruments[0] || 'Keys'} for function band`,
    description: 'Standards plus pop covers. Charts provided.',
    instruments: [poster.instruments[0] || 'Keys'],
    gig_date: randDateBetween(rand, isoPlusDays(7), isoPlusDays(60)),
    start_time: '19:00',
    end_time: '23:00',
    venue_name: VENUE_NAMES[Math.floor(rand() * VENUE_NAMES.length)],
    venue_postcode: fullPostcode(venue.outward, rand),
    fee_pence: 9000 + Math.floor(rand() * 8) * 1000,
    mode: 'pick',
  }, overrides || {});
  const r = await poster.client.post('/api/marketplace', { body: payload });
  return { r, payload };
}

async function scenarioMarketplacePick(poster, applicants, lateApplicant, rand) {
  const MODULE = 'marketplace';
  // Match the post's instrument to the applicants so browse filters line up.
  const inst = (applicants[0] && applicants[0].instruments[0]) || 'Keys';
  const { r: postR, payload } = await postMarketplaceGig(poster, rand, { instruments: [inst] });
  if (!check(MODULE, postR.ok && postR.body && postR.body.id, {
    title: 'POST /api/marketplace failed for a valid paid pick-mode post',
    detail: `status=${postR.status}`,
    repro: repro('POST', '/api/marketplace', payload, postR),
  })) return;
  const postId = postR.body.id;

  // Browse sanity (loose): the matching applicant should be able to see the
  // post with the radius cap dropped.
  const br = await applicants[0].client.get('/api/marketplace?show_outside_radius=true&limit=100');
  const browseGigs = br.ok && br.body && Array.isArray(br.body.gigs) ? br.body.gigs : null;
  if (!browseGigs) {
    check(MODULE, false, {
      title: 'GET /api/marketplace did not return a { gigs: [...] } payload',
      detail: `status=${br.status} body=${snippet(br.body)}`,
      repro: repro('GET', '/api/marketplace?show_outside_radius=true', null, br),
    });
  } else if (!browseGigs.some((g) => g.id === postId)) {
    note(MODULE, {
      title: 'Fresh marketplace post not visible in browse with radius cap dropped',
      detail: `post id=${postId} instrument=${inst}; may be instrument/fee defaults filtering, recorded loosely rather than as a hard failure`,
      repro: repro('GET', '/api/marketplace?show_outside_radius=true&limit=100', null, br),
    });
  } else {
    statsFor(MODULE).pass++;
  }
  const badge = await applicants[0].client.get('/api/marketplace/badge-count');
  check(MODULE, badge.ok, {
    title: 'GET /api/marketplace/badge-count failed',
    detail: `status=${badge.status}`,
    repro: repro('GET', '/api/marketplace/badge-count', null, badge),
  });

  // Everyone applies.
  for (const ap of applicants) {
    const ar = await ap.client.post(`/api/marketplace/${postId}/apply`, { body: { note: `Available, ${ap.instruments[0]} 10+ years.` } });
    check(MODULE, ar.ok && ar.body && ar.body.status === 'pending', {
      title: 'Pick-mode application did not land as pending',
      detail: `status=${ar.status} body=${snippet(ar.body)}`,
      repro: repro('POST', `/api/marketplace/${postId}/apply`, { note: '...' }, ar),
    });
  }

  // Poster reviews applicants: is_new_to_tmg + distance fields must be there.
  const lr = await poster.client.get(`/api/marketplace/${postId}/applicants`);
  const apps = lr.ok ? (Array.isArray(lr.body) ? lr.body : (lr.body && lr.body.applicants) || null) : null;
  if (check(MODULE, Array.isArray(apps) && apps.length >= applicants.length, {
    title: 'GET /api/marketplace/:id/applicants missing applications',
    detail: `expected >=${applicants.length}, got ${Array.isArray(apps) ? apps.length : 'non-array'} status=${lr.status}`,
    repro: repro('GET', `/api/marketplace/${postId}/applicants`, null, lr),
  })) {
    const a0 = apps[0];
    check(MODULE, typeof a0.is_new_to_tmg === 'boolean' && ('distance_miles' in a0), {
      title: 'Applicant rows missing is_new_to_tmg / distance_miles fields',
      detail: `first row keys=${snippet(Object.keys(a0))}`,
      repro: repro('GET', `/api/marketplace/${postId}/applicants`, null, lr),
    });
  }

  // Message-before-pick: the application itself must authorise a poster ->
  // applicant DM even when the applicant has DMs closed. Temporarily close
  // applicant[1]'s DMs to prove the marketplace relationship is the gate
  // that lets the thread through.
  const dmTarget = applicants[1] || applicants[0];
  await dmTarget.client.patch('/api/user/profile', { body: { allow_direct_messages: false } });
  const dmThread = await poster.client.post('/api/chat/threads', { body: { thread_type: 'dep', participant_ids: [dmTarget.userId] } });
  check(MODULE, dmThread.ok && dmThread.body && dmThread.body.thread, {
    title: 'Poster could not DM an applicant before picking (application should authorise the thread)',
    detail: `status=${dmThread.status} body=${snippet(dmThread.body)}; applicant had DMs closed so the only valid gate is the marketplace application`,
    repro: repro('POST', '/api/chat/threads', { thread_type: 'dep', participant_ids: [dmTarget.userId] }, dmThread),
  });
  if (dmThread.ok && dmThread.body && dmThread.body.thread) {
    await poster.client.post(`/api/chat/threads/${dmThread.body.thread.id}/messages`, { body: { content: 'Quick one before I confirm: own transport?' } });
  }
  await dmTarget.client.patch('/api/user/profile', { body: { allow_direct_messages: true } });

  // Pick the first applicant.
  const winner = applicants[0];
  const pick = await poster.client.post(`/api/marketplace/${postId}/pick`, { body: { applicant_user_id: winner.userId } });
  if (!check(MODULE, pick.ok && pick.body && pick.body.ok, {
    title: 'POST /api/marketplace/:id/pick failed',
    detail: `status=${pick.status}`,
    repro: repro('POST', `/api/marketplace/${postId}/pick`, { applicant_user_id: winner.userId }, pick),
  })) return;

  // Winner gig stamp.
  const wg = await winner.client.get('/api/gigs');
  const wgl = Array.isArray(wg.body) ? wg.body : [];
  const stamped = wgl.find((g) => g.source === 'marketplace-fill' && Number(g.origin_marketplace_id) === Number(postId));
  if (check(MODULE, !!stamped, {
    title: "Picked applicant did not get a source='marketplace-fill' gig in their diary (regression)",
    detail: `marketplace id=${postId}; winner gigs=${wgl.length}, none stamped. Fixed 2026-06-09, must not regress.`,
    repro: repro('GET', '/api/gigs', null, wg),
  })) {
    winner.gigs.push(stamped);
    check(MODULE, moneyEq(stamped.fee, payload.fee_pence / 100), {
      severity: 'improvement',
      title: 'Stamped marketplace-fill gig fee does not match fee_pence / 100',
      detail: `fee_pence=${payload.fee_pence}, stamped fee=${stamped.fee}`,
      repro: repro('GET', '/api/gigs', null, wg),
    });
  }

  // FILLED-gig regression: the picked applicant opens the detail and it must
  // NOT 500 (known historical bug).
  const det = await winner.client.get(`/api/marketplace/${postId}`);
  check(MODULE, det.status !== 500, {
    title: 'GET /api/marketplace/:id returns 500 to the picked applicant on a FILLED gig (known bug)',
    detail: `status=${det.status} body=${snippet(det.body)}`,
    repro: repro('GET', `/api/marketplace/${postId}`, null, det),
  });
  check(MODULE, det.ok && det.body && det.body.gig && det.body.gig.my_application && det.body.gig.my_application.status === 'accepted', {
    title: "Picked applicant's my_application is not 'accepted' on the filled gig detail",
    detail: `status=${det.status} my_application=${snippet(det.body && det.body.gig && det.body.gig.my_application)}`,
    repro: repro('GET', `/api/marketplace/${postId}`, null, det),
  });

  // Losers must show 'rejected'.
  for (const loser of applicants.slice(1)) {
    const ld = await loser.client.get(`/api/marketplace/${postId}`);
    check(MODULE, ld.ok && ld.body && ld.body.gig && ld.body.gig.my_application && ld.body.gig.my_application.status === 'rejected', {
      title: "Other applications were not flipped to 'rejected' after a pick",
      detail: `loser sim_index=${loser.idx} my_application=${snippet(ld.body && ld.body.gig && ld.body.gig.my_application)}`,
      repro: repro('GET', `/api/marketplace/${postId}`, null, ld),
    });
  }

  // Late application after fill must 409 not_open.
  if (lateApplicant) {
    const late = await lateApplicant.client.post(`/api/marketplace/${postId}/apply`, { body: { note: 'Still open?' } });
    check(MODULE, late.status === 409 && late.body && late.body.error === 'not_open', {
      title: `Applying to a filled gig returned ${late.status}, expected 409 not_open`,
      detail: `body=${snippet(late.body)}`,
      repro: repro('POST', `/api/marketplace/${postId}/apply`, { note: 'Still open?' }, late),
    });
  }
}

async function scenarioMarketplaceFcfs(poster, racers, rand) {
  const MODULE = 'marketplace-fcfs';
  const inst = (racers[0] && racers[0].instruments[0]) || 'Guitar';
  const { r: postR, payload } = await postMarketplaceGig(poster, rand, { mode: 'fcfs', instruments: [inst], fee_pence: 8000 });
  if (!check(MODULE, postR.ok && postR.body && postR.body.id, {
    title: 'POST /api/marketplace (fcfs) failed',
    detail: `status=${postR.status}`,
    repro: repro('POST', '/api/marketplace', payload, postR),
  })) return;
  const postId = postR.body.id;

  // Concurrency torture: all racers apply at the same instant.
  const results = await Promise.all(racers.map((u) =>
    u.client.post(`/api/marketplace/${postId}/apply`, { body: { note: 'Yes! Available.' } })
  ));
  const winners = [];
  const lockedOut = [];
  const odd = [];
  results.forEach((r, i) => {
    if (r.ok && r.body && r.body.status === 'accepted') winners.push(racers[i]);
    else if (r.status === 409 && r.body && r.body.error === 'not_open') lockedOut.push(racers[i]);
    else odd.push({ idx: racers[i].idx, status: r.status, body: snippet(r.body, 200) });
  });
  check(MODULE, winners.length === 1, {
    title: `FCFS race produced ${winners.length} winners (must be exactly 1)`,
    detail: `racers=${racers.length} winners=${winners.length} locked_out_409=${lockedOut.length} other=${snippet(odd)}. ${winners.length > 1 ? 'Double-booking under concurrency is a data-integrity bug.' : ''}`,
    repro: repro('POST', `/api/marketplace/${postId}/apply`, { note: 'Yes! Available.' }, results[0]),
  });
  check(MODULE, odd.length === 0, {
    severity: 'improvement',
    title: 'FCFS losers received something other than 409 not_open',
    detail: `unexpected results: ${snippet(odd)}`,
    repro: { method: 'POST', endpoint: `/api/marketplace/${postId}/apply`, payload: { note: 'Yes! Available.' }, status: null, body_snippet: snippet(odd) },
  });

  if (winners.length >= 1) {
    const w = winners[0];
    const wg = await w.client.get('/api/gigs');
    const wgl = Array.isArray(wg.body) ? wg.body : [];
    const stamped = wgl.find((g) => g.source === 'marketplace-fill' && Number(g.origin_marketplace_id) === Number(postId));
    if (check(MODULE, !!stamped, {
      title: "FCFS winner did not get a source='marketplace-fill' gig in their diary (regression)",
      detail: `marketplace id=${postId} winner sim_index=${w.idx} gigs=${wgl.length}`,
      repro: repro('GET', '/api/gigs', null, wg),
    })) {
      w.gigs.push(stamped);
    }
    // Filled-gig detail for the winner must not 500 here either.
    const det = await w.client.get(`/api/marketplace/${postId}`);
    check(MODULE, det.status !== 500, {
      title: 'GET /api/marketplace/:id 500s for the FCFS winner on a filled gig',
      detail: `status=${det.status} body=${snippet(det.body)}`,
      repro: repro('GET', `/api/marketplace/${postId}`, null, det),
    });
  }
}

async function scenarioMarketplaceMisc(poster, applicant, rand) {
  const MODULE = 'marketplace';

  // Fee floor: < 3000 pence must be rejected.
  const { r: floorR, payload: floorP } = await postMarketplaceGig(poster, rand, { fee_pence: 2500 });
  check(MODULE, floorR.status === 400 && floorR.body && floorR.body.error === 'below_paid_floor', {
    title: `Marketplace fee floor not enforced (fee_pence 2500 returned ${floorR.status})`,
    detail: `expected 400 below_paid_floor; body=${snippet(floorR.body)}`,
    repro: repro('POST', '/api/marketplace', floorP, floorR),
  });

  // Free post with a valid reason.
  const { r: freeR, payload: freeP } = await postMarketplaceGig(poster, rand, { is_free: true, free_reason: 'charity', fee_pence: 0, mode: 'fcfs' });
  check(MODULE, freeR.ok && freeR.body && freeR.body.id, {
    title: 'Free marketplace post (is_free + free_reason) rejected',
    detail: `status=${freeR.status} body=${snippet(freeR.body)}`,
    repro: repro('POST', '/api/marketplace', freeP, freeR),
  });

  // Withdraw, cancel, repost cycle on a fresh pick post.
  const { r: postR, payload } = await postMarketplaceGig(poster, rand, {});
  if (!(postR.ok && postR.body && postR.body.id)) {
    check(MODULE, false, {
      title: 'Marketplace post for withdraw/cancel/repost cycle failed',
      detail: `status=${postR.status}`,
      repro: repro('POST', '/api/marketplace', payload, postR),
    });
    return;
  }
  const postId = postR.body.id;
  await applicant.client.post(`/api/marketplace/${postId}/apply`, { body: { note: 'Interested.' } });
  const w1 = await applicant.client.post(`/api/marketplace/${postId}/withdraw`, { body: {} });
  check(MODULE, w1.ok, {
    title: 'Applicant withdraw of a pending application failed',
    detail: `status=${w1.status}`,
    repro: repro('POST', `/api/marketplace/${postId}/withdraw`, {}, w1),
  });
  const w2 = await applicant.client.post(`/api/marketplace/${postId}/withdraw`, { body: {} });
  check(MODULE, w2.status === 404, {
    severity: 'improvement',
    title: `Second withdraw returned ${w2.status}, expected 404 not_found_or_not_pending`,
    detail: 'Withdraw should be a one-shot on a pending application.',
    repro: repro('POST', `/api/marketplace/${postId}/withdraw`, {}, w2),
  });
  const cx = await poster.client.post(`/api/marketplace/${postId}/cancel`, { body: {} });
  check(MODULE, cx.ok, {
    title: 'Poster cancel of an open marketplace post failed',
    detail: `status=${cx.status}`,
    repro: repro('POST', `/api/marketplace/${postId}/cancel`, {}, cx),
  });
  const rp = await poster.client.post(`/api/marketplace/${postId}/repost`, { body: { gig_date: randDateBetween(rand, isoPlusDays(20), isoPlusDays(70)) } });
  if (check(MODULE, rp.ok && rp.body && rp.body.id, {
    title: 'POST /api/marketplace/:id/repost failed for a cancelled post',
    detail: `status=${rp.status} body=${snippet(rp.body)}`,
    repro: repro('POST', `/api/marketplace/${postId}/repost`, { gig_date: 'future' }, rp),
  })) {
    const nd = await poster.client.get(`/api/marketplace/${rp.body.id}`);
    check(MODULE, nd.ok && nd.body && nd.body.gig && nd.body.gig.status === 'open', {
      title: 'Reposted marketplace gig is not open',
      detail: `new id=${rp.body.id} status=${nd.body && nd.body.gig && nd.body.gig.status}`,
      repro: repro('GET', `/api/marketplace/${rp.body.id}`, null, nd),
    });
  }
}

async function scenarioBlock(a, b) {
  const MODULE = 'blocks';
  const br = await a.client.post('/api/user-blocks', { body: { blocked_id: b.userId } });
  if (!check(MODULE, br.ok && br.body && br.body.ok, {
    title: 'POST /api/user-blocks failed',
    detail: `status=${br.status}`,
    repro: repro('POST', '/api/user-blocks', { blocked_id: b.userId }, br),
  })) return;

  const tr = await b.client.post('/api/chat/threads', { body: { thread_type: 'dep', participant_ids: [a.userId] } });
  check(MODULE, tr.status === 403, {
    title: `Blocked user could still open a thread to the blocker (got ${tr.status}, expected 403)`,
    detail: `blocker=${a.userId} blocked=${b.userId} body=${snippet(tr.body)}`,
    repro: repro('POST', '/api/chat/threads', { thread_type: 'dep', participant_ids: [a.userId] }, tr),
  });

  const dr = await a.client.get('/api/discover?mode=nearby');
  if (dr.ok) {
    const visible = snippet(dr.body, 100000).includes(b.userId);
    check(MODULE, !visible, {
      title: 'Blocked user still appears in the blocker\'s GET /api/discover results',
      detail: `blocked user_id=${b.userId} present in mode=nearby payload`,
      repro: repro('GET', '/api/discover?mode=nearby', null, dr),
    });
  } else {
    note(MODULE, {
      title: 'GET /api/discover?mode=nearby did not return 200 during block test',
      detail: `status=${dr.status} body=${snippet(dr.body)}`,
      repro: repro('GET', '/api/discover?mode=nearby', null, dr),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Module 5: INVOICES + EXPENSES + RECONCILIATION
// ───────────────────────────────────────────────────────────────────────────

async function moduleInvoicesExpenses(u, rand) {
  const MODULE = 'invoices';
  const ty = taxYearRange();
  const confirmed = u.gigs.filter((g) => g.status === 'confirmed');

  let draftId = null;
  for (let i = 0; i < u.quotas.invoices; i++) {
    const variant = i % 3; // 0=sent simple, 1=draft, 2=sent with line items
    const dueFuture = rand() < 0.5;
    const base = {
      band_name: BAND_NAMES[Math.floor(rand() * BAND_NAMES.length)],
      due_date: dueFuture ? isoPlusDays(14) : isoPlusDays(-10),
      description: 'Live performance',
    };
    if (confirmed[i] && rand() < 0.6) base.gig_id = confirmed[i].id;

    let payload;
    if (variant === 2) {
      payload = Object.assign({}, base, {
        status: 'sent',
        line_items: [
          { description: 'Performance fee', qty: 1, rate: 200 },
          { description: 'Travel', qty: 38, rate: 0.45 },
          { description: 'Extra set', qty: 1, rate: 75 },
        ],
      });
    } else {
      payload = Object.assign({}, base, {
        status: variant === 1 ? 'draft' : 'sent',
        amount: 100 + Math.floor(rand() * 10) * 25,
      });
    }
    const r = await u.client.post('/api/invoices', { body: payload });
    if (!check(MODULE, r.ok && r.body && r.body.id, {
      title: 'POST /api/invoices failed',
      detail: `status=${r.status}`,
      repro: repro('POST', '/api/invoices', payload, r),
    })) continue;
    const inv = r.body;
    if (variant === 2) {
      const expect = payload.line_items.reduce((s, it) => s + Math.round(it.qty * it.rate * 100) / 100, 0);
      check(MODULE, moneyEq(inv.amount, expect), {
        title: 'Line-item invoice server-computed amount != sum(qty*rate)',
        detail: `expected ${expect.toFixed(2)}, got ${inv.amount}`,
        repro: repro('POST', '/api/invoices', payload, r),
      });
    }
    if (variant === 1) draftId = inv.id;
    u.invoices.push(inv);
  }

  // Mark one sent invoice paid.
  const sent = u.invoices.find((i) => i.status === 'sent');
  if (sent) {
    const pr = await u.client.patch(`/api/invoices/${sent.id}`, { body: { status: 'paid' } });
    if (check(MODULE, pr.ok && pr.body && pr.body.status === 'paid', {
      title: 'PATCH invoice to paid failed',
      detail: `status=${pr.status}`,
      repro: repro('PATCH', `/api/invoices/${sent.id}`, { status: 'paid' }, pr),
    })) {
      sent.status = 'paid';
    }
  }

  // Delete a draft.
  if (draftId && rand() < 0.5) {
    const dr = await u.client.delete(`/api/invoices/${draftId}`);
    if (check(MODULE, dr.ok, {
      title: 'DELETE draft invoice failed',
      detail: `status=${dr.status}`,
      repro: repro('DELETE', `/api/invoices/${draftId}`, null, dr),
    })) {
      u.invoices = u.invoices.filter((i) => i.id !== draftId);
    }
  }

  // PDF for the first surviving invoice.
  if (u.invoices[0] && u.idx % 4 === 0) {
    const pdf = await rawGet(u.client.baseUrl, `/api/invoices/${u.invoices[0].id}/pdf`, u);
    check(MODULE, pdf.status === 200 && /pdf/i.test(pdf.contentType), {
      title: 'GET /api/invoices/:id/pdf did not return a PDF',
      detail: `status=${pdf.status} content-type=${pdf.contentType} bytes=${pdf.bytes}`,
      repro: { method: 'GET', endpoint: `/api/invoices/${u.invoices[0].id}/pdf`, payload: null, status: pdf.status, body_snippet: pdf.contentType },
    });
  }
  // NOTE: POST /api/invoices/:id/chase is AI-backed and deliberately skipped.

  // Expenses (receipts). ~30% carry a tiny photo.
  const EXP = 'expenses';
  for (let i = 0; i < u.quotas.expenses; i++) {
    const payload = {
      amount: Math.round((5 + rand() * 80) * 100) / 100,
      description: ['Strings', 'Petrol', 'Parking', 'Reeds', 'Cables', 'Hotel'][Math.floor(rand() * 6)],
      date: randDateBetween(rand, ty.start, todayIso() < ty.end ? todayIso() : ty.end),
      category: EXPENSE_CATEGORIES[Math.floor(rand() * EXPENSE_CATEGORIES.length)],
    };
    if (rand() < 0.3) payload.photo_base64 = TINY_PNG_DATA_URL;
    const r = await u.client.post('/api/expenses', { body: payload });
    if (!check(EXP, r.ok && r.body && r.body.expense && r.body.expense.id, {
      title: 'POST /api/expenses failed',
      detail: `status=${r.status}`,
      repro: repro('POST', '/api/expenses', Object.assign({}, payload, { photo_base64: payload.photo_base64 ? '<1x1 png data url>' : undefined }), r),
    })) continue;
    const e = r.body.expense;
    check(EXP, e.description === payload.description && moneyEq(e.amount, payload.amount), {
      title: 'Expense response does not echo description/amount (vendor alias)',
      detail: `sent ${payload.description}/${payload.amount}, got ${e.description}/${e.amount}`,
      repro: repro('POST', '/api/expenses', payload, r),
    });
    if (payload.photo_base64) {
      check(EXP, e.has_photo === true, {
        title: 'Expense with photo_base64 did not persist the photo (has_photo false)',
        detail: `expense id=${e.id}`,
        repro: repro('POST', '/api/expenses', { amount: payload.amount, photo_base64: '<1x1 png>' }, r),
      });
    }
    u.receipts.push(e);
  }
  if (u.receipts.length >= 2) {
    const target = u.receipts[0];
    const newAmount = Math.round((Number(target.amount) + 5) * 100) / 100;
    const pr = await u.client.patch(`/api/expenses/${target.id}`, { body: { amount: newAmount } });
    if (check(EXP, pr.ok && pr.body && pr.body.expense && moneyEq(pr.body.expense.amount, newAmount), {
      title: 'PATCH /api/expenses/:id did not round-trip the amount',
      detail: `expected ${newAmount}, got ${pr.body && pr.body.expense && pr.body.expense.amount}`,
      repro: repro('PATCH', `/api/expenses/${target.id}`, { amount: newAmount }, pr),
    })) {
      target.amount = newAmount;
    }
    const victim = u.receipts.pop();
    const dr = await u.client.delete(`/api/expenses/${victim.id}`);
    check(EXP, dr.ok, {
      title: 'DELETE /api/expenses/:id failed',
      detail: `status=${dr.status}`,
      repro: repro('DELETE', `/api/expenses/${victim.id}`, null, dr),
    });
  }
}

// Core money checks: the server's aggregates must agree with the server's own
// raw lists. Any discrepancy is reported with exact numbers.
async function moduleReconcile(u) {
  const MODULE = 'reconciliation';
  const ty = taxYearRange();
  const today = todayIso();

  const [gigsR, expR, invR, earnR] = [
    await u.client.get('/api/gigs'),
    await u.client.get('/api/expenses'),
    await u.client.get('/api/invoices'),
    await u.client.get('/api/earnings'),
  ];
  if (!gigsR.ok || !expR.ok || !invR.ok || !earnR.ok) {
    note(MODULE, {
      title: 'Reconciliation skipped for a user: one of the source lists failed',
      detail: `gigs=${gigsR.status} expenses=${expR.status} invoices=${invR.status} earnings=${earnR.status} (sim_index=${u.idx})`,
    });
    return;
  }
  const gigs = Array.isArray(gigsR.body) ? gigsR.body : [];
  const receipts = (expR.body && Array.isArray(expR.body.expenses)) ? expR.body.expenses : [];
  const invoices = Array.isArray(invR.body) ? invR.body : [];
  const earn = earnR.body || {};

  const inTy = (d) => { const s = dateStr(d); return s >= ty.start && s <= ty.end; };
  const expectedEarnings = gigs
    .filter((g) => g.status === 'confirmed' && inTy(g.date))
    .reduce((s, g) => s + (Number(g.fee) || 0), 0);
  const expectedExpenses = receipts
    .filter((r) => inTy(r.date))
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);

  check(MODULE, moneyEq(earn.total_earnings, expectedEarnings), {
    title: 'GET /api/earnings total_earnings disagrees with the gig list',
    detail: `user sim_index=${u.idx}: earnings endpoint says ${earn.total_earnings}, sum of confirmed gig fees in ${ty.start}..${ty.end} from GET /api/gigs is ${expectedEarnings.toFixed(2)} (${gigs.length} gigs total)`,
    repro: repro('GET', '/api/earnings', null, earnR),
  });
  check(MODULE, moneyEq(earn.total_expenses, expectedExpenses), {
    title: 'GET /api/earnings total_expenses disagrees with the receipts list',
    detail: `user sim_index=${u.idx}: earnings endpoint says ${earn.total_expenses}, sum of receipts in range from GET /api/expenses is ${expectedExpenses.toFixed(2)} (${receipts.length} receipts)`,
    repro: repro('GET', '/api/earnings', null, earnR),
  });

  // Invoice summary (note: the endpoint returns SUMS of amounts per bucket,
  // not row counts).
  const buckets = { paid: 0, unpaid: 0, overdue: 0, draft: 0 };
  for (const inv of invoices) {
    const amt = Number(inv.amount) || 0;
    const due = dateStr(inv.due_date);
    if (inv.status === 'paid') buckets.paid += amt;
    else if (inv.status === 'draft') buckets.draft += amt;
    else if (inv.status === 'sent') {
      if (due && due < today) buckets.overdue += amt; else buckets.unpaid += amt;
    }
  }
  const is = earn.invoice_summary || {};
  for (const k of ['paid', 'unpaid', 'overdue', 'draft']) {
    check(MODULE, moneyEq(is[k], buckets[k]), {
      title: `GET /api/earnings invoice_summary.${k} disagrees with the invoice list`,
      detail: `user sim_index=${u.idx}: summary says ${is[k]}, recomputed from GET /api/invoices = ${buckets[k].toFixed(2)} (${invoices.length} invoices). Buckets: ${snippet(buckets)}`,
      repro: repro('GET', '/api/earnings', null, earnR),
    });
  }

  // MTD CSV export must agree with the earnings totals.
  const mtd = await rawGet(u.client.baseUrl, '/api/finance/mtd-export', u);
  if (check(MODULE, mtd.status === 200 && /csv/i.test(mtd.contentType), {
    title: 'GET /api/finance/mtd-export did not return CSV',
    detail: `status=${mtd.status} content-type=${mtd.contentType}`,
    repro: { method: 'GET', endpoint: '/api/finance/mtd-export', payload: null, status: mtd.status, body_snippet: mtd.text.slice(0, 200) },
  })) {
    const lines = mtd.text.split(/\r?\n/);
    const totalIncomeLine = lines.find((l) => l.startsWith('Total income'));
    const csvIncome = totalIncomeLine ? Number(totalIncomeLine.split(',')[1]) : NaN;
    check(MODULE, Number.isFinite(csvIncome) && moneyEq(csvIncome, Number(earn.total_earnings)), {
      title: 'MTD export Total income disagrees with GET /api/earnings',
      detail: `user sim_index=${u.idx}: CSV says ${csvIncome}, earnings endpoint says ${earn.total_earnings}. (CSV income only counts gigs with a non-null fee, earnings counts null fee as 0, so a mismatch here with equal data means a real divergence.)`,
      repro: { method: 'GET', endpoint: '/api/finance/mtd-export', payload: null, status: mtd.status, body_snippet: totalIncomeLine || '' },
    });
    // Count expense data rows: between the EXPENSES header row and the blank line.
    const expHeaderIdx = lines.findIndex((l) => l.startsWith('EXPENSES'));
    let csvExpenseRows = 0;
    if (expHeaderIdx >= 0) {
      for (let i = expHeaderIdx + 2; i < lines.length && lines[i].trim() !== ''; i++) csvExpenseRows++;
    }
    const expectedRows = receipts.filter((r) => inTy(r.date)).length;
    check(MODULE, csvExpenseRows === expectedRows, {
      title: 'MTD export expense row count disagrees with the receipts list',
      detail: `user sim_index=${u.idx}: CSV has ${csvExpenseRows} expense rows, GET /api/expenses has ${expectedRows} receipts in ${ty.start}..${ty.end}`,
      repro: { method: 'GET', endpoint: '/api/finance/mtd-export', payload: null, status: mtd.status, body_snippet: lines.slice(expHeaderIdx, expHeaderIdx + 4).join(' | ') },
    });
  }

  // Receipts zip
  const zip = await rawGet(u.client.baseUrl, '/api/expenses/export.zip', u);
  check(MODULE, zip.status === 200 && zip.bytes > 0, {
    title: 'GET /api/expenses/export.zip failed or returned an empty body',
    detail: `status=${zip.status} bytes=${zip.bytes} content-type=${zip.contentType}`,
    repro: { method: 'GET', endpoint: '/api/expenses/export.zip', payload: null, status: zip.status, body_snippet: zip.contentType },
  });

  // Stats: month_earnings must equal confirmed gigs in the current month.
  const statsR = await u.client.get('/api/stats');
  if (statsR.ok && statsR.body) {
    const now = new Date();
    const mStart = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-01`;
    const mEnd = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-31`;
    const expectedMonth = gigs
      .filter((g) => g.status === 'confirmed' && dateStr(g.date) >= mStart && dateStr(g.date) <= mEnd)
      .reduce((s, g) => s + (Number(g.fee) || 0), 0);
    check(MODULE, moneyEq(statsR.body.month_earnings, expectedMonth), {
      title: 'GET /api/stats month_earnings disagrees with confirmed gigs in the current month',
      detail: `user sim_index=${u.idx}: stats says ${statsR.body.month_earnings}, recomputed from GET /api/gigs = ${expectedMonth.toFixed(2)}`,
      repro: repro('GET', '/api/stats', null, statsR),
    });
  } else {
    note(MODULE, {
      title: 'GET /api/stats failed during reconciliation',
      detail: `status=${statsR.status}`,
      repro: repro('GET', '/api/stats', null, statsR),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Module 6: EVERYTHING-ELSE SWEEP
// ───────────────────────────────────────────────────────────────────────────

async function moduleSweep(u, premiumUser, rand) {
  const MODULE = 'sweep';

  // Blocked dates: single
  const singleDate = isoPlusDays(30 + Math.floor(rand() * 30));
  const b1 = await u.client.post('/api/blocked-dates', { body: { mode: 'single', date: singleDate } });
  check(MODULE, b1.ok, {
    title: 'POST /api/blocked-dates (single) failed',
    detail: `status=${b1.status}`,
    repro: repro('POST', '/api/blocked-dates', { mode: 'single', date: singleDate }, b1),
  });

  // Recurring with an until date: expanded_dates must respect it.
  const recFrom = isoPlusDays(7);
  const recTo = isoPlusDays(45);
  const b2 = await u.client.post('/api/blocked-dates', { body: { mode: 'recurring', days: [1, 3], from: recFrom, to: recTo, reason: 'Teaching nights' } });
  check(MODULE, b2.ok, {
    title: 'POST /api/blocked-dates (recurring) failed',
    detail: `status=${b2.status}`,
    repro: repro('POST', '/api/blocked-dates', { mode: 'recurring', days: [1, 3], from: recFrom, to: recTo }, b2),
  });
  const bl = await u.client.get('/api/blocked-dates');
  const rows = Array.isArray(bl.body) ? bl.body : [];
  const recRow = rows.find((r) => r.recurring_pattern && String(r.recurring_pattern).startsWith('recurring:'));
  if (check(MODULE, !!recRow && Array.isArray(recRow.expanded_dates) && recRow.expanded_dates.length > 0, {
    title: 'Recurring blocked-date row missing or has no expanded_dates',
    detail: `rows=${rows.length} recurring row=${snippet(recRow)}`,
    repro: repro('GET', '/api/blocked-dates', null, bl),
  })) {
    const beyondUntil = recRow.expanded_dates.filter((d) => d > recTo);
    check(MODULE, beyondUntil.length === 0, {
      title: 'Recurring blocked dates expand past the until date',
      detail: `until=${recTo}, dates beyond it: ${snippet(beyondUntil)}`,
      repro: repro('GET', '/api/blocked-dates', null, bl),
    });
    const wrongDay = recRow.expanded_dates.filter((d) => ![1, 3].includes(new Date(d + 'T12:00:00Z').getUTCDay()));
    check(MODULE, wrongDay.length === 0, {
      severity: 'improvement',
      title: 'Recurring blocked dates include days outside the requested weekdays',
      detail: `requested days=[1,3] (Mon,Wed), offending dates: ${snippet(wrongDay)}`,
      repro: repro('GET', '/api/blocked-dates', null, bl),
    });
  }

  // Bulk + delete one
  const bulkDates = [isoPlusDays(100), isoPlusDays(101), isoPlusDays(102)];
  const b3 = await u.client.post('/api/blocked-dates/bulk', { body: { dates: bulkDates, reason: 'Holiday' } });
  check(MODULE, b3.ok && b3.body && b3.body.inserted >= 1, {
    title: 'POST /api/blocked-dates/bulk failed',
    detail: `status=${b3.status} body=${snippet(b3.body)}`,
    repro: repro('POST', '/api/blocked-dates/bulk', { dates: bulkDates }, b3),
  });
  const bl2 = await u.client.get('/api/blocked-dates');
  const rows2 = Array.isArray(bl2.body) ? bl2.body : [];
  const delTarget = rows2.find((r) => dateStr(r.date) === singleDate);
  if (delTarget) {
    const del = await u.client.delete(`/api/blocked-dates/${delTarget.id}`);
    check(MODULE, del.ok, {
      title: 'DELETE /api/blocked-dates/:id failed',
      detail: `status=${del.status}`,
      repro: repro('DELETE', `/api/blocked-dates/${delTarget.id}`, null, del),
    });
    const bl3 = await u.client.get('/api/blocked-dates');
    const gone = !(Array.isArray(bl3.body) ? bl3.body : []).some((r) => r.id === delTarget.id);
    check(MODULE, gone, {
      title: 'Deleted blocked date still present in GET /api/blocked-dates',
      detail: `id=${delTarget.id}`,
      repro: repro('GET', '/api/blocked-dates', null, bl3),
    });
  }

  // Setlists: build, reorder, print, attach to a gig.
  const setlist = await ensureSetlist(u, rand);
  if (setlist && u.songs.length >= 3) {
    const reversed = [...setlist.song_ids].reverse();
    const pr = await u.client.patch(`/api/setlists/${setlist.id}`, { body: { song_ids: reversed } });
    check(MODULE, pr.ok && pr.body && JSON.stringify(pr.body.song_ids) === JSON.stringify(reversed), {
      title: 'PATCH setlist song_ids order did not round-trip',
      detail: `sent ${snippet(reversed)}, got ${snippet(pr.body && pr.body.song_ids)}`,
      repro: repro('PATCH', `/api/setlists/${setlist.id}`, { song_ids: reversed }, pr),
    });
    const print = await rawGet(u.client.baseUrl, `/api/print/setlist/${setlist.id}`, u);
    check(MODULE, print.status === 200 && /html/i.test(print.contentType), {
      title: 'GET /api/print/setlist/:id did not return printable HTML',
      detail: `status=${print.status} content-type=${print.contentType}`,
      repro: { method: 'GET', endpoint: `/api/print/setlist/${setlist.id}`, payload: null, status: print.status, body_snippet: print.text.slice(0, 150) },
    });

    const gig = await ensureFutureGig(u, rand);
    if (gig) {
      const at = await u.client.patch(`/api/gigs/${gig.id}/setlist`, { body: { setlist_id: setlist.id, setlist_notes: 'Skip track 2 if running late' } });
      check(MODULE, at.ok && at.body && at.body.setlist_id === setlist.id && at.body.setlist_notes === 'Skip track 2 if running late', {
        title: 'PATCH /api/gigs/:id/setlist did not round-trip setlist + notes',
        detail: `status=${at.status} setlist_id=${at.body && at.body.setlist_id}`,
        repro: repro('PATCH', `/api/gigs/${gig.id}/setlist`, { setlist_id: setlist.id, setlist_notes: '...' }, at),
      });
      const clear = await u.client.patch(`/api/gigs/${gig.id}/setlist`, { body: { setlist_id: null } });
      check(MODULE, clear.ok && clear.body && clear.body.setlist_id == null, {
        title: 'PATCH /api/gigs/:id/setlist with null did not clear the assignment',
        detail: `status=${clear.status} setlist_id=${clear.body && clear.body.setlist_id}`,
        repro: repro('PATCH', `/api/gigs/${gig.id}/setlist`, { setlist_id: null }, clear),
      });
    }
  }

  // Lineup premium gate: free user must 403.
  const freeGig = await ensureFutureGig(u, rand);
  if (freeGig && !u.premium) {
    const lr = await u.client.patch(`/api/gigs/${freeGig.id}/lineup`, { body: { lineup: [{ name: 'Dep Drummer', role: 'Drums', status: 'confirmed' }] } });
    check(MODULE, lr.status === 403 && lr.body && lr.body.error === 'premium_required', {
      title: `Free-tier lineup PATCH returned ${lr.status}, expected 403 premium_required`,
      detail: `body=${snippet(lr.body)}`,
      repro: repro('PATCH', `/api/gigs/${freeGig.id}/lineup`, { lineup: [{ name: 'Dep Drummer' }] }, lr),
    });
  }
  // Premium user CRUD works.
  if (premiumUser) {
    const pGig = await ensureFutureGig(premiumUser, rand);
    if (pGig) {
      const lineup = [{ name: 'Sam Keys', role: 'Keys', status: 'confirmed' }, { name: 'Jo Bass', role: 'Bass', status: 'pending' }];
      const lr = await premiumUser.client.patch(`/api/gigs/${pGig.id}/lineup`, { body: { lineup } });
      check(MODULE, lr.ok && lr.body && Array.isArray(lr.body.lineup) && lr.body.lineup.length === 2, {
        title: 'Premium user lineup PATCH failed',
        detail: `status=${lr.status} body=${snippet(lr.body)}. If this is a 403 premium_required: the lineup gate reads users.subscription_tier while /auth/dev-set-premium sets users.premium/premium_until, so the two premium flags disagree.`,
        repro: repro('PATCH', `/api/gigs/${pGig.id}/lineup`, { lineup }, lr),
      });
    }
  }

  // Documents: upload, fetch file, delete.
  const docPayload = { name: 'Public liability certificate', doc_type: 'other', file_base64: TINY_PNG_DATA_URL, expiry_date: isoPlusDays(25) };
  const doc = await u.client.post('/api/documents', { body: docPayload });
  if (check(MODULE, doc.ok && doc.body && doc.body.document && doc.body.document.has_file === true, {
    title: 'POST /api/documents with file_base64 failed',
    detail: `status=${doc.status} body=${snippet(doc.body)}`,
    repro: repro('POST', '/api/documents', { name: docPayload.name, file_base64: '<1x1 png>' }, doc),
  })) {
    const docId = doc.body.document.id;
    const file = await rawGet(u.client.baseUrl, `/api/documents/${docId}/file`, u);
    check(MODULE, file.status === 200 && /image\/png/i.test(file.contentType), {
      title: 'GET /api/documents/:id/file did not stream the stored file back',
      detail: `status=${file.status} content-type=${file.contentType} bytes=${file.bytes}`,
      repro: { method: 'GET', endpoint: `/api/documents/${docId}/file`, payload: null, status: file.status, body_snippet: file.contentType },
    });
    const del = await u.client.delete(`/api/documents/${docId}`);
    check(MODULE, del.ok, {
      title: 'DELETE /api/documents/:id failed',
      detail: `status=${del.status}`,
      repro: repro('DELETE', `/api/documents/${docId}`, null, del),
    });
  }

  // Notifications: list + dismiss one (key derived the same way the client does).
  const nr = await u.client.get('/api/notifications');
  const notifs = Array.isArray(nr.body) ? nr.body : [];
  check(MODULE, nr.ok, {
    title: 'GET /api/notifications failed',
    detail: `status=${nr.status}`,
    repro: repro('GET', '/api/notifications', null, nr),
  });
  if (notifs.length > 0) {
    const n = notifs[0];
    const key = `${n.type}:${n.action_type || ''}:${n.action_id || ''}:${n.timestamp || ''}`;
    const dr = await u.client.post('/api/notifications/dismiss', { body: { key } });
    check(MODULE, dr.ok && dr.body && dr.body.success, {
      title: 'POST /api/notifications/dismiss failed',
      detail: `status=${dr.status} key=${key}`,
      repro: repro('POST', '/api/notifications/dismiss', { key }, dr),
    });
  }
}

// Public, unauthenticated pages for a user with a slug.
async function modulePublic(baseUrl, u) {
  const MODULE = 'public-pages';
  if (!u || !u.slug) return;

  const epk = await rawGet(baseUrl, `/epk/${u.slug}`, null);
  if (check(MODULE, epk.status === 200, {
    title: 'Public EPK page /epk/:slug did not return 200',
    detail: `slug=${u.slug} status=${epk.status}`,
    repro: { method: 'GET', endpoint: `/epk/${u.slug}`, payload: null, status: epk.status, body_snippet: epk.text.slice(0, 150) },
  })) {
    const nameVisible = epk.text.includes(u.display_name) || epk.text.includes(u.name);
    check(MODULE, nameVisible, {
      title: 'Public EPK page does not contain the artist name',
      detail: `slug=${u.slug} expected "${u.display_name}" somewhere in the HTML`,
      repro: { method: 'GET', endpoint: `/epk/${u.slug}`, payload: null, status: epk.status, body_snippet: epk.text.slice(0, 200) },
    });
  }

  const share = await rawGet(baseUrl, `/share/${u.slug}`, null);
  check(MODULE, share.status === 200, {
    title: 'Public availability page /share/:slug did not return 200',
    detail: `slug=${u.slug} status=${share.status}`,
    repro: { method: 'GET', endpoint: `/share/${u.slug}`, payload: null, status: share.status, body_snippet: share.text.slice(0, 150) },
  });
  const times = await rawGet(baseUrl, `/share/${u.slug}?times=1`, null);
  check(MODULE, times.status === 200, {
    title: '/share/:slug?times=1 variant did not return 200',
    detail: `slug=${u.slug} status=${times.status}`,
    repro: { method: 'GET', endpoint: `/share/${u.slug}?times=1`, payload: null, status: times.status, body_snippet: times.text.slice(0, 150) },
  });
  const embed = await rawGet(baseUrl, `/share/${u.slug}?embed=1`, null);
  if (check(MODULE, embed.status === 200, {
    title: '/share/:slug?embed=1 variant did not return 200',
    detail: `slug=${u.slug} status=${embed.status}`,
    repro: { method: 'GET', endpoint: `/share/${u.slug}?embed=1`, payload: null, status: embed.status, body_snippet: embed.text.slice(0, 150) },
  })) {
    check(MODULE, !embed.text.includes('Powered by'), {
      title: "Embed variant of the share page still contains 'Powered by' branding",
      detail: `slug=${u.slug}; ?embed=1 must strip the footer branding`,
      repro: { method: 'GET', endpoint: `/share/${u.slug}?embed=1`, payload: null, status: embed.status, body_snippet: 'contains "Powered by"' },
    });
  }
  const ics = await rawGet(baseUrl, `/share/${u.slug}/next-gig.ics`, null);
  check(MODULE, ics.status === 200 && /calendar/i.test(ics.contentType), {
    severity: ics.status === 404 ? 'note' : 'bug',
    title: '/share/:slug/next-gig.ics did not return an iCalendar payload',
    detail: `slug=${u.slug} status=${ics.status} content-type=${ics.contentType} (404 may just mean the user has no upcoming gig)`,
    repro: { method: 'GET', endpoint: `/share/${u.slug}/next-gig.ics`, payload: null, status: ics.status, body_snippet: ics.text.slice(0, 150) },
  });

  note(MODULE, {
    title: 'Availability-share blocked-cell rendering not asserted',
    detail: 'Checking that a specific blocked date renders as a blocked cell depends on the page markup and is brittle; verify visually. Recorded as a note per the campaign spec.',
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Module 7: latency roll-up
// ───────────────────────────────────────────────────────────────────────────

function normPath(p) {
  let s = String(p).split('?')[0];
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
  s = s.replace(/\/\d+(?=\/|$)/g, '/:id');
  s = s.replace(/^\/(epk|share|pay)\/[^/]+/, '/$1/:slug');
  return s;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function latencyRollup() {
  const MODULE = 'latency';
  const coldCutoff = RUN_START + 2 * 60 * 1000; // drop the first 2 minutes (cold starts)
  const byEndpoint = new Map();
  for (const ev of memEvents) {
    if (!ev || ev.ts < coldCutoff || !ev.status) continue;
    const key = `${ev.method} ${normPath(ev.path)}`;
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key).push(ev.elapsed_ms);
  }
  const rows = [];
  for (const [key, arr] of byEndpoint) {
    arr.sort((a, b) => a - b);
    const row = {
      endpoint: key,
      samples: arr.length,
      p50_ms: percentile(arr, 0.5),
      p95_ms: percentile(arr, 0.95),
      max_ms: arr[arr.length - 1],
    };
    rows.push(row);
    if (row.samples >= 5 && row.p95_ms > 3000) {
      addFinding({
        severity: 'improvement',
        area: 'latency',
        title: `Slow endpoint: ${key} p95 ${row.p95_ms}ms`,
        detail: `${row.samples} samples after the 2-minute cold-start window: p50=${row.p50_ms}ms p95=${row.p95_ms}ms max=${row.max_ms}ms. Threshold is 3000ms.`,
        repro: { method: key.split(' ')[0], endpoint: key.split(' ')[1], payload: null, status: null, body_snippet: null },
      });
      statsFor(MODULE).fail++;
    } else {
      statsFor(MODULE).pass++;
    }
  }
  rows.sort((a, b) => b.p95_ms - a.p95_ms);
  return rows;
}

// ───────────────────────────────────────────────────────────────────────────
// Reporting
// ───────────────────────────────────────────────────────────────────────────

const SEV_ORDER = { bug: 0, improvement: 1, note: 2 };

function writeOutputs(outDir, meta, latencyRows) {
  findings.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.area.localeCompare(b.area));
  fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify({ meta, findings }, null, 2));

  const counts = { bug: 0, improvement: 0, note: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const lines = [];
  lines.push('# TrackMyGigs functional test campaign');
  lines.push('');
  lines.push(`- Base URL: ${meta.base_url}`);
  lines.push(`- Started: ${meta.started_at}  Finished: ${meta.finished_at}  Duration: ${Math.round(meta.duration_ms / 1000)}s`);
  lines.push(`- Fleet: ${meta.users_created}/${meta.users_requested} users minted (concurrency ${meta.concurrency}, seed ${meta.seed})`);
  lines.push(`- Requests recorded: ${memEvents.length}`);
  lines.push(`- Findings: ${counts.bug || 0} bugs, ${counts.improvement || 0} improvements, ${counts.note || 0} notes`);
  lines.push('');
  lines.push('AI endpoints (/api/ai/*) were deliberately never called. All activity was confined to freshly minted sim+*@trackmygigs.app accounts; clean up with `node sim/run.js --wipe`.');
  lines.push('');
  lines.push('## Module results');
  lines.push('');
  lines.push('| Module | Checks passed | Checks failed | Notes | Verdict |');
  lines.push('|---|---|---|---|---|');
  const moduleNames = Object.keys(moduleStats).sort();
  for (const m of moduleNames) {
    const s = moduleStats[m];
    lines.push(`| ${m} | ${s.pass} | ${s.fail} | ${s.notes} | ${s.fail === 0 ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (findings.length === 0) {
    lines.push('No findings. Every assertion passed.');
  } else {
    lines.push('| Severity | Area | Title | Seen | Detail |');
    lines.push('|---|---|---|---|---|');
    for (const f of findings) {
      const detail = String(f.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
      const title = String(f.title).replace(/\|/g, '\\|');
      lines.push(`| ${f.severity} | ${f.area} | ${title} | ${f.occurrences}x | ${detail} |`);
    }
    lines.push('');
    lines.push('Full reproduction payloads (endpoint, payload, status, body snippet) are in findings.json.');
  }
  lines.push('');
  lines.push('## Endpoint latency (cold-start window excluded)');
  lines.push('');
  lines.push('| Endpoint | Samples | p50 ms | p95 ms | Max ms |');
  lines.push('|---|---|---|---|---|');
  for (const r of latencyRows.slice(0, 40)) {
    lines.push(`| ${r.endpoint} | ${r.samples} | ${r.p50_ms} | ${r.p95_ms} | ${r.max_ms} |`);
  }
  lines.push('');
  lines.push('Raw per-request log: events.jsonl in this directory.');
  lines.push('');
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(args.base || '').replace(/\/$/, '');
  if (!baseUrl) { console.error('Missing --base <URL>'); process.exit(0); }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.outDir || path.join(__dirname, 'results', `${ts}-campaign`);
  fs.mkdirSync(outDir, { recursive: true });
  eventsLog = makeJsonlWriter(path.join(outDir, 'events.jsonl'));

  RUN_START = Date.now();
  DEADLINE = RUN_START + args.maxMinutes * 60 * 1000;
  const seed = args.seed != null ? args.seed : (Date.now() % 2147483647);
  const rand = mulberry32(seed);
  const runTag = Math.floor(Date.now() / 1000).toString(36);
  const sem = new Semaphore(args.concurrency);

  const meta = {
    started_at: new Date().toISOString(),
    base_url: baseUrl,
    users_requested: args.users,
    concurrency: args.concurrency,
    seed,
    run_tag: runTag,
    users_created: 0,
    finished_at: null,
    duration_ms: 0,
  };

  console.log(`[campaign] starting against ${baseUrl}`);
  console.log(`[campaign] users=${args.users} concurrency=${args.concurrency} seed=${seed} out=${outDir}`);

  // Phase 0: fleet
  console.log('[campaign] phase 0: minting fleet + profiles + EPKs + premium');
  const fleet = makeFleetSpec(args.users, rand, runTag);
  const ctx = { baseUrl, secret: args.secret };
  await runLimited(sem, fleet.map((u) => () => mintUser(u, ctx)));
  const live = fleet.filter((u) => u.client);
  meta.users_created = live.length;
  console.log(`[campaign] fleet live: ${live.length}/${fleet.length}`);
  if (live.length === 0) {
    addFinding({ severity: 'bug', area: 'fleet', title: 'No sim users could be created; campaign aborted', detail: 'Check --base and --secret. sim-create-user must be reachable.' });
    meta.finished_at = new Date().toISOString();
    meta.duration_ms = Date.now() - RUN_START;
    writeOutputs(outDir, meta, []);
    console.log('[campaign] aborted; report written.');
    return;
  }

  const epkUsers = live.filter((u) => u.slug);
  const premiumCandidates = epkUsers.slice(0, 4);
  await runLimited(sem, premiumCandidates.map((u) => () => grantPremium(u)));
  const premiumUsers = live.filter((u) => u.premium);

  // Carve up the fleet for cross-user scenarios. The block-test pair is
  // reserved and excluded from messaging/marketplace so a block can never
  // contaminate another scenario.
  const blockPair = live.slice(-2);
  const pool = live.slice(0, Math.max(0, live.length - 2));
  const byPersona = (k) => pool.filter((u) => u.persona === k);
  const leaders = [...byPersona('band_leader'), ...byPersona('active_gigger')];
  const deps = [...byPersona('dep_specialist'), ...byPersona('hobbyist')];

  // Phase 1: per-user solo activity
  console.log('[campaign] phase 1: gigs + invoices + expenses per user');
  const perUserRand = (u) => mulberry32(seed + u.idx * 7919 + 13);
  await runLimited(sem, live.map((u) => async () => {
    if (expired()) return;
    const r = perUserRand(u);
    try { await moduleGigs(u, r); } catch (e) { note('gigs', { title: 'gigs module threw', detail: `${e.message} (sim_index=${u.idx})` }); }
    try { await moduleInvoicesExpenses(u, r); } catch (e) { note('invoices', { title: 'invoices module threw', detail: `${e.message} (sim_index=${u.idx})` }); }
  }));

  // Phase 2: dep offers (heavy)
  console.log('[campaign] phase 2: dep offers');
  const depScenarios = [];
  const nDepScenarios = Math.min(14, leaders.length, Math.floor(deps.length / 3));
  for (let i = 0; i < nDepScenarios; i++) {
    const leader = leaders[i % leaders.length];
    const recipients = [deps[(i * 3) % deps.length], deps[(i * 3 + 1) % deps.length], deps[(i * 3 + 2) % deps.length]]
      .filter((r, idx, arr) => r && r.userId !== leader.userId && arr.findIndex((x) => x.userId === r.userId) === idx);
    if (recipients.length === 0) continue;
    const opts = i === 0
      ? { withReplacement: true, replacementUser: deps[(i * 3 + 4) % deps.length] }
      : {};
    if (opts.replacementUser && (opts.replacementUser.userId === leader.userId || recipients.some((r) => r.userId === opts.replacementUser.userId))) {
      opts.withReplacement = false;
    }
    depScenarios.push(() => expired() ? null : scenarioDepOffers(leader, recipients, mulberry32(seed + 1000 + i), opts)
      .catch((e) => note('dep-offers', { title: 'dep-offers scenario threw', detail: e.message })));
  }
  await runLimited(sem, depScenarios);

  // Phase 3: messaging (heavy)
  console.log('[campaign] phase 3: messaging');
  const msgScenarios = [];
  const nMsg = Math.min(20, Math.floor(pool.length / 3));
  for (let i = 0; i < nMsg; i++) {
    const a = pool[(i * 3) % pool.length];
    const b = pool[(i * 3 + 1) % pool.length];
    const c = pool[(i * 3 + 2) % pool.length];
    if (!a || !b || a.userId === b.userId) continue;
    const third = (c && c.userId !== a.userId && c.userId !== b.userId) ? c : null;
    msgScenarios.push(() => expired() ? null : scenarioMessaging(a, b, third, mulberry32(seed + 2000 + i))
      .catch((e) => note('messaging', { title: 'messaging scenario threw', detail: e.message })));
  }
  await runLimited(sem, msgScenarios);

  // Phase 4: marketplace (heavy)
  console.log('[campaign] phase 4: marketplace');
  const mktScenarios = [];
  const posters = leaders.length > 0 ? leaders : pool;
  const nPick = Math.min(8, posters.length);
  for (let i = 0; i < nPick; i++) {
    const poster = posters[i % posters.length];
    const candidates = deps.filter((d) => d.userId !== poster.userId);
    const applicants = [candidates[(i * 4) % candidates.length], candidates[(i * 4 + 1) % candidates.length], candidates[(i * 4 + 2) % candidates.length]]
      .filter((x, idx, arr) => x && arr.findIndex((y) => y.userId === x.userId) === idx);
    const late = candidates[(i * 4 + 3) % candidates.length];
    if (applicants.length < 2) continue;
    mktScenarios.push(() => expired() ? null : scenarioMarketplacePick(poster, applicants, (late && !applicants.some((a) => a.userId === late.userId)) ? late : null, mulberry32(seed + 3000 + i))
      .catch((e) => note('marketplace', { title: 'marketplace pick scenario threw', detail: e.message })));
  }
  // FCFS torture: one big simultaneous race plus two normal fcfs fills.
  for (let i = 0; i < 3; i++) {
    const poster = posters[(i + 3) % posters.length];
    const racers = deps.filter((d) => d.userId !== poster.userId).slice(i * 5, i * 5 + 5);
    if (racers.length >= (i === 0 ? 5 : 2)) {
      mktScenarios.push(() => expired() ? null : scenarioMarketplaceFcfs(poster, racers, mulberry32(seed + 4000 + i))
        .catch((e) => note('marketplace-fcfs', { title: 'fcfs scenario threw', detail: e.message })));
    }
  }
  // Misc: floor reject, free post, withdraw/cancel/repost.
  for (let i = 0; i < 3; i++) {
    const poster = posters[(i + 6) % posters.length];
    const applicant = deps.find((d) => d.userId !== poster.userId);
    if (poster && applicant) {
      mktScenarios.push(() => expired() ? null : scenarioMarketplaceMisc(poster, applicant, mulberry32(seed + 5000 + i))
        .catch((e) => note('marketplace', { title: 'marketplace misc scenario threw', detail: e.message })));
    }
  }
  await runLimited(sem, mktScenarios);

  // Block / report isolation test (dedicated pair, run after marketplace so
  // neither side has contact rows linking them).
  console.log('[campaign] phase 4b: block semantics');
  if (blockPair.length === 2 && blockPair[0].client && blockPair[1].client) {
    try { await scenarioBlock(blockPair[0], blockPair[1]); }
    catch (e) { note('blocks', { title: 'block scenario threw', detail: e.message }); }
  }

  // Phase 5: everything-else sweep on a sample
  console.log('[campaign] phase 5: sweep (blocked dates, setlists, lineup, documents, notifications)');
  const sweepSample = pool.filter((u) => u.persona === 'active_gigger').slice(0, 10)
    .concat(pool.filter((u) => u.persona === 'hobbyist').slice(0, 3))
    .concat(pool.filter((u) => u.persona === 'lurker').slice(0, 1));
  await runLimited(sem, sweepSample.map((u, i) => () => expired() ? null :
    moduleSweep(u, i === 0 ? premiumUsers[0] : null, mulberry32(seed + 6000 + u.idx))
      .catch((e) => note('sweep', { title: 'sweep module threw', detail: `${e.message} (sim_index=${u.idx})` }))));

  // Public pages for a few EPK users (prefer one with a future gig for the ics).
  console.log('[campaign] phase 5b: public pages');
  const publicSample = epkUsers
    .sort((a, b) => (b.gigs.some((g) => dateStr(g.date) > todayIso()) ? 1 : 0) - (a.gigs.some((g) => dateStr(g.date) > todayIso()) ? 1 : 0))
    .slice(0, 3);
  await runLimited(sem, publicSample.map((u) => () => expired() ? null :
    modulePublic(baseUrl, u).catch((e) => note('public-pages', { title: 'public pages module threw', detail: e.message }))));

  // Phase 6: money reconciliation, after every gig-stamping interaction has landed.
  console.log('[campaign] phase 6: money reconciliation');
  const reconSample = pool
    .filter((u) => u.gigs.length > 0)
    .sort((a, b) => b.gigs.length - a.gigs.length)
    .slice(0, 20);
  await runLimited(sem, reconSample.map((u) => () => expired() ? null :
    moduleReconcile(u).catch((e) => note('reconciliation', { title: 'reconciliation module threw', detail: `${e.message} (sim_index=${u.idx})` }))));

  if (expired()) {
    note('runtime', {
      title: 'Runtime cap reached; some later phases may have been skipped',
      detail: `Cap was ${args.maxMinutes} minutes. Re-run with --max-minutes or fewer users for full coverage.`,
    });
  }

  // Phase 7: latency roll-up + outputs
  console.log('[campaign] phase 7: latency roll-up + report');
  const latencyRows = latencyRollup();
  meta.finished_at = new Date().toISOString();
  meta.duration_ms = Date.now() - RUN_START;
  writeOutputs(outDir, meta, latencyRows);

  const counts = { bug: 0, improvement: 0, note: 0 };
  for (const f of findings) counts[f.severity]++;
  console.log('\n===== CAMPAIGN COMPLETE =====');
  console.log(`Users     : ${meta.users_created}/${meta.users_requested}`);
  console.log(`Requests  : ${memEvents.length}`);
  console.log(`Findings  : ${counts.bug} bug / ${counts.improvement} improvement / ${counts.note} note`);
  console.log(`Report    : ${path.join(outDir, 'report.md')}`);
  console.log(`Findings  : ${path.join(outDir, 'findings.json')}`);
  console.log(`Raw log   : ${path.join(outDir, 'events.jsonl')}`);
  console.log('\nClean up sim data afterwards with: node sim/run.js --wipe --base ' + baseUrl);
}

main().catch((err) => {
  // The report is the product: even a fatal error exits 0 after recording it.
  console.error('[campaign] fatal:', err);
  try {
    addFinding({ severity: 'bug', area: 'harness', title: 'Campaign harness threw a fatal error', detail: String(err && err.stack || err).slice(0, 1500) });
    const outDir = path.join(__dirname, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-campaign-crash`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify({ findings }, null, 2));
  } catch (_) { /* last resort */ }
  process.exit(0);
});
