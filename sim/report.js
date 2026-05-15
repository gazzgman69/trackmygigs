// Read the events.jsonl + errors.jsonl + summary.json from a run directory
// and produce a clean structured report:
//
//   report.json          — every roll-up at machine-readable precision
//   report.html          — single-page HTML summary to open in a browser
//   slowest-paths.json   — top-50 slowest endpoint hits with status + body
//   top-errors.json      — error rows grouped by (path, status, kind) with
//                          one example body per group
//
// Usage:
//   node sim/report.js sim/results/<timestamp>

const fs = require('fs');
const path = require('path');

function readJsonl(filepath) {
  if (!fs.existsSync(filepath)) return [];
  const lines = fs.readFileSync(filepath, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function generate(runDir) {
  const events = readJsonl(path.join(runDir, 'events.jsonl'));
  const errors = readJsonl(path.join(runDir, 'errors.jsonl'));
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));

  // Roll up per-endpoint
  const byPath = new Map();
  for (const e of events) {
    const key = e.method + ' ' + normalizePath(e.path);
    let bucket = byPath.get(key);
    if (!bucket) {
      bucket = {
        method: e.method, path_template: normalizePath(e.path),
        count: 0, ok: 0, fail: 0,
        status_dist: {},
        latencies: [],
      };
      byPath.set(key, bucket);
    }
    bucket.count++;
    if (e.ok) bucket.ok++; else bucket.fail++;
    bucket.status_dist[e.status] = (bucket.status_dist[e.status] || 0) + 1;
    bucket.latencies.push(e.elapsed_ms || 0);
  }

  // Convert latencies to p50/p95/p99
  const endpointRollup = [...byPath.values()].map((b) => {
    const sorted = b.latencies.slice().sort((a, x) => a - x);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] || 0;
    return {
      method: b.method,
      path: b.path_template,
      count: b.count,
      ok: b.ok,
      fail: b.fail,
      ok_rate: b.count ? (b.ok / b.count) : 0,
      status_dist: b.status_dist,
      p50_ms: p(0.5),
      p95_ms: p(0.95),
      p99_ms: p(0.99),
    };
  }).sort((a, b) => b.count - a.count);

  // Error grouping
  const errorGroups = new Map();
  for (const e of events.filter((e) => !e.ok)) {
    const key = e.method + ' ' + normalizePath(e.path) + ' :: ' + e.status + ' :: ' + (e.err_kind || 'http');
    let g = errorGroups.get(key);
    if (!g) { g = { key, count: 0, example: null }; errorGroups.set(key, g); }
    g.count++;
    if (!g.example) g.example = { ...e, body_sample: e.body_sample };
  }
  const topErrors = [...errorGroups.values()].sort((a, b) => b.count - a.count).slice(0, 50);

  // Slowest paths
  const slowest = events.slice().filter((e) => e.elapsed_ms != null).sort((a, b) => b.elapsed_ms - a.elapsed_ms).slice(0, 50);

  // Final report
  const totalReq = events.length;
  const totalErr = events.filter((e) => !e.ok).length;
  const fiveHundreds = events.filter((e) => e.status >= 500 && e.status <= 599).length;

  const report = {
    summary,
    totals: {
      total_requests: totalReq,
      total_errors: totalErr,
      error_rate: totalReq ? totalErr / totalReq : 0,
      five_hundreds: fiveHundreds,
      five_hundred_rate: totalReq ? fiveHundreds / totalReq : 0,
      flow_throws: errors.filter((e) => e.kind === 'flow_threw').length,
      sim_create_user_failures: errors.filter((e) => e.kind && e.kind.startsWith('sim_create_user_')).length,
    },
    pass_fail: {
      no_5xx: fiveHundreds === 0,
      users_created: summary.users_created,
      users_requested: summary.users_requested,
      key_invariants: invariantsCheck(summary),
    },
    endpoints: endpointRollup,
    top_errors: topErrors,
  };

  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(runDir, 'slowest-paths.json'), JSON.stringify(slowest, null, 2));
  fs.writeFileSync(path.join(runDir, 'top-errors.json'), JSON.stringify(topErrors, null, 2));
  fs.writeFileSync(path.join(runDir, 'report.html'), renderHtml(report));
  console.log('[report] wrote report.json, report.html, slowest-paths.json, top-errors.json');
  return report;
}

// Collapse UUIDs / numeric ids in URL paths to placeholders so the same
// endpoint with different ids aggregates cleanly.
function normalizePath(p) {
  if (!p) return '';
  return p
    .replace(/\?.*$/, '')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '/:uuid')
    .replace(/\/\d+\b/g, '/:id');
}

function invariantsCheck(summary) {
  const before = summary.db_stats_before || {};
  const after = summary.db_stats_after || {};
  const out = {};
  function delta(key, subkey) {
    if (!before[key] || !after[key]) return null;
    if (subkey) {
      return (after[key][subkey] || 0) - (before[key][subkey] || 0);
    }
    return (after[key] || 0) - (before[key] || 0);
  }
  out.users_added = delta('users', 'total');
  out.sim_users_added = delta('users', 'sim');
  out.gigs_added = delta('gigs', 'total');
  out.gigs_with_geo_added = delta('gigs', 'with_geo');
  out.invoices_added = delta('invoices', 'total');
  out.invoices_paid_added = delta('invoices', 'paid');
  out.offers_added = delta('offers', 'total');
  out.marketplace_gigs_added = delta('marketplace_gigs', 'total');
  out.marketplace_filled_added = delta('marketplace_gigs', 'filled');
  out.messages_added = delta('messages');
  out.threads_added = delta('threads');
  return out;
}

function renderHtml(report) {
  const r = report;
  const okBadge = (ok) => ok ? `<span style="background:#3FB950;color:#000;padding:2px 8px;border-radius:6px;font-weight:700;">PASS</span>` : `<span style="background:#F85149;color:#fff;padding:2px 8px;border-radius:6px;font-weight:700;">FAIL</span>`;
  const rows = r.endpoints.slice(0, 100).map((e) => `<tr><td>${e.method}</td><td>${escape(e.path)}</td><td>${e.count}</td><td>${e.ok}</td><td>${e.fail}</td><td>${(e.ok_rate*100).toFixed(1)}%</td><td>${e.p50_ms}</td><td>${e.p95_ms}</td><td>${e.p99_ms}</td></tr>`).join('');
  const errRows = r.top_errors.slice(0, 30).map((e) => `<tr><td>${escape(e.key)}</td><td>${e.count}</td><td><pre style="margin:0;white-space:pre-wrap;font-size:11px;max-width:500px;overflow:auto;">${escape((e.example && e.example.body_sample) || '')}</pre></td></tr>`).join('');
  const inv = r.pass_fail.key_invariants || {};
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>TMG sim report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0D1117; color: #E6EDF3; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 24px; }
  h2 { font-size: 16px; margin-top: 24px; border-bottom: 1px solid #30363D; padding-bottom: 6px; color: #B0B8C1; text-transform: uppercase; letter-spacing: 1px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #30363D; text-align: left; vertical-align: top; }
  th { color: #8B949E; font-weight: 600; }
  .kv { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px 24px; margin-top: 8px; }
  .kv > div { background: #161B22; border: 1px solid #30363D; padding: 8px 12px; border-radius: 6px; }
  .kv .lbl { color: #8B949E; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .kv .val { font-size: 18px; font-weight: 700; margin-top: 2px; }
  code { background: #161B22; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
</style></head>
<body>
  <h1>TrackMyGigs 1,000-user simulation</h1>
  <p>${escape(r.summary.base_url)} · seed ${r.summary.seed} · ${escape(r.summary.started_at)} → ${escape(r.summary.finished_at)} · ${(r.summary.duration_ms/1000/60).toFixed(1)} min</p>

  <h2>Pass / fail</h2>
  <div class="kv">
    <div><div class="lbl">5xx-free</div><div class="val">${okBadge(r.pass_fail.no_5xx)}</div></div>
    <div><div class="lbl">Users created</div><div class="val">${r.pass_fail.users_created} / ${r.pass_fail.users_requested}</div></div>
    <div><div class="lbl">Total requests</div><div class="val">${r.totals.total_requests.toLocaleString()}</div></div>
    <div><div class="lbl">Errors</div><div class="val">${r.totals.total_errors.toLocaleString()} (${(r.totals.error_rate*100).toFixed(2)}%)</div></div>
    <div><div class="lbl">5xx</div><div class="val">${r.totals.five_hundreds}</div></div>
    <div><div class="lbl">Flow throws</div><div class="val">${r.totals.flow_throws}</div></div>
  </div>

  <h2>DB invariants (delta)</h2>
  <div class="kv">
    <div><div class="lbl">Sim users added</div><div class="val">${inv.sim_users_added || 0}</div></div>
    <div><div class="lbl">Gigs added</div><div class="val">${inv.gigs_added || 0}</div></div>
    <div><div class="lbl">Gigs with geo</div><div class="val">${inv.gigs_with_geo_added || 0}</div></div>
    <div><div class="lbl">Invoices added</div><div class="val">${inv.invoices_added || 0}</div></div>
    <div><div class="lbl">Invoices paid</div><div class="val">${inv.invoices_paid_added || 0}</div></div>
    <div><div class="lbl">Offers added</div><div class="val">${inv.offers_added || 0}</div></div>
    <div><div class="lbl">Marketplace gigs</div><div class="val">${inv.marketplace_gigs_added || 0}</div></div>
    <div><div class="lbl">Marketplace filled</div><div class="val">${inv.marketplace_filled_added || 0}</div></div>
    <div><div class="lbl">Threads</div><div class="val">${inv.threads_added || 0}</div></div>
    <div><div class="lbl">Messages</div><div class="val">${inv.messages_added || 0}</div></div>
  </div>

  <h2>Endpoints by traffic (top 100)</h2>
  <table>
    <tr><th>Method</th><th>Path</th><th>Count</th><th>OK</th><th>Fail</th><th>OK rate</th><th>p50</th><th>p95</th><th>p99</th></tr>
    ${rows}
  </table>

  <h2>Top error groups (up to 30)</h2>
  <table>
    <tr><th>Group</th><th>Count</th><th>Example body</th></tr>
    ${errRows || '<tr><td colspan="3" style="color:#3FB950;">No errors recorded.</td></tr>'}
  </table>

  <p style="color:#6E7681;margin-top:24px;font-size:11px;">See <code>report.json</code>, <code>slowest-paths.json</code>, <code>top-errors.json</code> in this same directory for raw data.</p>
</body></html>`;
}

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// CLI entry
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node sim/report.js <runDir>');
    process.exit(1);
  }
  generate(dir);
}

module.exports = { generate };
