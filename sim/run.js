#!/usr/bin/env node
// CLI entry for the simulation. Examples:
//
//   node sim/run.js --users 10                 # smoke
//   node sim/run.js --users 100                # ramp
//   node sim/run.js --users 1000               # full run
//   node sim/run.js --users 1000 --concurrency 50
//   node sim/run.js --users 1000 --base https://trackmygigs.replit.app
//   node sim/run.js --wipe                     # wipe sim users + exit
//
// Defaults:
//   base         = https://trackmygigs.replit.app
//   users        = 100
//   concurrency  = 25 (safe for Neon free; bump for paid tiers)
//   admin-key    = LEROADSECRET! (override with RELOAD_SECRET env)
//   out-dir      = sim/results/<timestamp>

const path = require('path');
const fs = require('fs');
const { runSim } = require('./orchestrator');
const { generate: generateReport } = require('./report');

function parseArgs(argv) {
  const out = { users: 100, concurrency: 25, base: 'https://trackmygigs.replit.app',
                adminKey: process.env.RELOAD_SECRET || 'LEROADSECRET!',
                wipe: false, seed: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--users') { out.users = parseInt(next, 10); i++; }
    else if (a === '--concurrency') { out.concurrency = parseInt(next, 10); i++; }
    else if (a === '--base') { out.base = next; i++; }
    else if (a === '--admin-key') { out.adminKey = next; i++; }
    else if (a === '--seed') { out.seed = parseInt(next, 10); i++; }
    else if (a === '--wipe') { out.wipe = true; }
    else if (a === '--out-dir') { out.outDir = next; i++; }
  }
  return out;
}

async function wipeSimData(base, adminKey) {
  const url = base.replace(/\/$/, '') + '/api/admin/wipe-sim-data?key=' + encodeURIComponent(adminKey);
  console.log('[wipe] hitting', url);
  const r = await fetch(url, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  console.log('[wipe] status', r.status);
  console.log('[wipe] counts', JSON.stringify(body.counts, null, 2));
  return r.status === 200;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.wipe) {
    const ok = await wipeSimData(args.base, args.adminKey);
    process.exit(ok ? 0 : 1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const outDir = args.outDir || path.join(__dirname, 'results', ts);
  console.log('[sim] starting');
  console.log('  base       =', args.base);
  console.log('  users      =', args.users);
  console.log('  concurrency=', args.concurrency);
  console.log('  out_dir    =', outDir);
  console.log('  seed       =', args.seed != null ? args.seed : '(time-based)');

  const summary = await runSim({
    baseUrl: args.base,
    users: args.users,
    concurrency: args.concurrency,
    adminKey: args.adminKey,
    outDir,
    seed: args.seed,
  });

  console.log('[sim] writing report...');
  const report = generateReport(outDir);

  // Print quick verdict to stdout
  console.log('\n===== VERDICT =====');
  console.log('5xx-free   :', report.pass_fail.no_5xx ? 'PASS' : 'FAIL (' + report.totals.five_hundreds + ' five-hundreds)');
  console.log('Users      :', report.pass_fail.users_created, '/', report.pass_fail.users_requested);
  console.log('Requests   :', report.totals.total_requests);
  console.log('Errors     :', report.totals.total_errors, '(' + (report.totals.error_rate * 100).toFixed(2) + '%)');
  console.log('Flow throws:', report.totals.flow_throws);
  const inv = report.pass_fail.key_invariants || {};
  console.log('DB delta   : sim_users=' + (inv.sim_users_added || 0)
              + '  gigs=' + (inv.gigs_added || 0)
              + '  invoices=' + (inv.invoices_added || 0)
              + '  offers=' + (inv.offers_added || 0)
              + '  marketplace=' + (inv.marketplace_gigs_added || 0)
              + '  messages=' + (inv.messages_added || 0));
  console.log('Report     :', path.join(outDir, 'report.html'));
}

main().catch((err) => {
  console.error('[sim] fatal:', err);
  process.exit(1);
});
