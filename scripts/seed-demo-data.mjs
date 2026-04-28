// Test data generator for the TrackMyGigs onboarding demo (Phases A-F).
//
// Produces TWO outputs that overlap by design so cross-source dedup gets
// exercised when both are imported into TMG:
//
//   1. A CSV file in /sessions/nifty-gallant-franklin/mnt/ClientFlow CRM/
//      that the user uploads to Google Sheets, then connects via the
//      onboarding picker.
//   2. A JSON file with calendar event payloads that get fired into the
//      user's Google Calendar via the calendar MCP (separately, by Claude).
//
// Layout:
//   60 unique gigs across May 2026 - April 2027.
//   Calendar receives 50 of them (30 overlapping + 20 calendar-only).
//   Sheet receives 40 of them (30 overlapping + 10 sheet-only).
//
// The 30 overlapping gigs hit the cross-source soft-match dedup. The
// calendar-only and sheet-only sets prove the inbound import works for
// each source independently.
//
// Run with:
//   cd trackmygigs && node scripts/seed-demo-data.mjs
// then upload the printed CSV path to Google Sheets and let Claude fire
// the JSON calendar events via the MCP.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Master gig list. 60 unique gigs designed to look like a real working
// musician's year - residencies, weddings, festivals, teaching, deps,
// Christmas party season.
// ---------------------------------------------------------------------------
const ALL_GIGS = [
  // ---- May 2026 ----
  { id:'G01', date:'2026-05-02', start:'19:00', end:'23:00', band:'The Velveteens', venue:'The Tythe Barn', address:'High St, Bicester OX26 6BD', fee:850, client:'Rachel Morgan', notes:'Wedding reception. First dance at 8pm.' },
  { id:'G02', date:'2026-05-07', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G03', date:'2026-05-09', start:'19:30', end:'23:30', band:'The Velveteens', venue:'Stoke Park Country Club', address:'Park Rd, Stoke Poges SL2 4PG', fee:950, client:'Daniel and Sophie', notes:'Outdoor ceremony 2pm, evening reception.' },
  { id:'G04', date:'2026-05-12', start:'16:00', end:'18:00', band:'', venue:'Maidenhead Music School', address:'Castle Hill, Maidenhead SL6 4AY', fee:140, client:'Mark Pearson', notes:'Teaching block: 4 students.' },
  { id:'G05', date:'2026-05-14', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G06', date:'2026-05-16', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Cain Manor', address:'Hindhead Rd, Headley GU35 8SY', fee:900, client:'Tom and Eliza', notes:'Wedding.' },
  { id:'G07', date:'2026-05-19', start:'16:00', end:'18:00', band:'', venue:'Maidenhead Music School', address:'Castle Hill, Maidenhead SL6 4AY', fee:140, client:'Mark Pearson', notes:'Teaching.' },
  { id:'G08', date:'2026-05-21', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G09', date:'2026-05-23', start:'19:00', end:'23:30', band:'The Velveteens', venue:'Greenwich Yacht Club', address:'1 Peartree Way, London SE10 0BW', fee:1100, client:'James Whitfield', notes:'Wedding. London traffic, leave 4pm.' },
  { id:'G10', date:'2026-05-29', start:'21:00', end:'00:00', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:220, client:'', notes:'Last Friday residency.' },
  { id:'G11', date:'2026-05-30', start:'19:00', end:'23:00', band:'The Velveteens', venue:'The Manor House Castle Combe', address:'Castle Combe SN14 7HR', fee:950, client:'Hannah Roberts', notes:'Wedding.' },

  // ---- June 2026 ----
  { id:'G12', date:'2026-06-04', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G13', date:'2026-06-06', start:'18:00', end:'22:00', band:'The Velveteens', venue:'Notley Abbey', address:'Notley Abbey, Long Crendon HP18 9ER', fee:1000, client:'Olivia Bennett', notes:'Wedding.' },
  { id:'G14', date:'2026-06-09', start:'16:00', end:'18:00', band:'', venue:'Maidenhead Music School', address:'Castle Hill, Maidenhead SL6 4AY', fee:140, client:'Mark Pearson', notes:'Teaching.' },
  { id:'G15', date:'2026-06-11', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G16', date:'2026-06-13', start:'19:00', end:'23:30', band:'The Velveteens', venue:'Aynhoe Park', address:'Aynho, Banbury OX17 3BQ', fee:1200, client:'Charlotte Hughes', notes:'Wedding. Black tie.' },
  { id:'G17', date:'2026-06-19', start:'19:30', end:'22:30', band:'Mixed By Gaz DJ', venue:'Henley Festival', address:'Marsh Meadows, Henley-on-Thames RG9 2HY', fee:450, client:'Henley Festival', notes:'DJ set, jazz tent.' },
  { id:'G18', date:'2026-06-20', start:'14:00', end:'17:00', band:'The Velveteens', venue:'Henley Festival', address:'Marsh Meadows, Henley-on-Thames RG9 2HY', fee:600, client:'Henley Festival', notes:'Afternoon stage slot.' },
  { id:'G19', date:'2026-06-25', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G20', date:'2026-06-26', start:'21:00', end:'00:00', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:220, client:'', notes:'Last Friday residency.' },
  { id:'G21', date:'2026-06-27', start:'18:00', end:'22:00', band:'The Velveteens', venue:'Brympton House', address:'Brympton, Yeovil BA22 8TD', fee:1100, client:'Emily Carter', notes:'Wedding.' },

  // ---- July 2026 ----
  { id:'G22', date:'2026-07-04', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Iscoyd Park', address:'Whitchurch SY13 3AT', fee:1100, client:'Lucy Foster', notes:'Wedding.' },
  { id:'G23', date:'2026-07-09', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G24', date:'2026-07-11', start:'15:00', end:'17:00', band:'The Velveteens', venue:'Cornbury Festival', address:'Great Tew, Chipping Norton OX7 4AB', fee:800, client:'Cornbury Festival', notes:'Main stage, mid-afternoon.' },
  { id:'G25', date:'2026-07-18', start:'13:00', end:'15:00', band:'The Velveteens', venue:'Ealing Jazz Festival', address:'Walpole Park, Ealing W5 5JN', fee:550, client:'Ealing Jazz Festival', notes:'Bandstand stage.' },
  { id:'G26', date:'2026-07-23', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G27', date:'2026-07-25', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Hedsor House', address:'Taplow SL6 0HX', fee:1300, client:'Sienna Walsh', notes:'Wedding.' },
  { id:'G28', date:'2026-07-30', start:'21:00', end:'00:00', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:220, client:'', notes:'Last Friday residency.' },

  // ---- August 2026 ----
  { id:'G29', date:'2026-08-01', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Hampton Manor', address:'Shadowbrook Lane, Hampton-in-Arden B92 0EN', fee:1050, client:'Amelia Reid', notes:'Wedding.' },
  { id:'G30', date:'2026-08-08', start:'14:00', end:'16:00', band:'The Velveteens', venue:'Cropredy Festival', address:'Cropredy, Banbury OX17 1PE', fee:700, client:'Cropredy Festival', notes:'Acoustic stage.' },
  { id:'G31', date:'2026-08-13', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G32', date:'2026-08-15', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Kingscote Barn', address:'Kingscote, Tetbury GL8 8YE', fee:950, client:'Isla Murray', notes:'Wedding.' },
  { id:'G33', date:'2026-08-22', start:'18:00', end:'22:00', band:'The Velveteens', venue:'Le Manoir aux QuatSaisons', address:'Church Rd, Great Milton OX44 7PD', fee:1500, client:'Charlotte and Henry', notes:'Wedding. High-end venue.' },
  { id:'G34', date:'2026-08-28', start:'21:00', end:'00:00', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:220, client:'', notes:'Last Friday residency.' },

  // ---- September 2026 ----
  { id:'G35', date:'2026-09-05', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Dorney Court', address:'Court Lane, Dorney SL4 6QP', fee:950, client:'Beatrice Lyons', notes:'Wedding.' },
  { id:'G36', date:'2026-09-10', start:'20:00', end:'22:00', band:'The Olde Bell Trio', venue:'The Olde Bell', address:'High St, Hurley SL6 5LX', fee:180, client:'', notes:'Thursday residency.' },
  { id:'G37', date:'2026-09-12', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Mapledurham House', address:'Mapledurham RG4 7TR', fee:900, client:'Annabel Drake', notes:'Wedding.' },
  { id:'G38', date:'2026-09-15', start:'16:00', end:'18:00', band:'', venue:'Maidenhead Music School', address:'Castle Hill, Maidenhead SL6 4AY', fee:140, client:'Mark Pearson', notes:'Teaching, autumn term restart.' },
  { id:'G39', date:'2026-09-19', start:'19:30', end:'23:30', band:'The Velveteens', venue:'Pennyhill Park', address:'London Rd, Bagshot GU19 5EU', fee:1100, client:'Grace Sterling', notes:'Wedding.' },
  { id:'G40', date:'2026-09-25', start:'21:00', end:'00:00', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:220, client:'', notes:'Last Friday residency.' },

  // ---- October 2026 ----
  { id:'G41', date:'2026-10-03', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Coworth Park', address:'Blacknest Rd, Sunningdale SL5 7SE', fee:1200, client:'Sophie and Ed', notes:'Wedding.' },
  { id:'G42', date:'2026-10-06', start:'16:00', end:'18:00', band:'', venue:'Maidenhead Music School', address:'Castle Hill, Maidenhead SL6 4AY', fee:140, client:'Mark Pearson', notes:'Teaching.' },
  { id:'G43', date:'2026-10-10', start:'20:00', end:'23:00', band:'Mixed By Gaz DJ', venue:'Private residence Cookham', address:'Cookham Dean SL6 9JA', fee:600, client:'Henry Morton', notes:'40th birthday party.' },
  { id:'G44', date:'2026-10-17', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Botleys Mansion', address:'Chertsey KT16 0AL', fee:1000, client:'Mia Singleton', notes:'Wedding.' },
  { id:'G45', date:'2026-10-30', start:'21:00', end:'00:00', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:220, client:'', notes:'Halloween night.' },

  // ---- November 2026 ----
  { id:'G46', date:'2026-11-07', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Fawsley Hall', address:'Fawsley NN11 3BA', fee:950, client:'Holly Marsh', notes:'Wedding.' },
  { id:'G47', date:'2026-11-14', start:'19:00', end:'22:30', band:'Mixed By Gaz DJ', venue:'Phyllis Court Club', address:'Marlow Rd, Henley-on-Thames RG9 2HT', fee:550, client:'Phyllis Court members', notes:'Members evening.' },
  { id:'G48', date:'2026-11-21', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Rivervale Barn', address:'Yateley GU46 7TX', fee:900, client:'Ava Bishop', notes:'Wedding.' },

  // ---- December 2026 ----
  { id:'G49', date:'2026-12-04', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Cliveden House', address:'Cliveden Rd, Taplow SL6 0JF', fee:1500, client:'GreenLeaf Marketing', notes:'Corporate Christmas party.' },
  { id:'G50', date:'2026-12-05', start:'19:30', end:'23:30', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:300, client:'', notes:'Christmas residency special.' },
  { id:'G51', date:'2026-12-11', start:'18:30', end:'22:30', band:'The Velveteens', venue:'The Royal Garden Hotel', address:'2-24 Kensington High St, London W8 4PT', fee:1400, client:'Westfield Group', notes:'Corporate dinner.' },
  { id:'G52', date:'2026-12-12', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Foxhills Resort', address:'Stonehill Rd, Ottershaw KT16 0EL', fee:1300, client:'Sage HR Awards', notes:'Awards dinner.' },
  { id:'G53', date:'2026-12-18', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Stoke Park Country Club', address:'Park Rd, Stoke Poges SL2 4PG', fee:1500, client:'Cura Asset Management', notes:'Christmas party.' },
  { id:'G54', date:'2026-12-19', start:'19:30', end:'23:30', band:'The Velveteens', venue:'The Bull Hotel Gerrards Cross', address:'Oxford Rd, Gerrards Cross SL9 7PA', fee:1100, client:'Hayes Bingham Solicitors', notes:'Christmas party.' },
  { id:'G55', date:'2026-12-30', start:'20:00', end:'01:00', band:'The Velveteens', venue:'The Boathouse Henley', address:'Station Rd, Henley-on-Thames RG9 1AZ', fee:1800, client:'', notes:'NYE warmup. Late finish.' },

  // ---- 2027 ----
  { id:'G56', date:'2027-01-15', start:'19:00', end:'22:00', band:'Mixed By Gaz DJ', venue:'Private residence Beaconsfield', address:'Beaconsfield HP9 1RN', fee:500, client:'Daniel Crawford', notes:'30th birthday.' },
  { id:'G57', date:'2027-01-22', start:'21:00', end:'00:00', band:'The Velveteens', venue:'Vinyl Underground', address:'High St, Maidenhead SL6 1QX', fee:220, client:'', notes:'Friday residency.' },
  { id:'G58', date:'2027-02-14', start:'19:30', end:'23:30', band:'The Velveteens', venue:'The Crazy Bear', address:'Bear Lane, Stadhampton OX44 7UR', fee:1000, client:'Crazy Bear', notes:'Valentines event.' },
  { id:'G59', date:'2027-03-13', start:'19:00', end:'22:00', band:'Mixed By Gaz DJ', venue:'Hotel du Vin Henley', address:'New St, Henley-on-Thames RG9 2BP', fee:600, client:'Sarah and Mike', notes:'Engagement party.' },
  { id:'G60', date:'2027-04-17', start:'19:00', end:'23:00', band:'The Velveteens', venue:'Wasing Park', address:'Aldermaston RG7 4NG', fee:950, client:'Phoebe Eastwood', notes:'Wedding.' },
];

// ---------------------------------------------------------------------------
// Distribution. 30 in BOTH (cross-source dedup), 20 calendar-only,
// 10 sheet-only. The split is hand-picked so every kind of gig appears
// in both surfaces (residencies, weddings, teaching, festivals).
// ---------------------------------------------------------------------------
const IN_BOTH = ['G01','G02','G03','G05','G06','G08','G09','G11','G13','G15',
                 'G16','G21','G22','G27','G29','G32','G33','G35','G37','G39',
                 'G41','G44','G46','G48','G49','G51','G52','G53','G54','G60'];

const CALENDAR_ONLY = ['G04','G07','G10','G12','G14','G17','G18','G19','G20','G23',
                       'G24','G25','G26','G28','G30','G31','G34','G36','G38','G45'];

const SHEET_ONLY = ['G40','G42','G43','G47','G50','G55','G56','G57','G58','G59'];

const calendarIds = new Set([...IN_BOTH, ...CALENDAR_ONLY]);
const sheetIds = new Set([...IN_BOTH, ...SHEET_ONLY]);

const calendarGigs = ALL_GIGS.filter(g => calendarIds.has(g.id));
const sheetGigs = ALL_GIGS.filter(g => sheetIds.has(g.id));

console.log(`Calendar events: ${calendarGigs.length}`);
console.log(`Sheet rows:      ${sheetGigs.length}`);
console.log(`Overlap (dedup): ${IN_BOTH.length}`);
console.log(`Calendar-only:   ${CALENDAR_ONLY.length}`);
console.log(`Sheet-only:      ${SHEET_ONLY.length}`);

// ---------------------------------------------------------------------------
// CSV writer. The header names intentionally don't match TMG's canonical
// field names so the column mapper has to do real work.
// ---------------------------------------------------------------------------
function csvEscape(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const csvHeader = ['Date','Start','End','Band/Act','Venue','Address','Fee (£)','Client','Notes'];
const csvRows = sheetGigs.map(g => [
  g.date,
  g.start,
  g.end,
  g.band,
  g.venue,
  g.address,
  g.fee,
  g.client,
  g.notes,
].map(csvEscape).join(','));

const csvOut = [csvHeader.join(','), ...csvRows].join('\n') + '\n';

const csvPath = '/sessions/nifty-gallant-franklin/mnt/ClientFlow CRM/TMG-Demo-Gigs.csv';
fs.writeFileSync(csvPath, csvOut, 'utf8');
console.log(`\n✓ CSV written: ${csvPath}`);
console.log(`  ${sheetGigs.length} rows + 1 header = ${sheetGigs.length + 1} lines`);

// ---------------------------------------------------------------------------
// Calendar event payloads. Stamps a [TMG Demo] prefix and a description
// marker so the user can search-and-delete after the demo. Times are
// Europe/London local; the calendar MCP gets them paired with timeZone.
// ---------------------------------------------------------------------------
function eventForGig(g) {
  // Wrap-around times like 21:00-00:00 mean end is next day.
  let endDate = g.date;
  const [sh, sm] = g.start.split(':').map(n => parseInt(n, 10));
  const [eh, em] = g.end.split(':').map(n => parseInt(n, 10));
  if (eh < sh || (eh === sh && em < sm)) {
    const d = new Date(g.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }
  const summary = g.band
    ? `[TMG Demo] ${g.band} @ ${g.venue}`
    : `[TMG Demo] ${g.venue}`;
  const descLines = [
    'TMG demo data — safe to delete after the onboarding walkthrough.',
    g.notes ? `Notes: ${g.notes}` : null,
    g.client ? `Client: ${g.client}` : null,
    g.fee ? `Fee: £${g.fee}` : null,
  ].filter(Boolean);
  return {
    id: g.id,
    summary,
    description: descLines.join('\n'),
    location: g.address,
    startTime: `${g.date}T${g.start}:00`,
    endTime: `${endDate}T${g.end}:00`,
    timeZone: 'Europe/London',
  };
}

const calendarEvents = calendarGigs.map(eventForGig);
const eventsPath = path.join(path.dirname(csvPath), 'TMG-Demo-CalendarEvents.json');
fs.writeFileSync(eventsPath, JSON.stringify(calendarEvents, null, 2), 'utf8');
console.log(`✓ Calendar events JSON: ${eventsPath}`);
console.log(`  ${calendarEvents.length} events for the calendar MCP`);
