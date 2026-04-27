// One-shot seed script that lights up Gareth's Home screen with realistic
// demo data: 3 incoming gig offers, 1 outgoing active dep request, a couple
// of chat threads with unread messages, and a few extra confirmed gigs
// scattered across the tax year so the 12-month forecast has more bars.
//
// Idempotent-ish: it creates new gigs and offers each run because the
// underlying API doesn't expose a "find or create" pattern, but every
// piece of data is tagged "[DEMO]" or [STRESS] so it's easy to grep and
// remove later. Re-running this won't break anything; it'll just add
// another round of demo offers/threads.
//
// Usage:
//   STRESS_BASE=https://...kirk.replit.dev node scripts/seed-home-demo.mjs
//   (defaults to the live Replit URL)

const BASE = process.env.STRESS_BASE || 'https://ae09c647-8bf5-4921-92ff-ea1cb2c7d309-00-jm619uhf957h.kirk.replit.dev';
const TARGET_EMAIL = process.env.SEED_TARGET || 'skinnycheck@gmail.com';
const TARGET_NAME = process.env.SEED_TARGET_NAME || 'Gareth';

// Extra musicians whose accounts we'll log in as to send Gareth offers
// and messages. These should already exist (seeded by the stress harness).
// If a session can't be established we skip that musician gracefully.
const SENDERS = [
  { key: 'leader1', email: 'stress-leader-1@trackmygigs.app', name: '[STRESS] Leader Alpha' },
  { key: 'leader2', email: 'stress-leader-2@trackmygigs.app', name: '[STRESS] Leader Bravo' },
  { key: 'dep1',    email: 'stress-dep-1@trackmygigs.app',    name: '[STRESS] Dep One' },
];

const sessions = {};

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

async function devLogin(email, name) {
  const url = `/auth/dev-login?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name || '')}`;
  const r = await http('GET', url);
  const token = parseSessionToken(r.setCookie);
  if (!token) throw new Error(`dev-login for ${email} returned no session cookie; status=${r.status}`);
  // Pull the user row so we know their id.
  const me = await http('GET', '/auth/me', { token });
  const user = me.json?.user || null;
  if (!user) throw new Error(`could not read /auth/me after dev-login for ${email}`);
  return { token, user };
}

function futureDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function pastDate(days) {
  return futureDate(-days);
}

async function ensureContact(ownerToken, contactUser, contactName) {
  const list = await http('GET', '/api/contacts', { token: ownerToken });
  const arr = Array.isArray(list.json) ? list.json : [];
  const existing = arr.find(c => (c.email || '').toLowerCase() === (contactUser.email || '').toLowerCase());
  if (existing) return existing;
  const r = await http('POST', '/api/contacts', {
    token: ownerToken,
    body: {
      name: contactName,
      email: contactUser.email,
      instruments: 'Guitar, Bass',
      linked_user_id: contactUser.id,
      is_favourite: true,
    },
  });
  if (r.status >= 400) throw new Error(`contact create failed: ${r.status} ${r.text?.slice(0, 200)}`);
  return r.json;
}

async function createGig(token, { date, venue_postcode, band_name, venue_name, fee, status }) {
  const r = await http('POST', '/api/gigs', {
    token,
    body: {
      band_name,
      venue_name,
      date,
      start_time: '20:00',
      end_time: '23:00',
      fee,
      venue_postcode,
      status: status || 'confirmed',
      notes: '[DEMO] seed-home-demo',
    },
  });
  if (r.status >= 400) throw new Error(`gig create failed: ${r.status} ${r.text?.slice(0, 200)}`);
  return r.json;
}

async function sendDepOffer(senderToken, gigId, recipientContactId, message) {
  const r = await http('POST', '/api/dep-offers', {
    token: senderToken,
    body: { gig_id: gigId, mode: 'pick', contact_ids: [recipientContactId], message },
  });
  if (r.status >= 400) throw new Error(`dep-offer failed: ${r.status} ${r.text?.slice(0, 300)}`);
  return r.json;
}

async function ensureThreadWithMessage(senderToken, recipientUserId, content) {
  // POST /api/threads either finds an existing 1:1 thread or creates one.
  const t = await http('POST', '/api/chat/threads', {
    token: senderToken,
    body: { participant_ids: [recipientUserId] },
  });
  const threadId = t.json?.id || t.json?.thread?.id;
  if (!threadId) {
    throw new Error(`thread create failed: ${t.status} ${t.text?.slice(0, 200)}`);
  }
  const m = await http('POST', `/api/chat/threads/${threadId}/messages`, {
    token: senderToken,
    body: { content },
  });
  if (m.status >= 400) {
    throw new Error(`message send failed: ${m.status} ${m.text?.slice(0, 200)}`);
  }
  return { threadId, messageId: m.json?.id };
}

async function main() {
  console.log(`\n===== HOME DEMO SEED  target=${TARGET_EMAIL}  base=${BASE} =====\n`);

  // 1. dev-login as Gareth and as each sender.
  const target = await devLogin(TARGET_EMAIL, TARGET_NAME);
  console.log(`✓ logged in as ${TARGET_EMAIL} (id=${target.user.id})`);
  for (const s of SENDERS) {
    try {
      sessions[s.key] = await devLogin(s.email, s.name);
      console.log(`✓ logged in as ${s.email}`);
    } catch (err) {
      console.warn(`× could not log in as ${s.email}: ${err.message}`);
    }
  }
  const activeSenders = SENDERS.filter(s => sessions[s.key]);
  if (activeSenders.length === 0) {
    console.error('No sender accounts could authenticate. Has the stress harness been run yet to seed them?');
    process.exit(1);
  }

  // 2. Make sure each sender has Gareth as a favourite contact (so they
  //    can send him a dep offer in pick mode), and Gareth has each sender
  //    as a favourite (so he can chat / send dep offers to them later).
  for (const s of activeSenders) {
    try {
      const contact = await ensureContact(sessions[s.key].token, target.user, TARGET_NAME);
      sessions[s.key].targetContactId = contact.id;
      console.log(`✓ ${s.key} contacts include ${TARGET_NAME} (contactId=${contact.id})`);
    } catch (err) {
      console.warn(`× ${s.key} contact setup failed: ${err.message}`);
    }
    try {
      await ensureContact(target.token, sessions[s.key].user, s.name);
      console.log(`✓ ${TARGET_NAME} contacts include ${s.name}`);
    } catch (err) {
      console.warn(`× ${TARGET_NAME} → ${s.key} contact setup failed: ${err.message}`);
    }
  }

  // 3. Each sender creates a gig and sends a dep offer to Gareth.
  //    These become the "X gig offers waiting" cards on Home.
  const incomingOffers = [];
  const gigBriefs = [
    { senderKey: 'leader1', date: futureDate(7),  postcode: 'SW1A 1AA', band: 'Soho Project',         venue: 'The Roundhouse',     fee: 320, msg: "Mate, can you cover Saturday night? Same set as usual." },
    { senderKey: 'leader2', date: futureDate(11), postcode: 'M1 1AD',   band: 'Northern Quarter Trio', venue: 'Band on the Wall',   fee: 280, msg: "Got a wedding in Manchester, Sax player flaked. £280 + travel." },
    { senderKey: 'dep1',    date: futureDate(18), postcode: 'B1 1AA',   band: 'Brum Soul Collective',  venue: 'Hare & Hounds',      fee: 250, msg: "Gareth! Sub coming through for Brum, would mean a lot if you can do it." },
  ];
  for (const g of gigBriefs) {
    const sess = sessions[g.senderKey];
    if (!sess || !sess.targetContactId) continue;
    try {
      const gig = await createGig(sess.token, {
        date: g.date, venue_postcode: g.postcode, band_name: g.band, venue_name: g.venue, fee: g.fee,
      });
      const offer = await sendDepOffer(sess.token, gig.id, sess.targetContactId, g.msg);
      incomingOffers.push({ from: g.senderKey, offer });
      console.log(`✓ ${g.senderKey} sent dep offer to ${TARGET_NAME} (£${g.fee} on ${g.date})`);
    } catch (err) {
      console.warn(`× ${g.senderKey} dep offer failed: ${err.message}`);
    }
  }

  // 4. Gareth creates a gig and sends an outgoing dep offer to leader2.
  //    Becomes the purple "Active dep request" banner on Home.
  try {
    const sess = sessions.leader2;
    if (sess) {
      // Need the contact id Gareth holds for leader2.
      const contactsList = await http('GET', '/api/contacts', { token: target.token });
      const leader2Contact = (Array.isArray(contactsList.json) ? contactsList.json : [])
        .find(c => (c.email || '').toLowerCase() === sess.user.email.toLowerCase());
      if (leader2Contact) {
        const gig = await createGig(target.token, {
          date: futureDate(5), venue_postcode: 'CV1 5RR', band_name: 'Coventry Cathedral Wedding',
          venue_name: 'Coventry Cathedral', fee: 400,
        });
        const offer = await sendDepOffer(target.token, gig.id, leader2Contact.id,
          'Last-minute wedding cover, drum stool. Black tie, £400 + parking.');
        console.log(`✓ ${TARGET_NAME} sent outgoing dep offer to leader2 (active dep request banner)`);
      }
    }
  } catch (err) {
    console.warn(`× outgoing dep offer failed: ${err.message}`);
  }

  // 5. Chat threads with unread messages from senders → Gareth.
  //    Become the "Gig messages" card on Home with an unread badge.
  const chatBriefs = [
    { senderKey: 'leader1', text: "Just confirmed parking by the venue, will send you the postcode once I have it." },
    { senderKey: 'dep1',    text: "What time should we load in for Saturday? PA's a bit fiddly so worth allowing extra." },
  ];
  for (const c of chatBriefs) {
    const sess = sessions[c.senderKey];
    if (!sess) continue;
    try {
      const out = await ensureThreadWithMessage(sess.token, target.user.id, c.text);
      console.log(`✓ ${c.senderKey} -> ${TARGET_NAME} chat thread+message (threadId=${out.threadId})`);
    } catch (err) {
      console.warn(`× ${c.senderKey} chat seed failed: ${err.message}`);
    }
  }

  // 6. A few extra confirmed gigs across the tax year so the forecast
  //    has bars in multiple months. These are owned by Gareth himself
  //    and tagged [DEMO] so they're easy to identify.
  const extraGigs = [
    { date: pastDate(60),    postcode: 'BS1 4DR',  band: '[DEMO] Bristol Wedding',     venue: 'Ashton Court',         fee: 525 },
    { date: pastDate(30),    postcode: 'EH1 1YZ',  band: '[DEMO] Edinburgh Function',  venue: 'The Caves',            fee: 600 },
    { date: pastDate(15),    postcode: 'L1 8JQ',   band: '[DEMO] Liverpool Pub Night', venue: 'The Cavern Club',      fee: 240 },
    { date: futureDate(40),  postcode: 'BN1 1EE',  band: '[DEMO] Brighton Festival',   venue: 'Brighton Dome',        fee: 480 },
    { date: futureDate(80),  postcode: 'CF10 1BH', band: '[DEMO] Cardiff Wedding',     venue: 'Cardiff Castle',       fee: 720 },
    { date: futureDate(120), postcode: 'NE1 7RU',  band: '[DEMO] Newcastle Christmas', venue: 'Tyneside Cinema',      fee: 380 },
  ];
  for (const g of extraGigs) {
    try {
      await createGig(target.token, {
        date: g.date, venue_postcode: g.postcode, band_name: g.band, venue_name: g.venue, fee: g.fee,
      });
      console.log(`✓ extra gig ${g.date} ${g.band} £${g.fee}`);
    } catch (err) {
      console.warn(`× extra gig failed: ${err.message}`);
    }
  }

  // 7. Read back stats so we can verify everything lit up.
  const stats = await http('GET', '/api/stats', { token: target.token });
  const s = stats.json || {};
  console.log('\n===== HOME STATE =====');
  console.log(`offer_count:           ${s.offer_count}`);
  console.log(`network_offers:        ${s.network_offers}`);
  console.log(`unread_messages:       ${s.unread_messages}`);
  console.log(`unread_notifications:  ${s.unread_notifications}`);
  console.log(`active_dep_request:    ${s.active_dep_request ? 'YES (' + s.active_dep_request.band_name + ')' : 'no'}`);
  console.log(`overdue_invoices:      ${s.overdue_invoices}`);
  console.log(`draft_invoices:        ${s.draft_invoices}`);
  console.log(`month_earnings:        £${s.month_earnings} (${s.month_gigs} gigs)`);
  console.log(`year_earnings:         £${s.year_earnings} (${s.year_gigs} gigs)`);
  console.log(`monthly_breakdown:     ${(s.monthly_breakdown || []).filter(m => parseFloat(m.confirmed_earnings) > 0).length} months with earnings`);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Seed crashed:', err);
  process.exit(1);
});
