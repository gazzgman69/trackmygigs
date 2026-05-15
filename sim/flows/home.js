// Home / homescreen flow. Every user opens Home at least twice during a
// session (once on first land, once after some activity). The stats payload
// is the single most-hit endpoint in the app, so exercising it under load
// surfaces N+1 query problems, slow joins, and the new gigs_next_7_days
// branch we added during the calendar/sheets wave.
//
// Also fires the routes that the Home v2 action grid + Needs you sheet
// land on when the user taps a tile or chip.

async function run(client, user, ctx) {
  // First Home open — fires /api/stats and the in-flight prefetch chain.
  await client.get('/api/stats');
  await client.get('/api/user/profile');

  // Gigs list (the "Open in Gigs" path from action grid)
  await client.get('/api/gigs');

  // Calendar status + pins (the calendar tab)
  await client.get('/api/calendar/status');
  if (ctx.rand() < 0.4) await client.get('/api/calendar/pins');

  // Sheets status (the Sheets row inside the calendar / More sheet)
  if (ctx.rand() < 0.3) await client.get('/api/sheets/status');

  // Chat inbox (the action grid tile)
  await client.get('/api/chat/threads');

  // Offers screen (Offers tab + Needs you "X offers" chip drilldown)
  await client.get('/api/offers?direction=received');
  if (ctx.rand() < 0.3) await client.get('/api/offers?direction=sent');

  // AI status (feature-detect on first session load)
  await client.get('/api/ai/status');

  // After a bit of activity, refresh Home once more — exercises the
  // background-stats SWR path and the maybeBackgroundSync helper.
  await client.get('/api/stats');
}

module.exports = { run };
