// Orchestrator: spawns N virtual users in cohorts, runs each through the
// onboarding + behaviour flows, and writes every HTTP event to disk as
// JSONL. Concurrency cap is enforced via a simple semaphore so we never
// overshoot Neon's connection budget.
//
// Each virtual user runs roughly:
//   1. /api/admin/sim-create-user (server mints session, returns token)
//   2. onboard.run   — patch profile, mint slug, status probes
//   3. home.run      — open Home, hit the high-traffic stats payload
//   4. gigs.run      — log N gigs
//   5. invoices.run  — create + (mostly) send + sometimes mark paid
//   6. marketplace.run — post / apply / pick
//   7. social.run    — discover + offers + chat
//   8. Final stats poll
//
// Error injection is wired through ctx.maybeInjectError() — each flow calls
// it before a request and may receive a "skip" or "garbage payload" signal.

const path = require('path');
const fs = require('fs');
const { SimClient, makeJsonlWriter, sleep } = require('./client');
const { makeVirtualUser } = require('./personas');
const onboard = require('./flows/onboard');
const home = require('./flows/home');
const gigs = require('./flows/gigs');
const invoices = require('./flows/invoices');
const marketplace = require('./flows/marketplace');
const social = require('./flows/social');

class Semaphore {
  constructor(max) { this.max = max; this.cur = 0; this.q = []; }
  acquire() {
    return new Promise((resolve) => {
      const tryNow = () => {
        if (this.cur < this.max) { this.cur++; resolve(() => { this.cur--; if (this.q.length) this.q.shift()(); }); }
        else this.q.push(tryNow);
      };
      tryNow();
    });
  }
}

// Deterministic-ish PRNG so re-runs with same seed produce same users.
function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runSim(opts) {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const userCount = opts.users || 100;
  const concurrency = opts.concurrency || 25;
  const adminKey = opts.adminKey || 'LEROADSECRET!';
  const seed = opts.seed != null ? opts.seed : Date.now();
  const outDir = opts.outDir;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const eventsLog = makeJsonlWriter(path.join(outDir, 'events.jsonl'));
  const errorsLog = makeJsonlWriter(path.join(outDir, 'errors.jsonl'));
  const summary = {
    started_at: new Date().toISOString(),
    base_url: baseUrl,
    users_requested: userCount,
    concurrency,
    seed,
    users_created: 0,
    users_failed: 0,
    finished_at: null,
    db_stats_before: null,
    db_stats_after: null,
  };

  // Capture DB stats before the run kicks off
  summary.db_stats_before = await fetchSimStats(baseUrl, adminKey);

  // Generate all virtual user specs up front (deterministic given seed)
  const rand = mulberry32(seed);
  const specs = [];
  for (let i = 0; i < userCount; i++) specs.push(makeVirtualUser(i, rand));

  const sem = new Semaphore(concurrency);
  const tasks = specs.map((spec) => runOneUser(spec, {
    baseUrl, adminKey, eventsLog, errorsLog, sem, summary,
    rand: mulberry32(seed + spec.sim_index * 7919), // per-user rng
  }));

  // Live progress to stdout so an operator can watch a 1,000-user run
  const progressEvery = Math.max(1, Math.floor(userCount / 20));
  let done = 0;
  for (const t of tasks) {
    t.then(() => {
      done++;
      if (done % progressEvery === 0 || done === userCount) {
        console.log(`[sim] ${done}/${userCount} users complete · created=${summary.users_created} failed=${summary.users_failed}`);
      }
    });
  }
  await Promise.allSettled(tasks);

  // Final stats poll
  summary.db_stats_after = await fetchSimStats(baseUrl, adminKey);
  summary.finished_at = new Date().toISOString();
  summary.duration_ms = new Date(summary.finished_at) - new Date(summary.started_at);

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[sim] all done. summary at', path.join(outDir, 'summary.json'));
  return summary;
}

async function runOneUser(spec, ctx) {
  const release = await ctx.sem.acquire();
  try {
    // 1. Create user via admin endpoint
    const createUrl = ctx.baseUrl + '/api/admin/sim-create-user?key=' + encodeURIComponent(ctx.adminKey);
    const createBody = {
      email: spec.email,
      name: spec.name,
      display_name: spec.display_name,
      home_postcode: spec.home_postcode,
      home_lat: spec.home_lat,
      home_lng: spec.home_lng,
      travel_radius_miles: spec.travel_radius_miles,
      instruments: spec.instruments,
      genres: spec.genres,
      discoverable: spec.discoverable,
      allow_direct_messages: spec.allow_direct_messages,
      available_now: spec.available_now,
      available_now_until: spec.available_now_until,
    };
    let createRes;
    try {
      const r = await fetch(createUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      createRes = await r.json();
      if (!r.ok || !createRes || !createRes.user_id) {
        ctx.errorsLog({
          kind: 'sim_create_user_failed',
          sim_index: spec.sim_index,
          email: spec.email,
          status: r.status,
          response: createRes,
        });
        ctx.summary.users_failed++;
        return;
      }
    } catch (err) {
      ctx.errorsLog({ kind: 'sim_create_user_threw', sim_index: spec.sim_index, email: spec.email, message: err.message });
      ctx.summary.users_failed++;
      return;
    }
    ctx.summary.users_created++;
    spec.user_id = createRes.user_id;

    // Build the per-user HTTP client
    const client = new SimClient({
      baseUrl: ctx.baseUrl,
      userId: createRes.user_id,
      simIndex: spec.sim_index,
      persona: spec.persona,
      sessionToken: createRes.session_token,
      recordEvent: ctx.eventsLog,
      errorLogger: ctx.errorsLog,
    });

    // Build the shared per-user ctx the flows use
    const flowCtx = {
      rand: ctx.rand,
      shortPause: () => sleep(50 + Math.floor(ctx.rand() * 250)),
      longPause: () => sleep(1000 + Math.floor(ctx.rand() * 4000)),
    };

    // 2-7. Run the behaviour flows in order. Each is wrapped in a try/catch
    // so a single flow's bug doesn't kill the whole user's journey.
    try { await onboard.run(client, spec, flowCtx); } catch (err) { logFlowErr('onboard', err, spec, ctx); }
    try { await home.run(client, spec, flowCtx); } catch (err) { logFlowErr('home', err, spec, ctx); }
    let gigOut = { created: [] };
    try { gigOut = await gigs.run(client, spec, flowCtx) || gigOut; } catch (err) { logFlowErr('gigs', err, spec, ctx); }
    try { await invoices.run(client, spec, flowCtx, gigOut.created); } catch (err) { logFlowErr('invoices', err, spec, ctx); }
    try { await marketplace.run(client, spec, flowCtx); } catch (err) { logFlowErr('marketplace', err, spec, ctx); }
    try { await social.run(client, spec, flowCtx); } catch (err) { logFlowErr('social', err, spec, ctx); }

    // 8. Final Home refresh (exercises the second-render cache path)
    await client.get('/api/stats');
  } finally {
    release();
  }
}

function logFlowErr(flowName, err, spec, ctx) {
  ctx.errorsLog({
    kind: 'flow_threw',
    flow: flowName,
    sim_index: spec.sim_index,
    email: spec.email,
    message: err && (err.message || String(err)),
    stack: err && err.stack ? String(err.stack).slice(0, 1200) : null,
  });
}

async function fetchSimStats(baseUrl, adminKey) {
  try {
    const r = await fetch(baseUrl + '/api/admin/sim-stats?key=' + encodeURIComponent(adminKey), {
      method: 'GET',
    });
    if (!r.ok) return { error: 'http_' + r.status };
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { runSim };
