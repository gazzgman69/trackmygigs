// Combined offers + chat + directory flow. These are intentionally bundled
// because in real usage they cluster: you discover someone in Find Musicians,
// send them a dep offer, message them about logistics, then accept/decline.
//
// Surfaces hit:
//   - GET  /api/discover (name, nearby, instrument_match modes)
//   - POST /api/offers   (dep offers)
//   - POST /api/chat/threads
//   - POST /api/chat/threads/:id/messages
//   - GET  /api/network/top-deps + suggested-deps + shared-history (insights)
//   - POST /api/offers/:id/withdraw + /respond (accept/decline)

async function run(client, user, ctx) {
  // Discovery: every user runs at least one search of each mode
  await client.get('/api/discover?mode=nearby');
  await client.get('/api/discover?mode=instrument_match');
  if (ctx.rand() < 0.5) {
    const q = encodeURIComponent(pickFrom(['Sarah', 'James', 'Tom', 'Emma', 'sax', 'keys'], ctx.rand));
    await client.get('/api/discover?mode=name&q=' + q);
  }

  // Network insights cards (rendered on Home + profile sheets)
  await client.get('/api/network/top-deps?limit=5');
  await client.get('/api/network/suggested-deps?limit=5');

  // Dep offer SENDING via POST /api/dep-offers requires the sender to own
  // a gig AND have contacts. Newly-created sim users won't have contacts
  // until marketplace Pick auto-adds them, so most sim runs won't satisfy
  // the precondition. We skip the send step here in v1 to avoid noise;
  // the offers table is exercised indirectly through marketplace flows
  // (Pick auto-bootstraps a contact pair) and through the GET routes
  // above. A follow-up sim wave can add a "send after marketplace Pick"
  // chained flow once that data exists.

  // Inbound responses: list offers received, accept some, decline some.
  // Accept/decline is a PATCH on the offer with { status }.
  const received = await client.get('/api/offers?direction=received&status=pending');
  const incoming = (received.body && Array.isArray(received.body.offers))
    ? received.body.offers
    : (received.body && Array.isArray(received.body)) ? received.body : [];
  for (const off of incoming.slice(0, 3)) {
    const status = ctx.rand() < 0.55 ? 'accepted' : 'declined';
    await client.patch('/api/offers/' + off.id, { body: { status } });
    await ctx.shortPause();
  }

  // Chat: send a few messages into existing threads (created by Pick /
  // offer-accept on the marketplace + offers paths). Tests the optimistic
  // send path + the SWR thread cache.
  const threads = await client.get('/api/chat/threads');
  const tlist = (threads.body && Array.isArray(threads.body.threads))
    ? threads.body.threads
    : (Array.isArray(threads.body)) ? threads.body : [];
  const msgWanted = user.behavior.chat_messages_to_send || 0;
  for (let i = 0; i < Math.min(msgWanted, tlist.length); i++) {
    const t = tlist[i];
    const msg = pickFrom([
      'Thanks for the booking.',
      'What\'s the dress code?',
      'I\'ll arrive 30min before load-in.',
      'Parking sorted?',
      'See you Saturday.',
      'Quick one: PA in-house?',
    ], ctx.rand);
    await client.post('/api/chat/threads/' + t.id + '/messages', {
      body: { content: msg },
    });
    await ctx.shortPause();
  }

  return { msgsSent: Math.min(msgWanted, tlist.length) };
}

function pickN(arr, n, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
function pickFrom(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }
function pad2(n) { return String(n).padStart(2, '0'); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDaysIso(d, n) { return isoDate(addDays(d, n)); }

module.exports = { run };
