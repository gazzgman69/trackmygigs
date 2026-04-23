// Overnight stress harness for TrackMyGigs.
// Seeds [STRESS] accounts via dev-login, runs dep-offer round-trips
// (pick + broadcast), edge cases, concurrency, and a breadth sweep
// across the rest of the app. Writes a JSON results blob that the
// human-readable report is built from.
//
// Usage: node scripts/stress/overnight-stress.mjs
// Output: /tmp/stress-results.json

import fs from 'node:fs/promises';

const BASE = process.env.STRESS_BASE || 'https://ae09c647-8bf5-4921-92ff-ea1cb2c7d309-00-jm619uhf957h.kirk.replit.dev';
const RESULTS_PATH = process.env.STRESS_RESULTS || '/tmp/stress-results.json';

// ── account plan ─────────────────────────────────────────────────────────────
// Varied postcodes and radii so distance filtering actually fires.
const ACCOUNTS = {
  leader1: {
    email: 'stress-leader-1@trackmygigs.app',
    name: '[STRESS] Leader Alpha',
    postcode: 'SW1A 1AA',
    travel_radius_miles: 50,
    instruments: 'Vocals,Guitar',
    discoverable: true,
  },
  leader2: {
    email: 'stress-leader-2@trackmygigs.app',
    name: '[STRESS] Leader Bravo',
    postcode: 'M1 1AD',
    travel_radius_miles: 40,
    instruments: 'Keys',
    discoverable: true,
  },
  dep1: {
    email: 'stress-dep-1@trackmygigs.app',
    name: '[STRESS] Dep One',
    postcode: 'SW1A 2AA',
    travel_radius_miles: 25,
    instruments: 'Guitar',
    discoverable: true,
  },
  dep2: {
    email: 'stress-dep-2@trackmygigs.app',
    name: '[STRESS] Dep Two',
    postcode: 'E1 6AN',
    travel_radius_miles: 30,
    instruments: 'Guitar,Bass',
    discoverable: true,
  },
  dep3: {
    email: 'stress-dep-3@trackmygigs.app',
    name: '[STRESS] Dep Three',
    postcode: 'TR26 1AG',
    travel_radius_miles: 15,
    instruments: 'Guitar',
    discoverable: true,
  },
  dep4: {
    email: 'stress-dep-4@trackmygigs.app',
    name: '[STRESS] Dep Four',
    postcode: 'EH1 1YZ',
    travel_radius_miles: 500,
    instruments: 'Guitar,Vocals',
    discoverable: true,
  },
};

// ── result capture ───────────────────────────────────────────────────────────
const results = {
  started_at: new Date().toISOString(),
  base: BASE,
  scenarios: [],
  summary: { passed: 0, failed: 0, skipped: 0 },
};

function record(category, name, status, note, extra = {}) {
  results.scenarios.push({
    category, name, status, note, ts: new Date().toISOString(), ...extra,
  });
  if (status === 'pass') results.summary.passed++;
  else if (status === 'fail') results.summary.failed++;
  else results.summary.skipped++;
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '○';
  console.log(`${icon} [${category}] ${name}: ${note}`);
}

async function saveResults() {
  results.ended_at = new Date().toISOString();
  await fs.writeFile(RESULTS_PATH, JSON.stringify(results, null, 2));
}

// ── tiny HTTP client with cookie jars per account ────────────────────────────
const sessions = {};  // key -> { token, user }

async function http(method, path, { token, body, headers = {} } = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.cookie = `sessionToken=${token}`;
  const init = { method, headers: h, redirect: 'manual' };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json, setCookie: res.headers.get('set-cookie') };
}

function parseSessionToken(setCookieHeader) {
  if (!setCookieHeader) return null;
  const m = setCookieHeader.match(/sessionToken=([^;,]+)/);
  return m ? m[1] : null;
}

async function devLogin(key) {
  const acc = ACCOUNTS[key];
  const url = `/auth/dev-login?email=${encodeURIComponent(acc.email)}&name=${encodeURIComponent(acc.name)}`;
  const r = await http('GET', url);
  const token = parseSessionToken(r.setCookie);
  if (!token) throw new Error(`dev-login for ${key} returned no session cookie; status=${r.status}`);
  sessions[key] = { token };
  // The session-validation endpoint lives at /auth/me (not /api/auth/me).
  const me = await http('GET', '/auth/me', { token });
  if (me.status !== 200 || !me.json?.user?.id) {
    throw new Error(`/auth/me failed for ${key}: ${me.status} ${me.text?.slice(0, 200)}`);
  }
  sessions[key].user = me.json.user;
  return sessions[key];
}

async function setProfile(key) {
  const acc = ACCOUNTS[key];
  const s = sessions[key];
  // instruments is comma-separated STRING (the PATCH handler does .split(','))
  const r = await http('PATCH', '/api/user/profile', {
    token: s.token,
    body: {
      home_postcode: acc.postcode,
      travel_radius_miles: acc.travel_radius_miles,
      instruments: acc.instruments,
      discoverable: acc.discoverable,
      bio: `Automated stress-test account for ${key}. Safe to delete.`,
    },
  });
  return r;
}

// ── Phase 1: account seeding + profile setup ─────────────────────────────────
async function phase1Seeding() {
  for (const key of Object.keys(ACCOUNTS)) {
    try {
      await devLogin(key);
      record('seeding', `dev-login ${key}`, 'pass', `userId=${sessions[key].user.id}`);
    } catch (e) {
      record('seeding', `dev-login ${key}`, 'fail', String(e));
    }
  }
  for (const key of Object.keys(ACCOUNTS)) {
    if (!sessions[key]) continue;
    try {
      const r = await setProfile(key);
      if (r.status === 200) {
        record('seeding', `profile ${key}`, 'pass',
          `postcode=${r.json?.home_postcode || r.json?.postcode || '?'} radius=${r.json?.travel_radius_miles ?? '?'}`);
      } else {
        record('seeding', `profile ${key}`, 'fail',
          `status=${r.status} body=${r.text?.slice(0, 200)}`);
      }
    } catch (e) {
      record('seeding', `profile ${key}`, 'fail', String(e));
    }
  }
}

// ── Phase 2: wire up contacts ────────────────────────────────────────────────
const CONTACT_PLAN = [
  ['leader1', 'dep1'],
  ['leader1', 'dep2'],
  ['leader1', 'dep3'],
  ['leader1', 'dep4'],
  ['leader2', 'dep1'],
  ['leader2', 'dep4'],
];

async function phase2Contacts() {
  for (const [ownerKey, contactKey] of CONTACT_PLAN) {
    const owner = sessions[ownerKey];
    const contact = ACCOUNTS[contactKey];
    const contactUser = sessions[contactKey]?.user;
    if (!owner || !contactUser) {
      record('contacts', `${ownerKey} → ${contactKey}`, 'skip', 'missing session');
      continue;
    }
    // Check if contact already exists (re-runs pick it up by email)
    const existing = await http('GET', '/api/contacts', { token: owner.token });
    const existingRow = Array.isArray(existing.json)
      ? existing.json.find(c => (c.email || '').toLowerCase() === contact.email.toLowerCase())
      : null;
    if (existingRow) {
      record('contacts', `${ownerKey} → ${contactKey}`, 'pass',
        `already existed id=${existingRow.id}`);
      continue;
    }
    const r = await http('POST', '/api/contacts', {
      token: owner.token,
      body: {
        name: contact.name,
        email: contact.email,
        instruments: contact.instruments,  // comma string, server converts
        linked_user_id: contactUser.id,
        is_favourite: true,  // favourites broadcast by default
      },
    });
    if (r.status === 200 || r.status === 201) {
      record('contacts', `${ownerKey} → ${contactKey}`, 'pass',
        `contactId=${r.json?.id || '?'} linkedUserId=${r.json?.linked_user_id || 'null'}`);
    } else {
      record('contacts', `${ownerKey} → ${contactKey}`, 'fail',
        `status=${r.status} body=${r.text?.slice(0, 200)}`);
    }
  }
}

// ── Phase 3: create test gigs owned by leader1 and leader2 ───────────────────
const createdGigs = {};  // key -> { id, venue_postcode }

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function createGig(ownerKey, { date, venue_postcode, band_name, venue_name, fee }) {
  const owner = sessions[ownerKey];
  const r = await http('POST', '/api/gigs', {
    token: owner.token,
    body: {
      band_name,
      venue_name,
      date,
      start_time: '20:00',
      end_time: '23:00',
      fee,
      venue_postcode,
      notes: '[STRESS] automated test gig',
    },
  });
  return r;
}

async function phase3Gigs() {
  const gigPlan = [
    { key: 'leader1_london_10d',   owner: 'leader1', date: futureDate(10), venue_postcode: 'SW1A 1AA', band_name: '[STRESS] Alpha Band', venue_name: 'London Test Venue', fee: 300 },
    { key: 'leader1_manchester',   owner: 'leader1', date: futureDate(14), venue_postcode: 'M1 1AD',   band_name: '[STRESS] Alpha Band', venue_name: 'Manchester Test',    fee: 400 },
    { key: 'leader1_cornwall',     owner: 'leader1', date: futureDate(21), venue_postcode: 'TR26 1AG', band_name: '[STRESS] Alpha Band', venue_name: 'Cornwall Test',      fee: 500 },
    { key: 'leader2_london',       owner: 'leader2', date: futureDate(12), venue_postcode: 'SW1A 1AA', band_name: '[STRESS] Bravo Band', venue_name: 'London Venue 2',     fee: 350 },
  ];
  for (const g of gigPlan) {
    const r = await createGig(g.owner, g);
    // POST /gigs returns gig row directly (not wrapped).
    const gigId = r.json?.id || r.json?.gig?.id;
    if ((r.status === 200 || r.status === 201) && gigId) {
      createdGigs[g.key] = { id: gigId, venue_postcode: g.venue_postcode, owner: g.owner };
      record('gigs', `create ${g.key}`, 'pass', `gigId=${gigId}`);
    } else {
      record('gigs', `create ${g.key}`, 'fail',
        `status=${r.status} body=${r.text?.slice(0, 200)}`);
    }
  }
}

// ── helpers for dep-offer scenarios ──────────────────────────────────────────
async function sendDepOffer(senderKey, gigKey, body) {
  const sender = sessions[senderKey];
  const gig = createdGigs[gigKey];
  if (!sender || !gig) return { error: 'missing prereq' };
  const r = await http('POST', '/api/dep-offers', {
    token: sender.token,
    body: { gig_id: gig.id, ...body },
  });
  return r;
}

async function getContacts(ownerKey) {
  const r = await http('GET', '/api/contacts', { token: sessions[ownerKey].token });
  return Array.isArray(r.json) ? r.json : (r.json?.contacts || []);
}

async function getReceivedOffers(key) {
  const r = await http('GET', '/api/offers', { token: sessions[key].token });
  return Array.isArray(r.json) ? r.json : (r.json?.offers || []);
}

async function getSentOffers(key) {
  const r = await http('GET', '/api/offers/sent', { token: sessions[key].token });
  return Array.isArray(r.json) ? r.json : (r.json?.offers || []);
}

// Resolve the specific offer we just sent by scanning the recipient's inbox
// for a pending offer on the given gig from the given sender. Relies on
// unique (sender, recipient, gig, pending) tuple at a point in time.
async function findLatestOffer(recipientKey, gigId, senderKey, message) {
  const list = await getReceivedOffers(recipientKey);
  // newest first by created_at
  const matches = list
    .filter(o => o.gig_id === gigId && o.sender_id === sessions[senderKey].user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return matches[0];
}

// Scenario A: pick-mode offer, recipient accepts, gig thread spawns, messaging works.
async function scenarioPickAccept() {
  try {
    const contacts = await getContacts('leader1');
    const dep1Contact = contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS.dep1.email);
    if (!dep1Contact) {
      record('dep_offer', 'A: pick+accept setup', 'fail',
        `dep1 contact not found for leader1 (have ${contacts.length} contacts: ${contacts.map(c => c.email).join(',')})`);
      return;
    }
    const sendR = await sendDepOffer('leader1', 'leader1_london_10d', {
      role: 'Guitar',
      message: '[STRESS A] Fancy covering guitar?',
      mode: 'pick',
      contact_ids: [dep1Contact.id],
    });
    if (sendR.status !== 200 && sendR.status !== 201) {
      record('dep_offer', 'A: pick send', 'fail',
        `status=${sendR.status} body=${sendR.text?.slice(0, 200)}`);
      return;
    }
    const { sent = 0, unresolved = 0, filtered_out_of_range = 0 } = sendR.json || {};
    record('dep_offer', 'A: pick send',
      sent === 1 ? 'pass' : 'fail',
      `sent=${sent} unresolved=${unresolved} filtered=${filtered_out_of_range}`);
    if (sent !== 1) return;

    // dep1 sees it
    const target = await findLatestOffer('dep1', createdGigs.leader1_london_10d.id, 'leader1');
    if (!target) {
      record('dep_offer', 'A: dep1 sees offer', 'fail', 'no offer in dep1 inbox');
      return;
    }
    record('dep_offer', 'A: dep1 sees offer', 'pass',
      `offerId=${target.id} status=${target.status} fee=${target.fee}`);

    // dep1 accepts
    const accR = await http('PATCH', `/api/offers/${target.id}`, {
      token: sessions.dep1.token,
      body: { status: 'accepted' },
    });
    if (accR.status === 200) {
      record('dep_offer', 'A: dep1 accepts', 'pass', `status=${accR.json?.status || 'accepted'}`);
    } else {
      record('dep_offer', 'A: dep1 accepts', 'fail',
        `status=${accR.status} body=${accR.text?.slice(0, 200)}`);
      return;
    }

    // leader1 sees it as accepted
    const sentOffers = await getSentOffers('leader1');
    const mirror = sentOffers.find(o => o.id === target.id);
    if (mirror && mirror.status === 'accepted') {
      record('dep_offer', 'A: leader1 sees accepted', 'pass', `status=${mirror.status}`);
    } else {
      record('dep_offer', 'A: leader1 sees accepted', 'fail', `mirror status=${mirror?.status}`);
    }

    // chat thread
    const threadR = await http('GET', `/api/chat/gig/${createdGigs.leader1_london_10d.id}`,
      { token: sessions.leader1.token });
    if (threadR.status === 200 && threadR.json?.thread?.id) {
      record('dep_offer', 'A: gig thread exists', 'pass',
        `threadId=${threadR.json.thread.id} participants=${threadR.json.participants?.length ?? '?'}`);
      // leader1 sends a message
      const msgR = await http('POST', `/api/chat/threads/${threadR.json.thread.id}/messages`, {
        token: sessions.leader1.token,
        body: { content: '[STRESS A] welcome aboard' },
      });
      if (msgR.status === 200) {
        record('dep_offer', 'A: leader posts in thread', 'pass',
          `messageId=${msgR.json?.message?.id}`);
      } else {
        record('dep_offer', 'A: leader posts in thread', 'fail',
          `status=${msgR.status} body=${msgR.text?.slice(0, 200)}`);
      }
      // dep1 reads
      const dep1Thread = await http('GET', `/api/chat/gig/${createdGigs.leader1_london_10d.id}`,
        { token: sessions.dep1.token });
      if (dep1Thread.status === 200 && (dep1Thread.json?.messages?.length ?? 0) >= 1) {
        record('dep_offer', 'A: dep1 reads thread', 'pass',
          `messages=${dep1Thread.json.messages.length}`);
        // dep1 replies
        const replyR = await http('POST', `/api/chat/threads/${dep1Thread.json.thread.id}/messages`, {
          token: sessions.dep1.token,
          body: { content: '[STRESS A] cheers, in!' },
        });
        record('dep_offer', 'A: dep1 replies in thread',
          replyR.status === 200 ? 'pass' : 'fail',
          `status=${replyR.status}`);
      } else {
        record('dep_offer', 'A: dep1 reads thread', 'fail',
          `status=${dep1Thread.status} messages=${dep1Thread.json?.messages?.length}`);
      }
    } else {
      record('dep_offer', 'A: gig thread exists', 'fail',
        `status=${threadR.status} body=${threadR.text?.slice(0, 200)}`);
    }
  } catch (e) {
    record('dep_offer', 'A: unexpected error', 'fail', String(e.stack || e));
  }
}

// Scenario B: broadcast with distance filter
async function scenarioBroadcastDistance() {
  try {
    const contacts = await getContacts('leader1');
    const ids = {};
    for (const k of ['dep1', 'dep2', 'dep3', 'dep4']) {
      const c = contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS[k].email);
      if (c) ids[k] = c.id;
    }
    if (Object.keys(ids).length !== 4) {
      record('dep_offer', 'B: broadcast setup', 'fail',
        `expected 4 contacts, got ${Object.keys(ids).length}: ${JSON.stringify(ids)}`);
      return;
    }
    const r = await sendDepOffer('leader1', 'leader1_cornwall', {
      role: 'Guitar',
      message: '[STRESS B] broadcast cornwall',
      mode: 'all',
      contact_ids: Object.values(ids),  // ignored for broadcast
    });
    if (r.status !== 200 && r.status !== 201) {
      record('dep_offer', 'B: broadcast send', 'fail',
        `status=${r.status} body=${r.text?.slice(0, 200)}`);
      return;
    }
    const { sent = 0, unresolved = 0, total = 0, filtered_out_of_range = 0, out_of_range_contacts = [] } = r.json || {};
    record('dep_offer', 'B: broadcast send', 'pass',
      `sent=${sent} filtered=${filtered_out_of_range} total=${total} unresolved=${unresolved} outOfRange=${JSON.stringify(out_of_range_contacts).slice(0, 300)}`);

    // dep4 has 500mi radius so Cornwall should land in their inbox
    const dep4Offers = await getReceivedOffers('dep4');
    const dep4Got = dep4Offers.some(o => o.gig_id === createdGigs.leader1_cornwall.id);
    record('dep_offer', 'B: dep4 received (in range)',
      dep4Got ? 'pass' : 'fail', `dep4 inbox has ${dep4Offers.length} offers total`);

    // dep3 is in St Ives with 15mi radius — that's actually CLOSE to the
    // Cornwall gig, so dep3 SHOULD receive it. dep1 (SW1A, 25mi) and dep2
    // (E1, 30mi) are the ones that should be filtered out for a Cornwall gig.
    const dep1Filtered = out_of_range_contacts.some(c => c.recipient_id === sessions.dep1.user.id);
    const dep2Filtered = out_of_range_contacts.some(c => c.recipient_id === sessions.dep2.user.id);
    record('dep_offer', 'B: dep1 filtered (SW1A vs Cornwall)',
      dep1Filtered ? 'pass' : 'fail', `dep1 in out_of_range list=${dep1Filtered}`);
    record('dep_offer', 'B: dep2 filtered (E1 vs Cornwall)',
      dep2Filtered ? 'pass' : 'fail', `dep2 in out_of_range list=${dep2Filtered}`);

    const dep3Offers = await getReceivedOffers('dep3');
    const dep3GotCornwall = dep3Offers.some(o => o.gig_id === createdGigs.leader1_cornwall.id);
    record('dep_offer', 'B: dep3 received Cornwall (St Ives is near)',
      dep3GotCornwall ? 'pass' : 'fail', `dep3 inbox has ${dep3Offers.length} offers; got cornwall=${dep3GotCornwall}`);

    // The out_of_range_contacts array should reflect filtering
    record('dep_offer', 'B: out_of_range payload present',
      Array.isArray(out_of_range_contacts) ? 'pass' : 'fail',
      `len=${out_of_range_contacts.length}`);
  } catch (e) {
    record('dep_offer', 'B: unexpected error', 'fail', String(e.stack || e));
  }
}

// Scenario C: decline path
async function scenarioDecline() {
  try {
    const contacts = await getContacts('leader2');
    const dep4C = contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS.dep4.email);
    if (!dep4C) {
      record('dep_offer', 'C: decline setup', 'fail', 'dep4 contact not found for leader2');
      return;
    }
    const sendR = await sendDepOffer('leader2', 'leader2_london', {
      role: 'Guitar',
      message: '[STRESS C] please decline',
      mode: 'pick',
      contact_ids: [dep4C.id],
    });
    if (sendR.status !== 200 && sendR.status !== 201) {
      record('dep_offer', 'C: decline send', 'fail',
        `status=${sendR.status} body=${sendR.text?.slice(0, 200)}`);
      return;
    }
    const target = await findLatestOffer('dep4', createdGigs.leader2_london.id, 'leader2');
    if (!target) {
      record('dep_offer', 'C: dep4 sees pending', 'fail', 'no offer in inbox');
      return;
    }
    const decR = await http('PATCH', `/api/offers/${target.id}`, {
      token: sessions.dep4.token, body: { status: 'declined' },
    });
    if (decR.status === 200) {
      record('dep_offer', 'C: dep4 declines', 'pass', `status=${decR.json?.status}`);
    } else {
      record('dep_offer', 'C: dep4 declines', 'fail',
        `status=${decR.status} body=${decR.text?.slice(0, 200)}`);
    }
    const sent = await getSentOffers('leader2');
    const mirror = sent.find(o => o.id === target.id);
    record('dep_offer', 'C: leader2 sees declined',
      mirror?.status === 'declined' ? 'pass' : 'fail', `mirror=${mirror?.status}`);
  } catch (e) {
    record('dep_offer', 'C: unexpected error', 'fail', String(e.stack || e));
  }
}

// Scenario D: sender withdraws pending offer
async function scenarioWithdraw() {
  try {
    const contacts = await getContacts('leader1');
    const dep2C = contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS.dep2.email);
    if (!dep2C) {
      record('dep_offer', 'D: withdraw setup', 'fail', 'dep2 contact not found');
      return;
    }
    const sendR = await sendDepOffer('leader1', 'leader1_manchester', {
      role: 'Guitar', message: '[STRESS D] to be withdrawn',
      mode: 'pick', contact_ids: [dep2C.id],
    });
    if ((sendR.json?.sent ?? 0) !== 1) {
      record('dep_offer', 'D: withdraw send', 'fail',
        `sent=${sendR.json?.sent} status=${sendR.status} body=${sendR.text?.slice(0, 200)}`);
      return;
    }
    const target = await findLatestOffer('dep2', createdGigs.leader1_manchester.id, 'leader1');
    if (!target) {
      record('dep_offer', 'D: locate offer', 'fail', 'not in dep2 inbox');
      return;
    }
    record('dep_offer', 'D: withdraw send', 'pass', `offerId=${target.id}`);
    const wR = await http('POST', `/api/offers/${target.id}/withdraw`, { token: sessions.leader1.token });
    if (wR.status === 200) {
      record('dep_offer', 'D: leader1 withdraws', 'pass', `response=${JSON.stringify(wR.json).slice(0, 200)}`);
    } else {
      record('dep_offer', 'D: leader1 withdraws', 'fail',
        `status=${wR.status} body=${wR.text?.slice(0, 200)}`);
    }
    const dep2Offers = await getReceivedOffers('dep2');
    const leftover = dep2Offers.find(o => o.id === target.id && o.status === 'pending');
    record('dep_offer', 'D: dep2 no longer sees as pending',
      !leftover ? 'pass' : 'fail',
      leftover ? `still pending!` : 'withdrawn correctly');
  } catch (e) {
    record('dep_offer', 'D: unexpected error', 'fail', String(e.stack || e));
  }
}

// Scenario E: security
async function scenarioSecurity() {
  try {
    const contacts = await getContacts('leader2');
    const dep4C = contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS.dep4.email);
    if (!dep4C) {
      record('dep_offer', 'E: security setup', 'fail', 'dep4 contact not found for leader2');
      return;
    }
    const sendR = await sendDepOffer('leader2', 'leader2_london', {
      role: 'Guitar', message: '[STRESS E] hijack target',
      mode: 'pick', contact_ids: [dep4C.id],
    });
    const target = await findLatestOffer('dep4', createdGigs.leader2_london.id, 'leader2');
    if (!target) {
      record('dep_offer', 'E: setup', 'fail',
        `no offer; sendR=${JSON.stringify(sendR.json).slice(0, 200)}`);
      return;
    }

    // E1: dep2 (not the recipient) tries to accept
    const hijack = await http('PATCH', `/api/offers/${target.id}`, {
      token: sessions.dep2.token, body: { status: 'accepted' },
    });
    if (hijack.status === 403 || hijack.status === 404) {
      record('dep_offer', 'E1: non-recipient cannot accept', 'pass', `blocked ${hijack.status}`);
    } else {
      record('dep_offer', 'E1: non-recipient cannot accept', 'fail',
        `status=${hijack.status} body=${hijack.text?.slice(0, 200)}`);
    }

    // E2: dep2 tries to read a gig thread they have no stake in
    const cornwallGigId = createdGigs.leader1_cornwall?.id;
    if (cornwallGigId) {
      // dep2 was filtered out of range, so no offer → no access
      const tR = await http('GET', `/api/chat/gig/${cornwallGigId}`, { token: sessions.dep2.token });
      if (tR.status === 403 || tR.status === 404) {
        record('dep_offer', 'E2: unrelated user blocked from gig thread', 'pass', `blocked ${tR.status}`);
      } else {
        record('dep_offer', 'E2: unrelated user blocked from gig thread', 'fail',
          `status=${tR.status} body=${tR.text?.slice(0, 200)}`);
      }
    }

    // E3: dep3 tries to view offer details they're not party to
    const peek = await http('GET', `/api/offers/${target.id}/details`, { token: sessions.dep3.token });
    if (peek.status === 403 || peek.status === 404) {
      record('dep_offer', 'E3: non-party cannot view offer details', 'pass', `blocked ${peek.status}`);
    } else {
      record('dep_offer', 'E3: non-party cannot view offer details', 'fail',
        `status=${peek.status} body=${peek.text?.slice(0, 200)}`);
    }

    // E4: unauthenticated request
    const unauth = await http('GET', '/api/offers');
    record('dep_offer', 'E4: unauthenticated blocked',
      [401, 403].includes(unauth.status) ? 'pass' : 'fail', `status=${unauth.status}`);

    // E5: leader1 (not recipient) tries to accept someone else's offer
    const leaderTries = await http('PATCH', `/api/offers/${target.id}`, {
      token: sessions.leader1.token, body: { status: 'accepted' },
    });
    record('dep_offer', 'E5: sender cannot accept their own offer',
      [403, 404].includes(leaderTries.status) ? 'pass' : 'fail',
      `status=${leaderTries.status}`);

    // cleanup: withdraw so dep4 doesn't have dangling pending offer
    await http('POST', `/api/offers/${target.id}/withdraw`, { token: sessions.leader2.token });

    // E6: non-sender tries to withdraw someone else's offer
    const newSend = await sendDepOffer('leader2', 'leader2_london', {
      role: 'Guitar', message: '[STRESS E6]', mode: 'pick', contact_ids: [dep4C.id],
    });
    const target2 = await findLatestOffer('dep4', createdGigs.leader2_london.id, 'leader2');
    if (target2) {
      const badWithdraw = await http('POST', `/api/offers/${target2.id}/withdraw`, { token: sessions.leader1.token });
      record('dep_offer', 'E6: non-sender cannot withdraw',
        [403, 404].includes(badWithdraw.status) ? 'pass' : 'fail',
        `status=${badWithdraw.status}`);
      await http('POST', `/api/offers/${target2.id}/withdraw`, { token: sessions.leader2.token });
    }
  } catch (e) {
    record('dep_offer', 'E: unexpected error', 'fail', String(e.stack || e));
  }
}

// Scenario F: concurrency - 5 parallel offers to same dep on same gig
async function scenarioConcurrency() {
  try {
    const contacts = await getContacts('leader1');
    const dep1C = contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS.dep1.email);
    if (!dep1C) {
      record('dep_offer', 'F: concurrency setup', 'fail', 'dep1 contact missing');
      return;
    }
    const before = await getReceivedOffers('dep1');
    const beforeCount = before.filter(o => o.gig_id === createdGigs.leader1_manchester.id).length;

    const promises = Array.from({ length: 5 }, (_, i) =>
      sendDepOffer('leader1', 'leader1_manchester', {
        role: 'Guitar',
        message: `[STRESS F concurrent ${i}]`,
        mode: 'pick',
        contact_ids: [dep1C.id],
      })
    );
    const results_ = await Promise.all(promises);
    const statuses = results_.map(r => r.status);
    const sentCounts = results_.map(r => r.json?.sent);
    const allOk = statuses.every(s => s === 200 || s === 201);
    record('dep_offer', 'F: parallel sends no crash',
      allOk ? 'pass' : 'fail',
      `statuses=${JSON.stringify(statuses)} sentCounts=${JSON.stringify(sentCounts)}`);

    const after = await getReceivedOffers('dep1');
    const afterCount = after.filter(o => o.gig_id === createdGigs.leader1_manchester.id).length;
    record('dep_offer', 'F: dep1 inbox updated',
      afterCount > beforeCount ? 'pass' : 'fail',
      `beforeCount=${beforeCount} afterCount=${afterCount} delta=${afterCount - beforeCount}`);

    // Document whether the system allows duplicates or dedupes
    const delta = afterCount - beforeCount;
    if (delta >= 5) {
      record('dep_offer', 'F: duplicates allowed', 'pass',
        `5 sends created ${delta} offers — no server-side dedupe (document for product review)`);
    } else if (delta >= 1 && delta < 5) {
      record('dep_offer', 'F: partial dedupe detected', 'pass',
        `5 sends created ${delta} offers — partial dedupe`);
    } else {
      record('dep_offer', 'F: delta unexpected', 'fail', `delta=${delta}`);
    }

    // cleanup: withdraw each pending offer on this gig from dep1
    const toClean = after.filter(o =>
      o.gig_id === createdGigs.leader1_manchester.id && o.status === 'pending'
    );
    for (const o of toClean) {
      await http('POST', `/api/offers/${o.id}/withdraw`, { token: sessions.leader1.token });
    }
  } catch (e) {
    record('dep_offer', 'F: unexpected error', 'fail', String(e.stack || e));
  }
}

// Scenario G: input validation
async function scenarioValidation() {
  const gigId = createdGigs.leader1_london_10d?.id;
  const cases = [
    { name: 'G1: no gig_id',      body: { role: 'Guitar', mode: 'pick', contact_ids: [] }, expect: [400] },
    { name: 'G2: invalid mode',   body: { gig_id: gigId, role: 'Guitar', mode: 'bogus', contact_ids: [] }, expect: [400] },
    { name: 'G3: empty contacts', body: { gig_id: gigId, role: 'Guitar', mode: 'pick', contact_ids: [] }, expect: [400] },
    { name: 'G4: bogus gig_id',   body: { gig_id: '00000000-0000-0000-0000-000000000000', role: 'Guitar', mode: 'pick', contact_ids: ['00000000-0000-0000-0000-000000000000'] }, expect: [404, 400] },
    { name: 'G5: gig from other user', body: { gig_id: createdGigs.leader2_london?.id, role: 'Guitar', mode: 'pick', contact_ids: ['00000000-0000-0000-0000-000000000000'] }, expect: [404, 403] },
  ];
  for (const c of cases) {
    const r = await http('POST', '/api/dep-offers', { token: sessions.leader1.token, body: c.body });
    if (c.expect.includes(r.status)) {
      record('dep_offer', c.name, 'pass', `status=${r.status}`);
    } else {
      record('dep_offer', c.name, 'fail',
        `status=${r.status} expected=${c.expect.join('/')} body=${r.text?.slice(0, 200)}`);
    }
  }
}

// Scenario H: message size cap (chat route uses 40kB cap)
async function scenarioMessageCap() {
  try {
    const gigId = createdGigs.leader1_london_10d.id;
    const t = await http('GET', `/api/chat/gig/${gigId}`, { token: sessions.leader1.token });
    if (t.status !== 200 || !t.json?.thread?.id) {
      record('dep_offer', 'H: thread lookup', 'fail', `status=${t.status}`);
      return;
    }
    // 50kB message: expect 413
    const bigMsg = 'x'.repeat(50 * 1024);
    const bigR = await http('POST', `/api/chat/threads/${t.json.thread.id}/messages`, {
      token: sessions.leader1.token, body: { content: bigMsg },
    });
    record('dep_offer', 'H: 50kB message rejected with 413',
      bigR.status === 413 ? 'pass' : 'fail',
      `status=${bigR.status} body=${bigR.text?.slice(0, 200)}`);

    // empty message: expect 400
    const emptyR = await http('POST', `/api/chat/threads/${t.json.thread.id}/messages`, {
      token: sessions.leader1.token, body: { content: '   ' },
    });
    record('dep_offer', 'H: empty message rejected',
      emptyR.status === 400 ? 'pass' : 'fail',
      `status=${emptyR.status}`);

    // 30kB message: expect 200 (under cap)
    const okMsg = 'y'.repeat(30 * 1024);
    const okR = await http('POST', `/api/chat/threads/${t.json.thread.id}/messages`, {
      token: sessions.leader1.token, body: { content: okMsg },
    });
    record('dep_offer', 'H: 30kB message accepted',
      okR.status === 200 ? 'pass' : 'fail', `status=${okR.status}`);
  } catch (e) {
    record('dep_offer', 'H: unexpected error', 'fail', String(e.stack || e));
  }
}

// ── Phase 5: breadth sweep ───────────────────────────────────────────────────
async function phase5Breadth() {
  const token = sessions.leader1.token;
  const otherToken = sessions.dep1.token;

  const checks = [
    { name: 'GET /auth/me',          path: '/auth/me',           expect: 200 },
    { name: 'GET /api/gigs',         path: '/api/gigs',          expect: 200 },
    { name: 'GET /api/contacts',     path: '/api/contacts',      expect: 200 },
    { name: 'GET /api/chat/threads', path: '/api/chat/threads',  expect: 200 },
    { name: 'GET /api/offers',       path: '/api/offers',        expect: 200 },
    { name: 'GET /api/offers/sent',  path: '/api/offers/sent',   expect: 200 },
    { name: 'GET /api/user/profile', path: '/api/user/profile',  expect: 200 },
    { name: 'GET /api/expenses',     path: '/api/expenses',      expect: [200, 404] },
    { name: 'GET /api/invoices',     path: '/api/invoices',      expect: [200, 404] },
    { name: 'GET /api/notifications',path: '/api/notifications', expect: [200, 404] },
    { name: 'GET /api/stats',        path: '/api/stats',         expect: [200, 404] },
    { name: 'GET /api/songs',        path: '/api/songs',         expect: [200, 404] },
    { name: 'GET /api/documents',    path: '/api/documents',     expect: [200, 404] },
    { name: 'GET /api/blocked-dates',path: '/api/blocked-dates', expect: [200, 404] },
    { name: 'GET /api/receipts',     path: '/api/receipts',      expect: [200, 404] },
    { name: 'GET /api/invoice-clients', path: '/api/invoice-clients', expect: [200, 404] },
  ];
  for (const c of checks) {
    const r = await http('GET', c.path, { token });
    const expectArr = Array.isArray(c.expect) ? c.expect : [c.expect];
    const status = expectArr.includes(r.status) ? 'pass' : 'fail';
    const count = Array.isArray(r.json) ? r.json.length
                : (r.json?.length ?? r.json?.gigs?.length ?? r.json?.contacts?.length
                   ?? r.json?.expenses?.length ?? r.json?.invoices?.length ?? '?');
    record('breadth', c.name, status, `status=${r.status} count=${count}`);
  }

  // specific gig fetch
  const someGigId = createdGigs.leader1_london_10d?.id;
  if (someGigId) {
    const g = await http('GET', `/api/gigs/${someGigId}`, { token });
    record('breadth', 'GET /api/gigs/:id', g.status === 200 ? 'pass' : 'fail', `status=${g.status}`);

    // dep1 tries to access leader1's gig via /api/gigs/:id
    const xg = await http('GET', `/api/gigs/${someGigId}`, { token: otherToken });
    record('breadth', 'cross-user gig fetch blocked',
      [403, 404].includes(xg.status) ? 'pass' : 'fail',
      `dep1 got ${xg.status} for leader1's gig`);
  }

  // search users (Find Musicians). /api/discover requires a mode parameter,
  // not just a query string. Use name mode to match existing frontend usage.
  const search = await http('GET', '/api/discover?mode=name&q=STRESS', { token });
  record('breadth', 'GET /api/discover?mode=name&q=STRESS',
    [200].includes(search.status) ? 'pass' : 'fail',
    `status=${search.status} resultCount=${search.json?.total ?? search.json?.results?.length ?? '?'}`);
  // Missing-mode 400 is a required behavior — assert it explicitly.
  const searchNoMode = await http('GET', '/api/discover?q=STRESS', { token });
  record('breadth', '/api/discover without mode rejected',
    searchNoMode.status === 400 ? 'pass' : 'fail',
    `status=${searchNoMode.status}`);

  // unauthenticated
  const unauthGigs = await http('GET', '/api/gigs');
  record('breadth', 'unauth GET /api/gigs',
    [401, 403].includes(unauthGigs.status) ? 'pass' : 'fail', `status=${unauthGigs.status}`);

  // invalid postcode
  const bad = await http('PATCH', '/api/user/profile', {
    token, body: { home_postcode: 'NOT A POSTCODE AT ALL' },
  });
  record('breadth', 'bad postcode rejected',
    bad.status === 400 ? 'pass' : 'fail',
    `status=${bad.status} body=${bad.text?.slice(0, 200)}`);

  // over-range radius: documented behaviour is to clamp to 1..500 silently.
  const bigR = await http('PATCH', '/api/user/profile', {
    token, body: { travel_radius_miles: 9999 },
  });
  const saved = bigR.json?.travel_radius_miles;
  if (bigR.status === 200 && saved === 500) {
    record('breadth', 'out-of-range radius clamped to 500', 'pass',
      `accepts 9999 and clamps to 500 (by design per code comment)`);
  } else {
    record('breadth', 'out-of-range radius clamped to 500', 'fail',
      `status=${bigR.status} saved=${saved}`);
  }
  // reset
  await http('PATCH', '/api/user/profile', {
    token, body: { travel_radius_miles: ACCOUNTS.leader1.travel_radius_miles },
  });

  // past-dated gig: probably accepted (no past-date guard). Just document.
  const pastGig = await http('POST', '/api/gigs', {
    token,
    body: {
      band_name: '[STRESS] past gig', venue_name: 'past', date: '2020-01-01',
      start_time: '20:00', end_time: '23:00', fee: 100,
    },
  });
  if (pastGig.status === 200 || pastGig.status === 201) {
    record('breadth', 'past-dated gig accepted (no guard)', 'pass',
      `status=${pastGig.status} — potential product question: should this be rejected?`);
    // cleanup
    const pid = pastGig.json?.id;
    if (pid) await http('DELETE', `/api/gigs/${pid}`, { token });
  } else if (pastGig.status === 400) {
    record('breadth', 'past-dated gig rejected', 'pass', `status=400`);
  } else {
    record('breadth', 'past-dated gig behaviour', 'fail', `unexpected status=${pastGig.status}`);
  }

  // missing required fields on gig
  const badGig = await http('POST', '/api/gigs', { token, body: { notes: 'nothing else' } });
  record('breadth', 'gig missing required fields rejected',
    badGig.status === 400 ? 'pass' : 'fail',
    `status=${badGig.status} body=${badGig.text?.slice(0, 200)}`);

  // gig PATCH by non-owner
  if (someGigId) {
    const editAttempt = await http('PUT', `/api/gigs/${someGigId}`, {
      token: otherToken, body: { band_name: '[HIJACK]' },
    });
    record('breadth', 'cross-user gig edit blocked',
      [403, 404].includes(editAttempt.status) ? 'pass' : 'fail',
      `status=${editAttempt.status}`);
  }

  // thread send to a thread user is not a participant in
  const threads = await http('GET', '/api/chat/threads', { token: sessions.leader1.token });
  const someThreadId = Array.isArray(threads.json) ? threads.json[0]?.id : threads.json?.threads?.[0]?.id;
  if (someThreadId) {
    const hijackMsg = await http('POST', `/api/chat/threads/${someThreadId}/messages`, {
      token: sessions.dep3.token, body: { content: '[hijack attempt]' },
    });
    record('breadth', 'cross-user thread message blocked',
      [403, 404].includes(hijackMsg.status) ? 'pass' : 'fail',
      `status=${hijackMsg.status}`);
  }
}

// ── Scenario I: Nudge cap + dedupe + block symmetry ─────────────────────────
// Flow:
//   1. leader2 sends dep1 a fresh offer for leader2_london (creates row).
//   2. Re-POST the same dep-offer via /api/dep-offers. Server must NOT create
//      a duplicate; response shows the contact in `already_sent`.
//   3. POST /api/offers/:id/nudge twice — both succeed, counter goes 0→1→2.
//   4. Third nudge rejected with 409 "No nudges left".
//   5. Cleanup: withdraw the offer so downstream runs start fresh.
//   6. Block symmetry: dep1 blocks leader2. leader2 re-sends; recipient count
//      stays at zero (silent drop). Nudge attempts on the withdrawn offer
//      return 404 (offer not pending) — can't exercise block-on-nudge cleanly
//      after withdraw, so we stage a separate short-lived offer instead.
async function scenarioNudgeCap() {
  try {
    // Fresh offer round: pick leader2 + dep1 on leader2_london.
    const l2contacts = await getContacts('leader2');
    const dep1Contact = l2contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS.dep1.email);
    if (!dep1Contact) {
      record('dep_offer', 'I: setup: leader2→dep1 contact missing', 'fail',
        `leader2 contacts=${l2contacts.length}`);
      return;
    }

    // Withdraw any prior pending offer first so we start clean.
    const prior = await getSentOffers('leader2');
    for (const o of prior) {
      if (
        o.gig_id === createdGigs.leader2_london.id &&
        o.recipient_id === sessions.dep1.user.id &&
        o.status === 'pending'
      ) {
        await http('POST', `/api/offers/${o.id}/withdraw`, { token: sessions.leader2.token });
      }
    }

    // Step 1: fresh send
    const firstSend = await sendDepOffer('leader2', 'leader2_london', {
      role: 'Guitar',
      message: '[STRESS I] nudge-cap fresh',
      mode: 'pick',
      contact_ids: [dep1Contact.id],
    });
    if (firstSend.status !== 200 || (firstSend.json?.sent || 0) < 1) {
      record('dep_offer', 'I: fresh send succeeded', 'fail',
        `status=${firstSend.status} sent=${firstSend.json?.sent} body=${firstSend.text?.slice(0, 200)}`);
      return;
    }
    record('dep_offer', 'I: fresh send succeeded', 'pass',
      `sent=${firstSend.json.sent}`);

    const offer = await findLatestOffer('dep1', createdGigs.leader2_london.id, 'leader2');
    if (!offer) {
      record('dep_offer', 'I: offer landed in dep1 inbox', 'fail', 'no matching offer found');
      return;
    }
    record('dep_offer', 'I: offer landed in dep1 inbox', 'pass', `offerId=${offer.id}`);

    // Step 2: duplicate send → should not create a new row, should land in already_sent
    const dupe = await sendDepOffer('leader2', 'leader2_london', {
      role: 'Guitar',
      message: '[STRESS I] nudge-cap dupe',
      mode: 'pick',
      contact_ids: [dep1Contact.id],
    });
    const alreadySent = dupe.json?.already_sent || [];
    const isAlreadySent = alreadySent.some(a => a.recipient_id === sessions.dep1.user.id);
    record('dep_offer', 'I: duplicate send skipped creation',
      (dupe.json?.sent || 0) === 0 && isAlreadySent ? 'pass' : 'fail',
      `sent=${dupe.json?.sent} already_sent=${JSON.stringify(alreadySent).slice(0, 200)}`);

    // Confirm no new offer row landed in dep1's inbox for this gig/sender.
    const dep1Inbox = await getReceivedOffers('dep1');
    const matchingRows = dep1Inbox.filter(o =>
      o.gig_id === createdGigs.leader2_london.id &&
      o.sender_id === sessions.leader2.user.id &&
      o.status === 'pending'
    );
    record('dep_offer', 'I: only one pending offer for (gig, sender, recipient)',
      matchingRows.length === 1 ? 'pass' : 'fail',
      `matching rows=${matchingRows.length}`);

    // Step 3: first nudge
    const nudge1 = await http('POST', `/api/offers/${offer.id}/nudge`, { token: sessions.leader2.token });
    record('dep_offer', 'I: nudge #1 accepted',
      nudge1.status === 200 && nudge1.json?.nudge_count === 1 && nudge1.json?.nudges_remaining === 1 ? 'pass' : 'fail',
      `status=${nudge1.status} body=${JSON.stringify(nudge1.json)}`);

    // Step 4: second nudge
    const nudge2 = await http('POST', `/api/offers/${offer.id}/nudge`, { token: sessions.leader2.token });
    record('dep_offer', 'I: nudge #2 accepted',
      nudge2.status === 200 && nudge2.json?.nudge_count === 2 && nudge2.json?.nudges_remaining === 0 ? 'pass' : 'fail',
      `status=${nudge2.status} body=${JSON.stringify(nudge2.json)}`);

    // Step 5: third nudge rejected
    const nudge3 = await http('POST', `/api/offers/${offer.id}/nudge`, { token: sessions.leader2.token });
    record('dep_offer', 'I: nudge #3 rejected with 409',
      nudge3.status === 409 ? 'pass' : 'fail',
      `status=${nudge3.status} body=${JSON.stringify(nudge3.json)}`);

    // Step 6: non-sender cannot nudge
    const crossNudge = await http('POST', `/api/offers/${offer.id}/nudge`, { token: sessions.leader1.token });
    record('dep_offer', 'I: non-sender nudge blocked',
      crossNudge.status === 404 ? 'pass' : 'fail',
      `status=${crossNudge.status}`);

    // Step 7: block symmetry. dep2 blocks leader2, leader2 sends, offer should
    // silently drop (recipient count on leader2_london for dep2 stays 0).
    const dep2Contact = l2contacts.find(c => (c.email || '').toLowerCase() === ACCOUNTS.dep2.email);
    if (dep2Contact) {
      // dep2 blocks leader2
      const block = await http('POST', '/api/user-blocks', {
        token: sessions.dep2.token,
        body: { blocked_id: sessions.leader2.user.id },
      });
      record('dep_offer', 'I: dep2 blocks leader2',
        block.status === 200 ? 'pass' : 'fail',
        `status=${block.status}`);

      // leader2 tries to send to dep2 — should drop silently (unresolved++)
      const blockedSend = await sendDepOffer('leader2', 'leader2_london', {
        role: 'Guitar',
        message: '[STRESS I] block-test',
        mode: 'pick',
        contact_ids: [dep2Contact.id],
      });
      record('dep_offer', 'I: blocked send dropped silently',
        blockedSend.status === 200 && blockedSend.json?.sent === 0 && blockedSend.json?.unresolved >= 1 ? 'pass' : 'fail',
        `sent=${blockedSend.json?.sent} unresolved=${blockedSend.json?.unresolved} already_sent=${JSON.stringify(blockedSend.json?.already_sent)}`);

      // cleanup: remove block so future runs are fresh
      await http('DELETE', `/api/user-blocks/${sessions.leader2.user.id}`, { token: sessions.dep2.token });
    }

    // Cleanup: withdraw the nudged offer so next run is clean
    await http('POST', `/api/offers/${offer.id}/withdraw`, { token: sessions.leader2.token });
  } catch (e) {
    record('dep_offer', 'I: unexpected error', 'fail', String(e.stack || e));
  }
}

// ── Scenario J: Marketplace post + apply + pick ─────────────────────────────
async function scenarioMarketplace() {
  try {
    // leader1 posts a marketplace gig
    const post = await http('POST', '/api/marketplace', {
      token: sessions.leader1.token,
      body: {
        title: '[STRESS J] weekend wedding — guitar needed',
        description: 'Sub needed for a 2pm ceremony set',
        venue_name: 'Stress Test Hotel',
        venue_postcode: 'SW1A 1AA',
        gig_date: '2027-06-01',
        start_time: '14:00',
        end_time: '18:00',
        instruments: ['guitar'],
        fee_pence: 20000,
        is_free: false,
        mode: 'pick',
      },
    });
    if (post.status !== 200 && post.status !== 201) {
      record('marketplace', 'J: create post', 'fail',
        `status=${post.status} body=${post.text?.slice(0, 300)}`);
      return;
    }
    const postId = post.json?.id || post.json?.post?.id || post.json?.marketplace_gig?.id;
    if (!postId) {
      record('marketplace', 'J: post id captured', 'fail', `body=${JSON.stringify(post.json).slice(0, 300)}`);
      return;
    }
    record('marketplace', 'J: create post', 'pass', `postId=${postId}`);

    // dep1 browses. Note: /api/marketplace applies instrument overlap + fee
    // floor filters based on the CALLER's profile, so whether dep1 sees the
    // post depends on dep1 having "Guitar" (or the post having a matching
    // instrument casing) and the post fee clearing dep1's min_fee. Pass extra
    // query params so the test is deterministic rather than user-profile-dependent.
    const browse = await http('GET', '/api/marketplace?instrument=guitar&instrument=Guitar&min_fee_pence=0', {
      token: sessions.dep1.token,
    });
    const visible = Array.isArray(browse.json) ? browse.json : browse.json?.gigs || browse.json?.posts || [];
    const visibleIds = visible.map(g => String(g.id));
    record('marketplace', 'J: dep1 sees the post',
      visibleIds.includes(String(postId)) ? 'pass' : 'fail',
      `visible=${visibleIds.length} includes=${visibleIds.includes(String(postId))} ids=${visibleIds.slice(0, 5).join(',')}`);

    const apply = await http('POST', `/api/marketplace/${postId}/apply`, {
      token: sessions.dep1.token,
      body: { note: '[STRESS J] happy to cover' },
    });
    record('marketplace', 'J: dep1 applies',
      apply.status === 200 && (apply.json?.ok || apply.json?.status === 'pending') ? 'pass' : 'fail',
      `status=${apply.status} body=${JSON.stringify(apply.json).slice(0, 200)}`);

    // leader1 sees the applicant. Server returns { applicants: [...] } where each
    // applicant row uses `user_id` for the dep's user id (aliased from
    // ma.applicant_user_id in the SQL).
    const applicants = await http('GET', `/api/marketplace/${postId}/applicants`, {
      token: sessions.leader1.token,
    });
    const appList = Array.isArray(applicants.json)
      ? applicants.json
      : applicants.json?.applicants || applicants.json?.applications || [];
    const hasDep1 = appList.some(a => (a.user_id || a.applicant_user_id || a.id) === sessions.dep1.user.id);
    record('marketplace', 'J: leader1 sees dep1 in applicants',
      hasDep1 ? 'pass' : 'fail',
      `applicants=${appList.length} hasDep1=${hasDep1} shape=${JSON.stringify(appList[0] || {}).slice(0, 200)}`);

    // Non-poster cannot see applicant list
    const unauthApps = await http('GET', `/api/marketplace/${postId}/applicants`, {
      token: sessions.dep2.token,
    });
    record('marketplace', 'J: non-poster blocked from applicant list',
      [403, 404].includes(unauthApps.status) ? 'pass' : 'fail',
      `status=${unauthApps.status}`);

    // leader1 picks dep1
    const pick = await http('POST', `/api/marketplace/${postId}/pick`, {
      token: sessions.leader1.token,
      body: { applicant_user_id: sessions.dep1.user.id },
    });
    record('marketplace', 'J: leader1 picks dep1',
      pick.status === 200 ? 'pass' : 'fail',
      `status=${pick.status} body=${JSON.stringify(pick.json).slice(0, 200)}`);

    // dep1 can see their application status flipped. Server returns
    // { applications: [...] } where each row has `id` (the post id) and
    // `application_status` (accepted/pending/rejected).
    const myApps = await http('GET', '/api/marketplace/applications/mine', { token: sessions.dep1.token });
    const myList = Array.isArray(myApps.json) ? myApps.json : myApps.json?.applications || [];
    const mine = myList.find(a => String(a.id) === String(postId) || String(a.marketplace_gig_id) === String(postId));
    const mineStatus = mine?.application_status || mine?.status;
    record('marketplace', 'J: dep1 sees application accepted',
      mine && (mineStatus === 'accepted' || mineStatus === 'picked') ? 'pass' : 'fail',
      `mine=${mine ? JSON.stringify(mine).slice(0, 200) : 'not-found'} status=${mineStatus}`);

    // Own-post apply guard
    const selfApply = await http('POST', `/api/marketplace/${postId}/apply`, {
      token: sessions.leader1.token,
    });
    record('marketplace', 'J: cannot apply to own post',
      [400, 403].includes(selfApply.status) ? 'pass' : 'fail',
      `status=${selfApply.status}`);
  } catch (e) {
    record('marketplace', 'J: unexpected error', 'fail', String(e.stack || e));
  }
}

// ── Scenario K: Invoice end-to-end ──────────────────────────────────────────
async function scenarioInvoice() {
  try {
    const gigId = createdGigs.leader1_london_10d?.id;
    if (!gigId) {
      record('invoice', 'K: setup: missing leader1 gig', 'fail', 'no gigId');
      return;
    }
    const create = await http('POST', '/api/invoices', {
      token: sessions.leader1.token,
      body: {
        gig_id: gigId,
        band_name: '[STRESS K] Band',
        amount: 450,
        status: 'draft',
        invoice_number: `STRESS-K-${Date.now()}`,
        payment_terms: 'Net 30',
        due_date: '2027-07-01',
        venue_name: 'Stress Test Venue',
        description: '[STRESS K] gig fee',
        recipient_email: 'client@stress.test',
      },
    });
    const invoiceId = create.json?.id || create.json?.invoice?.id;
    if (create.status !== 200 || !invoiceId) {
      record('invoice', 'K: create invoice', 'fail',
        `status=${create.status} body=${create.text?.slice(0, 300)}`);
      return;
    }
    record('invoice', 'K: create invoice', 'pass', `invoiceId=${invoiceId}`);

    // PDF fetch: must start with %PDF magic bytes
    const pdfUrl = `${BASE}/api/invoices/${invoiceId}/pdf`;
    const pdfRes = await fetch(pdfUrl, {
      headers: { cookie: `sessionToken=${sessions.leader1.token}` },
    });
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    const magic = pdfBuf.slice(0, 4).toString('utf8');
    record('invoice', 'K: PDF download returns %PDF',
      pdfRes.status === 200 && magic === '%PDF' ? 'pass' : 'fail',
      `status=${pdfRes.status} size=${pdfBuf.length} magic=${magic}`);

    // Cross-user PDF fetch must 404
    const pdfCross = await fetch(pdfUrl, {
      headers: { cookie: `sessionToken=${sessions.dep1.token}` },
    });
    record('invoice', 'K: cross-user PDF fetch blocked',
      [403, 404].includes(pdfCross.status) ? 'pass' : 'fail',
      `status=${pdfCross.status}`);

    // Chase endpoint
    const chase = await http('POST', `/api/invoices/${invoiceId}/chase`, { token: sessions.leader1.token });
    record('invoice', 'K: chase endpoint responds',
      [200, 201].includes(chase.status) ? 'pass' : 'fail',
      `status=${chase.status} body=${chase.text?.slice(0, 200)}`);

    // Mark paid via PATCH
    const paid = await http('PATCH', `/api/invoices/${invoiceId}`, {
      token: sessions.leader1.token,
      body: { status: 'paid' },
    });
    record('invoice', 'K: mark paid via PATCH',
      paid.status === 200 ? 'pass' : 'fail',
      `status=${paid.status} body=${paid.text?.slice(0, 200)}`);

    // Verify flipped
    const fetched = await http('GET', `/api/invoices/${invoiceId}`, { token: sessions.leader1.token });
    const fetchedStatus = fetched.json?.status || fetched.json?.invoice?.status;
    record('invoice', 'K: status persisted as paid',
      fetched.status === 200 && fetchedStatus === 'paid' ? 'pass' : 'fail',
      `status=${fetched.status} invoiceStatus=${fetchedStatus}`);

    // Cross-user GET blocked
    const crossGet = await http('GET', `/api/invoices/${invoiceId}`, { token: sessions.dep2.token });
    record('invoice', 'K: cross-user GET blocked',
      [403, 404].includes(crossGet.status) ? 'pass' : 'fail',
      `status=${crossGet.status}`);
  } catch (e) {
    record('invoice', 'K: unexpected error', 'fail', String(e.stack || e));
  }
}

// ── Scenario L: Expenses CRUD ───────────────────────────────────────────────
async function scenarioExpenses() {
  try {
    const create = await http('POST', '/api/expenses', {
      token: sessions.leader1.token,
      body: {
        amount: 42.5,
        description: '[STRESS L] parking at the venue',
        date: '2026-04-20',
        category: 'Travel',
      },
    });
    const expenseId = create.json?.expense?.id || create.json?.id;
    record('expense', 'L: create expense',
      create.status === 200 && expenseId ? 'pass' : 'fail',
      `status=${create.status} body=${create.text?.slice(0, 200)}`);
    if (!expenseId) return;

    // List and confirm present
    const list = await http('GET', '/api/expenses', { token: sessions.leader1.token });
    const arr = Array.isArray(list.json) ? list.json : list.json?.expenses || [];
    record('expense', 'L: list includes created expense',
      arr.some(e => e.id === expenseId) ? 'pass' : 'fail',
      `count=${arr.length}`);

    // PATCH
    const patch = await http('PATCH', `/api/expenses/${expenseId}`, {
      token: sessions.leader1.token,
      body: { amount: 50, category: 'Travel' },
    });
    record('expense', 'L: patch expense',
      patch.status === 200 ? 'pass' : 'fail',
      `status=${patch.status}`);

    // Cross-user DELETE blocked
    const crossDelete = await http('DELETE', `/api/expenses/${expenseId}`, { token: sessions.dep2.token });
    record('expense', 'L: cross-user delete blocked',
      [403, 404].includes(crossDelete.status) ? 'pass' : 'fail',
      `status=${crossDelete.status}`);

    // Confirm still there
    const listAfter = await http('GET', '/api/expenses', { token: sessions.leader1.token });
    const arrAfter = Array.isArray(listAfter.json) ? listAfter.json : listAfter.json?.expenses || [];
    record('expense', 'L: expense survived cross-user delete',
      arrAfter.some(e => e.id === expenseId) ? 'pass' : 'fail',
      `count=${arrAfter.length}`);

    // Owner delete works
    const del = await http('DELETE', `/api/expenses/${expenseId}`, { token: sessions.leader1.token });
    record('expense', 'L: owner delete works',
      [200, 204].includes(del.status) ? 'pass' : 'fail',
      `status=${del.status}`);

    // Validation: oversize description
    const bad = await http('POST', '/api/expenses', {
      token: sessions.leader1.token,
      body: {
        amount: 1,
        description: 'x'.repeat(5000),
        date: '2026-04-20',
      },
    });
    record('expense', 'L: oversize description rejected',
      bad.status === 400 ? 'pass' : 'fail',
      `status=${bad.status}`);
  } catch (e) {
    record('expense', 'L: unexpected error', 'fail', String(e.stack || e));
  }
}

// ── Scenario M: AI endpoints (Haiku) ────────────────────────────────────────
// One call per endpoint, lightweight inputs. Guards against 5xx/silent
// breakage after changes to lib/ai.js or Haiku availability.
async function scenarioAI() {
  const probes = [
    {
      name: 'M: /ai/extract-gig',
      path: '/api/ai/extract-gig',
      body: { text: 'Booking confirmed for Saturday 12 June 2027 at The Royal Arms, London. Load-in 6pm, set at 8pm. Fee £300.' },
    },
    {
      name: 'M: /ai/draft-dep-reply',
      path: '/api/ai/draft-dep-reply',
      body: { offerText: 'Can you cover my wedding gig on 15 Aug? £250.', gigDate: '2027-08-15' },
    },
    {
      name: 'M: /ai/generate-setlist',
      path: '/api/ai/generate-setlist',
      body: { durationMinutes: 90, venueType: 'pub', crowd: 'mixed age 30-60', mood: 'upbeat classic rock' },
      // Returns 400 "Add songs to your Repertoire first." when the test account
      // has no songs — expected for a clean [STRESS] account. 200 also acceptable
      // if a prior run seeded songs.
      accept: [200, 400],
    },
    {
      name: 'M: /ai/draft-invoice-chase',
      path: '/api/ai/draft-invoice-chase',
      body: {},  // will 4xx without invoiceId — captured as status check
      accept: [400, 404],
    },
    {
      name: 'M: /ai/generate-bio',
      path: '/api/ai/generate-bio',
      body: { facts: 'Gareth is a Cardiff-based session guitarist with 20 years of experience. Plays wedding bands and jazz clubs.', style: 'warm and professional' },
    },
    {
      name: 'M: /ai/sanity-check',
      path: '/api/ai/sanity-check',
      body: {
        date: '2027-06-12',
        start_time: '20:00',
        finish_time: '23:00',
        venue_address: 'The Royal Arms, London',
        band_name: 'Stress Test Band',
      },
    },
    {
      name: 'M: /ai/normalize-chordpro',
      path: '/api/ai/normalize-chordpro',
      body: { text: "[C]Hello [G]darkness my old [Am]friend\n[F]I've come to [C]talk with you [G]again" },
    },
  ];

  for (const p of probes) {
    try {
      const r = await http('POST', p.path, { token: sessions.leader1.token, body: p.body });
      const accept = p.accept || [200];
      record('ai', p.name,
        accept.includes(r.status) ? 'pass' : 'fail',
        `status=${r.status} bodySize=${r.text?.length || 0}`);
    } catch (e) {
      record('ai', p.name, 'fail', String(e).slice(0, 200));
    }
  }
}

// ── Scenario N: premium flag + Stripe endpoint gating ──────────────────────
// Covers the flag semantics that ship with the Stripe subscription plumbing
// without needing real Stripe keys (which the harness environment doesn't
// have). Three buckets:
//   N-1..N-3  auth gating on the Stripe endpoints (401 without session)
//   N-4..N-6  shape and error paths when the session IS present (tolerates
//             503 when STRIPE_SECRET_KEY is unset, because that IS the
//             correct response until Gareth drops the keys in Replit Secrets)
//   N-7..N-9  premium flag round-trip via the dev toggle: flip on, read
//             /api/user/profile, flip off, read again.
async function scenarioPremium() {
  const cat = 'premium';
  const token = sessions.leader1.token;

  // N-1: unauthenticated checkout call → 401
  try {
    const r = await http('POST', '/api/stripe/create-checkout-session', { body: { plan: 'monthly' } });
    record(cat, 'N-1: unauth checkout → 401',
      r.status === 401 ? 'pass' : 'fail',
      `status=${r.status}`);
  } catch (e) { record(cat, 'N-1: unauth checkout', 'fail', String(e).slice(0, 160)); }

  // N-2: unauthenticated billing portal → 401
  try {
    const r = await http('POST', '/api/stripe/billing-portal', {});
    record(cat, 'N-2: unauth billing-portal → 401',
      r.status === 401 ? 'pass' : 'fail',
      `status=${r.status}`);
  } catch (e) { record(cat, 'N-2: unauth billing-portal', 'fail', String(e).slice(0, 160)); }

  // N-3: authed checkout with valid plan. 200 means Stripe is live and returned
  // a checkout URL; 503 means Stripe keys are not configured yet (expected
  // until production secrets are set). Either is a pass — the endpoint and
  // mount-order are correct.
  try {
    const r = await http('POST', '/api/stripe/create-checkout-session', {
      token, body: { plan: 'monthly' },
    });
    if (r.status === 200 && r.json && r.json.url && /^https?:\/\//.test(r.json.url)) {
      record(cat, 'N-3: authed checkout monthly → 200 url', 'pass', `url host=${new URL(r.json.url).host}`);
    } else if (r.status === 503) {
      record(cat, 'N-3: authed checkout monthly → 503 (Stripe not configured)', 'pass',
        'STRIPE_SECRET_KEY not set in env; endpoint returns 503 cleanly');
    } else {
      record(cat, 'N-3: authed checkout monthly', 'fail', `unexpected status=${r.status}`);
    }
  } catch (e) { record(cat, 'N-3: authed checkout monthly', 'fail', String(e).slice(0, 160)); }

  // N-4: authed checkout with invalid plan → 400 (or 503 if Stripe isn't configured).
  try {
    const r = await http('POST', '/api/stripe/create-checkout-session', {
      token, body: { plan: 'lifetime' },
    });
    if (r.status === 400 || r.status === 503) {
      record(cat, 'N-4: invalid plan rejected', 'pass', `status=${r.status}`);
    } else {
      record(cat, 'N-4: invalid plan rejected', 'fail', `unexpected status=${r.status}`);
    }
  } catch (e) { record(cat, 'N-4: invalid plan rejected', 'fail', String(e).slice(0, 160)); }

  // N-5: authed billing-portal with no stripe_customer_id → 400 no_subscription
  // (the [STRESS] leader has never paid) or 503 if Stripe is unconfigured.
  try {
    const r = await http('POST', '/api/stripe/billing-portal', { token });
    const bodyErr = r.json && r.json.error;
    if (r.status === 400 && bodyErr === 'no_subscription') {
      record(cat, 'N-5: billing-portal without subscription → 400 no_subscription', 'pass', 'correct gate');
    } else if (r.status === 503) {
      record(cat, 'N-5: billing-portal → 503 (Stripe not configured)', 'pass', 'keys missing, handled cleanly');
    } else {
      record(cat, 'N-5: billing-portal without subscription', 'fail',
        `unexpected status=${r.status} error=${bodyErr || 'none'}`);
    }
  } catch (e) { record(cat, 'N-5: billing-portal without subscription', 'fail', String(e).slice(0, 160)); }

  // N-6: Stripe webhook mount order. A POST to /api/stripe/webhook without a
  // valid Stripe-Signature should fail signature verification with 400 (when
  // STRIPE_WEBHOOK_SECRET is set) or return 503 (when Stripe is unconfigured).
  // Either is fine — both prove the route is reachable and NOT eaten by
  // express.json() upstream.
  try {
    const r = await http('POST', '/api/stripe/webhook', { body: { type: 'ping' } });
    if (r.status === 400 || r.status === 503) {
      record(cat, 'N-6: webhook rejects unsigned payloads', 'pass', `status=${r.status}`);
    } else {
      record(cat, 'N-6: webhook rejects unsigned payloads', 'fail', `unexpected status=${r.status}`);
    }
  } catch (e) { record(cat, 'N-6: webhook unsigned', 'fail', String(e).slice(0, 160)); }

  // N-7: flip premium ON via dev toggle, then read /api/user/profile back.
  try {
    const flip = await http('GET', '/auth/dev-set-premium?on=1', { token });
    if (flip.status !== 200 || !flip.json || flip.json.premium !== true) {
      record(cat, 'N-7: dev-set-premium on', 'fail',
        `flip status=${flip.status} payload=${JSON.stringify(flip.json).slice(0, 120)}`);
    } else {
      const prof = await http('GET', '/api/user/profile', { token });
      const p = prof.json || {};
      if (prof.status === 200 && p.premium === true && p.premium_until) {
        record(cat, 'N-7: profile reflects premium=true after flip', 'pass',
          `premium_until=${String(p.premium_until).slice(0, 10)}`);
      } else {
        record(cat, 'N-7: profile reflects premium=true after flip', 'fail',
          `profile status=${prof.status} premium=${p.premium} until=${p.premium_until}`);
      }
    }
  } catch (e) { record(cat, 'N-7: premium flip on', 'fail', String(e).slice(0, 160)); }

  // N-8: with premium on, billing-portal still returns no_subscription (no
  // stripe_customer_id). Proves that the premium flag ALONE doesn't unlock
  // the portal — the portal needs a real Stripe customer relationship.
  try {
    const r = await http('POST', '/api/stripe/billing-portal', { token });
    const bodyErr = r.json && r.json.error;
    if ((r.status === 400 && bodyErr === 'no_subscription') || r.status === 503) {
      record(cat, 'N-8: premium=true alone does not unlock portal', 'pass', `status=${r.status}`);
    } else {
      record(cat, 'N-8: premium=true alone does not unlock portal', 'fail',
        `unexpected status=${r.status} error=${bodyErr || 'none'}`);
    }
  } catch (e) { record(cat, 'N-8: premium without customer', 'fail', String(e).slice(0, 160)); }

  // N-9: flip premium back OFF, verify profile reflects it. Important so
  // [STRESS] accounts don't leak premium into later runs.
  try {
    const flip = await http('GET', '/auth/dev-set-premium?on=0', { token });
    if (flip.status !== 200 || !flip.json || flip.json.premium !== false) {
      record(cat, 'N-9: dev-set-premium off', 'fail',
        `flip status=${flip.status} payload=${JSON.stringify(flip.json).slice(0, 120)}`);
    } else {
      const prof = await http('GET', '/api/user/profile', { token });
      const p = prof.json || {};
      if (prof.status === 200 && p.premium === false) {
        record(cat, 'N-9: profile reflects premium=false after revert', 'pass', 'cleanup ok');
      } else {
        record(cat, 'N-9: profile reflects premium=false after revert', 'fail',
          `profile status=${prof.status} premium=${p.premium}`);
      }
    }
  } catch (e) { record(cat, 'N-9: premium flip off', 'fail', String(e).slice(0, 160)); }
}

// ── main runner ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n===== STRESS HARNESS starting @ ${BASE} =====\n`);

  try {
    await phase1Seeding();
    await phase2Contacts();
    await phase3Gigs();

    // dep offer deep pass
    await scenarioPickAccept();
    await scenarioBroadcastDistance();
    await scenarioDecline();
    await scenarioWithdraw();
    await scenarioSecurity();
    await scenarioConcurrency();
    await scenarioValidation();
    await scenarioMessageCap();
    await scenarioNudgeCap();

    // new surfaces
    await scenarioMarketplace();
    await scenarioInvoice();
    await scenarioExpenses();
    await scenarioAI();
    await scenarioPremium();

    // breadth
    await phase5Breadth();
  } catch (e) {
    record('runner', 'top-level error', 'fail', String(e.stack || e));
  } finally {
    await saveResults();
    console.log(`\n===== STRESS HARNESS done =====`);
    console.log(`Passed: ${results.summary.passed}`);
    console.log(`Failed: ${results.summary.failed}`);
    console.log(`Skipped: ${results.summary.skipped}`);
    console.log(`Results at: ${RESULTS_PATH}`);
  }
}

main();
