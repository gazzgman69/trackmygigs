// UK outward postcode distribution for the 1,000-user simulation.
//
// Each entry: { outward, lat, lng, region, weight }
//   outward = the outward part of a UK postcode (e.g. "SW1A", "M14")
//   lat/lng = approximate centroid (good enough for distance maths within
//             ~1-2 miles, which is the granularity gig matching cares about)
//   region  = bucket label for cohort-level reporting
//   weight  = relative likelihood (London heavier, rural lighter), roughly
//             matching where UK gigging musicians live in the real world
//
// The simulator uses these to seed each virtual user's home_postcode and
// home_lat/lng, then bias their gig venues toward nearby postcodes (with
// a tail of "touring" gigs further afield to exercise the radius filter).

const POSTCODES = [
  // London (heavy weight: ~25% of musicians)
  { outward: 'SW1A', lat: 51.4995, lng: -0.1245, region: 'London', weight: 6 },
  { outward: 'E1',   lat: 51.5165, lng: -0.0700, region: 'London', weight: 5 },
  { outward: 'E2',   lat: 51.5294, lng: -0.0617, region: 'London', weight: 4 },
  { outward: 'E8',   lat: 51.5446, lng: -0.0700, region: 'London', weight: 5 },
  { outward: 'NW1',  lat: 51.5366, lng: -0.1390, region: 'London', weight: 5 },
  { outward: 'NW5',  lat: 51.5556, lng: -0.1450, region: 'London', weight: 4 },
  { outward: 'SE1',  lat: 51.5006, lng: -0.0883, region: 'London', weight: 5 },
  { outward: 'SE15', lat: 51.4734, lng: -0.0716, region: 'London', weight: 4 },
  { outward: 'N1',   lat: 51.5378, lng: -0.0997, region: 'London', weight: 5 },
  { outward: 'N16',  lat: 51.5618, lng: -0.0796, region: 'London', weight: 4 },
  { outward: 'W1',   lat: 51.5145, lng: -0.1416, region: 'London', weight: 4 },
  { outward: 'W11',  lat: 51.5158, lng: -0.2078, region: 'London', weight: 3 },
  { outward: 'EC1',  lat: 51.5223, lng: -0.1019, region: 'London', weight: 3 },
  { outward: 'SW9',  lat: 51.4734, lng: -0.1118, region: 'London', weight: 4 },
  { outward: 'SW11', lat: 51.4671, lng: -0.1700, region: 'London', weight: 4 },

  // Manchester
  { outward: 'M1',   lat: 53.4767, lng: -2.2390, region: 'NorthWest', weight: 5 },
  { outward: 'M4',   lat: 53.4839, lng: -2.2304, region: 'NorthWest', weight: 4 },
  { outward: 'M14',  lat: 53.4499, lng: -2.2247, region: 'NorthWest', weight: 4 },
  { outward: 'M21',  lat: 53.4456, lng: -2.2818, region: 'NorthWest', weight: 3 },
  { outward: 'M3',   lat: 53.4854, lng: -2.2520, region: 'NorthWest', weight: 3 },

  // Liverpool
  { outward: 'L1',   lat: 53.4054, lng: -2.9783, region: 'NorthWest', weight: 4 },
  { outward: 'L8',   lat: 53.3879, lng: -2.9667, region: 'NorthWest', weight: 3 },
  { outward: 'L17',  lat: 53.3784, lng: -2.9359, region: 'NorthWest', weight: 3 },

  // Birmingham
  { outward: 'B1',   lat: 52.4801, lng: -1.9027, region: 'Midlands', weight: 5 },
  { outward: 'B14',  lat: 52.4231, lng: -1.8927, region: 'Midlands', weight: 3 },
  { outward: 'B16',  lat: 52.4769, lng: -1.9379, region: 'Midlands', weight: 3 },
  { outward: 'B30',  lat: 52.4233, lng: -1.9418, region: 'Midlands', weight: 2 },

  // Leeds
  { outward: 'LS1',  lat: 53.7980, lng: -1.5491, region: 'Yorkshire', weight: 4 },
  { outward: 'LS6',  lat: 53.8131, lng: -1.5697, region: 'Yorkshire', weight: 3 },

  // Sheffield
  { outward: 'S1',   lat: 53.3811, lng: -1.4701, region: 'Yorkshire', weight: 3 },
  { outward: 'S7',   lat: 53.3531, lng: -1.4818, region: 'Yorkshire', weight: 3 },

  // Bristol
  { outward: 'BS1',  lat: 51.4536, lng: -2.5980, region: 'SouthWest', weight: 4 },
  { outward: 'BS8',  lat: 51.4574, lng: -2.6116, region: 'SouthWest', weight: 4 },
  { outward: 'BS3',  lat: 51.4407, lng: -2.6034, region: 'SouthWest', weight: 3 },

  // Brighton
  { outward: 'BN1',  lat: 50.8276, lng: -0.1414, region: 'SouthEast', weight: 4 },
  { outward: 'BN2',  lat: 50.8175, lng: -0.1235, region: 'SouthEast', weight: 3 },

  // Newcastle
  { outward: 'NE1',  lat: 54.9738, lng: -1.6131, region: 'NorthEast', weight: 4 },
  { outward: 'NE2',  lat: 54.9926, lng: -1.6105, region: 'NorthEast', weight: 3 },

  // Oxford / Cambridge
  { outward: 'OX1',  lat: 51.7520, lng: -1.2577, region: 'SouthEast', weight: 3 },
  { outward: 'CB1',  lat: 52.1979, lng: 0.1380,  region: 'East',      weight: 3 },

  // Nottingham / Derby / Leicester
  { outward: 'NG1',  lat: 52.9550, lng: -1.1500, region: 'Midlands', weight: 3 },
  { outward: 'DE1',  lat: 52.9219, lng: -1.4769, region: 'Midlands', weight: 2 },
  { outward: 'LE1',  lat: 52.6369, lng: -1.1398, region: 'Midlands', weight: 2 },

  // York / Hull
  { outward: 'YO1',  lat: 53.9590, lng: -1.0815, region: 'Yorkshire', weight: 2 },
  { outward: 'HU1',  lat: 53.7456, lng: -0.3367, region: 'Yorkshire', weight: 2 },

  // Cardiff
  { outward: 'CF10', lat: 51.4811, lng: -3.1791, region: 'Wales', weight: 4 },
  { outward: 'CF24', lat: 51.4920, lng: -3.1635, region: 'Wales', weight: 3 },
  { outward: 'CF5',  lat: 51.4791, lng: -3.2300, region: 'Wales', weight: 2 },

  // Swansea / Newport
  { outward: 'SA1',  lat: 51.6214, lng: -3.9436, region: 'Wales', weight: 2 },
  { outward: 'NP20', lat: 51.5878, lng: -3.0008, region: 'Wales', weight: 2 },

  // Edinburgh
  { outward: 'EH1',  lat: 55.9533, lng: -3.1883, region: 'Scotland', weight: 4 },
  { outward: 'EH3',  lat: 55.9491, lng: -3.2042, region: 'Scotland', weight: 3 },
  { outward: 'EH8',  lat: 55.9419, lng: -3.1746, region: 'Scotland', weight: 3 },

  // Glasgow
  { outward: 'G1',   lat: 55.8617, lng: -4.2583, region: 'Scotland', weight: 4 },
  { outward: 'G42',  lat: 55.8259, lng: -4.2585, region: 'Scotland', weight: 3 },
  { outward: 'G3',   lat: 55.8642, lng: -4.2747, region: 'Scotland', weight: 3 },

  // Aberdeen / Dundee
  { outward: 'AB10', lat: 57.1497, lng: -2.0943, region: 'Scotland', weight: 2 },
  { outward: 'DD1',  lat: 56.4620, lng: -2.9707, region: 'Scotland', weight: 2 },

  // Belfast
  { outward: 'BT1',  lat: 54.5973, lng: -5.9301, region: 'NorthernIreland', weight: 3 },
  { outward: 'BT9',  lat: 54.5786, lng: -5.9498, region: 'NorthernIreland', weight: 2 },

  // Southampton / Portsmouth
  { outward: 'SO14', lat: 50.9018, lng: -1.4044, region: 'SouthEast', weight: 3 },
  { outward: 'PO1',  lat: 50.7944, lng: -1.0996, region: 'SouthEast', weight: 2 },

  // Plymouth / Exeter
  { outward: 'PL1',  lat: 50.3755, lng: -4.1427, region: 'SouthWest', weight: 2 },
  { outward: 'EX1',  lat: 50.7253, lng: -3.5172, region: 'SouthWest', weight: 2 },

  // Norwich / Ipswich
  { outward: 'NR1',  lat: 52.6230, lng: 1.3088,  region: 'East', weight: 2 },
  { outward: 'IP1',  lat: 52.0567, lng: 1.1483,  region: 'East', weight: 2 },

  // Stratford-upon-Avon / Cheltenham / Bath / Reading (touring belt)
  { outward: 'CV37', lat: 52.1917, lng: -1.7080, region: 'Midlands', weight: 2 },
  { outward: 'GL50', lat: 51.9000, lng: -2.0750, region: 'SouthWest', weight: 2 },
  { outward: 'BA1',  lat: 51.3805, lng: -2.3590, region: 'SouthWest', weight: 3 },
  { outward: 'RG1',  lat: 51.4543, lng: -0.9781, region: 'SouthEast', weight: 2 },

  // Smaller market towns + rural prefix (sparse — tests the geo edge cases)
  { outward: 'HG1',  lat: 53.9925, lng: -1.5410, region: 'Yorkshire', weight: 1 },
  { outward: 'TR1',  lat: 50.2632, lng: -5.0510, region: 'SouthWest', weight: 1 },
  { outward: 'LL30', lat: 53.3215, lng: -3.8270, region: 'Wales', weight: 1 },
  { outward: 'IV1',  lat: 57.4778, lng: -4.2247, region: 'Scotland', weight: 1 },
];

// Pre-compute the weighted random-pick lookup table once.
const TOTAL_WEIGHT = POSTCODES.reduce((s, p) => s + p.weight, 0);

function pickPostcode(rand) {
  const r = (rand || Math.random)() * TOTAL_WEIGHT;
  let acc = 0;
  for (const p of POSTCODES) {
    acc += p.weight;
    if (r <= acc) return p;
  }
  return POSTCODES[POSTCODES.length - 1];
}

// Produce a plausible-looking full postcode by appending a random inward
// part (one digit + two letters). Doesn't need to be a real address — only
// the outward part is used for geocoding fallback paths, and we ship the
// pre-computed lat/lng directly.
function fullPostcode(outward, rand) {
  rand = rand || Math.random;
  const inwardNum = Math.floor(rand() * 9) + 1;
  const letters = 'ABDEFGHJLNPQRSTUWXYZ'; // postcodes don't use C/I/K/M/O/V
  const a = letters[Math.floor(rand() * letters.length)];
  const b = letters[Math.floor(rand() * letters.length)];
  return `${outward} ${inwardNum}${a}${b}`;
}

// Haversine for sanity-checking distances during simulation. Same formula
// the server uses; keeping it client-side too lets the simulator pre-pick
// "nearby" vs "touring" venues without round-tripping to the server.
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Pick a venue postcode biased by distance from a home postcode. Used to
// generate gig venues that mostly fall within the user's travel_radius_miles
// (with a tail of far-away "touring" gigs that exercise the radius filter).
function pickVenuePostcode(home, opts) {
  opts = opts || {};
  const radius = opts.radius_miles != null ? opts.radius_miles : 50;
  const far = opts.far === true;
  const rand = opts.rand || Math.random;

  // Build a candidate pool with weights = (radius reach) * (popularity).
  const candidates = [];
  for (const p of POSTCODES) {
    const miles = haversineMiles(home.lat, home.lng, p.lat, p.lng);
    if (far) {
      // Tour gigs: prefer postcodes 100+ miles away
      if (miles >= 100) candidates.push({ ...p, miles, w: p.weight * 2 });
    } else {
      // Local gigs: weight by how far inside the radius they sit
      if (miles <= radius) {
        const inverseDist = Math.max(1, radius - miles + 1);
        candidates.push({ ...p, miles, w: p.weight * inverseDist });
      }
    }
  }
  if (candidates.length === 0) return home; // fallback: same postcode

  const total = candidates.reduce((s, c) => s + c.w, 0);
  const r = rand() * total;
  let acc = 0;
  for (const c of candidates) {
    acc += c.w;
    if (r <= acc) return c;
  }
  return candidates[candidates.length - 1];
}

module.exports = { POSTCODES, pickPostcode, fullPostcode, haversineMiles, pickVenuePostcode };
