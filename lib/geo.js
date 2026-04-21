// Great-circle distance between two lat/lng pairs, in miles.
// Input degrees. Returns a non-negative Number, or null if any input is
// missing/non-numeric.
//
// We use miles (not km) because every TMG distance setting the user sees is
// already in miles (travel radius slider, agency tiers of 50/250/Nationwide,
// and the existing mileage_miles column on gigs). Mixing units would guarantee
// a subtle off-by-1.6 bug somewhere down the line.
function haversineMiles(lat1, lng1, lat2, lng2) {
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : parseFloat(v));
  const a1 = n(lat1), o1 = n(lng1), a2 = n(lat2), o2 = n(lng2);
  if (!isFinite(a1) || !isFinite(o1) || !isFinite(a2) || !isFinite(o2)) return null;

  const R = 3958.7613; // Earth radius in statute miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(a2 - a1);
  const dLng = toRad(o2 - o1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

module.exports = { haversineMiles };
