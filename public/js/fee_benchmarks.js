/* TrackMyGigs fee benchmarks v1
 * Seed data for the wizard-chip peer-positioned benchmark.
 * Source: /fee_benchmark_research.md (v1.1, signed off 2026-04-20).
 *
 * Design rules (do not break):
 *  - 65th to 75th percentile of real booked fees, not averages.
 *  - Agency prices deflated 15% for direct-booked musicians.
 *  - Never show a benchmark below the user's own fee (asymmetric).
 *  - No MU figures, no "average" language, no monetary comparison.
 *  - Confidence label on every chip.
 */

(function (global) {
  // National typical figures for an established working act.
  // Configuration chosen: the modal act size for each gig type based on
  // early TrackMyGigs user population. Band-size-aware benchmarks land in v1.1.
  var NATIONAL = {
    'Wedding':       { amount: 2000, unit: 'total', config: 'full reception' },
    'Corporate':     { amount: 2250, unit: 'total', config: 'corporate event' },
    'Pub / Club':    { amount: 550,  unit: 'total', config: '2 x 45 pub slot' },
    'Private party': { amount: 1500, unit: 'total', config: 'private party' },
    'Hotel':         { amount: 1500, unit: 'total', config: 'hotel function' },
    'Restaurant':    { amount: 550,  unit: 'total', config: 'restaurant slot' },
    'Teaching':      { amount: 50,   unit: 'hourly', config: 'private lesson' },
    // Festival / Theatre / Church / Other deliberately omitted. Too varied.
  };

  var REGION_MULTIPLIERS = {
    london:            1.15,
    south_east:        1.05,
    south_west:        1.10,
    east_of_england:   1.05,
    scotland:          1.05,
    wales:             1.05,
    yorkshire:         0.98,
    east_midlands:     0.95,
    west_midlands:     0.95,
    north_west:        0.95,
    north_east:        0.93,
    northern_ireland:  0.95,
    channel_islands:   1.20,
  };

  var REGION_LABELS = {
    london:            'London',
    south_east:        'the South East',
    south_west:        'the South West',
    east_of_england:   'the East of England',
    scotland:          'Scotland',
    wales:             'Wales',
    yorkshire:         'Yorkshire',
    east_midlands:     'the East Midlands',
    west_midlands:     'the West Midlands',
    north_west:        'the North West',
    north_east:        'the North East',
    northern_ireland:  'Northern Ireland',
    channel_islands:   'the Channel Islands',
    national:          'the UK',
  };

  // Lightweight keyword-based region inference from a venue address.
  // Covers the common city/county/postcode-area tokens. Fallback: national.
  var REGION_KEYWORDS = {
    london: [
      'london', ' ec1', ' ec2', ' ec3', ' ec4', ' wc1', ' wc2',
      ' e1 ', ' e2 ', ' e3 ', ' e4 ', ' e5 ', ' e6 ', ' e7 ', ' e8 ', ' e9 ',
      ' n1 ', ' n2 ', ' n3 ', ' n4 ', ' n5 ', ' n6 ', ' n7 ', ' n8 ', ' n9 ',
      ' nw1', ' nw2', ' nw3', ' nw4', ' nw5', ' nw6', ' nw7', ' nw8',
      ' se1', ' se2', ' se3', ' se4', ' se5', ' se6', ' se7', ' se8',
      ' sw1', ' sw2', ' sw3', ' sw4', ' sw5', ' sw6', ' sw7', ' sw8',
      ' w1 ', ' w2 ', ' w3 ', ' w4 ', ' w5 ', ' w6 ', ' w7 ', ' w8 ',
    ],
    north_west:       ['manchester', 'liverpool', 'preston', 'bolton', 'blackburn', 'blackpool', 'wigan', 'lancaster', 'cheshire', 'cumbria', 'chester', 'stockport', 'warrington'],
    north_east:       ['newcastle', 'sunderland', 'middlesbrough', 'durham', 'gateshead', 'hartlepool', 'tyne', 'wear'],
    yorkshire:        ['leeds', 'sheffield', 'bradford', 'york', 'hull', 'huddersfield', 'halifax', 'wakefield', 'harrogate', 'yorkshire', 'humberside'],
    east_midlands:    ['nottingham', 'leicester', 'derby', 'lincoln', 'northampton', 'loughborough', 'lincolnshire'],
    west_midlands:    ['birmingham', 'coventry', 'wolverhampton', 'stoke', 'worcester', 'hereford', 'shrewsbury', 'telford', 'dudley', 'walsall', 'warwick', 'solihull'],
    south_west:       ['bristol', 'bath', 'plymouth', 'exeter', 'bournemouth', 'poole', 'gloucester', 'cheltenham', 'taunton', 'cornwall', 'devon', 'somerset', 'dorset', 'wiltshire', 'swindon'],
    south_east:       ['brighton', 'southampton', 'portsmouth', 'reading', 'oxford', 'milton keynes', 'guildford', 'woking', 'kent', 'surrey', 'sussex', 'hampshire', 'berkshire', 'buckinghamshire', 'canterbury', 'maidstone', 'tunbridge', 'basingstoke', 'crawley'],
    east_of_england:  ['cambridge', 'norwich', 'ipswich', 'colchester', 'essex', 'norfolk', 'suffolk', 'hertfordshire', 'bedfordshire', 'luton', 'watford', 'chelmsford', 'southend', 'peterborough'],
    scotland:         ['edinburgh', 'glasgow', 'aberdeen', 'dundee', 'stirling', 'inverness', 'perth', 'scotland', 'scottish', 'fife', 'lothian', 'highland'],
    wales:            ['cardiff', 'swansea', 'newport', 'wrexham', 'wales', 'welsh', 'gwynedd', 'carmarthen', 'pembroke', 'anglesey'],
    northern_ireland: ['belfast', 'londonderry', ' derry', 'antrim', 'armagh', 'down', 'fermanagh', 'tyrone', 'northern ireland'],
    channel_islands:  ['jersey', 'guernsey', 'alderney', 'sark', 'channel islands'],
  };

  function inferRegion(address) {
    if (!address || typeof address !== 'string') return 'national';
    var haystack = ' ' + address.toLowerCase() + ' ';
    // London first so its postcode tokens win over generic SW/SE text elsewhere.
    var order = ['london', 'channel_islands', 'northern_ireland', 'scotland', 'wales',
                 'north_east', 'north_west', 'yorkshire', 'east_midlands', 'west_midlands',
                 'south_west', 'east_of_england', 'south_east'];
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var keys = REGION_KEYWORDS[key];
      for (var j = 0; j < keys.length; j++) {
        if (haystack.indexOf(keys[j]) !== -1) return key;
      }
    }
    return 'national';
  }

  // Round to nearest £25 for clean UI display (per research doc).
  // Epsilon guards against 57.4999... style floating-point truncation
  // (e.g. 50 x 1.15 lands below 57.5 and would round down to 55 without it).
  function roundToClean(n, unit) {
    var step = unit === 'hourly' ? 5 : 25;
    return Math.round(n / step + 1e-9) * step;
  }

  /**
   * Get a benchmark for a given gig_type, region and user fee.
   * Returns null if we shouldn't show a chip (no data, or user's fee is at/above benchmark).
   *
   * @param {object} opts
   * @param {string} opts.gig_type    - e.g. 'Wedding', 'Teaching'
   * @param {string} [opts.address]   - venue address; region inferred from this
   * @param {string} [opts.region]    - explicit region key override
   * @param {number|string} [opts.fee]- user's entered fee
   * @returns {{amount:number, regionLabel:string, regionKey:string, unit:string, config:string, text:string, meta:string}|null}
   */
  function getBenchmark(opts) {
    opts = opts || {};
    var gigType = opts.gig_type;
    if (!gigType || !NATIONAL[gigType]) return null;

    var regionKey = opts.region || inferRegion(opts.address);
    var multiplier = REGION_MULTIPLIERS[regionKey] || 1.0;

    var base = NATIONAL[gigType];
    var amount = roundToClean(base.amount * multiplier, base.unit);
    var regionLabel = REGION_LABELS[regionKey] || REGION_LABELS.national;

    // Asymmetric rule: never show a benchmark below the user's own fee.
    // Allow a small 2% buffer so a £1,995 fee doesn't hide a £2,000 chip.
    var userFee = parseFloat(opts.fee);
    if (!isNaN(userFee) && userFee > 0) {
      if (userFee >= amount * 0.98) return null;
    }

    var text;
    if (gigType === 'Teaching') {
      text = 'Established private teachers in ' + regionLabel + ' typically charge around \u00A3' + amount + '/hour.';
    } else if (gigType === 'Wedding') {
      text = 'Working wedding bands in ' + regionLabel + ' typically charge around \u00A3' + amount.toLocaleString() + ' for a full reception.';
    } else if (gigType === 'Corporate') {
      text = 'Corporate events in ' + regionLabel + ' typically run around \u00A3' + amount.toLocaleString() + '.';
    } else if (gigType === 'Pub / Club') {
      text = 'Established pub acts in ' + regionLabel + ' typically charge around \u00A3' + amount.toLocaleString() + ' for a 2\u00D745 slot.';
    } else if (gigType === 'Private party') {
      text = 'Private party bookings in ' + regionLabel + ' typically run around \u00A3' + amount.toLocaleString() + '.';
    } else if (gigType === 'Hotel') {
      text = 'Hotel function bookings in ' + regionLabel + ' typically run around \u00A3' + amount.toLocaleString() + '.';
    } else if (gigType === 'Restaurant') {
      text = 'Restaurant slots in ' + regionLabel + ' typically pay around \u00A3' + amount.toLocaleString() + '.';
    } else {
      text = 'Working musicians in ' + regionLabel + ' typically charge around \u00A3' + amount.toLocaleString() + '.';
    }

    return {
      amount: amount,
      regionKey: regionKey,
      regionLabel: regionLabel,
      unit: base.unit,
      config: base.config,
      text: text,
      meta: 'Based on UK market data, April 2026.',
    };
  }

  global.FeeBenchmarks = {
    getBenchmark: getBenchmark,
    inferRegion: inferRegion,
    _national: NATIONAL,
    _multipliers: REGION_MULTIPLIERS,
  };
})(window);
