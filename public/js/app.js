let currentUser = null;
let currentScreen = 'home';

// Fix iOS Safari viewport height: Safari's toolbar overlaps position:fixed elements
// when viewport-fit=cover. Use visualViewport API to get actual visible height.
function setAppHeight() {
  var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', vh + 'px');
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
  window.visualViewport.addEventListener('scroll', setAppHeight);
}

// Run text scaling immediately so all screens (including auth) scale correctly
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { if (typeof setupTextScaling === 'function') setupTextScaling(); });
} else {
  // DOM already ready (e.g. script loaded at end of body)
  setTimeout(() => { if (typeof setupTextScaling === 'function') setupTextScaling(); }, 0);
}

// Wizard state
let gigWizardStep = 1;
let gigWizardData = {};
window._cachedGigs = null;
window._cachedStats = null;
window._cachedStatsTime = 0;
window._cachedContacts = [];
window._contactFilterType = 'all';
window._cachedProfile = null;
window._cachedProfileTime = 0;
window._cachedInvoices = null;
window._cachedInvoicesTime = 0;
window._cachedOffers = null;
window._cachedOffersTime = 0;
window._calViewMode = 'month';
window._calDate = new Date();

// Cache TTL in ms
const STATS_CACHE_TTL = 30000;
const PROFILE_CACHE_TTL = 60000;
const DATA_CACHE_TTL = 30000;

function initApp(user) {
  currentUser = user;
  window._currentUser = user;
  setupTextScaling();
  setupThemeToggle();
  setupNavigation();
  setupScreenHandlers();

  // Update the fixed header with user info
  updateAppHeader();

  // Show home immediately (uses skeleton while data loads)
  showScreen('home');

  // Prefetch ALL screen data in parallel so every tab opens instantly
  window._prefetchPromise = prefetchAllData();
}

async function prefetchAllData() {
  // Fire all fetches at once - don't await sequentially
  const [statsRes, gigsRes, invoicesRes, offersRes, profileRes, blockedRes] = await Promise.allSettled([
    fetch('/api/stats'),
    fetch('/api/gigs'),
    fetch('/api/invoices'),
    fetch('/api/offers'),
    fetch('/api/user/profile'),
    fetch('/api/blocked-dates'),
  ]);

  const now = Date.now();

  if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
    window._cachedStats = await statsRes.value.json();
    window._cachedStatsTime = now;
    // Re-render home if it's showing, now with real data
    if (currentScreen === 'home') {
      const content = document.getElementById('homeScreen');
      buildHomeHTML(content, window._cachedStats);
    }
  }

  if (gigsRes.status === 'fulfilled' && gigsRes.value.ok) {
    window._cachedGigs = await gigsRes.value.json();
  }

  if (invoicesRes.status === 'fulfilled' && invoicesRes.value.ok) {
    window._cachedInvoices = await invoicesRes.value.json();
    window._cachedInvoicesTime = now;
  }

  if (offersRes.status === 'fulfilled' && offersRes.value.ok) {
    window._cachedOffers = await offersRes.value.json();
    window._cachedOffersTime = now;
  }
  // Keep the nav Offers badge consistent with the Offers screen:
  // derive it from the actual pending offers list rather than a
  // separately-counted server stat that can drift.
  const pendingOffersCount = (window._cachedOffers || []).filter(o => o.status === 'pending').length;
  updateOffersBadge(pendingOffersCount);

  if (profileRes.status === 'fulfilled' && profileRes.value.ok) {
    window._cachedProfile = await profileRes.value.json();
    window._cachedProfileTime = now;
    // Sync colour theme from profile (server wins over localStorage)
    if (window._cachedProfile.colour_theme) {
      localStorage.setItem('colourTheme', window._cachedProfile.colour_theme);
      applyColourTheme(window._cachedProfile.colour_theme);
    }
  }

  if (blockedRes.status === 'fulfilled' && blockedRes.value.ok) {
    window._cachedBlocked = await blockedRes.value.json();
    window._cachedBlockedTime = now;
  }

  // Show onboarding tour on very first load (profile has no onboarded_at yet).
  // Delay by a tick so the home screen paints first, then the tour appears over it.
  setTimeout(() => {
    if (typeof maybeStartOnboarding === 'function') maybeStartOnboarding();
  }, 400);
}

// Update the bottom nav Offers tab badge based on pending offer count.
// Hides the badge entirely when there are zero pending offers, shows "9+" when above 9.
function updateOffersBadge(count) {
  const badge = document.getElementById('offersBadge');
  if (!badge) return;
  const n = parseInt(count || 0, 10);
  if (!n || isNaN(n) || n <= 0) {
    badge.style.display = 'none';
    badge.textContent = '';
    return;
  }
  badge.style.display = '';
  badge.textContent = n > 9 ? '9+' : String(n);
}

function updateAppHeader() {
  // Prefer display_name (the user's real name) over name (which may be an act/band name)
  const name = window._currentUser?.display_name || window._currentUser?.name || 'Guest';
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

// prefetchGigs replaced by prefetchAllData above

function buildSkeletonHTML() {
  const pulse = 'background:var(--card);border-radius:var(--rs);animation:pulse 1.5s ease-in-out infinite;';
  return `
    <style>@keyframes pulse{0%,100%{opacity:.4}50%{opacity:.8}}</style>
    <div style="margin:8px 16px;${pulse}height:90px;border-radius:var(--r);"></div>
    <div style="display:flex;gap:6px;margin:8px 16px;">
      <div style="flex:1;${pulse}height:64px;"></div>
      <div style="flex:1;${pulse}height:64px;"></div>
    </div>
    <div style="display:flex;gap:6px;margin:8px 16px;">
      <div style="flex:1;${pulse}height:60px;"></div>
      <div style="flex:1;${pulse}height:60px;"></div>
    </div>`;
}

function setupTextScaling() {
  // Detect the user's preferred text size (iOS Dynamic Type / Android font scale).
  // Uses -apple-system-body font which respects Dynamic Type on iOS Safari.
  try {
    var probe = document.createElement('p');
    probe.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    probe.setAttribute('style', 'font: -apple-system-body !important; position: absolute !important; left: -9999px !important; top: -9999px !important; visibility: hidden !important; pointer-events: none !important;');
    document.body.appendChild(probe);
    var preferredSize = parseFloat(window.getComputedStyle(probe).fontSize);
    document.body.removeChild(probe);
    if (preferredSize && preferredSize > 0 && Math.abs(preferredSize - 16) > 0.5) {
      // Clamp between 0.8x and 1.4x to prevent layout breakage
      var scale = Math.min(1.4, Math.max(0.8, preferredSize / 16));
      document.documentElement.style.setProperty('--text-scale', scale.toFixed(3));
    }
  } catch (e) { /* silent - will use default 1x */ }
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

  // Apply saved colour theme
  const savedColour = localStorage.getItem('colourTheme') || 'amber';
  applyColourTheme(savedColour);

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

  // Show skeleton loading state - looks like real content, feels fast
  content.innerHTML = buildSkeletonHTML();

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
let gigWeekOffset = 0;  // 0 = current week, +1 = next week, -1 = prev week
let gigMonthOffset = 0; // 0 = current month
let gigYearOffset = 0;  // 0 = current tax year

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
  gigWeekOffset = 0;
  gigMonthOffset = 0;
  gigYearOffset = 0;
  document.querySelectorAll('.gig-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  if (window._cachedGigs) renderGigsList(window._cachedGigs);
}

function navigateGigView(direction) {
  if (gigViewMode === 'week') gigWeekOffset += direction;
  else if (gigViewMode === 'month') gigMonthOffset += direction;
  else if (gigViewMode === 'year') gigYearOffset += direction;
  if (window._cachedGigs) renderGigsList(window._cachedGigs);
}

function filterGigsList() {
  if (window._cachedGigs) renderGigsList(window._cachedGigs);
}

// Parse a gig date safely - handles both "YYYY-MM-DD" and full ISO "YYYY-MM-DDTHH:mm:ss.sssZ"
function parseGigDate(dateStr) {
  if (!dateStr) return null;
  const iso = dateStr.substring(0, 10); // always grab YYYY-MM-DD
  return new Date(iso + 'T12:00:00');
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

  const now = new Date();
  let headerHtml = '';
  let viewFiltered = filtered;

  if (gigViewMode === 'week') {
    // Calculate week range with offset
    // getDay(): 0=Sun..6=Sat. We want Monday as week start.
    // On Sunday, naive "date - getDay() + 1" rolls FORWARD a day; instead subtract ((getDay()+6)%7).
    const weekStart = new Date(now);
    const dowMonday = (weekStart.getDay() + 6) % 7; // 0=Mon, 6=Sun
    weekStart.setDate(weekStart.getDate() - dowMonday + (gigWeekOffset * 7));
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekGigs = filtered.filter(g => {
      const d = parseGigDate(g.date);
      return d >= weekStart && d <= weekEnd;
    });
    viewFiltered = weekGigs;

    // Week summary stats
    const weekTotal = weekGigs.reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);
    const startDay = weekStart.getDate();
    const endDay = weekEnd.getDate();
    const monthLabel = weekStart.toLocaleDateString('en-GB', { month: 'long' });
    const endMonthLabel = weekEnd.toLocaleDateString('en-GB', { month: 'long' });
    const rangeLabel = monthLabel === endMonthLabel
      ? `${startDay} - ${endDay} ${monthLabel}`
      : `${startDay} ${monthLabel} - ${endDay} ${endMonthLabel}`;

    const isThisWeek = gigWeekOffset === 0;
    const weekLabel = isThisWeek ? 'This week' : (gigWeekOffset === 1 ? 'Next week' : (gigWeekOffset === -1 ? 'Last week' : `${Math.abs(gigWeekOffset)} weeks ${gigWeekOffset > 0 ? 'ahead' : 'ago'}`));

    // Build day strip
    const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    let dayStripHtml = '';
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + i);
      const dayNum = dayDate.getDate();
      const isToday = dayDate.toDateString() === now.toDateString();
      const hasGig = weekGigs.some(g => {
        const d = parseGigDate(g.date);
        return d.toDateString() === dayDate.toDateString();
      });

      if (isToday) {
        dayStripHtml += `<div style="flex:1;text-align:center;padding:6px 0;border-radius:8px;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);">
          <div style="font-size:10px;color:var(--accent);">${dayNames[i]}</div>
          <div style="font-size:14px;font-weight:700;color:var(--accent);">${dayNum}</div>
          ${hasGig ? '<div style="width:4px;height:4px;border-radius:2px;background:var(--accent);margin:3px auto 0;"></div>' : ''}
        </div>`;
      } else if (hasGig) {
        dayStripHtml += `<div style="flex:1;text-align:center;padding:6px 0;border-radius:8px;">
          <div style="font-size:10px;color:var(--text-3);">${dayNames[i]}</div>
          <div style="font-size:14px;font-weight:600;color:var(--success);">${dayNum}</div>
          <div style="width:4px;height:4px;border-radius:2px;background:var(--success);margin:3px auto 0;"></div>
        </div>`;
      } else {
        dayStripHtml += `<div style="flex:1;text-align:center;padding:6px 0;border-radius:8px;">
          <div style="font-size:10px;color:var(--text-3);">${dayNames[i]}</div>
          <div style="font-size:14px;color:var(--text-2);">${dayNum}</div>
        </div>`;
      }
    }

    headerHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-top:8px;">
        <button onclick="navigateGigView(-1)" style="width:28px;height:28px;border-radius:14px;background:var(--card);border:1px solid var(--border);color:var(--text-2);font-size:14px;cursor:pointer;">&lsaquo;</button>
        <div style="text-align:center;">
          <div style="font-size:15px;font-weight:700;color:var(--text);">${rangeLabel}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px;">${weekLabel} &middot; ${weekGigs.length} gig${weekGigs.length !== 1 ? 's' : ''}${weekTotal > 0 ? ' &middot; &pound;' + weekTotal.toFixed(0) : ''}</div>
        </div>
        <button onclick="navigateGigView(1)" style="width:28px;height:28px;border-radius:14px;background:var(--card);border:1px solid var(--border);color:var(--text-2);font-size:14px;cursor:pointer;">&rsaquo;</button>
      </div>
      <div style="display:flex;gap:2px;margin-bottom:12px;">${dayStripHtml}</div>
    `;

  } else if (gigViewMode === 'month') {
    const targetDate = new Date(now.getFullYear(), now.getMonth() + gigMonthOffset, 1);
    const monthStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
    const monthEnd = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0, 23, 59, 59);
    const monthName = targetDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const monthGigs = filtered.filter(g => {
      const d = parseGigDate(g.date);
      return d >= monthStart && d <= monthEnd;
    });
    viewFiltered = monthGigs;

    const monthTotal = monthGigs.reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);
    const unpaidTotal = monthGigs.filter(g => g.status !== 'paid' && g.invoice_status !== 'paid').reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);

    // Build mini calendar grid (Monday-first; 0..6 where 0=Mon, 6=Sun)
    const firstDayOfMonth = (monthStart.getDay() + 6) % 7;
    const daysInMonth = monthEnd.getDate();
    const gigDateSet = {};
    monthGigs.forEach(g => {
      const d = parseGigDate(g.date);
      const day = d.getDate();
      if (!gigDateSet[day]) gigDateSet[day] = [];
      gigDateSet[day].push(g);
    });

    let calGridHtml = '<div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:2px;">';
    // Day headers
    ['Mo','Tu','We','Th','Fr','Sa','Su'].forEach(d => {
      calGridHtml += `<div style="font-size:9px;color:var(--text-3);padding:4px;">${d}</div>`;
    });
    // Empty cells before first day
    for (let i = 0; i < firstDayOfMonth; i++) {
      calGridHtml += '<div style="padding:4px;"></div>';
    }
    // Day cells
    for (let day = 1; day <= daysInMonth; day++) {
      const isToday = day === now.getDate() && targetDate.getMonth() === now.getMonth() && targetDate.getFullYear() === now.getFullYear();
      const dayGigs = gigDateSet[day];
      if (dayGigs) {
        // Determine color based on payment status
        const allPaid = dayGigs.every(g => g.status === 'paid' || g.invoice_status === 'paid');
        const isUpcoming = dayGigs.some(g => parseGigDate(g.date) >= now);
        let bgColor, textColor;
        if (allPaid) {
          bgColor = 'var(--success-dim)'; textColor = 'var(--success)';
        } else if (isUpcoming) {
          bgColor = 'var(--accent-dim)'; textColor = 'var(--accent)';
        } else {
          bgColor = 'var(--warning-dim)'; textColor = 'var(--warning)';
        }
        calGridHtml += `<div style="padding:4px;font-size:11px;border-radius:6px;background:${bgColor};color:${textColor};font-weight:700;cursor:pointer;">${day}</div>`;
      } else if (isToday) {
        calGridHtml += `<div style="padding:4px;font-size:11px;border-radius:6px;border:1px solid var(--accent);color:var(--accent);font-weight:600;">${day}</div>`;
      } else {
        calGridHtml += `<div style="padding:4px;font-size:11px;color:var(--text-2);">${day}</div>`;
      }
    }
    calGridHtml += '</div>';
    // Legend
    calGridHtml += `<div style="display:flex;gap:10px;justify-content:center;margin-top:8px;padding-top:6px;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:4px;"><div style="width:6px;height:6px;border-radius:3px;background:var(--success);"></div><span style="font-size:9px;color:var(--text-3);">Paid</span></div>
      <div style="display:flex;align-items:center;gap:4px;"><div style="width:6px;height:6px;border-radius:3px;background:var(--warning);"></div><span style="font-size:9px;color:var(--text-3);">Unpaid</span></div>
      <div style="display:flex;align-items:center;gap:4px;"><div style="width:6px;height:6px;border-radius:3px;background:var(--accent);"></div><span style="font-size:9px;color:var(--text-3);">Upcoming</span></div>
    </div>`;

    headerHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-top:8px;">
        <button onclick="navigateGigView(-1)" style="width:28px;height:28px;border-radius:14px;background:var(--card);border:1px solid var(--border);color:var(--text-2);font-size:14px;cursor:pointer;">&lsaquo;</button>
        <div style="text-align:center;">
          <div style="font-size:15px;font-weight:700;color:var(--text);">${monthName}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px;">${monthGigs.length} gig${monthGigs.length !== 1 ? 's' : ''} &middot; <span style="color:var(--accent);font-weight:600;">&pound;${monthTotal.toFixed(0)}</span>${unpaidTotal > 0 ? ' &middot; <span style="color:var(--warning);">&pound;' + unpaidTotal.toFixed(0) + ' unpaid</span>' : ''}</div>
        </div>
        <button onclick="navigateGigView(1)" style="width:28px;height:28px;border-radius:14px;background:var(--card);border:1px solid var(--border);color:var(--text-2);font-size:14px;cursor:pointer;">&rsaquo;</button>
      </div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:10px;margin-bottom:12px;">
        ${calGridHtml}
      </div>
    `;

  } else if (gigViewMode === 'year') {
    // Tax year runs April to March
    const currentTaxYearStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const taxYearStart = currentTaxYearStart + gigYearOffset;
    const taxYearEnd = taxYearStart + 1;
    const startDate = new Date(taxYearStart, 3, 1); // 1 April
    const endDate = new Date(taxYearEnd, 2, 31, 23, 59, 59); // 31 March

    const yearGigs = filtered.filter(g => {
      const d = parseGigDate(g.date);
      return d >= startDate && d <= endDate;
    });
    viewFiltered = yearGigs;

    const yearTotal = yearGigs.reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);
    const paidTotal = yearGigs.filter(g => g.status === 'paid' || g.invoice_status === 'paid').reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);
    const dueTotal = yearTotal - paidTotal;

    // Monthly bar chart data (Apr-Mar)
    const monthNames = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
    const monthTotals = new Array(12).fill(0);
    yearGigs.forEach(g => {
      const d = parseGigDate(g.date);
      const m = d.getMonth(); // 0-11
      // Map to tax year index: Apr(3)=0, May(4)=1, ... Mar(2)=11
      const idx = m >= 3 ? m - 3 : m + 9;
      monthTotals[idx] += (parseFloat(g.fee) || 0);
    });
    const maxMonthTotal = Math.max(...monthTotals, 1);

    let barChartHtml = '<div style="display:flex;align-items:flex-end;gap:4px;height:60px;margin-bottom:6px;">';
    monthTotals.forEach((total, i) => {
      const height = Math.max(4, Math.round((total / maxMonthTotal) * 60));
      const isFuture = (() => {
        const barMonth = i < 9 ? i + 3 : i - 9;
        const barYear = i < 9 ? taxYearStart : taxYearEnd;
        return new Date(barYear, barMonth, 1) > now;
      })();
      const color = isFuture ? 'var(--accent);opacity:.3' : 'var(--accent)';
      barChartHtml += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;">
        <div style="width:100%;background:${color};border-radius:3px 3px 0 0;height:${height}px;"></div>
      </div>`;
    });
    barChartHtml += '</div>';
    barChartHtml += '<div style="display:flex;gap:4px;">';
    monthNames.forEach(m => {
      barChartHtml += `<div style="flex:1;text-align:center;font-size:8px;color:var(--text-3);">${m}</div>`;
    });
    barChartHtml += '</div>';

    // Paid/due progress bar
    const paidPct = yearTotal > 0 ? Math.round((paidTotal / yearTotal) * 100) : 0;
    const paidBarHtml = yearTotal > 0 ? `
      <div style="display:flex;gap:1px;border-radius:8px;overflow:hidden;margin-bottom:12px;">
        <div style="background:var(--success-dim);color:var(--success);flex:${paidPct || 1};padding:6px;font-size:11px;font-weight:600;text-align:center;">&pound;${paidTotal.toFixed(0)} paid</div>
        ${dueTotal > 0 ? `<div style="background:var(--warning-dim);color:var(--warning);flex:${100 - paidPct || 1};padding:6px;font-size:11px;font-weight:600;text-align:center;">&pound;${dueTotal.toFixed(0)} due</div>` : ''}
      </div>` : '';

    headerHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-top:8px;">
        <button onclick="navigateGigView(-1)" style="width:28px;height:28px;border-radius:14px;background:var(--card);border:1px solid var(--border);color:var(--text-2);font-size:14px;cursor:pointer;">&lsaquo;</button>
        <div style="text-align:center;">
          <div style="font-size:15px;font-weight:700;color:var(--text);">Tax Year ${taxYearStart}-${String(taxYearEnd).slice(2)}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px;">${yearGigs.length} gig${yearGigs.length !== 1 ? 's' : ''} &middot; <span style="color:var(--accent);font-weight:600;">&pound;${yearTotal.toFixed(0)}</span></div>
        </div>
        <button onclick="navigateGigView(1)" style="width:28px;height:28px;border-radius:14px;background:var(--card);border:1px solid var(--border);color:var(--text-2);font-size:14px;cursor:pointer;">&rsaquo;</button>
      </div>
      ${paidBarHtml}
      <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px;margin-bottom:12px;">
        ${barChartHtml}
      </div>
      <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">All gigs &middot; most recent first</div>
    `;
  }

  // Sort filtered gigs
  if (gigViewMode === 'year') {
    viewFiltered.sort((a, b) => (b.date || '').localeCompare(a.date || '')); // newest first for yearly
  } else {
    viewFiltered.sort((a, b) => (a.date || '').localeCompare(b.date || '')); // oldest first for week/month
  }

  // Render empty state
  if (viewFiltered.length === 0 && !searchQuery) {
    const emptyMsg = gigViewMode === 'week' ? 'No gigs this week' : (gigViewMode === 'month' ? 'No gigs this month' : 'No gigs this tax year');
    listContent.innerHTML = headerHtml + `
      <div style="text-align:center;padding:30px;">
        <div style="font-size:28px;margin-bottom:8px;">🎸</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">${emptyMsg}</div>
        <div style="font-size:13px;color:var(--text-2);">Tap + New to add a gig</div>
      </div>
    `;
    return;
  }

  if (viewFiltered.length === 0 && searchQuery) {
    listContent.innerHTML = headerHtml + `
      <div style="text-align:center;padding:30px;">
        <div style="font-size:28px;margin-bottom:8px;">🔍</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">No gigs matching "${escapeHtml(searchQuery)}"</div>
      </div>
    `;
    return;
  }

  // Separate regular gigs from depped-out gigs
  const regularGigs = viewFiltered.filter(g => g.status !== 'depped_out');
  const deppedGigs = viewFiltered.filter(g => g.status === 'depped_out');

  const gigCardsHtml = regularGigs.map(gig => renderGigCard(gig)).join('');
  const deppedHtml = deppedGigs.length > 0
    ? `<div style="font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:1px;margin:12px 0 6px;">Depped out</div>` + deppedGigs.map(gig => `<div style="opacity:.55;">${renderGigCard(gig)}</div>`).join('')
    : '';

  listContent.innerHTML = headerHtml + gigCardsHtml + deppedHtml;
}

function renderGigCard(gig) {
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

  // Payment badge for monthly/yearly views
  let payBadge = '';
  if (gigViewMode !== 'week') {
    if (gig.status === 'paid' || gig.invoice_status === 'paid') {
      payBadge = '<span class="badge badge-success" style="font-size:9px;">Paid</span>';
    } else if (gig.invoice_status === 'sent' || gig.invoice_status === 'overdue') {
      payBadge = '<span class="badge badge-warning" style="font-size:9px;">Unpaid</span>';
    }
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
        ${gig.mileage_miles ? `<div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">\uD83D\uDE97 ${Math.round(parseFloat(gig.mileage_miles))} miles from home</div>` : ''}
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
          <span class="badge badge-${statusBadgeClass(gig.status)}" style="font-size:11px;">${statusLabel(gig.status)}</span>
          ${gig.fee ? `<span class="gf">\u00A3${parseFloat(gig.fee).toFixed(0)}</span>` : ''}
          ${payBadge}
          ${badges ? `<div style="display:flex;gap:4px;margin-left:auto;">${badges}</div>` : ''}
        </div>
      </div>
    </div>
  </div>`;
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
  const now = Date.now();

  // Cache-first: render instantly if both caches are fresh
  if (window._cachedGigs && window._cachedBlocked && (now - (window._cachedBlockedTime || 0)) < DATA_CACHE_TTL) {
    buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
    return;
  }

  // Show skeleton only if we have no cached data at all
  if (!window._cachedGigs && !window._cachedBlocked) {
    content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading calendar...</div>';
  }

  try {
    // Wait for in-flight prefetch first instead of firing duplicate requests
    if (window._prefetchPromise && (!window._cachedGigs || !window._cachedBlocked)) {
      await window._prefetchPromise;
      if (window._cachedGigs && window._cachedBlocked) {
        buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
        return;
      }
    }
    // Fetch anything still missing in parallel
    const fetches = [];
    const needGigs = !window._cachedGigs;
    const needBlocked = !window._cachedBlocked || (now - (window._cachedBlockedTime || 0)) >= DATA_CACHE_TTL;

    if (needGigs) fetches.push(fetch('/api/gigs'));
    if (needBlocked) fetches.push(fetch('/api/blocked-dates'));

    const results = await Promise.allSettled(fetches);
    let idx = 0;

    if (needGigs) {
      const gigsRes = results[idx++];
      if (gigsRes.status === 'fulfilled' && gigsRes.value.ok) {
        window._cachedGigs = await gigsRes.value.json();
      }
    }
    if (needBlocked) {
      const blockedRes = results[idx++];
      if (blockedRes.status === 'fulfilled' && blockedRes.value.ok) {
        window._cachedBlocked = await blockedRes.value.json();
        window._cachedBlockedTime = Date.now();
      }
    }

    buildCalendarView(content, window._cachedGigs || [], window._cachedBlocked || []);
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

function buildCalendarView(content, gigsData, blockedData) {
  const view = window._calViewMode || 'month';
  const currentDate = window._calDate || new Date();

  let html = `
    <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:24px;font-weight:700;color:var(--text);">Calendar</div>
      <div style="display:flex;gap:8px;">
        <div onclick="toggleCalendarMenu()" style="width:32px;height:32px;border-radius:16px;background:var(--card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;">&#8943;</div>
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
  // JS getDay(): 0=Sun..6=Sat. We render Mon-first, so shift: Mon=0..Sun=6.
  const firstDayRaw = new Date(year, month, 1).getDay();
  const firstDay = (firstDayRaw + 6) % 7; // 0 empty cells if month starts on Mon, 6 if Sun
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

  // Empty cells (firstDay is now 0..6 Monday-first)
  for (let i = 0; i < firstDay; i++) {
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

    // Auto-blocks for the day: soft pre/post windows from travel + load-in + pack-down
    const autoBlocks = (typeof computeAutoBlocksForGigs === 'function')
      ? computeAutoBlocksForGigs(dayGigs).filter(b => {
          const bs = new Date(b.start);
          return `${bs.getFullYear()}-${String(bs.getMonth() + 1).padStart(2, '0')}-${String(bs.getDate()).padStart(2, '0')}` === dateStr;
        })
      : [];

    dayGigs.forEach(gig => {
      const pre = autoBlocks.find(b => b.gig_id === gig.id && b.kind === 'travel_out');
      const post = autoBlocks.find(b => b.gig_id === gig.id && b.kind === 'travel_home');
      const fmt = (iso) => new Date(iso).toTimeString().substring(0, 5);

      if (pre) {
        html += `<div title="${escapeHtml(pre.label)}" style="padding:6px 10px;margin:4px 0;background:rgba(240,165,0,.08);border-left:3px solid var(--accent);border-radius:6px;font-size:11px;color:var(--text-2);">
          🚗 Travel + load-in · ${fmt(pre.start)} to ${fmt(pre.end)}
        </div>`;
      }
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
      if (post) {
        html += `<div title="${escapeHtml(post.label)}" style="padding:6px 10px;margin:4px 0;background:rgba(88,166,255,.08);border-left:3px solid var(--info);border-radius:6px;font-size:11px;color:var(--text-2);">
          📦 Pack-down + drive home · ${fmt(post.start)} to ${fmt(post.end)}
        </div>`;
      }
    });

    html += `<div style="margin-top:16px;padding:8px 10px;background:var(--card);border:1px dashed var(--border);border-radius:6px;font-size:11px;color:var(--text-3);text-align:center;">
      Travel windows default to 60min each way + 30min load-in and pack-down. Tune in Settings.
    </div>`;
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

  // Use cached invoices for instant render
  const now = Date.now();
  if (window._cachedInvoices && (now - window._cachedInvoicesTime) < DATA_CACHE_TTL) {
    buildInvoicesHTML(content, window._cachedInvoices);
    return;
  }

  content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading invoices...</div>';

  try {
    // Wait for in-flight prefetch first instead of firing a duplicate request
    if (window._prefetchPromise) {
      await window._prefetchPromise;
      if (window._cachedInvoices) {
        buildInvoicesHTML(content, window._cachedInvoices);
        return;
      }
    }
    // Fallback: fetch directly if prefetch didn't populate cache
    const res = await fetch('/api/invoices');
    if (!res.ok) throw new Error('Failed to fetch invoices');
    const invoices = await res.json();
    window._cachedInvoices = invoices;
    window._cachedInvoicesTime = Date.now();
    buildInvoicesHTML(content, invoices);
  } catch (err) {
    console.error('Invoices screen error:', err);
    content.innerHTML = `
      <div style="padding:40px 20px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#9888;&#65039;</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">Couldn't load invoices</div>
        <div style="font-size:13px;color:var(--text-2);">Check your connection and try again</div>
      </div>`;
  }
}

function buildInvoicesHTML(content, invoices) {
    const paid = invoices.filter(i => i.status === 'paid').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
    const overdue = invoices.filter(i => i.status === 'overdue').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
    const draft = invoices.filter(i => i.status === 'draft').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);
    const sent = invoices.filter(i => i.status === 'sent').reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:24px;font-weight:700;color:var(--text);">Invoices</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:2px;">${invoices.length} total &middot; &pound;${(paid + overdue + draft + sent).toFixed(0)} invoiced</div>
        </div>
        <button onclick="openPanel('panel-invoice');initInvoicePanel();" style="background:var(--accent);color:#000;border:none;border-radius:24px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">+ New</button>
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
          <div class="inv-m">${escapeHtml(inv.invoice_number || `INV-${String(inv.id).slice(0, 6)}`)} &middot; ${formatDateShort(inv.created_at || inv.date)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="inv-a" style="color:var(--success);">&pound;${parseFloat(inv.amount).toFixed(0)}</div>
          <div style="font-size:10px;color:var(--text-2);margin-top:2px;text-transform:capitalize;">${inv.status}</div>
        </div>
      </div>`;
    });

    html += `</div>
      <div style="padding:0 16px;margin-top:12px;">
        <button onclick="openPanel('create-standalone-invoice')" class="pill-g">Create standalone invoice</button>
      </div>`;

    content.innerHTML = html;
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
          <span style="font-weight:600;color:var(--text);">${escapeHtml(invoice.invoice_number || `INV-${String(invoice.id).slice(0, 6)}`)}</span>
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
        ${invoice.venue_name ? `
        <div style="display:flex;justify-content:space-between;margin-top:8px;">
          <span style="color:var(--text-2);font-size:12px;">Venue</span>
          <span style="font-weight:600;color:var(--text);text-align:right;max-width:60%;">${escapeHtml(invoice.venue_name)}</span>
        </div>` : ''}
        ${invoice.venue_address ? `
        <div style="display:flex;justify-content:space-between;margin-top:4px;">
          <span style="color:var(--text-2);font-size:12px;">Address</span>
          <span style="font-size:12px;color:var(--text);text-align:right;max-width:60%;">${escapeHtml(invoice.venue_address)}</span>
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
  const now = Date.now();

  // Cache-first: render instantly if cached data is fresh
  if (window._cachedOffers && (now - window._cachedOffersTime) < DATA_CACHE_TTL) {
    buildOffersHTML(content, window._cachedOffers);
    return;
  }

  content.innerHTML = buildSkeletonHTML();

  try {
    // Wait for in-flight prefetch first instead of firing a duplicate request
    if (window._prefetchPromise) {
      await window._prefetchPromise;
      if (window._cachedOffers) {
        buildOffersHTML(content, window._cachedOffers);
        return;
      }
    }
    // Fallback: fetch directly if prefetch didn't populate cache
    const res = await fetch('/api/offers');
    if (!res.ok) throw new Error('Failed to fetch offers');
    const offers = await res.json();
    window._cachedOffers = offers;
    window._cachedOffersTime = Date.now();
    buildOffersHTML(content, offers);
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

function buildOffersHTML(content, offers) {
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
    // Wait for in-flight prefetch first instead of firing a duplicate request
    if (window._prefetchPromise) {
      await window._prefetchPromise;
      if (window._cachedProfile) {
        buildProfileHTML(content, window._cachedProfile);
        return;
      }
    }
    // Fallback: fetch directly if prefetch didn't populate cache
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
    // Prefer display_name (real name) over name (which may be an act/band name)
    const displayName = profile.display_name || profile.name || '';
    const userInitial = (displayName || profile.email || 'G')[0].toUpperCase();

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('profile-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">&#8249;</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">Profile</div>
        <button onclick="editProfile()" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;font-weight:600;">Edit</button>
      </div>
      <div style="padding:0 16px 12px;">
        <div style="text-align:center;">
          <div style="width:64px;height:64px;margin:0 auto 12px;border-radius:32px;background:var(--accent-dim);border:3px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:var(--accent);">${userInitial}</div>
          <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px;">${escapeHtml(displayName || 'Guest')}</div>
          ${profile.name && profile.name !== displayName ? `<div style="font-size:12px;color:var(--text-2);margin-bottom:4px;">Act: ${escapeHtml(profile.name)}</div>` : ''}
          <div style="font-size:12px;color:var(--text-2);margin-bottom:2px;">${escapeHtml(Array.isArray(profile.instruments) ? profile.instruments.join(', ') : (profile.instruments || 'No instruments listed'))}</div>
          <div style="font-size:12px;color:var(--text-2);">📍 ${escapeHtml(profile.location || profile.home_postcode || 'Location not set')}</div>
          ${profile.home_postcode ? `<div style="font-size:10px;color:var(--text-3);margin-top:2px;">Home: ${escapeHtml(profile.home_postcode)}</div>` : '<div style="font-size:10px;color:var(--warning);margin-top:2px;">Add home postcode for mileage tracking</div>'}
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
        <div onclick="openPanel('panel-network'); openNetworkPanel();" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">My Network</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="openPanel('panel-repertoire'); openRepertoirePanel();" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Repertoire library</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="viewEPK()" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
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
        <div style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);">
          <div style="font-size:14px;color:var(--text);margin-bottom:10px;">Colour theme</div>
          <div style="display:flex;gap:12px;justify-content:center;">
            <button onclick="setColourTheme('amber')" class="colour-swatch" data-theme="amber" style="width:36px;height:36px;border-radius:50%;border:3px solid transparent;cursor:pointer;background:#F0A500;" title="Amber"></button>
            <button onclick="setColourTheme('blue')" class="colour-swatch" data-theme="blue" style="width:36px;height:36px;border-radius:50%;border:3px solid transparent;cursor:pointer;background:#58A6FF;" title="Blue"></button>
            <button onclick="setColourTheme('green')" class="colour-swatch" data-theme="green" style="width:36px;height:36px;border-radius:50%;border:3px solid transparent;cursor:pointer;background:#3FB950;" title="Green"></button>
            <button onclick="setColourTheme('purple')" class="colour-swatch" data-theme="purple" style="width:36px;height:36px;border-radius:50%;border:3px solid transparent;cursor:pointer;background:#BC8CFF;" title="Purple"></button>
            <button onclick="setColourTheme('red')" class="colour-swatch" data-theme="red" style="width:36px;height:36px;border-radius:50%;border:3px solid transparent;cursor:pointer;background:#F85149;" title="Red"></button>
            <button onclick="setColourTheme('teal')" class="colour-swatch" data-theme="teal" style="width:36px;height:36px;border-radius:50%;border:3px solid transparent;cursor:pointer;background:#39D2C0;" title="Teal"></button>
          </div>
        </div>
      </div>
      <div style="padding:0 16px;margin-top:12px;">
        <button onclick="logout()" class="pill" style="background:var(--danger);color:#fff;">Sign Out</button>
      </div>`;

    content.innerHTML = html;
    // Highlight the active colour swatch
    const activeColour = localStorage.getItem('colourTheme') || 'amber';
    applyColourTheme(activeColour);
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
  // Capture current fee before re-render destroys the input
  const feeEl = document.getElementById('wFee');
  if (feeEl) gigWizardData.fee = feeEl.value || '';
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
            gigWizardData.mileage_miles = distData.miles;
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

  // Auto-block pre-flight check: warn if this gig collides with another gig's
  // travel-home or travel-out window. Runs on the client, cheap, no round-trip.
  try {
    if (gigWizardData.date && gigWizardData.start_time && !gigWizardData._forcedThroughAutoBlock) {
      const d = gigWizardData.date;
      const s = `${d}T${gigWizardData.start_time.length === 5 ? gigWizardData.start_time + ':00' : gigWizardData.start_time}`;
      const endTime = gigWizardData.end_time || gigWizardData.start_time;
      const e = `${d}T${endTime.length === 5 ? endTime + ':00' : endTime}`;
      const clash = typeof isTimeAutoBlocked === 'function' ? isTimeAutoBlocked(s, e) : null;
      if (clash) {
        const ok = confirm(`Heads up: this overlaps with ${clash.label}. Book it anyway?`);
        if (!ok) return;
        gigWizardData._forcedThroughAutoBlock = true;
      }
    }
  } catch (_) { /* non-fatal */ }

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
      notes: gigWizardData.notes || null,
      gig_type: gigWizardData.gig_type || null,
      dress_code: gigWizardData.dress_code || null,
      mileage_miles: gigWizardData.mileage_miles || null,
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
    data.gig_type = gigWizardData.gig_type || null;

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
    { name: 'Dress code', ok: !!gig.dress_code || !!gig.details_complete },
    { name: 'Notes', ok: !!gig.notes || !!gig.details_complete },
    { name: 'Address', ok: !!gig.venue_address },
  ];
  const doneCount = fields.filter((f) => f.ok).length;
  const allDone = doneCount === fields.length;

  // Wire up the Edit button in the panel header
  const editBtn = document.getElementById('gigDetailEditBtn');
  if (editBtn) editBtn.onclick = () => openEditGig(gig.id);

  body.innerHTML = `
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
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          ${fields.map((f) => f.ok
            ? `<span style="font-size:10px;color:var(--success);background:var(--success-dim);border-radius:8px;padding:3px 8px;">\u2713 ${f.name}</span>`
            : `<span style="font-size:10px;color:var(--warning);background:var(--warning-dim);border:1px solid rgba(240,165,0,.3);border-radius:8px;padding:3px 8px;">+ Add ${f.name.toLowerCase()}</span>`
          ).join('')}
          ${!allDone ? `<span onclick="markGigDetailsComplete('${gig.id}')" style="font-size:10px;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:3px 10px;cursor:pointer;margin-left:auto;">Mark complete</span>` : ''}
        </div>
      </div>
    </div>
    <!-- Gig Pack -->
    <div style="padding:16px 20px;border-top:1px solid var(--border);">
      <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">\uD83C\uDF92 Gig Pack</div>
      ${getGigType(gig) ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Type</span><span style="color:var(--text);font-weight:500;">${escapeHtml(getGigType(gig))}</span></div>` : ''}
      ${gig.dress_code ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Dress code</span><span style="color:var(--text);font-weight:500;">${escapeHtml(gig.dress_code)}</span></div>` : ''}
      ${gig.parking_info ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Parking</span><span style="color:var(--text);font-weight:500;text-align:right;max-width:60%;">${escapeHtml(gig.parking_info)}</span></div>` : ''}
      ${gig.load_in_time ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Load-in</span><span style="color:var(--text);font-weight:500;">${formatTime(gig.load_in_time)}</span></div>` : ''}
      ${gig.day_of_contact ? `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;"><span style="color:var(--text-2);">Day-of contact</span><span style="color:var(--text);font-weight:500;text-align:right;max-width:60%;">${escapeHtml(gig.day_of_contact)}</span></div>` : ''}
      ${buildSetTimesDisplay(gig)}
      ${getGigNotes(gig) ? `<div style="display:flex;justify-content:space-between;padding:10px 0;font-size:14px;"><span style="color:var(--text-2);">Notes</span><span style="color:var(--text);font-weight:500;text-align:right;max-width:60%;">${escapeHtml(getGigNotes(gig))}</span></div>` : ''}
      ${!gig.dress_code && !gig.load_in_time && !getGigNotes(gig) && !getGigType(gig) && !gig.parking_info && !gig.day_of_contact ? '<div style="font-size:13px;color:var(--text-3);padding:10px 0;">No gig pack info yet. Edit the gig to add details.</div>' : ''}
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
        <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Prep checklist</div>
        <span onclick="addChecklistItem('${gig.id}')" style="font-size:11px;color:var(--accent);cursor:pointer;">+ Add</span>
      </div>
      <div id="checklistItems" style="background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;">
        ${buildChecklistHTML(gig)}
      </div>
    </div>
    <!-- Actions -->
    <div style="padding:16px 20px;border-top:1px solid var(--border);">
      <button style="width:100%;background:var(--card);color:var(--accent);border:1px solid var(--accent);border-radius:24px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px;" onclick="openGigChat('${gig.id}')">💬 Message band</button>
      <button style="width:100%;background:var(--accent);color:#000;border:none;border-radius:24px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px;" onclick="createInvoiceForGig('${gig.id}')">Create invoice for this gig</button>
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
          <button onclick="shareReviewLink('google')" style="flex:1;background:var(--card);color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:8px;font-size:11px;font-weight:600;cursor:pointer;">🔵 Google Review</button>
          <button onclick="shareReviewLink('facebook')" style="flex:1;background:var(--card);color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:8px;font-size:11px;font-weight:600;cursor:pointer;">📘 Facebook Review</button>
        </div>
        <div style="text-align:center;font-size:10px;color:var(--text-3);margin-top:6px;">Set up your review links in Profile > Edit Profile</div>
      </div>
      <button style="width:100%;background:var(--card);color:var(--danger);border:1px solid var(--danger);border-radius:24px;padding:12px;font-size:14px;font-weight:500;cursor:pointer;" onclick="closePanel('panel-gig-detail');deleteGig('${gig.id}')">Delete gig</button>
    </div>
  `;

  openPanel('panel-gig-detail');

  // Show mileage: use stored value first, then fetch in background if needed
  const mileageEl = document.getElementById('gigDetailMileage');
  if (gig.mileage_miles && mileageEl) {
    const miles = Math.round(parseFloat(gig.mileage_miles));
    const claimable = (miles * 2 * 0.45).toFixed(2);
    mileageEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="font-size:14px;color:var(--text-2);">\uD83D\uDE97 ${miles} miles round trip</div>
        <span style="font-size:11px;color:var(--success);background:var(--success-dim);border-radius:8px;padding:2px 8px;font-weight:600;">\u00A3${claimable} claimable</span>
      </div>
    `;
  } else if (homePostcode && gig.venue_address) {
    try {
      const distResp = await fetch(`/api/distance?origin=${encodeURIComponent(homePostcode)}&destination=${encodeURIComponent(gig.venue_address)}`);
      const distData = await distResp.json();
      if (distData.miles && mileageEl) {
        const claimable = (distData.miles * 2 * 0.45).toFixed(2);
        mileageEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="font-size:14px;color:var(--text-2);">\uD83D\uDE97 ${distData.miles} miles round trip</div>
            <span style="font-size:11px;color:var(--success);background:var(--success-dim);border-radius:8px;padding:2px 8px;font-weight:600;">\u00A3${claimable} claimable</span>
          </div>
        `;
        // Save mileage to the gig record so it shows on cards next time
        fetch('/api/gigs/' + gig.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mileage_miles: distData.miles })
        }).catch(e => console.error('Save mileage error:', e));
        // Update cached gig too
        if (window._cachedGigs) {
          const cached = window._cachedGigs.find(g => g.id === gig.id);
          if (cached) cached.mileage_miles = distData.miles;
        }
      }
    } catch (e) {
      console.error('Mileage fetch error:', e);
    }
  }
}

// -- Checklist functions --

const DEFAULT_CHECKLIST = [
  { text: 'Check PA requirements', done: false },
  { text: 'Confirm set times with band', done: false },
  { text: 'Pack gear the night before', done: false },
  { text: 'Print/download setlist', done: false },
];

// Extract gig type - use dedicated column, or parse legacy [Type] prefix from notes
function getGigType(gig) {
  if (gig.gig_type) return gig.gig_type;
  // Legacy: parse [Type] from notes
  if (gig.notes) {
    const m = gig.notes.match(/^\[([^\]]+)\]/);
    if (m) return m[1];
  }
  return null;
}

// Get notes without legacy [Type] prefix
function buildSetTimesDisplay(gig) {
  const sets = gig.set_times && Array.isArray(gig.set_times) && gig.set_times.length > 0 ? gig.set_times : [];
  if (sets.length === 0) return '';
  return sets.map(s =>
    `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:14px;">
      <span style="color:var(--text-2);">${escapeHtml(s.name || 'Set')}</span>
      <span style="color:var(--text);font-weight:500;">${formatTime(s.start)}${s.end ? '\u2013' + formatTime(s.end) : ''}</span>
    </div>`
  ).join('');
}

function getGigNotes(gig) {
  if (gig.gig_type || !gig.notes) return gig.notes || '';
  // Strip legacy [Type] prefix
  return gig.notes.replace(/^\[[^\]]+\]\s*/, '');
}

function getGigChecklist(gig) {
  if (gig.checklist && Array.isArray(gig.checklist) && gig.checklist.length > 0) return gig.checklist;
  return DEFAULT_CHECKLIST;
}

function buildChecklistHTML(gig) {
  const items = getGigChecklist(gig);
  if (!items.length) return '<div style="padding:10px 14px;font-size:12px;color:var(--text-3);">No items yet</div>';
  return items.map((item, i) => `
    <div onclick="toggleChecklistItem('${gig.id}', ${i})" style="display:flex;align-items:center;gap:10px;padding:10px 14px;${i < items.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}cursor:pointer;">
      <span style="font-size:14px;${item.done ? 'color:var(--success);' : ''}">${item.done ? '\u2713' : '\u25CB'}</span>
      <span style="font-size:13px;color:var(--text);${item.done ? 'text-decoration:line-through;opacity:0.5;' : ''}flex:1;">${escapeHtml(item.text)}</span>
      <span onclick="event.stopPropagation();removeChecklistItem('${gig.id}', ${i})" style="font-size:11px;color:var(--text-3);cursor:pointer;padding:2px 6px;">\u2715</span>
    </div>`).join('');
}

async function toggleChecklistItem(gigId, index) {
  const gig = (window._cachedGigs || []).find(g => g.id === gigId);
  if (!gig) return;
  const items = getGigChecklist(gig);
  items[index].done = !items[index].done;
  gig.checklist = items;
  const container = document.getElementById('checklistItems');
  if (container) container.innerHTML = buildChecklistHTML(gig);
  await saveChecklist(gigId, items);
}

function addChecklistItem(gigId) {
  // Remove any existing modal
  const existing = document.getElementById('checklistModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'checklistModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;width:100%;max-width:360px;padding:20px;">
      <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:14px;">Add checklist item</div>
      <input id="checklistModalInput" type="text" placeholder="e.g. Bring spare strings"
        style="width:100%;box-sizing:border-box;padding:12px 14px;font-size:14px;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);outline:none;" />
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button id="checklistModalCancel" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text-2);font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>
        <button id="checklistModalAdd" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--accent);color:#000;font-size:14px;font-weight:600;cursor:pointer;">Add</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const input = document.getElementById('checklistModalInput');
  input.focus();

  function closeModal() { modal.remove(); }

  async function submitItem() {
    const text = input.value.trim();
    if (!text) { closeModal(); return; }
    const gig = (window._cachedGigs || []).find(g => g.id === gigId);
    if (!gig) { closeModal(); return; }
    const items = getGigChecklist(gig);
    items.push({ text, done: false });
    gig.checklist = items;
    const container = document.getElementById('checklistItems');
    if (container) container.innerHTML = buildChecklistHTML(gig);
    closeModal();
    await saveChecklist(gigId, items);
  }

  document.getElementById('checklistModalCancel').onclick = closeModal;
  document.getElementById('checklistModalAdd').onclick = submitItem;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitItem();
    if (e.key === 'Escape') closeModal();
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}

async function removeChecklistItem(gigId, index) {
  const gig = (window._cachedGigs || []).find(g => g.id === gigId);
  if (!gig) return;
  const items = getGigChecklist(gig);
  items.splice(index, 1);
  gig.checklist = items;
  const container = document.getElementById('checklistItems');
  if (container) container.innerHTML = buildChecklistHTML(gig);
  await saveChecklist(gigId, items);
}

async function saveChecklist(gigId, items) {
  try {
    await fetch(`/api/gigs/${gigId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checklist: items }),
    });
  } catch (e) {
    console.error('Save checklist error:', e);
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

async function shareReviewLink(platform) {
  const profile = window._cachedProfile || window._currentUser || {};
  const url = platform === 'google' ? profile.google_review_url : profile.facebook_review_url;
  const label = platform === 'google' ? 'Google' : 'Facebook';

  if (!url) {
    showToast(`Set up your ${label} review link in Profile > Edit Profile`);
    return;
  }

  // Try native share, fall back to clipboard
  if (navigator.share) {
    try {
      await navigator.share({ title: `Leave a ${label} review`, url: url });
      showToast('Review link shared!');
    } catch (e) {
      if (e.name !== 'AbortError') {
        await navigator.clipboard.writeText(url);
        showToast('Review link copied to clipboard!');
      }
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      showToast('Review link copied to clipboard!');
    } catch (e) {
      showToast(`${label} review: ${url}`);
    }
  }
}

async function markGigDetailsComplete(gigId) {
  try {
    const res = await fetch(`/api/gigs/${gigId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ details_complete: true }),
    });
    if (!res.ok) throw new Error('Failed to update gig');
    // Update cache and re-render detail view
    window._cachedGigs = (window._cachedGigs || []).map(g =>
      g.id === gigId ? { ...g, details_complete: true } : g
    );
    openGigDetail(gigId);
    showToast('Marked as complete');
  } catch (e) {
    console.error('Mark complete error:', e);
  }
}

async function deleteGig(gigId) {
  if (!confirm('Are you sure you want to delete this gig?')) return;
  try {
    const res = await fetch(`/api/gigs/${gigId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Delete gig failed:', res.status, err);
      showToast('Failed to delete gig');
      return;
    }
    // Clear caches so every screen re-fetches fresh data
    window._cachedGigs = (window._cachedGigs || []).filter((g) => g.id !== gigId);
    window._cachedStats = null;
    // Re-render the active screen so homepage/gigs/calendar all update
    showScreen(currentScreen || 'gigs');
    showToast('Gig deleted');
  } catch (e) {
    console.error('Delete gig error:', e);
    showToast('Failed to delete gig');
  }
}

async function openEditGig(gigId) {
  const body = document.getElementById('editGigBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading gig...</div>';
  openPanel('panel-edit-gig');

  try {
    let gig = (window._cachedGigs || []).find(g => g.id === gigId);
    if (!gig) {
      const res = await fetch(`/api/gigs/${gigId}`);
      if (!res.ok) throw new Error('Failed to fetch gig');
      gig = await res.json();
    }

    let html = `
      <div style="padding:0 16px 20px;">
        <div class="form-group">
          <div class="form-label">Band / client name</div>
          <input type="text" class="form-input" id="editBandName" value="${escapeHtml(gig.band_name || '')}" placeholder="e.g. The Vents" />
        </div>
        <div class="form-group">
          <div class="form-label">Venue</div>
          <input type="text" class="form-input" id="editVenue" value="${escapeHtml(gig.venue_name || '')}" placeholder="e.g. The Grand Hotel" />
        </div>
        <div class="form-group">
          <div class="form-label">Venue address</div>
          <input type="text" class="form-input" id="editVenueAddress" value="${escapeHtml(gig.venue_address || '')}" placeholder="Full address" />
        </div>
        <div class="form-group">
          <div class="form-label">Date</div>
          <input type="date" class="form-input" id="editDate" value="${(gig.date || '').substring(0, 10)}" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group">
            <div class="form-label">Start time</div>
            <input type="time" class="form-input" id="editStartTime" value="${gig.start_time || ''}" />
          </div>
          <div class="form-group">
            <div class="form-label">End time</div>
            <input type="time" class="form-input" id="editEndTime" value="${gig.end_time || ''}" />
          </div>
        </div>
        <div class="form-group">
          <div class="form-label">Load-in time</div>
          <input type="time" class="form-input" id="editLoadInTime" value="${gig.load_in_time || ''}" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group">
            <div class="form-label">Fee (\u00a3)</div>
            <input type="number" class="form-input" id="editFee" value="${gig.fee || ''}" placeholder="0.00" step="0.01" />
          </div>
          <div class="form-group">
            <div class="form-label">Status</div>
            <select class="form-input" id="editStatus">
              <option value="confirmed" ${gig.status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
              <option value="tentative" ${gig.status === 'tentative' ? 'selected' : ''}>Pencilled</option>
              <option value="enquiry" ${gig.status === 'enquiry' ? 'selected' : ''}>Enquiry</option>
              <option value="cancelled" ${gig.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div class="form-group">
            <div class="form-label">Gig type</div>
            <select class="form-input" id="editGigType">
              <option value="" ${!getGigType(gig) ? 'selected' : ''}>None</option>
              <option value="Wedding" ${getGigType(gig) === 'Wedding' ? 'selected' : ''}>Wedding</option>
              <option value="Corporate" ${getGigType(gig) === 'Corporate' ? 'selected' : ''}>Corporate</option>
              <option value="Pub / Club" ${getGigType(gig) === 'Pub / Club' ? 'selected' : ''}>Pub / Club</option>
              <option value="Private party" ${getGigType(gig) === 'Private party' ? 'selected' : ''}>Private party</option>
              <option value="Festival" ${getGigType(gig) === 'Festival' ? 'selected' : ''}>Festival</option>
              <option value="Hotel" ${getGigType(gig) === 'Hotel' ? 'selected' : ''}>Hotel</option>
              <option value="Theatre" ${getGigType(gig) === 'Theatre' ? 'selected' : ''}>Theatre</option>
              <option value="Church" ${getGigType(gig) === 'Church' ? 'selected' : ''}>Church</option>
              <option value="Restaurant" ${getGigType(gig) === 'Restaurant' ? 'selected' : ''}>Restaurant</option>
              <option value="Other" ${getGigType(gig) === 'Other' ? 'selected' : ''}>Other</option>
            </select>
          </div>
          <div class="form-group">
            <div class="form-label">Dress code</div>
            <input type="text" class="form-input" id="editDressCode" value="${escapeHtml(gig.dress_code || '')}" placeholder="e.g. Smart casual" />
          </div>
        </div>
        <div class="form-group">
          <div class="form-label">Parking</div>
          <input type="text" class="form-input" id="editParkingInfo" value="${escapeHtml(gig.parking_info || '')}" placeholder="e.g. Q-Park, rear entrance" />
        </div>
        <div class="form-group">
          <div class="form-label">Day-of contact</div>
          <input type="text" class="form-input" id="editDayOfContact" value="${escapeHtml(gig.day_of_contact || '')}" placeholder="e.g. Sarah 07700 900123" />
        </div>
        <div class="form-group">
          <div class="form-label">Notes</div>
          <textarea class="form-input" id="editNotes" style="resize:vertical;min-height:80px;">${escapeHtml(getGigNotes(gig))}</textarea>
        </div>
        <div class="form-group">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div class="form-label" style="margin-bottom:0;">Sets</div>
            <span onclick="addSetTimeRow()" style="font-size:11px;color:var(--accent);cursor:pointer;">+ Add set</span>
          </div>
          <div id="editSetTimesContainer">${buildEditSetTimesHTML(gig)}</div>
        </div>
        <button onclick="saveEditGig('${gig.id}')" class="btn-pill" style="width:100%;margin-top:8px;">Save Changes</button>
      </div>`;

    body.innerHTML = html;
  } catch (err) {
    console.error('Edit gig error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load gig</div>';
  }
}

function buildEditSetTimesHTML(gig) {
  const sets = gig.set_times && Array.isArray(gig.set_times) && gig.set_times.length > 0 ? gig.set_times : [];
  if (sets.length === 0) return '<div id="editSetTimesEmpty" style="font-size:12px;color:var(--text-3);padding:8px 0;">No sets defined yet. Add sets to plan your performance.</div>';
  return sets.map((s, i) => buildSetTimeRow(i, s.name, s.start, s.end)).join('');
}

function buildSetTimeRow(index, name, start, end) {
  return `<div class="set-time-row" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
    <input type="text" class="form-input set-name" value="${escapeHtml(name || 'Set ' + (index + 1))}" placeholder="Set ${index + 1}" style="flex:1;min-width:0;padding:10px;font-size:13px;" />
    <input type="time" class="form-input set-start" value="${start || ''}" style="width:90px;padding:10px;font-size:13px;" />
    <span style="color:var(--text-3);font-size:12px;">to</span>
    <input type="time" class="form-input set-end" value="${end || ''}" style="width:90px;padding:10px;font-size:13px;" />
    <span onclick="this.parentElement.remove()" style="color:var(--text-3);cursor:pointer;padding:4px;font-size:14px;">\u2715</span>
  </div>`;
}

function addSetTimeRow() {
  const container = document.getElementById('editSetTimesContainer');
  if (!container) return;
  const empty = document.getElementById('editSetTimesEmpty');
  if (empty) empty.remove();
  const count = container.querySelectorAll('.set-time-row').length;
  container.insertAdjacentHTML('beforeend', buildSetTimeRow(count, 'Set ' + (count + 1), '', ''));
}

function collectSetTimes() {
  const rows = document.querySelectorAll('#editSetTimesContainer .set-time-row');
  const sets = [];
  rows.forEach(row => {
    const name = row.querySelector('.set-name').value.trim();
    const start = row.querySelector('.set-start').value;
    const end = row.querySelector('.set-end').value;
    if (name || start || end) {
      sets.push({ name: name || 'Set', start: start || '', end: end || '' });
    }
  });
  return sets;
}

async function saveEditGig(gigId) {
  try {
    const dateVal = document.getElementById('editDate').value;
    const feeVal = document.getElementById('editFee').value;
    const data = {
      band_name: document.getElementById('editBandName').value || null,
      venue_name: document.getElementById('editVenue').value || null,
      venue_address: document.getElementById('editVenueAddress').value || null,
      date: dateVal || null,
      start_time: document.getElementById('editStartTime').value || null,
      end_time: document.getElementById('editEndTime').value || null,
      load_in_time: document.getElementById('editLoadInTime').value || null,
      fee: feeVal ? parseFloat(feeVal) : null,
      status: document.getElementById('editStatus').value,
      gig_type: document.getElementById('editGigType').value || null,
      dress_code: document.getElementById('editDressCode').value || null,
      parking_info: document.getElementById('editParkingInfo').value || null,
      day_of_contact: document.getElementById('editDayOfContact').value || null,
      notes: document.getElementById('editNotes').value || null,
      set_times: collectSetTimes(),
    };

    const res = await fetch(`/api/gigs/${gigId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) throw new Error('Failed to save gig');

    // Update cache and invalidate stats so homepage refreshes
    window._cachedGigs = (window._cachedGigs || []).map(g => g.id === gigId ? { ...g, ...data, id: gigId } : g);
    window._cachedStats = null;
    closePanel('panel-edit-gig');
    renderGigsList(window._cachedGigs);
  } catch (err) {
    console.error('Save gig error:', err);
    alert('Failed to save gig');
  }
}

// openPanel / closePanel defined earlier (line ~1969) — removed duplicate here

function editProfile() {
  const profile = window._cachedProfile || window._currentUser || {};
  const body = document.getElementById('editProfileBody');
  if (!body) return;

  const instrumentsStr = Array.isArray(profile.instruments) ? profile.instruments.join(', ') : (profile.instruments || '');

  body.innerHTML = `
    <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
      <button onclick="closePanel('panel-edit-profile')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">&#8249;</button>
      <div style="font-size:16px;font-weight:700;color:var(--text);">Edit Profile</div>
      <button onclick="saveProfile()" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;font-weight:600;">Save</button>
    </div>
    <div style="padding:0 16px;">
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Your name</label>
        <input id="editDisplayName" type="text" value="${escapeHtml(profile.display_name || '')}" placeholder="e.g. Gareth Gwyn" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Shown in the app header and on your profile</div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Act / band name</label>
        <input id="editName" type="text" value="${escapeHtml(profile.name || '')}" placeholder="e.g. The Vents" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Used on invoices and public pages. Leave blank if you only perform under your own name.</div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Phone</label>
        <input id="editPhone" type="tel" value="${escapeHtml(profile.phone || '')}" placeholder="07xxx xxxxxx" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Instruments</label>
        <input id="editInstruments" type="text" value="${escapeHtml(instrumentsStr)}" placeholder="Guitar, Vocals, Keys" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Comma separated</div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Home Postcode</label>
        <input id="editHomePostcode" type="text" value="${escapeHtml(profile.home_postcode || '')}" placeholder="e.g. CF10 1AA" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;text-transform:uppercase;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Used to calculate mileage to gig venues</div>
      </div>
      <div style="margin-top:20px;margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Review Links</div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Google Review URL</label>
        <input id="editGoogleReview" type="url" value="${escapeHtml(profile.google_review_url || '')}" placeholder="https://g.page/r/..." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Paste your Google Business review link</div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Facebook Review URL</label>
        <input id="editFacebookReview" type="url" value="${escapeHtml(profile.facebook_review_url || '')}" placeholder="https://facebook.com/..." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Paste your Facebook page review link</div>
      </div>
      <div style="margin-top:20px;margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Invoice Settings</div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Bank / Payment Details</label>
        <textarea id="editBankDetails" rows="3" placeholder="e.g. Sort code: 12-34-56&#10;Account: 12345678&#10;Gareth Gwyn" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;min-height:60px;font-family:inherit;">${escapeHtml(profile.bank_details || '')}</textarea>
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Auto-fills on every new invoice</div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Number Format</label>
        <select id="editInvoiceFormat" onchange="updateInvFormatPreview()" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
          <option value="plain" ${(profile.invoice_format || 'plain') === 'plain' ? 'selected' : ''}>Sequential (INV-001)</option>
          <option value="year" ${profile.invoice_format === 'year' ? 'selected' : ''}>Year (INV-2026-001)</option>
          <option value="year-month" ${profile.invoice_format === 'year-month' ? 'selected' : ''}>Year-month (INV-2026-04-001)</option>
          <option value="year-short" ${profile.invoice_format === 'year-short' ? 'selected' : ''}>Short date (INV-2604-001)</option>
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Prefix</label>
          <input id="editInvoicePrefix" type="text" value="${escapeHtml(profile.invoice_prefix || 'INV')}" placeholder="INV" oninput="updateInvFormatPreview()" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;text-transform:uppercase;" />
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Next Number</label>
          <input id="editInvoiceNextNum" type="number" min="1" value="${profile.invoice_next_number || 1}" oninput="updateInvFormatPreview()" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        </div>
      </div>
      <div id="invFormatPreview" style="font-size:12px;color:var(--accent);margin-bottom:14px;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);">Next invoice: ${escapeHtml(generateInvoiceNumber(profile.invoice_prefix || 'INV', profile.invoice_next_number || 1, profile.invoice_format || 'plain'))}</div>
    </div>`;

  openPanel('panel-edit-profile');
}

async function saveProfile() {
  const name = document.getElementById('editName')?.value?.trim();
  const displayName = document.getElementById('editDisplayName')?.value?.trim();
  const phone = document.getElementById('editPhone')?.value?.trim();
  const instrumentsRaw = document.getElementById('editInstruments')?.value?.trim();
  const homePostcode = document.getElementById('editHomePostcode')?.value?.trim().toUpperCase();
  const googleReviewUrl = document.getElementById('editGoogleReview')?.value?.trim();
  const facebookReviewUrl = document.getElementById('editFacebookReview')?.value?.trim();
  const bankDetails = document.getElementById('editBankDetails')?.value?.trim();
  const invoicePrefix = document.getElementById('editInvoicePrefix')?.value?.trim().toUpperCase();
  const invoiceNextNum = parseInt(document.getElementById('editInvoiceNextNum')?.value, 10) || null;
  const invoiceFormat = document.getElementById('editInvoiceFormat')?.value || null;

  const instruments = instrumentsRaw ? instrumentsRaw.split(',').map(s => s.trim()).filter(Boolean).join(', ') : '';

  try {
    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name !== undefined ? name : null,
        display_name: displayName || null,
        phone: phone || null,
        instruments: instruments || null,
        home_postcode: homePostcode || null,
        google_review_url: googleReviewUrl || null,
        facebook_review_url: facebookReviewUrl || null,
        bank_details: bankDetails || null,
        invoice_prefix: invoicePrefix || null,
        invoice_next_number: invoiceNextNum,
        invoice_format: invoiceFormat,
      })
    });

    if (!res.ok) throw new Error('Save failed');

    const updated = await res.json();
    window._cachedProfile = updated;
    window._cachedProfileTime = Date.now();
    window._currentUser = { ...window._currentUser, ...updated };

    // Refresh profile panel behind the edit panel
    const profileBody = document.getElementById('profilePanelBody');
    if (profileBody) buildProfileHTML(profileBody, updated);

    // Update header avatar/name if changed
    updateAppHeader();

    closePanel('panel-edit-profile');
  } catch (err) {
    console.error('Save profile error:', err);
    alert('Failed to save profile. Please try again.');
  }
}

function updateInvFormatPreview() {
  const prefix = document.getElementById('editInvoicePrefix')?.value?.trim().toUpperCase() || 'INV';
  const nextNum = parseInt(document.getElementById('editInvoiceNextNum')?.value, 10) || 1;
  const format = document.getElementById('editInvoiceFormat')?.value || 'plain';
  const preview = generateInvoiceNumber(prefix, nextNum, format);
  const el = document.getElementById('invFormatPreview');
  if (el) el.textContent = 'Next invoice: ' + preview;
}
window.updateInvFormatPreview = updateInvFormatPreview;

// Ensure the current user has a public_slug, requesting one from the server if needed.
// Returns the slug string, or null on failure.
async function _ensurePublicSlug() {
  const profile = window._cachedProfile || window._currentUser || {};
  if (profile.public_slug) return profile.public_slug;
  try {
    const res = await fetch('/api/user/slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error('slug fetch failed');
    const { slug } = await res.json();
    if (window._cachedProfile) window._cachedProfile.public_slug = slug;
    if (window._currentUser) window._currentUser.public_slug = slug;
    return slug;
  } catch (err) {
    console.error('Slug error:', err);
    return null;
  }
}

async function _shareOrCopy(url, shareTitle, shareText) {
  // Native Web Share if available
  if (navigator.share) {
    try {
      await navigator.share({ title: shareTitle, text: shareText, url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied: ' + url);
  } catch {
    prompt('Copy this link:', url);
  }
}

async function shareProfile() {
  const slug = await _ensurePublicSlug();
  if (!slug) { showToast('Could not generate share link'); return; }
  const name = window._currentUser?.display_name || window._currentUser?.name || 'my';
  const url = `${location.origin}/epk/${slug}`;
  _shareOrCopy(url, `${name} EPK`, `Check out ${name} on TrackMyGigs`);
}
window.shareProfile = shareProfile;

function viewEPK() {
  // Open the internal EPK editor; it includes a button to preview the public version
  openPanel('panel-epk');
  buildEPKEditor();
}
window.viewEPK = viewEPK;

function buildEPKEditor() {
  const body = document.getElementById('epkBody');
  if (!body) return;
  const profile = window._cachedProfile || window._currentUser || {};

  body.innerHTML = `
    <div style="padding:16px;">
      <p style="font-size:13px;color:var(--text-2);line-height:1.5;margin-bottom:16px;">
        Fill these in and they'll show on your public EPK page. Anyone can view it once you share the link.
      </p>

      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Bio</label>
        <textarea id="epkBio" rows="5" placeholder="A short bio promoters can read at a glance. Style of music, notable gigs, what makes you worth booking." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;font-family:inherit;">${escapeHtml(profile.epk_bio || '')}</textarea>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Photo URL</label>
        <input id="epkPhoto" type="url" value="${escapeHtml(profile.epk_photo_url || '')}" placeholder="https://..." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">A wide hero photo works best. Upload to Imgur or Dropbox and paste the direct image URL.</div>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Video URL</label>
        <input id="epkVideo" type="url" value="${escapeHtml(profile.epk_video_url || '')}" placeholder="https://youtube.com/watch?v=..." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">YouTube, Vimeo, or any direct video link.</div>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Audio URL</label>
        <input id="epkAudio" type="url" value="${escapeHtml(profile.epk_audio_url || '')}" placeholder="https://soundcloud.com/..." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">A direct MP3, SoundCloud, or Dropbox link.</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px;margin-top:20px;">
        <button onclick="saveEPK()" class="pill-g">Save EPK</button>
        <button onclick="previewEPK()" class="pill-o">Preview public page</button>
        <button onclick="shareProfile()" class="pill-o">Share EPK link</button>
      </div>
    </div>`;
}
window.buildEPKEditor = buildEPKEditor;

async function saveEPK() {
  const epk_bio = document.getElementById('epkBio')?.value?.trim();
  const epk_photo_url = document.getElementById('epkPhoto')?.value?.trim();
  const epk_video_url = document.getElementById('epkVideo')?.value?.trim();
  const epk_audio_url = document.getElementById('epkAudio')?.value?.trim();

  try {
    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        epk_bio: epk_bio || '',
        epk_photo_url: epk_photo_url || '',
        epk_video_url: epk_video_url || '',
        epk_audio_url: epk_audio_url || '',
      }),
    });
    if (!res.ok) throw new Error('save failed');
    const updated = await res.json();
    window._cachedProfile = updated;
    window._currentUser = { ...window._currentUser, ...updated };
    showToast('EPK saved');
  } catch (err) {
    console.error('Save EPK error:', err);
    showToast('Failed to save EPK');
  }
}
window.saveEPK = saveEPK;

async function previewEPK() {
  const slug = await _ensurePublicSlug();
  if (!slug) { showToast('Could not open preview'); return; }
  window.open(`/epk/${slug}`, '_blank');
}
window.previewEPK = previewEPK;

async function shareAvailability() {
  const slug = await _ensurePublicSlug();
  if (!slug) { showToast('Could not generate share link'); return; }
  const name = window._currentUser?.display_name || window._currentUser?.name || 'my';
  const url = `${location.origin}/share/${slug}`;
  _shareOrCopy(url, `${name} availability`, `Book ${name}. Live availability here.`);
}
window.shareAvailability = shareAvailability;

function toggleTheme() {
  document.body.classList.toggle('light-mode');
  const newTheme = document.body.classList.contains('light-mode') ? 'light' : 'dark';
  localStorage.setItem('theme', newTheme);
}

function applyColourTheme(colour) {
  // Remove any existing theme-* class
  document.body.classList.forEach(c => {
    if (c.startsWith('theme-')) document.body.classList.remove(c);
  });
  // amber is the default (no class needed), others get theme-{colour}
  if (colour && colour !== 'amber') {
    document.body.classList.add('theme-' + colour);
  }
  // Highlight the active swatch
  document.querySelectorAll('.colour-swatch').forEach(btn => {
    const t = btn.getAttribute('data-theme');
    btn.style.border = t === colour ? '3px solid var(--text)' : '3px solid transparent';
  });
}

async function setColourTheme(colour) {
  applyColourTheme(colour);
  localStorage.setItem('colourTheme', colour);
  // Persist to profile
  try {
    await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ colour_theme: colour })
    });
    if (window._cachedProfile) window._cachedProfile.colour_theme = colour;
  } catch (e) { /* silent */ }
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
    window._cachedContacts = contacts;
    window._contactFilterType = 'all';

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('panel-network')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">&#8249;</button>
        <div style="font-size:16px;font-weight:700;color:var(--text);">My Network</div>
        <button onclick="openPanel('add-contact')" style="background:var(--accent);color:#000;border:none;border-radius:12px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">+ Add</button>
      </div>
      <div style="padding:0 16px 8px;">
        <input type="text" class="fi" placeholder="Search contacts..." id="contactSearch" oninput="filterContacts()" />
      </div>
      <div id="contactFilterBadges" style="display:flex;gap:6px;padding:0 16px 8px;overflow-x:auto;">
        <button class="filter-badge ac" onclick="filterContactsByType('all')">All</button>
        <button class="filter-badge" onclick="filterContactsByType('favourite')">Favourites</button>
        <button class="filter-badge" onclick="filterContactsByType('instrument')">By instrument</button>
      </div>
      <div id="contactsList" style="padding:0 16px;"></div>`;

    body.innerHTML = html;
    renderContactsList();
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
        <button onclick="closePanel('panel-repertoire')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
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

    const hasAnyActivity = (earnings.paid_total || 0) + (earnings.unpaid_total || 0)
      + (earnings.overdue_total || 0) + (earnings.expenses_total || 0) > 0;

    // Empty state: no paid/unpaid/overdue/expenses yet
    if (!hasAnyActivity) {
      body.innerHTML = `
        <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
          <button onclick="closePanel('finance-panel')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
          <div style="font-size:16px;font-weight:700;color:var(--text);">Earnings & Tax</div>
          <div style="width:32px;"></div>
        </div>
        <div style="padding:32px 24px;text-align:center;">
          <div style="font-size:48px;margin-bottom:12px;">💰</div>
          <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:8px;">No earnings yet</div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.5;margin-bottom:20px;">
            Add a gig with a fee, or log an expense, and you'll see your income, tax profile and monthly breakdown appear here.
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;max-width:240px;margin:0 auto;">
            <button onclick="closePanel('finance-panel'); openGigWizard();" class="pill-g">Log a gig</button>
            <button onclick="closePanel('finance-panel'); openPanel('panel-receipt'); setTimeout(()=>showReceiptForm('manual'),150); loadReceipts();" class="pill-o">Log an expense</button>
          </div>
        </div>`;
      return;
    }

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
        <button class="pill-g" onclick="exportGigsCSV()">Export gigs (CSV)</button>
        <button class="pill-g" onclick="exportExpensesCSV()">Export expenses (CSV)</button>
        <button class="pill-o" onclick="alert('PDF export coming soon. CSV is ready now.')">Export PDF</button>
        <button class="pill-o" onclick="alert('Receipts ZIP coming soon.')">Receipts ZIP</button>
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

function renderContactsList() {
  const container = document.getElementById('contactsList');
  if (!container) return;

  const searchQuery = (document.getElementById('contactSearch')?.value || '').toLowerCase().trim();
  let contacts = window._cachedContacts || [];
  const filterType = window._contactFilterType || 'all';

  // Text search across name and instruments
  if (searchQuery) {
    contacts = contacts.filter(c =>
      (c.name || '').toLowerCase().includes(searchQuery) ||
      (c.instruments || '').toLowerCase().includes(searchQuery)
    );
  }

  // Filter by type
  if (filterType === 'favourite') {
    contacts = contacts.filter(c => c.is_favourite);
  }

  if (contacts.length === 0) {
    const msg = filterType === 'favourite' ? 'No favourites yet. Tap the star on a contact to add them.'
      : searchQuery ? 'No contacts matching "' + escapeHtml(searchQuery) + '"'
      : 'No contacts yet. Tap + Add to get started.';
    container.innerHTML = `<div style="text-align:center;padding:30px 10px;color:var(--text-2);font-size:13px;">${msg}</div>`;
    return;
  }

  // Group by instrument if that filter is active
  if (filterType === 'instrument') {
    const groups = {};
    contacts.forEach(c => {
      const instr = (c.instruments || '').split(',').map(s => s.trim()).filter(Boolean);
      if (instr.length === 0) instr.push('No instrument listed');
      instr.forEach(inst => {
        if (!groups[inst]) groups[inst] = [];
        groups[inst].push(c);
      });
    });

    // Sort group names alphabetically, but put "No instrument listed" last
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === 'No instrument listed') return 1;
      if (b === 'No instrument listed') return -1;
      return a.localeCompare(b);
    });

    let html = '';
    sortedKeys.forEach(inst => {
      html += `<div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;padding:12px 0 6px;border-bottom:1px solid var(--border);">${escapeHtml(inst)} (${groups[inst].length})</div>`;
      groups[inst].forEach(contact => {
        html += renderContactRow(contact);
      });
    });
    container.innerHTML = html;
    return;
  }

  // Default: flat list sorted by name
  container.innerHTML = contacts.map(c => renderContactRow(c)).join('');
}

function renderContactRow(contact) {
  const initial = (contact.name || 'U')[0].toUpperCase();
  return `
    <div onclick="openContactDetail('${contact.id}')" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;">
      <div style="width:40px;height:40px;border-radius:20px;background:var(--accent-dim);border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--accent);flex-shrink:0;">${initial}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(contact.name)}</div>
        <div style="font-size:11px;color:var(--text-2);">${escapeHtml(contact.instruments || 'No instruments')}</div>
        <div style="font-size:10px;color:var(--text-3);">Last gig: ${contact.last_gig_date ? formatDateShort(contact.last_gig_date) : 'Never'}</div>
      </div>
      <span style="font-size:14px;cursor:pointer;" onclick="toggleFavourite('${contact.id}', event)">${contact.is_favourite ? '\u2B50' : '\u2606'}</span>
    </div>`;
}

function filterContacts() {
  renderContactsList();
}

function filterContactsByType(type) {
  window._contactFilterType = type;
  document.querySelectorAll('#contactFilterBadges .filter-badge').forEach(b => b.classList.remove('ac'));
  if (event && event.target) event.target.classList.add('ac');
  renderContactsList();
}

async function toggleFavourite(contactId, e) {
  e.stopPropagation();
  const contact = (window._cachedContacts || []).find(c => c.id === contactId);
  if (!contact) return;

  const newVal = !contact.is_favourite;
  try {
    const res = await fetch('/api/contacts/' + contactId + '/favourite', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_favourite: newVal })
    });
    if (res.ok) {
      contact.is_favourite = newVal;
      renderContactsList();
    }
  } catch (err) {
    console.error('Toggle favourite error:', err);
  }
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

async function acceptOffer(offerId) {
  try {
    const res = await fetch(`/api/offers/${offerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted' }),
    });
    if (!res.ok) throw new Error('Failed to accept');
    recordNudgeFeedback('offer', 'accepted', offerId);
    await refreshOffersAndBadge();
  } catch (err) {
    console.error('Accept offer error:', err);
    alert('Could not accept that offer, please try again');
  }
}

async function declineOffer(offerId) {
  if (!confirm('Decline this offer?')) return;
  try {
    const res = await fetch(`/api/offers/${offerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'declined' }),
    });
    if (!res.ok) throw new Error('Failed to decline');
    recordNudgeFeedback('offer', 'declined', offerId);
    await refreshOffersAndBadge();
  } catch (err) {
    console.error('Decline offer error:', err);
    alert('Could not decline that offer, please try again');
  }
}

async function snoozeOffer(offerId, hours) {
  // Snooze is a local-only UI defer; we stash a snooze_until in localStorage
  // and hide the offer from the list until that time passes. Server is untouched.
  const until = Date.now() + (hours * 3600 * 1000);
  const key = 'snoozedOffers';
  const store = JSON.parse(localStorage.getItem(key) || '{}');
  store[offerId] = until;
  localStorage.setItem(key, JSON.stringify(store));
  await refreshOffersAndBadge();
}

// Refresh offers, stats, and re-render offers screen if it's open.
async function refreshOffersAndBadge() {
  try {
    const [offersRes, statsRes] = await Promise.all([
      fetch('/api/offers'),
      fetch('/api/stats'),
    ]);
    if (offersRes.ok) {
      window._cachedOffers = await offersRes.json();
      window._cachedOffersTime = Date.now();
    }
    if (statsRes.ok) {
      window._cachedStats = await statsRes.json();
      window._cachedStatsTime = Date.now();
    }
    // Derive badge count directly from the offers list so it never drifts
    // from what the Offers screen actually shows.
    const pendingCount = (window._cachedOffers || []).filter(o => o.status === 'pending').length;
    updateOffersBadge(pendingCount);
    if (currentScreen === 'offers') {
      renderOffersScreen();
    }
  } catch (err) {
    console.error('refreshOffersAndBadge error:', err);
  }
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
    recordNudgeFeedback('calendar_import', 'imported', e.id);
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
    recordNudgeFeedback('calendar_import', 'imported', e.id);
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
    recordNudgeFeedback('calendar_import', 'dismissed', e.id);
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

function generateInvoiceNumber(prefix, nextNum, format) {
  prefix = prefix || 'INV';
  nextNum = nextNum || 1;
  format = format || 'plain';
  const num = String(nextNum).padStart(3, '0');
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  switch (format) {
    case 'year':        return prefix + '-' + y + '-' + num;
    case 'year-month':  return prefix + '-' + y + '-' + m + '-' + num;
    case 'year-short':  return prefix + '-' + String(y).slice(2) + m + '-' + num;
    default:            return prefix + '-' + num;
  }
}

function createInvoiceForGig(gigId) {
  // Close gig detail, open invoice panel, pre-select the gig and auto-fill
  closePanel('panel-gig-detail');
  openPanel('panel-invoice');
  initInvoicePanel();

  // Pre-select the gig in the dropdown and trigger auto-fill
  const select = document.getElementById('invLinkedGig');
  if (select && gigId) {
    select.value = gigId;
    onGigSelected();
  }
}

function initInvoicePanel() {
  // Populate gig dropdown from cached gigs
  populateGigDropdown();

  // Live preview updates
  const fields = ['invBillTo', 'invDesc', 'invAmount', 'invNotes', 'invInvoiceNumber'];
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateInvoicePreview);
  });

  // Gig selector auto-fill
  const gigSelect = document.getElementById('invLinkedGig');
  if (gigSelect) gigSelect.addEventListener('change', onGigSelected);

  // Auto-populate bank details and invoice number from profile
  const profile = window._cachedProfile || window._currentUser || {};
  if (profile.bank_details) {
    const notesEl = document.getElementById('invNotes');
    if (notesEl && !notesEl.value) notesEl.value = profile.bank_details;
  }
  // Generate next invoice number using format setting
  const prefix = profile.invoice_prefix || 'INV';
  const nextNum = profile.invoice_next_number || 1;
  const format = profile.invoice_format || 'plain';
  const invNum = generateInvoiceNumber(prefix, nextNum, format);
  const invNumEl = document.getElementById('invInvoiceNumber');
  if (invNumEl && !invNumEl.value) invNumEl.value = invNum;

  updateInvoicePreview();

  document.getElementById('sendInvoiceBtn').onclick = submitInvoice;
  document.getElementById('saveInvoiceDraft').onclick = () => saveInvoiceDraft();
}

function populateGigDropdown() {
  const select = document.getElementById('invLinkedGig');
  if (!select) return;
  select.innerHTML = '<option value="">Select a gig...</option>';
  const gigs = window._cachedGigs || [];
  // Sort by date descending so recent gigs are first
  const sorted = [...gigs].sort((a, b) => new Date(b.date) - new Date(a.date));
  sorted.forEach((g) => {
    const d = new Date(g.date);
    const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const label = [g.venue_name, g.band_name, dateStr].filter(Boolean).join(' / ');
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = label || dateStr;
    select.appendChild(opt);
  });
}

function onGigSelected() {
  const select = document.getElementById('invLinkedGig');
  const gigId = select ? select.value : '';
  if (!gigId) {
    // Cleared selection, reset venue preview
    const venueRow = document.getElementById('invPreviewVenueRow');
    if (venueRow) venueRow.style.display = 'none';
    document.getElementById('invPreviewGig').textContent = '--';
    return;
  }
  const gigs = window._cachedGigs || [];
  const gig = gigs.find((g) => g.id === gigId);
  if (!gig) return;

  // Auto-fill fields from the linked gig
  if (gig.band_name) {
    document.getElementById('invBillTo').value = gig.band_name;
  }
  if (gig.fee) {
    document.getElementById('invAmount').value = parseFloat(gig.fee).toFixed(2);
  }

  // Auto-generate description: "Performing [instrument] at [venue], [date]"
  const profile = window._cachedProfile || window._currentUser || {};
  const instrumentsStr = Array.isArray(profile.instruments) ? profile.instruments.join(', ') : (profile.instruments || '');
  const firstInstrument = instrumentsStr.split(',')[0]?.trim() || 'guitar';
  const d = new Date(gig.date);
  const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const venuePart = gig.venue_name || '';
  const descDefault = `Performing ${firstInstrument}${venuePart ? ' at ' + venuePart : ''}${gig.date ? ', ' + dateStr : ''}`;
  document.getElementById('invDesc').value = descDefault;

  // Update preview with gig info
  const gigLabel = [gig.venue_name, dateStr].filter(Boolean).join(' / ');
  document.getElementById('invPreviewGig').textContent = gigLabel;

  // Show venue in preview: name + address
  const venueRow = document.getElementById('invPreviewVenueRow');
  const venueEl = document.getElementById('invPreviewVenue');
  if ((gig.venue_name || gig.venue_address) && venueRow && venueEl) {
    const parts = [gig.venue_name, gig.venue_address].filter(Boolean);
    venueEl.textContent = parts.join(', ');
    venueRow.style.display = '';
  } else if (venueRow) {
    venueRow.style.display = 'none';
  }

  updateInvoicePreview();
}

function updateInvoicePreview() {
  const to = document.getElementById('invBillTo').value || '--';
  const desc = document.getElementById('invDesc').value || 'Performance fee';
  const amt = parseFloat(document.getElementById('invAmount').value) || 0;
  const fmt = '\u00A3' + amt.toFixed(2);

  document.getElementById('invPreviewTo').textContent = to;
  document.getElementById('invPreviewDesc').textContent = desc;
  document.getElementById('invPreviewAmt').textContent = fmt;
  document.getElementById('invPreviewTotal').textContent = fmt;

  const currentUser = window._currentUser;
  if (currentUser) {
    document.getElementById('invPreviewFrom').textContent =
      currentUser.name || currentUser.email;
  }

  // Update invoice number in preview
  const invNumInput = document.getElementById('invInvoiceNumber');
  const invNumPreview = document.getElementById('invPreviewNum');
  if (invNumInput && invNumPreview) {
    invNumPreview.textContent = (invNumInput.value || 'INV-001') + ' \u00B7 Draft';
  }

  // Update bank details in preview
  const bankNotes = document.getElementById('invNotes')?.value || '';
  const bankRow = document.getElementById('invPreviewBankRow');
  const bankEl = document.getElementById('invPreviewBank');
  if (bankNotes && bankRow && bankEl) {
    bankEl.textContent = bankNotes;
    bankRow.style.display = '';
  } else if (bankRow) {
    bankRow.style.display = 'none';
  }
}

async function submitInvoice() {
  const billTo = document.getElementById('invBillTo').value.trim();
  const amount = parseFloat(document.getElementById('invAmount').value);
  if (!billTo) { showToast('Enter a client name'); return; }
  if (!amount || amount <= 0) { showToast('Enter an amount'); return; }

  // Get linked gig details for venue address
  const gigId = document.getElementById('invLinkedGig').value || null;
  let venueName = null;
  let venueAddress = null;
  if (gigId) {
    const gigs = window._cachedGigs || [];
    const gig = gigs.find((g) => g.id === gigId);
    if (gig) {
      venueName = gig.venue_name || null;
      venueAddress = gig.venue_address || null;
    }
  }

  const invoiceNumber = document.getElementById('invInvoiceNumber')?.value?.trim() || null;

  try {
    const res = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        band_name: billTo,
        gig_id: gigId,
        description: document.getElementById('invDesc').value,
        amount,
        due_date: document.getElementById('invDueDate').value || null,
        notes: document.getElementById('invNotes').value,
        invoice_number: invoiceNumber,
        venue_name: venueName,
        venue_address: venueAddress,
        status: 'sent',
      }),
    });
    if (res.ok) {
      // Invalidate invoices cache so the list refreshes
      window._cachedInvoices = null;
      window._cachedInvoicesTime = 0;
      // Auto-increment the user's next invoice number
      const profile = window._cachedProfile || window._currentUser || {};
      const nextNum = (profile.invoice_next_number || 1) + 1;
      fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_next_number: nextNum }),
      }).then(() => {
        if (window._cachedProfile) window._cachedProfile.invoice_next_number = nextNum;
        if (window._currentUser) window._currentUser.invoice_next_number = nextNum;
      }).catch(() => {});
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

// ── CSV Export ───────────────────────────────────────────────────────────────
// Escapes a value for a CSV cell: wraps in quotes, doubles internal quotes, strips newlines
function _csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  if (s.includes(',') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function _downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(_csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportGigsCSV() {
  try {
    const res = await fetch('/api/gigs');
    if (!res.ok) throw new Error('Failed to fetch gigs');
    const gigs = await res.json();
    if (!gigs.length) { showToast('No gigs to export yet'); return; }

    const header = ['Date', 'Time', 'Venue', 'Address', 'Act', 'Gig type', 'Fee', 'Status', 'Paid', 'Invoiced', 'Notes'];
    const rows = [header];
    gigs.forEach(g => {
      rows.push([
        (g.date || '').slice(0, 10),
        g.start_time || '',
        g.venue_name || '',
        g.venue_address || '',
        g.act_name || '',
        g.gig_type || '',
        g.fee || '',
        g.status || '',
        g.status === 'paid' || g.invoice_status === 'paid' ? 'Yes' : 'No',
        g.invoice_id ? 'Yes' : 'No',
        g.notes || '',
      ]);
    });

    const today = new Date().toISOString().slice(0, 10);
    _downloadCSV(`trackmygigs-gigs-${today}.csv`, rows);
    showToast(`Exported ${gigs.length} gigs`);
  } catch (err) {
    console.error('Export gigs CSV error:', err);
    showToast('Failed to export gigs');
  }
}
window.exportGigsCSV = exportGigsCSV;

async function exportExpensesCSV() {
  try {
    const res = await fetch('/api/expenses');
    if (!res.ok) throw new Error('Failed to fetch expenses');
    const data = await res.json();
    const expenses = Array.isArray(data) ? data : (data.expenses || []);
    if (!expenses.length) { showToast('No expenses to export yet'); return; }

    const header = ['Date', 'Description', 'Category', 'Amount (GBP)'];
    const rows = [header];
    expenses.forEach(e => {
      rows.push([
        (e.date || '').slice(0, 10),
        e.description || '',
        e.category || '',
        parseFloat(e.amount || 0).toFixed(2),
      ]);
    });

    const today = new Date().toISOString().slice(0, 10);
    _downloadCSV(`trackmygigs-expenses-${today}.csv`, rows);
    showToast(`Exported ${expenses.length} expenses`);
  } catch (err) {
    console.error('Export expenses CSV error:', err);
    showToast('Failed to export expenses');
  }
}
window.exportExpensesCSV = exportExpensesCSV;

// ── ONBOARDING TOUR ─────────────────────────────────────────────────────────
// A simple first-run welcome shown once (gated by users.onboarded_at).
// Fires after prefetchAllData settles so we have the profile to check.

const ONBOARDING_STEPS = [
  {
    emoji: '🎵',
    title: 'Welcome to TrackMyGigs',
    body: "Your home for every gig, invoice, expense and mile. Let's take a 30-second tour.",
    cta: 'Start tour',
  },
  {
    emoji: '📋',
    title: 'Log a gig in 10 seconds',
    body: "Tap the big + button at the bottom to log a new gig. Just venue, date, and fee. Everything else can come later.",
    cta: 'Next',
  },
  {
    emoji: '💷',
    title: 'Get paid, stay sane',
    body: "Every gig can turn into an invoice with one tap. Overdue invoices show up on your home screen so nothing slips.",
    cta: 'Next',
  },
  {
    emoji: '📅',
    title: 'Share your availability',
    body: "Open Settings to grab your public share link. Anyone can see what dates you're free, with no login needed.",
    cta: 'Next',
  },
  {
    emoji: '✨',
    title: "You're ready",
    body: "Your first gig is the hardest. After that it gets addictive. Let's go.",
    cta: "Let's go",
  },
];

function maybeStartOnboarding() {
  try {
    // Skip if already done, or local flag set (avoids showing twice in same session)
    if (window._onboardingShown) return;
    const profile = window._cachedProfile || {};
    if (profile.onboarded_at) return;
    if (localStorage.getItem('tmg_onboarded') === '1') return;
    window._onboardingShown = true;
    showOnboardingStep(0);
  } catch (err) {
    console.error('Onboarding check failed:', err);
  }
}
window.maybeStartOnboarding = maybeStartOnboarding;

function showOnboardingStep(index) {
  const step = ONBOARDING_STEPS[index];
  if (!step) { finishOnboarding(); return; }

  let overlay = document.getElementById('onboardingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'onboardingOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(13,17,23,.88);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(overlay);
  }

  const total = ONBOARDING_STEPS.length;
  const pips = Array.from({ length: total }, (_, i) =>
    `<span style="width:6px;height:6px;border-radius:50%;background:${i === index ? 'var(--accent)' : 'var(--border)'};"></span>`
  ).join('');

  overlay.innerHTML = `
    <div style="max-width:360px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 24px;text-align:center;box-shadow:0 30px 60px rgba(0,0,0,.5);">
      <div style="font-size:52px;margin-bottom:12px;">${step.emoji}</div>
      <div style="font-size:20px;font-weight:700;color:var(--text);margin-bottom:10px;">${escapeHtml(step.title)}</div>
      <div style="font-size:14px;color:var(--text-2);line-height:1.5;margin-bottom:20px;">${escapeHtml(step.body)}</div>
      <div style="display:flex;justify-content:center;gap:6px;margin-bottom:20px;">${pips}</div>
      <button id="onbNext" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:10px;padding:12px;font-size:15px;font-weight:700;cursor:pointer;">${escapeHtml(step.cta)}</button>
      <button id="onbSkip" style="margin-top:10px;width:100%;background:transparent;color:var(--text-3);border:none;padding:8px;font-size:13px;cursor:pointer;">Skip tour</button>
    </div>`;

  const nextBtn = overlay.querySelector('#onbNext');
  const skipBtn = overlay.querySelector('#onbSkip');
  nextBtn.onclick = () => showOnboardingStep(index + 1);
  skipBtn.onclick = () => finishOnboarding();
}

async function finishOnboarding() {
  const overlay = document.getElementById('onboardingOverlay');
  if (overlay) overlay.remove();
  try {
    localStorage.setItem('tmg_onboarded', '1');
    await fetch('/api/user/onboarded', { method: 'POST' });
    if (window._cachedProfile) window._cachedProfile.onboarded_at = new Date().toISOString();
  } catch (err) {
    console.error('Mark onboarded failed (non-fatal):', err);
  }
}
window.finishOnboarding = finishOnboarding;

// ── NUDGE FEEDBACK CAPTURE ──────────────────────────────────────────────────
// Fire-and-forget POST so the server can learn which nudges users act on vs
// dismiss, letting us tune scoring. Action: 'accepted' | 'dismissed' | 'snoozed'.

function recordNudgeFeedback(nudgeType, action, gigId) {
  try {
    fetch('/api/nudge-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nudge_type: String(nudgeType || 'unknown'),
        action: String(action || 'unknown'),
        gig_id: gigId || null,
      }),
    }).catch(() => { /* non-fatal */ });
  } catch (_) { /* silent */ }
}
window.recordNudgeFeedback = recordNudgeFeedback;

// ── TRAVEL-TIME & PACK-DOWN AUTO-BLOCKS ─────────────────────────────────────
// Given the user's gigs, return pseudo-blocked windows representing drive time
// before + pack-down + drive time home after. Purely client-side visualisation
// — they display as "soft" entries on the calendar without touching blocked_dates.
// Defaults: 60min travel each way, 30min load-in, 30min pack-down.

function computeAutoBlocksForGigs(gigs) {
  if (!Array.isArray(gigs) || gigs.length === 0) return [];
  const TRAVEL_MIN = Number(localStorage.getItem('tmg_travel_mins')) || 60;
  const LOAD_MIN = Number(localStorage.getItem('tmg_load_mins')) || 30;
  const PACKDOWN_MIN = Number(localStorage.getItem('tmg_packdown_mins')) || 30;
  const out = [];
  for (const g of gigs) {
    if (!g.date || g.status === 'cancelled') continue;
    if (!g.start_time) continue;
    const startIso = `${String(g.date).slice(0, 10)}T${g.start_time.length === 5 ? g.start_time + ':00' : g.start_time}`;
    const start = new Date(startIso);
    if (isNaN(+start)) continue;
    const end = g.end_time
      ? new Date(`${String(g.date).slice(0, 10)}T${g.end_time.length === 5 ? g.end_time + ':00' : g.end_time}`)
      : new Date(start.getTime() + 3 * 3600000);
    const preStart = new Date(start.getTime() - (TRAVEL_MIN + LOAD_MIN) * 60000);
    const postEnd = new Date(end.getTime() + (TRAVEL_MIN + PACKDOWN_MIN) * 60000);
    out.push({
      gig_id: g.id,
      kind: 'travel_out',
      start: preStart.toISOString(),
      end: start.toISOString(),
      label: `Drive + load-in for ${g.venue_name || g.band_name || 'gig'}`,
    });
    out.push({
      gig_id: g.id,
      kind: 'travel_home',
      start: end.toISOString(),
      end: postEnd.toISOString(),
      label: `Pack-down + drive home from ${g.venue_name || g.band_name || 'gig'}`,
    });
  }
  return out;
}
window.computeAutoBlocksForGigs = computeAutoBlocksForGigs;

// Returns true if a candidate window (ISO strings) collides with any auto-block
// derived from the user's current gigs. Used by the availability calendar to
// warn when a potential new gig clashes with travel/pack-down of an existing one.
function isTimeAutoBlocked(startIso, endIso) {
  try {
    const gigs = window._cachedGigs || [];
    const blocks = computeAutoBlocksForGigs(gigs);
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    for (const b of blocks) {
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      if (s < be && e > bs) return b; // overlap — return offending block
    }
    return null;
  } catch (_) {
    return null;
  }
}
window.isTimeAutoBlocked = isTimeAutoBlocked;
