// Instrument + genre distribution for sim users. Weighted to roughly mirror
// the working-musician landscape: lots of guitar/keys/vocals, fewer brass and
// strings, a handful of niche players. The mix matters because the dep
// marketplace + "instrument_match" Find Musicians mode rank by overlap.

const INSTRUMENTS = [
  { name: 'Vocals',     weight: 10 },
  { name: 'Guitar',     weight: 10 },
  { name: 'Bass',       weight: 7 },
  { name: 'Keys',       weight: 8 },
  { name: 'Piano',      weight: 4 },
  { name: 'Drums',      weight: 8 },
  { name: 'Saxophone',  weight: 4 },
  { name: 'Trumpet',    weight: 3 },
  { name: 'Trombone',   weight: 2 },
  { name: 'Violin',     weight: 3 },
  { name: 'Cello',      weight: 1 },
  { name: 'DJ',         weight: 4 },
  { name: 'Percussion', weight: 2 },
  { name: 'Flute',      weight: 1 },
  { name: 'Clarinet',   weight: 1 },
];

const GENRES = [
  'Pop', 'Rock', 'Jazz', 'Soul', 'Funk', 'Blues', 'Folk', 'Country',
  'Reggae', 'Disco', 'R&B', 'House', 'Indie', 'Classical', 'Latin',
  'Wedding band', 'Function', 'Acoustic duo', 'Tribute', 'Choir',
];

const TOTAL_INSTRUMENT_WEIGHT = INSTRUMENTS.reduce((s, i) => s + i.weight, 0);

function pickInstruments(rand) {
  rand = rand || Math.random;
  // 60% multi-instrument (2-3), 35% single, 5% four
  const r = rand();
  const count = r < 0.05 ? 4 : r < 0.4 ? 1 : r < 0.7 ? 2 : 3;
  const picked = new Set();
  let safety = 0;
  while (picked.size < count && safety++ < 20) {
    const roll = rand() * TOTAL_INSTRUMENT_WEIGHT;
    let acc = 0;
    for (const ins of INSTRUMENTS) {
      acc += ins.weight;
      if (roll <= acc) { picked.add(ins.name); break; }
    }
  }
  return Array.from(picked);
}

function pickGenres(rand) {
  rand = rand || Math.random;
  // 40% one genre, 40% two, 15% three, 5% four
  const r = rand();
  const count = r < 0.4 ? 1 : r < 0.8 ? 2 : r < 0.95 ? 3 : 4;
  const picked = new Set();
  let safety = 0;
  while (picked.size < count && safety++ < 20) {
    picked.add(GENRES[Math.floor(rand() * GENRES.length)]);
  }
  return Array.from(picked);
}

module.exports = { INSTRUMENTS, GENRES, pickInstruments, pickGenres };
