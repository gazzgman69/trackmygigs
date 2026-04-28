/* ===========================================================================
 * TrackMyGigs — Urgent Gigs Marketplace UI (Phase X)
 *
 * Two tabs:
 *   - Paid: gigs with a real fee (server enforces £30 floor for paid posts)
 *   - Free: gigs flagged is_free=true with a free_reason chip (charity, open
 *     mic, promo slot, favour, student showcase, other). Opt-in notifications
 *     via the notify_free_gigs user setting; the tab itself is always visible.
 *
 * Plus three sub-views under a secondary rail:
 *   - Browse (list of open gigs, filtered + sorted)
 *   - My Posts (gigs I posted)
 *   - My Applications (gigs I applied to)
 *
 * All three tabs live inside one panel (#panel-marketplace). Detail opens in
 * #panel-marketplace-detail; compose opens in #panel-marketplace-compose.
 * ========================================================================= */

(function () {
  'use strict';

  // ---------- constants ---------------------------------------------------

  const INSTRUMENT_PRESETS = [
    'vocals', 'guitar', 'bass', 'drums', 'keys', 'saxophone',
    'trumpet', 'violin', 'cello', 'dj', 'sound engineer'
  ];
  const FREE_REASONS = [
    { value: 'charity',          label: 'Charity / fundraiser' },
    { value: 'open_mic',         label: 'Open mic' },
    { value: 'promo_slot',       label: 'Promo / showcase' },
    { value: 'favour',           label: 'Favour / friend' },
    { value: 'student_showcase', label: 'Student showcase' },
    { value: 'other',            label: 'Other' },
  ];
  const SORTS = [
    { value: 'soonest',   label: 'Soonest' },
    { value: 'nearest',   label: 'Nearest' },
    { value: 'fee_high',  label: 'Fee (high)' },
    { value: 'fee_low',   label: 'Fee (low)' },
    { value: 'newest',    label: 'Newest' },
  ];
  const MODE_LABELS = { pick: 'You pick',     fcfs: 'First come first served' };
  const MODE_HINTS  = { pick: 'Applicants apply; you choose.', fcfs: 'First applicant auto-fills it.' };

  // ---------- state -------------------------------------------------------

  const state = {
    tab: 'paid',             // 'paid' | 'free'
    view: 'browse',          // 'browse' | 'posts' | 'applications'
    instruments: [],         // active filter chips
    minFeePence: null,       // number or null (Paid tab only)
    sort: 'soonest',
    q: '',                   // free-text search (title + venue)
    dateRange: 'any',        // 'any' | 'week' | 'month'
    showOutside: false,      // include posts beyond my travel radius
    filtersExpanded: false,  // collapsed by default; tap Filters to open
    paid: null,              // last fetched list for Paid
    free: null,              // last fetched list for Free
    myPosts: null,
    myApplications: null,
    loading: false,
  };

  // Expose for debugging only.
  window._marketplaceState = state;

  // ---------- helpers -----------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return esc(s).replace(/\n/g, ' '); }

  function fmtMoney(pence) {
    if (pence == null) return '';
    const p = Math.max(0, Math.round(Number(pence)));
    return '£' + (p / 100).toFixed(p % 100 === 0 ? 0 : 2);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      // Demo 2026-04-28 fix: API returns full ISO timestamps for gig_date
      // (e.g. "2026-04-29T00:00:00.000Z"), not bare YYYY-MM-DD. Appending
      // 'T00:00:00' to a full timestamp produced an invalid date string and
      // every marketplace surface rendered "Invalid Date". Detect both
      // shapes and parse correctly.
      const s = String(iso);
      const d = /T/.test(s) ? new Date(s) : new Date(s + 'T00:00:00');
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    } catch (e) { return ''; }
  }
  // In-app replacement for window.confirm() — Promise<boolean>. Used by the
  // Pick / Withdraw / Cancel-post flows because native confirm() blocks the
  // event loop in a way that breaks our automated demo + is generally a worse
  // UX than a styled modal.
  function confirmModal(message) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;';
      var box = document.createElement('div');
      box.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:20px;max-width:360px;width:100%;color:var(--text);';
      box.innerHTML = ''
        + '<div style="font-size:14px;line-height:1.4;margin-bottom:16px;">' + (String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;')) + '</div>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
        +   '<button data-act="cancel" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:18px;padding:8px 16px;font-size:13px;cursor:pointer;">Cancel</button>'
        +   '<button data-act="ok" style="background:var(--accent);color:#000;border:none;border-radius:18px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">OK</button>'
        + '</div>';
      function done(ok) { try { document.body.removeChild(overlay); } catch (_) {} resolve(ok); }
      box.querySelector('[data-act=cancel]').onclick = function () { done(false); };
      box.querySelector('[data-act=ok]').onclick = function () { done(true); };
      overlay.onclick = function (e) { if (e.target === overlay) done(false); };
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }
  function fmtTime(t) {
    if (!t) return '';
    return String(t).slice(0, 5);
  }
  function fmtDistance(miles) {
    if (miles == null) return '';
    if (miles < 1) return '< 1 mi';
    return miles.toFixed(miles < 10 ? 1 : 0) + ' mi';
  }
  function fmtRelative(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!isFinite(then)) return '';
    const diff = Math.max(0, Date.now() - then);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    // Minimal fallback
    try { console.log('[toast]', msg); } catch (e) {}
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    }, opts || {}));
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const msg = (body && body.error) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // ---------- top-level entry ---------------------------------------------

  window.openMarketplacePanel = function () {
    if (state.view === 'browse') loadBrowse(true);
    else if (state.view === 'posts') loadMyPosts();
    else if (state.view === 'applications') loadMyApplications();
    render();
  };

  // Badge count refresh (fire and forget).
  window.refreshMarketplaceBadge = async function () {
    try {
      const r = await api('/api/marketplace/badge-count');
      const badge = document.getElementById('marketplaceMenuBadge');
      if (!badge) return;
      const n = Number(r && r.count || 0);
      if (n > 0) {
        badge.textContent = String(n);
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    } catch (e) { /* ignore */ }
  };

  // ---------- render ------------------------------------------------------

  function render() {
    const body = document.getElementById('marketplaceBody');
    if (!body) return;

    const tabs = `
      <div class="mkt-tabs" style="display:flex;gap:0;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:2;background:var(--bg);">
        ${tabBtn('paid', 'Paid')}${tabBtn('free', 'Free')}
      </div>
      <div class="mkt-view-rail" style="display:flex;justify-content:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg);">
        ${viewPill('browse', 'Browse')}${viewPill('posts', 'My posts')}${viewPill('applications', 'My applications')}
      </div>`;

    let content = '';
    if (state.view === 'browse') content = renderBrowse();
    else if (state.view === 'posts') content = renderMyPosts();
    else content = renderMyApplications();

    body.innerHTML = tabs + `<div id="marketplaceContent" style="padding:12px;">${content}</div>`;
  }

  function tabBtn(id, label) {
    const active = state.tab === id;
    return `<button onclick="_mktSetTab('${id}')" style="flex:1;padding:12px 8px;background:${active?'var(--bg)':'transparent'};color:${active?'var(--accent)':'var(--text-2)'};border:none;border-bottom:2px solid ${active?'var(--accent)':'transparent'};font-size:14px;font-weight:700;cursor:pointer;">${esc(label)}</button>`;
  }
  function viewPill(id, label) {
    const active = state.view === id;
    return `<button onclick="_mktSetView('${id}')" style="padding:6px 14px;background:${active?'var(--accent)':'var(--card)'};color:${active?'#000':'var(--text)'};border:1px solid ${active?'var(--accent)':'var(--border)'};border-radius:14px;font-size:12px;font-weight:600;cursor:pointer;">${esc(label)}</button>`;
  }

  // ---------- BROWSE ------------------------------------------------------

  function renderBrowse() {
    const list = state.tab === 'paid' ? state.paid : state.free;
    const filterBar = renderFilterBar();
    if (state.loading && !list) {
      return filterBar + `<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>`;
    }
    if (!list) {
      return filterBar + `<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>`;
    }
    if (list.length === 0) {
      return filterBar + emptyBrowse();
    }
    // 2026-04-23: bucket into date sections with sticky headers so the feed
    // reads as a timeline rather than a flat list. Buckets are computed off
    // the server's ORDER BY gig_date ASC so within each group the soonest
    // gig sits first. Non-soonest sort orders (fee_high, newest, nearest)
    // still bucket the list but the visual ordering inside each bucket may
    // be less intuitive; acceptable because the user explicitly picked a
    // different sort in that case.
    const buckets = groupByDateBucket(list);
    const sections = buckets
      .filter(b => b.rows.length > 0)
      .map(b => {
        const header = `<div style="position:sticky;top:0;z-index:2;background:var(--bg);padding:10px 4px 6px;margin-top:6px;display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--border);">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-2);">${esc(b.label)}</div>
          <div style="font-size:11px;color:var(--text-3);">${b.rows.length} gig${b.rows.length===1?'':'s'}</div>
        </div>`;
        return header + b.rows.map(cardBrowse).join('');
      })
      .join('');
    return filterBar + sections;
  }

  // Group marketplace rows into labelled date buckets. Pure function; input
  // is a list already sorted by gig_date ASC, output is a list of
  // { label, rows } preserving that order. Bucket thresholds are computed
  // once per call against the user's local "today".
  function groupByDateBucket(rows) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const addDays = (d, n) => {
      const out = new Date(d);
      out.setDate(out.getDate() + n);
      return out;
    };
    const todayEnd = addDays(today, 1);
    const weekendStart = todayEnd; // anything past today up to end of week
    const nextMonday = addDays(today, 7 - today.getDay() + 1); // start of next week (Mon)
    const twoWeeksOut = addDays(today, 14);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const buckets = [
      { label: 'Today',             rows: [], lt: todayEnd },
      { label: 'This week',         rows: [], lt: nextMonday },
      { label: 'Next week',         rows: [], lt: twoWeeksOut },
      { label: 'Later this month',  rows: [], lt: endOfMonth },
      { label: 'Further out',       rows: [], lt: null },
    ];
    for (const r of rows) {
      const d = r.gig_date ? new Date(r.gig_date) : null;
      if (!d || isNaN(d)) {
        buckets[buckets.length - 1].rows.push(r);
        continue;
      }
      let placed = false;
      for (let i = 0; i < buckets.length - 1; i++) {
        if (d < buckets[i].lt) {
          buckets[i].rows.push(r);
          placed = true;
          break;
        }
      }
      if (!placed) buckets[buckets.length - 1].rows.push(r);
    }
    return buckets;
  }

  // Instrument-to-colour map for the left stripe + matching pill. Covers the
  // instruments that show up in ~99% of posts; everything else falls back to
  // a neutral gray so the card still renders cleanly.
  function instrColour(instr) {
    const s = String(instr || '').toLowerCase();
    if (s.includes('guitar')) return { stripe: '#EF9F27', pillBg: '#FAEEDA', pillText: '#633806' };
    if (s.includes('bass'))   return { stripe: '#1D9E75', pillBg: '#E1F5EE', pillText: '#085041' };
    if (s.includes('drum'))   return { stripe: '#E24B4A', pillBg: '#FCEBEB', pillText: '#791F1F' };
    if (s.includes('key') || s.includes('piano')) return { stripe: '#534AB7', pillBg: '#EEEDFE', pillText: '#3C3489' };
    if (s.includes('vocal') || s.includes('sing')) return { stripe: '#D4537E', pillBg: '#FBEAF0', pillText: '#72243E' };
    if (s.includes('horn') || s.includes('sax') || s.includes('trumpet') || s.includes('brass')) return { stripe: '#BA7517', pillBg: '#FAEEDA', pillText: '#633806' };
    if (s.includes('strings') || s.includes('violin') || s.includes('cello')) return { stripe: '#378ADD', pillBg: '#E6F1FB', pillText: '#0C447C' };
    return { stripe: '#888780', pillBg: 'rgba(136,135,128,0.15)', pillText: 'var(--text-2)' };
  }

  function emptyBrowse() {
    const freeCopy = 'No free gigs posted right now. Check back later, or post your own.';
    const paidCopy = 'No open urgent gigs match your filters. Widen your instruments or lower the fee floor.';
    const copy = state.tab === 'free' ? freeCopy : paidCopy;
    const sub = state.tab === 'free'
      ? `<div style="font-size:11px;color:var(--text-3);margin-top:10px;">Free gigs are opt-in: turn on "Notify me about free gigs" in Profile to get pinged when one is posted.</div>`
      : '';
    return `<div style="padding:32px 20px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-top:4px;">
      <div style="font-size:32px;margin-bottom:8px;">📯</div>
      <div style="color:var(--text);font-size:14px;font-weight:600;margin-bottom:6px;">${esc(copy)}</div>
      ${sub}
    </div>`;
  }

  function renderFilterBar() {
    // Count how many filters differ from defaults so the collapsed pill can
    // show an "at a glance" active-filter badge. Search query is always
    // visible so it doesn't count. Defaults: instruments empty (falls back
    // to profile), minFee null, dateRange 'any', showOutside false.
    const activeCount = (
      (Array.isArray(state.instruments) && state.instruments.length > 0 ? 1 : 0) +
      (state.minFeePence != null ? 1 : 0) +
      (state.dateRange && state.dateRange !== 'any' ? 1 : 0) +
      (state.showOutside ? 1 : 0)
    );
    const expanded = !!state.filtersExpanded;

    const chips = INSTRUMENT_PRESETS.map(instr => {
      const on = state.instruments.includes(instr);
      return `<button onclick="_mktToggleInstr('${escAttr(instr)}')" style="padding:5px 11px;background:${on?'var(--accent)':'var(--card)'};color:${on?'#000':'var(--text)'};border:1px solid ${on?'var(--accent)':'var(--border)'};border-radius:14px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">${esc(instr)}</button>`;
    }).join('');

    const sortOpts = SORTS.map(s => `<option value="${esc(s.value)}" ${state.sort===s.value?'selected':''}>${esc(s.label)}</option>`).join('');

    function dateChip(val, label) {
      const on = state.dateRange === val;
      return `<button onclick="_mktSetDateRange('${escAttr(val)}')" style="padding:5px 11px;background:${on?'var(--accent)':'var(--card)'};color:${on?'#000':'var(--text)'};border:1px solid ${on?'var(--accent)':'var(--border)'};border-radius:14px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">${esc(label)}</button>`;
    }

    const outsideOn = state.showOutside;

    // Filters badge: shows active count if > 0, else plain "Filters".
    const filtersBadge = activeCount > 0
      ? `<span style="background:var(--accent);color:#000;font-size:10px;font-weight:700;border-radius:10px;padding:1px 6px;margin-left:4px;">${activeCount}</span>`
      : '';
    const chevron = expanded ? '&#x25B4;' : '&#x25BE;';

    // Compact top row: search + filters pill + sort. Always visible, one line.
    // Removed Refresh button (filter changes auto-refresh) and moved free-tab
    // helper copy into the expanded panel.
    const topRow = `<div style="display:flex;align-items:center;gap:6px;">
      <input type="search" id="mktSearch" value="${escAttr(state.q)}" placeholder="Search gigs" oninput="_mktSetQuery(this.value)" style="flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px;" />
      <button onclick="_mktToggleFilters()" style="background:${activeCount>0?'var(--accent-dim,rgba(240,165,0,.12))':'var(--card)'};color:var(--text);border:1px solid ${activeCount>0?'var(--accent)':'var(--border)'};border-radius:8px;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;display:flex;align-items:center;">Filters${filtersBadge}<span style="margin-left:4px;font-size:9px;">${chevron}</span></button>
      <select onchange="_mktSetSort(this.value)" title="Sort" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 6px;font-size:12px;max-width:110px;">${sortOpts}</select>
    </div>`;

    // Expanded body: hidden by default. All the rich filter controls live
    // here so the common case (glance + scroll) is a single row of chrome.
    const expandedBody = expanded ? `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
        <div style="font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Instruments</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">${chips}</div>

        ${state.tab === 'paid' ? `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <span style="font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;">Min fee</span>
          <input type="number" min="0" step="10" value="${state.minFeePence == null ? '' : Math.round(state.minFeePence/100)}" placeholder="any (£30 floor)" id="mktMinFee" oninput="_mktSetMinFee(this.value)" style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12px;" />
        </div>` : `
        <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;">Free posts only: charity, open mic, showcases, favours.</div>`}

        <div style="font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Date</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
          ${dateChip('any','Any date')}${dateChip('week','This week')}${dateChip('month','This month')}
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;cursor:pointer;padding:4px 0;" onclick="_mktToggleOutside()">
          <span style="color:var(--text);">Include gigs outside my travel radius</span>
          <span style="width:36px;height:20px;border-radius:10px;background:${outsideOn?'var(--accent)':'var(--border)'};position:relative;display:inline-block;flex-shrink:0;transition:background .15s;">
            <span style="position:absolute;top:2px;left:${outsideOn?'18px':'2px'};width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;"></span>
          </span>
        </div>
      </div>` : '';

    return `<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
      ${topRow}
      ${expandedBody}
    </div>`;
  }

  function cardBrowse(gig) {
    // Detect own posts — server now returns these inline in Browse. Own
    // posts get a distinct blue outline + "YOUR POST" chip so the user
    // can see how their listing reads to everyone else while still
    // spotting it instantly.
    const callerId = (typeof window !== 'undefined' && window._currentUser && window._currentUser.id) || null;
    const isOwnPost = callerId && gig.poster_user_id && String(gig.poster_user_id) === String(callerId);

    // Pick the stripe colour off the first listed instrument. Multi-
    // instrument posts still show every pill below; the stripe just needs
    // a single anchor for the eye.
    const firstInstr = Array.isArray(gig.instruments) && gig.instruments.length > 0 ? gig.instruments[0] : '';
    const colour = instrColour(firstInstr);

    const feeLine = gig.is_free
      ? `<span style="display:inline-block;padding:2px 8px;background:var(--card);border:1px solid var(--accent);color:var(--accent);border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${esc(freeReasonLabel(gig.free_reason))}</span>`
      : `<span style="font-size:16px;font-weight:800;color:var(--accent);">${esc(fmtMoney(gig.fee_pence))}</span>`;

    const instrPills = Array.isArray(gig.instruments) && gig.instruments.length
      ? gig.instruments.map(i => {
          const c = instrColour(i);
          return `<span style="font-size:10px;background:${c.pillBg};color:${c.pillText};padding:2px 8px;border-radius:10px;font-weight:600;">${esc(i)}</span>`;
        }).join('')
      : '';

    const whenLine = `<span style="color:var(--text);font-weight:600;">${esc(fmtDate(gig.gig_date))}</span>${gig.start_time ? ' · ' + esc(fmtTime(gig.start_time)) : ''}`;
    const whereLine = gig.venue_name ? `<div style="font-size:12px;color:var(--text-2);margin-top:2px;">${esc(gig.venue_name)}${gig.venue_postcode?' · '+esc(gig.venue_postcode):''}${!isOwnPost && gig.distance_miles!=null?' · '+esc(fmtDistance(gig.distance_miles)):''}</div>` : '';

    const modeBadge = `<span style="font-size:10px;color:var(--text-2);padding:2px 6px;border:1px solid var(--border);border-radius:4px;">${esc(gig.mode === 'fcfs' ? 'FCFS' : 'Pick')}</span>`;
    const applicantBadge = gig.mode === 'pick' && gig.applicant_count > 0
      ? `<span style="font-size:10px;color:var(--accent);padding:2px 6px;border:1px solid var(--accent);border-radius:4px;">${gig.applicant_count} applicant${gig.applicant_count===1?'':'s'}</span>` : '';
    const outsideBadge = !isOwnPost && gig.outside_radius
      ? `<span style="font-size:10px;color:var(--text-2);padding:2px 6px;border:1px dashed var(--text-2);border-radius:4px;">Beyond radius</span>` : '';

    const ownChip = isOwnPost
      ? `<div style="margin-bottom:6px;"><span style="font-size:9px;background:rgba(86,156,214,0.12);color:#378ADD;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;">Your post</span></div>`
      : '';

    const outerBorder = isOwnPost ? '2px solid #378ADD' : '1px solid var(--border)';

    return `<div onclick="_mktOpenDetail(${gig.id})" style="background:var(--card);border:${outerBorder};border-radius:12px;margin-bottom:10px;cursor:pointer;overflow:hidden;display:flex;">
      <div style="width:4px;background:${colour.stripe};flex-shrink:0;"></div>
      <div style="flex:1;min-width:0;padding:12px;">
        ${ownChip}
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:700;color:var(--text);">${esc(gig.title)}</div>
            <div style="margin-top:6px;font-size:12px;">${whenLine}</div>
            ${whereLine}
          </div>
          <div style="text-align:right;flex-shrink:0;">${feeLine}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);flex-wrap:wrap;">
          ${instrPills}${modeBadge}${applicantBadge}${outsideBadge}
          <span style="flex:1;"></span>
          <span style="font-size:10px;color:var(--text-3);">${esc(fmtRelative(gig.created_at))}</span>
        </div>
      </div>
    </div>`;
  }

  function freeReasonLabel(v) {
    const r = FREE_REASONS.find(x => x.value === v);
    return r ? r.label : 'Free';
  }

  // ---------- MY POSTS ----------------------------------------------------

  function renderMyPosts() {
    const list = state.myPosts;
    if (!list) return `<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>`;
    if (list.length === 0) {
      return `<div style="padding:32px 20px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:12px;">
        <div style="font-size:32px;margin-bottom:8px;">📣</div>
        <div style="color:var(--text);font-size:14px;font-weight:600;margin-bottom:8px;">You haven't posted any urgent gigs yet.</div>
        <button onclick="openMarketplaceCompose()" style="background:var(--accent);color:#000;border:none;border-radius:18px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;margin-top:8px;">+ Post a gig</button>
      </div>`;
    }
    return list.map(cardMyPost).join('');
  }

  function cardMyPost(gig) {
    const statusLabel = gig.status === 'open' ? 'Open'
      : gig.status === 'filled' ? 'Filled'
      : gig.status === 'cancelled' ? 'Cancelled'
      : gig.status === 'expired' ? 'Expired' : gig.status;
    const statusColor = gig.status === 'open' ? 'var(--accent)'
      : gig.status === 'filled' ? '#3fb950'
      : 'var(--text-2)';
    const pickActions = gig.status === 'open' && gig.mode === 'pick' && gig.applicant_count > 0
      ? `<button onclick="event.stopPropagation();_mktOpenDetail(${gig.id})" style="background:var(--accent);color:#000;border:none;border-radius:16px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">${gig.applicant_count} applicant${gig.applicant_count===1?'':'s'} →</button>`
      : '';
    const repostBtn = (gig.status === 'cancelled' || gig.status === 'expired')
      ? `<button onclick="event.stopPropagation();_mktRepost(${gig.id})" style="background:none;color:var(--accent);border:1px solid var(--accent);border-radius:16px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">Repost</button>` : '';
    const cancelBtn = gig.status === 'open'
      ? `<button onclick="event.stopPropagation();_mktCancel(${gig.id})" style="background:none;color:var(--text-2);border:1px solid var(--border);border-radius:16px;padding:6px 12px;font-size:12px;cursor:pointer;">Cancel</button>` : '';
    const fee = gig.is_free ? freeReasonLabel(gig.free_reason) : fmtMoney(gig.fee_pence);

    return `<div onclick="_mktOpenDetail(${gig.id})" style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:10px;cursor:pointer;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:700;color:var(--text);">${esc(gig.title)}</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:4px;">${esc(fmtDate(gig.gig_date))}${gig.venue_name?' · '+esc(gig.venue_name):''}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px;">${esc(fee)} · ${esc(MODE_LABELS[gig.mode]||gig.mode)}</div>
        </div>
        <span style="font-size:11px;font-weight:700;color:${statusColor};text-transform:uppercase;letter-spacing:0.5px;">${esc(statusLabel)}</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
        ${pickActions}${repostBtn}${cancelBtn}
      </div>
    </div>`;
  }

  // ---------- MY APPLICATIONS --------------------------------------------

  function renderMyApplications() {
    const list = state.myApplications;
    if (!list) return `<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>`;
    if (list.length === 0) {
      return `<div style="padding:32px 20px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:12px;">
        <div style="font-size:32px;margin-bottom:8px;">🎯</div>
        <div style="color:var(--text);font-size:14px;font-weight:600;">You haven't applied to any urgent gigs yet.</div>
        <div style="font-size:12px;color:var(--text-2);margin-top:8px;">Head back to Browse to see what's open.</div>
      </div>`;
    }
    return list.map(cardApplication).join('');
  }

  function cardApplication(row) {
    const statusLabel = row.status === 'pending' ? 'Pending'
      : row.status === 'accepted' ? 'Accepted 🎉'
      : row.status === 'rejected' ? 'Not selected'
      : row.status;
    const statusColor = row.status === 'accepted' ? '#3fb950'
      : row.status === 'rejected' ? 'var(--text-2)' : 'var(--accent)';
    const fee = row.is_free ? freeReasonLabel(row.free_reason) : fmtMoney(row.fee_pence);
    return `<div onclick="_mktOpenDetail(${row.id})" style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:10px;cursor:pointer;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:700;color:var(--text);">${esc(row.title)}</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:4px;">${esc(fmtDate(row.gig_date))}${row.venue_name?' · '+esc(row.venue_name):''}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px;">${esc(fee)} · posted by ${esc(row.poster_name || 'someone')}</div>
        </div>
        <span style="font-size:11px;font-weight:700;color:${statusColor};text-transform:uppercase;letter-spacing:0.5px;">${esc(statusLabel)}</span>
      </div>
    </div>`;
  }

  // ---------- DETAIL ------------------------------------------------------

  window._mktOpenDetail = async function (id) {
    if (typeof openPanel === 'function') openPanel('panel-marketplace-detail');
    const body = document.getElementById('marketplaceDetailBody');
    if (body) body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>`;
    try {
      const r = await api('/api/marketplace/' + encodeURIComponent(id));
      const gig = (r && r.gig) ? r.gig : r;
      renderDetail(gig);
    } catch (e) {
      if (body) body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-2);">Couldn't load gig: ${esc(e.message || 'error')}</div>`;
    }
  };

  async function renderDetail(gig) {
    const body = document.getElementById('marketplaceDetailBody');
    if (!body) return;

    // Stash the currently rendered detail so handlers (Edit note, applicant
    // preview) can read it without another round-trip.
    state.detail = gig;

    const me = window._cachedProfile || {};
    const myId = me.id || me.user_id;
    const isPoster = String(gig.poster_user_id) === String(myId);

    const feeBlock = gig.is_free
      ? `<div style="display:inline-block;padding:6px 12px;background:var(--card);border:1px solid var(--accent);color:var(--accent);border-radius:14px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${esc(freeReasonLabel(gig.free_reason))}</div>`
      : `<div style="font-size:28px;font-weight:800;color:var(--accent);">${esc(fmtMoney(gig.fee_pence))}</div>`;

    const instrBlock = Array.isArray(gig.instruments) && gig.instruments.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">${gig.instruments.map(i=>`<span style="padding:3px 10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;font-size:11px;color:var(--text);">${esc(i)}</span>`).join('')}</div>` : '';

    const whereBlock = gig.venue_name ? `<div style="margin-top:14px;">
      <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Venue</div>
      <div style="font-size:14px;color:var(--text);">${esc(gig.venue_name)}</div>
      ${gig.venue_address?`<div style="font-size:12px;color:var(--text-2);">${esc(gig.venue_address)}</div>`:''}
      ${gig.venue_postcode?`<div style="font-size:12px;color:var(--text-2);">${esc(gig.venue_postcode)}${gig.distance_miles!=null?' · '+esc(fmtDistance(gig.distance_miles))+' from you':''}</div>`:''}
    </div>` : '';

    const whenBlock = `<div style="margin-top:14px;">
      <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">When</div>
      <div style="font-size:14px;color:var(--text);">${esc(fmtDate(gig.gig_date))}${gig.start_time?' · '+esc(fmtTime(gig.start_time)):''}${gig.end_time?' – '+esc(fmtTime(gig.end_time)):''}</div>
    </div>`;

    const descBlock = gig.description ? `<div style="margin-top:14px;">
      <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Details</div>
      <div style="font-size:13px;color:var(--text);white-space:pre-wrap;line-height:1.5;">${esc(gig.description)}</div>
    </div>` : '';

    const modeBlock = `<div style="margin-top:14px;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:10px;">
      <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${esc(MODE_LABELS[gig.mode]||gig.mode)}</div>
      <div style="font-size:12px;color:var(--text-2);">${esc(MODE_HINTS[gig.mode]||'')}</div>
    </div>`;

    const posterBlock = `<div style="margin-top:14px;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:10px;display:flex;align-items:center;gap:10px;">
      ${gig.poster_avatar_url?`<img src="${escAttr(gig.poster_avatar_url)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" />`:`<div style="width:32px;height:32px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">${esc((gig.poster_name||'?')[0])}</div>`}
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;color:var(--text);font-weight:600;">${esc(gig.poster_name || 'TrackMyGigs user')}</div>
        <div style="font-size:11px;color:var(--text-3);">Posted ${esc(fmtRelative(gig.created_at))}</div>
      </div>
    </div>`;

    // Build actions based on role / status
    let actions = '';
    if (isPoster) {
      actions = await renderPosterActions(gig);
    } else {
      actions = renderApplicantActions(gig);
    }

    body.innerHTML = `<div style="padding:14px 16px 80px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:20px;font-weight:700;color:var(--text);">${esc(gig.title)}</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">Status: ${esc(gig.status)}</div>
        </div>
        <div style="flex-shrink:0;text-align:right;">${feeBlock}</div>
      </div>
      ${instrBlock}
      ${whenBlock}
      ${whereBlock}
      ${descBlock}
      ${modeBlock}
      ${posterBlock}
      ${actions}
    </div>`;

    // If this is a poster looking at a Pick-mode open gig, load applicants.
    if (isPoster && gig.status === 'open' && gig.mode === 'pick') {
      loadApplicants(gig.id);
    }
  }

  function renderApplicantActions(gig) {
    if (gig.status === 'filled' && !gig.my_application) {
      return `<div style="margin-top:20px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px;text-align:center;">
        <div style="font-size:13px;color:var(--text-2);">This gig has been filled. Check similar open gigs on Browse.</div>
      </div>`;
    }
    if (gig.status !== 'open' && !gig.my_application) {
      return `<div style="margin-top:20px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px;text-align:center;">
        <div style="font-size:13px;color:var(--text-2);">This post is no longer active (${esc(gig.status)}).</div>
      </div>`;
    }

    // Already applied?
    const myApp = gig.my_application;
    if (myApp) {
      const s = myApp.status;
      const label = s === 'pending' ? 'Your application is in.'
        : s === 'accepted' ? 'You got this one \u{1F389}'
        : s === 'withdrawn' ? 'You withdrew this application.'
        : 'Not selected this time.';
      const noteBlock = myApp.note ? `<div style="font-size:12px;color:var(--text-2);margin-top:8px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;text-align:left;white-space:pre-wrap;">${esc(myApp.note)}</div>` : '';
      const manageRow = (s === 'pending' && gig.status === 'open')
        ? `<div style="display:flex;gap:8px;margin-top:12px;justify-content:center;flex-wrap:wrap;">
             <button onclick="_mktEditNote(${gig.id})" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:16px;padding:6px 14px;font-size:12px;cursor:pointer;">Edit note</button>
             <button onclick="_mktWithdraw(${gig.id})" style="background:none;border:1px solid var(--danger,#f85149);color:var(--danger,#f85149);border-radius:16px;padding:6px 14px;font-size:12px;cursor:pointer;">Withdraw</button>
           </div>` : '';
      // 2026-04-28 chat batch: when accepted, expose a Message button to the
      // poster. Pick endpoint already spawned a thread on the server side; we
      // call the same openChatWithUser path so a stale UI still resolves to
      // the correct thread (server dedupes 1-to-1 by participant set).
      const messageRow = (s === 'accepted' && gig.poster_user_id && typeof window.openChatWithUser === 'function')
        ? `<div style="display:flex;gap:8px;margin-top:12px;justify-content:center;flex-wrap:wrap;">
             <button onclick="window.openChatWithUser('${escAttr(gig.poster_user_id)}')" style="background:var(--accent);color:#000;border:none;border-radius:16px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;">\u{1F4AC} Message ${esc(gig.poster_name || 'the poster')}</button>
           </div>` : '';
      return `<div style="margin-top:20px;padding:14px;background:var(--card);border:1px solid var(--accent);border-radius:12px;text-align:center;">
        <div style="font-size:14px;color:var(--text);font-weight:600;">${esc(label)}</div>
        ${noteBlock}
        ${messageRow}
        ${manageRow}
      </div>`;
    }

    const cta = gig.mode === 'fcfs' ? 'Take it' : 'Apply';
    return `<div style="margin-top:20px;">
      <textarea id="mktApplyNote" placeholder="${esc(gig.mode === 'pick' ? 'Short note to the poster (optional)' : 'Optional note')}" style="width:100%;min-height:70px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:13px;resize:vertical;"></textarea>
      <button onclick="_mktApply(${gig.id})" style="margin-top:10px;width:100%;background:var(--accent);color:#000;border:none;border-radius:24px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;">${esc(cta)}</button>
    </div>`;
  }

  async function renderPosterActions(gig) {
    const cancelBtn = gig.status === 'open'
      ? `<button onclick="_mktCancel(${gig.id})" style="background:none;border:1px solid var(--border);color:var(--text-2);border-radius:18px;padding:8px 14px;font-size:13px;cursor:pointer;">Cancel post</button>` : '';
    const repostBtn = (gig.status === 'cancelled' || gig.status === 'expired' || gig.status === 'filled')
      ? `<button onclick="_mktRepost(${gig.id})" style="background:var(--accent);color:#000;border:none;border-radius:18px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;">Repost</button>` : '';
    // 2026-04-28 chat batch: as the poster, message the person who took or
    // was picked for this gig. openChatWithUser dedupes 1-to-1 threads, so
    // this resolves to the same thread the Pick endpoint just opened.
    const messageBtn = (gig.status === 'filled' && gig.filled_by_user_id && typeof window.openChatWithUser === 'function')
      ? `<button onclick="window.openChatWithUser('${escAttr(gig.filled_by_user_id)}')" style="background:var(--accent);color:#000;border:none;border-radius:18px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;">\u{1F4AC} Message ${esc(gig.filled_by_name || 'the dep')}</button>` : '';

    if (gig.mode === 'fcfs' && gig.status === 'filled') {
      return `<div style="margin-top:20px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:12px;">
        <div style="font-size:13px;color:var(--text);font-weight:600;">Filled automatically — first-come-first-served.</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px;">Filled by ${esc(gig.filled_by_name || 'someone')}.</div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">${messageBtn}${repostBtn}</div>
      </div>`;
    }

    // Pick mode open: applicants panel loads separately.
    if (gig.mode === 'pick' && gig.status === 'open') {
      return `<div style="margin-top:18px;">
        <div style="font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Applicants</div>
        <div id="marketplaceApplicants"><div style="padding:20px;text-align:center;color:var(--text-2);font-size:12px;">Loading applicants...</div></div>
        <div style="display:flex;gap:8px;margin-top:16px;">${cancelBtn}</div>
      </div>`;
    }

    return `<div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap;">${messageBtn}${cancelBtn}${repostBtn}</div>`;
  }

  async function loadApplicants(gigId) {
    const host = document.getElementById('marketplaceApplicants');
    if (!host) return;
    try {
      const r = await api('/api/marketplace/' + encodeURIComponent(gigId) + '/applicants');
      const list = (r && r.applicants) || [];
      if (list.length === 0) {
        host.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-2);font-size:12px;background:var(--card);border:1px solid var(--border);border-radius:10px;">No applicants yet. Share this gig around.</div>`;
        return;
      }
      // Stash the list so the profile-preview modal can look up the full
      // applicant object without a second fetch.
      state.applicants = list;
      host.innerHTML = list.map(a => applicantRow(gigId, a)).join('');
    } catch (e) {
      host.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-2);font-size:12px;">Couldn't load applicants.</div>`;
    }
  }

  function applicantRow(gigId, a) {
    const photo = a.photo_url || a.avatar_url;
    const avatar = photo
      ? `<img src="${escAttr(photo)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" />`
      : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-weight:700;">${esc((a.name||'?')[0])}</div>`;
    const instrs = Array.isArray(a.instruments) && a.instruments.length
      ? `<div style="font-size:11px;color:var(--text-2);margin-top:2px;">${a.instruments.map(i=>esc(i)).join(' · ')}</div>` : '';
    const note = a.note ? `<div style="font-size:12px;color:var(--text);margin-top:6px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;white-space:pre-wrap;">${esc(a.note)}</div>` : '';
    const dist = a.distance_miles != null ? ` · ${esc(fmtDistance(a.distance_miles))}` : '';
    const newBadge = a.is_new_to_tmg
      ? `<span style="margin-left:6px;padding:1px 6px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:9px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;">New</span>` : '';
    const applicantId = String(a.user_id || a.applicant_user_id || '');
    return `<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;">
        ${avatar}
        <div style="flex:1;min-width:0;cursor:pointer;" onclick="_mktShowApplicant('${escAttr(applicantId)}')">
          <div style="font-size:13px;color:var(--text);font-weight:600;text-decoration:underline;text-decoration-color:var(--text-3);text-underline-offset:2px;">${esc(a.name || 'TrackMyGigs user')}${newBadge}</div>
          ${instrs}
          <div style="font-size:10px;color:var(--text-3);">Applied ${esc(fmtRelative(a.applied_at || a.created_at))}${dist}</div>
        </div>
        <button onclick="_mktPick(${gigId}, '${escAttr(applicantId)}')" style="background:var(--accent);color:#000;border:none;border-radius:16px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;">Pick</button>
      </div>
      ${note}
    </div>`;
  }

  // Profile-preview modal: uses the applicant data already fetched by
  // loadApplicants. No second round-trip so this is instant.
  window._mktShowApplicant = function (applicantId) {
    const list = state.applicants || [];
    const a = list.find(x => String(x.user_id || x.applicant_user_id) === String(applicantId));
    if (!a) return;
    const photo = a.photo_url || a.avatar_url;
    const avatar = photo
      ? `<img src="${escAttr(photo)}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;" />`
      : `<div style="width:72px;height:72px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:28px;">${esc((a.name||'?')[0])}</div>`;
    const instrs = Array.isArray(a.instruments) && a.instruments.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">${a.instruments.map(i=>`<span style="padding:3px 10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;font-size:11px;color:var(--text);">${esc(i)}</span>`).join('')}</div>` : '';
    const gigsDone = a.gigs_completed == null ? 0 : parseInt(a.gigs_completed, 10);
    const statBlocks = `<div style="display:flex;gap:8px;margin-top:14px;">
      <div style="flex:1;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;text-align:center;">
        <div style="font-size:18px;font-weight:800;color:var(--text);">${gigsDone}</div>
        <div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;">Gigs logged</div>
      </div>
      ${a.distance_miles != null ? `<div style="flex:1;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;text-align:center;">
        <div style="font-size:18px;font-weight:800;color:var(--text);">${esc(fmtDistance(a.distance_miles))}</div>
        <div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;">From venue</div>
      </div>` : ''}
    </div>`;
    const bioBlock = a.bio
      ? `<div style="margin-top:14px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;font-size:13px;color:var(--text);white-space:pre-wrap;line-height:1.5;">${esc(a.bio)}</div>`
      : `<div style="margin-top:14px;padding:10px 12px;background:var(--bg);border:1px dashed var(--border);border-radius:10px;font-size:12px;color:var(--text-2);">No bio yet.</div>`;
    const newNote = a.is_new_to_tmg
      ? `<div style="margin-top:10px;font-size:11px;color:var(--text-2);">\u26A0 New to TrackMyGigs — no gig history yet.</div>` : '';

    const modal = document.createElement('div');
    modal.id = 'mktApplicantModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.onclick = function (e) { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;max-width:360px;width:100%;max-height:85vh;overflow:auto;">
      <div style="display:flex;align-items:center;gap:14px;">
        ${avatar}
        <div style="flex:1;min-width:0;">
          <div style="font-size:18px;font-weight:700;color:var(--text);">${esc(a.name || 'TrackMyGigs user')}</div>
          ${a.is_new_to_tmg ? `<div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">New to TrackMyGigs</div>` : ''}
        </div>
        <button onclick="document.getElementById('mktApplicantModal').remove()" style="background:none;border:none;color:var(--text-2);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
      </div>
      ${instrs}
      ${statBlocks}
      ${bioBlock}
      ${newNote}
    </div>`;
    document.body.appendChild(modal);
  };

  // ---------- COMPOSE -----------------------------------------------------

  window.openMarketplaceCompose = function () {
    if (typeof openPanel === 'function') openPanel('panel-marketplace-compose');
    const body = document.getElementById('marketplaceComposeBody');
    if (!body) return;

    // Prefill date with tomorrow (urgent = soon).
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const instrChips = INSTRUMENT_PRESETS.map(i =>
      `<button type="button" onclick="_mktComposeToggleInstr('${escAttr(i)}')" data-instr="${escAttr(i)}" class="mkt-comp-instr" style="padding:5px 11px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:14px;font-size:11px;font-weight:600;cursor:pointer;margin:0 4px 4px 0;">${esc(i)}</button>`
    ).join('');

    const freeReasonOpts = FREE_REASONS.map(r => `<option value="${esc(r.value)}">${esc(r.label)}</option>`).join('');

    // Style tokens reused across the form so the inputs feel like native
    // members of the app rather than browser defaults. The previous
    // implementation leaned on .fl/.fi classes that were never defined in
    // app.css, so labels rendered inline and inputs kept the browser's
    // white-field default. Inline styles here match the onboarding and
    // gig-wizard fields.
    const lbl = 'display:block;font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px;';
    const fld = 'width:100%;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;box-sizing:border-box;font-family:inherit;';
    const grp = 'margin-bottom:16px;';

    body.innerHTML = `<div style="padding:16px 16px 80px;">

      <div style="${grp}">
        <label for="mktCTitle" style="${lbl}">Title</label>
        <input type="text" id="mktCTitle" placeholder="e.g. Saxophone needed for Saturday wedding" style="${fld}" />
      </div>

      <div style="${grp}">
        <label style="${lbl}">Fee type</label>
        <div style="display:flex;gap:0;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:3px;">
          <label id="mktCFeeKindPaidWrap" style="flex:1;text-align:center;padding:10px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;background:var(--accent);color:#000;">
            <input type="radio" name="mktCFeeKind" value="paid" checked onchange="_mktComposeFeeKind('paid')" style="display:none;" />Paid
          </label>
          <label id="mktCFeeKindFreeWrap" style="flex:1;text-align:center;padding:10px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;color:var(--text-2);">
            <input type="radio" name="mktCFeeKind" value="free" onchange="_mktComposeFeeKind('free')" style="display:none;" />Free
          </label>
        </div>
      </div>

      <div id="mktCPaidFields" style="${grp}">
        <label for="mktCFee" style="${lbl}">Fee (£)</label>
        <input type="number" min="30" step="10" id="mktCFee" placeholder="Minimum £30" style="${fld}" />
      </div>
      <div id="mktCFreeFields" style="${grp};display:none;">
        <label for="mktCFreeReason" style="${lbl}">Why is this free?</label>
        <select id="mktCFreeReason" style="${fld}">${freeReasonOpts}</select>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:16px;">
        <div style="flex:1;">
          <label for="mktCDate" style="${lbl}">Date</label>
          <input type="date" id="mktCDate" value="${tomorrow}" style="${fld}color-scheme:dark;" />
        </div>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:16px;">
        <div style="flex:1;">
          <label for="mktCStart" style="${lbl}">Start time</label>
          <input type="time" id="mktCStart" style="${fld}color-scheme:dark;" />
        </div>
        <div style="flex:1;">
          <label for="mktCEnd" style="${lbl}">End time</label>
          <input type="time" id="mktCEnd" style="${fld}color-scheme:dark;" />
        </div>
      </div>

      <div style="${grp}">
        <label for="mktCVenue" style="${lbl}">Venue name</label>
        <input type="text" id="mktCVenue" placeholder="e.g. The Grand Hotel" style="${fld}" />
      </div>

      <div style="${grp}">
        <label for="mktCPostcode" style="${lbl}">Postcode</label>
        <input type="text" id="mktCPostcode" placeholder="SW1A 1AA" style="${fld}text-transform:uppercase;" />
      </div>

      <div style="${grp}">
        <label style="${lbl}">Instruments needed</label>
        <div id="mktCInstrChips" style="display:flex;flex-wrap:wrap;gap:6px;">${instrChips}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:8px;">Tap any that fit the slot.</div>
      </div>

      <div style="${grp}">
        <label for="mktCDesc" style="${lbl}">Details</label>
        <textarea id="mktCDesc" rows="4" placeholder="Setlist vibe, dress code, load-in notes, anything else the dep needs to know." style="${fld}resize:vertical;min-height:96px;"></textarea>
      </div>

      <div style="${grp}">
        <label style="${lbl}">Application mode</label>
        <div style="display:flex;gap:8px;">
          <label style="flex:1;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <input type="radio" name="mktCMode" value="pick" checked />
              <div style="font-weight:600;color:var(--text);font-size:13px;">You pick</div>
            </div>
            <div style="color:var(--text-2);font-size:11px;line-height:1.4;">See applicants, choose one. Best for paid gigs.</div>
          </label>
          <label style="flex:1;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <input type="radio" name="mktCMode" value="fcfs" />
              <div style="font-weight:600;color:var(--text);font-size:13px;">First come, first served</div>
            </div>
            <div style="color:var(--text-2);font-size:11px;line-height:1.4;">First applicant auto-fills the slot.</div>
          </label>
        </div>
      </div>

      <button onclick="_mktComposeSubmit()" style="margin-top:8px;width:100%;background:var(--accent);color:#000;border:none;border-radius:24px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;">Post gig</button>
      <div id="mktComposeError" style="margin-top:10px;color:var(--danger,#f85149);font-size:12px;text-align:center;display:none;"></div>
    </div>`;

    window._mktComposeInstruments = new Set();
  };

  window._mktComposeToggleInstr = function (instr) {
    const set = window._mktComposeInstruments || new Set();
    if (set.has(instr)) set.delete(instr); else set.add(instr);
    window._mktComposeInstruments = set;
    const btn = document.querySelector(`.mkt-comp-instr[data-instr="${CSS.escape(instr)}"]`);
    if (btn) {
      const on = set.has(instr);
      btn.style.background = on ? 'var(--accent)' : 'var(--card)';
      btn.style.color = on ? '#000' : 'var(--text)';
      btn.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
    }
  };

  window._mktComposeFeeKind = function (kind) {
    document.getElementById('mktCPaidFields').style.display = kind === 'paid' ? 'block' : 'none';
    document.getElementById('mktCFreeFields').style.display = kind === 'free' ? 'block' : 'none';
    // Flip the segmented-control styling so the active side reads as
    // selected. Both wrappers start with matching padding/radius; we swap
    // background and text colour only.
    const paidWrap = document.getElementById('mktCFeeKindPaidWrap');
    const freeWrap = document.getElementById('mktCFeeKindFreeWrap');
    if (paidWrap && freeWrap) {
      if (kind === 'paid') {
        paidWrap.style.background = 'var(--accent)';
        paidWrap.style.color = '#000';
        freeWrap.style.background = 'transparent';
        freeWrap.style.color = 'var(--text-2)';
      } else {
        freeWrap.style.background = 'var(--accent)';
        freeWrap.style.color = '#000';
        paidWrap.style.background = 'transparent';
        paidWrap.style.color = 'var(--text-2)';
      }
    }
    // Default Free posts to FCFS (you typically don't curate a free slot).
    if (kind === 'free') {
      const fc = document.querySelector('input[name="mktCMode"][value="fcfs"]');
      if (fc) fc.checked = true;
    } else {
      const pk = document.querySelector('input[name="mktCMode"][value="pick"]');
      if (pk) pk.checked = true;
    }
  };

  window._mktComposeSubmit = async function () {
    const err = document.getElementById('mktComposeError');
    if (err) { err.style.display = 'none'; err.textContent = ''; }
    const title = (document.getElementById('mktCTitle').value || '').trim();
    const date  = document.getElementById('mktCDate').value;
    const feeKind = (document.querySelector('input[name="mktCFeeKind"]:checked') || {}).value || 'paid';
    const feePounds = parseInt(document.getElementById('mktCFee').value || '0', 10);
    const freeReason = document.getElementById('mktCFreeReason').value;
    const mode = (document.querySelector('input[name="mktCMode"]:checked') || {}).value || 'pick';
    const instruments = Array.from(window._mktComposeInstruments || []);
    const startTime = document.getElementById('mktCStart').value || null;
    const endTime = document.getElementById('mktCEnd').value || null;
    const venueName = (document.getElementById('mktCVenue').value || '').trim() || null;
    const postcode = (document.getElementById('mktCPostcode').value || '').trim() || null;
    const description = (document.getElementById('mktCDesc').value || '').trim() || null;

    if (!title) return showErr('Title is required.');
    if (!date) return showErr('Pick a date.');
    if (instruments.length === 0) return showErr('Pick at least one instrument.');
    if (feeKind === 'paid') {
      if (!feePounds || feePounds < 30) return showErr('Paid posts need a fee of at least £30. Switch to Free for charity / open mic / favours.');
    }

    const payload = {
      title,
      description,
      venue_name: venueName,
      venue_postcode: postcode,
      gig_date: date,
      start_time: startTime,
      end_time: endTime,
      instruments,
      is_free: feeKind === 'free',
      fee_pence: feeKind === 'paid' ? feePounds * 100 : 0,
      free_reason: feeKind === 'free' ? freeReason : null,
      mode,
    };

    try {
      const r = await api('/api/marketplace', { method: 'POST', body: JSON.stringify(payload) });
      toast('Posted. Musicians can see it now.');
      if (typeof closePanel === 'function') closePanel('panel-marketplace-compose');
      // Refresh the user's My Posts and Browse so the new entry shows up immediately.
      state.view = 'posts'; state.tab = feeKind === 'free' ? 'free' : 'paid';
      await loadMyPosts();
      render();
      refreshMarketplaceBadge();
    } catch (e) {
      showErr(e.message || 'Couldn\u2019t post.');
    }

    function showErr(m) {
      if (err) { err.textContent = m; err.style.display = 'block'; }
      else toast(m);
    }
  };

  // ---------- actions -----------------------------------------------------

  window._mktSetTab = function (tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    if (state.view === 'browse') loadBrowse(true);
    render();
  };
  window._mktSetView = function (view) {
    if (state.view === view) return;
    state.view = view;
    if (view === 'browse') loadBrowse(true);
    else if (view === 'posts') loadMyPosts();
    else if (view === 'applications') loadMyApplications();
    render();
  };
  window._mktToggleInstr = function (instr) {
    const i = state.instruments.indexOf(instr);
    if (i >= 0) state.instruments.splice(i, 1); else state.instruments.push(instr);
    loadBrowse(true);
    render();
  };
  window._mktSetMinFee = function (val) {
    const n = parseInt(val, 10);
    state.minFeePence = isFinite(n) && n >= 0 ? n * 100 : null;
    clearTimeout(window._mktFeeDeb);
    window._mktFeeDeb = setTimeout(() => { loadBrowse(true); render(); }, 350);
  };
  window._mktSetSort = function (val) {
    state.sort = val;
    loadBrowse(true);
    render();
  };
  window._mktReload = function () { loadBrowse(true); };
  window._mktSetQuery = function (val) {
    state.q = (val || '').trim();
    clearTimeout(window._mktQDeb);
    // Debounce so each keystroke doesn't hit the API.
    window._mktQDeb = setTimeout(() => { loadBrowse(true); }, 300);
  };
  window._mktSetDateRange = function (val) {
    if (state.dateRange === val) val = 'any';
    state.dateRange = val;
    loadBrowse(true);
    render();
  };
  window._mktToggleOutside = function () {
    state.showOutside = !state.showOutside;
    loadBrowse(true);
    render();
  };
  // Toggle the expanded filter panel. Purely a view-state flip; no network.
  window._mktToggleFilters = function () {
    state.filtersExpanded = !state.filtersExpanded;
    render();
    // Refocus the search input if the panel just collapsed and the user's
    // next action is typing; if expanded, scroll the panel into view so the
    // new controls don't sit below the fold.
    if (state.filtersExpanded) {
      requestAnimationFrame(() => {
        const el = document.getElementById('mktMinFee');
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    }
  };

  window._mktApply = async function (gigId) {
    const noteEl = document.getElementById('mktApplyNote');
    const note = noteEl ? (noteEl.value || '').trim() : '';
    try {
      const r = await api('/api/marketplace/' + encodeURIComponent(gigId) + '/apply', {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      if (r && r.status === 'accepted') {
        toast('Got it — that one\u2019s yours.');
      } else {
        toast('Application sent.');
      }
      // Refresh detail view
      const r2 = await api('/api/marketplace/' + encodeURIComponent(gigId));
      renderDetail((r2 && r2.gig) ? r2.gig : r2);
      refreshMarketplaceBadge();
    } catch (e) {
      toast(e.message || 'Couldn\u2019t apply.');
    }
  };

  window._mktWithdraw = async function (gigId) {
    if (!(await confirmModal('Withdraw your application? You can re-apply while the post is still open.'))) return;
    try {
      await api('/api/marketplace/' + encodeURIComponent(gigId) + '/withdraw', { method: 'POST' });
      toast('Application withdrawn.');
      const r2 = await api('/api/marketplace/' + encodeURIComponent(gigId));
      renderDetail((r2 && r2.gig) ? r2.gig : r2);
      refreshMarketplaceBadge();
      // My Applications list reads status live, so refresh it too.
      if (state.view === 'applications') {
        loadMyApplications().then(() => render());
      }
    } catch (e) {
      toast(e.message || 'Couldn\u2019t withdraw.');
    }
  };

  window._mktEditNote = async function (gigId) {
    // Pull the current note out of the rendered state so the prompt is seeded.
    const existing = (state.detail && state.detail.my_application && state.detail.my_application.note) || '';
    const next = prompt('Update your note to the poster:', existing);
    if (next == null) return; // Cancel
    try {
      await api('/api/marketplace/' + encodeURIComponent(gigId) + '/application', {
        method: 'PATCH',
        body: JSON.stringify({ note: next.slice(0, 1000) }),
      });
      toast('Note updated.');
      const r2 = await api('/api/marketplace/' + encodeURIComponent(gigId));
      renderDetail((r2 && r2.gig) ? r2.gig : r2);
    } catch (e) {
      toast(e.message || 'Couldn\u2019t update note.');
    }
  };

  window._mktPick = async function (gigId, userId) {
    if (!(await confirmModal('Pick this applicant? Others will be notified they weren\u2019t selected.'))) return;
    try {
      await api('/api/marketplace/' + encodeURIComponent(gigId) + '/pick', {
        method: 'POST',
        body: JSON.stringify({ applicant_user_id: userId }),
      });
      toast('Picked. Applicant has been notified.');
      const r2 = await api('/api/marketplace/' + encodeURIComponent(gigId));
      renderDetail((r2 && r2.gig) ? r2.gig : r2);
    } catch (e) {
      toast(e.message || 'Couldn\u2019t pick.');
    }
  };

  window._mktCancel = async function (gigId) {
    if (!(await confirmModal('Cancel this post? Applicants will be notified.'))) return;
    try {
      await api('/api/marketplace/' + encodeURIComponent(gigId) + '/cancel', { method: 'POST' });
      toast('Post cancelled.');
      if (typeof closePanel === 'function') closePanel('panel-marketplace-detail');
      await loadMyPosts();
      render();
    } catch (e) {
      toast(e.message || 'Couldn\u2019t cancel.');
    }
  };

  window._mktRepost = async function (gigId) {
    try {
      const r = await api('/api/marketplace/' + encodeURIComponent(gigId) + '/repost', { method: 'POST' });
      toast('Reposted.');
      if (typeof closePanel === 'function') closePanel('panel-marketplace-detail');
      await loadMyPosts();
      render();
    } catch (e) {
      toast(e.message || 'Couldn\u2019t repost.');
    }
  };

  // ---------- data loads --------------------------------------------------

  function computeDateBounds(range) {
    if (range !== 'week' && range !== 'month') return {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = today.toISOString().slice(0, 10);
    const end = new Date(today);
    if (range === 'week') end.setDate(end.getDate() + 7);
    else end.setMonth(end.getMonth() + 1);
    const to = end.toISOString().slice(0, 10);
    return { from, to };
  }

  async function loadBrowse(silent) {
    state.loading = true;
    if (!silent) render();
    const params = new URLSearchParams();
    // Backend expects is_free=true/false rather than tab= — flip here.
    params.set('is_free', state.tab === 'free' ? 'true' : 'false');
    params.set('sort', state.sort);
    if (state.instruments.length) params.set('instrument', state.instruments.join(','));
    if (state.tab === 'paid' && state.minFeePence != null) params.set('min_fee_pence', String(state.minFeePence));
    if (state.q) params.set('q', state.q);
    if (state.showOutside) params.set('show_outside_radius', 'true');
    const bounds = computeDateBounds(state.dateRange);
    if (bounds.from) params.set('date_from', bounds.from);
    if (bounds.to)   params.set('date_to',   bounds.to);
    try {
      const r = await api('/api/marketplace?' + params.toString());
      const list = (r && r.gigs) || [];
      if (state.tab === 'paid') state.paid = list;
      else state.free = list;
    } catch (e) {
      if (state.tab === 'paid') state.paid = [];
      else state.free = [];
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadMyPosts() {
    try {
      const r = await api('/api/marketplace/mine');
      state.myPosts = (r && r.gigs) || [];
    } catch (e) {
      state.myPosts = [];
    }
    render();
  }

  async function loadMyApplications() {
    try {
      const r = await api('/api/marketplace/applications/mine');
      state.myApplications = (r && r.applications) || [];
    } catch (e) {
      state.myApplications = [];
    }
    render();
  }

  // Refresh badge count on script load + every 60s while a tab is focused.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => refreshMarketplaceBadge(), 1500);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => refreshMarketplaceBadge(), 1500));
  }
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshMarketplaceBadge();
  }, 60000);

})();
