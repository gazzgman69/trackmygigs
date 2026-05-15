// Compose a virtual user. Each call returns a self-contained spec that the
// orchestrator hands to the onboarding flow. Five personas weighted to
// approximate the real-world musician landscape:
//
//   active_gigger  (40%)  Logs 5-15 gigs, invoices most, posts marketplace
//                          gigs occasionally, sends dep offers. Sits in the
//                          middle of the funnel.
//   hobbyist       (35%)  1-3 gigs, sometimes invoices, browses marketplace
//                          but rarely applies. The "I do this on weekends"
//                          slice of the user base.
//   dep_specialist (15%)  Few own gigs, lots of marketplace applications,
//                          available_now toggled on. Tests the dep-supply
//                          side of the marketplace + Find Musicians ranking.
//   band_leader    (5%)   Posts many marketplace gigs to find deps, fewer
//                          own gigs. Tests the dep-demand side.
//   lurker         (5%)   Signs up, sets a profile, does almost nothing else.
//                          Tests that the app handles empty-state surfaces
//                          gracefully.
//
// Geographic + instrument + name distribution come from the lib/ modules.

const { pickPostcode, fullPostcode } = require('./lib/postcodes');
const { pickInstruments, pickGenres } = require('./lib/instruments');
const { pickName } = require('./lib/names');

const PERSONAS = [
  { kind: 'active_gigger',  weight: 40 },
  { kind: 'hobbyist',       weight: 35 },
  { kind: 'dep_specialist', weight: 15 },
  { kind: 'band_leader',    weight: 5 },
  { kind: 'lurker',         weight: 5 },
];
const TOTAL_PERSONA_WEIGHT = PERSONAS.reduce((s, p) => s + p.weight, 0);

function pickPersonaKind(rand) {
  const r = (rand || Math.random)() * TOTAL_PERSONA_WEIGHT;
  let acc = 0;
  for (const p of PERSONAS) {
    acc += p.weight;
    if (r <= acc) return p.kind;
  }
  return PERSONAS[PERSONAS.length - 1].kind;
}

// Per-persona behaviour vector. Probabilities + count ranges the orchestrator
// uses to decide how many of each action to run for this user.
function behaviorFor(kind, rand) {
  rand = rand || Math.random;
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  if (kind === 'active_gigger') {
    return {
      gigs_to_log:               between(5, 15),
      gigs_with_leader_contact:  0.7,
      invoices_per_completed_gig: 0.85,
      will_mark_paid:            0.7,
      expenses_to_log:           between(2, 8),
      marketplace_posts:         between(0, 2),
      marketplace_applications:  between(1, 4),
      dep_offers_to_send:        between(0, 2),
      chat_messages_to_send:     between(2, 8),
      will_use_voice_note:       0.3,
      will_set_available_now:    0.2,
      will_share_next_gig:       0.4,
    };
  }
  if (kind === 'hobbyist') {
    return {
      gigs_to_log:               between(1, 3),
      gigs_with_leader_contact:  0.4,
      invoices_per_completed_gig: 0.5,
      will_mark_paid:            0.4,
      expenses_to_log:           between(0, 3),
      marketplace_posts:         0,
      marketplace_applications:  between(0, 1),
      dep_offers_to_send:        0,
      chat_messages_to_send:     between(0, 2),
      will_use_voice_note:       0.1,
      will_set_available_now:    0.05,
      will_share_next_gig:       0.1,
    };
  }
  if (kind === 'dep_specialist') {
    return {
      gigs_to_log:               between(0, 2),
      gigs_with_leader_contact:  0.3,
      invoices_per_completed_gig: 0.6,
      will_mark_paid:            0.5,
      expenses_to_log:           between(1, 4),
      marketplace_posts:         0,
      marketplace_applications:  between(5, 12),
      dep_offers_to_send:        0,
      chat_messages_to_send:     between(3, 6),
      will_use_voice_note:       0.2,
      will_set_available_now:    0.85, // signature of this persona
      will_share_next_gig:       0.3,
    };
  }
  if (kind === 'band_leader') {
    return {
      gigs_to_log:               between(3, 8),
      gigs_with_leader_contact:  0.9, // they ARE the leader
      invoices_per_completed_gig: 0.7,
      will_mark_paid:            0.5,
      expenses_to_log:           between(0, 3),
      marketplace_posts:         between(3, 8), // many dep posts
      marketplace_applications:  between(0, 1),
      dep_offers_to_send:        between(2, 5),
      chat_messages_to_send:     between(5, 12),
      will_use_voice_note:       0.4,
      will_set_available_now:    0.1,
      will_share_next_gig:       0.5,
    };
  }
  // lurker
  return {
    gigs_to_log:               0,
    gigs_with_leader_contact:  0,
    invoices_per_completed_gig: 0,
    will_mark_paid:            0,
    expenses_to_log:           0,
    marketplace_posts:         0,
    marketplace_applications:  0,
    dep_offers_to_send:        0,
    chat_messages_to_send:     0,
    will_use_voice_note:       0,
    will_set_available_now:    0,
    will_share_next_gig:       0,
  };
}

// Compose a complete virtual user spec.
function makeVirtualUser(index, rand) {
  rand = rand || Math.random;
  const { display_name, name } = pickName(rand);
  const home = pickPostcode(rand);
  const home_postcode = fullPostcode(home.outward, rand);
  const persona = pickPersonaKind(rand);
  const behavior = behaviorFor(persona, rand);

  // Travel radius: bell-curve-ish around 40-50mi, with tails.
  const radiusRoll = rand();
  const travel_radius_miles =
    radiusRoll < 0.10 ? 15 + Math.floor(rand() * 10)
    : radiusRoll < 0.80 ? 30 + Math.floor(rand() * 30)
    : radiusRoll < 0.95 ? 75 + Math.floor(rand() * 25)
    : null; // 5% have no radius set — tests the null-fall-open path

  // Phone: UK mobile starting 07
  const phone = '07' + Math.floor(100000000 + rand() * 900000000).toString().slice(0, 9);

  return {
    // Identity
    sim_index: index,
    email: `sim+${randomToken(rand)}@trackmygigs.app`,
    name,
    display_name,
    phone,
    persona,

    // Geo
    home_postcode,
    home_lat: home.lat,
    home_lng: home.lng,
    region: home.region,
    travel_radius_miles,

    // Profile
    instruments: pickInstruments(rand),
    genres: pickGenres(rand),
    discoverable: rand() < 0.85,
    allow_direct_messages: rand() < 0.9,
    available_now: rand() < behavior.will_set_available_now,
    available_now_until: rand() < behavior.will_set_available_now
      ? new Date(Date.now() + (1 + Math.floor(rand() * 14)) * 24 * 60 * 60 * 1000).toISOString()
      : null,

    // Behaviour quotas
    behavior,
  };
}

function randomToken(rand) {
  rand = rand || Math.random;
  // 12 chars from a-z0-9. Used as the email-local part after "sim+".
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(rand() * chars.length)];
  return s;
}

module.exports = { PERSONAS, pickPersonaKind, behaviorFor, makeVirtualUser };
