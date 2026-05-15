// Marketplace flow. Posts dep gigs (band_leader / active_gigger personas),
// browses the listing (everyone), applies to gigs (dep_specialist / hobbyist),
// and exercises the Pick / Cancel paths (posters).
//
// Each session runs both halves where applicable: a user may post AND apply
// to others' posts in the same flow, exactly as a real working musician does
// during a busy week.

const { pickVenuePostcode } = require('../lib/postcodes');

async function run(client, user, ctx) {
  const posted = [];
  const applications = [];

  // Browse first — every user does this. Tests the Browse endpoint + filters.
  await client.get('/api/marketplace?tab=open');

  // Post: band leaders + some active giggers
  const postsWanted = user.behavior.marketplace_posts || 0;
  for (let i = 0; i < postsWanted; i++) {
    const post = composePost(user, ctx);
    const res = await client.post('/api/marketplace', { body: post });
    if (res.ok && res.body && res.body.id) posted.push(res.body.id);
    await ctx.shortPause();
  }

  // Apply: dep specialists + some active giggers
  // We need a pool of open gigs to apply to. Re-fetch Browse to see the
  // current cohort's posts (the orchestrator runs personas in waves so by
  // the time this user reaches the application phase, there should be
  // plenty of open posts from the earlier cohort).
  const appsWanted = user.behavior.marketplace_applications || 0;
  if (appsWanted > 0) {
    const browse = await client.get('/api/marketplace?tab=open');
    const list = (browse.body && Array.isArray(browse.body.gigs)) ? browse.body.gigs
                : (browse.body && Array.isArray(browse.body)) ? browse.body
                : [];
    // Filter to gigs we don't own (server should already do this but be safe)
    const candidates = list.filter((g) => g.poster_user_id !== user.user_id);
    // Apply to a random subset up to appsWanted
    const targets = pickN(candidates, Math.min(appsWanted, candidates.length), ctx.rand);
    for (const gig of targets) {
      const note = pickFrom([
        'Available, can do.',
        'I\'m free that night, would love to.',
        'Open to it — what\'s the dress code?',
        'Yes please. Travelling from ' + user.region + '.',
      ], ctx.rand);
      const res = await client.post('/api/marketplace/' + gig.id + '/apply', {
        body: { note },
      });
      if (res.ok) applications.push({ marketplace_gig_id: gig.id });
      await ctx.shortPause();
    }
  }

  // For our own posts: review applicants and pick one if we have any.
  // Run later cohorts will see the filled state. Pick happens for ~60% of
  // posts that have at least one application.
  for (const postId of posted) {
    if (ctx.rand() > 0.6) continue;
    const apps = await client.get('/api/marketplace/' + postId + '/applicants');
    const list = (apps.body && Array.isArray(apps.body.applicants)) ? apps.body.applicants
               : (Array.isArray(apps.body)) ? apps.body : [];
    if (list.length === 0) continue;
    const winner = list[Math.floor(ctx.rand() * list.length)];
    if (!winner || !winner.user_id) continue;
    await client.post('/api/marketplace/' + postId + '/pick', {
      body: { applicant_user_id: winner.user_id },
    });
    await ctx.shortPause();
  }

  return { posted, applications };
}

function composePost(user, ctx) {
  const rand = ctx.rand;
  const home = { lat: user.home_lat, lng: user.home_lng };
  // Most marketplace posts are local; a few are touring or remote-leader posts
  const venue = pickVenuePostcode(home, {
    radius_miles: (user.travel_radius_miles || 50) * 1.5,
    rand,
  });
  const dayOffset = 3 + Math.floor(rand() * 60); // 3-63 days out
  const date = isoDate(addDays(new Date(), dayOffset));
  const startHour = 18 + Math.floor(rand() * 4);
  const start_time = `${pad2(startHour)}:30:00`;
  const end_time = `${pad2(Math.min(startHour + 3, 23))}:30:00`;

  // Free vs paid: 85% paid, 15% free (charity/showcase)
  const isFreePost = rand() < 0.15;
  const fee_pence = isFreePost ? 0 : (10000 + Math.floor(rand() * 40) * 2500);

  const instrument = pickFrom(user.instruments.length ? user.instruments : ['Guitar'], rand);

  return {
    title: pickFrom([
      `${instrument} sub needed`,
      `Looking for a ${instrument.toLowerCase()}`,
      `Need cover, ${instrument.toLowerCase()}`,
      `Last-minute ${instrument.toLowerCase()} dep`,
    ], rand),
    description: 'Function gig, standard sets, easy crowd. PA + monitors in-house.',
    venue_name: pickFrom(['The Crown', 'The Old Mill', 'Hilton', 'The Grand'], rand),
    venue_address: `${1 + Math.floor(rand() * 200)} High Street`,
    venue_postcode: venue.outward + ' ' + (1 + Math.floor(rand() * 9)) + 'AB',
    gig_date: date,
    start_time,
    end_time,
    instruments: [instrument],
    fee_pence,
    is_free: isFreePost,
    free_reason: isFreePost ? pickFrom(['charity', 'open_mic', 'promo_slot', 'favour', 'student_showcase', 'other'], rand) : null,
    mode: rand() < 0.7 ? 'pick' : 'fcfs',
  };
}

function pickN(arr, n, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pickFrom(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

module.exports = { run };
