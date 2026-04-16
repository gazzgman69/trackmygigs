let currentUser = null;
let currentScreen = 'home';

// Wizard state
let gigWizardStep = 1;
let gigWizardData = {};
window._cachedGigs = null;
window._cachedStats = null;
window._cachedStatsTime = 0;
window._cachedProfile = null;
window._cachedProfileTime = 0;
window._calViewMode = 'month';
window._calDate = new Date();

// Cache TTL in ms (30 seconds for stats, 60 seconds for profile)
const STATS_CACHE_TTL = 30000;
const PROFILE_CACHE_TTL = 60000;

function initApp(user) {
  currentUser = user;
  window._currentUser = user;
  setupThemeToggle();
  setupNavigation();
  setupScreenHandlers();

  // Update the fixed header with user info
  updateAppHeader();

  // showScreen('home') already calls renderHomeScreen - no need to call it twice
  showScreen('home');

  // Pre-fetch gigs in background so they're instant when the user taps the tab
  prefetchGigs();
}

function updateAppHeader() {
  const name = window._currentUser?.name || 'Guest';
  const initial = (name || 'G')[0].toUpperCase();
  const hour = new Date().getHours();
  let greeting = 'Good morning';
  if (hour >= 12 && hour < 18) greeting = 'Good afternoon';
  if (hour >= 18) greeting = 'Good evening';

  const avatarEl = document.getElementById('userAvatar');
  if (avatarEl) avatarEl.textContent = initial;

  const greetingEl = document.getElementById('greeting');
  if (greetingEl) greetingEl.textContent = `${greeting}, ${name}`;
}

async function prefetchGigs() {
  try {
    const res = await fetch('/api/gigs');
    if (res.ok) {
      window._cachedGigs = await res.json();
    }
  } catch {
    // silently ignore - will fetch when tab is tapped
  }
}

function setupThemeToggle() {
  const themeToggle = document.getElementById('themeToggle');
  const savedTheme = localStorage.getItem('theme') || 'dark';

  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
    themeToggle.textContent = '☀️';
  } else {
    document.body.classList.remove('light-mode');
    themeToggle.textContent = '🌙';
  }

  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('light-mode');
    const newTheme = document.body.classList.contains('light-mode')
      ? 'light'
      : 'dark';
    localStorage.setItem('theme', newTheme);
    themeToggle.textContent = newTheme === 'light' ? '☀️' : '🌙';
  });
}

function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const screen = item.getAttribute('data-screen');
      showScreen(screen);
    });
  });

  const quickActions = document.querySelectorAll('.nav-quick-btn');
  quickActions.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      handleQuickAction(action);
    });
  });
}

function setupScreenHandlers() {
  setupGigsScreen();
  setupInvoicesScreen();
  setupOffersScreen();
}

function showScreen(screenName) {
  const screens = document.querySelectorAll('.app-content .screen');
  screens.forEach((s) => s.classList.remove('active'));

  const screen = document.getElementById(`${screenName}Screen`);
  if (screen) {
    screen.classList.add('active');
  }

  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.classList.remove('active');
  });

  const activeNav = document.querySelector(
    `.nav-item[data-screen="${screenName}"]`
  );
  if (activeNav) {
    activeNav.classList.add('active');
  }

  currentScreen = screenName;

  if (screenName === 'home') {
    renderHomeScreen();
  } else if (screenName === 'gigs') {
    renderGigsScreen();
  } else if (screenName === 'calendar') {
    renderCalendarScreen();
  } else if (screenName === 'invoices') {
    renderInvoicesScreen();
  } else if (screenName === 'offers') {
    renderOffersScreen();
  } else if (screenName === 'profile') {
    renderProfileScreen();
  }
}

async function fetchStatsWithCache(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && window._cachedStats && (now - window._cachedStatsTime) < STATS_CACHE_TTL) {
    return window._cachedStats;
  }
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error('Failed to fetch stats');
  const stats = await res.json();
  window._cachedStats = stats;
  window._cachedStatsTime = now;
  return stats;
}

async function renderHomeScreen() {
  const content = document.getElementById('homeScreen');

  // If we have cached stats, render immediately (no loading flash)
  if (window._cachedStats && (Date.now() - window._cachedStatsTime) < STATS_CACHE_TTL) {
    buildHomeHTML(content, window._cachedStats);
    return;
  }

  // Show loading state only on first load
  content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading home screen...</div>';

  try {
    const stats = await fetchStatsWithCache(false);
    buildHomeHTML(content, stats);
  } catch (err) {
    console.error('Home screen error:', err);
    content.innerHTML = `
      <div style="padding:40px 20px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#9888;&#65039;</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">Couldn't load home</div>
        <div style="font-size:13px;color:var(--text-2);">Check your connection and refresh</div>
      </div>`;
  }
}

function buildHomeHTML(content, stats) {
    // Update notification dot in the fixed header
    const notifDot = document.getElementById('notificationDot');
    if (notifDot) notifDot.style.display = stats.unread_notifications > 0 ? 'block' : 'none';

    // Build HTML (header is handled by the fixed app-header, no duplicate here)
    let html = '';

    // Offer alert banner
    if (stats.offer_count > 0) {
      html += `
      <div onclick="showScreen('offers')" style="margin:6px 16px;background:linear-gradient(135deg,rgba(240,165,0,.15) 0%,rgba(240,165,0,.06) 100%);border:1px solid rgba(240,165,0,.4);border-radius:var(--r);padding:12px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;">
        <div style="font-size:22px;">📬</div>
        <div style="flex:1;">
          <div class="ho-count" style="font-size:14px;font-weight:600;color:var(--text);">${stats.offer_count} gig offer${stats.offer_count === 1 ? '' : 's'} waiting</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
            ${stats.network_offers > 0 ? `<span style="font-size:10px;font-weight:700;color:#000;background:var(--accent);padding:1px 6px;border-radius:3px;">${stats.network_offers} FROM YOUR NETWORK</span>` : ''}
          </div>
        </div>
        <div style="color:var(--accent);font-size:20px;">›</div>
      </div>`;
    }

    // Next gig card
    if (stats.next_gig) {
      const gig = stats.next_gig;
      const daysUntil = Math.ceil((new Date(gig.date) - new Date()) / (1000 * 60 * 60 * 24));
      html += `
      <div onclick="openGigDetail('${gig.id}')" style="margin:0 16px 8px;background:linear-gradient(135deg,#1C2A1A,#182318);border:1px solid rgba(63,185,80,.3);border-radius:var(--r);padding:12px 14px;position:relative;cursor:pointer;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <span style="font-size:10px;font-weight:600;color:var(--success);letter-spacing:1px;text-transform:uppercase;">⚡ Your next gig</span>
          <span style="margin-left:auto;font-size:12px;font-weight:800;color:var(--success);">${daysUntil} day${daysUntil === 1 ? '' : 's'}</span>
        </div>
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px;">${escapeHtml(gig.band_name)}</div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:2px;">📍 ${escapeHtml(gig.venue_name)} · 🕖 ${formatDateLong(gig.date)} · ${formatTime(gig.start_time)}${gig.end_time ? ' to ' + formatTime(gig.end_time) : ''}</div>
        ${gig.dress_code ? `<div style="font-size:12px;color:var(--text-2);">👔 ${escapeHtml(gig.dress_code)} · 🎒 Gig pack ready</div>` : ''}
      </div>`;
    }

    // Compact alert row
    html += `<div style="display:flex;gap:6px;margin:0 16px 6px;">`;

    if (stats.overdue_invoices > 0) {
      html += `
      <div onclick="openPanel('invoices-panel')" style="flex:1;background:var(--danger-dim);border:1px solid rgba(248,81,73,.2);border-radius:var(--rs);padding:8px 10px;cursor:pointer;">
        <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">📄 Invoice</div>
        <div style="font-size:11px;font-weight:600;color:var(--danger);">£${stats.overdue_total} overdue</div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px;">${stats.overdue_invoices} invoice${stats.overdue_invoices === 1 ? '' : 's'}</div>
      </div>`;
    }

    if (stats.draft_invoices > 0) {
      html += `
      <div onclick="openPanel('invoices-panel')" style="flex:1;background:var(--info-dim);border:1px solid rgba(88,166,255,.2);border-radius:var(--rs);padding:8px 10px;cursor:pointer;">
        <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">📄 Invoice</div>
        <div style="font-size:11px;font-weight:600;color:var(--info);">£${stats.draft_total} draft</div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px;">${stats.draft_invoices} ready</div>
      </div>`;
    }

    html += `
      <div onclick="showScreen('calendar')" style="flex:1;background:var(--accent-dim);border:1px solid rgba(240,165,0,.2);border-radius:var(--rs);padding:8px 10px;cursor:pointer;">
        <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">📅 Calendar</div>
        <div style="font-size:11px;font-weight:600;color:var(--accent);">Availability</div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px;">Update now</div>
      </div>
    </div>`;

    // Gig messages card
    if (stats.unread_messages > 0) {
      html += `
      <div onclick="openPanel('chat-inbox')" style="margin:0 16px 6px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;cursor:pointer;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:14px;">💬</span>
            <span style="font-size:12px;font-weight:700;color:var(--text);">Gig messages</span>
          </div>
          <div style="background:var(--accent);color:#000;font-size:10px;font-weight:800;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 5px;">${stats.unread_messages}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${(stats.recent_messages || []).slice(0, 2).map((msg) => `
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:24px;height:24px;border-radius:12px;background:var(--info-dim);border:1px solid var(--info);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--info);flex-shrink:0;">${(msg.sender || 'U')[0].toUpperCase()}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:11px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(msg.sender)}</div>
              <div style="font-size:10px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(msg.preview || '')}</div>
            </div>
            <span style="font-size:9px;color:var(--accent);font-weight:600;flex-shrink:0;">${msg.time_ago || 'now'}</span>
          </div>`).join('')}
        </div>
      </div>`;
    }

    // Quick stats
    html += `
    <div style="display:flex;gap:6px;margin:0 16px 6px;">
      <div style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px 12px;">
        <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">This month</div>
        <div style="font-size:13px;font-weight:700;color:var(--success);">£${stats.month_earnings || 0}</div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px;">${stats.month_gigs || 0} gig${stats.month_gigs === 1 ? '' : 's'}</div>
      </div>
      <div style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px 12px;">
        <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Tax year</div>
        <div style="font-size:13px;font-weight:700;color:var(--success);">£${stats.year_earnings || 0}</div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px;">${stats.year_gigs || 0} gig${stats.year_gigs === 1 ? '' : 's'}</div>
      </div>
    </div>`;

    // 12-month forecast
    if (stats.monthly_breakdown) {
      html += `
      <div style="margin:0 16px 6px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">12-Month Forecast</div>
        <div style="display:flex;align-items:flex-end;gap:2px;height:60px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:8px;">
          ${stats.monthly_breakdown.map((m) => {
            const height = Math.min(100, (m.earnings / (Math.max(...stats.monthly_breakdown.map(x => x.earnings)) || 1)) * 100);
            const color = m.status === 'confirmed' ? 'var(--success)' : m.status === 'forecast' ? '#666' : 'var(--warning)';
            return `<div style="flex:1;background:${color};border-radius:2px;opacity:${height < 5 ? 0.4 : 1};height:${Math.max(4, height)}%;" title="£${m.earnings}"></div>`;
          }).join('')}
        </div>
      </div>`;
    }

    html += '</div>';
    content.innerHTML = html;
}

// Current gig view state
let gigViewMode = 'week';

async function renderGigsScreen() {
  const content = document.getElementById('gigsScreen');
  const cached = window._cachedGigs;

  content.innerHTML = `
    <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:24px;font-weight:700;color:var(--text);">My Gigs</div>
      <button style="background:var(--accent);color:#000;border:none;border-radius:24px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;" onclick="openGigWizard()">+ New</button>
    </div>
    <div style="padding:0 16px 8px;">
      <input type="text" class="form-input" id="gigSearchInput" placeholder="Search gigs - band, venue, date..." oninput="filterGigsList()" style="font-size:14px;padding:10px 14px;">
    </div>
    <div style="display:flex;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;overflow-x:auto;" id="gigTabBar">
      <div class="gig-tab active" onclick="switchGigTab(this,'week')">Weekly</div>
      <div class="gig-tab" onclick="switchGigTab(this,'month')">Monthly</div>
      <div class="gig-tab" onclick="switchGigTab(this,'year')">Yearly</div>
    </div>
    <div id="calendarNudgeBar" style="display:none;"></div>
    <div style="padding:0 16px;" id="gigsListContent">
      ${cached ? '' : '<div style="text-align:center;padding:40px;color:var(--text-2);">Loading...</div>'}
    </div>
  `;

  if (cached) {
    renderGigsList(cached);
  }

  // Check for calendar imports to review (non-blocking)
  checkCalendarNudges();

  try {
    const response = await fetch('/api/gigs');
    if (!response.ok) throw new Error('Failed to fetch');
    const gigs = await response.json();
    window._cachedGigs = gigs;
    renderGigsList(gigs);
  } catch (err) {
    console.error('Load gigs error:', err);
    if (!cached) {
      const listContent = document.getElementById('gigsListContent');
      if (listContent) {
        listContent.innerHTML = `
          <div style="text-align:center;padding:40px;">
            <div style="font-size:32px;margin-bottom:8px;">📋</div>
            <div style="font-weight:600;color:var(--text);margin-bottom:4px;">Couldn't load gigs</div>
            <div style="font-size:13px;color:var(--text-2);">Check your connection and try again</div>
          </div>
        `;
      }
    }
  }
}

async function checkCalendarNudges() {
  const bar = document.getElementById('calendarNudgeBar');
  if (!bar) return;
  try {
    const resp = await fetch('/api/calendar/events');
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.connected) return;
    const toReview = (data.events || []).filter(e => !e.already_imported);
    if (toReview.length === 0) {
      bar.style.display = 'none';
      return;
    }
    window._calendarNudges = toReview;
    bar.style.display = 'block';
    bar.innerHTML = `
      <div onclick="openGigNudge()" style="margin:8px 16px;padding:12px 16px;background:var(--accent-dim);border:1px solid rgba(0,207,130,.3);border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">📅</span>
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--text);">${toReview.length} import${toReview.length === 1 ? '' : 's'} to review</div>
            <div style="font-size:11px;color:var(--text-2);">Found possible gigs in your calendar</div>
          </div>
        </div>
        <span style="font-size:18px;color:var(--accent);">&#8250;</span>
      </div>
    `;
  } catch (e) {
    // Silent fail - calendar nudges are optional
  }
}

function switchGigTab(el, mode) {
  gigViewMode = mode;
  document.querySelectorAll('.gig-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  if (window._cachedGigs) renderGigsList(window._cachedGigs);
}

function filterGigsList() {
  if (window._cachedGigs) renderGigsList(window._cachedGigs);
}

function renderGigsList(gigs) {
  const listContent = document.getElementById('gigsListContent');
  if (!listContent) return;

  // Apply search filter
  const searchQuery = (document.getElementById('gigSearchInput')?.value || '').toLowerCase().trim();
  let filtered = gigs;
  if (searchQuery) {
    filtered = gigs.filter(g =>
      (g.band_name || '').toLowerCase().includes(searchQuery) ||
      (g.venue_name || '').toLowerCase().includes(searchQuery) ||
      (g.date || '').includes(searchQuery)
    );
  }

  // Apply view mode filter
  const now = new Date();
  if (gigViewMode === 'week') {
    // Show current week and next 7 days + past gigs this week
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    // Show all upcoming if within-week is empty
    const weekGigs = filtered.filter(g => {
      const d = new Date(g.date + 'T12:00:00');
      return d >= weekStart && d <= weekEnd;
    });
    if (weekGigs.length > 0) {
      filtered = weekGigs;
    }
    // If no gigs this week, show all upcoming
  } else if (gigViewMode === 'month') {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const monthGigs = filtered.filter(g => {
      const d = new Date(g.date + 'T12:00:00');
      return d >= monthStart && d <= monthEnd;
    });
    if (monthGigs.length > 0) filtered = monthGigs;
  }
  // 'year' shows all

  if (filtered.length === 0) {
    listContent.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <div style="font-size:32px;margin-bottom:8px;">🎸</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">No gigs ${searchQuery ? 'matching "' + escapeHtml(searchQuery) + '"' : 'yet'}</div>
        <div style="font-size:13px;color:var(--text-2);">Tap + New to log your first gig</div>
      </div>
    `;
    return;
  }

  // Sort by date ascending (upcoming first)
  filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  listContent.innerHTML = filtered
    .map((gig) => {
      const dateObj = gig.date ? new Date(gig.date.substring(0, 10) + 'T12:00:00') : null;
      const dayNum = dateObj ? dateObj.getDate() : '?';
      const monthAbbr = dateObj ? dateObj.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase() : '';

      // Mini badges
      let badges = '';
      if (!gig.fee || parseFloat(gig.fee) === 0) {
        badges += '<span style="font-size:9px;background:var(--info-dim);color:var(--info);border-radius:6px;padding:2px 6px;font-weight:600;">Draft inv</span>';
      }
      if (gig.dress_code) {
        badges += '<span style="font-size:9px;background:var(--success-dim);color:var(--success);border-radius:6px;padding:2px 6px;font-weight:600;">Pack ready</span>';
      }

      return `
      <div class="gi" onclick="openGigDetail('${gig.id}')">
        <div style="display:flex;align-items:flex-start;gap:14px;">
          <div class="gdb">
            <div class="gdd">${dayNum}</div>
            <div class="gdm">${monthAbbr}</div>
          </div>
          <div style="flex:1;min-width:0;">
            <div class="gt">${escapeHtml(gig.band_name || 'Unnamed Gig')}</div>
            <div class="gv">${escapeHtml(gig.venue_name || 'No venue')}${gig.start_time ? ' \u00B7 ' + formatTime(gig.start_time) + (gig.end_time ? '\u2013' + formatTime(gig.end_time) : '') : ''}</div>
            ${gig.load_in_time ? `<div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">Load-in ${formatTime(gig.load_in_time)}</div>` : ''}
            <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
              <span class="badge badge-${statusBadgeClass(gig.status)}" style="font-size:11px;">${statusLabel(gig.status)}</span>
              ${gig.fee ? `<span class="gf">\u00A3${parseFloat(gig.fee).toFixed(0)}</span>` : ''}
              ${badges ? `<div style="display:flex;gap:4px;margin-left:auto;">${badges}</div>` : ''}
            </div>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

function statusBadgeClass(status) {
  const map = {
    confirmed: 'success',
    tentative: 'warning',
    enquiry: 'info',
    cancelled: 'danger',
    depped_out: 'info',
  };
  return map[status] || 'info';
}

function statusLabel(status) {
  const map = {
    confirmed: 'Confirmed',
    tentative: 'Pencilled',
    enquiry: 'Enquiry',
    cancelled: 'Cancelled',
    depped_out: 'Depped Out',
  };
  return map[status] || status;
}

async function renderCalendarScreen() {
  const content = document.getElementById('calendarScreen');

  // Use cached gigs if available for instant render
  const cachedGigs = window._cachedGigs;
  if (!cachedGigs) {
    content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading calendar...</div>';
  }

  try {
    // Use cached gigs or fetch fresh ones
    let gigsData;
    if (cachedGigs) {
      gigsData = cachedGigs;
    } else {
      const gigsRes = await fetch('/api/gigs');
      gigsData = gigsRes.ok ? await gigsRes.json() : [];
      window._cachedGigs = gigsData;
    }

    const blockedRes = await fetch('/api/blocked-dates');
    const blockedData = blockedRes.ok ? await blockedRes.json() : [];

    const view = window._calViewMode || 'month';
    const currentDate = window._calDate || new Date();

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:24px;font-weight:700;color:var(--text);">Calendar</div>
        <div style="display:flex;gap:8px;">
          <div onclick="toggleCalendarMenu()" style="width:32px;height:32px;border-radius:16px;background:var(--card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;">⋯</div>
        </div>
      </div>
      <div id="calendarMenu" style="display:none;margin:0 16px 8px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:8px;z-index:10;">
        <div onclick="handleCalendarAction('add-gig')" style="padding:12px 14px;cursor:pointer;color:var(--text);font-size:14px;">Add gig</div>
        <div onclick="handleCalendarAction('add-event')" style="padding:12px 14px;cursor:pointer;color:var(--text);font-size:14px;border-top:1px solid var(--border);">Add event</div>
        <div onclick="handleCalendarAction('block-dates')" style="padding:12px 14px;cursor:pointer;color:var(--text);font-size:14px;border-top:1px solid var(--border);">Block dates</div>
      </div>
      <div style="display:flex;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;gap:8px;">
        <div class="tb ${view === 'day' ? 'ac' : ''}" onclick="switchCalendarView('day')">Day</div>
        <div class="tb ${view === 'week' ? 'ac' : ''}" onclick="switchCalendarView('week')">Week</div>
        <div class="tb ${view === 'month' ? 'ac' : ''}" onclick="switchCalendarView('month')">Month</div>
      </div>`;

    if (view === 'month') {
      html += renderCalendarMonth(currentDate, gigsData, blockedData);
    } else if (view === 'week') {
      html += renderCalendarWeek(currentDate, gigsData, blockedData);
    } else if (view === 'day') {
      html += renderCalendarDay(currentDate, gigsData, blockedData);
    }

    content.innerHTML = html;
  } catch (err) {
    console.error('Calendar error:', err);
    content.innerHTML = `
      <div style="padding:40px 20px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">Couldn't load calendar</div>
        <div style="font-size:13px;color:var(--text-2);">Check your connection and try again</div>
      </div>`;
  }
}

function toggleCalendarMenu() {
  const menu = document.getElementById('calendarMenu');
  if (menu) {
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    menu.style.flexDirection = 'column';
  }
}

function handleCalendarAction(action) {
  if (action === 'add-gig') {
    openGigWizard();
  } else if (action === 'add-event') {
    // TODO: implement add-event panel
  } else if (action === 'block-dates') {
    openPanel('block-dates-panel');
  }
  toggleCalendarMenu();
}

function switchCalendarView(view) {
  window._calViewMode = view;
  renderCalendarScreen();
}

function renderCalendarMonth(currentDate, gigs, blocked) {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();

  let html = `<div style="padding:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <button onclick="prevCalendarMonth()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">‹</button>
      <div style="font-size:16px;font-weight:600;color:var(--text);">${new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</div>
      <button onclick="nextCalendarMonth()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">›</button>
    </div>
    <button onclick="goCalendarToday()" style="width:100%;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);color:var(--accent);border-radius:6px;padding:8px;font-size:12px;font-weight:600;margin-bottom:12px;cursor:pointer;">Today</button>
    <div class="cg">
      <div class="cdh">Mo</div><div class="cdh">Tu</div><div class="cdh">We</div><div class="cdh">Th</div><div class="cdh">Fr</div><div class="cdh">Sa</div><div class="cdh">Su</div>`;

  // Empty cells
  for (let i = 1; i < firstDay; i++) {
    html += `<div class="cd empty"></div>`;
  }

  // Days
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isToday = isCurrentMonth && day === today.getDate();

    const gigsOnDay = gigs.filter(g => (g.date || '').slice(0, 10) === dateStr);
    const blockedOnDay = blocked.some(b => (b.date || '').slice(0, 10) === dateStr);

    html += `<div class="cd ${isToday ? 'today' : ''}" onclick="selectCalendarDate('${dateStr}')" style="position:relative;">
      ${day}
      ${gigsOnDay.length > 0 || blockedOnDay ? `
      <div class="cd-dots">
        ${gigsOnDay.slice(0, 3).map(() => `<div class="cd-dot" style="background:var(--success);"></div>`).join('')}
        ${blockedOnDay ? `<div class="cd-dot" style="background:var(--danger);"></div>` : ''}
      </div>` : ''}
    </div>`;
  }

  html += `</div>`;

  // List gigs for this month
  const monthGigs = gigs.filter(g => (g.date || '').slice(0, 7) === `${year}-${String(month + 1).padStart(2, '0')}`);
  if (monthGigs.length > 0) {
    html += `<div style="margin-top:16px;">
      <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Gigs this month</div>`;
    monthGigs.forEach(gig => {
      html += `<div class="gi" onclick="openGigDetail('${gig.id}')">
        <div style="display:flex;align-items:flex-start;gap:14px;">
          <div class="gdb">
            <div class="gdd">${new Date(gig.date).getDate()}</div>
            <div class="gdm">${new Date(gig.date).toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</div>
          </div>
          <div style="flex:1;">
            <div class="gt">${escapeHtml(gig.band_name)}</div>
            <div class="gv">${escapeHtml(gig.venue_name)}${gig.start_time ? ' · ' + formatTime(gig.start_time) : ''}</div>
            ${gig.fee ? `<div class="gf">£${parseFloat(gig.fee).toFixed(0)}</div>` : ''}
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderCalendarWeek(currentDate, gigs, blocked) {
  // Get week start (Monday)
  const d = new Date(currentDate);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const weekStart = new Date(d.setDate(diff));

  let html = `<div style="padding:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <button onclick="prevCalendarWeek()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">‹</button>
      <div style="font-size:14px;font-weight:600;color:var(--text);">${weekStart.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} - ${new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}</div>
      <button onclick="nextCalendarWeek()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">›</button>
    </div>
    <button onclick="goCalendarToday()" style="width:100%;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);color:var(--accent);border-radius:6px;padding:8px;font-size:12px;font-weight:600;margin-bottom:12px;cursor:pointer;">Today</button>
    <div style="display:flex;gap:4px;margin-bottom:12px;">`;

  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const isToday = dateStr === new Date().toISOString().split('T')[0];

    html += `<div style="flex:1;text-align:center;padding:8px;border-radius:6px;background:${isToday ? 'var(--accent)' : 'var(--card)'};border:1px solid ${isToday ? 'var(--accent)' : 'var(--border)'};cursor:pointer;color:${isToday ? '#000' : 'var(--text)'};font-weight:${isToday ? '700' : '600'};font-size:12px;">
      ${d.toLocaleDateString('en-GB', { weekday: 'short' })}<br>${d.getDate()}
    </div>`;
  }

  html += `</div>`;

  // List gigs for week
  const weekGigs = gigs.filter(g => {
    const gDate = new Date(g.date);
    return gDate >= weekStart && gDate < new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  if (weekGigs.length > 0) {
    html += `<div style="margin-top:12px;">
      <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Gigs this week</div>`;
    weekGigs.forEach(gig => {
      html += `<div class="gi" onclick="openGigDetail('${gig.id}')">
        <div style="display:flex;align-items:flex-start;gap:14px;">
          <div class="gdb">
            <div class="gdd">${new Date(gig.date).getDate()}</div>
            <div class="gdm">${new Date(gig.date).toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</div>
          </div>
          <div style="flex:1;">
            <div class="gt">${escapeHtml(gig.band_name)}</div>
            <div class="gv">${escapeHtml(gig.venue_name)}${gig.start_time ? ' · ' + formatTime(gig.start_time) : ''}</div>
            ${gig.fee ? `<div class="gf">£${parseFloat(gig.fee).toFixed(0)}</div>` : ''}
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderCalendarDay(currentDate, gigs, blocked) {
  const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
  const dayGigs = gigs.filter(g => g.date === dateStr).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

  let html = `<div style="padding:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <button onclick="prevCalendarDay()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">‹</button>
      <div style="font-size:16px;font-weight:600;color:var(--text);">${currentDate.toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <button onclick="nextCalendarDay()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">›</button>
    </div>
    <button onclick="goCalendarToday()" style="width:100%;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);color:var(--accent);border-radius:6px;padding:8px;font-size:12px;font-weight:600;margin-bottom:12px;cursor:pointer;">Today</button>`;

  if (dayGigs.length === 0) {
    html += `<div style="text-align:center;padding:40px 20px;color:var(--text-2);">No gigs scheduled for this day</div>`;
  } else {
    html += `<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Gigs today</div>`;
    dayGigs.forEach(gig => {
      html += `<div class="gi" onclick="openGigDetail('${gig.id}')">
        <div style="display:flex;align-items:flex-start;gap:14px;">
          <div class="gdb">
            <div class="gdd" style="font-size:14px;">${formatTime(gig.start_time)}</div>
          </div>
          <div style="flex:1;">
            <div class="gt">${escapeHtml(gig.band_name)}</div>
            <div class="gv">${escapeHtml(gig.venue_name)}</div>
            ${gig.fee ? `<div class="gf">£${parseFloat(gig.fee).toFixed(0)}</div>` : ''}
          </div>
        </div>
      </div>`;
    });
  }

  html += `</div>`;
  return html;
}

function selectCalendarDate(dateStr) {
  window._calDate = new Date(dateStr);
  renderCalendarScreen();
}

function prevCalendarMonth() {
  const d = new Date(window._calDate);
  d.setMonth(d.getMonth() - 1);
  window._calDate = d;
  renderCalendarScreen();
}

function nextCalendarMonth() {
  const d = new Date(window._calDate);
  d.setMonth(d.getMonth() + 1);
  window._calDate = d;
  renderCalendarScreen();
}

function prevCalendarWeek() {
  const d = new Date(window._calDate);
  d.setDate(d.getDate() - 7);
  window._calDate = d;
  renderCalendarScreen();
}

function nextCalendarWeek() {
  const d = new Date(window._calDate);
  d.setDate(d.getDate() + 7);
  window._calDate = d;
  renderCalendarScreen();
}

function prevCalendarDay() {
  const d = new Date(window._calDate);
  d.setDate(d.getDate() - 1);
  window._calDate = d;
  renderCalendarScreen();
}

function nextCalendarDay() {
  const d = new Date(window._calDate);
  d.setDate(d.getDate() + 1);
  window._calDate = d;
  renderCalendarScreen();
}

function goCalendarToday() {
  window._calDate = new Date();
  renderCalendarScreen();
}

async function renderInvoicesScreen() {
  const content = document.getElementById('invoicesScreen');
  content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading invoices...</div>';

  try {
    const res = await fetch('/api/invoices');
    if (!res.ok) throw new Error('Failed to fetch invoices');
    const invoices = await res.json();

    // Calculate totals
    const paid = invoices.filter(i => i.status === 'paid').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
    const overdue = invoices.filter(i => i.status === 'overdue').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
    const draft = invoices.filter(i => i.status === 'draft').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
    const sent = invoices.filter(i => i.status === 'sent').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:24px;font-weight:700;color:var(--text);">Invoices</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:2px;">${invoices.length} total · £${(paid + overdue + draft + sent).toFixed(0)} invoiced</div>
        </div>
        <button onclick="openPanel('create-invoice')" style="background:var(--accent);color:#000;border:none;border-radius:24px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">+ New</button>
      </div>
      <div style="display:flex;gap:6px;padding:0 16px 8px;overflow-x:auto;">
        <button class="filter-badge ac" onclick="filterInvoicesByStatus('all')">All</button>
        <button class="filter-badge" onclick="filterInvoicesByStatus('overdue')">Overdue</button>
        <button class="filter-badge" onclick="filterInvoicesByStatus('draft')">Draft</button>
        <button class="filter-badge" onclick="filterInvoicesByStatus('sent')">Sent</button>
        <button class="filter-badge" onclick="filterInvoicesByStatus('paid')">Paid</button>
      </div>
      <div id="invoicesList" style="padding:0 16px;">`;

    invoices.forEach(inv => {
      const dotColor = inv.status === 'paid' ? 'var(--success)' :
                       inv.status === 'overdue' ? 'var(--danger)' :
                       inv.status === 'draft' ? 'var(--info)' : 'var(--warning)';

      html += `
      <div class="inv-i" onclick="openInvoiceDetail('${inv.id}')">
        <div class="inv-dot" style="background:${dotColor};"></div>
        <div style="flex:1;min-width:0;">
          <div class="inv-t">${escapeHtml(inv.band_name || 'Unnamed')}</div>
          <div class="inv-m">INV-${String(inv.id).padStart(3, '0')} · ${formatDateShort(inv.created_at || inv.date)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="inv-a" style="color:var(--success);">£${parseFloat(inv.amount).toFixed(0)}</div>
          <div style="font-size:10px;color:var(--text-2);margin-top:2px;text-transform:capitalize;">${inv.status}</div>
        </div>
      </div>`;
    });

    html += `</div>
      <div style="padding:0 16px;margin-top:12px;">
        <button onclick="openPanel('create-standalone-invoice')" class="pill-g">Create standalone invoice</button>
      </div>`;

    content.innerHTML = html;
  } catch (err) {
    console.error('Invoices screen error:', err);
    content.innerHTML = `
      <div style="padding:40px 20px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">Couldn't load invoices</div>
        <div style="font-size:13px;color:var(--text-2);">Check your connection and try again</div>
      </div>`;
  }
}

function filterInvoicesByStatus(status) {
  document.querySelectorAll('.filter-badge').forEach(b => b.classList.remove('ac'));
  event.target.classList.add('ac');
  // TODO: implement filtering
}

async function openInvoiceDetail(invoiceId) {
  const panel = document.getElementById('invoice-detail');
  if (!panel) return;

  panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading invoice...</div>';
  openPanel('invoice-detail');

  try {
    const res = await fetch(`/api/invoices/${invoiceId}`);
    if (!res.ok) throw new Error('Failed to fetch invoice');
    const invoice = await res.json();

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('invoice-detail')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="flex:1;text-align:center;">
          <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(invoice.band_name)}</div>
          <span style="font-size:11px;background:${invoice.status === 'paid' ? 'var(--success-dim);color:var(--success)' : invoice.status === 'overdue' ? 'var(--danger-dim);color:var(--danger)' : 'var(--info-dim);color:var(--info)'};padding:2px 8px;border-radius:12px;text-transform:capitalize;font-weight:600;">${invoice.status}</span>
        </div>
        <div style="width:32px;"></div>
      </div>
      <div style="padding:0 16px 16px;border-bottom:1px solid var(--border);margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span style="color:var(--text-2);font-size:12px;">Invoice number</span>
          <span style="font-weight:600;color:var(--text);">INV-${String(invoice.id).padStart(3, '0')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span style="color:var(--text-2);font-size:12px;">Date created</span>
          <span style="font-weight:600;color:var(--text);">${formatDateShort(invoice.created_at || invoice.date)}</span>
        </div>
        ${invoice.due_date ? `
        <div style="display:flex;justify-content:space-between;">
          <span style="color:var(--text-2);font-size:12px;">Due date</span>
          <span style="font-weight:600;color:var(--text);">${formatDateShort(invoice.due_date)}</span>
        </div>` : ''}
      </div>`;

    if (invoice.line_items && invoice.line_items.length > 0) {
      html += `<div style="padding:0 16px 12px;border-bottom:1px solid var(--border);margin-bottom:12px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Line items</div>`;
      invoice.line_items.forEach(item => {
        html += `
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;">
          <span style="color:var(--text);">${escapeHtml(item.description)}</span>
          <span style="font-weight:600;color:var(--text);">£${parseFloat(item.amount).toFixed(0)}</span>
        </div>`;
      });
      html += `</div>`;
    }

    html += `
      <div style="padding:0 16px 12px;border-bottom:1px solid var(--border);margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:14px;font-weight:600;color:var(--text);">Total</span>
          <span style="font-size:20px;font-weight:700;color:var(--success);">£${parseFloat(invoice.amount).toFixed(0)}</span>
        </div>
      </div>
      <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;">
        ${invoice.status === 'draft' ? `<button onclick="openPanel('send-invoice')" class="pill">Send invoice</button>` : ''}
        ${invoice.status !== 'paid' ? `<button onclick="markInvoiceAsPaid('${invoice.id}')" class="pill-o">Mark as paid</button>` : ''}
        <button onclick="downloadInvoicePDF('${invoice.id}')" class="pill-g">Download PDF</button>
        ${invoice.status === 'sent' ? `<button onclick="chaseInvoicePayment('${invoice.id}')" class="pill-g">Chase payment</button>` : ''}
      </div>`;

    panel.innerHTML = html;
  } catch (err) {
    console.error('Invoice detail error:', err);
    panel.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load invoice</div>`;
  }
}

async function renderOffersScreen() {
  const content = document.getElementById('offersScreen');
  content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading offers...</div>';

  try {
    const res = await fetch('/api/offers');
    if (!res.ok) throw new Error('Failed to fetch offers');
    const offers = await res.json();

    const accepted = offers.filter(o => o.status === 'accepted').length;

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:8px;">
          <button onclick="showScreen('home')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
          <div>
            <div style="font-size:24px;font-weight:700;color:var(--text);">Offers</div>
          </div>
        </div>
        <span style="background:var(--accent);color:#000;font-size:10px;font-weight:800;min-width:24px;height:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;padding:0 6px;">${accepted}</span>
      </div>
      <div style="display:flex;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;">
        <div class="tb ac" onclick="switchOffersTab('incoming')">Incoming</div>
        <div class="tb" onclick="switchOffersTab('my-deps')">My deps</div>
      </div>
      <div id="offersListContent" style="padding:0 16px;">`;

    offers.forEach(offer => {
      const deadline = new Date(offer.deadline);
      const now = new Date();
      const hoursLeft = Math.ceil((deadline - now) / (1000 * 60 * 60));
      const daysLeft = Math.ceil(hoursLeft / 24);

      html += `
      <div class="oc">
        <div class="o-act">${offer.source || 'OFFER'}</div>
        <div class="o-title">${escapeHtml(offer.band_name)}</div>
        <div class="o-det">📍 ${escapeHtml(offer.venue_name)}</div>
        <div class="o-det">📅 ${formatDateLong(offer.gig_date)}</div>
        <div class="o-det">💷 £${parseFloat(offer.fee).toFixed(0)}</div>
        <div class="o-timer">
          ⏳ Expires in ${daysLeft > 0 ? daysLeft + 'd' : hoursLeft + 'h'}
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <button onclick="acceptOffer('${offer.id}')" class="o-acc">Accept</button>
          <button onclick="declineOffer('${offer.id}')" class="o-dec">Decline</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="snz-opt" onclick="snoozeOffer('${offer.id}', 1)">1h</button>
          <button class="snz-opt" onclick="snoozeOffer('${offer.id}', 24)">1d</button>
          <button class="snz-opt" onclick="snoozeOffer('${offer.id}', 168)">1w</button>
        </div>
      </div>`;
    });

    html += `</div>`;
    content.innerHTML = html;
  } catch (err) {
    console.error('Offers screen error:', err);
    content.innerHTML = `
      <div style="padding:40px 20px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">Couldn't load offers</div>
        <div style="font-size:13px;color:var(--text-2);">Check your connection and try again</div>
      </div>`;
  }
}

function switchOffersTab(tab) {
  document.querySelectorAll('#offersScreen .tb').forEach(t => t.classList.remove('ac'));
  event.target.classList.add('ac');
  // TODO: filter offers by tab
}

async function renderProfileScreen() {
  // Render into the panel overlay body (profile-panel), falling back to the screen
  const content = document.getElementById('profilePanelBody') || document.getElementById('profileScreen');

  // Use cached profile for instant render
  const now = Date.now();
  if (window._cachedProfile && (now - window._cachedProfileTime) < PROFILE_CACHE_TTL) {
    buildProfileHTML(content, window._cachedProfile);
    return;
  }

  content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading profile...</div>';

  try {
    const res = await fetch('/api/user/profile');
    const profile = res.ok ? await res.json() : { name: window._currentUser?.name || 'Guest', email: window._currentUser?.email || '' };
    window._cachedProfile = profile;
    window._cachedProfileTime = Date.now();
    buildProfileHTML(content, profile);
  } catch (err) {
    console.error('Profile error:', err);
    content.innerHTML = `<div style="padding:40px 20px;text-align:center;">Error loading profile</div>`;
  }
}

function buildProfileHTML(content, profile) {
    const userInitial = (profile.name || profile.email || 'G')[0].toUpperCase();

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('profile-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">&#8249;</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">Profile</div>
        <button onclick="editProfile()" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;font-weight:600;">Edit</button>
      </div>
      <div style="padding:0 16px 12px;">
        <div style="text-align:center;">
          <div style="width:64px;height:64px;margin:0 auto 12px;border-radius:32px;background:var(--accent-dim);border:3px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:var(--accent);">${userInitial}</div>
          <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px;">${escapeHtml(profile.name || 'Guest')}</div>
          <div style="font-size:12px;color:var(--text-2);margin-bottom:2px;">${escapeHtml(profile.instruments || 'No instruments listed')}</div>
          <div style="font-size:12px;color:var(--text-2);">📍 ${escapeHtml(profile.location || 'Location not set')}</div>
          ${profile.available_to_dep ? `<span style="display:inline-block;background:var(--success-dim);color:var(--success);padding:4px 10px;border-radius:12px;font-size:10px;font-weight:600;margin-top:6px;">Available to dep</span>` : ''}
        </div>
      </div>
      <div style="padding:0 16px 12px;display:flex;gap:6px;">
        <button onclick="shareProfile()" class="pill-o" style="flex:1;">Share profile</button>
        <button onclick="viewEPK()" class="pill-o" style="flex:1;">View EPK</button>
      </div>
      <div style="display:flex;gap:6px;padding:0 16px 12px;margin-bottom:8px;">
        <div style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:8px 10px;text-align:center;">
          <div style="font-size:13px;font-weight:700;color:var(--text);">${profile.gigs_count || 0}</div>
          <div style="font-size:10px;color:var(--text-2);">Gigs</div>
        </div>
        <div style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:8px 10px;text-align:center;">
          <div style="font-size:13px;font-weight:700;color:var(--text);">${profile.acts_count || 0}</div>
          <div style="font-size:10px;color:var(--text-2);">Acts</div>
        </div>
        <div style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:8px 10px;text-align:center;">
          <div style="font-size:13px;font-weight:700;color:var(--success);">£${profile.total_earned || 0}</div>
          <div style="font-size:10px;color:var(--text-2);">Earned</div>
        </div>
      </div>
      <div style="padding:0 16px;margin-bottom:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px;cursor:pointer;" onclick="shareAvailability()">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">🔗</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);">Share your availability</div>
            <div style="font-size:11px;color:var(--text-2);">Send calendar link to band leaders</div>
          </div>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
      </div>
      <div style="padding:0 16px 12px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Menu</div>
        <div onclick="openPanel('network-panel')" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">My Network</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="openPanel('repertoire-panel')" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Repertoire library</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="openPanel('epk-panel')" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Professional EPK</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="toggleDocs()" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Documents & certs</span>
          <span style="color:var(--accent);font-size:16px;" id="docs-arrow">›</span>
        </div>
        <div id="docs-section" style="display:none;background:var(--card);padding:8px 14px;border-bottom:1px solid var(--border);">
          <div style="font-size:12px;color:var(--text-2);padding:6px 0;">DBS Check · Public Liability Insurance · Risk Assessment</div>
        </div>
        <div onclick="openPanel('finance-panel')" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Earnings & tax summary</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="openPanel('notifications-settings')" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Notification settings</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="toggleConnected()" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Connected acts</span>
          <span style="color:var(--accent);font-size:16px;" id="connected-arrow">›</span>
        </div>
        <div id="connected-section" style="display:none;background:var(--card);padding:8px 14px;border-bottom:1px solid var(--border);">
          <div style="font-size:12px;color:var(--text-2);padding:6px 0;">Musician Tracker · ClientFlow CRM</div>
        </div>
        <div style="padding:12px 14px;background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
          <span style="color:var(--text);font-size:14px;">Google Calendar</span>
          <input type="checkbox" style="cursor:pointer;" onchange="toggleCalendarSync()">
        </div>
        <div style="padding:12px 14px;background:var(--card);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
          <span style="color:var(--text);font-size:14px;">Theme</span>
          <button onclick="toggleTheme()" style="background:none;border:none;cursor:pointer;font-size:16px;">🌙</button>
        </div>
      </div>
      <div style="padding:0 16px;margin-top:12px;">
        <button onclick="logout()" class="pill" style="background:var(--danger);color:#fff;">Sign Out</button>
      </div>`;

    content.innerHTML = html;
}

function toggleDocs() {
  const section = document.getElementById('docs-section');
  const arrow = document.getElementById('docs-arrow');
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
  arrow.textContent = section.style.display === 'none' ? '›' : '‹';
}

function toggleConnected() {
  const section = document.getElementById('connected-section');
  const arrow = document.getElementById('connected-arrow');
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
  arrow.textContent = section.style.display === 'none' ? '›' : '‹';
}

// ── Gig Wizard ──────────────────────────────────────────────────────────────

function openGigWizard() {
  gigWizardStep = 1;
  gigWizardData = {
    band_name: '',
    venue_name: '',
    venue_address: '',
    date: '',
    start_time: '',
    end_time: '',
    load_in_time: '',
    fee: '',
    status: 'confirmed',
    gig_type: '',
    dress_code: '',
    notes: '',
  };
  renderCreateGigScreen();
  showScreen('createGig');
}

function renderCreateGigScreen() {
  const content = document.getElementById('createGigScreen');

  content.innerHTML = `
    <div class="wizard-container">
      <div class="wizard-header" style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);background:var(--surface);">
        <button onclick="showScreen('gigs')" style="color:var(--accent);font-size:14px;font-weight:500;cursor:pointer;background:none;border:none;">&#8249; Back</button>
        <div class="wizard-title" style="font-size:16px;font-weight:700;">New Gig</div>
        <div onclick="renderFullGigForm()" style="font-size:12px;color:var(--text-3);cursor:pointer;">Show full form</div>
      </div>
      <div style="display:flex;gap:4px;padding:0 20px;margin-bottom:20px;" id="wizardProgress">
        <div id="wizardDot1" style="flex:1;height:3px;border-radius:2px;background:var(--accent);transition:background .3s;"></div>
        <div id="wizardDot2" style="flex:1;height:3px;border-radius:2px;background:var(--border);transition:background .3s;"></div>
        <div id="wizardDot3" style="flex:1;height:3px;border-radius:2px;background:var(--border);transition:background .3s;"></div>
        <div id="wizardDot4" style="flex:1;height:3px;border-radius:2px;background:var(--border);transition:background .3s;"></div>
        <div id="wizardDot5" style="flex:1;height:3px;border-radius:2px;background:var(--border);transition:background .3s;"></div>
      </div>
      <div id="wizardBody"></div>
    </div>
  `;

  renderWizardStep(gigWizardStep);
}

function renderWizardStep(step) {
  const body = document.getElementById('wizardBody');

  if (!body) return;

  // Update progress bars
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById(`wizardDot${i}`);
    if (!dot) continue;
    dot.style.background = i <= step ? 'var(--accent)' : 'var(--border)';
  }

  let stepHTML = '';

  if (step === 1) {
    stepHTML = `
      <div style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Step 1 of 5</div>
      <div class="wizard-step-question">Who's the gig with?</div>
      <div class="wizard-step-hint">Band name, client, or your own booking</div>
      <div class="form-group" style="margin-bottom:12px;">
        <input
          type="text"
          class="form-input"
          id="wBandName"
          placeholder="Start typing a name..."
          value="${escapeHtml(gigWizardData.band_name)}"
          autocomplete="off"
          oninput="filterBandSuggestions(this.value)"
          onblur="setTimeout(() => hideSuggestions('bandSuggestions'), 200)"
        >
        <div id="bandSuggestions" class="suggestions-list" style="display:none;"></div>
        <div class="wizard-error" id="wBandError">Please enter a band or project name</div>
      </div>
      <div id="wizAutofill" style="display:none;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);border-radius:var(--radius-sm, 8px);padding:14px 16px;margin-bottom:14px;display:none;align-items:center;gap:12px;">
        <div style="font-size:20px;">&#129302;</div>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:3px;">Auto-fill from past gigs?</div>
          <div style="font-size:12px;color:var(--text-2);line-height:1.5;" id="wizAutofillDetails"></div>
        </div>
        <button onclick="applyAutofill()" id="wizAutofillBtn" style="background:var(--accent);color:#000;border:none;border-radius:14px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">Apply</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:16px;">
        <div style="background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);border-radius:16px;padding:4px 10px;font-size:10px;font-weight:600;color:var(--accent);">&#9995; Manual entry</div>
        <div style="font-size:10px;color:var(--text-3);">or arrives pre-filled from ClientFlow / Musician Tracker</div>
      </div>
    `;
  } else if (step === 2) {
    stepHTML = `
      <div style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Step 2 of 5</div>
      <div class="wizard-step-question">Where's the gig?</div>
      <div class="wizard-step-hint">Search for the venue - we'll grab the full address for directions & mileage</div>
      <div class="form-group" style="position:relative;">
        <input
          type="text"
          class="form-input"
          id="wVenueName"
          placeholder="Search venues..."
          value="${escapeHtml(gigWizardData.venue_name)}"
          autocomplete="off"
          oninput="searchVenues(this.value)"
        >
        <div id="venueSuggestions" class="suggestions-list" style="display:none;"></div>
        <div class="wizard-error" id="wVenueError">Please enter the venue name</div>
      </div>
      <div id="venueConfirm" style="display:${gigWizardData.venue_address ? 'block' : 'none'};background:var(--success-dim);border:1px solid rgba(63,185,80,.2);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-2);" id="venueAddrText">${gigWizardData.venue_address ? escapeHtml(gigWizardData.venue_address) : ''}</div>
        <div style="font-size:10px;color:var(--success);margin-top:4px;" id="venueAddrMeta"></div>
      </div>
      <input type="hidden" id="wVenueAddress" value="${escapeHtml(gigWizardData.venue_address)}">
      <div style="font-size:10px;color:var(--text-3);margin-bottom:16px;">&#128269; Google Places \u00B7 Address feeds into mileage calc & sat nav</div>
    `;
  } else if (step === 3) {
    stepHTML = `
      <div style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Step 3 of 5</div>
      <div class="wizard-step-question">When is it?</div>
      <div class="wizard-step-hint">Date and times</div>
      <div class="form-group">
        <label class="form-label">Date</label>
        <input
          type="date"
          class="form-input"
          id="wDate"
          value="${gigWizardData.date}"
        >
        <div class="wizard-error" id="wDateError">Please pick a date</div>
      </div>
      <div class="form-group">
        <div class="time-row">
          <div>
            <label class="form-label">Start time</label>
            <input type="time" class="form-input" id="wStartTime" value="${gigWizardData.start_time}">
          </div>
          <div>
            <label class="form-label">End time</label>
            <input type="time" class="form-input" id="wEndTime" value="${gigWizardData.end_time}">
          </div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Load-in / arrival (optional)</label>
        <input type="time" class="form-input" id="wLoadIn" value="${gigWizardData.load_in_time}" style="max-width: 50%;">
      </div>
    `;
  } else if (step === 4) {
    stepHTML = `
      <div style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Step 4 of 5</div>
      <div class="wizard-step-question">How much & what's the status?</div>
      <div class="wizard-step-hint">Your fee and whether it's confirmed</div>
      <div class="form-group">
        <label class="form-label">Fee (&pound;)</label>
        <div class="fee-input-wrapper">
          <span class="fee-currency">&pound;</span>
          <input
            type="number"
            class="fee-input-big"
            id="wFee"
            placeholder="280"
            value="${gigWizardData.fee}"
            min="0"
            step="1"
            inputmode="decimal"
          >
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <div style="display:flex;gap:8px;">
          <div onclick="selectGigStatus('confirmed')" id="statusChipConfirmed" style="flex:1;${gigWizardData.status === 'confirmed' ? 'background:var(--success-dim);color:var(--success);border:2px solid var(--success);font-weight:700;' : 'background:var(--card);color:var(--text-2);border:2px solid var(--border);'}border-radius:16px;padding:14px;font-size:14px;cursor:pointer;text-align:center;">${gigWizardData.status === 'confirmed' ? '\u2713 ' : ''}Confirmed</div>
          <div onclick="selectGigStatus('tentative')" id="statusChipTentative" style="flex:1;${gigWizardData.status === 'tentative' ? 'background:var(--warning-dim);color:var(--warning);border:2px solid var(--warning);font-weight:700;' : 'background:var(--card);color:var(--text-2);border:2px solid var(--border);'}border-radius:16px;padding:14px;font-size:14px;cursor:pointer;text-align:center;">Pencilled</div>
          <div onclick="selectGigStatus('enquiry')" id="statusChipEnquiry" style="flex:1;${gigWizardData.status === 'enquiry' ? 'background:var(--info-dim);color:var(--info);border:2px solid var(--info);font-weight:700;' : 'background:var(--card);color:var(--text-2);border:2px solid var(--border);'}border-radius:16px;padding:14px;font-size:14px;cursor:pointer;text-align:center;">Enquiry</div>
        </div>
      </div>
    `;
  } else if (step === 5) {
    const gigTypes = [
      { label: '\u{1F492} Wedding', value: 'Wedding' },
      { label: '\u{1F3E2} Corporate', value: 'Corporate' },
      { label: '\u{1F37A} Pub / Club', value: 'Pub / Club' },
      { label: '\u{1F389} Private party', value: 'Private party' },
      { label: '\u{1F3AA} Festival', value: 'Festival' },
      { label: '\u{1F3E8} Hotel', value: 'Hotel' },
      { label: '\u{1F3AD} Theatre', value: 'Theatre' },
      { label: '\u26EA Church', value: 'Church' },
      { label: '\u{1F37D}\uFE0F Restaurant', value: 'Restaurant' },
      { label: '\u{1F4CC} Other', value: 'Other' },
    ];
    stepHTML = `
      <div style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Step 5 of 5</div>
      <div class="wizard-step-question">Quick extras</div>
      <div class="wizard-step-hint">All optional - skip any you don't need</div>
      <div class="form-group">
        <label class="form-label">What type of gig?</label>
        <div class="chip-group">
          ${gigTypes
            .map(
              (t) => `
            <button
              class="chip ${gigWizardData.gig_type === t.value ? 'selected' : ''}"
              onclick="toggleGigType('${t.value}', this)"
            >${t.label}</button>
          `
            )
            .join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Dress code</label>
        <input
          type="text"
          class="form-input"
          id="wDressCode"
          placeholder="e.g. Smart casual, Black tie"
          value="${escapeHtml(gigWizardData.dress_code)}"
        >
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea
          class="form-textarea"
          id="wNotes"
          placeholder="Parking info, contacts, anything useful..."
          rows="3"
        >${escapeHtml(gigWizardData.notes)}</textarea>
      </div>
    `;
  }

  const nextLabels = {
    1: 'Next \u2192 Where?',
    2: 'Next \u2192 When?',
    3: 'Next \u2192 How much?',
    4: 'Next \u2192 Extras',
    5: '\u2713 Save gig',
  };
  const nextLabel = nextLabels[step] || 'Next';
  const isSave = step === 5;

  body.innerHTML = `
    ${stepHTML}
    <div class="wizard-footer" style="display:flex;gap:8px;">
      ${step > 1 ? `<button class="button button-outline" style="width:80px;" onclick="wizardBack()">\u2190 Back</button>` : ''}
      <button class="button ${isSave ? 'button-success' : 'button-primary'} button-block" id="wizardNextBtn" onclick="wizardNext()" style="flex:1;">${nextLabel}</button>
    </div>
  `;

  // Auto-focus the first text input (skip for date/time steps)
  if (step === 1 || step === 2) {
    setTimeout(() => {
      const firstInput = body.querySelector('input[type="text"]');
      if (firstInput) firstInput.focus();
    }, 100);
  }
}

function wizardNext() {
  const step = gigWizardStep;

  if (step === 1) {
    const val = document.getElementById('wBandName')?.value?.trim();
    if (!val) {
      document.getElementById('wBandError')?.classList.add('visible');
      return;
    }
    gigWizardData.band_name = val;
  } else if (step === 2) {
    const val = document.getElementById('wVenueName')?.value?.trim();
    if (!val) {
      document.getElementById('wVenueError')?.classList.add('visible');
      return;
    }
    gigWizardData.venue_name = val;
    gigWizardData.venue_address =
      document.getElementById('wVenueAddress')?.value?.trim() || '';
  } else if (step === 3) {
    const dateVal = document.getElementById('wDate')?.value;
    if (!dateVal) {
      document.getElementById('wDateError')?.classList.add('visible');
      return;
    }
    gigWizardData.date = dateVal;
    gigWizardData.start_time =
      document.getElementById('wStartTime')?.value || '';
    gigWizardData.end_time = document.getElementById('wEndTime')?.value || '';
    gigWizardData.load_in_time =
      document.getElementById('wLoadIn')?.value || '';
  } else if (step === 4) {
    gigWizardData.fee = document.getElementById('wFee')?.value || '';
    // status is saved live via selectGigStatus()
  } else if (step === 5) {
    gigWizardData.dress_code =
      document.getElementById('wDressCode')?.value?.trim() || '';
    gigWizardData.notes =
      document.getElementById('wNotes')?.value?.trim() || '';
    submitGigWizard();
    return;
  }

  gigWizardStep++;
  renderWizardStep(gigWizardStep);
  document.querySelector('.app-content').scrollTop = 0;
}

function wizardBack() {
  if (gigWizardStep === 1) {
    showScreen('gigs');
    return;
  }
  gigWizardStep--;
  renderWizardStep(gigWizardStep);
  document.querySelector('.app-content').scrollTop = 0;
}

function selectGigStatus(status) {
  gigWizardData.status = status;
  // Re-render step 4 to update chip styles
  renderWizardStep(4);
}

function toggleGigType(type, btn) {
  if (gigWizardData.gig_type === type) {
    gigWizardData.gig_type = '';
    btn.classList.remove('selected');
  } else {
    gigWizardData.gig_type = type;
    document
      .querySelectorAll('.chip-group .chip')
      .forEach((c) => c.classList.remove('selected'));
    btn.classList.add('selected');
  }
}

function selectBand(btn) {
  const name = btn.textContent;
  gigWizardData.band_name = name;
  const input = document.getElementById('wBandName');
  if (input) input.value = name;
}

function getBandStats(bandName) {
  const gigs = (window._cachedGigs || []).filter(
    (g) => g.band_name && g.band_name.toLowerCase() === bandName.toLowerCase()
  );
  if (gigs.length === 0) return null;
  const fees = gigs.map((g) => parseFloat(g.fee)).filter((f) => !isNaN(f) && f > 0);
  const avgFee = fees.length > 0 ? Math.round(fees.reduce((a, b) => a + b, 0) / fees.length) : null;
  const lastGig = gigs[0];
  return {
    count: gigs.length,
    avgFee,
    venue: lastGig.venue_name || null,
    venueAddr: lastGig.venue_address || null,
    dressCode: lastGig.dress_code || null,
    startTime: lastGig.start_time || null,
    endTime: lastGig.end_time || null,
  };
}

function filterBandSuggestions(query) {
  const container = document.getElementById('bandSuggestions');
  if (!container) return;

  // Hide autofill when typing
  const af = document.getElementById('wizAutofill');
  if (af) af.style.display = 'none';

  const allBands = getRecentBands();
  if (!query || query.length < 2 || allBands.length === 0) {
    container.style.display = 'none';
    return;
  }
  const filtered = allBands.filter((b) =>
    b.toLowerCase().includes(query.toLowerCase())
  );
  if (filtered.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.innerHTML = filtered
    .map((b) => {
      const stats = getBandStats(b);
      const initial = b.charAt(0).toUpperCase();
      const meta = stats
        ? `${stats.count} past gig${stats.count !== 1 ? 's' : ''}${stats.avgFee ? ' \u00B7 Usually \u00A3' + stats.avgFee : ''}`
        : '';
      return `<div class="suggestion-item" onmousedown="selectBandFromSuggestion('${escapeAttr(b)}')" style="display:flex;align-items:center;gap:12px;">
        <div style="width:32px;height:32px;border-radius:16px;background:var(--accent-dim);border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--accent);flex-shrink:0;">${initial}</div>
        <div style="flex:1;"><div style="font-size:14px;font-weight:600;color:var(--text);">${escapeHtml(b)}</div>${meta ? `<div style="font-size:11px;color:var(--text-3);">${meta}</div>` : ''}</div>
      </div>`;
    })
    .join('');
  container.style.display = 'block';
}

window._autofillData = null;

function selectBandFromSuggestion(name) {
  gigWizardData.band_name = name;
  const input = document.getElementById('wBandName');
  if (input) input.value = name;
  hideSuggestions('bandSuggestions');

  // Show auto-fill card if we have past gig data
  const stats = getBandStats(name);
  if (stats && stats.count > 0) {
    window._autofillData = stats;
    const details = [];
    if (stats.avgFee) details.push('Fee: \u00A3' + stats.avgFee);
    if (stats.dressCode) details.push('Dress: ' + stats.dressCode);
    if (stats.startTime && stats.endTime) details.push('Usually ' + stats.startTime.substring(0, 5) + '\u2013' + stats.endTime.substring(0, 5));
    if (stats.venue) details.push('Venue: ' + stats.venue);

    const af = document.getElementById('wizAutofill');
    const afDetails = document.getElementById('wizAutofillDetails');
    if (af && afDetails && details.length > 0) {
      afDetails.innerHTML = details.join(' \u00B7 ');
      af.style.display = 'flex';
      // Reset button in case it was previously applied
      const btn = document.getElementById('wizAutofillBtn');
      if (btn) { btn.textContent = 'Apply'; btn.style.background = 'var(--accent)'; btn.style.color = '#000'; }
    }
  }
}

function applyAutofill() {
  const d = window._autofillData;
  if (!d) return;
  if (d.avgFee) gigWizardData.fee = String(d.avgFee);
  if (d.dressCode) gigWizardData.dress_code = d.dressCode;
  if (d.startTime) gigWizardData.start_time = d.startTime;
  if (d.endTime) gigWizardData.end_time = d.endTime;
  if (d.venue) gigWizardData.venue_name = d.venue;
  if (d.venueAddr) gigWizardData.venue_address = d.venueAddr;

  const btn = document.getElementById('wizAutofillBtn');
  if (btn) {
    btn.textContent = '\u2713';
    btn.style.background = 'var(--success)';
    btn.style.color = '#fff';
  }
}

function hideSuggestions(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ── Venue search (Google Places via server proxy) ───────────────────────────
let _venueSearchTimer = null;

function searchVenues(query) {
  const list = document.getElementById('venueSuggestions');
  if (!list) return;

  clearTimeout(_venueSearchTimer);

  if (query.length < 3) {
    list.style.display = 'none';
    return;
  }

  _venueSearchTimer = setTimeout(async () => {
    try {
      const resp = await fetch(`/api/places?q=${encodeURIComponent(query)}`);
      const data = await resp.json();
      if (!data.predictions || data.predictions.length === 0) {
        list.style.display = 'none';
        return;
      }
      list.innerHTML = data.predictions
        .map(
          (p) => `
        <div class="suggestion-item" onclick="selectVenue('${escapeHtml(p.place_id)}', '${escapeHtml(p.structured_formatting?.main_text || p.description)}')">
          <div style="font-size:14px;font-weight:500;color:var(--text);">${escapeHtml(p.structured_formatting?.main_text || p.description)}</div>
          <div style="font-size:11px;color:var(--text-3);">${escapeHtml(p.structured_formatting?.secondary_text || '')}</div>
        </div>
      `
        )
        .join('');
      list.style.display = 'block';
    } catch (err) {
      console.error('Venue search error:', err);
      list.style.display = 'none';
    }
  }, 300);
}

async function selectVenue(placeId, name) {
  const nameInput = document.getElementById('wVenueName');
  const addrInput = document.getElementById('wVenueAddress');
  const list = document.getElementById('venueSuggestions');
  const confirm = document.getElementById('venueConfirm');
  const addrText = document.getElementById('venueAddrText');
  const addrMeta = document.getElementById('venueAddrMeta');

  if (nameInput) nameInput.value = name;
  if (list) list.style.display = 'none';

  try {
    const resp = await fetch(`/api/places/detail?place_id=${encodeURIComponent(placeId)}`);
    const data = await resp.json();
    if (data.result) {
      const addr = data.result.formatted_address || '';
      if (addrInput) addrInput.value = addr;
      if (addrText) addrText.textContent = '\uD83D\uDCCD ' + addr;
      gigWizardData.venue_name = name;
      gigWizardData.venue_address = addr;

      // Fetch distance from home postcode
      const homePostcode = window._currentUser?.home_postcode;
      if (homePostcode && addr && addrMeta) {
        addrMeta.textContent = '\u2713 Full address saved';
        if (confirm) confirm.style.display = 'block';
        try {
          const distResp = await fetch(`/api/distance?origin=${encodeURIComponent(homePostcode)}&destination=${encodeURIComponent(addr)}`);
          const distData = await distResp.json();
          if (distData.miles) {
            addrMeta.textContent = `\u2713 Full address saved \u00B7 ${distData.miles} miles from home \u00B7 ~${distData.duration}`;
          }
        } catch (e) {
          console.error('Distance fetch error:', e);
        }
      } else {
        if (addrMeta) addrMeta.textContent = '\u2713 Full address saved';
        if (confirm) confirm.style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Venue detail error:', err);
  }
}

function getRecentBands() {
  if (window._cachedGigs && window._cachedGigs.length > 0) {
    const names = [
      ...new Set(window._cachedGigs.map((g) => g.band_name).filter(Boolean)),
    ];
    return names.slice(0, 5);
  }
  return [];
}

async function submitGigWizard() {
  const btn = document.getElementById('wizardNextBtn');
  if (btn) {
    btn.textContent = 'Saving...';
    btn.disabled = true;
  }

  try {
    const payload = {
      band_name: gigWizardData.band_name,
      venue_name: gigWizardData.venue_name,
      venue_address: gigWizardData.venue_address || null,
      date: gigWizardData.date,
      start_time: gigWizardData.start_time || null,
      end_time: gigWizardData.end_time || null,
      load_in_time: gigWizardData.load_in_time || null,
      fee: gigWizardData.fee ? parseFloat(gigWizardData.fee) : null,
      status: gigWizardData.status,
      notes: gigWizardData.notes
        ? (gigWizardData.gig_type
            ? `[${gigWizardData.gig_type}] `
            : '') + gigWizardData.notes
        : gigWizardData.gig_type
          ? `[${gigWizardData.gig_type}]`
          : null,
      dress_code: gigWizardData.dress_code || null,
      source: 'manual',
    };

    const response = await fetch('/api/gigs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      window._cachedGigs = null;
      showScreen('gigs');
      showToast('Gig saved!');
    } else {
      const err = await response.json();
      const body = document.getElementById('wizardBody');
      if (body) {
        body.insertAdjacentHTML(
          'afterbegin',
          `<div class="alert alert-error" style="margin-bottom: var(--spacing-4);">
            Failed to save: ${err.error || 'Unknown error'}
          </div>`
        );
      }
      if (btn) {
        btn.textContent = 'Save Gig';
        btn.disabled = false;
      }
    }
  } catch (error) {
    console.error('Submit gig error:', error);
    if (btn) {
      btn.textContent = 'Save Gig';
      btn.disabled = false;
    }
  }
}

function renderFullGigForm() {
  const content = document.getElementById('createGigScreen');
  const d = gigWizardData;

  const gigTypes = [
    { label: '\u{1F492} Wedding', value: 'Wedding' },
    { label: '\u{1F3E2} Corporate', value: 'Corporate' },
    { label: '\u{1F37A} Pub / Club', value: 'Pub / Club' },
    { label: '\u{1F389} Private party', value: 'Private party' },
    { label: '\u{1F3AA} Festival', value: 'Festival' },
    { label: '\u{1F3E8} Hotel', value: 'Hotel' },
    { label: '\u{1F3AD} Theatre', value: 'Theatre' },
    { label: '\u26EA Church', value: 'Church' },
    { label: '\u{1F37D}\uFE0F Restaurant', value: 'Restaurant' },
    { label: '\u{1F4CC} Other', value: 'Other' },
  ];

  const statusOptions = [
    { label: 'Confirmed', value: 'confirmed', color: 'success' },
    { label: 'Pencilled', value: 'tentative', color: 'warning' },
    { label: 'Enquiry', value: 'enquiry', color: 'info' },
  ];

  const sourceOptions = [
    { label: '\u270B Manual entry', value: 'manual' },
    { label: '\uD83D\uDD04 From calendar', value: 'calendar' },
    { label: '\uD83D\uDCEC From CRM', value: 'crm' },
  ];

  content.innerHTML = `
    <div style="background:var(--surface);padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
      <button onclick="openGigWizard()" style="color:var(--accent);font-size:14px;font-weight:500;cursor:pointer;background:none;border:none;">&#8249; Wizard</button>
      <div style="font-size:16px;font-weight:700;color:var(--text);">Full Form</div>
      <div style="width:50px;"></div>
    </div>
    <div style="overflow-y:auto;flex:1;padding:16px;">
      <!-- Summary bar -->
      <div style="background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);border-radius:14px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-size:12px;font-weight:600;color:var(--accent);margin-bottom:4px;">📋 Gig so far</div>
        <div style="font-size:11px;color:var(--text-2);line-height:1.5;">Tap any field below to edit. Everything from the wizard is preserved.</div>
      </div>
      <!-- Source badges -->
      <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;">
        ${sourceOptions.map(s => `
          <span onclick="selectFullFormSource('${s.value}')" style="padding:5px 12px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;${(d.source || 'manual') === s.value ? 'background:var(--accent-dim);color:var(--accent);border:1px solid rgba(240,165,0,.3);' : 'background:var(--card);color:var(--text-2);border:1px solid var(--border);'}">${s.label}</span>
        `).join('')}
      </div>
      <form id="createGigForm">
        <div class="form-group">
          <label class="form-label">Band / Client</label>
          <input type="text" class="form-input" name="band_name" value="${escapeHtml(d.band_name)}" placeholder="e.g. The Silverstone Band">
        </div>
        <!-- Gig type chips -->
        <div class="form-group">
          <label class="form-label">What type of gig?</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;" id="fullFormGigTypes">
            ${gigTypes.map(t => `
              <span onclick="selectFullFormGigType('${t.value}', this)" style="padding:5px 12px;border-radius:20px;font-size:11px;font-weight:500;cursor:pointer;${d.gig_type === t.value ? 'background:var(--accent-dim);color:var(--accent);border:1px solid rgba(240,165,0,.3);' : 'background:var(--card);color:var(--text-2);border:1px solid var(--border);'}">${t.label}</span>
            `).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Venue</label>
          <input type="text" class="form-input" name="venue_name" value="${escapeHtml(d.venue_name)}" placeholder="Search venues...">
          ${d.venue_address ? `<div style="font-size:11px;color:var(--success);margin-top:4px;">📍 ${escapeHtml(d.venue_address)}</div>` : ''}
          <input type="hidden" name="venue_address" value="${escapeHtml(d.venue_address)}">
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input type="date" class="form-input" name="date" value="${d.date}" required>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="form-group">
            <label class="form-label">Start time</label>
            <input type="time" class="form-input" name="start_time" value="${d.start_time}">
          </div>
          <div class="form-group">
            <label class="form-label">End time</label>
            <input type="time" class="form-input" name="end_time" value="${d.end_time}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Load-in / arrival</label>
          <input type="time" class="form-input" name="load_in_time" value="${d.load_in_time}" style="max-width:50%;">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="form-group">
            <label class="form-label">Fee (\u00A3)</label>
            <input type="number" class="form-input" name="fee" value="${d.fee}" placeholder="280" min="0" step="1">
          </div>
          <div class="form-group">
            <label class="form-label">Status</label>
            <div style="display:flex;gap:6px;" id="fullFormStatusChips">
              ${statusOptions.map(s => `
                <span onclick="selectFullFormStatus('${s.value}')" style="flex:1;text-align:center;padding:10px 6px;border-radius:12px;font-size:12px;font-weight:600;cursor:pointer;${(d.status || 'confirmed') === s.value ? `background:var(--${s.color}-dim);color:var(--${s.color});border:2px solid var(--${s.color});` : 'background:var(--card);color:var(--text-2);border:2px solid var(--border);'}">${s.label}</span>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Dress code</label>
          <input type="text" class="form-input" name="dress_code" value="${escapeHtml(d.dress_code)}" placeholder="e.g. Black tie">
        </div>
        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea class="form-textarea" name="notes" placeholder="Parking info, contacts, anything useful..." rows="3">${escapeHtml(d.notes)}</textarea>
        </div>
        <!-- Lineup section (premium) -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:600;color:var(--text);">Lineup</div>
            <span style="font-size:9px;font-weight:700;color:var(--accent);background:var(--accent-dim);border-radius:6px;padding:2px 6px;text-transform:uppercase;">Premium</span>
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-bottom:10px;">Manage who's playing this gig. Available with Premium.</div>
          <div style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--card);border:1px dashed var(--border);border-radius:10px;">
            <div style="width:28px;height:28px;border-radius:14px;border:1px dashed var(--text-3);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-3);">?</div>
            <div style="flex:1;font-size:12px;color:var(--text-3);">Add lineup members</div>
            <span style="font-size:11px;color:var(--accent);font-weight:600;cursor:pointer;">Send dep</span>
          </div>
        </div>
        <div id="fullFormError" class="alert alert-error" style="display:none;margin-bottom:12px;"></div>
        <button type="submit" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:24px;padding:13px 24px;font-size:15px;font-weight:700;cursor:pointer;">Save gig</button>
      </form>
    </div>
  `;

  document.getElementById('createGigForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('[type="submit"]');
    submitBtn.textContent = 'Saving...';
    submitBtn.disabled = true;

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);
    Object.keys(data).forEach((k) => {
      if (data[k] === '') data[k] = null;
    });
    data.status = gigWizardData.status || 'confirmed';
    data.source = gigWizardData.source || 'manual';
    if (gigWizardData.gig_type) {
      data.notes = data.notes
        ? `[${gigWizardData.gig_type}] ${data.notes}`
        : `[${gigWizardData.gig_type}]`;
    }

    try {
      const response = await fetch('/api/gigs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (response.ok) {
        window._cachedGigs = null;
        showScreen('gigs');
        showToast('Gig saved!');
      } else {
        const err = await response.json();
        const errEl = document.getElementById('fullFormError');
        if (errEl) {
          errEl.textContent = err.error || 'Failed to save gig';
          errEl.style.display = 'block';
        }
        submitBtn.textContent = 'Save gig';
        submitBtn.disabled = false;
      }
    } catch (error) {
      console.error('Create gig error:', error);
      submitBtn.textContent = 'Save gig';
      submitBtn.disabled = false;
    }
  });
}

function selectFullFormSource(value) {
  gigWizardData.source = value;
  renderFullGigForm();
}

function selectFullFormGigType(value, el) {
  gigWizardData.gig_type = gigWizardData.gig_type === value ? '' : value;
  // Re-render chips
  const container = document.getElementById('fullFormGigTypes');
  if (container) {
    container.querySelectorAll('span').forEach(s => {
      const v = s.textContent.trim();
      const isSelected = gigWizardData.gig_type && s.onclick.toString().includes(gigWizardData.gig_type);
    });
  }
  renderFullGigForm();
}

function selectFullFormStatus(value) {
  gigWizardData.status = value;
  renderFullGigForm();
}

// ── Screen setup stubs ──────────────────────────────────────────────────────

function setupGigsScreen() {}
function setupInvoicesScreen() {}
function setupOffersScreen() {}

// ── Quick actions ────────────────────────────────────────────────────────────

function handleQuickAction(action) {
  if (action === 'add-gig') {
    openGigWizard();
  } else if (action === 'invoice') {
    openPanel('panel-invoice');
    initInvoicePanel();
  } else if (action === 'block-date') {
    openPanel('panel-block');
  } else if (action === 'send-dep') {
    openPanel('panel-dep');
    initDepPanel();
  } else if (action === 'receipt') {
    openPanel('panel-receipt');
    initReceiptPanel();
  }
}

// ── Panel open / close ────────────────────────────────────────────────────────

function openPanel(id) {
  document.getElementById(id).classList.add('open');
  // Trigger render for panels that need dynamic content
  if (id === 'profile-panel') renderProfileScreen();
}

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
}

// Make panel helpers accessible from inline HTML onclick
window.openPanel = openPanel;
window.closePanel = closePanel;

// ── Gig Detail View ─────────────────────────────────────────────────────────
async function openGigDetail(gigId) {
  const body = document.getElementById('gigDetailBody');
  if (!body) return;

  // Try cache first, then fetch
  let gig = (window._cachedGigs || []).find((g) => g.id === gigId);
  if (!gig) {
    try {
      const resp = await fetch(`/api/gigs/${gigId}`);
      gig = await resp.json();
    } catch (e) {
      body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load gig details.</div>';
      openPanel('panel-gig-detail');
      return;
    }
  }

  const homePostcode = window._currentUser?.home_postcode;
  let mileageHTML = '';

  // Build completeness tracker
  const fields = [
    { name: 'Venue', ok: !!gig.venue_name },
    { name: 'Times', ok: !!gig.start_time },
    { name: 'Fee', ok: !!gig.fee && parseFloat(gig.fee) > 0 },
    { name: 'Dress code', ok: !!gig.dress_code },
    { name: 'Notes', ok: !!gig.notes },
    { name: 'Address', ok: !!gig.venue_address },
  ];
  const doneCount = fields.filter((f) => f.ok).length;

  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--border);">
      <button onclick="closePanel('panel-gig-detail')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
      <div style="font-size:14px;font-weight:700;color:var(--text);">Gig Details</div>
      <button onclick="openEditGig('${gig.id}')" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;font-weight:600;">Edit</button>
    </div>
    <div style="background:var(--surface);padding:16px 20px 20px;">
      <div style="font-size:13px;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${escapeHtml(gig.band_name || 'Unnamed Gig')}</div>
      <div style="font-size:22px;font-weight:700;color:var(--text);margin-bottom:16px;">${escapeHtml(gig.venue_name || 'No venue')}</div>
      <div style="font-size:14px;color:var(--text-2);margin-bottom:6px;">\uD83D\uDCC5 ${formatDateLong(gig.date)}</div>
      ${gig.start_time ? `<div style="font-size:14px;color:var(--text-2);margin-bottom:6px;">\uD83D\uDD56 ${formatTime(gig.start_time)}${gig.end_time ? '\u2013' + formatTime(gig.end_time) : ''}${gig.load_in_time ? ' \u00B7 Load-in: ' + formatTime(gig.load_in_time) : ''}</div>` : ''}
      ${gig.venue_address ? `<div style="font-size:14px;color:var(--text-2);margin-bottom:6px;">\uD83D\uDCCD ${escapeHtml(gig.venue_address)}</div>` : ''}
      <div style="font-size:14px;color:var(--text-2);">\uD83D\uDCB7 ${gig.fee ? '\u00A3' + parseFloat(gig.fee).toFixed(0) : 'No fee set'} <span class="badge badge-${statusBadgeClass(gig.status)}" style="margin-left:6px;">${statusLabel(gig.status)}</span></div>
      <div id="gigDetailMileage" style="margin-top:8px;"></div>
      <!-- Completeness tracker -->
      <div style="margin-top:12px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:12px;font-weight:600;color:var(--text);">Gig details</div>
          <div style="font-size:11px;color:var(--success);font-weight:600;">${doneCount} of ${fields.length} complete</div>
        </div>
        <div style="display:flex;gap:3px;margin-bottom:8px;">
          ${fields.map((f) => `<div style="flex:1;height:4px;border-radius:2px;background:${f.ok ? 'var(--success)' : 'var(--border)'};"></div>`).join('')}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${fields.map((f) => f.ok
            ? `<span style="font-size:10px;color:var(--success);background:var(--success-dim);border-radius:8px;padding:3px 8px;">\u2713 ${f.name}</span>`
            : `<span style="font-size:10px;color:var(--warning);background:var(--warning-dim);border:1px solid rgba(240,165,0,.3);border-radius:8px;padding:3px 8px;">+ Add ${f.name.toLowerCase()}</span>`
          ).join('')}
        </div>
      </div>
    </div>
    <!-- Gig Pack -->
    <div style="padding:16px 20px;border-top:1px solid var(--border);">
      <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">\uD83C\uDF92 Gig Pack</div>
      ${gig.dress_code ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Dress code</span><span style="color:var(--text);font-weight:500;">${escapeHtml(gig.dress_code)}</span></div>` : ''}
      ${gig.load_in_time ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Load-in</span><span style="color:var(--text);font-weight:500;">${formatTime(gig.load_in_time)}</span></div>` : ''}
      ${gig.start_time ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Set times</span><span style="color:var(--text);font-weight:500;">${formatTime(gig.start_time)}${gig.end_time ? '\u2013' + formatTime(gig.end_time) : ''}</span></div>` : ''}
      ${gig.notes ? `<div style="display:flex;justify-content:space-between;padding:10px 0;font-size:14px;"><span style="color:var(--text-2);">Notes</span><span style="color:var(--text);font-weight:500;text-align:right;max-width:60%;">${escapeHtml(gig.notes)}</span></div>` : ''}
      ${!gig.dress_code && !gig.load_in_time && !gig.notes ? '<div style="font-size:13px;color:var(--text-3);padding:10px 0;">No gig pack info yet. Edit the gig to add details.</div>' : ''}
    </div>
    <!-- Lineup (Premium) -->
    <div style="padding:16px 20px;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Lineup</div>
        <span style="font-size:9px;font-weight:700;color:var(--accent);background:var(--accent-dim);border-radius:6px;padding:2px 6px;text-transform:uppercase;">Premium</span>
      </div>
      <div style="font-size:12px;color:var(--text-3);padding:10px;background:var(--card);border:1px dashed var(--border);border-radius:10px;text-align:center;">Lineup management is coming with Premium</div>
    </div>
    <!-- Setlist -->
    <div style="padding:16px 20px;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">🎵 Setlist</div>
        <span style="font-size:11px;color:var(--accent);cursor:pointer;">Change</span>
      </div>
      <div style="font-size:12px;color:var(--text-3);padding:10px;background:var(--card);border:1px solid var(--border);border-radius:10px;text-align:center;">No setlist assigned yet</div>
    </div>
    <!-- Prep checklist -->
    <div style="padding:16px 20px;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">📋 Prep checklist</div>
        <span style="font-size:11px;color:var(--accent);cursor:pointer;">+ Add</span>
      </div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;">
        <div class="prep-item" onclick="togglePrepItem(this)" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;">
          <span style="font-size:14px;">○</span>
          <span style="font-size:13px;color:var(--text);">Check PA requirements</span>
        </div>
        <div class="prep-item" onclick="togglePrepItem(this)" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;">
          <span style="font-size:14px;">○</span>
          <span style="font-size:13px;color:var(--text);">Confirm set times with band</span>
        </div>
        <div class="prep-item" onclick="togglePrepItem(this)" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;">
          <span style="font-size:14px;">○</span>
          <span style="font-size:13px;color:var(--text);">Pack gear the night before</span>
        </div>
        <div class="prep-item" onclick="togglePrepItem(this)" style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;">
          <span style="font-size:14px;">○</span>
          <span style="font-size:13px;color:var(--text);">Print/download setlist</span>
        </div>
      </div>
    </div>
    <!-- Actions -->
    <div style="padding:16px 20px;border-top:1px solid var(--border);">
      <button style="width:100%;background:var(--card);color:var(--accent);border:1px solid var(--accent);border-radius:24px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px;" onclick="openGigChat('${gig.id}')">💬 Message band</button>
      <button style="width:100%;background:var(--accent);color:#000;border:none;border-radius:24px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px;" onclick="closePanel('panel-gig-detail')">Create invoice for this gig</button>
      <!-- Ask for review -->
      <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <div style="font-size:24px;">⭐</div>
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--text);">Ask for a review</div>
            <div style="font-size:11px;color:var(--text-2);">Send the client a review link after the gig</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button style="flex:1;background:var(--card);color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:8px;font-size:11px;font-weight:600;cursor:pointer;">🔵 Google Review</button>
          <button style="flex:1;background:var(--card);color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:8px;font-size:11px;font-weight:600;cursor:pointer;">📘 Facebook Review</button>
        </div>
        <div style="text-align:center;font-size:10px;color:var(--text-3);margin-top:6px;">Set up your review links in Profile > Account settings</div>
      </div>
      <button style="width:100%;background:var(--card);color:var(--danger);border:1px solid var(--danger);border-radius:24px;padding:12px;font-size:14px;font-weight:500;cursor:pointer;" onclick="closePanel('panel-gig-detail');deleteGig('${gig.id}')">Delete gig</button>
    </div>
  `;

  openPanel('panel-gig-detail');

  // Fetch mileage in background
  if (homePostcode && gig.venue_address) {
    try {
      const distResp = await fetch(`/api/distance?origin=${encodeURIComponent(homePostcode)}&destination=${encodeURIComponent(gig.venue_address)}`);
      const distData = await distResp.json();
      const mileageEl = document.getElementById('gigDetailMileage');
      if (distData.miles && mileageEl) {
        const claimable = (distData.miles * 2 * 0.45).toFixed(2);
        mileageEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="font-size:14px;color:var(--text-2);">\uD83D\uDE97 ${distData.miles} miles round trip</div>
            <span style="font-size:11px;color:var(--success);background:var(--success-dim);border-radius:8px;padding:2px 8px;font-weight:600;">\u00A3${claimable} claimable</span>
          </div>
        `;
      }
    } catch (e) {
      console.error('Mileage fetch error:', e);
    }
  }
}

function togglePrepItem(el) {
  const icon = el.querySelector('span:first-child');
  const text = el.querySelector('span:last-child');
  if (icon.textContent === '○') {
    icon.textContent = '\u2713';
    icon.style.color = 'var(--success)';
    text.style.textDecoration = 'line-through';
    text.style.opacity = '0.5';
  } else {
    icon.textContent = '○';
    icon.style.color = '';
    text.style.textDecoration = '';
    text.style.opacity = '';
  }
}

async function deleteGig(gigId) {
  if (!confirm('Are you sure you want to delete this gig?')) return;
  try {
    await fetch(`/api/gigs/${gigId}`, { method: 'DELETE' });
    // Refresh gigs cache and list
    window._cachedGigs = (window._cachedGigs || []).filter((g) => g.id !== gigId);
    renderGigsList(window._cachedGigs);
  } catch (e) {
    console.error('Delete gig error:', e);
  }
}

async function openEditGig(gigId) {
  const panel = document.getElementById('edit-gig-panel');
  if (!panel) return;

  panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading gig...</div>';
  openPanel('edit-gig-panel');

  try {
    let gig = (window._cachedGigs || []).find(g => g.id === gigId);
    if (!gig) {
      const res = await fetch(`/api/gigs/${gigId}`);
      if (!res.ok) throw new Error('Failed to fetch gig');
      gig = await res.json();
    }

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('edit-gig-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">Edit Gig</div>
        <button onclick="deleteGig('${gig.id}')" style="background:none;border:none;color:var(--danger);font-size:14px;cursor:pointer;font-weight:600;">Delete</button>
      </div>
      <div style="padding:0 16px 20px;">
        <div class="form-group">
          <label class="fl">Band name</label>
          <input type="text" class="fi" id="editBandName" value="${escapeHtml(gig.band_name || '')}" />
        </div>
        <div class="form-group">
          <label class="fl">Venue</label>
          <input type="text" class="fi" id="editVenue" value="${escapeHtml(gig.venue_name || '')}" />
        </div>
        <div class="form-group">
          <label class="fl">Date</label>
          <input type="date" class="fi" id="editDate" value="${gig.date || ''}" />
        </div>
        <div style="display:flex;gap:10px;">
          <div class="form-group" style="flex:1;">
            <label class="fl">Start time</label>
            <input type="time" class="fi" id="editStartTime" value="${gig.start_time || ''}" />
          </div>
          <div class="form-group" style="flex:1;">
            <label class="fl">End time</label>
            <input type="time" class="fi" id="editEndTime" value="${gig.end_time || ''}" />
          </div>
        </div>
        <div class="form-group">
          <label class="fl">Fee (£)</label>
          <input type="number" class="fi" id="editFee" value="${gig.fee || ''}" />
        </div>
        <div class="form-group">
          <label class="fl">Status</label>
          <select class="fi" id="editStatus">
            <option value="confirmed" ${gig.status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
            <option value="tentative" ${gig.status === 'tentative' ? 'selected' : ''}>Pencilled</option>
            <option value="enquiry" ${gig.status === 'enquiry' ? 'selected' : ''}>Enquiry</option>
            <option value="cancelled" ${gig.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
          </select>
        </div>
        <div class="form-group">
          <label class="fl">Dress code</label>
          <input type="text" class="fi" id="editDressCode" value="${escapeHtml(gig.dress_code || '')}" />
        </div>
        <div class="form-group">
          <label class="fl">Notes</label>
          <textarea class="fi" id="editNotes" style="resize:vertical;height:80px;">${escapeHtml(gig.notes || '')}</textarea>
        </div>
        <button onclick="saveEditGig('${gig.id}')" class="pill">Save Changes</button>
      </div>`;

    panel.innerHTML = html;
  } catch (err) {
    console.error('Edit gig error:', err);
    panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load gig</div>';
  }
}

async function saveEditGig(gigId) {
  try {
    const data = {
      band_name: document.getElementById('editBandName').value,
      venue_name: document.getElementById('editVenue').value,
      date: document.getElementById('editDate').value,
      start_time: document.getElementById('editStartTime').value,
      end_time: document.getElementById('editEndTime').value,
      fee: parseFloat(document.getElementById('editFee').value) || 0,
      status: document.getElementById('editStatus').value,
      dress_code: document.getElementById('editDressCode').value,
      notes: document.getElementById('editNotes').value,
    };

    const res = await fetch(`/api/gigs/${gigId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) throw new Error('Failed to save gig');

    // Update cache
    window._cachedGigs = (window._cachedGigs || []).map(g => g.id === gigId ? { ...g, ...data, id: gigId } : g);
    closePanel('edit-gig-panel');
    renderGigsList(window._cachedGigs);
  } catch (err) {
    console.error('Save gig error:', err);
    alert('Failed to save gig');
  }
}

// openPanel / closePanel defined earlier (line ~1969) — removed duplicate here

function editProfile() {
  // TODO: implement edit profile
  alert('Edit profile coming soon');
}

function shareProfile() {
  // TODO: implement share profile
  alert('Share profile coming soon');
}

function viewEPK() {
  openPanel('epk-panel');
}

function shareAvailability() {
  // TODO: implement share availability
  alert('Share availability coming soon');
}

function toggleTheme() {
  document.body.classList.toggle('light-mode');
  const newTheme = document.body.classList.contains('light-mode') ? 'light' : 'dark';
  localStorage.setItem('theme', newTheme);
}

function toggleCalendarSync() {
  // TODO: implement calendar sync toggle
  alert('Calendar sync coming soon');
}

async function openNetworkPanel() {
  const body = document.getElementById('networkBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading contacts...</div>';

  try {
    const res = await fetch('/api/contacts');
    if (!res.ok) throw new Error('Failed to fetch contacts');
    const contacts = await res.json();

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('network-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">My Network</div>
        <button onclick="openPanel('add-contact')" style="background:var(--accent);color:#000;border:none;border-radius:12px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">+ Add</button>
      </div>
      <div style="padding:0 16px 8px;">
        <input type="text" class="fi" placeholder="Search contacts..." id="contactSearch" oninput="filterContacts()" />
      </div>
      <div style="display:flex;gap:6px;padding:0 16px 8px;overflow-x:auto;">
        <button class="filter-badge ac" onclick="filterContactsByType('all')">All</button>
        <button class="filter-badge" onclick="filterContactsByType('favourite')">Favourites</button>
        <button class="filter-badge" onclick="filterContactsByType('instrument')">By instrument</button>
      </div>
      <div id="contactsList" style="padding:0 16px;">`;

    contacts.forEach(contact => {
      const initial = (contact.name || 'U')[0].toUpperCase();
      html += `
      <div onclick="openContactDetail('${contact.id}')" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;">
        <div style="width:40px;height:40px;border-radius:20px;background:var(--accent-dim);border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--accent);flex-shrink:0;">${initial}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(contact.name)}</div>
          <div style="font-size:11px;color:var(--text-2);">${escapeHtml(contact.instruments || 'No instruments')}</div>
          <div style="font-size:10px;color:var(--text-3);">Last gig: ${contact.last_gig_date ? formatDateShort(contact.last_gig_date) : 'Never'}</div>
        </div>
        <span style="font-size:14px;cursor:pointer;" onclick="toggleFavourite('${contact.id}', event)">${contact.favourite ? '⭐' : '☆'}</span>
      </div>`;
    });

    html += `</div>`;
    body.innerHTML = html;
  } catch (err) {
    console.error('Network panel error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load contacts</div>';
  }
}

async function openContactDetail(contactId) {
  const panel = document.getElementById('contact-detail-panel');
  if (!panel) return;

  panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading contact...</div>';
  openPanel('contact-detail-panel');

  try {
    const res = await fetch(`/api/contacts/${contactId}`);
    if (!res.ok) throw new Error('Failed to fetch contact');
    const contact = await res.json();

    const initial = (contact.name || 'U')[0].toUpperCase();

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('contact-detail-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">Contact</div>
        <div style="width:32px;"></div>
      </div>
      <div style="padding:0 16px;text-align:center;margin-bottom:12px;">
        <div style="width:48px;height:48px;margin:0 auto 12px;border-radius:24px;background:var(--accent-dim);border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:var(--accent);">${initial}</div>
        <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(contact.name)}</div>
        <div style="font-size:12px;color:var(--text-2);margin-top:2px;">${escapeHtml(contact.instruments || 'No instruments')}</div>
        ${contact.location ? `<div style="font-size:12px;color:var(--text-2);">📍 ${escapeHtml(contact.location)}</div>` : ''}
      </div>
      <div style="padding:0 16px;margin-bottom:12px;">
        ${contact.phone ? `<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Phone</span><br/><span style="color:var(--text);font-weight:600;">${escapeHtml(contact.phone)}</span></div>` : ''}
        ${contact.email ? `<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Email</span><br/><span style="color:var(--text);font-weight:600;">${escapeHtml(contact.email)}</span></div>` : ''}
        ${contact.gigs_together ? `<div style="padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Gigs together</span><br/><span style="color:var(--text);font-weight:600;">${contact.gigs_together}</span></div>` : ''}
        ${contact.last_gig_date ? `<div style="padding:10px 0;font-size:13px;"><span style="color:var(--text-2);">Last gig</span><br/><span style="color:var(--text);font-weight:600;">${formatDateShort(contact.last_gig_date)}</span></div>` : ''}
      </div>
      <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
        <button onclick="sendDepOffer('${contact.id}')" class="pill-o">Send dep offer</button>
        <button onclick="messageContact('${contact.id}')" class="pill-o">Message</button>
        <button onclick="callContact('${contact.id}')" class="pill-g">Call</button>
      </div>
      ${contact.notes ? `<div style="padding:0 16px;margin-bottom:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Notes</div>
        <div style="font-size:13px;color:var(--text);">${escapeHtml(contact.notes)}</div>
      </div>` : ''}`;

    panel.innerHTML = html;
  } catch (err) {
    console.error('Contact detail error:', err);
    panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load contact</div>';
  }
}

async function openRepertoirePanel() {
  const body = document.getElementById('repertoireBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading repertoire...</div>';

  try {
    const songsRes = await fetch('/api/songs');
    const songs = songsRes.ok ? await songsRes.json() : [];

    const setlistsRes = await fetch('/api/setlists');
    const setlists = setlistsRes.ok ? await setlistsRes.json() : [];

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('repertoire-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">Repertoire</div>
        <div style="width:32px;"></div>
      </div>
      <div style="display:flex;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;">
        <div class="tb ac" onclick="switchRepertoireTab('songs')">Songs</div>
        <div class="tb" onclick="switchRepertoireTab('setlists')">Setlists</div>
      </div>
      <div id="repertoireContent" style="padding:0 16px;">`;

    // Songs tab
    html += `<div id="songsTab">
      <div style="padding:8px 0;">
        <input type="text" class="fi" placeholder="Search songs..." id="songSearch" oninput="filterSongs()" />
      </div>
      <button onclick="openPanel('song-form')" class="pill" style="margin-bottom:12px;">+ Add Song</button>
      ${songs.map(song => `
      <div onclick="openSongForm('${song.id}')" style="padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(song.title)}</div>
        <div style="font-size:11px;color:var(--text-2);">${escapeHtml(song.artist)} · Key: ${song.key || 'N/A'} · ${song.tempo || '?'} BPM</div>
      </div>`).join('')}
    </div>`;

    // Setlists tab
    html += `<div id="setlistsTab" style="display:none;">
      <button onclick="openPanel('create-setlist')" class="pill" style="margin-bottom:12px;">+ Create Setlist</button>
      ${setlists.map(setlist => `
      <div style="padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(setlist.name)}</div>
        <div style="font-size:11px;color:var(--text-2);">${setlist.song_count} songs · ${setlist.duration || '?'} mins · ${setlist.linked_gig ? 'Linked to gig' : 'Not linked'}</div>
      </div>`).join('')}
    </div>`;

    html += `</div>`;
    body.innerHTML = html;
  } catch (err) {
    console.error('Repertoire error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load repertoire</div>';
  }
}

async function openSongForm(songId) {
  const panel = document.getElementById('song-form-panel');
  if (!panel) return;

  if (songId) {
    panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading song...</div>';
    try {
      const res = await fetch(`/api/songs/${songId}`);
      if (!res.ok) throw new Error('Failed to fetch song');
      const song = await res.json();

      panel.innerHTML = `
        <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
          <button onclick="closePanel('song-form-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
          <div style="font-size:16px;font-weight:700;color:var(--text);">Edit Song</div>
          <div style="width:32px;"></div>
        </div>
        <div style="padding:0 16px 20px;">
          <div class="form-group">
            <label class="fl">Title</label>
            <input type="text" class="fi" id="songTitle" value="${escapeHtml(song.title || '')}" />
          </div>
          <div class="form-group">
            <label class="fl">Artist</label>
            <input type="text" class="fi" id="songArtist" value="${escapeHtml(song.artist || '')}" />
          </div>
          <div class="form-group">
            <label class="fl">Key</label>
            <input type="text" class="fi" id="songKey" value="${escapeHtml(song.key || '')}" placeholder="C, Dm, etc." />
          </div>
          <div style="display:flex;gap:10px;">
            <div class="form-group" style="flex:1;">
              <label class="fl">Tempo (BPM)</label>
              <input type="number" class="fi" id="songTempo" value="${song.tempo || ''}" />
            </div>
            <div class="form-group" style="flex:1;">
              <label class="fl">Duration (mins)</label>
              <input type="number" class="fi" id="songDuration" value="${song.duration || ''}" />
            </div>
          </div>
          <div class="form-group">
            <label class="fl">Genre</label>
            <input type="text" class="fi" id="songGenre" value="${escapeHtml(song.genre || '')}" />
          </div>
          <div class="form-group">
            <label class="fl">Tags</label>
            <input type="text" class="fi" id="songTags" value="${escapeHtml(song.tags || '')}" placeholder="comma separated" />
          </div>
          <div class="form-group">
            <label class="fl">Lyrics</label>
            <textarea class="fi" id="songLyrics" style="resize:vertical;height:120px;">${escapeHtml(song.lyrics || '')}</textarea>
          </div>
          <button onclick="saveSong('${song.id}')" class="pill">Save Song</button>
        </div>`;
    } catch (err) {
      console.error('Song form error:', err);
      panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load song</div>';
    }
  } else {
    panel.innerHTML = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('song-form-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">Add Song</div>
        <div style="width:32px;"></div>
      </div>
      <div style="padding:0 16px 20px;">
        <div class="form-group">
          <label class="fl">Title</label>
          <input type="text" class="fi" id="songTitle" placeholder="Song title" />
        </div>
        <div class="form-group">
          <label class="fl">Artist</label>
          <input type="text" class="fi" id="songArtist" placeholder="Artist name" />
        </div>
        <div class="form-group">
          <label class="fl">Key</label>
          <input type="text" class="fi" id="songKey" placeholder="C, Dm, etc." />
        </div>
        <div style="display:flex;gap:10px;">
          <div class="form-group" style="flex:1;">
            <label class="fl">Tempo (BPM)</label>
            <input type="number" class="fi" id="songTempo" />
          </div>
          <div class="form-group" style="flex:1;">
            <label class="fl">Duration (mins)</label>
            <input type="number" class="fi" id="songDuration" />
          </div>
        </div>
        <div class="form-group">
          <label class="fl">Genre</label>
          <input type="text" class="fi" id="songGenre" />
        </div>
        <div class="form-group">
          <label class="fl">Tags</label>
          <input type="text" class="fi" id="songTags" placeholder="comma separated" />
        </div>
        <div class="form-group">
          <label class="fl">Lyrics</label>
          <textarea class="fi" id="songLyrics" style="resize:vertical;height:120px;"></textarea>
        </div>
        <button onclick="saveSong()" class="pill">Save Song</button>
      </div>`;
  }

  openPanel('song-form-panel');
}

async function openEpkPanel() {
  const body = document.getElementById('epkBody');
  if (!body) return;

  body.innerHTML = `
    <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
      <button onclick="closePanel('epk-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
      <div style="font-size:16px;font-weight:700;color:var(--text);">Professional EPK</div>
      <div style="width:32px;"></div>
    </div>
    <div style="padding:16px 20px;text-align:center;">
      <div style="font-size:32px;margin-bottom:8px;">⭐</div>
      <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px;">Premium Feature</div>
      <div style="font-size:13px;color:var(--text-2);margin-bottom:16px;">Create a stunning electronic press kit to share with venues and promoters</div>
      <button class="pill" style="background:var(--accent);">Upgrade to Premium</button>
      <div style="margin-top:16px;padding:16px;background:var(--card);border-radius:var(--r);border:1px solid var(--border);">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">What's included</div>
        <div style="font-size:12px;color:var(--text);line-height:1.6;">
          · Custom bio section<br/>
          · Video showcases<br/>
          · Audio clips<br/>
          · Testimonials<br/>
          · Career stats<br/>
          · Shareable link
        </div>
      </div>
    </div>`;
}

async function openFinancePanel() {
  const body = document.getElementById('financeBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading earnings...</div>';

  try {
    const res = await fetch('/api/earnings');
    if (!res.ok) throw new Error('Failed to fetch earnings');
    const earnings = await res.json();

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('finance-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">Earnings & Tax</div>
        <div style="width:32px;"></div>
      </div>
      <div style="padding:0 16px 16px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;margin-top:12px;">Monthly breakdown</div>
        <div style="display:flex;align-items:flex-end;gap:2px;height:80px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:8px;">
          ${(earnings.monthly_breakdown || []).map(m => {
            const max = Math.max(...(earnings.monthly_breakdown || []).map(x => x.earnings));
            const height = Math.min(100, (m.earnings / (max || 1)) * 100);
            return `<div style="flex:1;background:var(--success);border-radius:2px;height:${Math.max(4, height)}%;opacity:${m.status === 'forecast' ? 0.4 : 1};" title="£${m.earnings}"></div>`;
          }).join('')}
        </div>
      </div>
      <div style="padding:0 16px 16px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Paid</div>
            <div style="font-size:14px;font-weight:700;color:var(--success);">£${earnings.paid_total || 0}</div>
          </div>
          <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Unpaid</div>
            <div style="font-size:14px;font-weight:700;color:var(--warning);">£${earnings.unpaid_total || 0}</div>
          </div>
          <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Overdue</div>
            <div style="font-size:14px;font-weight:700;color:var(--danger);">£${earnings.overdue_total || 0}</div>
          </div>
          <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Expenses</div>
            <div style="font-size:14px;font-weight:700;color:var(--text);">£${earnings.expenses_total || 0}</div>
          </div>
        </div>
      </div>
      <div style="padding:0 16px 16px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Tax year overview</div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px;">
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;">
            <span style="color:var(--text-2);">Income</span>
            <span style="color:var(--text);font-weight:600;">£${earnings.year_income || 0}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;">
            <span style="color:var(--text-2);">Expenses</span>
            <span style="color:var(--text);font-weight:600;">£${earnings.year_expenses || 0}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:12px;font-weight:600;">
            <span style="color:var(--text);">Taxable profit</span>
            <span style="color:var(--success);">£${(earnings.year_income || 0) - (earnings.year_expenses || 0)}</span>
          </div>
        </div>
      </div>
      <div style="padding:0 16px;display:flex;flex-direction:column;gap:6px;">
        <button class="pill-g">Export CSV</button>
        <button class="pill-g">Export PDF</button>
        <button class="pill-g">Receipts ZIP</button>
      </div>`;

    body.innerHTML = html;
  } catch (err) {
    console.error('Finance panel error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load earnings</div>';
  }
}

function saveSong(songId) {
  // TODO: implement save song
  alert('Save song coming soon');
  closePanel('song-form-panel');
}

function filterContacts() {
  // TODO: implement contact filtering
}

function filterContactsByType(type) {
  document.querySelectorAll('#networkBody .filter-badge').forEach(b => b.classList.remove('ac'));
  event.target.classList.add('ac');
}

function toggleFavourite(contactId, e) {
  e.stopPropagation();
  // TODO: implement favourite toggle
}

function sendDepOffer(contactId) {
  // TODO: implement send dep offer
  alert('Send dep offer coming soon');
}

function messageContact(contactId) {
  // TODO: implement message contact
  alert('Message coming soon');
}

function callContact(contactId) {
  // TODO: implement call contact
  alert('Call coming soon');
}

function filterSongs() {
  // TODO: implement song filtering
}

function switchRepertoireTab(tab) {
  document.getElementById('songsTab').style.display = tab === 'songs' ? 'block' : 'none';
  document.getElementById('setlistsTab').style.display = tab === 'setlists' ? 'block' : 'none';
  document.querySelectorAll('#repertoireContent .tb').forEach((t, i) => {
    t.classList.toggle('ac', (i === 0 && tab === 'songs') || (i === 1 && tab === 'setlists'));
  });
}

function markInvoiceAsPaid(invoiceId) {
  // TODO: implement mark as paid
  alert('Mark as paid coming soon');
}

function downloadInvoicePDF(invoiceId) {
  // TODO: implement PDF download
  alert('PDF download coming soon');
}

function chaseInvoicePayment(invoiceId) {
  // TODO: implement chase payment
  alert('Chase payment coming soon');
}

function acceptOffer(offerId) {
  // TODO: implement accept offer
  alert('Accept coming soon');
}

function declineOffer(offerId) {
  // TODO: implement decline offer
  alert('Decline coming soon');
}

function snoozeOffer(offerId, hours) {
  // TODO: implement snooze
  alert('Snooze coming soon');
}

// ── Calendar Nudge (Gig Detection) ──────────────────────────────────────────

let _nudgeEvents = [];

async function openGigNudge() {
  const body = document.getElementById('gigNudgeBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-2);">Scanning your calendar...</div>';
  openPanel('panel-gig-nudge');

  try {
    const resp = await fetch('/api/calendar/events');
    const data = await resp.json();

    if (!data.connected) {
      body.innerHTML = `
        <div style="padding:20px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <div style="width:40px;height:40px;border-radius:10px;background:var(--warning-dim);display:flex;align-items:center;justify-content:center;font-size:20px;">🎵</div>
            <div>
              <div style="font-size:17px;font-weight:700;color:var(--text);">Connect Google Calendar</div>
              <div style="font-size:12px;color:var(--text-2);">We'll detect which events look like gigs</div>
            </div>
          </div>
          <a href="/auth/google/calendar" style="display:block;width:100%;background:var(--accent);color:#000;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;">Connect Google Calendar</a>
          <div style="text-align:center;font-size:10px;color:var(--text-3);margin-top:8px;">Read-only access. We never modify your calendar.</div>
        </div>
      `;
      return;
    }

    _nudgeEvents = data.events.filter(e => !e.already_imported);

    if (_nudgeEvents.length === 0) {
      body.innerHTML = `
        <div style="padding:40px;text-align:center;">
          <div style="font-size:32px;margin-bottom:8px;">✓</div>
          <div style="font-weight:600;color:var(--text);margin-bottom:4px;">All caught up</div>
          <div style="font-size:13px;color:var(--text-2);">No new events that look like gigs</div>
        </div>
      `;
      return;
    }

    renderNudgeList();
  } catch (err) {
    console.error('Nudge fetch error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not check calendar. Try again later.</div>';
  }
}

function renderNudgeList() {
  const body = document.getElementById('gigNudgeBody');
  if (!body) return;

  body.innerHTML = `
    <div style="padding:16px 20px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--warning-dim);display:flex;align-items:center;justify-content:center;font-size:20px;">🎵</div>
        <div>
          <div style="font-size:17px;font-weight:700;color:var(--text);">${_nudgeEvents.length} event${_nudgeEvents.length !== 1 ? 's' : ''} detected</div>
          <div style="font-size:12px;color:var(--text-2);">These look like gigs from your Google Calendar</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">
        <span style="font-size:9px;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">Import to unlock: \uD83D\uDCB7 Fees</span>
        <span style="font-size:9px;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">\uD83D\uDE97 Travel</span>
        <span style="font-size:9px;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">\uD83D\uDCE6 Pack-down</span>
        <span style="font-size:9px;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">\uD83C\uDFB5 Set lists</span>
        <span style="font-size:9px;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 6px;">\uD83D\uDCCA Reports</span>
      </div>
      ${_nudgeEvents.map((e, i) => `
        <div id="nudge-card-${i}" style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:12px;margin-bottom:8px;cursor:pointer;border-left:4px solid var(--info);${e.score < 40 ? 'opacity:.75;' : ''}" onclick="openNudgeDetail(${i})">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px;">
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:600;color:var(--text);">${escapeHtml(e.title)}</div>
              <div style="font-size:11px;color:var(--text-2);margin-top:2px;">${e.date_formatted || ''} \u00B7 ${e.start_time || ''}${e.end_time ? '\u2013' + e.end_time : ''}</div>
              ${e.location ? `<div style="font-size:11px;color:var(--text-3);">\uD83D\uDCCD ${escapeHtml(e.location.split(',')[0])}</div>` : ''}
            </div>
            <div style="font-size:11px;color:var(--accent);font-weight:600;">Review \u2192</div>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            ${e.reasons.map(r => `<span style="font-size:8px;color:var(--warning);background:rgba(240,165,0,.1);border-radius:4px;padding:2px 5px;">${escapeHtml(r)}</span>`).join('')}
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <button onclick="event.stopPropagation();quickImportNudge(${i})" style="flex:1;background:var(--accent);color:#000;border:none;border-radius:8px;padding:7px;font-size:11px;font-weight:600;cursor:pointer;">Quick import</button>
            <button onclick="event.stopPropagation();dismissNudge(${i})" style="background:var(--surface);color:var(--text-3);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:11px;cursor:pointer;">Not a gig</button>
          </div>
        </div>
      `).join('')}
      ${_nudgeEvents.length > 1 ? `
        <button onclick="importAllNudges()" style="width:100%;background:var(--surface);color:var(--accent);border:1px solid var(--accent);border-radius:12px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;margin-top:8px;">Import all ${_nudgeEvents.length} as gigs</button>
      ` : ''}
      <div style="text-align:center;font-size:10px;color:var(--text-3);margin-top:8px;">Events stay linked to Google Calendar</div>
    </div>
  `;
}

function openNudgeDetail(index) {
  const e = _nudgeEvents[index];
  if (!e) return;

  const body = document.getElementById('nudgeDetailBody');
  if (!body) return;

  body.innerHTML = `
    <div style="padding:16px 20px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--warning-dim);display:flex;align-items:center;justify-content:center;font-size:20px;">🎵</div>
        <div>
          <div style="font-size:17px;font-weight:700;color:var(--text);">Is this a gig?</div>
          <div style="font-size:12px;color:var(--text-2);">From Google Calendar</div>
        </div>
      </div>
      <!-- Event details -->
      <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:16px;border-left:4px solid var(--info);">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;">${escapeHtml(e.title)}</div>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:2px;">\uD83D\uDCC5 ${e.date_formatted || 'No date'} \u00B7 ${e.start_time || ''}${e.end_time ? ' \u2013 ' + e.end_time : ''}</div>
        ${e.location ? `<div style="font-size:12px;color:var(--text-2);margin-bottom:2px;">\uD83D\uDCCD ${escapeHtml(e.location)}</div>` : ''}
        ${e.calendar_email ? `<div style="font-size:10px;color:var(--text-3);margin-top:6px;font-style:italic;">From: ${escapeHtml(e.calendar_email)} \u00B7 Google Calendar</div>` : ''}
      </div>
      <!-- Why detected -->
      <div style="background:rgba(240,165,0,.08);border:1px solid rgba(240,165,0,.2);border-radius:14px;padding:12px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;color:var(--warning);margin-bottom:6px;">Why this looks like a gig</div>
        <div style="font-size:11px;color:var(--text-2);line-height:1.5;">${e.reasons.join(' \u00B7 ')}</div>
      </div>
      <!-- Quick import form -->
      <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:12px;">
        <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:10px;">Quick details (optional - add more later)</div>
        <div style="margin-bottom:8px;">
          <label style="font-size:10px;color:var(--text-3);font-weight:600;display:block;margin-bottom:3px;">Fee</label>
          <input type="text" id="nudgeFee" placeholder="e.g. 350" style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;">
        </div>
        <div style="margin-bottom:8px;">
          <label style="font-size:10px;color:var(--text-3);font-weight:600;display:block;margin-bottom:3px;">Band / act name</label>
          <input type="text" id="nudgeBandName" placeholder="e.g. The Silverstone Band" style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;">
        </div>
        <div>
          <label style="font-size:10px;color:var(--text-3);font-weight:600;display:block;margin-bottom:3px;">Dress code</label>
          <input type="text" id="nudgeDressCode" placeholder="e.g. Black tie" style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;">
        </div>
      </div>
      <button onclick="importNudgeFromDetail(${index})" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:8px;">Import as gig \u2192</button>
      <button onclick="dismissNudge(${index});closePanel('panel-nudge-detail')" style="width:100%;background:var(--card);color:var(--text-2);border:1px solid var(--border);border-radius:12px;padding:12px;font-size:13px;font-weight:500;cursor:pointer;margin-bottom:8px;">Not a gig - keep as personal</button>
      <div style="text-align:center;font-size:10px;color:var(--text-3);margin-top:4px;">Changes sync back to Google Calendar</div>
    </div>
  `;

  openPanel('panel-nudge-detail');
}

async function quickImportNudge(index) {
  const e = _nudgeEvents[index];
  if (!e) return;

  try {
    await fetch('/api/calendar/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: e.id,
        title: e.title,
        location: e.location,
        start: e.start,
        end: e.end,
      }),
    });

    const card = document.getElementById(`nudge-card-${index}`);
    if (card) {
      card.style.borderColor = 'var(--success)';
      card.style.background = 'var(--success-dim)';
      card.querySelector('div:last-child').innerHTML = '<span style="font-size:12px;color:var(--success);font-weight:600;">\u2713 Imported - add details in Gigs</span>';
    }

    window._cachedGigs = null;
    _nudgeEvents[index].already_imported = true;
  } catch (err) {
    console.error('Quick import error:', err);
  }
}

async function importNudgeFromDetail(index) {
  const e = _nudgeEvents[index];
  if (!e) return;

  const fee = document.getElementById('nudgeFee')?.value;
  const bandName = document.getElementById('nudgeBandName')?.value;
  const dressCode = document.getElementById('nudgeDressCode')?.value;

  try {
    await fetch('/api/calendar/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: e.id,
        title: e.title,
        location: e.location,
        start: e.start,
        end: e.end,
        fee: fee || null,
        band_name: bandName || null,
        dress_code: dressCode || null,
      }),
    });

    window._cachedGigs = null;
    _nudgeEvents[index].already_imported = true;
    closePanel('panel-nudge-detail');
    showToast('Gig imported!');
    renderNudgeList();
  } catch (err) {
    console.error('Import from detail error:', err);
  }
}

async function dismissNudge(index) {
  const e = _nudgeEvents[index];
  if (!e) return;

  try {
    await fetch('/api/calendar/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: e.id }),
    });

    const card = document.getElementById(`nudge-card-${index}`);
    if (card) {
      card.style.opacity = '.4';
      card.style.pointerEvents = 'none';
      card.querySelector('div:last-child').innerHTML = '<span style="font-size:12px;color:var(--text-3);">Dismissed</span>';
    }
  } catch (err) {
    console.error('Dismiss error:', err);
  }
}

async function importAllNudges() {
  for (let i = 0; i < _nudgeEvents.length; i++) {
    if (!_nudgeEvents[i].already_imported) {
      await quickImportNudge(i);
    }
  }
}

// ── Chat / Messaging ────────────────────────────────────────────────────────

let _currentThreadId = null;

async function openChatInbox() {
  const body = document.getElementById('chatInboxBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-2);">Loading messages...</div>';
  openPanel('panel-chat-inbox');

  try {
    const resp = await fetch('/api/chat/threads');
    const data = await resp.json();
    const threads = data.threads || [];

    if (threads.length === 0) {
      body.innerHTML = `
        <div style="padding:40px;text-align:center;">
          <div style="font-size:32px;margin-bottom:8px;">💬</div>
          <div style="font-weight:600;color:var(--text);margin-bottom:4px;">No messages yet</div>
          <div style="font-size:13px;color:var(--text-2);">Messages will appear here when you message a band or dep</div>
        </div>
      `;
      return;
    }

    // Split into gig threads and dep threads
    const gigThreads = threads.filter(t => t.thread_type === 'gig');
    const depThreads = threads.filter(t => t.thread_type === 'dep');

    let html = '<div>';

    if (gigThreads.length > 0) {
      html += '<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;padding:12px 20px 6px;">Upcoming gigs</div>';
      html += gigThreads.map(t => renderThreadItem(t, 'gig')).join('');
    }

    if (depThreads.length > 0) {
      html += '<div style="font-size:11px;font-weight:600;color:#A78BFA;text-transform:uppercase;letter-spacing:1px;padding:12px 20px 6px;">Dep conversations</div>';
      html += depThreads.map(t => renderThreadItem(t, 'dep')).join('');
    }

    html += '</div>';
    body.innerHTML = html;
  } catch (err) {
    console.error('Chat inbox error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load messages.</div>';
  }
}

function renderThreadItem(thread, type) {
  const isUnread = parseInt(thread.unread_count) > 0;
  const otherParticipants = (thread.participants || []).filter(p => p.id !== currentUser?.id);
  const displayName = thread.band_name || otherParticipants.map(p => p.name || p.email).join(', ') || 'Unknown';
  const initial = displayName.charAt(0).toUpperCase();
  const subtitle = thread.venue_name ? `${thread.venue_name}` : '';
  const preview = thread.last_message ? (thread.last_message.length > 40 ? thread.last_message.substring(0, 40) + '...' : thread.last_message) : 'No messages yet';
  const timeAgo = thread.last_message_at ? formatTimeAgo(new Date(thread.last_message_at)) : '';

  const bgTint = isUnread
    ? (type === 'dep' ? 'rgba(167,139,250,.04)' : 'rgba(240,165,0,.04)')
    : 'transparent';

  const avatarBg = type === 'dep' ? 'rgba(167,139,250,.15)' : 'var(--info-dim)';

  return `
    <div onclick="openChatThread('${thread.id}')" style="padding:14px 20px;display:flex;align-items:center;gap:12px;cursor:pointer;border-bottom:1px solid var(--border);background:${bgTint};">
      <div style="position:relative;flex-shrink:0;">
        <div style="width:42px;height:42px;border-radius:21px;background:${avatarBg};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--text);">${initial}</div>
        ${isUnread ? '<div style="position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:5px;background:var(--accent);border:2px solid var(--bg);"></div>' : ''}
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <div style="font-size:14px;font-weight:${isUnread ? '700' : '500'};color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
          <div style="font-size:10px;color:var(--text-3);flex-shrink:0;margin-left:8px;">${timeAgo}</div>
        </div>
        ${subtitle ? `<div style="font-size:11px;color:var(--text-3);">${escapeHtml(subtitle)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</div>
      </div>
    </div>
  `;
}

function formatTimeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd';
  const weeks = Math.floor(days / 7);
  return weeks + 'w';
}

async function openChatThread(threadId) {
  _currentThreadId = threadId;
  const body = document.getElementById('chatThreadBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>';
  openPanel('panel-chat-thread');

  try {
    const resp = await fetch(`/api/chat/threads/${threadId}/messages`);
    const data = await resp.json();

    renderChatThread(data.thread, data.messages);
  } catch (err) {
    console.error('Chat thread error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load messages.</div>';
  }
}

async function openGigChat(gigId) {
  const body = document.getElementById('chatThreadBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>';
  openPanel('panel-chat-thread');

  try {
    const resp = await fetch(`/api/chat/gig/${gigId}`);
    const data = await resp.json();

    _currentThreadId = data.thread.id;
    renderChatThread(data.thread, data.messages, data.participants);
  } catch (err) {
    console.error('Gig chat error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load messages.</div>';
  }
}

function renderChatThread(thread, messages, participants) {
  const body = document.getElementById('chatThreadBody');
  if (!body) return;

  const userInitial = (currentUser?.name || currentUser?.email || 'G')[0].toUpperCase();
  const participantCount = (thread.participant_ids || []).length;

  // Update header
  const header = document.getElementById('chatThreadHeader');
  if (header) {
    header.innerHTML = `
      <button class="panel-back" onclick="closePanel('panel-chat-thread')">&#8249; Back</button>
      <div style="text-align:center;flex:1;">
        <div class="panel-title" style="font-size:15px;">${escapeHtml(thread.band_name || 'Messages')}</div>
        <div style="font-size:10px;color:var(--text-3);">${participantCount} ${participantCount === 1 ? 'person' : 'people'}</div>
      </div>
      <div style="font-size:11px;color:var(--accent);cursor:pointer;width:50px;text-align:right;">Gig info</div>
    `;
  }

  // Messages area
  let messagesHTML = '<div style="flex:1;overflow-y:auto;padding:16px 20px;" id="chatMessagesArea">';

  if (messages.length === 0) {
    messagesHTML += `
      <div style="text-align:center;padding:20px;">
        <div style="font-size:11px;color:var(--text-3);background:var(--card);border-radius:12px;padding:6px 12px;display:inline-block;">Start the conversation</div>
      </div>
    `;
  }

  for (const msg of messages) {
    const isMe = msg.sender_id === currentUser?.id;
    const senderInitial = (msg.sender_name || '?')[0].toUpperCase();
    const time = new Date(msg.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const allRead = (msg.read_by || []).length >= participantCount;

    if (isMe) {
      messagesHTML += `
        <div style="display:flex;flex-direction:row-reverse;gap:8px;margin-bottom:12px;">
          <div style="width:30px;height:30px;border-radius:15px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--accent);flex-shrink:0;">${userInitial}</div>
          <div style="max-width:85%;">
            <div style="background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);border-radius:14px 0 14px 14px;padding:10px 14px;">
              <div style="font-size:14px;color:var(--text);line-height:1.5;">${escapeHtml(msg.content)}</div>
            </div>
            <div style="font-size:10px;color:var(--text-3);margin-top:2px;text-align:right;">${allRead ? '<span style="color:var(--success);">\u2713\u2713</span> ' : '\u2713 '}${time}</div>
          </div>
        </div>
      `;
    } else {
      messagesHTML += `
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <div style="width:30px;height:30px;border-radius:15px;background:var(--info-dim);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--info);flex-shrink:0;">${senderInitial}</div>
          <div style="max-width:85%;">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:2px;">${escapeHtml(msg.sender_name || 'Unknown')} \u00B7 ${time}</div>
            <div style="background:var(--card);border:1px solid var(--border);border-radius:0 14px 14px 14px;padding:10px 14px;">
              <div style="font-size:14px;color:var(--text);line-height:1.5;">${escapeHtml(msg.content)}</div>
            </div>
          </div>
        </div>
      `;
    }
  }

  messagesHTML += '</div>';

  // Input bar
  const inputHTML = `
    <div style="padding:12px 20px;border-top:1px solid var(--border);background:var(--surface);display:flex;gap:8px;align-items:center;">
      <input type="text" id="chatMessageInput" placeholder="Message..." style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:24px;padding:10px 16px;color:var(--text);font-size:14px;outline:none;" onkeydown="if(event.key==='Enter')sendChatMessage()">
      <button onclick="sendChatMessage()" style="width:36px;height:36px;border-radius:18px;background:var(--accent);border:none;color:#000;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">&#x2191;</button>
    </div>
  `;

  body.innerHTML = messagesHTML + inputHTML;

  // Scroll to bottom
  const area = document.getElementById('chatMessagesArea');
  if (area) area.scrollTop = area.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chatMessageInput');
  if (!input || !input.value.trim() || !_currentThreadId) return;

  const content = input.value.trim();
  input.value = '';

  try {
    await fetch(`/api/chat/threads/${_currentThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    // Refresh thread
    openChatThread(_currentThreadId);
  } catch (err) {
    console.error('Send message error:', err);
    input.value = content; // Restore on error
  }
}

// ── Invoice Panel ─────────────────────────────────────────────────────────────

function initInvoicePanel() {
  // Live preview updates
  const fields = ['invBillTo', 'invDesc', 'invAmount'];
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateInvoicePreview);
  });
  updateInvoicePreview();

  document.getElementById('sendInvoiceBtn').onclick = submitInvoice;
  document.getElementById('saveInvoiceDraft').onclick = () => saveInvoiceDraft();
}

function updateInvoicePreview() {
  const to = document.getElementById('invBillTo').value || '—';
  const desc = document.getElementById('invDesc').value || 'Performance fee';
  const amt = parseFloat(document.getElementById('invAmount').value) || 0;
  const fmt = '£' + amt.toFixed(2);

  document.getElementById('invPreviewTo').textContent = to;
  document.getElementById('invPreviewDesc').textContent = desc;
  document.getElementById('invPreviewAmt').textContent = fmt;
  document.getElementById('invPreviewTotal').textContent = fmt;

  const currentUser = window._currentUser;
  if (currentUser) {
    document.getElementById('invPreviewFrom').textContent =
      currentUser.name || currentUser.email;
  }
}

async function submitInvoice() {
  const billTo = document.getElementById('invBillTo').value.trim();
  const amount = parseFloat(document.getElementById('invAmount').value);
  if (!billTo) { showToast('Enter a client name'); return; }
  if (!amount || amount <= 0) { showToast('Enter an amount'); return; }

  try {
    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: billTo,
        gig_reference: document.getElementById('invLinkedGig').value,
        description: document.getElementById('invDesc').value,
        amount,
        due_date: document.getElementById('invDueDate').value || null,
        notes: document.getElementById('invNotes').value,
        status: 'sent',
      }),
    });
    if (res.ok) {
      closePanel('panel-invoice');
      showToast('Invoice sent!');
    } else {
      const d = await res.json();
      showToast(d.error || 'Failed to send invoice');
    }
  } catch {
    showToast('Failed to send invoice');
  }
}

function saveInvoiceDraft() {
  showToast('Draft saved');
  closePanel('panel-invoice');
}

// ── Block Dates Panel ─────────────────────────────────────────────────────────

function setBlockMode(mode) {
  ['single', 'range', 'recurring'].forEach((m) => {
    document.getElementById('block-' + m).style.display = m === mode ? '' : 'none';
    document.getElementById('bm-' + m).classList.toggle('active', m === mode);
  });
}
window.setBlockMode = setBlockMode;

function toggleDayBtn(btn) {
  btn.classList.toggle('active');
}
window.toggleDayBtn = toggleDayBtn;

async function submitBlockDate(mode) {
  let payload = { mode };
  if (mode === 'single') {
    const date = document.getElementById('blockSingleDate').value;
    if (!date) { showToast('Pick a date'); return; }
    payload.date = date;
    payload.reason = document.getElementById('blockSingleReason').value;
  } else if (mode === 'range') {
    const from = document.getElementById('blockRangeFrom').value;
    const to = document.getElementById('blockRangeTo').value;
    if (!from || !to) { showToast('Pick a date range'); return; }
    payload.from = from;
    payload.to = to;
    payload.reason = document.getElementById('blockRangeReason').value;
  } else if (mode === 'recurring') {
    const days = Array.from(document.querySelectorAll('.day-btn.active')).map(b => b.textContent);
    if (!days.length) { showToast('Select at least one day'); return; }
    payload.days = days;
  }

  try {
    const res = await fetch('/api/blocked-dates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      closePanel('panel-block');
      showToast('Date blocked');
    } else {
      showToast('Failed to block date');
    }
  } catch {
    showToast('Failed to block date');
  }
}
window.submitBlockDate = submitBlockDate;

// ── Send Dep Panel ────────────────────────────────────────────────────────────

async function initDepPanel() {
  // Populate gig selector from cached or fresh gigs
  const gigs = window._cachedGigs || [];
  const sel = document.getElementById('depGigSelect');
  sel.innerHTML = '<option value="">Select a gig...</option>';
  gigs.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `${g.band_name} · ${formatDate(g.date)}`;
    sel.appendChild(opt);
  });

  document.getElementById('sendDepBtn').onclick = submitDepOffer;
}

function setDepMode(mode) {
  document.getElementById('dep-mode-pick').classList.toggle('active', mode === 'pick');
  document.getElementById('dep-mode-all').classList.toggle('active', mode === 'all');
  document.getElementById('dep-pick-section').style.display = mode === 'pick' ? '' : 'none';
}
window.setDepMode = setDepMode;

async function submitDepOffer() {
  const gigId = document.getElementById('depGigSelect').value;
  const role = document.getElementById('depRole').value.trim();
  const message = document.getElementById('depMessage').value;
  const mode = document.getElementById('dep-mode-pick').classList.contains('active') ? 'pick' : 'all';

  if (!gigId) { showToast('Select a gig'); return; }
  if (!role) { showToast('Enter the role needed'); return; }

  try {
    const res = await fetch('/api/dep-offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gig_id: gigId, role, message, mode }),
    });
    if (res.ok) {
      closePanel('panel-dep');
      showToast('Dep offer sent!');
    } else {
      showToast('Failed to send dep offer');
    }
  } catch {
    showToast('Failed to send dep offer');
  }
}

// ── Receipts Panel ────────────────────────────────────────────────────────────

async function initReceiptPanel() {
  document.getElementById('receiptDate').valueAsDate = new Date();
  await loadReceipts();
}

function showReceiptForm(type) {
  document.getElementById('receiptManualForm').style.display = 'block';
}
window.showReceiptForm = showReceiptForm;

async function loadReceipts() {
  try {
    const res = await fetch('/api/expenses');
    if (!res.ok) return;
    const data = await res.json();
    const expenses = data.expenses || [];
    const total = expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);

    document.getElementById('receiptTotalExpenses').textContent = '£' + total.toFixed(0);
    document.getElementById('receiptClaimable').textContent = '£' + total.toFixed(0);
    document.getElementById('receiptCount').textContent = expenses.length + ' receipt' + (expenses.length !== 1 ? 's' : '');

    const list = document.getElementById('receiptList');
    list.innerHTML = expenses.length ? expenses.map((e) => `
      <div class="receipt-item">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--text)">${escapeHtml(e.description || 'Expense')}</div>
          <div style="font-size:12px;color:var(--text-2)">${escapeHtml(e.category || '')} · ${formatDate(e.date)}</div>
        </div>
        <div style="font-size:15px;font-weight:700;color:var(--text)">£${parseFloat(e.amount).toFixed(2)}</div>
      </div>`).join('') : '<div style="text-align:center;color:var(--text-2);padding:20px;font-size:14px">No expenses yet</div>';
  } catch {
    // silently ignore
  }
}

async function submitReceipt() {
  const amount = parseFloat(document.getElementById('receiptAmount').value);
  const desc = document.getElementById('receiptDesc').value.trim();
  const date = document.getElementById('receiptDate').value;
  const category = document.getElementById('receiptCategory').value;

  if (!amount || amount <= 0) { showToast('Enter an amount'); return; }
  if (!desc) { showToast('Enter a description'); return; }

  try {
    const res = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, description: desc, date, category }),
    });
    if (res.ok) {
      document.getElementById('receiptAmount').value = '';
      document.getElementById('receiptDesc').value = '';
      document.getElementById('receiptManualForm').style.display = 'none';
      await loadReceipts();
      showToast('Expense saved!');
    } else {
      showToast('Failed to save expense');
    }
  } catch {
    showToast('Failed to save expense');
  }
}
window.submitReceipt = submitReceipt;

function updateOfferStatus(offerId, status) {
  console.log(`Updated offer ${offerId} to ${status}`);
  showToast(status === 'accepted' ? 'Offer accepted!' : 'Offer declined');
}

// ── Utilities ────────────────────────────────────────────────────────────────

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatDate(dateString) {
  if (!dateString) return 'No date';
  const raw = String(dateString).substring(0, 10);
  const date = new Date(raw + 'T12:00:00');
  if (isNaN(date.getTime())) return 'Invalid date';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]}`;
}

function formatDateShort(dateString) {
  if (!dateString) return 'No date';
  const raw = String(dateString).substring(0, 10);
  const date = new Date(raw + 'T12:00:00');
  if (isNaN(date.getTime())) return 'Invalid date';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

function formatDateLong(dateString) {
  if (!dateString) return 'No date';
  const raw = String(dateString).substring(0, 10);
  const date = new Date(raw + 'T12:00:00');
  if (isNaN(date.getTime())) return 'Invalid date';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  // DB returns "HH:MM:SS", we want "HH:MM"
  return timeStr.substring(0, 5);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'");
}

// ── Nav reorder: long-press any nav button to enter wiggle/reorder mode ──────
(function setupNavReorder() {
  let longPressTimer = null;
  let reorderMode = false;
  let dragItem = null;

  function allNavItems() {
    return document.querySelectorAll('.nav-main .nav-item, .nav-quick-actions .nav-quick-btn');
  }

  // Attach long-press listeners
  allNavItems().forEach(function (item) {
    item.addEventListener('touchstart', function () {
      if (reorderMode) return;
      longPressTimer = setTimeout(function () { enterReorderMode(item); }, 600);
    }, { passive: true });
    item.addEventListener('touchend', function () { clearTimeout(longPressTimer); });
    item.addEventListener('touchmove', function () { clearTimeout(longPressTimer); });
    item.addEventListener('mousedown', function () {
      if (reorderMode) return;
      longPressTimer = setTimeout(function () { enterReorderMode(item); }, 600);
    });
    item.addEventListener('mouseup', function () { clearTimeout(longPressTimer); });
    item.addEventListener('mouseleave', function () { clearTimeout(longPressTimer); });
  });

  function enterReorderMode(item) {
    reorderMode = true;
    allNavItems().forEach(function (ni) {
      ni.style.animation = 'wiggle .3s ease-in-out infinite alternate';
      ni.style.opacity = '.85';
      ni.setAttribute('draggable', 'true');
      ni.addEventListener('dragstart', onDragStart);
      ni.addEventListener('dragover', onDragOver);
      ni.addEventListener('drop', onDrop);
      ni.addEventListener('dragend', onDragEnd);
    });
    item.style.opacity = '1';
    item.style.transform = 'scale(1.15)';
    dragItem = item;

    // Show Done button
    const nav = document.querySelector('.app-nav');
    const exitBtn = document.createElement('div');
    exitBtn.id = 'reorder-exit';
    exitBtn.textContent = '\u2713 Done reordering';
    exitBtn.style.cssText = 'position:absolute;top:-30px;left:50%;transform:translateX(-50%);background:var(--accent);color:#000;font-size:11px;font-weight:700;padding:5px 16px;border-radius:12px;cursor:pointer;z-index:20;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    exitBtn.onclick = exitReorderMode;
    nav.style.position = 'relative';
    nav.appendChild(exitBtn);
  }

  function exitReorderMode() {
    reorderMode = false;
    allNavItems().forEach(function (ni) {
      ni.style.animation = '';
      ni.style.opacity = '';
      ni.style.transform = '';
      ni.removeAttribute('draggable');
      ni.removeEventListener('dragstart', onDragStart);
      ni.removeEventListener('dragover', onDragOver);
      ni.removeEventListener('drop', onDrop);
      ni.removeEventListener('dragend', onDragEnd);
    });
    const exit = document.getElementById('reorder-exit');
    if (exit) exit.remove();
    dragItem = null;
  }

  function onDragStart(e) {
    dragItem = this;
    this.style.opacity = '.4';
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.style.transform = 'scale(1.1)';
  }

  function onDrop(e) {
    e.preventDefault();
    // Swap only within the same row
    if (dragItem !== this && dragItem.parentElement === this.parentElement) {
      const parent = this.parentElement;
      const items = Array.from(parent.children);
      const fromIdx = items.indexOf(dragItem);
      const toIdx = items.indexOf(this);
      if (fromIdx < toIdx) {
        parent.insertBefore(dragItem, this.nextSibling);
      } else {
        parent.insertBefore(dragItem, this);
      }
    }
    this.style.transform = '';
  }

  function onDragEnd() {
    allNavItems().forEach(function (ni) {
      ni.style.opacity = '.85';
      ni.style.transform = '';
    });
    if (dragItem) dragItem.style.opacity = '.85';
  }
})();

if ('serviceWorker' in navigator) {
  // Force-update: unregister any old service workers, then re-register
  // This guarantees the new network-first SW replaces any stale cache-first one
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    const reRegister = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.log('ServiceWorker registration failed:', err);
      });
    };
    if (registrations.length > 0) {
      Promise.all(registrations.map((r) => r.unregister())).then(reRegister);
    } else {
      reRegister();
    }
  });
}
