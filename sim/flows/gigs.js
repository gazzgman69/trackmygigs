// Gig logging flow. Creates the number of gigs the persona's behaviour
// vector calls for, with realistic field variance:
//   - 80% local (inside travel_radius_miles) — biases venue postcodes nearby
//   - 15% mid-range (just outside) — exercises the radius-filter logic
//   - 5%  touring (>100mi) — exercises edge cases + "I'm on tour" patterns
// Roughly 70% confirmed, 25% enquiry, 5% cancelled. About 1/3 of gigs are
// in the past so the simulator's invoice phase can attach to "completed"
// gigs and run the mark-paid cycle.
//
// A configurable share use the Quick-log endpoint shape (POST /api/gigs
// with source='quick-log') to exercise that path; the rest use the
// standard structured payload the wizard sends.

const { pickVenuePostcode } = require('../lib/postcodes');

async function run(client, user, ctx) {
  const want = user.behavior.gigs_to_log || 0;
  if (want === 0) return { created: [] };
  const created = [];
  for (let i = 0; i < want; i++) {
    const gig = composeGig(user, ctx);
    const res = await client.post('/api/gigs', { body: gig });
    if (res.ok && res.body && res.body.id) {
      created.push({ id: res.body.id, date: gig.date, status: gig.status, fee: gig.fee });
    }
    // Light human-like delay between consecutive gig creates
    await ctx.shortPause();
  }
  // After creating, list them back once to exercise the GET path
  await client.get('/api/gigs');
  return { created };
}

function composeGig(user, ctx) {
  const rand = ctx.rand;
  const distanceRoll = rand();
  const home = { lat: user.home_lat, lng: user.home_lng };
  const venue = distanceRoll < 0.80
    ? pickVenuePostcode(home, { radius_miles: user.travel_radius_miles || 50, rand })
    : distanceRoll < 0.95
      ? pickVenuePostcode(home, { radius_miles: (user.travel_radius_miles || 50) * 1.5, rand })
      : pickVenuePostcode(home, { far: true, rand });

  // Pick a date: 35% past (eligible for invoicing), 65% future
  const dayOffset = rand() < 0.35
    ? -Math.floor(rand() * 120) - 1  // 1-120 days ago
    : Math.floor(rand() * 90) + 1;   // 1-90 days hence
  const date = isoDate(addDays(new Date(), dayOffset));

  // Times: 8pm start is most common, end +3h, load-in 2h earlier
  const startHour = 18 + Math.floor(rand() * 4); // 18-21
  const start_time = `${pad2(startHour)}:${pickFrom(['00', '15', '30', '45'], rand)}:00`;
  const endHour = startHour + 2 + Math.floor(rand() * 2);
  const end_time = `${pad2(Math.min(endHour, 23))}:30:00`;
  const load_in_time = `${pad2(startHour - 2)}:30:00`;

  // Fee: weighted distribution. £100-£200 most common.
  const feeRoll = rand();
  const fee = feeRoll < 0.6 ? 100 + Math.floor(rand() * 12) * 25
            : feeRoll < 0.9 ? 200 + Math.floor(rand() * 20) * 25
            : 500 + Math.floor(rand() * 20) * 50;

  // Status: 70% confirmed, 25% enquiry, 5% cancelled
  const sRoll = rand();
  const status = sRoll < 0.70 ? 'confirmed' : sRoll < 0.95 ? 'enquiry' : 'cancelled';

  const gigType = pickFrom(['Function', 'Wedding', 'Pub', 'Corporate', 'Private', 'Church', 'Theatre'], rand);
  const dressCode = pickFrom(['Smart-casual', 'All-black', 'Formal', 'Themed', null, null], rand);

  // 70% of gigs get a leader contact (one of the persona behaviours)
  const includeLeader = rand() < (user.behavior.gigs_with_leader_contact || 0);
  const leaderName = includeLeader ? pickFrom([
    'Sarah', 'James', 'Tom', 'Hannah', 'Joe', 'Olivia', 'Ben', 'Emma'
  ], rand) : null;
  const leaderPhone = includeLeader ? '07' + Math.floor(100000000 + rand() * 900000000).toString().slice(0, 9) : null;
  const leaderEmail = includeLeader && rand() < 0.4 ? `${leaderName.toLowerCase()}@example.com` : null;

  return {
    band_name: pickFrom([
      'The Foxes', 'Soul Society', 'Late Night Funk', 'Function Five',
      'Saturday Six', 'Brass Tactics', 'Vinyl Souls', 'Acoustic Two',
    ], rand),
    venue_name: venueNameFrom(venue.outward, rand),
    venue_address: `${1 + Math.floor(rand() * 200)} High Street, ${venue.outward}`,
    venue_postcode: venue.outward + ' ' + (1 + Math.floor(rand() * 9)) + 'AB',
    date,
    start_time,
    end_time,
    load_in_time,
    fee,
    status,
    source: rand() < 0.10 ? 'quick-log' : 'manual',
    dress_code: dressCode,
    notes: rand() < 0.4 ? pickFrom([
      'Park out back, ask for the manager.',
      'PA is in-house, just bring DI.',
      'Soundcheck at 6.',
      'Dinner provided.',
    ], rand) : null,
    gig_type: gigType,
    parking_info: rand() < 0.3 ? 'Free on-site' : null,
    gig_leader_name: leaderName,
    gig_leader_phone: leaderPhone,
    gig_leader_email: leaderEmail,
    mileage_miles: Math.round(venue.miles || 0),
    rate_per_hour: null,
  };
}

// Helpers
function pad2(n) { return String(n).padStart(2, '0'); }
function pickFrom(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function venueNameFrom(outward, rand) {
  const venues = [
    'The Crown', 'The Bullingdon', 'The Tythe Barn', 'Concorde 2',
    'The Old Mill', 'The Hare & Hounds', 'The George', 'St Mary\'s Church',
    'The Town Hall', 'The Grand', 'Hilton Garden', 'The Royal Oak',
  ];
  return pickFrom(venues, rand) + ' (' + outward + ')';
}

module.exports = { run };
