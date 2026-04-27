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

// Desktop scroll-anywhere: on viewports wider than the 390px app column,
// the gutters to the left and right of the centered content don't respond
// to mouse-wheel or trackpad scroll because body is overflow:hidden and the
// event target isn't inside .app-content / .panel-body. This listener
// forwards any wheel event that fires outside a natively-scrollable
// container to whichever scrollable region is currently on top (an open
// panel-body if there is one, otherwise the active .app-content). Does
// nothing on mobile because the gutters don't exist there, and lets the
// event pass through untouched whenever the user is already over a
// scrollable element so nested scroll still works as expected.
(function enableScrollAnywhere() {
  function findActiveScrollable() {
    // Prefer the topmost open panel. Stacked panels (e.g. profile over
    // edit-profile) both carry .open, and the later DOM node is visually on
    // top, so the last match wins.
    var openPanels = document.querySelectorAll('.panel-overlay.open');
    if (openPanels.length) {
      var top = openPanels[openPanels.length - 1];
      var body = top.querySelector('.panel-body');
      if (body) return body;
    }
    var screen = document.querySelector('.screen.active .app-content')
              || document.querySelector('.app-content');
    return screen || null;
  }
  window.addEventListener('wheel', function(ev) {
    // Ignore pinch-zoom gestures (trackpad sends wheel + ctrlKey).
    if (ev.ctrlKey) return;
    // Walk up from the target; if any ancestor is itself scrollable and
    // has overflowing content, let the browser handle it natively.
    var node = ev.target;
    while (node && node !== document.documentElement) {
      if (node.nodeType === 1 && node.scrollHeight > node.clientHeight) {
        var oy = getComputedStyle(node).overflowY;
        if (oy === 'auto' || oy === 'scroll') return;
      }
      node = node.parentNode;
    }
    var target = findActiveScrollable();
    if (!target) return;
    target.scrollTop += ev.deltaY;
    ev.preventDefault();
  }, { passive: false });
})();

// Run text scaling immediately so all screens (including auth) scale correctly
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { if (typeof setupTextScaling === 'function') setupTextScaling(); });
} else {
  // DOM already ready (e.g. script loaded at end of body)
  setTimeout(() => { if (typeof setupTextScaling === 'function') setupTextScaling(); }, 0);
}

// Keep --app-nav-h in sync with the actual rendered height of the bottom nav so
// the quick-action panels (.panel-keep-header) stop exactly above it. Using the
// measured value covers safe-area-inset-bottom differences on iOS home-indicator
// devices, text-scaling changes, and any future nav-row additions without the
// CSS having to track them.
function syncAppNavHeight() {
  var nav = document.querySelector('.app-nav');
  if (!nav) return;
  var h = nav.getBoundingClientRect().height;
  if (h > 0) document.documentElement.style.setProperty('--app-nav-h', h + 'px');
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncAppNavHeight);
} else {
  setTimeout(syncAppNavHeight, 0);
}
window.addEventListener('resize', syncAppNavHeight);

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
// Home stats can be up to 5min old before we show a skeleton instead of stale
// data. renderHomeScreen() uses stale-while-revalidate regardless — it always
// renders the cache first, then refetches silently in the background — so this
// TTL really only bounds how old we'll allow the very first paint to be.
const STATS_CACHE_TTL = 300000;
const PROFILE_CACHE_TTL = 60000;
const DATA_CACHE_TTL = 30000;

// Hydrate _cachedStats from localStorage on module load so the first open of the
// app after a cold boot paints real-looking data instantly instead of a skeleton.
// The background fetch in renderHomeScreen() then refreshes to live data.
// Keyed by user id so switching accounts never surfaces another user's stats.
try {
  const raw = localStorage.getItem('tmg_cachedStats_v1');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.stats && parsed.userId && parsed.time) {
      window._cachedStats = parsed.stats;
      window._cachedStatsTime = parsed.time;
      window._cachedStatsUser = parsed.userId;
    }
  }
} catch (_) { /* corrupt localStorage entry — ignore */ }

function persistCachedStats() {
  try {
    if (!window._cachedStats || !window._cachedStatsUser) return;
    localStorage.setItem('tmg_cachedStats_v1', JSON.stringify({
      stats: window._cachedStats,
      userId: window._cachedStatsUser,
      time: window._cachedStatsTime || Date.now(),
    }));
  } catch (_) { /* quota / privacy mode — ignore */ }
}

// Hydrate _cachedGigs and _cachedBlocked from localStorage at script parse
// time so the Calendar screen paints instantly on a cold open instead of
// running through the 3-5s skeleton + fetch path every time. Stale-while-
// revalidate refresh happens in renderCalendarScreen().
// Keyed by user id so switching accounts never leaks calendar data.
try {
  const raw = localStorage.getItem('tmg_cachedCalendar_v1');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.userId && parsed.time) {
      window._cachedGigs = parsed.gigs || null;
      window._cachedBlocked = parsed.blocked || null;
      window._cachedBlockedTime = parsed.time;
      window._cachedCalendarUser = parsed.userId;
    }
  }
} catch (_) { /* corrupt localStorage entry — ignore */ }

function persistCachedCalendar() {
  try {
    const userId = window._currentUser?.id || window._cachedCalendarUser || null;
    if (!userId) return;
    window._cachedCalendarUser = userId;
    // Only persist if we have at least one piece of data worth keeping
    if (!window._cachedGigs && !window._cachedBlocked) {
      localStorage.removeItem('tmg_cachedCalendar_v1');
      return;
    }
    localStorage.setItem('tmg_cachedCalendar_v1', JSON.stringify({
      gigs: window._cachedGigs || null,
      blocked: window._cachedBlocked || null,
      userId,
      time: window._cachedBlockedTime || Date.now(),
    }));
  } catch (_) { /* quota / privacy mode — ignore */ }
}

function initApp(user) {
  currentUser = user;
  window._currentUser = user;
  setupTextScaling();
  setupThemeToggle();
  setupNavigation();
  setupScreenHandlers();

  // Strip ?calendar_connected=true from the URL once we've landed, so a
  // refresh doesn't re-show any connected banner keyed off that param.
  // First-import modal hook (2026-04-23): if the URL flag is present and
  // this user has never bulk-imported, open the modal before we strip.
  const justConnected = (typeof URL !== 'undefined')
    && new URL(window.location.href).searchParams.get('calendar_connected') === 'true';
  if (typeof clearCalendarConnectedParam === 'function') {
    clearCalendarConnectedParam();
  }
  if (justConnected) {
    const firstDone = (function () {
      try { return localStorage.getItem('tmg_first_import_done') === '1'; }
      catch (_) { return false; }
    })();
    if (!firstDone && typeof openFirstImportModal === 'function') {
      // Small delay so the Calendar panel is ready under the modal.
      setTimeout(() => openFirstImportModal(), 600);
    }
  }

  // Stripe handshake (task #282):
  //   ?intent=premium&plan=<monthly|annual> — landing bounced the user here
  //     because they weren't signed in when they clicked Go Premium. Now that
  //     they're authed, fire checkout and forward them to Stripe.
  //   ?premium=success&session_id=... — Stripe checkout completed. Show a
  //     welcome toast; the webhook has already flipped the premium flag.
  //   ?premium=cancelled — user backed out of checkout. Quiet acknowledgement.
  // All three params are stripped from the address bar after handling so a
  // refresh doesn't re-trigger the flow.
  try {
    const url = new URL(window.location.href);
    const intent = url.searchParams.get('intent');
    const premiumStatus = url.searchParams.get('premium');
    const plan = url.searchParams.get('plan');
    let needsStrip = false;
    if (intent === 'premium' && (plan === 'monthly' || plan === 'annual')) {
      needsStrip = true;
      if (typeof startPremiumCheckout === 'function') {
        setTimeout(() => startPremiumCheckout(plan), 400);
      }
    }
    if (premiumStatus === 'success') {
      needsStrip = true;
      if (typeof toast === 'function') {
        setTimeout(() => toast('Welcome to premium. Your 14-day trial has started.'), 500);
      }
      // Invalidate caches so premium-gated UI re-reads the new flag.
      try { window._cachedProfile = null; } catch (_) {}
      try { window._cachedStats = null; window._cachedStatsTime = 0; } catch (_) {}
    } else if (premiumStatus === 'cancelled') {
      needsStrip = true;
      if (typeof toast === 'function') {
        setTimeout(() => toast('Checkout cancelled. No charge made.'), 300);
      }
    }
    if (needsStrip) {
      url.searchParams.delete('intent');
      url.searchParams.delete('plan');
      url.searchParams.delete('premium');
      url.searchParams.delete('session_id');
      const qs = url.searchParams.toString();
      history.replaceState(null, '', url.pathname + (qs ? `?${qs}` : '') + url.hash);
    }
  } catch (_) { /* never block boot on this */ }

  // Seed calendar connection state from the user record we already have,
  // so Profile and Calendar panels render correctly on first paint.
  if (user && typeof user === 'object') {
    if (user.calendar_connected !== undefined) {
      window._googleConnected = !!user.calendar_connected;
    }
    if (user.calendar_email) {
      window._googleCalendarEmail = user.calendar_email;
    }
  }

  // Update the fixed header with user info
  updateAppHeader();

  // Show home immediately (uses skeleton while data loads)
  showScreen('home');

  // Arm the 5-min calendar background poll + visibility listener. Idempotent.
  try { startCalendarPollingOnce(); } catch (_) { /* optional */ }

  // Prefetch ALL screen data in parallel so every tab opens instantly
  window._prefetchPromise = prefetchAllData();

  // S14-08: honour the `?shortcut=…` URL param that PWA launcher shortcuts set.
  // Wait a tick so the screen framework has mounted before opening a panel,
  // then clear the param from the address bar to keep copy-paste links clean.
  try {
    const params = new URLSearchParams(location.search);
    const shortcut = params.get('shortcut');
    if (shortcut) {
      setTimeout(() => {
        try {
          if (shortcut === 'new-gig' && typeof openGigWizard === 'function') {
            openGigWizard();
          } else if (shortcut === 'new-expense') {
            if (typeof openPanel === 'function') openPanel('panel-receipt');
            setTimeout(() => { if (typeof showReceiptForm === 'function') showReceiptForm('manual'); }, 150);
          } else if (shortcut === 'invoices' && typeof showScreen === 'function') {
            showScreen('invoices');
          } else if (shortcut === 'finance' && typeof openPanel === 'function') {
            openPanel('panel-finance');
          }
        } catch (_) { /* shortcut is a nice-to-have, never block boot */ }
        // Strip the param so refreshes don't re-trigger the shortcut
        params.delete('shortcut');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
      }, 250);
    }
  } catch (_) { /* ignore */ }
}

async function prefetchAllData() {
  // /api/stats is fetched by renderHomeScreen() already via fetchStatsWithCache
  // (which dedupes concurrent callers), so we just grab its promise here rather
  // than opening a second connection. The other fetches fire in parallel.
  const statsPromise = fetchStatsWithCache(false).catch((err) => {
    console.error('prefetch stats failed:', err);
    return null;
  });

  const [gigsRes, invoicesRes, offersRes, profileRes, blockedRes] = await Promise.allSettled([
    fetch('/api/gigs'),
    fetch('/api/invoices'),
    fetch('/api/offers'),
    fetch('/api/user/profile'),
    fetch('/api/blocked-dates'),
  ]);

  const now = Date.now();

  const stats = await statsPromise;
  if (stats && currentScreen === 'home') {
    const content = document.getElementById('homeScreen');
    if (content) buildHomeHTML(content, stats);
  }

  if (gigsRes.status === 'fulfilled' && gigsRes.value.ok) {
    window._cachedGigs = await gigsRes.value.json();
    persistCachedCalendar();
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
    // Seed calendar connection state so any screen that renders before
    // /api/calendar/status is probed has the right connect/disconnect UI.
    if (window._cachedProfile.google_access_token !== undefined) {
      window._googleConnected = !!window._cachedProfile.google_access_token;
    }
    if (window._cachedProfile.google_calendar_email) {
      window._googleCalendarEmail = window._cachedProfile.google_calendar_email;
    }
    // Sync colour theme from profile (server wins over localStorage)
    if (window._cachedProfile.colour_theme) {
      localStorage.setItem('colourTheme', window._cachedProfile.colour_theme);
      applyColourTheme(window._cachedProfile.colour_theme);
    }
  }

  if (blockedRes.status === 'fulfilled' && blockedRes.value.ok) {
    window._cachedBlocked = await blockedRes.value.json();
    window._cachedBlockedTime = now;
    persistCachedCalendar();
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
  // S11-08: Skeleton must mirror the real Home layout so the content doesn't
  // jump when stats resolve. Order here matches buildHomeHTML(): next-gig
  // card, alert tile row (3 tiles), messages preview, quick-stats row,
  // forecast chart. Heights and margins are set to match the real elements.
  const pulse = 'background:var(--card);border-radius:var(--r);animation:pulse 1.5s ease-in-out infinite;';
  const pulseSm = 'background:var(--card);border-radius:var(--rs);animation:pulse 1.5s ease-in-out infinite;';
  return `
    <style>@keyframes pulse{0%,100%{opacity:.4}50%{opacity:.8}}</style>
    <div style="margin:0 16px 8px;${pulse}height:88px;"></div>
    <div style="display:flex;gap:6px;margin:0 16px 6px;">
      <div style="flex:1;${pulseSm}height:54px;"></div>
      <div style="flex:1;${pulseSm}height:54px;"></div>
      <div style="flex:1;${pulseSm}height:54px;"></div>
    </div>
    <div style="margin:0 16px 8px;${pulseSm}height:56px;"></div>
    <div style="display:flex;gap:6px;margin:0 16px 8px;">
      <div style="flex:1;${pulseSm}height:64px;"></div>
      <div style="flex:1;${pulseSm}height:64px;"></div>
    </div>
    <div style="margin:0 16px 8px;${pulseSm}height:72px;"></div>`;
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
  // Close any open overlay panels before switching screens. The bottom-row
  // quick actions (Invoice, Block, Dep, Receipt) open .panel-keep-header
  // overlays that leave the nav visible and clickable. When the user taps a
  // main-nav item from inside one of those panels they expect to navigate
  // away; without this, the overlay stays on top of the new screen and the
  // nav appears broken.
  var openOverlays = document.querySelectorAll('.panel-overlay.open');
  openOverlays.forEach(function (p) {
    closePanel(p.id);
  });

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
    // Reset to today when navigating to calendar from elsewhere, so user
    // always lands on the current month (not a stale stored date).
    window._calDate = new Date();
    window._calViewMode = window._calViewMode || 'month';
    renderCalendarScreen();
  } else if (screenName === 'invoices') {
    renderInvoicesScreen();
  } else if (screenName === 'offers') {
    renderOffersScreen();
  } else if (screenName === 'profile') {
    renderProfileScreen();
  }
}

// S11-07: Stats cache must belong to a specific user so account switches
// (dev-login, log out / log back in) never render the previous user's data.
// _cachedStatsUser tracks who the cache belongs to and the cache is
// invalidated whenever it doesn't match the currently logged-in user id.
async function fetchStatsWithCache(forceRefresh) {
  const now = Date.now();
  const currentUserId = window._currentUser?.id || null;
  const cacheMatchesUser = window._cachedStatsUser && window._cachedStatsUser === currentUserId;
  if (!forceRefresh && cacheMatchesUser && window._cachedStats && (now - window._cachedStatsTime) < STATS_CACHE_TTL) {
    return window._cachedStats;
  }
  // Dedupe concurrent fetches: if we're already refetching, reuse the pending
  // promise instead of opening a second network request. This matters because
  // /api/stats runs 13 parallel DB queries and is expensive on Neon.
  if (window._inflightStatsPromise) {
    return window._inflightStatsPromise;
  }
  const p = fetch('/api/stats').then(async (res) => {
    if (!res.ok) throw new Error('Failed to fetch stats');
    const stats = await res.json();
    window._cachedStats = stats;
    window._cachedStatsTime = Date.now();
    window._cachedStatsUser = currentUserId;
    persistCachedStats();
    return stats;
  }).finally(() => {
    window._inflightStatsPromise = null;
  });
  window._inflightStatsPromise = p;
  return p;
}

async function renderHomeScreen() {
  const content = document.getElementById('homeScreen');
  const currentUserId = window._currentUser?.id || null;
  const cacheMatchesUser = window._cachedStatsUser && window._cachedStatsUser === currentUserId;

  // Stale-while-revalidate: if ANY cached stats exist for this user, paint
  // them immediately so the home page never shows a skeleton after the very
  // first load. If the cache is older than STATS_CACHE_TTL we still refetch
  // in the background and swap in the new data when it lands.
  if (cacheMatchesUser && window._cachedStats) {
    buildHomeHTML(content, window._cachedStats);
    const isStale = (Date.now() - window._cachedStatsTime) >= STATS_CACHE_TTL;
    if (isStale) {
      fetchStatsWithCache(true)
        .then((stats) => {
          // Only re-render if the user hasn't navigated away in the meantime
          if (currentScreen === 'home') buildHomeHTML(content, stats);
        })
        .catch((err) => console.error('Background stats refresh failed:', err));
    }
    return;
  }

  // No cache (first ever load, or freshly logged-in user) — show skeleton.
  content.innerHTML = buildSkeletonHTML();

  try {
    const stats = await fetchStatsWithCache(false);
    buildHomeHTML(content, stats);
  } catch (err) {
    console.error('Home screen error:', err);
    // S11-09: Give the user a way out. A retry button that re-fetches the
    // stats with the cache bypassed is far kinder than "Check your connection
    // and refresh" with no affordance.
    content.innerHTML = `
      <div style="padding:40px 20px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#9888;&#65039;</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px;">Couldn&#x2019;t load home</div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:16px;">Check your connection and try again.</div>
        <button onclick="retryHomeScreen()" style="background:var(--accent);color:#000;border:none;border-radius:20px;padding:10px 20px;font-size:13px;font-weight:700;cursor:pointer;">Try again</button>
      </div>`;
  }
}

// S11-09: Companion helper for the retry button. Clears stale cache and
// re-renders the home screen from scratch.
function retryHomeScreen() {
  window._cachedStats = null;
  window._cachedStatsTime = 0;
  window._cachedStatsUser = null;
  renderHomeScreen();
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

    // Active outgoing dep-request banner (purple)
    if (stats.active_dep_request) {
      const dep = stats.active_dep_request;
      const dateLabel = formatDateLong(dep.date);
      const hoursLeft = dep.hours_left;
      const timeLabel = hoursLeft > 48
        ? Math.ceil(hoursLeft / 24) + 'd left'
        : hoursLeft + 'h left';
      html += `
      <div onclick="showScreen('offers')" style="margin:0 16px 8px;background:linear-gradient(135deg,rgba(136,87,255,.12),rgba(136,87,255,.04));border:1px solid rgba(136,87,255,.3);border-radius:var(--r);padding:10px 14px;cursor:pointer;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-size:13px;">📤</span>
          <span style="font-size:11px;font-weight:700;color:#A78BFA;text-transform:uppercase;letter-spacing:.5px;">Active dep request</span>
          <span style="margin-left:auto;color:#A78BFA;font-size:16px;">›</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:3px;height:30px;border-radius:2px;background:#A78BFA;flex-shrink:0;"></div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(dep.band_name)}</div>
            <div style="font-size:10px;color:var(--text-2);margin-top:2px;">${dateLabel} · ${escapeHtml(dep.venue_name || '')} · <span style="color:var(--warning);font-weight:600;">awaiting cover</span></div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:11px;font-weight:700;color:#A78BFA;">⏳ ${timeLabel}</div>
          </div>
        </div>
      </div>`;
    }

    // Compact alert row
    html += `<div style="display:flex;gap:6px;margin:0 16px 6px;">`;

    if (stats.overdue_invoices > 0) {
      html += `
      <div onclick="goToInvoicesFiltered('overdue')" style="flex:1;background:var(--danger-dim);border:1px solid rgba(248,81,73,.2);border-radius:var(--rs);padding:8px 10px;cursor:pointer;">
        <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">📄 Invoice</div>
        <div style="font-size:11px;font-weight:600;color:var(--danger);">£${stats.overdue_total} overdue</div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px;">${stats.overdue_invoices} invoice${stats.overdue_invoices === 1 ? '' : 's'}</div>
      </div>`;
    }

    if (stats.draft_invoices > 0) {
      html += `
      <div onclick="goToInvoicesFiltered('draft')" style="flex:1;background:var(--info-dim);border:1px solid rgba(88,166,255,.2);border-radius:var(--rs);padding:8px 10px;cursor:pointer;">
        <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">📄 Invoice</div>
        <div style="font-size:11px;font-weight:600;color:var(--info);">£${stats.draft_total} draft</div>
        <div style="font-size:10px;color:var(--text-2);margin-top:2px;">${stats.draft_invoices} ready</div>
      </div>`;
    }

    html += `</div>`;

    // Imported gigs missing a fee (task #291). Persistent entry point for the
    // quick-fire wizard so a musician who skipped the first-import flow can
    // fill fees in later. Only renders when count > 0. The whole card opens
    // the wizard — no separate tap target for clarity.
    if (stats.gigs_missing_fee > 0) {
      const n = stats.gigs_missing_fee;
      html += `
      <div onclick="window.openFeeReviewWizard && window.openFeeReviewWizard()" style="margin:0 16px 6px;background:linear-gradient(135deg,rgba(240,165,0,.14),rgba(240,165,0,.04));border:1px solid rgba(240,165,0,.32);border-radius:var(--r);padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:12px;">
        <div style="font-size:18px;">&#x1F4B7;</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:700;color:var(--text);">${n} imported gig${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a fee</div>
          <div style="font-size:10px;color:var(--text-2);margin-top:1px;">Quick-fire ${n === 1 ? 'it' : 'them'} in for accurate tax reporting.</div>
        </div>
        <div style="font-size:11px;font-weight:700;color:var(--accent);flex-shrink:0;">Fill in &rsaquo;</div>
      </div>`;
    }

    // Next 7 days strip: 7 tap-able pills, one per day. Each pill is coloured
    // by state (blue = gig, red = blocked, white/empty = open). Whole strip
    // opens the Availability panel; individual pills jump to the day's detail
    // sheet so the user can block, unblock, or add a gig from there.
    // Data is hydrated asynchronously via hydrateNext7DaysStrip() after render.
    const todayDate = new Date();
    const next7Cells = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getDay()];
      next7Cells.push(`
        <div data-next7-iso="${iso}" onclick="event.stopPropagation(); if (typeof openDayActionSheet === 'function') openDayActionSheet('${iso}'); else { openPanel('panel-block'); }"
             style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 0;border-radius:8px;background:var(--card);border:1px solid var(--border);cursor:pointer;">
          <div style="font-size:9px;color:var(--text-3);font-weight:600;letter-spacing:.3px;">${dow}</div>
          <div data-next7-num style="font-size:13px;font-weight:700;color:var(--text);">${d.getDate()}</div>
        </div>`);
    }
    html += `
      <div onclick="openPanel('panel-block')" style="margin:0 16px 6px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;cursor:pointer;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:9px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;">📅 Next 7 days</div>
          <div style="font-size:10px;color:var(--accent);font-weight:600;">Availability ›</div>
        </div>
        <div id="next7DaysStrip" style="display:flex;gap:4px;">${next7Cells.join('')}</div>
      </div>`;

    // Gig messages card
    if (stats.unread_messages > 0) {
      html += `
      <div onclick="openPanel('panel-chat-inbox'); renderChatInbox();" style="margin:0 16px 6px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;cursor:pointer;">
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
    // #140: Both cards and the forecast below are teasers for the Finance
    // panel per mockup-v3. Each tap opens #panel-finance via openFinanceAt
    // and scrolls to its relevant section. This month → AI monthly insight
    // (only month-specific section). Tax year → Tax year overview row
    // (Income/Expenses/Taxable profit). Forecast → expanded Monthly
    // breakdown chart.
    // Quick-stat pills (mockup-v3): big white £ amount on top, period + gig
    // count joined by a middle dot underneath. Drops the uppercase label
    // banner that was eating the visual weight on the old design.
    const _monthEarnings = Math.round(stats.month_earnings || 0).toLocaleString('en-GB');
    const _yearEarnings = Math.round(stats.year_earnings || 0).toLocaleString('en-GB');
    const _monthGigs = stats.month_gigs || 0;
    const _yearGigs = stats.year_gigs || 0;
    html += `
    <div style="display:flex;gap:8px;margin:0 16px 8px;">
      <div onclick="window.openFinanceAt && window.openFinanceAt('month-insight')" style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;cursor:pointer;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:var(--text);line-height:1.1;">£${_monthEarnings}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px;">This month &middot; ${_monthGigs} gig${_monthGigs === 1 ? '' : 's'}</div>
      </div>
      <div onclick="window.openFinanceAt && window.openFinanceAt('tax-year')" style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;cursor:pointer;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:var(--text);line-height:1.1;">£${_yearEarnings}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px;">Tax year &middot; ${_yearGigs} gig${_yearGigs === 1 ? '' : 's'}</div>
      </div>
    </div>`;

    // 12-month forecast (mockup-v3 redesign 2026-04-26)
    // Confirmed earnings only — no pending, no projection, no guesses.
    // Tax-year window (April -> March) so the bar order matches the
    // musician's actual financial year. Tax year header on the right,
    // YTD total + best month in the footer. Past months are vivid green;
    // future months that already have confirmed bookings render the same
    // colour but at slightly reduced opacity to hint "still ahead" without
    // introducing a separate visual category.
    if (stats.monthly_breakdown && stats.monthly_breakdown.length) {
      const nowRef = new Date();
      // UK tax year: 6 April through 5 April. If we're between Jan 1 and
      // April 5 we're still in the tax year that began the previous April.
      const tyStartYear = nowRef.getMonth() < 3 || (nowRef.getMonth() === 3 && nowRef.getDate() < 6)
        ? nowRef.getFullYear() - 1
        : nowRef.getFullYear();
      const tyEndYear = tyStartYear + 1;
      const taxYearLabel = `${String(tyStartYear).slice(-2)}/${String(tyEndYear).slice(-2)}`;

      // Reorder the API's calendar-month breakdown into tax-year sequence.
      // Each tax year contains months April..March, so we walk a fixed
      // 12-step list and pick the matching breakdown row. Months outside
      // the API's window (i.e. far past or far future) fall through as £0
      // empty bars rather than being silently dropped.
      const monthIndex = new Map();
      stats.monthly_breakdown.forEach((m) => {
        const d = new Date(m.month_start);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        monthIndex.set(key, m);
      });
      const SHORT = ['J','F','M','A','M','J','J','A','S','O','N','D'];
      const months = [];
      for (let i = 0; i < 12; i++) {
        const monthIdx = (3 + i) % 12;            // 3=April, ... 2=March
        const year = monthIdx >= 3 ? tyStartYear : tyEndYear;
        const key = `${year}-${monthIdx}`;
        const row = monthIndex.get(key) || null;
        const monthDate = new Date(year, monthIdx, 1);
        const isFuture = monthDate.getTime() > new Date(nowRef.getFullYear(), nowRef.getMonth(), 1).getTime();
        months.push({
          letter: SHORT[monthIdx],
          full: monthDate.toLocaleString('en-GB', { month: 'short', year: 'numeric' }),
          confirmed: row ? parseFloat(row.confirmed_earnings || 0) : 0,
          isFuture,
        });
      }

      const maxConfirmed = Math.max(1, ...months.map((m) => m.confirmed));
      const ytdTotal = months.reduce((s, m) => s + m.confirmed, 0);

      // Best month so far: highest confirmed across the tax year. If two
      // months tie we prefer the most recent (later in array order).
      let best = null;
      months.forEach((m) => {
        if (m.confirmed > 0 && (!best || m.confirmed >= best.confirmed)) best = m;
      });
      const bestLine = best
        ? `Best: ${best.full.split(' ')[0]} &pound;${Math.round(best.confirmed).toLocaleString('en-GB')}`
        : '';
      const summary = ytdTotal > 0
        ? `&pound;${Math.round(ytdTotal).toLocaleString('en-GB')} confirmed YTD${bestLine ? ' &middot; ' + bestLine : ''}`
        : 'No confirmed earnings yet this tax year';

      html += `
      <div onclick="window.openFinanceAt && window.openFinanceAt('monthly')" style="margin:0 16px 6px;cursor:pointer;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:9px 12px 8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:11px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:5px;">
            <span style="font-size:11px;">📈</span>12-month forecast
          </div>
          <div style="font-size:9px;color:var(--text-3);">Tax year ${taxYearLabel}</div>
        </div>
        <div style="display:flex;align-items:flex-end;gap:4px;height:30px;margin-bottom:3px;">
          ${months.map((m) => {
            const heightPct = m.confirmed > 0 ? Math.max(10, (m.confirmed / maxConfirmed) * 100) : 5;
            const opacity = m.confirmed > 0 ? (m.isFuture ? 0.85 : 1) : 0.18;
            const bg = m.confirmed > 0 ? 'var(--success,#3FB950)' : 'var(--border)';
            const titleSuffix = m.confirmed > 0
              ? ': £' + Math.round(m.confirmed).toLocaleString('en-GB')
              : ': no confirmed earnings';
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;" title="${m.full}${titleSuffix}">
              <div style="width:100%;height:${heightPct}%;background:${bg};border-radius:4px;opacity:${opacity};"></div>
            </div>`;
          }).join('')}
        </div>
        <div style="display:flex;align-items:center;gap:4px;margin-bottom:5px;padding:0 1px;">
          ${months.map((m) => `<div style="flex:1;text-align:center;font-size:8px;color:var(--text-3);font-weight:600;">${m.letter}</div>`).join('')}
        </div>
        <div style="display:flex;align-items:center;gap:5px;font-size:9px;color:var(--text-2);padding-top:5px;border-top:1px solid var(--border);">
          <span style="width:7px;height:7px;background:var(--success,#3FB950);border-radius:2px;flex-shrink:0;"></span>
          <span>${summary}</span>
        </div>
      </div>`;
    }

    html += '</div>';
    content.innerHTML = html;

    // Colour the Next 7 days strip using cached gigs + a light blocked-dates
    // fetch. Strip still works if either source fails — cells just stay white.
    hydrateNext7DaysStrip();
}

async function hydrateNext7DaysStrip() {
  const strip = document.getElementById('next7DaysStrip');
  if (!strip) return;
  // Build the 7-day ISO set
  const today = new Date();
  const isos = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    isos.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  // Gigs: prefer cache, fall back to fetch.
  let gigs = Array.isArray(window._cachedGigs) ? window._cachedGigs : null;
  if (!gigs) {
    try {
      const r = await fetch('/api/gigs');
      if (r.ok) {
        const data = await r.json();
        gigs = Array.isArray(data) ? data : (data.gigs || []);
      }
    } catch {}
  }
  const gigSet = new Set((gigs || []).map(g => String(g.date || '').slice(0, 10)).filter(Boolean));

  // Blocked dates — fire-and-forget; if it fails, cells stay unblocked-visual.
  let blockedSet = new Set();
  try {
    const r = await fetch('/api/blocked-dates');
    if (r.ok) {
      const rows = await r.json();
      (Array.isArray(rows) ? rows : []).forEach(row => {
        const dates = Array.isArray(row.expanded_dates) && row.expanded_dates.length > 0
          ? row.expanded_dates
          : [(row.start_date || row.date || '').slice(0, 10)];
        dates.forEach(d => { if (d) blockedSet.add(d); });
      });
    }
  } catch {}

  // Paint each cell. Gigs take priority over blocks (a block should never be
  // created on a gig day anyway, but if it is, show the gig).
  isos.forEach(iso => {
    const cell = strip.querySelector(`[data-next7-iso="${iso}"]`);
    if (!cell) return;
    if (gigSet.has(iso)) {
      cell.style.background = 'var(--info-dim)';
      cell.style.border = '1px solid var(--info)';
      const num = cell.querySelector('[data-next7-num]');
      if (num) num.style.color = 'var(--info)';
    } else if (blockedSet.has(iso)) {
      cell.style.background = 'var(--danger)';
      cell.style.border = '1px solid var(--danger)';
      const num = cell.querySelector('[data-next7-num]');
      if (num) num.style.color = '#fff';
      const labels = cell.querySelectorAll('div');
      if (labels[0]) labels[0].style.color = 'rgba(255,255,255,.7)';
    }
  });
}
window.hydrateNext7DaysStrip = hydrateNext7DaysStrip;

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
    persistCachedCalendar();
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

async function pullGoogleCalendarChanges() {
  try {
    const resp = await fetch('/api/calendar/pull', { method: 'POST' });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.success && (data.updated > 0 || data.cancelled > 0)) {
      // Refresh cached gigs so inbound changes appear immediately
      if (typeof window.loadGigs === 'function') {
        window.loadGigs().catch(() => {});
      }
      // Invalidate the pins cache so the Calendar re-fetches with any updates
      window._googlePinsKey = null;
      if (typeof loadGoogleCalendarPins === 'function' && currentScreen === 'calendar') {
        loadGoogleCalendarPins().catch(() => {});
      }
    }
    window._lastCalendarPullAt = Date.now();
  } catch (_) {
    // Silent fail — inbound sync is best-effort
  }
}

// Throttled trigger: only fire the pull if we haven't fired in the last 2 min.
// Called from Calendar screen open + visibility change. Keeps pull cadence
// at ~every 2 min during active use without hammering Google's API.
function maybePullCalendarOnOpen() {
  const MIN_GAP_MS = 2 * 60 * 1000;
  const last = window._lastCalendarPullAt || 0;
  if (Date.now() - last < MIN_GAP_MS) return;
  pullGoogleCalendarChanges();
}

// 5-minute background poll while app is foregrounded. Rearms on visibility
// change so we don't burn cycles when the tab is hidden.
function startCalendarPollingOnce() {
  if (window._calendarPollTimer) return;
  const POLL_MS = 5 * 60 * 1000;
  window._calendarPollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    pullGoogleCalendarChanges();
  }, POLL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      maybePullCalendarOnOpen();
    }
  });
}

// Manual Sync Now: full two-way sync (pull + push-all) with toast feedback.
async function triggerSyncNow() {
  const toastify = (msg, isErr = false) => {
    try {
      if (typeof showToast === 'function') return showToast(msg, isErr ? 'error' : 'success');
    } catch (_) {}
    console.log(isErr ? '[sync]' : '[sync]', msg);
  };

  toastify('Syncing with Google Calendar…');
  try {
    const resp = await fetch('/api/calendar/sync-now', { method: 'POST' });
    const data = await resp.json();

    if (!resp.ok || data.ok === false) {
      if (data.needs_reauth) {
        toastify('Google Calendar needs re-connecting. Head to Settings to reconnect.', true);
      } else {
        toastify(data.message || 'Sync didn\u2019t work. Check your connection and try again.', true);
      }
      return data;
    }

    // Refresh local caches so pulled changes appear immediately
    window._cachedGigs = null;
    window._googlePinsKey = null;
    window._lastCalendarPullAt = Date.now();
    window._calendarLastSyncedAt = data.synced_at || new Date().toISOString();
    if (typeof window.loadGigs === 'function') window.loadGigs().catch(() => {});
    if (typeof loadGoogleCalendarPins === 'function' && currentScreen === 'calendar') {
      loadGoogleCalendarPins().catch(() => {});
    }
    if (currentScreen === 'calendar' && typeof renderCalendarScreen === 'function') {
      renderCalendarScreen();
    }

    const pulled = data.pulled || {};
    const pushed = data.pushed || {};
    const parts = [];
    if (pulled.updated) parts.push(`${pulled.updated} updated from Google`);
    if (pulled.cancelled) parts.push(`${pulled.cancelled} cancelled`);
    if (pushed.ok) parts.push(`${pushed.ok} pushed to Google`);
    if (pushed.failed) parts.push(`${pushed.failed} failed`);
    toastify(parts.length ? `Sync complete: ${parts.join(', ')}` : 'Sync complete: already up to date');

    // Update any visible last-synced indicator
    const el = document.getElementById('calendarLastSyncLabel');
    if (el) el.textContent = 'Just now';
    return data;
  } catch (err) {
    console.error('Sync-now failed:', err);
    toastify('Couldn\u2019t sync. Check your connection and try again.', true);
    return null;
  }
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Never';
  const diff = Math.max(0, Date.now() - d.getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Loads the AI-scored "likely gig" events and caches them as both an array
// and an id-keyed map. Also keeps the global _nudgeEvents in sync so the
// existing openNudgeDetail / quickImportNudge / dismissNudge helpers (which
// index into _nudgeEvents) work from any entry point. Uses a 60s cache so
// opening Gigs and Calendar back-to-back doesn't double-fetch.
async function loadCalendarNudges({ force = false } = {}) {
  const fresh = (Date.now() - (window._calendarNudgesFetchedAt || 0)) < 60 * 1000;
  if (!force && fresh && Array.isArray(window._calendarNudges)) {
    return window._calendarNudges;
  }
  try {
    const resp = await fetch('/api/calendar/events');
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.connected) {
      window._calendarNudges = [];
      window._calendarNudgesById = {};
      window._calendarNudgesFetchedAt = Date.now();
      return [];
    }
    const toReview = (data.events || []).filter(e => !e.already_imported);
    const byId = {};
    toReview.forEach(e => { if (e.id) byId[e.id] = e; });
    window._calendarNudges = toReview;
    window._calendarNudgesById = byId;
    window._calendarNudgesFetchedAt = Date.now();
    // Keep the legacy array in sync so index-based helpers still work.
    _nudgeEvents = toReview;
    return toReview;
  } catch (_) {
    return null;
  }
}

async function checkCalendarNudges() {
  // Fire inbound sync first so existing gigs reflect Google changes before we
  // compute nudges from the remaining "unknown" events.
  await pullGoogleCalendarChanges();

  const bar = document.getElementById('calendarNudgeBar');
  if (!bar) return;
  const toReview = await loadCalendarNudges({ force: true });
  if (!Array.isArray(toReview)) return;
  if (toReview.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'block';
  bar.innerHTML = renderImportsBarHtml(toReview);
}

// Companion to checkCalendarNudges for the Calendar screen's own banner.
// Paints an amber "X events look like gigs" card above the grid, re-renders
// the grid to colour likely-gig pin dots amber, and refreshes the pin list
// sections so cards show the "Gig? Tap to import" tag + actions.
async function loadCalendarScreenNudges() {
  const toReview = await loadCalendarNudges({ force: true });
  if (!Array.isArray(toReview)) return;
  paintCalendarScreenNudgeBanner(toReview);
  // Re-render the calendar view so pin cards + grid dots pick up nudge
  // enrichment. Only refresh if the user is still on the calendar screen.
  if (currentScreen === 'calendar') {
    const content = document.getElementById('calendarScreen');
    if (content && window._cachedGigs && window._cachedBlocked) {
      buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
    }
  }
}

function paintCalendarScreenNudgeBanner(toReview) {
  const bar = document.getElementById('calScreenNudgeBar');
  if (!bar) return;
  if (!Array.isArray(toReview) || toReview.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const count = toReview.length;
  const previewCount = Math.min(count, 3);
  const titles = toReview.slice(0, previewCount).map(e => {
    const t = (e.title || 'Calendar event');
    return t.length > 32 ? t.slice(0, 30).trim() + '…' : t;
  }).join(', ');
  const extra = count > previewCount ? ` and ${count - previewCount} more` : '';
  const headline = `${count} event${count !== 1 ? 's' : ''} look${count === 1 ? 's' : ''} like a gig`;
  bar.style.display = 'block';
  bar.innerHTML = `
    <div onclick="openGigNudge()" style="margin:0 16px 12px;padding:12px 14px;background:linear-gradient(135deg,rgba(240,165,0,.18),rgba(240,165,0,.06));border:1px solid rgba(240,165,0,.35);border-radius:12px;cursor:pointer;display:flex;align-items:center;gap:12px;">
      <div style="width:36px;height:36px;border-radius:10px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">&#x1F3B5;</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text);">${headline}</div>
        <div style="font-size:11px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(titles)}${extra}</div>
      </div>
      <div style="font-size:11px;font-weight:600;color:var(--accent);flex-shrink:0;">Review &rsaquo;</div>
    </div>
  `;
}

// Opens the nudge detail panel by Google-Calendar event id. Used by the
// "Gig? Tap to import" tag on pin cards in the Calendar screen. Falls back
// silently if the id isn't in the nudge set.
function openCalendarNudgeByEventId(eventId) {
  const nudges = Array.isArray(window._calendarNudges) ? window._calendarNudges : [];
  const idx = nudges.findIndex(e => e.id === eventId);
  if (idx < 0) return;
  // Ensure _nudgeEvents is in sync so the existing openNudgeDetail path works.
  _nudgeEvents = nudges;
  openNudgeDetail(idx);
}
window.openCalendarNudgeByEventId = openCalendarNudgeByEventId;

function quickImportNudgeByEventId(eventId) {
  const nudges = Array.isArray(window._calendarNudges) ? window._calendarNudges : [];
  const idx = nudges.findIndex(e => e.id === eventId);
  if (idx < 0) return;
  _nudgeEvents = nudges;
  quickImportNudge(idx).then(() => {
    // Drop from the cached nudges so the banner + pin tags refresh.
    if (window._calendarNudges) {
      window._calendarNudges = window._calendarNudges.filter(e => e.id !== eventId);
      if (window._calendarNudgesById) delete window._calendarNudgesById[eventId];
    }
    paintCalendarScreenNudgeBanner(window._calendarNudges || []);
    if (currentScreen === 'calendar') {
      // Also drop the matching pin so the imported event flips into the gigs list.
      if (Array.isArray(window._googlePins)) {
        window._googlePins = window._googlePins.filter(p => p.id !== eventId);
      }
      window._googlePinsKey = null;
      const content = document.getElementById('calendarScreen');
      if (content && window._cachedGigs && window._cachedBlocked) {
        buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
      }
      // Refresh gigs cache in the background so the newly-imported gig appears.
      fetch('/api/gigs').then(r => r.ok ? r.json() : null).then(g => {
        if (g) {
          window._cachedGigs = g;
          persistCachedCalendar();
          if (currentScreen === 'calendar' && content) {
            buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
          }
        }
      }).catch(() => {});
    }
  });
}
window.quickImportNudgeByEventId = quickImportNudgeByEventId;

function dismissNudgeByEventId(eventId) {
  const nudges = Array.isArray(window._calendarNudges) ? window._calendarNudges : [];
  const idx = nudges.findIndex(e => e.id === eventId);
  if (idx < 0) return;
  _nudgeEvents = nudges;
  dismissNudge(idx).then(() => {
    // Drop from nudge set so the tag disappears. Pin stays visible but loses
    // its amber "Gig?" treatment (it's just a regular calendar event now).
    if (window._calendarNudges) {
      window._calendarNudges = window._calendarNudges.filter(e => e.id !== eventId);
      if (window._calendarNudgesById) delete window._calendarNudgesById[eventId];
    }
    paintCalendarScreenNudgeBanner(window._calendarNudges || []);
    if (currentScreen === 'calendar') {
      const content = document.getElementById('calendarScreen');
      if (content && window._cachedGigs && window._cachedBlocked) {
        buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
      }
    }
  });
}
window.dismissNudgeByEventId = dismissNudgeByEventId;

// Renders a Google Calendar pin card used inside the Calendar screen's Month /
// Week / Day views. If the pin matches a current nudge (likely gig), the card
// picks up amber styling, a "Gig? Tap to import" tag, and inline Import / Skip
// buttons. Otherwise it falls back to the plain Google-blue treatment so non-
// gig events still render clearly.
//   mode: 'month' | 'week' | 'day' — controls the date column layout.
function renderGooglePinCard(p, { mode = 'month' } = {}) {
  const isNudge = !!(window._calendarNudgesById && window._calendarNudgesById[p.id]);
  const nudge = isNudge ? window._calendarNudgesById[p.id] : null;
  const d = new Date(p.date);
  const accent = isNudge ? 'var(--accent)' : '#4285F4';
  const bg = isNudge
    ? 'linear-gradient(135deg,rgba(240,165,0,.10),rgba(240,165,0,.02))'
    : 'var(--card)';
  const safeId = (p.id || '').replace(/'/g, "\\'");
  const cardClick = isNudge ? `onclick="openCalendarNudgeByEventId('${safeId}')"` : '';
  const cursor = isNudge ? 'cursor:pointer;' : '';

  let dateColHtml = '';
  if (mode === 'day') {
    dateColHtml = `
      <div style="min-width:44px;text-align:center;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${p.all_day ? 'All' : (p.start_time ? formatTime(p.start_time) : '')}</div>
        ${p.all_day ? '<div style="font-size:9px;color:var(--text-2);">DAY</div>' : ''}
      </div>`;
  } else if (mode === 'week') {
    dateColHtml = `
      <div style="min-width:36px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--text);">${d.getDate()}</div>
        <div style="font-size:9px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;">${d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()}</div>
      </div>`;
  } else {
    dateColHtml = `
      <div style="min-width:36px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--text);">${d.getDate()}</div>
        <div style="font-size:9px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;">${d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</div>
      </div>`;
  }

  const metaBits = [];
  if (mode === 'day') {
    if (p.location) metaBits.push(escapeHtml(p.location));
  } else {
    if (p.all_day) metaBits.push('All day');
    else if (p.start_time) metaBits.push(formatTime(p.start_time));
    if (p.location) metaBits.push(escapeHtml(p.location));
  }
  const metaHtml = metaBits.length ? `<div style="font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${metaBits.join(' \u00B7 ')}</div>` : '';

  const reasonTags = (isNudge && Array.isArray(nudge.reasons) && nudge.reasons.length)
    ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">
        ${nudge.reasons.slice(0, 3).map(r => `<span style="font-size:9px;font-weight:600;color:var(--accent);background:rgba(240,165,0,.12);border:1px solid rgba(240,165,0,.25);border-radius:6px;padding:2px 6px;">${escapeHtml(r)}</span>`).join('')}
       </div>`
    : '';

  const nudgeTag = isNudge
    ? `<div style="display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:10px;font-weight:700;color:var(--accent);background:rgba(240,165,0,.14);border:1px solid rgba(240,165,0,.3);border-radius:8px;padding:2px 8px;">&#x1F3B5; Gig? Tap to import</div>`
    : '';

  const actionButtons = isNudge
    ? `<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
        <button onclick="event.stopPropagation();quickImportNudgeByEventId('${safeId}')" title="Import as gig" style="width:32px;height:32px;border-radius:16px;background:var(--success);border:none;color:#000;font-size:14px;font-weight:700;cursor:pointer;">&#x2713;</button>
        <button onclick="event.stopPropagation();dismissNudgeByEventId('${safeId}')" title="Not a gig" style="width:32px;height:32px;border-radius:16px;background:var(--card);border:1px solid var(--border);color:var(--text-2);font-size:14px;cursor:pointer;">&#x2715;</button>
      </div>`
    : '';

  return `<div ${cardClick} style="display:flex;align-items:flex-start;gap:14px;padding:10px 12px;background:${bg};border:1px solid var(--border);border-left:3px solid ${accent};border-radius:var(--r);margin-bottom:6px;${cursor}">
    ${dateColHtml}
    <div style="flex:1;min-width:0;">
      <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.title || 'Calendar event')}</div>
      ${metaHtml}
      ${nudgeTag}
      ${reasonTags}
    </div>
    ${actionButtons}
  </div>`;
}

// Collapsible imports-to-review bar with inline items (matches mockup lines 396-417)
function renderImportsBarHtml(toReview) {
  const count = toReview.length;
  const expanded = !!window._importsBarExpanded;
  const itemsHtml = toReview.slice(0, 6).map((e, i) => {
    const raw = e.start_time || e.start || e.date || '';
    let dateLabel = '';
    try {
      if (raw) {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) {
          dateLabel = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        }
      }
    } catch (_) {}
    const title = (e.summary || e.title || 'Calendar event').replace(/"/g, '&quot;');
    const src = e.source_label || 'Calendar';
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</div>
          <div style="font-size:10px;color:var(--text-3);">${dateLabel ? dateLabel + ' · ' : ''}${src}</div>
        </div>
        <button onclick="event.stopPropagation();quickImportNudge(${i})" style="font-size:11px;font-weight:600;color:var(--success);background:none;border:1px solid rgba(63,185,80,.3);border-radius:10px;padding:3px 10px;cursor:pointer;">Gig</button>
        <button onclick="event.stopPropagation();dismissNudge(${i})" style="font-size:11px;color:var(--text-3);background:none;border:1px solid var(--border);border-radius:10px;padding:3px 8px;cursor:pointer;">Skip</button>
      </div>
    `;
  }).join('');
  const overflow = count > 6
    ? `<div style="padding-top:8px;text-align:center;"><button onclick="event.stopPropagation();openGigNudge()" style="background:none;border:none;color:var(--accent);font-size:11px;font-weight:600;cursor:pointer;">See all ${count} →</button></div>`
    : '';
  return `
    <div style="margin:8px 16px 0;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      <div style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div onclick="toggleImportsBar()" style="display:flex;align-items:center;gap:10px;cursor:pointer;flex:1;min-width:0;">
          <div style="min-width:22px;height:22px;padding:0 7px;border-radius:11px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#000;">${count}</div>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">Imports to review</div>
            <div style="font-size:10px;color:var(--text-3);">Tap to ${expanded ? 'collapse' : 'expand'} · found in your calendar</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <button onclick="event.stopPropagation();importAllNudges()" style="background:var(--accent);color:#000;border:none;border-radius:10px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">Import all</button>
          <div onclick="toggleImportsBar()" style="font-size:11px;color:var(--text-3);transform:rotate(${expanded ? '180' : '0'}deg);transition:transform .15s;cursor:pointer;padding:4px;">▾</div>
        </div>
      </div>
      ${expanded ? `<div style="border-top:1px solid var(--border);padding:4px 14px 12px;">${itemsHtml}${overflow}</div>` : ''}
    </div>
  `;
}

function toggleImportsBar() {
  window._importsBarExpanded = !window._importsBarExpanded;
  const bar = document.getElementById('calendarNudgeBar');
  if (bar && Array.isArray(window._calendarNudges)) {
    bar.innerHTML = renderImportsBarHtml(window._calendarNudges);
  }
}
window.toggleImportsBar = toggleImportsBar;

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
      <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">All gigs &middot; upcoming first</div>
    `;
  }

  // Sort filtered gigs
  if (gigViewMode === 'year') {
    // Yearly: date order starting from today.
    // Upcoming (today onwards) soonest-first, then past below (most recent first).
    const todayKey = (() => {
      const n = new Date();
      const y = n.getFullYear();
      const m = String(n.getMonth() + 1).padStart(2, '0');
      const d = String(n.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    })();
    viewFiltered.sort((a, b) => {
      const ad = (a.date || '').substring(0, 10);
      const bd = (b.date || '').substring(0, 10);
      const aFuture = ad >= todayKey;
      const bFuture = bd >= todayKey;
      if (aFuture !== bFuture) return aFuture ? -1 : 1; // upcoming block first
      if (aFuture) return ad.localeCompare(bd);         // upcoming: ascending
      return bd.localeCompare(ad);                      // past: descending
    });
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

  // Task #291: persistent "fill in fees" entry. Counted from the FULL gigs
  // argument (not viewFiltered) so the banner is consistent across Weekly /
  // Monthly / Yearly tabs — the work-to-do count isn't view-scoped.
  const missingFeeCount = (gigs || []).filter(g => {
    const src = g.source || '';
    const fee = g.fee;
    return src.startsWith('gcal:') && (fee == null || Number(fee) === 0);
  }).length;
  const missingFeeBanner = missingFeeCount > 0 ? `
    <div onclick="window.openFeeReviewWizard && window.openFeeReviewWizard()" style="margin:0 0 10px;padding:9px 12px;background:linear-gradient(135deg,rgba(240,165,0,.14),rgba(240,165,0,.04));border:1px solid rgba(240,165,0,.32);border-radius:12px;cursor:pointer;display:flex;align-items:center;gap:10px;">
      <div style="font-size:15px;">&#x1F4B7;</div>
      <div style="flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--text);">${missingFeeCount} imported gig${missingFeeCount === 1 ? '' : 's'} missing a fee</div>
      <div style="font-size:11px;font-weight:700;color:var(--accent);flex-shrink:0;">Fill in &rsaquo;</div>
    </div>` : '';

  listContent.innerHTML = missingFeeBanner + headerHtml + gigCardsHtml + deppedHtml;
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
  const currentUserId = window._currentUser?.id || null;
  const cacheMatchesUser = !window._cachedCalendarUser
    || !currentUserId
    || window._cachedCalendarUser === currentUserId;

  // Stale-while-revalidate: if we have BOTH cached gigs and blocked dates for
  // this user (in-memory or hydrated from localStorage), paint them
  // immediately. The Calendar used to show a 3-5s "Loading calendar..."
  // skeleton on every cold open because the in-memory cache started empty on
  // each page load. Now we paint from localStorage first, then refresh
  // silently in the background.
  // Requiring BOTH caches preserves the existing "set _cachedGigs = null after
  // an edit" pattern used throughout the app to force a full refetch.
  if (cacheMatchesUser && window._cachedGigs && window._cachedBlocked) {
    buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
    // Paint the nudge banner immediately from cached nudges if we have them,
    // so the amber bar doesn't flicker in after the grid renders.
    paintCalendarScreenNudgeBanner(window._calendarNudges || []);
    // Fire pin fetch even on the instant-paint path so Google Calendar pins
    // show up once the request lands.
    loadGoogleCalendarPins().catch(() => {});
    // Also fire an inbound pull so any changes made in Google Calendar since
    // the last sync flow into the app while the user is looking at the calendar.
    maybePullCalendarOnOpen();
    // Refresh nudges in the background; the loader repaints the banner and
    // re-renders the grid if anything changed.
    loadCalendarScreenNudges().catch(() => {});

    const isStale = (now - (window._cachedBlockedTime || 0)) >= DATA_CACHE_TTL;
    if (isStale) {
      refreshCalendarDataInBackground(content, currentUserId).catch((err) => {
        console.error('Background calendar refresh failed:', err);
      });
    }
    return;
  }

  // No cache at all (first ever load, freshly logged-in user, or cache
  // belonged to a different user) — show the skeleton while we fetch.
  content.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading calendar...</div>';

  try {
    // Wait for in-flight prefetch first instead of firing duplicate requests
    if (window._prefetchPromise && (!window._cachedGigs || !window._cachedBlocked)) {
      await window._prefetchPromise;
      if (window._cachedGigs || window._cachedBlocked) {
        window._cachedCalendarUser = currentUserId;
        persistCachedCalendar();
        buildCalendarView(content, window._cachedGigs || [], window._cachedBlocked || []);
        paintCalendarScreenNudgeBanner(window._calendarNudges || []);
        loadGoogleCalendarPins().catch(() => {});
        loadCalendarScreenNudges().catch(() => {});
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
    window._cachedCalendarUser = currentUserId;
    persistCachedCalendar();

    buildCalendarView(content, window._cachedGigs || [], window._cachedBlocked || []);
    paintCalendarScreenNudgeBanner(window._calendarNudges || []);
    // Fire-and-forget pin fetch; when it returns, re-render so pins show up.
    loadGoogleCalendarPins().catch(() => {});
    maybePullCalendarOnOpen();
    loadCalendarScreenNudges().catch(() => {});
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

// Companion to renderCalendarScreen's SWR path: refetch gigs and blocked
// dates in the background, then re-render only if the user is still on the
// calendar screen so we don't yank focus from another view.
async function refreshCalendarDataInBackground(content, userId) {
  if (window._inflightCalendarRefresh) return window._inflightCalendarRefresh;
  const p = (async () => {
    const [gigsRes, blockedRes] = await Promise.allSettled([
      fetch('/api/gigs'),
      fetch('/api/blocked-dates'),
    ]);
    let changed = false;
    if (gigsRes.status === 'fulfilled' && gigsRes.value.ok) {
      window._cachedGigs = await gigsRes.value.json();
      changed = true;
    }
    if (blockedRes.status === 'fulfilled' && blockedRes.value.ok) {
      window._cachedBlocked = await blockedRes.value.json();
      window._cachedBlockedTime = Date.now();
      changed = true;
    }
    if (changed) {
      window._cachedCalendarUser = userId;
      persistCachedCalendar();
      if (currentScreen === 'calendar') {
        buildCalendarView(content, window._cachedGigs || [], window._cachedBlocked || []);
        loadGoogleCalendarPins().catch(() => {});
      }
    }
  })().finally(() => {
    window._inflightCalendarRefresh = null;
  });
  window._inflightCalendarRefresh = p;
  return p;
}

async function loadGoogleCalendarPins() {
  const layers = getCalendarLayers();
  if (!layers.google) {
    window._googlePins = [];
    return;
  }
  try {
    const base = window._calDate || new Date();
    const year = base.getFullYear();
    const month = base.getMonth();
    // Fetch a buffer around the visible month (prev 14 days .. +60 days)
    const start = new Date(year, month, 1);
    start.setDate(start.getDate() - 14);
    const end = new Date(year, month + 1, 0);
    end.setDate(end.getDate() + 14);
    const toYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const cacheKey = `${toYMD(start)}_${toYMD(end)}`;
    if (window._googlePinsKey === cacheKey && window._googlePins && (Date.now() - (window._googlePinsTime || 0)) < 60000) {
      return;
    }

    const resp = await fetch(`/api/calendar/pins?start=${toYMD(start)}&end=${toYMD(end)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.connected) {
      window._googlePins = [];
      window._googleConnected = false;
      return;
    }
    window._googleConnected = true;
    window._googlePins = data.pins || [];
    window._googlePinsKey = cacheKey;
    window._googlePinsTime = Date.now();
    // Re-render with pins
    const content = document.getElementById('calendarScreen');
    if (content && window._cachedGigs && window._cachedBlocked) {
      buildCalendarView(content, window._cachedGigs, window._cachedBlocked);
    }
  } catch (e) {
    // silent fail
  }
}

function buildCalendarView(content, gigsData, blockedData) {
  const view = window._calViewMode || 'month';
  const currentDate = window._calDate || new Date();
  const layers = getCalendarLayers();

  const needsReconnect = !!window._googleNeedsReconnect;
  const reconnectReason = window._googleConnectionState === 'revoked'
    ? 'Access to your Google Calendar was revoked. Reconnect to resume syncing.'
    : 'Google Calendar sync has failed. Reconnect to resume syncing.';

  let html = `
    <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:24px;font-weight:700;color:var(--text);">Calendar</div>
      <div style="display:flex;gap:8px;">
        <button type="button" onclick="toggleCalendarLayers()" aria-label="Toggle layers" title="Layers" style="width:40px;height:40px;border-radius:20px;background:var(--card);border:1px solid var(--border);color:var(--text);display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;padding:0;">&#x2630;</button>
        <button type="button" onclick="toggleCalendarMenu()" aria-label="More actions" title="More" style="width:40px;height:40px;border-radius:20px;background:var(--card);border:1px solid var(--border);color:var(--text);display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;padding:0;">&#8943;</button>
      </div>
    </div>
    ${needsReconnect ? `
    <div style="margin:0 16px 8px;padding:12px 14px;background:#FFF4E5;border:1px solid #F5B949;border-radius:var(--r);display:flex;align-items:center;gap:10px;">
      <span style="font-size:18px;flex-shrink:0;">&#9888;</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#7A4A00;">Google Calendar needs to be reconnected</div>
        <div style="font-size:12px;color:#7A4A00;margin-top:2px;">${reconnectReason}</div>
      </div>
      <a href="/auth/google/calendar" style="background:#4285F4;color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;text-decoration:none;flex-shrink:0;">Reconnect</a>
    </div>` : ''}
    <div id="calendarLayers" style="display:none;margin:0 16px 8px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;">
      <div style="font-size:10px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Layers</div>
      ${[
        ['gigs', 'Gigs', 'var(--success)'],
        ['blocked', 'Blocked dates', 'var(--danger)'],
        ['travel', 'Travel', 'var(--accent)'],
        ['events', 'Other events', 'var(--info)'],
        ['google', 'Google Calendar', '#4285F4'],
      ].map(([id, label, color]) => `
        <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;">
          <input type="checkbox" ${layers[id] ? 'checked' : ''} onchange="toggleCalendarLayer('${id}', this.checked)" style="accent-color:${color};width:16px;height:16px;">
          <span style="width:10px;height:10px;border-radius:2px;background:${color};"></span>
          <span style="font-size:13px;color:var(--text);">${label}</span>
        </label>
      `).join('')}
      ${(() => {
        const prof = window._cachedProfile || {};
        const isConnected = window._googleConnected === true || !!prof.google_access_token;
        const isDisconnected = window._googleConnected === false || (window._googleConnected === undefined && !prof.google_access_token);
        const linkedEmail = window._googleCalendarEmail || prof.google_calendar_email || null;
        if (isConnected) {
          const lastSyncRaw = window._calendarLastSyncedAt || prof.google_last_pull_at || null;
          const lastSyncText = formatRelativeTime(lastSyncRaw);
          const selectedCal = window._googleSelectedCalendar || 'primary';
          return `
            <div style="margin-top:10px;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--text-2);display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Connected${linkedEmail ? ' as <span style="color:var(--text);font-weight:600;">' + linkedEmail + '</span>' : ''}</span>
              <button onclick="disconnectGoogleCalendar()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;color:var(--danger);font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;">Disconnect</button>
            </div>
            <div style="margin-top:6px;padding:6px 10px;font-size:11px;color:var(--text-2);display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Syncing calendar: <span id="calendarPickerLabel" style="color:var(--text);font-weight:600;">${selectedCal === 'primary' ? 'Primary' : selectedCal}</span></span>
              <button onclick="openCalendarPicker()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;color:var(--text);font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;">Change</button>
            </div>
            <div id="calendarPickerList" style="display:none;margin-top:6px;padding:6px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:12px;"></div>
            <div style="margin-top:6px;padding:6px 10px;font-size:11px;color:var(--text-2);display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span>Last synced: <span id="calendarLastSyncLabel" style="color:var(--text);">${lastSyncText}</span></span>
              <button onclick="triggerSyncNow()" style="background:var(--accent);border:none;border-radius:6px;padding:4px 10px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;">Sync now</button>
            </div>`;
        }
        if (isDisconnected) {
          return `
            <a href="/auth/google/calendar" style="display:block;margin-top:10px;padding:10px 12px;background:#4285F4;color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-align:center;text-decoration:none;">Connect Google Calendar</a>`;
        }
        return '';
      })()}
    </div>
    <div id="calendarMenu" style="display:none;margin:0 16px 8px;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:8px;z-index:10;">
      <div onclick="handleCalendarAction('add-gig')" style="padding:12px 14px;cursor:pointer;color:var(--text);font-size:14px;">Add gig</div>
      <div onclick="handleCalendarAction('add-event')" style="padding:12px 14px;cursor:pointer;color:var(--text);font-size:14px;border-top:1px solid var(--border);">Add event</div>
      <div onclick="handleCalendarAction('block-dates')" style="padding:12px 14px;cursor:pointer;color:var(--text);font-size:14px;border-top:1px solid var(--border);">Availability</div>
      ${(window._googleConnected === true || (window._cachedProfile && !!window._cachedProfile.google_access_token)) ? `
        <div onclick="triggerSyncNow();toggleCalendarMenu();" style="padding:12px 14px;cursor:pointer;color:var(--text);font-size:14px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;">
          <span>&#x21BB;</span><span>Sync now</span>
        </div>
        <div onclick="disconnectGoogleCalendar()" style="padding:12px 14px;cursor:pointer;color:var(--danger);font-size:14px;border-top:1px solid var(--border);">Disconnect Google Calendar</div>
      ` : ''}
    </div>
    <div style="display:flex;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;gap:8px;">
      <div class="tb ${view === 'day' ? 'ac' : ''}" onclick="switchCalendarView('day')">Day</div>
      <div class="tb ${view === 'week' ? 'ac' : ''}" onclick="switchCalendarView('week')">Week</div>
      <div class="tb ${view === 'month' ? 'ac' : ''}" onclick="switchCalendarView('month')">Month</div>
    </div>`;

  const googlePins = (layers.google && Array.isArray(window._googlePins)) ? window._googlePins : [];
  if (view === 'month') {
    html += renderCalendarMonth(currentDate, gigsData, blockedData, googlePins);
  } else if (view === 'week') {
    html += renderCalendarWeek(currentDate, gigsData, blockedData, googlePins);
  } else if (view === 'day') {
    html += renderCalendarDay(currentDate, gigsData, blockedData, googlePins);
  }

  // Nudge bar moved to BELOW the grid so async inflation (when Google pins
  // arrive and paintCalendarScreenNudgeBanner populates it) doesn't push the
  // calendar grid down. The grid's top position is now stable across repaints
  // regardless of whether nudges are empty or populated. Gareth was seeing
  // "the whole calendar underneath the day/week/month bar shifts down" on
  // every view because the bar used to sit between the toolbar and the grid.
  html += `<div id="calScreenNudgeBar" style="margin-top:12px;"></div>`;

  content.innerHTML = html;
}

function toggleCalendarMenu() {
  const menu = document.getElementById('calendarMenu');
  if (menu) {
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    menu.style.flexDirection = 'column';
  }
}

function getCalendarLayers() {
  try {
    const saved = JSON.parse(localStorage.getItem('calendarLayers') || '{}');
    return {
      gigs: saved.gigs !== false,
      blocked: saved.blocked !== false,
      travel: saved.travel !== false,
      events: saved.events !== false,
      google: saved.google === true,
    };
  } catch (e) {
    return { gigs: true, blocked: true, travel: true, events: true, google: false };
  }
}

function toggleCalendarLayers() {
  const el = document.getElementById('calendarLayers');
  const opened = el && el.style.display === 'none';
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
  // When opening the panel, probe status so Connect/Disconnect state and
  // the "Last synced" stamp reflect reality. Cheap JSON fetch; skip if we
  // already probed in the last 30s.
  if (opened) {
    const last = window._calendarStatusProbedAt || 0;
    if (Date.now() - last < 30 * 1000 && window._googleConnected !== undefined) {
      // Still refresh the label text in place using cached timestamp
      const lbl = document.getElementById('calendarLastSyncLabel');
      if (lbl) lbl.textContent = formatRelativeTime(window._calendarLastSyncedAt || null);
      return;
    }
    fetch('/api/calendar/status')
      .then(r => r.ok ? r.json() : { connected: false })
      .then(d => {
        const was = window._googleConnected;
        const wasNeedsReconnect = !!window._googleNeedsReconnect;
        window._googleConnected = !!d.connected;
        window._googleCalendarEmail = d.calendar_email || null;
        window._calendarLastSyncedAt = d.last_synced_at || null;
        window._googleNeedsReconnect = !!d.needs_reconnect;
        window._googleConnectionState = d.connection_state || null;
        window._googleSelectedCalendar = d.selected_calendar || 'primary';
        window._calendarStatusProbedAt = Date.now();
        if (was !== window._googleConnected || wasNeedsReconnect !== window._googleNeedsReconnect) {
          renderCalendarScreen();
        } else {
          const lbl = document.getElementById('calendarLastSyncLabel');
          if (lbl) lbl.textContent = formatRelativeTime(window._calendarLastSyncedAt);
        }
      })
      .catch(() => { window._googleConnected = false; });
  }
}

// Disconnect the linked Google Calendar. Confirms, hits the API, refreshes
// state, and re-renders anything that shows connection status.
// Open the inline calendar picker inside the Layers panel. Lazily fetches the
// user's list of owned/writable calendars the first time it's opened, then
// caches. Each row is a radio button that fires selectCalendar() on change.
async function openCalendarPicker() {
  const el = document.getElementById('calendarPickerList');
  if (!el) return;
  if (el.style.display === 'block') {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = '<div style="padding:8px;color:var(--text-2);font-size:12px;">Loading calendars&hellip;</div>';
  try {
    const resp = await fetch('/api/calendar/list-calendars');
    if (!resp.ok) throw new Error('list failed');
    const data = await resp.json();
    if (!data.connected || !Array.isArray(data.calendars) || !data.calendars.length) {
      el.innerHTML = '<div style="padding:8px;color:var(--text-2);font-size:12px;">No calendars available.</div>';
      return;
    }
    const selected = data.selected_id || 'primary';
    const rows = data.calendars.map(c => {
      const id = c.primary ? 'primary' : c.id;
      const label = c.primary ? `${c.summary || 'Primary'} (Primary)` : (c.summary || c.id);
      const checked = id === selected ? 'checked' : '';
      const safeId = (id || '').replace(/"/g, '&quot;');
      const safeLabel = label.replace(/</g, '&lt;');
      return `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;font-size:12px;color:var(--text);">
          <input type="radio" name="tmg-calendar-picker" value="${safeId}" ${checked} onchange="selectCalendar(this.value)" style="accent-color:var(--accent);">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeLabel}</span>
        </label>`;
    }).join('');
    const rescope = data.needs_rescope
      ? `<div style="padding:8px 10px;margin-top:6px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);border-radius:8px;font-size:11px;line-height:1.4;color:var(--text-2);">
          To pick a different calendar, reconnect Google Calendar so TrackMyGigs can see your full list. Disconnect and reconnect from the Profile screen.
        </div>`
      : '';
    el.innerHTML = rows + rescope;
  } catch (e) {
    el.innerHTML = '<div style="padding:8px;color:var(--danger);font-size:12px;">Failed to load calendars. Try again.</div>';
  }
}

// Persist the new calendar selection server-side and refresh the Calendar
// screen so pins and layers re-query against the right calendar. Also nukes
// any in-memory google pin cache because the old cache is for a different id.
async function selectCalendar(calendarId) {
  if (!calendarId) return;
  try {
    const resp = await fetch('/api/calendar/select-calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendar_id: calendarId }),
    });
    if (!resp.ok) {
      alert('Could not switch calendar. Please try again.');
      return;
    }
    window._googleSelectedCalendar = calendarId;
    window._googlePins = [];
    window._googlePinsKey = null;
    window._calendarStatusProbedAt = 0; // force re-probe next open
    const lbl = document.getElementById('calendarPickerLabel');
    if (lbl) lbl.textContent = calendarId === 'primary' ? 'Primary' : calendarId;
    renderCalendarScreen();
  } catch (e) {
    alert('Could not switch calendar. Please try again.');
  }
}

async function disconnectGoogleCalendar() {
  const who = window._googleCalendarEmail ? ` (${window._googleCalendarEmail})` : '';
  if (!confirm(`Disconnect your Google Calendar${who}? You can reconnect anytime.`)) return;
  try {
    const resp = await fetch('/api/calendar/disconnect', { method: 'POST' });
    if (!resp.ok) {
      alert('Disconnect failed. Please try again.');
      return;
    }
    // Clear window-level flags
    window._googleConnected = false;
    window._googleCalendarEmail = null;
    window._googlePins = [];
    window._googlePinsKey = null;
    window._googleNeedsReconnect = false;
    window._googleConnectionState = null;
    window._googleSelectedCalendar = 'primary';
    // Update the cached profile in place so the next renderProfileScreen()
    // (which is cache-first) shows the disconnected state instead of stale
    // token data. Also invalidate the cache timestamp so a subsequent
    // refresh refetches from the server.
    if (window._cachedProfile) {
      window._cachedProfile.google_access_token = null;
      window._cachedProfile.google_refresh_token = null;
      window._cachedProfile.google_token_expires_at = null;
      window._cachedProfile.google_calendar_email = null;
      window._cachedProfile.calendar_connected = false;
      window._cachedProfile.calendar_email = null;
    }
    window._cachedProfileTime = 0;
    // Re-render the profile panel body directly if it's open, bypassing
    // renderProfileScreen's cache-first short-circuit.
    const profileBody = document.getElementById('profilePanelBody');
    if (profileBody && typeof buildProfileHTML === 'function' && window._cachedProfile) {
      try { buildProfileHTML(profileBody, window._cachedProfile); } catch (e) { console.warn('profile re-render failed', e); }
    }
    const profileScreen = document.getElementById('profileScreen');
    if (profileScreen && typeof buildProfileHTML === 'function' && window._cachedProfile) {
      try { buildProfileHTML(profileScreen, window._cachedProfile); } catch (e) { /* ignore */ }
    }
    // Re-render the calendar screen too in case the ... menu / layers are open.
    const calScreen = document.getElementById('calendarScreen');
    if (calScreen && window._cachedGigs && window._cachedBlocked) {
      try { buildCalendarView(calScreen, window._cachedGigs, window._cachedBlocked); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    alert('Disconnect failed: ' + (e.message || e));
  }
}

// If we came back from OAuth with ?calendar_connected=true in the URL,
// strip it once the app has loaded so refreshes don't re-show any banner
// keyed off that param.
function clearCalendarConnectedParam() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('calendar_connected')) {
      url.searchParams.delete('calendar_connected');
      window.history.replaceState({}, '', url.toString());
    }
  } catch (e) { /* ignore */ }
}

function toggleCalendarLayer(id, checked) {
  const layers = getCalendarLayers();
  layers[id] = !!checked;
  localStorage.setItem('calendarLayers', JSON.stringify(layers));
  // Force refresh of pins when Google layer flips on
  if (id === 'google' && checked) {
    window._googlePinsKey = null;
  }
  renderCalendarScreen();
}

function handleCalendarAction(action) {
  if (action === 'add-gig') {
    openGigWizard();
  } else if (action === 'add-event') {
    // TODO: implement add-event panel
  } else if (action === 'block-dates') {
    openPanel('panel-block');
  }
  toggleCalendarMenu();
}

function switchCalendarView(view) {
  window._calViewMode = view;
  renderCalendarScreen();
}

function renderCalendarMonth(currentDate, gigs, blocked, googlePins = []) {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  // JS getDay(): 0=Sun..6=Sat. We render Mon-first, so shift: Mon=0..Sun=6.
  const firstDayRaw = new Date(year, month, 1).getDay();
  const firstDay = (firstDayRaw + 6) % 7; // 0 empty cells if month starts on Mon, 6 if Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
  const layers = getCalendarLayers();

  // Helper: format HH:MM(:SS) into a compact time label like "8pm" or "9:30am"
  // matching Google Calendar's Month-cell convention. Saves horizontal pixels.
  const fmtCompactTime = (t) => {
    if (!t) return '';
    const [hStr, mStr] = String(t).split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr || '0', 10);
    if (isNaN(h)) return '';
    const ampm = h >= 12 ? 'pm' : 'am';
    const hr12 = ((h + 11) % 12) + 1;
    return m > 0 ? `${hr12}:${String(m).padStart(2, '0')}${ampm}` : `${hr12}${ampm}`;
  };

  let html = `<div style="padding:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <button onclick="prevCalendarMonth()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">&#8249;</button>
      <div style="font-size:16px;font-weight:600;color:var(--text);">${new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</div>
      <button onclick="nextCalendarMonth()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">&#8250;</button>
    </div>
    <button onclick="goCalendarToday()" style="width:100%;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);color:var(--accent);border-radius:6px;padding:8px;font-size:12px;font-weight:600;margin-bottom:12px;cursor:pointer;">Today</button>
    <div class="cg">
      <div class="cdh">Mo</div><div class="cdh">Tu</div><div class="cdh">We</div><div class="cdh">Th</div><div class="cdh">Fr</div><div class="cdh">Sa</div><div class="cdh">Su</div>`;

  // Empty cells (firstDay is now 0..6 Monday-first)
  for (let i = 0; i < firstDay; i++) {
    html += `<div class="cd cd-month empty"></div>`;
  }

  // Days. #135: replaced colored-dot markers with Google-style event pills.
  // Each cell shows up to 2 event pills with "TIME Title" (or just "Title"
  // for all-day items), then a "+N" overflow link if more events exist that
  // day. Pills clip with ellipsis so narrow mobile cells stay readable.
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isToday = isCurrentMonth && day === today.getDate();

    const gigsOnDay = (layers.gigs ? gigs : []).filter(g => (g.date || '').slice(0, 10) === dateStr);
    const blockedOnDay = (layers.blocked ? blocked : []).filter(b => {
      const bs = (b.start_date || '').slice(0, 10);
      const be = (b.end_date || bs).slice(0, 10);
      return dateStr >= bs && dateStr <= be;
    });
    const pinsOnDay = (layers.google ? googlePins : []).filter(p => (p.date || '').slice(0, 10) === dateStr);

    // Build a unified event list for this cell, all-day first then timed by start_time.
    // Each item: { kind, label, time, color, bg, border, isAllDay }
    const items = [];
    blockedOnDay.forEach(b => {
      items.push({
        kind: 'blocked',
        label: b.reason || 'Unavailable',
        time: '',
        color: '#fff',
        bg: 'var(--danger)',
        border: 'var(--danger)',
        isAllDay: true,
      });
    });
    gigsOnDay.forEach(g => {
      const isAllDay = !g.start_time;
      items.push({
        kind: 'gig',
        label: g.band_name || g.venue_name || 'Gig',
        time: isAllDay ? '' : fmtCompactTime(g.start_time),
        sortKey: isAllDay ? -1 : (parseInt(String(g.start_time).split(':')[0], 10) * 60 + (parseInt(String(g.start_time).split(':')[1] || '0', 10))),
        color: isAllDay ? '#000' : 'var(--text)',
        bg: isAllDay ? 'var(--accent)' : 'transparent',
        border: 'var(--accent)',
        dot: 'var(--accent)',
        isAllDay,
      });
    });
    pinsOnDay.forEach(p => {
      const isNudge = !!(window._calendarNudgesById && window._calendarNudgesById[p.id]);
      const isAllDay = p.all_day || !p.start_time;
      const hue = isNudge ? 'var(--accent)' : '#4285F4';
      items.push({
        kind: 'pin',
        label: p.summary || 'Busy',
        time: isAllDay ? '' : fmtCompactTime(p.start_time),
        sortKey: isAllDay ? -1 : (parseInt(String(p.start_time).split(':')[0], 10) * 60 + (parseInt(String(p.start_time).split(':')[1] || '0', 10))),
        color: isAllDay ? '#fff' : 'var(--text)',
        bg: isAllDay ? hue : 'transparent',
        border: hue,
        dot: hue,
        isAllDay,
      });
    });

    // Sort: all-day items first, then timed events by start time
    items.sort((a, b) => {
      if (a.isAllDay && !b.isAllDay) return -1;
      if (!a.isAllDay && b.isAllDay) return 1;
      return (a.sortKey || 0) - (b.sortKey || 0);
    });

    const visibleCount = 2;
    const visible = items.slice(0, visibleCount);
    const overflow = items.length - visible.length;

    let pillsHtml = '';
    visible.forEach(it => {
      if (it.isAllDay) {
        // Solid colored bar (Google bank-holiday style)
        pillsHtml += `<div class="cd-pill cd-pill-allday" style="background:${it.bg};color:${it.color};" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>`;
      } else {
        // Compact "8pm Title" with leading dot
        const timeBit = it.time ? `<span style="font-weight:700;margin-right:3px;">${escapeHtml(it.time)}</span>` : '';
        pillsHtml += `<div class="cd-pill cd-pill-timed" style="color:${it.color};" title="${escapeHtml(it.time ? it.time + ' ' + it.label : it.label)}">
          <span class="cd-pill-dot" style="background:${it.dot};"></span>${timeBit}<span class="cd-pill-text">${escapeHtml(it.label)}</span>
        </div>`;
      }
    });
    if (overflow > 0) {
      pillsHtml += `<div class="cd-pill cd-pill-more">+${overflow} more</div>`;
    }

    html += `<div class="cd cd-month ${isToday ? 'today' : ''}" onclick="selectCalendarDate('${dateStr}')">
      <div class="cd-num">${day}</div>
      ${pillsHtml ? `<div class="cd-events">${pillsHtml}</div>` : ''}
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

  // List Google Calendar pins this month. Pins that match a current nudge get
  // the amber "Gig? Tap to import" treatment via renderGooglePinCard.
  const monthPins = googlePins.filter(p => (p.date || '').slice(0, 7) === `${year}-${String(month + 1).padStart(2, '0')}`);
  if (monthPins.length > 0) {
    const hasNudge = monthPins.some(p => window._calendarNudgesById && window._calendarNudgesById[p.id]);
    html += `<div style="margin-top:16px;">
      <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
        <span style="width:8px;height:8px;border-radius:2px;background:${hasNudge ? 'var(--accent)' : '#4285F4'};display:inline-block;"></span>
        Google Calendar
      </div>`;
    monthPins.forEach(p => { html += renderGooglePinCard(p, { mode: 'month' }); });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// #92: proper Week view with a time grid. Previous implementation was just a
// weekday strip + a flat list of gigs, which lost the whole point of a week
// view — seeing overlaps, gaps, and evening-density at a glance. This builds
// 24-hour hour rows × 7 day columns with events positioned absolutely.
function renderCalendarWeek(currentDate, gigs, blocked, googlePins = []) {
  // Compute Monday-anchored week start
  const d = new Date(currentDate);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const weekStart = new Date(d.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  const weekEndTs = weekStart.getTime() + 7 * 24 * 3600 * 1000;

  const layers = getCalendarLayers();
  const toDateStr = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const weekStartStr = toDateStr(weekStart);
  const weekEndStr = toDateStr(new Date(weekEndTs));
  const todayStr = toDateStr(new Date());

  // Build array of 7 day descriptors
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(weekStart);
    dt.setDate(dt.getDate() + i);
    const ds = toDateStr(dt);
    days.push({
      date: new Date(dt),
      dateStr: ds,
      label: dt.toLocaleDateString('en-GB', { weekday: 'short' }),
      dayNum: dt.getDate(),
      isToday: ds === todayStr,
    });
  }

  // Filter inputs to this week
  const weekGigs = (layers.gigs ? gigs : []).filter(g => {
    const ds = (g.date || '').slice(0, 10);
    return ds >= weekStartStr && ds < weekEndStr;
  });
  const weekPins = (layers.google ? googlePins : []).filter(p => {
    const ds = (p.date || '').slice(0, 10);
    return ds >= weekStartStr && ds < weekEndStr;
  });
  const weekBlocked = (layers.blocked ? blocked : []).filter(b => {
    const bs = (b.start_date || '').slice(0, 10);
    const be = (b.end_date || bs).slice(0, 10);
    return be >= weekStartStr && bs < weekEndStr;
  });

  // Parse a HH:MM(:SS) string into minutes-since-midnight
  const toMin = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(n => parseInt(n, 10));
    return (h * 60) + (m || 0);
  };

  // Split items into all-day (no start_time) vs timed
  const allDayByDate = {};
  days.forEach(dd => { allDayByDate[dd.dateStr] = []; });

  const timedGigs = [];
  weekGigs.forEach(g => {
    const gDate = (g.date || '').slice(0, 10);
    const sMin = toMin(g.start_time);
    if (sMin == null) {
      if (allDayByDate[gDate]) allDayByDate[gDate].push({ kind: 'gig', label: g.band_name || 'Gig', id: g.id });
    } else {
      const eMin = toMin(g.end_time) != null ? toMin(g.end_time) : Math.min(sMin + 180, 24 * 60 - 1);
      timedGigs.push({
        kind: 'gig',
        id: g.id,
        dateStr: gDate,
        startMin: sMin,
        endMin: Math.max(eMin, sMin + 30),
        crossMidnight: eMin < sMin,
        label: g.band_name || 'Gig',
        sub: (g.venue_name || '') + (g.fee ? ` · £${parseFloat(g.fee).toFixed(0)}` : ''),
      });
    }
  });

  const timedPins = [];
  weekPins.forEach(p => {
    const pDate = (p.date || '').slice(0, 10);
    if (p.all_day || !p.start_time) {
      if (allDayByDate[pDate]) allDayByDate[pDate].push({ kind: 'pin', label: p.summary || 'Busy', id: p.id, isNudge: !!(window._calendarNudgesById && window._calendarNudgesById[p.id]) });
    } else {
      const sMin = toMin(p.start_time);
      const eMin = toMin(p.end_time) != null ? toMin(p.end_time) : sMin + 60;
      timedPins.push({
        kind: 'pin',
        id: p.id,
        dateStr: pDate,
        startMin: sMin,
        endMin: Math.max(eMin, sMin + 30),
        crossMidnight: eMin < sMin,
        label: p.summary || 'Busy',
        sub: p.location || '',
        isNudge: !!(window._calendarNudgesById && window._calendarNudgesById[p.id]),
      });
    }
  });

  // Blocked: each day the block covers gets an all-day bar
  weekBlocked.forEach(b => {
    const bs = (b.start_date || '').slice(0, 10);
    const be = (b.end_date || bs).slice(0, 10);
    days.forEach(dd => {
      if (dd.dateStr >= bs && dd.dateStr <= be) {
        allDayByDate[dd.dateStr].push({ kind: 'blocked', label: b.reason || 'Unavailable', id: b.id });
      }
    });
  });

  // Travel auto-blocks (soft halo around timed gigs). Only render if layer on.
  const autoBlocks = (layers.travel && typeof computeAutoBlocksForGigs === 'function')
    ? computeAutoBlocksForGigs(weekGigs.filter(g => g.start_time))
        .map(b => {
          const bs = new Date(b.start);
          const be = new Date(b.end);
          const ds = toDateStr(bs);
          if (ds < weekStartStr || ds >= weekEndStr) return null;
          const sMin = bs.getHours() * 60 + bs.getMinutes();
          const eMin = be.getHours() * 60 + be.getMinutes();
          return { dateStr: ds, startMin: sMin, endMin: eMin > sMin ? eMin : 24 * 60 - 1, kind: b.kind };
        })
        .filter(Boolean)
    : [];

  // Grid dimensions
  const HOUR_HEIGHT = 36;
  const TIME_COL_PX = 36;
  const GRID_HEIGHT = 24 * HOUR_HEIGHT;

  // Per-day event column packing: assign each timed event a (col, cols) pair
  // so overlapping events split the day column into vertical lanes.
  const timedByDay = {};
  days.forEach(dd => { timedByDay[dd.dateStr] = []; });
  [...timedGigs, ...timedPins].forEach(ev => { (timedByDay[ev.dateStr] || []).push(ev); });
  Object.values(timedByDay).forEach(list => {
    list.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    // Simple column packer
    const cols = [];
    list.forEach(ev => {
      let placed = false;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i][cols[i].length - 1].endMin <= ev.startMin) {
          ev._col = i;
          cols[i].push(ev);
          placed = true;
          break;
        }
      }
      if (!placed) { ev._col = cols.length; cols.push([ev]); }
    });
    // For each event, find max concurrent columns in its time range
    list.forEach(ev => {
      let maxCols = cols.length;
      // Tighter: count columns that have anyone overlapping with ev
      let active = 0;
      cols.forEach(c => {
        if (c.some(o => o.startMin < ev.endMin && o.endMin > ev.startMin)) active += 1;
      });
      ev._cols = Math.max(active, 1);
    });
  });

  // Header and nav
  let html = `<div style="padding:16px 16px 0;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <button onclick="prevCalendarWeek()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">&#8249;</button>
      <div style="font-size:14px;font-weight:600;color:var(--text);">${weekStart.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} - ${new Date(weekStart.getTime() + 6 * 24 * 3600 * 1000).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}</div>
      <button onclick="nextCalendarWeek()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">&#8250;</button>
    </div>
    <button onclick="goCalendarToday()" style="width:100%;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);color:var(--accent);border-radius:6px;padding:8px;font-size:12px;font-weight:600;margin-bottom:12px;cursor:pointer;">Today</button>
  </div>`;

  // Day header strip (tappable to jump to Day view for that date)
  html += `<div style="display:grid;grid-template-columns:${TIME_COL_PX}px repeat(7, 1fr);background:var(--surface);border-top:1px solid var(--border);border-bottom:1px solid var(--border);">
    <div></div>`;
  days.forEach(dd => {
    const bg = dd.isToday ? 'var(--accent)' : 'transparent';
    const col = dd.isToday ? '#000' : 'var(--text)';
    html += `<div onclick="jumpToDayView('${dd.dateStr}')" style="text-align:center;padding:6px 2px;background:${bg};color:${col};border-left:1px solid var(--border);font-size:10px;font-weight:600;cursor:pointer;">
      <div style="text-transform:uppercase;letter-spacing:0.5px;opacity:${dd.isToday ? 1 : 0.7};">${dd.label}</div>
      <div style="font-size:14px;font-weight:700;margin-top:2px;">${dd.dayNum}</div>
    </div>`;
  });
  html += `</div>`;

  // All-day band: ALWAYS render so layout doesn't shift when Google pins or
  // blocked dates arrive from a background fetch. Each day cell has a fixed
  // min-height of 28px and max-height of 72px (3 items × ~22px + padding).
  // This keeps the grid's top position stable across repaints.
  html += `<div style="display:grid;grid-template-columns:${TIME_COL_PX}px repeat(7, 1fr);background:var(--surface);border-bottom:1px solid var(--border);">
    <div style="font-size:9px;color:var(--text-3);text-align:right;padding:4px 4px 0;line-height:1;">all<br/>day</div>`;
  days.forEach(dd => {
    const items = allDayByDate[dd.dateStr] || [];
    html += `<div style="border-left:1px solid var(--border);padding:3px 2px;min-height:28px;max-height:72px;display:flex;flex-direction:column;gap:2px;overflow:hidden;">`;
    items.slice(0, 3).forEach(it => {
      let bg = 'rgba(240,165,0,.18)', border = 'var(--accent)', col = 'var(--accent)', click = '';
      if (it.kind === 'pin') {
        const isNudge = it.isNudge;
        bg = isNudge ? 'rgba(240,165,0,.18)' : 'rgba(66,133,244,.18)';
        border = isNudge ? 'var(--accent)' : '#4285F4';
        col = isNudge ? 'var(--accent)' : '#4285F4';
        click = isNudge ? ` onclick="openCalendarNudgeByEventId('${String(it.id).replace(/'/g, "\\'")}')"` : '';
      } else if (it.kind === 'blocked') {
        bg = 'rgba(230,70,70,.16)'; border = 'var(--danger)'; col = 'var(--danger)';
      } else if (it.kind === 'gig') {
        click = ` onclick="openGigDetail('${String(it.id).replace(/'/g, "\\'")}')"`;
      }
      html += `<div${click} style="background:${bg};border-left:2px solid ${border};color:${col};font-size:9px;padding:2px 4px;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:${click ? 'pointer' : 'default'};line-height:1.3;" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>`;
    });
    if (items.length > 3) {
      html += `<div style="font-size:9px;color:var(--text-3);text-align:center;">+${items.length - 3}</div>`;
    }
    html += `</div>`;
  });
  html += `</div>`;

  // Time grid: background hour rows + absolutely-positioned events
  html += `<div id="weekTimeGrid" style="position:relative;background:var(--bg);">`;

  // Background grid (hour rows × 8 cols: 1 time + 7 days)
  html += `<div style="display:grid;grid-template-columns:${TIME_COL_PX}px repeat(7, 1fr);">`;
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`;
    html += `<div style="height:${HOUR_HEIGHT}px;border-top:1px solid var(--border);font-size:9px;color:var(--text-3);text-align:right;padding:2px 4px 0;box-sizing:border-box;">${label}</div>`;
    days.forEach(dd => {
      html += `<div onclick="openDayActionSheet('${dd.dateStr}')" style="height:${HOUR_HEIGHT}px;border-top:1px solid var(--border);border-left:1px solid var(--border);cursor:pointer;box-sizing:border-box;"></div>`;
    });
  }
  html += `</div>`;

  // Event layer: absolute-positioned cards over the 7 day columns.
  // Day columns start at TIME_COL_PX and divide the remaining width into 7.
  html += `<div style="position:absolute;top:0;left:${TIME_COL_PX}px;right:0;height:${GRID_HEIGHT}px;pointer-events:none;">`;

  // Travel halos first so they render behind gig blocks visually.
  // #138: Pack-down pill (kind=travel_home) removed per Gareth — it was
  // colliding with the next gig and "doesn't work like this". The travel_home
  // data is still emitted by computeAutoBlocksForGigs so isTimeAutoBlocked
  // (availability-calendar collision warning) keeps working; only the visible
  // pill is suppressed here.
  autoBlocks.forEach(ab => {
    if (ab.kind === 'travel_home') return;
    const dayIdx = days.findIndex(dd => dd.dateStr === ab.dateStr);
    if (dayIdx < 0) return;
    const top = (ab.startMin / 60) * HOUR_HEIGHT;
    const height = Math.max(((ab.endMin - ab.startMin) / 60) * HOUR_HEIGHT, 6);
    const leftPct = (dayIdx / 7) * 100;
    const widthPct = (1 / 7) * 100;
    const bg = ab.kind === 'travel_out' ? 'rgba(240,165,0,.10)' : 'rgba(88,166,255,.10)';
    const border = ab.kind === 'travel_out' ? 'rgba(240,165,0,.35)' : 'rgba(88,166,255,.35)';
    // Week columns are narrow, so stack the label: "Leave" over "HH:MM".
    // Only show when the halo is tall enough for both lines to fit cleanly.
    const leaveHH = String(Math.floor(ab.startMin / 60)).padStart(2, '0');
    const leaveMM = String(ab.startMin % 60).padStart(2, '0');
    const timeStr = `${leaveHH}:${leaveMM}`;
    const tipText = ab.kind === 'travel_out'
      ? `Leave by ${timeStr} (${ab.label || 'drive + load-in'})`
      : (ab.label || '');
    const showLabel = ab.kind === 'travel_out' && height >= 26;
    const labelHtml = showLabel
      ? `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:var(--accent);line-height:1.1;pointer-events:none;overflow:hidden;">
           <span>Leave</span>
           <span>${timeStr}</span>
         </div>`
      : '';
    html += `<div title="${escapeHtml(tipText)}" style="position:absolute;top:${top}px;height:${height}px;left:calc(${leftPct}% + 1px);width:calc(${widthPct}% - 2px);background:${bg};border-left:2px dashed ${border};border-radius:3px;pointer-events:none;overflow:hidden;">${labelHtml}</div>`;
  });

  // Timed events
  days.forEach((dd, dayIdx) => {
    (timedByDay[dd.dateStr] || []).forEach(ev => {
      const top = (ev.startMin / 60) * HOUR_HEIGHT;
      const clampedEnd = ev.crossMidnight ? 24 * 60 - 1 : ev.endMin;
      const height = Math.max(((clampedEnd - ev.startMin) / 60) * HOUR_HEIGHT, 14);
      const cols = ev._cols || 1;
      const col = ev._col || 0;
      const dayLeftPct = (dayIdx / 7) * 100;
      const dayWidthPct = (1 / 7) * 100;
      const evLeftPct = dayLeftPct + (col / cols) * dayWidthPct;
      const evWidthPct = dayWidthPct / cols;

      if (ev.kind === 'gig') {
        const safeId = String(ev.id).replace(/'/g, "\\'");
        html += `<div onclick="openGigDetail('${safeId}')" style="position:absolute;top:${top}px;height:${height}px;left:calc(${evLeftPct}% + 1px);width:calc(${evWidthPct}% - 2px);background:rgba(240,165,0,.22);border-left:3px solid var(--accent);border-radius:4px;padding:2px 4px;font-size:10px;color:var(--text);overflow:hidden;cursor:pointer;pointer-events:auto;box-sizing:border-box;" title="${escapeHtml(ev.label)} - ${escapeHtml(ev.sub)}">
          <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;">${escapeHtml(ev.label)}</div>
          ${height > 28 ? `<div style="font-size:9px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;">${escapeHtml(ev.sub)}</div>` : ''}
          ${ev.crossMidnight ? `<div style="font-size:8px;color:var(--accent);">&#8681; continues</div>` : ''}
        </div>`;
      } else {
        const safeId = String(ev.id).replace(/'/g, "\\'");
        const isNudge = ev.isNudge;
        const bg = isNudge ? 'rgba(240,165,0,.18)' : 'rgba(66,133,244,.18)';
        const border = isNudge ? 'var(--accent)' : '#4285F4';
        const click = isNudge ? ` onclick="openCalendarNudgeByEventId('${safeId}')"` : '';
        const cursor = isNudge ? 'pointer' : 'default';
        html += `<div${click} style="position:absolute;top:${top}px;height:${height}px;left:calc(${evLeftPct}% + 1px);width:calc(${evWidthPct}% - 2px);background:${bg};border-left:3px solid ${border};border-radius:4px;padding:2px 4px;font-size:10px;color:var(--text);overflow:hidden;cursor:${cursor};pointer-events:auto;box-sizing:border-box;" title="${escapeHtml(ev.label)}">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;color:${isNudge ? 'var(--accent)' : '#4285F4'};">${escapeHtml(ev.label)}</div>
          ${height > 28 && ev.sub ? `<div style="font-size:9px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;">${escapeHtml(ev.sub)}</div>` : ''}
        </div>`;
      }
    });
  });

  // Now-line: red horizontal line on today's column only
  const todayIdx = days.findIndex(dd => dd.isToday);
  if (todayIdx >= 0) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowTop = (nowMin / 60) * HOUR_HEIGHT;
    const leftPct = (todayIdx / 7) * 100;
    const widthPct = (1 / 7) * 100;
    html += `<div style="position:absolute;top:${nowTop - 1}px;left:calc(${leftPct}%);width:calc(${widthPct}%);height:2px;background:#ff3b30;pointer-events:none;z-index:3;"></div>
      <div style="position:absolute;top:${nowTop - 4}px;left:calc(${leftPct}% - 4px);width:8px;height:8px;border-radius:50%;background:#ff3b30;pointer-events:none;z-index:3;"></div>`;
  }

  html += `</div></div>`; // close event layer + #weekTimeGrid

  // No auto-scroll: first attempt snapped users to 15:00 which Gareth found
  // disorienting. Just render the grid from the top and let the user scroll
  // to wherever they need. Scroll-anywhere wheel delegation already makes
  // moving around the grid smooth on desktop.

  return html;
}

// #92: Week view day-header taps switch to Day view anchored on the tapped
// date. Uses the same window._calDate global that prev/next/today nav uses,
// so the rest of the calendar stays in sync.
function jumpToDayView(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    if (!isNaN(d.getTime())) {
      window._calDate = d;
    }
  } catch (_) { /* fall through */ }
  switchCalendarView('day');
}

// #134: Day view rebuilt as a single-column time grid, mirroring Week view.
// Gareth wanted Google Calendar parity — Google's Day view is the same 24-hour
// hour-grid mechanic as Week, just one column wide. The previous Day view was
// a sorted list of gigs, which lost the visual "density of evening" and made
// it impossible to see gaps between travel halos and the gig itself.
//
// Shape: same HOUR_HEIGHT (36px), same TIME_COL_PX (36px), same all-day band,
// same column-packer for overlapping events, same now-line. Travel halos slot
// in around timed gigs as dashed left-border ghost blocks behind the event.
function renderCalendarDay(currentDate, gigs, blocked, googlePins = []) {
  const toDateStr = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const dateStr = toDateStr(currentDate);
  const layers = getCalendarLayers();
  const today = new Date();
  const todayStr = toDateStr(today);
  const isToday = dateStr === todayStr;

  const dd = {
    date: new Date(currentDate),
    dateStr,
    label: currentDate.toLocaleDateString('en-GB', { weekday: 'short' }),
    dayNum: currentDate.getDate(),
    isToday,
  };

  // Filter to this day only
  const dayGigs = (layers.gigs ? gigs : []).filter(g => (g.date || '').slice(0, 10) === dateStr);
  const dayPins = (layers.google ? googlePins : []).filter(p => (p.date || '').slice(0, 10) === dateStr);
  const dayBlocked = (layers.blocked ? blocked : []).filter(b => {
    const bs = (b.start_date || '').slice(0, 10);
    const be = (b.end_date || bs).slice(0, 10);
    return dateStr >= bs && dateStr <= be;
  });

  // Parse HH:MM(:SS) to minutes-since-midnight
  const toMin = (t) => {
    if (!t) return null;
    const [h, m] = String(t).split(':').map(n => parseInt(n, 10));
    return (h * 60) + (m || 0);
  };

  // Split all-day vs timed (same logic as Week view)
  const allDayItems = [];
  const timedEvents = [];

  dayGigs.forEach(g => {
    const sMin = toMin(g.start_time);
    if (sMin == null) {
      allDayItems.push({ kind: 'gig', label: g.band_name || 'Gig', id: g.id });
    } else {
      const eMin = toMin(g.end_time) != null ? toMin(g.end_time) : Math.min(sMin + 180, 24 * 60 - 1);
      timedEvents.push({
        kind: 'gig',
        id: g.id,
        startMin: sMin,
        endMin: Math.max(eMin, sMin + 30),
        crossMidnight: eMin < sMin,
        label: g.band_name || 'Gig',
        sub: (g.venue_name || '') + (g.fee ? ` · £${parseFloat(g.fee).toFixed(0)}` : ''),
      });
    }
  });

  dayPins.forEach(p => {
    if (p.all_day || !p.start_time) {
      allDayItems.push({
        kind: 'pin',
        label: p.summary || 'Busy',
        id: p.id,
        isNudge: !!(window._calendarNudgesById && window._calendarNudgesById[p.id]),
      });
    } else {
      const sMin = toMin(p.start_time);
      const eMin = toMin(p.end_time) != null ? toMin(p.end_time) : sMin + 60;
      timedEvents.push({
        kind: 'pin',
        id: p.id,
        startMin: sMin,
        endMin: Math.max(eMin, sMin + 30),
        crossMidnight: eMin < sMin,
        label: p.summary || 'Busy',
        sub: p.location || '',
        isNudge: !!(window._calendarNudgesById && window._calendarNudgesById[p.id]),
      });
    }
  });

  dayBlocked.forEach(b => {
    allDayItems.push({ kind: 'blocked', label: b.reason || 'Unavailable', id: b.id });
  });

  // Travel halos for timed gigs today
  const autoBlocks = (layers.travel && typeof computeAutoBlocksForGigs === 'function')
    ? computeAutoBlocksForGigs(dayGigs.filter(g => g.start_time))
        .map(b => {
          const bs = new Date(b.start);
          const be = new Date(b.end);
          const ds = toDateStr(bs);
          if (ds !== dateStr) return null;
          const sMin = bs.getHours() * 60 + bs.getMinutes();
          const eMin = be.getHours() * 60 + be.getMinutes();
          return { startMin: sMin, endMin: eMin > sMin ? eMin : 24 * 60 - 1, kind: b.kind, label: b.label };
        })
        .filter(Boolean)
    : [];

  // Grid dimensions (match Week view exactly so switching views feels seamless)
  const HOUR_HEIGHT = 36;
  const TIME_COL_PX = 36;
  const GRID_HEIGHT = 24 * HOUR_HEIGHT;

  // Column-packer (same as Week but operating on a single day's events)
  timedEvents.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const cols = [];
  timedEvents.forEach(ev => {
    let placed = false;
    for (let i = 0; i < cols.length; i++) {
      if (cols[i][cols[i].length - 1].endMin <= ev.startMin) {
        ev._col = i;
        cols[i].push(ev);
        placed = true;
        break;
      }
    }
    if (!placed) { ev._col = cols.length; cols.push([ev]); }
  });
  timedEvents.forEach(ev => {
    let active = 0;
    cols.forEach(c => { if (c.some(o => o.startMin < ev.endMin && o.endMin > ev.startMin)) active += 1; });
    ev._cols = Math.max(active, 1);
  });

  // Header: prev / day label / next + Today button
  let html = `<div style="padding:16px 16px 0;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <button onclick="prevCalendarDay()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">&#8249;</button>
      <div style="font-size:14px;font-weight:600;color:var(--text);">${currentDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <button onclick="nextCalendarDay()" style="background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;">&#8250;</button>
    </div>
    <button onclick="goCalendarToday()" style="width:100%;background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);color:var(--accent);border-radius:6px;padding:8px;font-size:12px;font-weight:600;margin-bottom:12px;cursor:pointer;">Today</button>
  </div>`;

  // Day header strip (mirrors Week's SUN/MON/... row but with the single day)
  const hdrBg = isToday ? 'var(--accent)' : 'transparent';
  const hdrCol = isToday ? '#000' : 'var(--text)';
  html += `<div style="display:grid;grid-template-columns:${TIME_COL_PX}px 1fr;background:var(--surface);border-top:1px solid var(--border);border-bottom:1px solid var(--border);">
    <div></div>
    <div style="text-align:center;padding:6px 2px;background:${hdrBg};color:${hdrCol};border-left:1px solid var(--border);font-size:10px;font-weight:600;">
      <div style="text-transform:uppercase;letter-spacing:0.5px;opacity:${isToday ? 1 : 0.7};">${dd.label}</div>
      <div style="font-size:14px;font-weight:700;margin-top:2px;">${dd.dayNum}</div>
    </div>
  </div>`;

  // All-day band: ALWAYS render to keep layout stable (same as Week view fix)
  html += `<div style="display:grid;grid-template-columns:${TIME_COL_PX}px 1fr;background:var(--surface);border-bottom:1px solid var(--border);">
    <div style="font-size:9px;color:var(--text-3);text-align:right;padding:4px 4px 0;line-height:1;">all<br/>day</div>
    <div style="border-left:1px solid var(--border);padding:3px 4px;min-height:28px;max-height:72px;display:flex;flex-direction:column;gap:2px;overflow:hidden;">`;
  allDayItems.slice(0, 3).forEach(it => {
    let bg = 'rgba(240,165,0,.18)', border = 'var(--accent)', col = 'var(--accent)', click = '';
    if (it.kind === 'pin') {
      const isNudge = it.isNudge;
      bg = isNudge ? 'rgba(240,165,0,.18)' : 'rgba(66,133,244,.18)';
      border = isNudge ? 'var(--accent)' : '#4285F4';
      col = isNudge ? 'var(--accent)' : '#4285F4';
      click = isNudge ? ` onclick="openCalendarNudgeByEventId('${String(it.id).replace(/'/g, "\\'")}')"` : '';
    } else if (it.kind === 'blocked') {
      bg = 'rgba(230,70,70,.16)'; border = 'var(--danger)'; col = 'var(--danger)';
    } else if (it.kind === 'gig') {
      click = ` onclick="openGigDetail('${String(it.id).replace(/'/g, "\\'")}')"`;
    }
    html += `<div${click} style="background:${bg};border-left:2px solid ${border};color:${col};font-size:10px;padding:2px 6px;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:${click ? 'pointer' : 'default'};line-height:1.4;" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>`;
  });
  if (allDayItems.length > 3) {
    html += `<div style="font-size:9px;color:var(--text-3);padding-left:4px;">+${allDayItems.length - 3} more</div>`;
  }
  html += `</div></div>`;

  // Time grid: background hour rows + absolute-positioned events
  html += `<div id="dayTimeGrid" style="position:relative;background:var(--bg);">`;

  // Background hour rows
  html += `<div style="display:grid;grid-template-columns:${TIME_COL_PX}px 1fr;">`;
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`;
    html += `<div style="height:${HOUR_HEIGHT}px;border-top:1px solid var(--border);font-size:9px;color:var(--text-3);text-align:right;padding:2px 4px 0;box-sizing:border-box;">${label}</div>`;
    html += `<div onclick="openDayActionSheet('${dateStr}')" style="height:${HOUR_HEIGHT}px;border-top:1px solid var(--border);border-left:1px solid var(--border);cursor:pointer;box-sizing:border-box;"></div>`;
  }
  html += `</div>`;

  // Event layer: absolutely positioned to the right of the time column
  html += `<div style="position:absolute;top:0;left:${TIME_COL_PX}px;right:0;height:${GRID_HEIGHT}px;pointer-events:none;">`;

  // Travel halos first (behind gig blocks). #138: skip travel_home (pack-down)
  // — it was colliding with later gigs in dense evenings. See note in Week
  // renderer for the rationale.
  autoBlocks.forEach(ab => {
    if (ab.kind === 'travel_home') return;
    const top = (ab.startMin / 60) * HOUR_HEIGHT;
    const height = Math.max(((ab.endMin - ab.startMin) / 60) * HOUR_HEIGHT, 6);
    const bg = ab.kind === 'travel_out' ? 'rgba(240,165,0,.10)' : 'rgba(88,166,255,.10)';
    const border = ab.kind === 'travel_out' ? 'rgba(240,165,0,.35)' : 'rgba(88,166,255,.35)';
    const icon = ab.kind === 'travel_out' ? '&#128663;' : '&#128230;';
    // Halo startMin is when the user needs to leave (travel_out = drive-to-gig).
    // Show the actionable "Leave by HH:MM" string instead of a generic "Travel"
    // restatement of what the block already communicates visually.
    const leaveHH = String(Math.floor(ab.startMin / 60)).padStart(2, '0');
    const leaveMM = String(ab.startMin % 60).padStart(2, '0');
    const leaveText = ab.kind === 'travel_out' ? `Leave by ${leaveHH}:${leaveMM}` : (ab.label || 'Travel');
    const tipText = ab.kind === 'travel_out'
      ? `${leaveText} (${ab.label || 'drive + load-in'})`
      : (ab.label || '');
    html += `<div title="${escapeHtml(tipText)}" style="position:absolute;top:${top}px;height:${height}px;left:1px;right:1px;background:${bg};border-left:2px dashed ${border};border-radius:3px;pointer-events:none;padding:2px 6px;font-size:10px;font-weight:600;color:var(--accent);overflow:hidden;line-height:1.3;box-sizing:border-box;">
      ${height > 18 ? `${icon} ${escapeHtml(leaveText)}` : ''}
    </div>`;
  });

  // Timed events with column packing
  timedEvents.forEach(ev => {
    const top = (ev.startMin / 60) * HOUR_HEIGHT;
    const clampedEnd = ev.crossMidnight ? 24 * 60 - 1 : ev.endMin;
    const height = Math.max(((clampedEnd - ev.startMin) / 60) * HOUR_HEIGHT, 14);
    const evCols = ev._cols || 1;
    const evCol = ev._col || 0;
    const leftPct = (evCol / evCols) * 100;
    const widthPct = (1 / evCols) * 100;

    if (ev.kind === 'gig') {
      const safeId = String(ev.id).replace(/'/g, "\\'");
      html += `<div onclick="openGigDetail('${safeId}')" style="position:absolute;top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);background:rgba(240,165,0,.22);border-left:3px solid var(--accent);border-radius:4px;padding:3px 6px;font-size:11px;color:var(--text);overflow:hidden;cursor:pointer;pointer-events:auto;box-sizing:border-box;" title="${escapeHtml(ev.label)} - ${escapeHtml(ev.sub)}">
        <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">${escapeHtml(ev.label)}</div>
        ${height > 30 ? `<div style="font-size:10px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">${escapeHtml(ev.sub)}</div>` : ''}
        ${ev.crossMidnight ? `<div style="font-size:9px;color:var(--accent);">&#8681; continues</div>` : ''}
      </div>`;
    } else {
      const safeId = String(ev.id).replace(/'/g, "\\'");
      const isNudge = ev.isNudge;
      const bg = isNudge ? 'rgba(240,165,0,.18)' : 'rgba(66,133,244,.18)';
      const border = isNudge ? 'var(--accent)' : '#4285F4';
      const click = isNudge ? ` onclick="openCalendarNudgeByEventId('${safeId}')"` : '';
      const cursor = isNudge ? 'pointer' : 'default';
      html += `<div${click} style="position:absolute;top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);background:${bg};border-left:3px solid ${border};border-radius:4px;padding:3px 6px;font-size:11px;color:var(--text);overflow:hidden;cursor:${cursor};pointer-events:auto;box-sizing:border-box;" title="${escapeHtml(ev.label)}">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;color:${isNudge ? 'var(--accent)' : '#4285F4'};">${escapeHtml(ev.label)}</div>
        ${height > 30 && ev.sub ? `<div style="font-size:10px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">${escapeHtml(ev.sub)}</div>` : ''}
      </div>`;
    }
  });

  // Now-line if today
  if (isToday) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowTop = (nowMin / 60) * HOUR_HEIGHT;
    html += `<div style="position:absolute;top:${nowTop - 1}px;left:0;right:0;height:2px;background:#ff3b30;pointer-events:none;z-index:3;"></div>
      <div style="position:absolute;top:${nowTop - 4}px;left:-4px;width:8px;height:8px;border-radius:50%;background:#ff3b30;pointer-events:none;z-index:3;"></div>`;
  }

  html += `</div></div>`; // close event layer + #dayTimeGrid

  return html;
}

function selectCalendarDate(dateStr) {
  window._calDate = new Date(dateStr);
  window._calSelectedDate = dateStr;
  // Check if this day has any content (gig, blocked, google pin). If not, offer actions.
  const gigs = Array.isArray(window._cachedGigs) ? window._cachedGigs : [];
  const blocked = Array.isArray(window._cachedBlocked) ? window._cachedBlocked : [];
  const googlePins = Array.isArray(window._googlePins) ? window._googlePins : [];
  const hasGig = gigs.some(g => (g.date || '').slice(0, 10) === dateStr);
  const hasBlock = blocked.some(b => {
    const s = (b.start_date || '').slice(0, 10);
    const e = (b.end_date || s).slice(0, 10);
    return dateStr >= s && dateStr <= e;
  });
  const hasPin = googlePins.some(p => p.date === dateStr);
  if (!hasGig && !hasBlock && !hasPin) {
    openDayActionSheet(dateStr);
    return;
  }
  // #91: day has content — open a focused day-detail panel instead of just
  // re-rendering the month grid. Shows gigs, blocks, and Google pins for the
  // selected date with direct actions to open each.
  openDayDetailPanel(dateStr);
}

function openDayDetailPanel(dateStr) {
  const title = document.getElementById('dayDetailTitle');
  const body = document.getElementById('dayDetailBody');
  if (!title || !body) return;

  const d = new Date(dateStr + 'T12:00:00');
  title.textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const gigs = (Array.isArray(window._cachedGigs) ? window._cachedGigs : [])
    .filter(g => (g.date || '').slice(0, 10) === dateStr);
  const blocked = (Array.isArray(window._cachedBlocked) ? window._cachedBlocked : [])
    .filter(b => {
      const s = (b.start_date || '').slice(0, 10);
      const e = (b.end_date || s).slice(0, 10);
      return dateStr >= s && dateStr <= e;
    });
  const googlePins = (Array.isArray(window._googlePins) ? window._googlePins : [])
    .filter(p => p.date === dateStr);

  let html = `<div style="padding:16px;">`;

  if (gigs.length > 0) {
    html += `<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">
      ${gigs.length === 1 ? 'Gig' : 'Gigs'}
    </div>`;
    gigs.forEach(gig => {
      html += `<div class="gi" onclick="closePanel('panel-day-detail');openGigDetail('${gig.id}')" style="cursor:pointer;">
        <div style="display:flex;align-items:flex-start;gap:14px;">
          <div class="gdb">
            <div class="gdd">${new Date(gig.date).getDate()}</div>
            <div class="gdm">${new Date(gig.date).toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</div>
          </div>
          <div style="flex:1;">
            <div class="gt">${escapeHtml(gig.band_name || '')}</div>
            <div class="gv">${escapeHtml(gig.venue_name || '')}${gig.start_time ? ' · ' + formatTime(gig.start_time) : ''}</div>
            ${gig.fee ? `<div class="gf">£${parseFloat(gig.fee).toFixed(0)}</div>` : ''}
          </div>
        </div>
      </div>`;
    });
  }

  if (googlePins.length > 0) {
    const hasNudge = googlePins.some(p => window._calendarNudgesById && window._calendarNudgesById[p.id]);
    html += `<div style="margin-top:16px;font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
      <span style="width:8px;height:8px;border-radius:2px;background:${hasNudge ? 'var(--accent)' : '#4285F4'};display:inline-block;"></span>
      Google Calendar
    </div>`;
    googlePins.forEach(p => { html += renderGooglePinCard(p, { mode: 'day' }); });
  }

  if (blocked.length > 0) {
    html += `<div style="margin-top:16px;font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">
      Blocked
    </div>`;
    blocked.forEach(b => {
      html += `<div style="background:var(--card);border:1px solid var(--border);border-left:3px solid var(--danger);border-radius:var(--r);padding:12px;margin-bottom:8px;">
        <div style="font-weight:600;color:var(--text);font-size:14px;">${escapeHtml(b.reason || 'Unavailable')}</div>
        ${b.notes ? `<div style="font-size:12px;color:var(--text-2);margin-top:4px;">${escapeHtml(b.notes)}</div>` : ''}
      </div>`;
    });
  }

  // Quick actions
  html += `<div style="margin-top:20px;display:flex;flex-direction:column;gap:8px;">
    <button onclick="closePanel('panel-day-detail');openDayActionSheet('${dateStr}')" class="pill-g">Add gig or block this day</button>
  </div>`;

  html += `</div>`;
  body.innerHTML = html;
  openPanel('panel-day-detail');
}

function openDayActionSheet(dateStr) {
  // Remove any existing sheet first.
  const existing = document.getElementById('dayActionSheet');
  if (existing) existing.remove();
  const display = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  // Look up what's actually on this date so the sheet is informative
  // instead of always saying "Nothing on this day". Gigs come from the
  // gigs cache (date columns are ISO timestamps so we slice the first 10
  // chars before comparing). Blocked-date entries come from the blocked
  // cache; they may be objects with a date field or bare ISO strings.
  const gigsOnDay = (Array.isArray(window._cachedGigs) ? window._cachedGigs : [])
    .filter((g) => String(g.date || '').slice(0, 10) === dateStr);
  const blockedRows = Array.isArray(window._cachedBlocked) ? window._cachedBlocked : [];
  const blockedRow = blockedRows.find((b) => {
    const bd = typeof b === 'string' ? b : (b && b.date);
    return String(bd || '').slice(0, 10) === dateStr;
  });

  let summaryHtml;
  if (gigsOnDay.length > 0) {
    summaryHtml = gigsOnDay.map((g) => {
      const startTime = g.start_time ? String(g.start_time).slice(0, 5) : '';
      const endTime = g.end_time ? String(g.end_time).slice(0, 5) : '';
      const timeBits = [startTime, endTime].filter(Boolean).join(' – ');
      const venue = g.venue_name || '';
      const sub = [timeBits, venue].filter(Boolean).join(' &middot; ');
      const fee = g.fee ? '£' + Math.round(parseFloat(g.fee)).toLocaleString('en-GB') : '';
      return `<div onclick="closeDayActionSheet();openGigDetail('${g.id}')" style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:11px 13px;margin-bottom:8px;cursor:pointer;display:flex;align-items:center;gap:10px;">
        <div style="width:3px;align-self:stretch;background:var(--success);border-radius:2px;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(g.band_name || g.act_name || 'Gig')}</div>
          ${sub ? `<div style="font-size:11px;color:var(--text-2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sub}</div>` : ''}
        </div>
        ${fee ? `<div style="font-size:12px;font-weight:700;color:var(--success);flex-shrink:0;">${fee}</div>` : ''}
        <span style="color:var(--accent);font-size:18px;flex-shrink:0;">&rsaquo;</span>
      </div>`;
    }).join('');
  } else if (blockedRow) {
    const reason = (typeof blockedRow === 'object' && blockedRow.reason) ? blockedRow.reason : '';
    summaryHtml = `<div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:11px 13px;margin-bottom:8px;display:flex;align-items:center;gap:10px;">
      <div style="width:3px;align-self:stretch;background:var(--danger);border-radius:2px;"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:var(--text);">Blocked</div>
        ${reason ? `<div style="font-size:11px;color:var(--text-2);margin-top:2px;">${escapeHtml(reason)}</div>` : ''}
      </div>
    </div>`;
  } else {
    summaryHtml = `<div style="font-size:12px;color:var(--text-2);text-align:center;margin-bottom:12px;">Nothing on this day</div>`;
  }

  // Always offer Add gig. Block / Unblock toggles based on current state.
  const blockButton = blockedRow
    ? `<button onclick="closeDayActionSheet();window._prefillBlockDate='${dateStr}';openPanel('panel-block');" style="width:100%;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:14px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:10px;">Manage block</button>`
    : `<button onclick="closeDayActionSheet();window._prefillBlockDate='${dateStr}';openPanel('panel-block');" style="width:100%;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:14px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:10px;">Block date</button>`;

  const sheet = document.createElement('div');
  sheet.id = 'dayActionSheet';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);display:flex;align-items:flex-end;justify-content:center;';
  sheet.innerHTML = `
    <div style="width:100%;max-width:480px;background:var(--card);border-radius:16px 16px 0 0;padding:16px 16px 24px;border-top:1px solid var(--border);">
      <div style="width:40px;height:4px;background:var(--border);border-radius:2px;margin:0 auto 14px;"></div>
      <div style="font-size:14px;font-weight:700;color:var(--text);text-align:center;margin-bottom:14px;">${escapeHtml(display)}</div>
      ${summaryHtml}
      <button onclick="closeDayActionSheet();window._prefillGigDate='${dateStr}';openGigWizard();" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:10px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;margin:6px 0 10px;">${gigsOnDay.length > 0 ? 'Add another gig' : 'Add gig'}</button>
      ${blockButton}
      <button onclick="closeDayActionSheet()" style="width:100%;background:transparent;color:var(--text-2);border:none;padding:10px;font-size:13px;cursor:pointer;">Cancel</button>
    </div>`;
  sheet.addEventListener('click', (ev) => { if (ev.target === sheet) closeDayActionSheet(); });
  document.body.appendChild(sheet);
}

function closeDayActionSheet() {
  const el = document.getElementById('dayActionSheet');
  if (el) el.remove();
}
window.closeDayActionSheet = closeDayActionSheet;
window.openDayActionSheet = openDayActionSheet;

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

    // S11-06: Honour initial filter set by Home-screen invoice tiles. The tiles
    // set window._invoicesInitialFilter before calling showScreen('invoices'),
    // and we consume-and-clear it here so it only applies on first render.
    const initialFilter = window._invoicesInitialFilter || 'all';
    window._invoicesInitialFilter = null;
    // Stash the full list so filterInvoicesByStatus can re-filter without refetching.
    window._invoicesFullList = invoices;

    const statuses = ['all', 'overdue', 'draft', 'sent', 'paid'];
    const chipsHtml = statuses.map(s => {
      const label = s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1);
      const cls = s === initialFilter ? 'filter-badge ac' : 'filter-badge';
      return `<button class="${cls}" data-status="${s}" onclick="filterInvoicesByStatus('${s}')">${label}</button>`;
    }).join('');

    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="min-width:0;">
          <div style="font-size:24px;font-weight:700;color:var(--text);">Invoices</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:2px;">${invoices.length} total &middot; &pound;${(paid + overdue + draft + sent).toFixed(0)} invoiced</div>
        </div>
        <button onclick="openStandaloneInvoice()" style="background:var(--accent);color:#000;border:none;border-radius:24px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;flex-shrink:0;white-space:nowrap;">+ New</button>
      </div>
      <div style="display:flex;gap:6px;padding:0 16px 8px;overflow-x:auto;">
        ${chipsHtml}
      </div>
      <div id="invoicesList" style="padding:0 16px;"></div>`;

    content.innerHTML = html;
    renderInvoicesList(initialFilter);
}

// S11-06: Render the invoice list filtered by status. Called by both the initial
// render and filterInvoicesByStatus on chip clicks. Pulls from the cached full
// list so no refetch is needed.
function renderInvoicesList(status) {
  const listEl = document.getElementById('invoicesList');
  if (!listEl) return;
  const invoices = window._invoicesFullList || [];
  const filtered = status === 'all' ? invoices : invoices.filter(i => i.status === status);

  if (filtered.length === 0) {
    const emptyLabel = status === 'all' ? 'No invoices yet' : `No ${status} invoices`;
    listEl.innerHTML = `
      <div style="padding:32px 20px;text-align:center;color:var(--text-2);font-size:13px;">
        ${emptyLabel}
      </div>`;
    return;
  }

  let html = '';
  filtered.forEach(inv => {
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
  listEl.innerHTML = html;
}

function filterInvoicesByStatus(status) {
  // S11-06: Wire chips to real filtering. Use data-status on the chip so we
  // don't depend on event.target (which breaks if onclick is triggered
  // programmatically). Falls through to status arg if attribute missing.
  document.querySelectorAll('.filter-badge').forEach(b => {
    if (b.dataset.status === status) b.classList.add('ac');
    else b.classList.remove('ac');
  });
  renderInvoicesList(status);
}

// S11-06: Helper the Home invoice tiles call. Sets the initial filter, then
// navigates to the invoices screen. buildInvoicesHTML consumes the filter.
function goToInvoicesFiltered(status) {
  window._invoicesInitialFilter = status;
  showScreen('invoices');
}

async function openInvoiceDetail(invoiceId) {
  const panel = document.getElementById('invoiceDetailBody');
  if (!panel) return;

  panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading invoice...</div>';
  openPanel('panel-invoice-detail');

  try {
    const res = await fetch(`/api/invoices/${invoiceId}`);
    if (!res.ok) throw new Error('Failed to fetch invoice');
    const invoice = await res.json();

    const invNumForHeader = invoice.invoice_number || ('INV-' + String(invoice.id).slice(0, 6));
    const headerSub = invoice.venue_name ? escapeHtml(invoice.venue_name) : escapeHtml(invoice.band_name || '');
    let html = `
      <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
        <button onclick="closePanel('panel-invoice-detail')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">‹</button>
        <div style="flex:1;text-align:center;">
          <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(invNumForHeader)}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px;">${headerSub}</div>
          <span style="font-size:11px;background:${invoice.status === 'paid' ? 'var(--success-dim);color:var(--success)' : invoice.status === 'overdue' ? 'var(--danger-dim);color:var(--danger)' : 'var(--info-dim);color:var(--info)'};padding:2px 8px;border-radius:12px;text-transform:capitalize;font-weight:600;display:inline-block;margin-top:4px;">${invoice.status}</span>
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
          <span style="color:var(--text-2);font-size:12px;">Venue address</span>
          <span style="font-size:12px;color:var(--text);text-align:right;max-width:60%;white-space:pre-line;">${escapeHtml(invoice.venue_address)}</span>
        </div>` : ''}
        ${invoice.recipient_address ? `
        <div style="display:flex;justify-content:space-between;margin-top:8px;">
          <span style="color:var(--text-2);font-size:12px;">Client address</span>
          <span style="font-size:12px;color:var(--text);text-align:right;max-width:60%;white-space:pre-line;">${escapeHtml(invoice.recipient_address)}</span>
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
      </div>`;

    // Pay link telemetry (#292). Only renders when the invoice has a public
    // pay slug AND the user has set a pay link somewhere (per-invoice
    // override or profile default). Otherwise the section is invisible.
    const _profile = window._cachedProfile || {};
    const _hasLink = !!(invoice.payment_link_url_override || _profile.payment_link_url);
    if (invoice.public_pay_slug && _hasLink) {
      const _origin = window.location.origin;
      const _payUrl = `${_origin}/pay/${invoice.public_pay_slug}`;
      const _clicks = invoice.pay_link_clicks || 0;
      const _lastClick = invoice.pay_link_last_clicked_at;
      let _lastClickLabel = '';
      if (_lastClick) {
        try {
          const ago = Math.max(0, Math.floor((Date.now() - new Date(_lastClick).getTime()) / 60000));
          if (ago < 1) _lastClickLabel = 'Last clicked just now';
          else if (ago < 60) _lastClickLabel = `Last clicked ${ago} min ago`;
          else if (ago < 1440) _lastClickLabel = `Last clicked ${Math.floor(ago / 60)} hr ago`;
          else _lastClickLabel = `Last clicked ${Math.floor(ago / 1440)} day${ago < 2880 ? '' : 's'} ago`;
        } catch (_) {}
      }
      const _clickColour = _clicks > 0 ? 'var(--accent)' : 'var(--text-3)';
      html += `
      <div style="padding:0 16px 12px;border-bottom:1px solid var(--border);margin-bottom:12px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Pay link</div>
        <div style="display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin-bottom:8px;">
          <input id="payLinkUrlInput" type="text" readonly value="${escapeHtml(_payUrl)}" style="flex:1;background:transparent;border:none;color:var(--text);font-size:12px;font-family:ui-monospace,monospace;outline:none;min-width:0;" onclick="this.select();" />
          <button onclick="copyPayLink('${invoice.id}')" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0;">Copy</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:${_clickColour};">
          <span>${_clicks > 0 ? '&#x1F441;' : '&#x1F4E5;'}</span>
          <span>${_clicks} click${_clicks === 1 ? '' : 's'}${_lastClickLabel ? ' &middot; ' + escapeHtml(_lastClickLabel) : ''}</span>
        </div>
      </div>`;
    }

    html += `
      <div style="padding:0 16px 12px;display:flex;flex-direction:column;gap:8px;">
        ${invoice.status === 'draft' ? `<button onclick="openSendInvoice('${invoice.id}')" class="pill">Send invoice</button>` : ''}
        ${invoice.status !== 'paid' ? `<button onclick="markInvoiceAsPaid('${invoice.id}')" class="pill-o">Mark as paid</button>` : ''}
        <button onclick="downloadInvoicePDF('${invoice.id}')" class="pill-g">Print / Save as PDF</button>
        ${invoice.status === 'sent' ? `<button onclick="chaseInvoicePayment('${invoice.id}')" class="pill-g">Chase payment</button>` : ''}
        ${(invoice.status === 'sent' || invoice.status === 'overdue') ? `<button onclick="window.aiInvoiceChase && window.aiInvoiceChase('${invoice.id}')" style="background:var(--accent-dim, rgba(240,165,0,.18));color:var(--accent,#f0a500);border:1px solid rgba(240,165,0,.4);border-radius:16px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;">&#10024; AI draft chase email</button>` : ''}
        <button onclick="deleteInvoice('${invoice.id}')" style="background:none;border:1px solid var(--danger);color:var(--danger);padding:10px;border-radius:var(--r);font-weight:600;font-size:13px;cursor:pointer;margin-top:4px;">Delete invoice</button>
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
  // S7-08: filter out offers snoozed until the future. snoozed_until comes from the
  // server, which is now the source of truth; localStorage-only snoozes from older
  // builds are honoured via the same check since the per-offer mirror uses timestamps.
  const nowMs = Date.now();
  const localSnoozes = JSON.parse(localStorage.getItem('snoozedOffers') || '{}');
  const isSnoozed = (o) => {
    if (o.snoozed_until && new Date(o.snoozed_until).getTime() > nowMs) return true;
    const local = localSnoozes[o.id];
    if (local && Number(local) > nowMs) return true;
    return false;
  };
  const pending = offers.filter(o => o.status === 'pending' && !isSnoozed(o));
  const acceptedN = offers.filter(o => o.status === 'accepted').length;
  const declinedN = offers.filter(o => o.status === 'declined' || o.status === 'expired').length;

  // Global snooze state from localStorage
  const snoozeState = getGlobalSnoozeState();
  const snoozedNow = snoozeState.snoozed;
  const missed = getMissedWhileSnoozed(offers);

  const visibleOffers = pending;

  // Which tab is active. 'received' = offers sent TO me (default),
  // 'sent' = offers I sent to other people. 'marketplace' opens the
  // existing marketplace panel rather than swapping tab content.
  const view = window._offersView || 'received';
  const isReceived = view === 'received';
  const isSent = view === 'sent';

  let html = `
    <div class="ph" style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:10px;">
        <button onclick="showScreen('home')" style="color:var(--accent);font-size:14px;font-weight:500;cursor:pointer;background:none;border:none;">‹ Back</button>
        <div class="pht" style="font-size:22px;font-weight:700;color:var(--text);">Offers</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <div onclick="showAcceptedOffers()" title="Accepted offers" style="display:flex;align-items:center;gap:4px;background:var(--success-dim);border:1px solid rgba(63,185,80,.3);border-radius:12px;padding:5px 10px;cursor:pointer;">
          <span style="font-size:12px;font-weight:700;color:var(--success);">${acceptedN}</span>
          <span style="font-size:10px;color:var(--success);">&#x2713;</span>
        </div>
        <div onclick="showDeclinedOffers()" title="Declined or expired" style="display:flex;align-items:center;gap:4px;background:var(--danger-dim);border:1px solid rgba(248,81,73,.3);border-radius:12px;padding:5px 10px;cursor:pointer;">
          <span style="font-size:12px;font-weight:700;color:var(--danger);">${declinedN}</span>
          <span style="font-size:10px;color:var(--danger);">&#x2715;</span>
        </div>
        <button onclick="openDepPicker()" style="background:var(--accent);color:#000;border:none;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;">Send dep</button>
      </div>
    </div>

    <div class="tbar" style="display:flex;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;gap:0;">
      <div class="tb${isReceived ? ' ac' : ''}" onclick="showOffersTab('received')" style="cursor:pointer;">Received (${pending.length})</div>
      <div class="tb${isSent ? ' ac' : ''}" onclick="showOffersTab('sent')" style="cursor:pointer;">Sent</div>
      <div class="tb" onclick="openPanel('panel-marketplace'); if (typeof openMarketplacePanel === 'function') openMarketplacePanel();" style="cursor:pointer;display:flex;align-items:center;gap:6px;">
        <span>Marketplace &#x26A1;</span>
        <span id="marketplaceMenuBadge" style="display:none;background:var(--accent);color:#000;font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px;min-width:18px;text-align:center;line-height:1;">0</span>
      </div>
    </div>`;

  if (isSent) {
    html += `<div id="sentOffersList" style="padding:8px 16px 24px;">
      <div style="padding:32px 16px;text-align:center;color:var(--text-2);font-size:13px;">Loading sent offers&hellip;</div>
    </div>`;
    content.innerHTML = html;
    loadSentOffers();
    return;
  }

  html += `
    <!-- Global snooze toggle -->
    <div style="margin:8px 16px 0;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:18px;">&#x1F4A4;</span>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">Snooze all offers</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px;">${snoozedNow ? 'Snoozed until ' + formatSnoozeEnd(snoozeState.until) : "You're receiving offers as normal"}</div>
          </div>
        </div>
        <div onclick="toggleGlobalSnooze()" style="width:44px;height:26px;border-radius:13px;background:${snoozedNow ? 'var(--accent)' : 'var(--border)'};cursor:pointer;position:relative;transition:background .2s;">
          <div style="width:22px;height:22px;border-radius:11px;background:#fff;position:absolute;top:2px;left:${snoozedNow ? '20px' : '2px'};transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.3);"></div>
        </div>
      </div>
      ${snoozedNow ? '' : `
      <div id="snoozeOptions" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
        <div style="font-size:12px;color:var(--text-2);margin-bottom:8px;">Snooze for:</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
          <button class="snz-opt" onclick="setGlobalSnooze('2h')">2 hours</button>
          <button class="snz-opt" onclick="setGlobalSnooze('tonight')">Until tonight</button>
          <button class="snz-opt" onclick="setGlobalSnooze('tomorrow')">Until tomorrow</button>
          <button class="snz-opt" onclick="setGlobalSnooze('week')">1 week</button>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--rs);padding:8px 12px;">
          <div style="font-size:11px;color:var(--text-2);line-height:1.5;">&#x1F4A1; You'll still get up to 2 nudge notifications per snooze if someone sends you a dep offer. After that, total silence until you un-snooze.</div>
        </div>
      </div>`}
    </div>

    ${missed && !snoozedNow ? `
    <div style="margin:8px 16px 0;background:var(--danger-dim);border:1px solid rgba(248,81,73,.3);border-radius:var(--r);padding:12px 14px;display:flex;align-items:center;gap:10px;">
      <div style="font-size:18px;">&#x1F62C;</div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:2px;">While you were snoozed&hellip;</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.4;">${missed.expired} offer${missed.expired === 1 ? '' : 's'} expired and ${missed.new} new ${missed.new === 1 ? 'is' : 'are'} waiting below.</div>
      </div>
      <button onclick="dismissWhileSnoozed()" style="color:var(--text-3);background:none;border:none;font-size:14px;cursor:pointer;">&times;</button>
    </div>` : ''}

    <div id="offersListContent" style="padding:8px 16px 24px;">`;

  if (visibleOffers.length === 0) {
    html += `
      <div style="padding:40px 16px;text-align:center;color:var(--text-2);">
        <div style="font-size:32px;margin-bottom:8px;">&#x1F4EC;</div>
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;">No pending offers</div>
        <div style="font-size:12px;color:var(--text-3);">New dep requests and lineup callouts will land here.</div>
      </div>`;
  } else {
    visibleOffers.forEach(offer => {
      const deadline = offer.deadline ? new Date(offer.deadline) : null;
      const now = new Date();
      const hoursLeft = deadline ? Math.ceil((deadline - now) / (1000 * 60 * 60)) : null;
      const daysLeft = hoursLeft ? Math.ceil(hoursLeft / 24) : null;
      const urgent = hoursLeft !== null && hoursLeft <= 24;
      const senderName = offer.sender_display_name || offer.sender_name || 'Musician';
      const badge = offer.offer_type === 'dep' ? 'Dep request' : 'Lineup callout';
      const badgeColor = offer.offer_type === 'dep' ? 'var(--warning)' : 'var(--info)';
      const badgeBg = offer.offer_type === 'dep' ? 'var(--warning-dim)' : 'var(--info-dim)';

      html += `
      <div class="oc" style="${urgent ? 'border-color:rgba(248,81,73,.4);' : ''}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div class="o-act" style="font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(offer.band_name || 'Gig')}</div>
          <span style="font-size:10px;color:${badgeColor};background:${badgeBg};border-radius:8px;padding:2px 8px;font-weight:600;">${badge}</span>
        </div>
        <div style="display:flex;gap:10px;">
          <div style="flex:1;">
            <div class="o-title" style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px;">${escapeHtml(offer.venue_name || 'Venue TBC')}</div>
            <div class="o-det" style="font-size:12px;color:var(--text-2);margin-bottom:2px;">&#x1F4C5; ${formatDateLong(offer.gig_date)}</div>
            ${offer.start_time ? `<div class="o-det" style="font-size:12px;color:var(--text-2);margin-bottom:2px;">&#x1F550; ${offer.start_time.slice(0,5)}${offer.end_time ? '&ndash;' + offer.end_time.slice(0,5) : ''}</div>` : ''}
            ${offer.dress_code ? `<div class="o-det" style="font-size:12px;color:var(--text-2);margin-bottom:2px;">&#x1F454; ${escapeHtml(offer.dress_code)}</div>` : ''}
          </div>
          <div style="font-size:18px;font-weight:700;color:var(--success);">&pound;${parseFloat(offer.fee || 0).toFixed(0)}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--rs);padding:10px 12px;margin:10px 0;display:flex;align-items:center;gap:10px;">
          <div style="width:36px;height:36px;border-radius:18px;background:var(--accent-dim);border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--accent);">${escapeHtml(senderName[0] || 'M')}</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(senderName)}</div>
            <div style="font-size:11px;color:var(--text-2);">${offer.offer_type === 'dep' ? 'Dep request' : 'Band leader'}</div>
          </div>
        </div>
        ${deadline ? `
        <div class="o-timer" style="background:${urgent ? 'var(--danger-dim)' : 'var(--warning-dim)'};border-radius:var(--rs);padding:8px 10px;display:flex;gap:8px;align-items:center;margin-bottom:10px;">
          <span style="font-size:14px;">${urgent ? '&#x23F3;' : '&#x23F1;'}</span>
          <div>
            <div style="font-size:12px;font-weight:600;color:${urgent ? 'var(--danger)' : 'var(--warning)'};">Respond by ${formatSnoozeEnd(offer.deadline)}</div>
            <div style="font-size:11px;color:${urgent ? 'var(--danger)' : 'var(--warning)'};margin-top:2px;opacity:.8;">${daysLeft > 1 ? daysLeft + ' days remaining' : hoursLeft + 'h remaining'}</div>
          </div>
        </div>` : ''}
        <div class="o-acts" style="display:flex;gap:8px;">
          <button onclick="acceptOffer('${offer.id}')" class="o-acc" style="flex:1;background:var(--accent);color:#000;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;">&#x2713; Accept</button>
          <button onclick="declineOffer('${offer.id}')" class="o-dec" style="flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;">&#x2715; Decline</button>
          <button onclick="messageAboutOffer('${offer.gig_id}','${offer.sender_id}')" title="Message about this gig" aria-label="Message" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:14px;font-weight:600;cursor:pointer;flex-shrink:0;">&#x1F4AC;</button>
        </div>
      </div>`;
    });
  }

  html += `</div>`;
  content.innerHTML = html;
}

// Swap between the Received and Sent tab views inside the Offers screen.
// Persists the choice on window so re-renders (cache hits) keep the active
// tab stable. 'marketplace' is not a tab swap — the tab's onclick opens the
// marketplace panel directly.
function showOffersTab(view) {
  window._offersView = view;
  const content = document.getElementById('offersScreen');
  if (!content) return;
  // Re-render using cached offers so the Received tab stays fast. If there
  // is no cache yet, fall back to the async path.
  if (window._cachedOffers) {
    buildOffersHTML(content, window._cachedOffers);
  } else {
    renderOffersScreen();
  }
}

// Fetch and render the Sent tab content. Called from buildOffersHTML when
// view === 'sent'. Keeps the list call out of the main render path so the
// received tab stays cache-first.
async function loadSentOffers() {
  const listEl = document.getElementById('sentOffersList');
  if (!listEl) return;
  try {
    const res = await fetch('/api/offers/sent');
    if (!res.ok) throw new Error('Failed to fetch sent offers');
    const offers = await res.json();
    renderSentOffers(listEl, offers);
  } catch (err) {
    console.error('Sent offers error:', err);
    listEl.innerHTML = `
      <div style="padding:40px 16px;text-align:center;">
        <div style="font-size:28px;margin-bottom:8px;">&#x26A0;&#xFE0F;</div>
        <div style="font-size:13px;color:var(--text-2);">Couldn&#x2019;t load sent offers. Try again.</div>
      </div>`;
  }
}

function renderSentOffers(listEl, offers) {
  if (!Array.isArray(offers) || offers.length === 0) {
    listEl.innerHTML = `
      <div style="padding:40px 16px;text-align:center;color:var(--text-2);">
        <div style="font-size:32px;margin-bottom:8px;">&#x1F4E4;</div>
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;">You haven&#x2019;t sent any offers yet</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:14px;">When you need a dep, your sent requests will live here so you can see who&#x2019;s said yes.</div>
        <button onclick="openDepPicker()" style="background:var(--accent);color:#000;border:none;border-radius:20px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;">Send a dep</button>
      </div>`;
    return;
  }

  // Surface pending offers first, then the rest in reverse-chronological order
  // which is what the backend already returns.
  const pending = offers.filter(o => o.status === 'pending');
  const other = offers.filter(o => o.status !== 'pending');
  const ordered = [...pending, ...other];

  const statusStyle = (status) => {
    switch (status) {
      case 'accepted': return { label: 'Accepted', color: 'var(--success)', bg: 'var(--success-dim)' };
      case 'declined': return { label: 'Declined', color: 'var(--danger)', bg: 'var(--danger-dim)' };
      case 'expired':  return { label: 'Expired',  color: 'var(--text-3)', bg: 'var(--surface)' };
      case 'cancelled':return { label: 'Cancelled',color: 'var(--text-3)', bg: 'var(--surface)' };
      case 'pending':
      default:         return { label: 'Pending',  color: 'var(--warning)', bg: 'var(--warning-dim)' };
    }
  };

  let html = '';
  ordered.forEach(offer => {
    const recipientName = offer.recipient_display_name || offer.recipient_name || 'Musician';
    const st = statusStyle(offer.status);
    const badge = offer.offer_type === 'dep' ? 'Dep request' : 'Lineup callout';
    const badgeColor = offer.offer_type === 'dep' ? 'var(--warning)' : 'var(--info)';
    const badgeBg = offer.offer_type === 'dep' ? 'var(--warning-dim)' : 'var(--info-dim)';
    const fee = parseFloat(offer.fee || 0).toFixed(0);

    html += `
      <div class="oc">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(offer.band_name || 'Gig')}</div>
          <span style="font-size:10px;color:${badgeColor};background:${badgeBg};border-radius:8px;padding:2px 8px;font-weight:600;">${badge}</span>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <div style="flex:1;">
            <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px;">${escapeHtml(offer.venue_name || 'Venue TBC')}</div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:2px;">&#x1F4C5; ${formatDateLong(offer.gig_date)}</div>
            ${offer.start_time ? `<div style="font-size:12px;color:var(--text-2);margin-bottom:2px;">&#x1F550; ${offer.start_time.slice(0,5)}${offer.end_time ? '&ndash;' + offer.end_time.slice(0,5) : ''}</div>` : ''}
          </div>
          <div style="font-size:18px;font-weight:700;color:var(--success);">&pound;${fee}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--rs);padding:10px 12px;margin:10px 0;display:flex;align-items:center;gap:10px;">
          <div style="width:36px;height:36px;border-radius:18px;background:var(--accent-dim);border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--accent);">${escapeHtml(recipientName[0] || 'M')}</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:600;color:var(--text);">Sent to ${escapeHtml(recipientName)}</div>
            <div style="font-size:11px;color:var(--text-2);">${new Date(offer.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</div>
          </div>
          <span style="font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border-radius:10px;padding:4px 10px;">${st.label}</span>
        </div>
        ${offer.status === 'pending' ? (() => {
          // Nudge cap: 1 send + up to 2 nudges per offer. Show the nudge
          // button alongside Cancel request with a live "N left" label so
          // the sender knows how many reminders they have in the bank.
          const nudgeCount = Number(offer.nudge_count || 0);
          const nudgesLeft = Math.max(0, 2 - nudgeCount);
          const nudgeLabel = nudgesLeft === 0
            ? 'No nudges left'
            : nudgeCount === 0
              ? 'Nudge (2 left)'
              : `Nudge (${nudgesLeft} left)`;
          const nudgeDisabled = nudgesLeft === 0;
          const nudgeHint = offer.last_nudged_at
            ? `<div style="font-size:11px;color:var(--text-3);margin:4px 0 8px;">Last nudged ${formatRelativeTime(offer.last_nudged_at)}</div>`
            : '';
          return `
        ${nudgeHint}
        <div style="display:flex;gap:8px;">
          <button onclick="cancelSentOffer('${offer.id}')" style="flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;">Cancel request</button>
          <button onclick="nudgeSentOffer('${offer.id}')" ${nudgeDisabled ? 'disabled' : ''} style="flex:1;background:${nudgeDisabled ? 'var(--surface)' : 'var(--accent)'};color:${nudgeDisabled ? 'var(--text-3)' : '#000'};border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:700;cursor:${nudgeDisabled ? 'not-allowed' : 'pointer'};">${nudgeLabel}</button>
        </div>`;
        })() : ''}
      </div>`;
  });

  listEl.innerHTML = html;
}

// Format a past timestamp as "2 hours ago" / "yesterday" / "3 days ago" for the
// nudge hint line under pending offers. Defensive: bad input returns an empty
// string so we never poison the card render.
function formatRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (isNaN(then)) return '';
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Sender-side nudge. Hits POST /offers/:id/nudge which enforces the max-2 cap
// server-side. On success reload the Sent list so the nudge count updates in
// place. 409 means the recipient has responded (no longer pending) or the cap
// was hit from another device mid-click — either way we refresh to show the
// real state.
async function nudgeSentOffer(offerId) {
  try {
    const res = await fetch(`/api/offers/${offerId}/nudge`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body.success) {
      const left = Math.max(0, Number(body.nudges_remaining || 0));
      toast(left === 0 ? 'Nudge sent. That was your last one.' : `Nudge sent. ${left} left on this offer.`);
      loadSentOffers();
      return;
    }
    if (res.status === 409) {
      toast(body.error || 'No nudges left on this offer');
      loadSentOffers(); // refresh so the disabled state reflects reality
      return;
    }
    toast(body.error || 'Could not nudge offer');
  } catch (err) {
    console.error('Nudge sent offer error:', err);
    toast('Could not nudge offer');
  }
}

// Sender-side withdrawal. Hits POST /offers/:id/withdraw which only touches
// offers the current user sent that are still pending. On success we reload
// the Sent list in place so the row moves into the cancelled group without
// a full screen re-render.
async function cancelSentOffer(offerId) {
  if (!confirm('Withdraw this dep request? The recipient will see it as cancelled.')) return;
  try {
    const res = await fetch(`/api/offers/${offerId}/withdraw`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Could not withdraw offer');
      return;
    }
    toast('Offer withdrawn');
    loadSentOffers();
  } catch (err) {
    console.error('Withdraw sent offer error:', err);
    toast('Could not withdraw offer');
  }
}


function showAcceptedOffers() {
  const offers = (window._cachedOffers || []).filter(o => o.status === 'accepted');
  if (!offers.length) return toast('No accepted offers yet');
  const summary = offers.slice(0, 8).map(o => `\u2713 ${o.band_name || o.venue_name || 'Gig'} \u2014 ${formatDateLong(o.gig_date)}`).join('\n');
  alert('Accepted offers:\n\n' + summary);
}

function showDeclinedOffers() {
  const offers = (window._cachedOffers || []).filter(o => o.status === 'declined' || o.status === 'expired');
  if (!offers.length) return toast('No declined or expired offers');
  const summary = offers.slice(0, 8).map(o => `\u2715 ${o.band_name || o.venue_name || 'Gig'} \u2014 ${formatDateLong(o.gig_date)}`).join('\n');
  alert('Declined / Missed:\n\n' + summary);
}

// ── Global snooze helpers ──────────────────────────────────────────────────
function getGlobalSnoozeState() {
  try {
    const raw = localStorage.getItem('globalSnoozeUntil');
    if (!raw) return { snoozed: false, until: null };
    const until = parseInt(raw, 10);
    if (!until || Date.now() > until) {
      // Auto-clear expired snooze
      localStorage.removeItem('globalSnoozeUntil');
      return { snoozed: false, until: null };
    }
    return { snoozed: true, until };
  } catch { return { snoozed: false, until: null }; }
}

function setGlobalSnooze(preset) {
  const now = new Date();
  let until;
  if (preset === '2h') until = now.getTime() + 2 * 3600_000;
  else if (preset === 'tonight') {
    const end = new Date(now); end.setHours(22, 0, 0, 0);
    until = end.getTime();
  } else if (preset === 'tomorrow') {
    const end = new Date(now); end.setDate(end.getDate() + 1); end.setHours(9, 0, 0, 0);
    until = end.getTime();
  } else if (preset === 'week') until = now.getTime() + 7 * 24 * 3600_000;
  else until = now.getTime() + 2 * 3600_000;
  localStorage.setItem('globalSnoozeUntil', String(until));
  localStorage.setItem('globalSnoozedAt', String(now.getTime()));
  toast('Snoozed');
  renderOffersScreen();
}

function toggleGlobalSnooze() {
  const state = getGlobalSnoozeState();
  if (state.snoozed) {
    // Un-snooze: stash the snooze window so we can show "while-you-were-away"
    localStorage.setItem('lastSnoozeEndedAt', String(Date.now()));
    localStorage.removeItem('globalSnoozeUntil');
    localStorage.setItem('showWhileAway', '1');
    renderOffersScreen();
    return;
  }
  // Toggle inline options panel
  const el = document.getElementById('snoozeOptions');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function getMissedWhileSnoozed(offers) {
  try {
    if (localStorage.getItem('showWhileAway') !== '1') return null;
    const start = parseInt(localStorage.getItem('globalSnoozedAt') || '0', 10);
    const end = parseInt(localStorage.getItem('lastSnoozeEndedAt') || '0', 10);
    if (!start || !end) return null;
    const expired = offers.filter(o => o.status === 'expired' && o.created_at && new Date(o.created_at).getTime() >= start && new Date(o.created_at).getTime() <= end).length;
    const fresh = offers.filter(o => o.status === 'pending' && o.created_at && new Date(o.created_at).getTime() >= start).length;
    if (expired === 0 && fresh === 0) return null;
    return { expired, new: fresh };
  } catch { return null; }
}

function dismissWhileSnoozed() {
  localStorage.removeItem('showWhileAway');
  renderOffersScreen();
}

function formatSnoozeEnd(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  if (isTomorrow) return `tomorrow ${time}`;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

window.showAcceptedOffers = showAcceptedOffers;
window.showDeclinedOffers = showDeclinedOffers;
window.setGlobalSnooze = setGlobalSnooze;
window.toggleGlobalSnooze = toggleGlobalSnooze;
window.dismissWhileSnoozed = dismissWhileSnoozed;

async function renderProfileScreen() {
  // Render into the panel overlay body (profile-panel), falling back to the screen
  const content = document.getElementById('profilePanelBody') || document.getElementById('profileScreen');

  // Use cached profile for instant render
  const now = Date.now();
  if (window._cachedProfile && (now - window._cachedProfileTime) < PROFILE_CACHE_TTL) {
    buildProfileHTML(content, window._cachedProfile);
    if (typeof refreshDocsExpiryDot === 'function') refreshDocsExpiryDot();
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
    // Paint the red-dot warning on the Documents & certs row if anything is
    // within 7 days of expiry. Fire-and-forget so the profile paint isn't blocked.
    if (typeof refreshDocsExpiryDot === 'function') refreshDocsExpiryDot();
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
        <button onclick="closePanel('profile-panel')" style="background:none;border:none;color:var(--accent);font-size:14px;font-weight:500;cursor:pointer;padding:0;min-width:60px;text-align:left;">&#8249; Back</button>
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
          ${profile.home_postcode ? `<div style="font-size:10px;color:var(--text-3);margin-top:2px;">Home: ${escapeHtml(profile.home_postcode)} · Travel radius: ${profile.travel_radius_miles != null ? profile.travel_radius_miles : 50} mi</div>` : '<div style="font-size:10px;color:var(--warning);margin-top:2px;">Add home postcode for mileage tracking</div>'}
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
      ${(() => {
        // Phase IX-E: Directory profile summary. Only render if user has
        // engaged with the feature (discoverable flag set, bio written, or
        // genres chosen) so the panel doesn't shout at users who haven't
        // touched it yet.
        const discoverable = profile.discoverable !== false;
        const bioSet = !!(profile.bio && profile.bio.trim());
        const genresSet = Array.isArray(profile.genres) && profile.genres.length > 0;
        const photoSet = !!(profile.photo_url && profile.photo_url.trim());
        const anyTouched = bioSet || genresSet || photoSet || profile.discoverable === false;
        if (!anyTouched && discoverable) {
          // Quiet encouragement: one line, nudging the user to the editor.
          return `<div onclick="editProfile()" style="margin:0 16px 12px;padding:10px 12px;background:var(--card);border:1px dashed var(--border);border-radius:var(--rs);cursor:pointer;display:flex;align-items:center;gap:10px;">
            <span style="font-size:18px;">🔍</span>
            <div style="flex:1;min-width:0;font-size:12px;color:var(--text-2);">Add a bio and genres to fill out your Find Musicians card</div>
            <span style="color:var(--accent);font-size:14px;">›</span>
          </div>`;
        }
        const chip = discoverable
          ? '<span style="display:inline-block;background:var(--success-dim);color:var(--success);padding:3px 8px;border-radius:10px;font-size:10px;font-weight:600;">Listed</span>'
          : '<span style="display:inline-block;background:var(--border);color:var(--text-2);padding:3px 8px;border-radius:10px;font-size:10px;font-weight:600;">Hidden</span>';
        const bioLine = bioSet
          ? `<div style="font-size:11px;color:var(--text-2);line-height:1.4;margin-top:4px;">${escapeHtml(profile.bio)}</div>`
          : '';
        const genreLine = genresSet
          ? `<div style="font-size:10px;color:var(--text-3);margin-top:6px;">${profile.genres.slice(0,6).map(g => escapeHtml(g)).join(' · ')}</div>`
          : '';
        return `<div onclick="editProfile()" style="margin:0 16px 12px;padding:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);cursor:pointer;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:12px;font-weight:600;color:var(--text);text-transform:uppercase;letter-spacing:1px;">Directory profile</div>
            ${chip}
          </div>
          ${bioLine}
          ${genreLine}
        </div>`;
      })()}
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
        <div onclick="openPanel('panel-documents'); openDocumentsPanel();" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;display:flex;align-items:center;gap:8px;">Documents & certs <span id="docsExpiryDot" style="display:none;width:8px;height:8px;border-radius:50%;background:var(--danger,#f85149);"></span></span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="openPanel('panel-finance'); if (typeof renderFinancePanel === 'function') renderFinancePanel();" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Earnings & tax summary</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="openPanel('panel-notifications-settings')" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Notification settings</span>
          <span style="color:var(--accent);font-size:16px;">›</span>
        </div>
        <div onclick="toggleConnected()" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span style="color:var(--text);font-size:14px;">Connected acts</span>
          <span style="color:var(--accent);font-size:16px;" id="connected-arrow">›</span>
        </div>
        <div id="connected-section" style="display:none;background:var(--card);padding:8px 14px;border-bottom:1px solid var(--border);">
          <!-- S8-04: dead placeholder removed. No account-linking flow exists yet between
               TrackMyGigs and Musician Tracker / ClientFlow, so a truthful coming-soon
               state replaces the hardcoded list. -->
          <div style="font-size:12px;color:var(--text-2);padding:6px 0;line-height:1.5;">
            Link your Musician Tracker and ClientFlow accounts for shared contacts, earnings and calendars. Coming soon.
          </div>
        </div>
        ${(() => {
          const prof = window._cachedProfile || {};
          const connected = window._googleConnected === true || !!prof.google_access_token || !!prof.calendar_connected;
          const who = window._googleCalendarEmail || prof.google_calendar_email || prof.calendar_email || null;
          if (connected) {
            return `
        <div style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;">
            <span style="color:var(--text);font-size:14px;">Google Calendar</span>
            <span style="color:var(--text-2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${who ? 'Connected as ' + escapeHtml(who) : 'Connected'}</span>
          </div>
          <button onclick="disconnectGoogleCalendar()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--danger);font-size:12px;font-weight:600;cursor:pointer;">Disconnect</button>
        </div>`;
          }
          return `
        <div onclick="window.location.href='/auth/google/calendar'" style="padding:12px 14px;background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
          <span style="color:var(--text);font-size:14px;">Google Calendar</span>
          <span style="color:var(--accent);font-size:12px;font-weight:600;">Connect \u203A</span>
        </div>`;
        })()}
        <div onclick="openMapsPreferencePicker()" style="padding:12px 14px;background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
          <span style="color:var(--text);font-size:14px;">Preferred maps app</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;color:var(--text-2);">${(() => { const p = (typeof getMapsPreference === 'function') ? getMapsPreference() : null; return p === 'google' ? 'Google Maps' : p === 'apple' ? 'Apple Maps' : p === 'waze' ? 'Waze' : 'Ask each time'; })()}</span>
            <span style="color:var(--accent);font-size:16px;">\u203A</span>
          </span>
        </div>
        ${(() => {
          // Subscription row (task #282). Premium users get "Manage subscription"
          // opening the Stripe Billing Portal; free users get "Go premium"
          // opening the plan picker. premium_until formatted as "renews on"
          // when set, so the user sees their trial or renewal anchor at a glance.
          const prof = window._cachedProfile || {};
          const isPremium = prof.premium === true;
          const untilRaw = prof.premium_until || null;
          let untilLabel = '';
          if (untilRaw) {
            try {
              const d = new Date(untilRaw);
              if (!isNaN(d.getTime())) {
                untilLabel = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
              }
            } catch (_) { /* ignore */ }
          }
          if (isPremium) {
            // 2026-04-26: read cancel_at_period_end so the date label matches
            // reality. After a Billing Portal cancel, the user still has
            // premium until the period ends — UI should say "cancels on" not
            // "renews on", and the colour shifts to warning so the cancellation
            // is visible at a glance.
            const cancelling = prof.stripe_cancel_at_period_end === true;
            const dateVerb = cancelling ? 'cancels' : 'renews';
            const subText = untilLabel ? ('Premium &middot; ' + dateVerb + ' ' + untilLabel) : 'Premium';
            const subColour = cancelling ? 'var(--warning,#F0A500)' : 'var(--text-2)';
            return `
        <div onclick="window.openBillingPortal && window.openBillingPortal()" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;">
            <span style="color:var(--text);font-size:14px;">Manage subscription</span>
            <span style="color:${subColour};font-size:11px;">${subText}</span>
          </div>
          <span style="color:var(--accent);font-size:16px;">&rsaquo;</span>
        </div>`;
          }
          return `
        <div onclick="window.openPremiumPicker && window.openPremiumPicker()" style="padding:12px 14px;background:var(--card);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;">
            <span style="color:var(--text);font-size:14px;">Go premium</span>
            <span style="color:var(--text-2);font-size:11px;">14-day free trial. &pound;14.99/mo or &pound;129/yr.</span>
          </div>
          <span style="color:var(--accent);font-size:16px;">&rsaquo;</span>
        </div>`;
        })()}
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
    // Teaching-specific: only populated when gig_type === 'Teaching'.
    // Server derives fee from rate_per_hour * duration when these are present.
    client_name: '',
    client_email: '',
    client_phone: '',
    rate_per_hour: '',
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
        <div style="display:flex;align-items:center;gap:12px;">
          <button type="button" onclick="window.aiSmartPasteGig && window.aiSmartPasteGig()" title="Paste booking text and I will fill the form" style="background:var(--accent-dim, rgba(240,165,0,.18));color:var(--accent,#f0a500);border:1px solid rgba(240,165,0,.4);border-radius:12px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;">&#10024; Smart Paste</button>
          <div onclick="renderFullGigForm()" style="font-size:12px;color:var(--text-3);cursor:pointer;">Show full form</div>
        </div>
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
      { label: '\u{1F4DA} Teaching', value: 'Teaching' },
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
        <div id="feeBenchmarkChip" style="margin-top:10px;"></div>
      </div>
      ${renderTeachingBlock()}
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

  // Paint the fee benchmark chip on Step 5 once the DOM is in place.
  if (step === 5) {
    setTimeout(renderFeeBenchmarkChip, 0);
  }
}

function renderFeeBenchmarkChip() {
  const host = document.getElementById('feeBenchmarkChip');
  if (!host) return;
  if (!window.FeeBenchmarks) {
    host.innerHTML = '';
    return;
  }
  // For Teaching, compare against the user's hourly rate (not the derived fee),
  // since the benchmark for teaching is also expressed per hour.
  const feeForBench = gigWizardData.gig_type === 'Teaching'
    ? gigWizardData.rate_per_hour
    : gigWizardData.fee;
  const b = window.FeeBenchmarks.getBenchmark({
    gig_type: gigWizardData.gig_type,
    address: gigWizardData.venue_address,
    fee: feeForBench,
  });
  if (!b) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `
    <div style="background:var(--accent-dim);border:1px solid rgba(240,165,0,.3);border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.45;">
      <div style="color:var(--text);">\u{1F4A1} ${escapeHtml(b.text)}</div>
      <div style="color:var(--text-3);font-size:10px;margin-top:4px;">${escapeHtml(b.meta)}</div>
    </div>
  `;
}

// ── Teaching helpers ────────────────────────────────────────────────────────
// Mirror of server-side deriveTeachingFee: rate × (duration in hours), 2dp.
// Returns null if inputs are missing so the UI can show a friendly hint.
function deriveTeachingFeeClient(startTime, endTime, ratePerHour) {
  const rate = parseFloat(ratePerHour);
  if (!rate || rate <= 0) return null;
  if (!startTime || !endTime) return null;
  const [sh, sm] = String(startTime).split(':').map(Number);
  const [eh, em] = String(endTime).split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return null;
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) return null;
  return Math.round(rate * (mins / 60) * 100) / 100;
}

function renderTeachingBlock() {
  if (gigWizardData.gig_type !== 'Teaching') return '';
  const d = gigWizardData;
  const derived = deriveTeachingFeeClient(d.start_time, d.end_time, d.rate_per_hour);
  let feePreview = '';
  if (derived != null) {
    const hrs = (() => {
      const [sh, sm] = String(d.start_time).split(':').map(Number);
      const [eh, em] = String(d.end_time).split(':').map(Number);
      const mins = eh * 60 + em - (sh * 60 + sm);
      return Math.round((mins / 60) * 100) / 100;
    })();
    feePreview = `That\u2019s \u00A3${derived.toFixed(2)} for ${hrs} hour${hrs === 1 ? '' : 's'}.`;
  } else if (d.rate_per_hour && !d.start_time) {
    feePreview = 'Add start/end times on Step 3 to preview the lesson fee.';
  }
  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">\u{1F4DA} Teaching details</div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;line-height:1.45;">We\u2019ll work the lesson fee out from your hourly rate and the times on Step 3.</div>
      <div class="form-group" style="margin-bottom:10px;">
        <label class="form-label">Student / client name</label>
        <input
          type="text"
          class="form-input"
          id="wClientName"
          placeholder="e.g. Sam Patel"
          value="${escapeHtml(d.client_name)}"
          oninput="captureTeachingField('client_name', this.value)"
        >
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">Email (optional)</label>
          <input
            type="email"
            class="form-input"
            id="wClientEmail"
            placeholder="sam@example.com"
            value="${escapeHtml(d.client_email)}"
            oninput="captureTeachingField('client_email', this.value)"
          >
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">Phone (optional)</label>
          <input
            type="tel"
            class="form-input"
            id="wClientPhone"
            placeholder="07..."
            value="${escapeHtml(d.client_phone)}"
            oninput="captureTeachingField('client_phone', this.value)"
          >
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Rate per hour (\u00A3)</label>
        <input
          type="number"
          class="form-input"
          id="wRatePerHour"
          placeholder="35"
          min="0"
          step="1"
          inputmode="decimal"
          value="${escapeHtml(String(d.rate_per_hour))}"
          oninput="captureTeachingRate(this.value)"
        >
        <div id="wTeachingFeePreview" style="margin-top:6px;font-size:12px;color:var(--text-2);min-height:18px;">${escapeHtml(feePreview)}</div>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);">
        <a onclick="openTeachingTermFromWizard()" style="display:inline-block;font-size:12px;font-weight:600;color:var(--accent);cursor:pointer;text-decoration:none;">
          \u{1F4C5} Teaching a whole term? Set up multiple lessons at once \u2192
        </a>
      </div>
    </div>
  `;
}

// Shortcut from the wizard into the bulk term panel. Seeds the panel with any
// client name / rate the user already typed so they don't have to re-type it.
function openTeachingTermFromWizard() {
  captureStep5Fields();
  window._teachingTermSeed = {
    client_name: gigWizardData.client_name || '',
    client_email: gigWizardData.client_email || '',
    client_phone: gigWizardData.client_phone || '',
    rate_per_hour: gigWizardData.rate_per_hour || '',
  };
  openPanel('panel-teaching-term');
}

// Live-capture handlers so the user's typing survives a re-render triggered by
// changing gig type or re-painting the benchmark chip.
function captureTeachingField(key, value) {
  if (!(key in gigWizardData)) return;
  gigWizardData[key] = value;
}

function captureTeachingRate(value) {
  gigWizardData.rate_per_hour = value;
  // Repaint fee preview and benchmark chip in place (no full re-render, to
  // avoid yanking focus from the input as the user types).
  const preview = document.getElementById('wTeachingFeePreview');
  if (preview) {
    const derived = deriveTeachingFeeClient(
      gigWizardData.start_time,
      gigWizardData.end_time,
      value
    );
    if (derived != null) {
      const [sh, sm] = String(gigWizardData.start_time).split(':').map(Number);
      const [eh, em] = String(gigWizardData.end_time).split(':').map(Number);
      const hrs = Math.round(((eh * 60 + em - (sh * 60 + sm)) / 60) * 100) / 100;
      preview.textContent = `That\u2019s \u00A3${derived.toFixed(2)} for ${hrs} hour${hrs === 1 ? '' : 's'}.`;
    } else if (value && !gigWizardData.start_time) {
      preview.textContent = 'Add start/end times on Step 3 to preview the lesson fee.';
    } else {
      preview.textContent = '';
    }
  }
  renderFeeBenchmarkChip();
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
    // captureStep5Fields grabs the teaching inputs too; trim the text fields
    // that have always been trimmed.
    captureStep5Fields();
    gigWizardData.dress_code = (gigWizardData.dress_code || '').trim();
    gigWizardData.notes = (gigWizardData.notes || '').trim();
    gigWizardData.client_name = (gigWizardData.client_name || '').trim();
    gigWizardData.client_email = (gigWizardData.client_email || '').trim();
    gigWizardData.client_phone = (gigWizardData.client_phone || '').trim();
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
  // Preserve whatever the user typed on the current step before navigating.
  if (gigWizardStep === 5) captureStep5Fields();
  if (gigWizardStep === 4) {
    const feeEl = document.getElementById('wFee');
    if (feeEl) gigWizardData.fee = feeEl.value || '';
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
  // Capture any in-flight field values before a potential re-render, so the
  // user's typing in dress code / notes / teaching inputs doesn't get lost.
  captureStep5Fields();

  const prevType = gigWizardData.gig_type;
  if (prevType === type) {
    gigWizardData.gig_type = '';
    btn.classList.remove('selected');
  } else {
    gigWizardData.gig_type = type;
    document
      .querySelectorAll('.chip-group .chip')
      .forEach((c) => c.classList.remove('selected'));
    btn.classList.add('selected');
  }

  // If Teaching is turning on or off, we need a full Step 5 re-render to
  // add/remove the teaching details block. Otherwise a chip repaint is enough.
  const teachingChanged = (prevType === 'Teaching') !== (gigWizardData.gig_type === 'Teaching');
  if (teachingChanged) {
    renderWizardStep(5);
    return;
  }
  renderFeeBenchmarkChip();
}

// Capture all editable fields on Step 5 into gigWizardData. Safe to call even
// when the teaching block isn't rendered (the lookups just no-op).
function captureStep5Fields() {
  const dress = document.getElementById('wDressCode');
  if (dress) gigWizardData.dress_code = dress.value;
  const notes = document.getElementById('wNotes');
  if (notes) gigWizardData.notes = notes.value;
  const cn = document.getElementById('wClientName');
  if (cn) gigWizardData.client_name = cn.value;
  const ce = document.getElementById('wClientEmail');
  if (ce) gigWizardData.client_email = ce.value;
  const cp = document.getElementById('wClientPhone');
  if (cp) gigWizardData.client_phone = cp.value;
  const rate = document.getElementById('wRatePerHour');
  if (rate) gigWizardData.rate_per_hour = rate.value;
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
      if (!resp.ok) {
        list.style.display = 'none';
        if (typeof showToast === 'function') {
          showToast('Venue lookup isn\u2019t working right now. Just type the venue name.');
        }
        return;
      }
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
      if (typeof showToast === 'function') {
        showToast('Venue lookup isn\u2019t working right now. Just type the venue name.');
      }
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

  // Optimistically save the typed name even if the detail lookup fails,
  // so a Places outage never silently drops the venue.
  gigWizardData.venue_name = name;

  try {
    const resp = await fetch(`/api/places/detail?place_id=${encodeURIComponent(placeId)}`);
    if (!resp.ok) {
      if (typeof showToast === 'function') {
        showToast('Address lookup hit a snag, but the venue name is saved.');
      }
      return;
    }
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
            addrMeta.textContent = `\u2713 Full address saved \u00B7 ${distData.miles * 2} miles round trip \u00B7 ~${distData.duration}`;
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
    if (typeof showToast === 'function') {
      showToast('Address lookup hit a snag, but the venue name is saved.');
    }
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
  // #83: guard against double-submit. The AI sanity check below fetches
  // /ai/sanity-check before we disable the Save button, so a user who
  // thinks the first tap didn't land can trigger a second concurrent run
  // (two gigs saved, or a confusing "two-click Save"). Block re-entry and
  // disable the button immediately so the first tap always wins.
  if (window._gigWizardSubmitting) return;
  window._gigWizardSubmitting = true;
  const btn = document.getElementById('wizardNextBtn');
  if (btn) {
    btn.disabled = true;
    btn.dataset.origLabel = btn.textContent;
    btn.textContent = 'Saving...';
  }

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
        if (!ok) {
          // #83: release the re-entry guard and restore the button so the
          // user can retry after dismissing the auto-block prompt.
          window._gigWizardSubmitting = false;
          if (btn) {
            btn.disabled = false;
            btn.textContent = btn.dataset.origLabel || 'Save Gig';
          }
          return;
        }
        gigWizardData._forcedThroughAutoBlock = true;
      }
    }
  } catch (_) { /* non-fatal */ }

  // AI Sanity Check — lightweight pre-flight (date in past? red-flag venue? unusually low/high fee?).
  // Fails silently to normal save if AI is disabled or errors.
  try {
    if (!gigWizardData._forcedThroughSanityCheck && typeof window.aiSanityCheck === 'function' && window.__aiEnabled) {
      const proceed = await new Promise((resolve) => {
        try {
          window.aiSanityCheck(
            {
              date: gigWizardData.date,
              start_time: gigWizardData.start_time,
              end_time: gigWizardData.end_time,
              venue_name: gigWizardData.venue_name,
              venue_address: gigWizardData.venue_address,
              fee: gigWizardData.fee ? parseFloat(gigWizardData.fee) : null,
              gig_type: gigWizardData.gig_type,
            },
            (ok) => resolve(!!ok)
          );
        } catch (_) { resolve(true); }
      });
      if (!proceed) {
        // #83: release the re-entry guard and restore the button so the
        // user can retry after cancelling the AI sanity check modal.
        window._gigWizardSubmitting = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = btn.dataset.origLabel || 'Save Gig';
        }
        return;
      }
      gigWizardData._forcedThroughSanityCheck = true;
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
      // Teaching-only fields: only send when gig type is Teaching, so a user
      // who typed a rate then switched gig type doesn't save ghost data.
      client_name: gigWizardData.gig_type === 'Teaching' ? (gigWizardData.client_name || null) : null,
      client_email: gigWizardData.gig_type === 'Teaching' ? (gigWizardData.client_email || null) : null,
      client_phone: gigWizardData.gig_type === 'Teaching' ? (gigWizardData.client_phone || null) : null,
      rate_per_hour:
        gigWizardData.gig_type === 'Teaching' && gigWizardData.rate_per_hour
          ? parseFloat(gigWizardData.rate_per_hour)
          : null,
      source: 'manual',
    };

    const response = await fetch('/api/gigs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      window._cachedGigs = null;
      persistCachedCalendar();
      showScreen('gigs');
      showToast('Gig saved!');
      // #83: release the re-entry guard now that the save has succeeded so
      // the next gig wizard session starts from a clean state.
      window._gigWizardSubmitting = false;
    } else {
      let errMsg = 'Unknown error';
      try {
        const err = await response.json();
        errMsg = err.error || errMsg;
      } catch (_) {
        // Server returned non-JSON (proxy down, HTML error page). Flag that
        // specifically so the user knows to retry rather than debug their input.
        errMsg = response.status === 404 || response.status === 502
          ? 'Server unavailable. Try again in a moment.'
          : `Server error ${response.status}`;
      }
      const body = document.getElementById('wizardBody');
      if (body) {
        body.insertAdjacentHTML(
          'afterbegin',
          `<div class="alert alert-error" style="margin-bottom: var(--spacing-4);">
            Failed to save: ${errMsg}
          </div>`
        );
      }
      if (typeof showToast === 'function') showToast('Gig not saved: ' + errMsg);
      if (btn) {
        btn.textContent = 'Save Gig';
        btn.disabled = false;
      }
      // #83: release the re-entry guard so the user can retry after a
      // server-side failure.
      window._gigWizardSubmitting = false;
    }
  } catch (error) {
    console.error('Submit gig error:', error);
    if (typeof showToast === 'function') {
      showToast('Gig not saved. Check your connection and try again.');
    }
    if (btn) {
      btn.textContent = 'Save Gig';
      btn.disabled = false;
    }
    // #83: release the re-entry guard so the user can retry after a
    // network / unexpected-exception failure.
    window._gigWizardSubmitting = false;
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
    { label: '\u{1F4DA} Teaching', value: 'Teaching' },
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
        <div id="fullFormTeachingBlock" style="display:${d.gig_type === 'Teaching' ? 'block' : 'none'};background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:16px;">
          <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">\u{1F4DA} Teaching details</div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;line-height:1.45;">Rate \u00D7 lesson duration sets the fee automatically.</div>
          <div class="form-group" style="margin-bottom:10px;">
            <label class="form-label">Student / client name</label>
            <input type="text" class="form-input" name="client_name" value="${escapeHtml(d.client_name || '')}" placeholder="e.g. Sam Patel">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="form-group" style="margin-bottom:10px;">
              <label class="form-label">Email</label>
              <input type="email" class="form-input" name="client_email" value="${escapeHtml(d.client_email || '')}" placeholder="sam@example.com">
            </div>
            <div class="form-group" style="margin-bottom:10px;">
              <label class="form-label">Phone</label>
              <input type="tel" class="form-input" name="client_phone" value="${escapeHtml(d.client_phone || '')}" placeholder="07...">
            </div>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Rate per hour (\u00A3)</label>
            <input type="number" class="form-input" name="rate_per_hour" value="${escapeHtml(String(d.rate_per_hour || ''))}" placeholder="35" min="0" step="1">
          </div>
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
    // Teaching-only fields: only send when gig type is Teaching. The form
    // inputs stay in the DOM even when hidden, so guard against stale values.
    if (data.gig_type !== 'Teaching') {
      data.client_name = null;
      data.client_email = null;
      data.client_phone = null;
      data.rate_per_hour = null;
    } else if (data.rate_per_hour) {
      data.rate_per_hour = parseFloat(data.rate_per_hour);
    }

    try {
      const response = await fetch('/api/gigs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (response.ok) {
        window._cachedGigs = null;
        persistCachedCalendar();
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
    // Open the full Invoices list screen (overdue/draft/sent/paid + "+ New").
    // The in-screen + New button opens panel-invoice for create; this pill is
    // the single entry point that gives access to both list and create paths.
    showScreen('invoices');
  } else if (action === 'block-date') {
    openPanel('panel-block');
  } else if (action === 'receipt') {
    openPanel('panel-receipt');
    initReceiptPanel();
  }
}

// ── Panel open / close ────────────────────────────────────────────────────────

function openPanel(id) {
  const el = document.getElementById(id);
  if (!el) { console.warn('openPanel: panel not found', id); return; }
  // Quick-action panels (.panel-keep-header) are launched from the bottom-nav menu
  // and should NEVER persist when the user navigates elsewhere. If any keep-header
  // panel is open, close it before opening the new panel. Without this:
  //  - Clicking a different bottom-row icon while a keep-header panel is open just
  //    stacks a second .open panel on top, leaving the user stuck on the first one.
  //  - Clicking a top-level nav target (profile, notifications, finance, chat) while
  //    on a keep-header panel would load that screen UNDERNEATH the keep-header panel,
  //    because both share z-index 100 and DOM order would win.
  document.querySelectorAll('.panel-overlay.panel-keep-header.open').forEach(function (other) {
    if (other !== el) other.classList.remove('open');
  });
  el.classList.add('open');
  // Trigger render for panels that need dynamic content
  if (id === 'profile-panel') { if (typeof renderProfileScreen === 'function') renderProfileScreen(); }
  if (id === 'panel-notifications') { if (typeof renderNotificationsPanel === 'function') renderNotificationsPanel(); }
  if (id === 'panel-finance') { if (typeof renderFinancePanel === 'function') renderFinancePanel(); }
  if (id === 'panel-chat-inbox') { if (typeof renderChatInbox === 'function') renderChatInbox(); }
  if (id === 'panel-notifications-settings') { if (typeof loadNotificationSettings === 'function') loadNotificationSettings(); }
  if (id === 'panel-dep') { if (typeof initDepPanel === 'function') initDepPanel(); }
  if (id === 'panel-teaching-term') { if (typeof initTeachingTermPanel === 'function') initTeachingTermPanel(); }
  if (id === 'panel-block') { if (typeof openMyAvailabilityPanel === 'function') openMyAvailabilityPanel(); }
  if (id === 'panel-add-contact') { if (typeof initAddContactPanel === 'function') initAddContactPanel(); }
}

// ── Teaching term (bulk weekly lesson creator) ──────────────────────────────

// State lives on window so the panel can be re-initialized cleanly.
window._teachingTerm = window._teachingTerm || null;

function initTeachingTermPanel() {
  const body = document.getElementById('teachingTermBody');
  if (!body) return;
  // Seed with sensible defaults the first time. On re-open, keep prior values
  // so a failed submit doesn't lose the user's inputs.
  if (!window._teachingTerm) {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 84); // default: 12 weeks
    const seed = window._teachingTermSeed || {};
    window._teachingTerm = {
      mode: 'weekly', // 'weekly' = from/to + weekday, 'dates' = explicit selected dates
      client_name: seed.client_name || '',
      client_email: seed.client_email || '',
      client_phone: seed.client_phone || '',
      venue_name: 'Lessons',
      venue_address: '',
      weekday: String(today.getDay()),
      start_time: '16:00',
      end_time: '17:00',
      rate_per_hour: seed.rate_per_hour || '',
      from_date: iso(today),
      to_date: iso(toDate),
      skip_dates: '',
      band_name: '',
      // Explicit-dates mode: picked dates as ISO yyyy-mm-dd, and the month
      // the mini calendar is currently viewing (YYYY-MM-01).
      selected_dates: [],
      cal_month: iso(new Date(today.getFullYear(), today.getMonth(), 1)),
    };
    // Consume the seed so reopening later doesn't overwrite user edits.
    window._teachingTermSeed = null;
  }
  renderTeachingTermPanel();
}

function renderTeachingTermPanel() {
  const body = document.getElementById('teachingTermBody');
  if (!body) return;
  const t = window._teachingTerm || {};
  const mode = t.mode === 'dates' ? 'dates' : 'weekly';
  const weekdays = [
    { v: '0', label: 'Sun' },
    { v: '1', label: 'Mon' },
    { v: '2', label: 'Tue' },
    { v: '3', label: 'Wed' },
    { v: '4', label: 'Thu' },
    { v: '5', label: 'Fri' },
    { v: '6', label: 'Sat' },
  ];

  const modeBlurb = mode === 'weekly'
    ? 'Set up a weekly lesson pattern, and we\u2019ll create one gig per session across the term.'
    : 'Pick any dates for this student. Useful when lessons don\u2019t fall on a fixed weekday.';

  const datesBlock = mode === 'weekly'
    ? `
      <div class="form-section-label">Repeats every</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">
        ${weekdays.map((d) => `
          <button type="button" class="day-btn${t.weekday === d.v ? ' active' : ''}" onclick="setTeachingTermWeekday('${d.v}')" style="${t.weekday === d.v ? 'background:var(--accent);color:#000;border-color:var(--accent);' : ''}">${d.label}</button>
        `).join('')}
      </div>

      <div class="form-section-label">Term dates</div>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <div style="flex:1;">
          <div class="form-label">From</div>
          <input type="date" class="form-input" id="ttFrom" value="${escapeAttr(t.from_date)}" oninput="updateTeachingTerm('from_date', this.value); renderTeachingTermPreview();">
        </div>
        <div style="flex:1;">
          <div class="form-label">To</div>
          <input type="date" class="form-input" id="ttTo" value="${escapeAttr(t.to_date)}" oninput="updateTeachingTerm('to_date', this.value); renderTeachingTermPreview();">
        </div>
      </div>
      <div class="form-label" style="margin-top:8px;">Skip dates (optional)</div>
      <input type="text" class="form-input" id="ttSkip" placeholder="e.g. 2026-05-25, 2026-06-01 (half term)" value="${escapeAttr(t.skip_dates)}" oninput="updateTeachingTerm('skip_dates', this.value); renderTeachingTermPreview();" style="margin-bottom:16px;">
    `
    : `
      <div class="form-section-label">Pick dates</div>
      ${renderTeachingTermMiniCalendar()}
      ${renderTeachingTermSelectedChips()}
    `;

  body.innerHTML = `
    <div style="font-size:12px;color:var(--text-2);margin-bottom:12px;line-height:1.5;">
      ${modeBlurb}
    </div>

    <div style="display:flex;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:3px;margin-bottom:16px;">
      <button type="button"
        onclick="setTeachingTermMode('weekly')"
        style="flex:1;padding:8px 10px;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;background:${mode === 'weekly' ? 'var(--accent)' : 'transparent'};color:${mode === 'weekly' ? '#000' : 'var(--text-2)'};">
        Weekly
      </button>
      <button type="button"
        onclick="setTeachingTermMode('dates')"
        style="flex:1;padding:8px 10px;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;background:${mode === 'dates' ? 'var(--accent)' : 'transparent'};color:${mode === 'dates' ? '#000' : 'var(--text-2)'};">
        Specific dates
      </button>
    </div>

    <div class="form-section-label">Student</div>
    <input type="text" class="form-input" id="ttClientName" placeholder="Name (required)" value="${escapeAttr(t.client_name)}" oninput="updateTeachingTerm('client_name', this.value)" style="margin-bottom:8px">
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <input type="email" class="form-input" id="ttClientEmail" placeholder="Email" value="${escapeAttr(t.client_email)}" oninput="updateTeachingTerm('client_email', this.value)" style="flex:1">
      <input type="tel" class="form-input" id="ttClientPhone" placeholder="Phone" value="${escapeAttr(t.client_phone)}" oninput="updateTeachingTerm('client_phone', this.value)" style="flex:1">
    </div>

    <div class="form-section-label">Where</div>
    <input type="text" class="form-input" id="ttVenueName" placeholder="e.g. Home studio, Student&rsquo;s house" value="${escapeAttr(t.venue_name)}" oninput="updateTeachingTerm('venue_name', this.value)" style="margin-bottom:8px">
    <input type="text" class="form-input" id="ttVenueAddress" placeholder="Address (optional)" value="${escapeAttr(t.venue_address)}" oninput="updateTeachingTerm('venue_address', this.value)" style="margin-bottom:16px">

    <div class="form-section-label">Time</div>
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <div style="flex:1;">
        <div class="form-label">Start</div>
        <input type="time" class="form-input" id="ttStart" value="${escapeAttr(t.start_time)}" oninput="updateTeachingTerm('start_time', this.value); renderTeachingTermPreview();">
      </div>
      <div style="flex:1;">
        <div class="form-label">End</div>
        <input type="time" class="form-input" id="ttEnd" value="${escapeAttr(t.end_time)}" oninput="updateTeachingTerm('end_time', this.value); renderTeachingTermPreview();">
      </div>
    </div>

    <div class="form-section-label">Rate per hour (\u00A3)</div>
    <input type="number" class="form-input" id="ttRate" min="0" step="1" inputmode="decimal" value="${escapeAttr(String(t.rate_per_hour || ''))}" placeholder="35" oninput="updateTeachingTerm('rate_per_hour', this.value); renderTeachingTermPreview();" style="margin-bottom:16px;">

    ${datesBlock}

    <div id="ttPreview" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:16px;font-size:13px;color:var(--text-2);"></div>

    <div id="ttError" class="alert alert-error" style="display:none;margin-bottom:12px;"></div>
    <button class="btn-pill" id="ttSubmitBtn" onclick="submitTeachingTerm()">Create lessons</button>
  `;
  renderTeachingTermPreview();
}

// Mini month calendar with click-to-toggle day cells. Used by the
// "Specific dates" mode of the teaching term panel.
function renderTeachingTermMiniCalendar() {
  const t = window._teachingTerm || {};
  const todayIso = new Date().toISOString().slice(0, 10);
  const month = t.cal_month || todayIso.slice(0, 7) + '-01';
  // cal_month is stored as YYYY-MM-01; parse in UTC so month arithmetic is stable.
  const anchor = new Date(month + 'T00:00:00Z');
  if (isNaN(anchor)) return '';
  const year = anchor.getUTCFullYear();
  const mon = anchor.getUTCMonth();
  const monthLabel = anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Build 6-row grid (42 cells), starting on Monday for UK users.
  // JS weekday: Sun=0..Sat=6. Convert to Mon=0..Sun=6 for grid offset.
  const first = new Date(Date.UTC(year, mon, 1));
  const firstWeekday = (first.getUTCDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate();
  const selected = new Set(Array.isArray(t.selected_dates) ? t.selected_dates : []);

  const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dayNum = i - firstWeekday + 1;
    if (dayNum < 1 || dayNum > daysInMonth) {
      cells.push(`<div style="padding:10px 0;"></div>`);
      continue;
    }
    const iso = `${year}-${String(mon + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const isSelected = selected.has(iso);
    const isToday = iso === todayIso;
    const bg = isSelected ? 'var(--accent)' : 'transparent';
    const color = isSelected ? '#000' : (isToday ? 'var(--accent)' : 'var(--text)');
    const border = isToday && !isSelected ? '1px solid var(--accent)' : '1px solid transparent';
    const fontWeight = isSelected || isToday ? '700' : '500';
    cells.push(`
      <button type="button"
        onclick="toggleTeachingTermDate('${iso}')"
        style="padding:8px 0;border-radius:8px;border:${border};background:${bg};color:${color};font-size:13px;font-weight:${fontWeight};cursor:pointer;text-align:center;min-height:34px;">
        ${dayNum}
      </button>
    `);
  }

  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <button type="button" onclick="stepTeachingTermMonth(-1)" style="background:transparent;border:none;color:var(--text-2);font-size:18px;cursor:pointer;padding:4px 10px;border-radius:6px;">&larr;</button>
        <div style="font-size:14px;font-weight:700;color:var(--text);">${escapeHtml(monthLabel)}</div>
        <button type="button" onclick="stepTeachingTermMonth(1)" style="background:transparent;border:none;color:var(--text-2);font-size:18px;cursor:pointer;padding:4px 10px;border-radius:6px;">&rarr;</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px;">
        ${dayLabels.map((d) => `<div style="text-align:center;font-size:11px;color:var(--text-3);padding:4px 0;">${d}</div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;">
        ${cells.join('')}
      </div>
    </div>
  `;
}

function renderTeachingTermSelectedChips() {
  const t = window._teachingTerm || {};
  const picked = Array.isArray(t.selected_dates) ? t.selected_dates.slice().sort() : [];
  if (picked.length === 0) {
    return `<div style="font-size:12px;color:var(--text-3);margin-bottom:16px;">Tap a day to select it. Tap again to unselect.</div>`;
  }
  const chips = picked.map((iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    const label = isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `
      <button type="button" onclick="toggleTeachingTermDate('${iso}')"
        style="display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#000;border:none;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;">
        ${escapeHtml(label)} <span style="opacity:0.7;font-weight:600;">\u2715</span>
      </button>
    `;
  }).join('');
  return `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
      ${chips}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div style="font-size:12px;color:var(--text-3);">${picked.length} date${picked.length === 1 ? '' : 's'} picked</div>
      <button type="button" onclick="clearTeachingTermDates()" style="background:transparent;border:none;color:var(--text-3);font-size:12px;cursor:pointer;text-decoration:underline;">Clear all</button>
    </div>
  `;
}

function updateTeachingTerm(key, value) {
  if (!window._teachingTerm) return;
  window._teachingTerm[key] = value;
}

function setTeachingTermWeekday(v) {
  if (!window._teachingTerm) return;
  window._teachingTerm.weekday = v;
  renderTeachingTermPanel();
}

function setTeachingTermMode(mode) {
  if (!window._teachingTerm) return;
  if (mode !== 'weekly' && mode !== 'dates') return;
  window._teachingTerm.mode = mode;
  renderTeachingTermPanel();
}

function toggleTeachingTermDate(iso) {
  const t = window._teachingTerm;
  if (!t) return;
  if (!Array.isArray(t.selected_dates)) t.selected_dates = [];
  const idx = t.selected_dates.indexOf(iso);
  if (idx === -1) t.selected_dates.push(iso);
  else t.selected_dates.splice(idx, 1);
  renderTeachingTermPanel();
}

function clearTeachingTermDates() {
  const t = window._teachingTerm;
  if (!t) return;
  t.selected_dates = [];
  renderTeachingTermPanel();
}

function stepTeachingTermMonth(delta) {
  const t = window._teachingTerm;
  if (!t) return;
  const cur = new Date((t.cal_month || new Date().toISOString().slice(0, 7) + '-01') + 'T00:00:00Z');
  if (isNaN(cur)) return;
  cur.setUTCMonth(cur.getUTCMonth() + delta);
  const y = cur.getUTCFullYear();
  const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
  t.cal_month = `${y}-${m}-01`;
  renderTeachingTermPanel();
}

// Build the list of lesson dates the term will produce, given the current
// inputs. Returns { dates, warnings, error }. Dates are ISO yyyy-mm-dd strings.
function computeTeachingTermDates() {
  const t = window._teachingTerm || {};
  const warnings = [];
  const MAX = 80;

  if (t.mode === 'dates') {
    const picked = Array.isArray(t.selected_dates) ? t.selected_dates.slice() : [];
    if (picked.length === 0) {
      return { dates: [], warnings, error: 'Tap at least one date on the calendar.' };
    }
    // Dedupe + sort so preview & payload are deterministic.
    const uniq = Array.from(new Set(picked)).sort();
    if (uniq.length > MAX) {
      return { dates: uniq.slice(0, MAX), warnings: [`Capped at ${MAX} lessons. Remove some dates or split into two terms.`], error: null };
    }
    return { dates: uniq, warnings, error: null };
  }

  // Weekly-pattern mode (original behaviour).
  if (!t.from_date || !t.to_date) return { dates: [], warnings, error: 'Pick from and to dates.' };
  const weekday = Number(t.weekday);
  if (!(weekday >= 0 && weekday <= 6)) return { dates: [], warnings, error: 'Pick a weekday.' };
  const from = new Date(t.from_date + 'T00:00:00Z');
  const to = new Date(t.to_date + 'T00:00:00Z');
  if (isNaN(from) || isNaN(to)) return { dates: [], warnings, error: 'Dates look invalid.' };
  if (to < from) return { dates: [], warnings, error: '\u201CTo\u201D date is before \u201Cfrom\u201D.' };

  // Parse skip dates (comma / newline / space separated).
  const skipSet = new Set(
    String(t.skip_dates || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const dates = [];
  // Walk forward from `from` to the first matching weekday.
  const cursor = new Date(from);
  while (cursor.getUTCDay() !== weekday && cursor <= to) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  while (cursor <= to && dates.length < MAX) {
    const iso = cursor.toISOString().slice(0, 10);
    if (!skipSet.has(iso)) dates.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  if (dates.length === MAX) warnings.push(`Capped at ${MAX} lessons. Split a long term into chunks.`);

  return { dates, warnings, error: null };
}

function renderTeachingTermPreview() {
  const preview = document.getElementById('ttPreview');
  if (!preview) return;
  const t = window._teachingTerm || {};
  const { dates, warnings, error } = computeTeachingTermDates();
  const rate = parseFloat(t.rate_per_hour);
  const feePerLesson = deriveTeachingFeeClient(t.start_time, t.end_time, rate);

  if (error) {
    preview.innerHTML = `<div style="color:var(--text-3);">${escapeHtml(error)}</div>`;
    return;
  }
  if (dates.length === 0) {
    preview.innerHTML = `<div style="color:var(--text-3);">No lessons fall in that date range on the chosen weekday.</div>`;
    return;
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  const lessonLabel = dates.length === 1 ? 'lesson' : 'lessons';
  const feeTotal = feePerLesson != null ? (feePerLesson * dates.length) : null;
  const feeLine = feePerLesson != null
    ? `<div style="color:var(--text);"><strong>\u00A3${feePerLesson.toFixed(2)}</strong> per lesson \u00B7 <strong>\u00A3${feeTotal.toFixed(2)}</strong> total for the term.</div>`
    : `<div style="color:var(--text-3);">Add a rate and times to see the fee.</div>`;
  const warnLine = warnings.length
    ? `<div style="color:var(--warning);font-size:11px;margin-top:6px;">\u26A0\uFE0F ${escapeHtml(warnings.join(' '))}</div>`
    : '';

  preview.innerHTML = `
    <div style="font-weight:700;color:var(--text);margin-bottom:4px;">${dates.length} ${lessonLabel}</div>
    <div style="color:var(--text-2);margin-bottom:6px;">${escapeHtml(first)} \u2192 ${escapeHtml(last)}</div>
    ${feeLine}
    ${warnLine}
  `;
}

async function submitTeachingTerm() {
  const t = window._teachingTerm || {};
  const btn = document.getElementById('ttSubmitBtn');
  const errEl = document.getElementById('ttError');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  // Client-side validation.
  if (!t.client_name || !t.client_name.trim()) {
    if (errEl) { errEl.textContent = 'Student name is required.'; errEl.style.display = 'block'; }
    return;
  }
  const rate = parseFloat(t.rate_per_hour);
  if (!rate || rate <= 0) {
    if (errEl) { errEl.textContent = 'Rate per hour must be greater than zero.'; errEl.style.display = 'block'; }
    return;
  }
  if (!t.start_time || !t.end_time) {
    if (errEl) { errEl.textContent = 'Lesson start and end times are required.'; errEl.style.display = 'block'; }
    return;
  }
  const { dates, error } = computeTeachingTermDates();
  if (error) {
    if (errEl) { errEl.textContent = error; errEl.style.display = 'block'; }
    return;
  }
  if (dates.length === 0) {
    if (errEl) { errEl.textContent = 'No lessons fall in that date range on the chosen weekday.'; errEl.style.display = 'block'; }
    return;
  }

  if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }

  const isDatesMode = t.mode === 'dates';
  const payload = {
    client_name: t.client_name.trim(),
    client_email: (t.client_email || '').trim() || null,
    client_phone: (t.client_phone || '').trim() || null,
    band_name: (t.band_name || t.client_name || '').trim(),
    venue_name: (t.venue_name || 'Lessons').trim(),
    venue_address: (t.venue_address || '').trim() || null,
    start_time: t.start_time,
    end_time: t.end_time,
    rate_per_hour: rate,
  };
  if (isDatesMode) {
    // Specific-dates mode: server ignores weekly fields when `dates` is present.
    payload.dates = dates;
  } else {
    payload.weekday = Number(t.weekday);
    payload.from_date = t.from_date;
    payload.to_date = t.to_date;
    payload.skip_dates = String(t.skip_dates || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  try {
    const resp = await fetch('/api/gigs/teaching-term', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      let msg = 'Failed to create lessons';
      try { const err = await resp.json(); msg = err.error || msg; } catch (_) {}
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
      if (btn) { btn.textContent = 'Create lessons'; btn.disabled = false; }
      return;
    }
    const result = await resp.json();
    // Refresh the gig cache so the new lessons show up everywhere.
    window._cachedGigs = null;

    // If the server reports partial failures, keep the panel open so the user
    // sees which dates didn't take rather than silently losing them. This is
    // the fix for the "I added a bunch of dates, only some appeared" bug.
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const requested = Number(result.requested || dates.length);
    const count = Number(result.count || 0);
    if (failed.length > 0) {
      const sample = failed.slice(0, 3).map((f) => f.date).join(', ');
      const extra = failed.length > 3 ? ` +${failed.length - 3} more` : '';
      if (errEl) {
        errEl.textContent = `Added ${count} of ${requested} lessons. Failed on ${sample}${extra}. Try again with just those dates.`;
        errEl.style.display = 'block';
      }
      if (btn) { btn.textContent = 'Create lessons'; btn.disabled = false; }
      // Refresh gigs cache so the ones that did land show up, but keep the
      // panel open.
      if (typeof renderGigsScreen === 'function') {
        try { renderGigsScreen(); } catch (_) {}
      }
      return;
    }

    closePanel('panel-teaching-term');
    window._teachingTerm = null;
    // Re-render whichever gigs-adjacent screen the user came from.
    const gigsVisible =
      document.getElementById('gigsScreen') &&
      document.getElementById('gigsScreen').style.display !== 'none';
    if (gigsVisible && typeof renderGigsScreen === 'function') {
      renderGigsScreen();
    } else if (typeof renderCalendarScreen === 'function') {
      // Calendar pulls from the same cache, refresh it too so lessons appear.
      try { renderCalendarScreen(); } catch (_) {}
    }
    if (typeof showToast === 'function') {
      showToast(`${count || dates.length} lessons added.`);
    }
  } catch (e) {
    console.error('submitTeachingTerm:', e);
    if (errEl) { errEl.textContent = 'Network error. Try again.'; errEl.style.display = 'block'; }
    if (btn) { btn.textContent = 'Create lessons'; btn.disabled = false; }
  }
}

// ── Notifications Panel ─────────────────────────────────────────────────────
//
// Perf note: the panel used to block on both /api/notifications AND
// /api/calendar/events (which hits the Google Calendar API + Haiku AI
// classifier) before painting. That made the bell feel like it took 3-5s to
// open. New flow:
//   1. Paint server notifications immediately (fast DB query).
//   2. If the calendar-nudge cache is fresh (<60s), fold it in on first paint.
//   3. Otherwise fire the nudge fetch in the background and re-render just
//      the nudge card when it arrives. The user sees the panel open instantly.
async function renderNotificationsPanel() {
  const body = document.getElementById('notificationsPanelBody');
  if (!body) return;

  // Cached nudges are free — use them for the first paint if fresh.
  const cacheFresh = Array.isArray(window._calendarNudges)
    && (Date.now() - (window._calendarNudgesFetchedAt || 0)) < 60 * 1000;
  const cachedNudges = cacheFresh ? window._calendarNudges : null;

  try {
    const notifResp = await fetch('/api/notifications').then(r => r.json()).catch(() => []);
    const notifications = Array.isArray(notifResp) ? notifResp : [];

    paintNotificationsPanel(body, notifications, cachedNudges);

    // If we don't have fresh nudges cached, fetch them in the background and
    // re-render only when they arrive. We never block the open on this.
    if (!cacheFresh) {
      loadCalendarNudges()
        .then((nudges) => {
          // Body may have been replaced by the time this resolves (user closed
          // and reopened panel). Only re-paint if the same element is still
          // mounted with our notifications view.
          const stillMounted = document.getElementById('notificationsPanelBody');
          if (!stillMounted) return;
          paintNotificationsPanel(stillMounted, notifications, Array.isArray(nudges) ? nudges : []);
        })
        .catch(() => {}); // silent — the panel already rendered fine without them
    }
  } catch (err) {
    console.error('Notifications panel error:', err);
    body.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Couldn't load notifications. Pull to retry.</div>`;
  }
}

// Split out of renderNotificationsPanel so the async nudge fetch can re-paint
// in place without re-running the server notifications fetch.
function paintNotificationsPanel(body, notifications, nudges) {
  const nudgeCount = Array.isArray(nudges) ? nudges.length : 0;
  const nudgeCardHTML = nudgeCount > 0 ? buildNudgeEntryCard(nudgeCount) : '';

  if (notifications.length === 0 && nudgeCount === 0) {
    body.innerHTML = `
      <div style="padding:60px 24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:12px;">🔔</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:6px;">You're all caught up</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.5;">New gig offers, upcoming gigs and payment updates will show up here.</div>
      </div>`;
    const dot = document.getElementById('notificationDot');
    if (dot) dot.style.display = 'none';
    return;
  }

  const dismissed = JSON.parse(localStorage.getItem('dismissedNotifications') || '[]');
  const visible = notifications.filter((n) => !dismissed.includes(notifKey(n)));

  if (visible.length === 0 && nudgeCount === 0) {
    body.innerHTML = `
      <div style="padding:60px 24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:12px;">🔔</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:6px;">You're all caught up</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.5;">Cleared notifications will come back when something new happens.</div>
      </div>`;
    return;
  }

  visible.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  body.innerHTML = `<div style="padding:10px 14px;">${nudgeCardHTML}${visible.map(buildNotifCard).join('')}</div>`;

  const dot = document.getElementById('notificationDot');
  if (dot) dot.style.display = (visible.length + nudgeCount) > 0 ? 'block' : 'none';
}

// BUG #3 fix: entry point card surfaced in the bell panel. Tapping it opens
// the same Gig Nudge overlay the Calendar screen banner already uses.
function buildNudgeEntryCard(count) {
  const label = `${count} calendar event${count === 1 ? '' : 's'} look${count === 1 ? 's' : ''} like gig${count === 1 ? '' : 's'}`;
  return `
    <div style="position:relative;background:linear-gradient(135deg,rgba(240,165,0,.12),transparent);border:1px solid rgba(240,165,0,.4);border-radius:12px;padding:12px 14px;margin-bottom:10px;cursor:pointer;" onclick="closePanel('panel-notifications');openGigNudge();">
      <div style="font-size:22px;margin-bottom:6px;">📅</div>
      <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${label}</div>
      <div style="font-size:13px;color:var(--text-2);line-height:1.5;margin-bottom:8px;">We spotted events in your Google Calendar that might be gigs. Review them now.</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <button onclick="event.stopPropagation();closePanel('panel-notifications');openGigNudge();" style="background:var(--accent);color:#000;border:none;border-radius:10px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;">Review</button>
        <div style="font-size:11px;color:var(--text-3);">Calendar</div>
      </div>
    </div>`;
}

function notifKey(n) {
  return `${n.type}:${n.action_type || ''}:${n.action_id || ''}:${n.timestamp || ''}`;
}

function buildNotifCard(n) {
  const key = notifKey(n);
  const ts = formatNotifTime(n.timestamp);
  let icon = '🔔';
  let borderColor = 'var(--border)';
  let bg = 'var(--card)';
  let actionHTML = '';

  switch (n.type) {
    case 'gig':
      icon = '📅';
      borderColor = 'rgba(88,166,255,.25)';
      actionHTML = n.action_id
        ? `<button onclick="openGigDetail('${n.action_id}');closePanel('panel-notifications');" style="background:var(--accent);color:#000;border:none;border-radius:10px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;">View gig</button>`
        : '';
      break;
    case 'invoice':
      icon = '💷';
      borderColor = 'rgba(248,81,73,.35)';
      bg = 'linear-gradient(135deg,rgba(248,81,73,.08),transparent)';
      actionHTML = n.action_id
        ? `<button onclick="openInvoiceDetail('${n.action_id}');closePanel('panel-notifications');" style="background:var(--accent);color:#000;border:none;border-radius:10px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;">View invoice</button>`
        : '';
      break;
    case 'offer':
      icon = '💤';
      borderColor = 'rgba(240,165,0,.4)';
      bg = 'linear-gradient(135deg,rgba(240,165,0,.08),transparent)';
      actionHTML = `<button onclick="showScreen('offers');closePanel('panel-notifications');" style="background:var(--accent);color:#000;border:none;border-radius:10px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;">View offer</button>`;
      break;
    case 'document':
      icon = '📄';
      // Red when expired or within 7 days, amber for 30-day warning.
      if (n.action_type === 'document_expired' || n.action_type === 'document_expiring_7') {
        borderColor = 'rgba(248,81,73,.35)';
        bg = 'linear-gradient(135deg,rgba(248,81,73,.08),transparent)';
      } else {
        borderColor = 'rgba(240,165,0,.35)';
        bg = 'linear-gradient(135deg,rgba(240,165,0,.08),transparent)';
      }
      actionHTML = n.action_id
        ? `<button onclick="openPanel('panel-documents'); openDocumentsPanel(); setTimeout(() => openDocumentForm('${n.action_id}'), 100); closePanel('panel-notifications');" style="background:var(--accent);color:#000;border:none;border-radius:10px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;">View document</button>`
        : '';
      break;
  }

  return `
    <div style="position:relative;background:${bg};border:1px solid ${borderColor};border-radius:12px;padding:12px 14px;margin-bottom:10px;">
      <button onclick="dismissNotification('${escapeHtml(key)}')" style="position:absolute;top:8px;right:10px;background:none;border:none;color:var(--text-3);font-size:14px;cursor:pointer;">✕</button>
      <div style="font-size:22px;margin-bottom:6px;">${icon}</div>
      <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px;">${escapeHtml(n.title || '')}</div>
      <div style="font-size:13px;color:var(--text-2);line-height:1.5;margin-bottom:8px;">${escapeHtml(n.subtitle || '')}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        ${actionHTML || '<div></div>'}
        <div style="font-size:11px;color:var(--text-3);">${ts}</div>
      </div>
    </div>`;
}

function formatNotifTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffHours = Math.abs(diffMs) / (1000 * 60 * 60);
    if (diffMs < 0) {
      const futureDays = Math.ceil(-diffMs / (1000 * 60 * 60 * 24));
      if (futureDays <= 2) return `in ${futureDays} day${futureDays === 1 ? '' : 's'}`;
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }
    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch (e) {
    return '';
  }
}

function dismissNotification(key) {
  const dismissed = JSON.parse(localStorage.getItem('dismissedNotifications') || '[]');
  if (!dismissed.includes(key)) {
    dismissed.push(key);
    localStorage.setItem('dismissedNotifications', JSON.stringify(dismissed));
  }
  // S8-05: persist server-side so dismissals sync across devices and survive
  // localStorage wipes. localStorage stays as an offline-first mirror so the
  // UI reacts immediately even if the fetch fails.
  fetch('/api/notifications/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  }).catch(() => {});
  renderNotificationsPanel();
}

function clearAllNotifications() {
  // Get current list, mark all visible keys as dismissed
  fetch('/api/notifications').then((r) => r.json()).then((list) => {
    if (!Array.isArray(list)) return;
    const dismissed = JSON.parse(localStorage.getItem('dismissedNotifications') || '[]');
    const keys = [];
    list.forEach((n) => {
      const k = notifKey(n);
      if (!dismissed.includes(k)) dismissed.push(k);
      keys.push(k);
    });
    localStorage.setItem('dismissedNotifications', JSON.stringify(dismissed));
    // S8-05: bulk-persist dismissals on the server.
    if (keys.length) {
      fetch('/api/notifications/dismiss-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      }).catch(() => {});
    }
    const dot = document.getElementById('notificationDot');
    if (dot) dot.style.display = 'none';
    renderNotificationsPanel();
  }).catch(() => {});
}

window.dismissNotification = dismissNotification;
window.clearAllNotifications = clearAllNotifications;
window.renderNotificationsPanel = renderNotificationsPanel;

// ── Documents & Certs Panel ─────────────────────────────────────────────────
// Shows a list of uploaded certs (DBS, PLI, risk assessments, etc). Colour-
// coded expiry badge: grey when no expiry, green 30d+, amber 7-30d, red
// when <=7d or expired. Upload form supports file replacement so a renewed
// cert keeps its history row but gets a fresh PDF.

const DOC_TYPE_LABELS = {
  dbs: 'DBS certificate',
  pli: 'Public liability insurance',
  risk_assessment: 'Risk assessment',
  insurance: 'Other insurance',
  qualification: 'Qualification',
  other: 'Other document',
};

function _docExpiryBadge(expiry) {
  if (!expiry) return { label: 'No expiry', bg: 'rgba(160,160,160,.18)', color: 'var(--text-2)' };
  const expMs = new Date(String(expiry).slice(0, 10) + 'T00:00:00Z').getTime();
  const now = Date.now();
  const days = Math.round((expMs - now) / (24 * 60 * 60 * 1000));
  if (days < 0) return { label: `Expired ${Math.abs(days)}d ago`, bg: 'rgba(248,81,73,.18)', color: '#f85149' };
  if (days === 0) return { label: 'Expires today', bg: 'rgba(248,81,73,.18)', color: '#f85149' };
  if (days <= 7) return { label: `${days}d left`, bg: 'rgba(248,81,73,.18)', color: '#f85149' };
  if (days <= 30) return { label: `${days}d left`, bg: 'rgba(240,165,0,.18)', color: '#f0a500' };
  return { label: `${days}d left`, bg: 'rgba(46,204,113,.18)', color: '#2ecc71' };
}

function _docFmtDate(d) {
  if (!d) return '';
  try {
    const dt = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) { return ''; }
}

async function openDocumentsPanel() {
  const body = document.getElementById('documentsBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading documents...</div>';
  try {
    const res = await fetch('/api/documents');
    const data = res.ok ? await res.json() : { documents: [] };
    const docs = Array.isArray(data.documents) ? data.documents : [];

    let html = `
      <div style="padding:14px 16px;">
        <div style="font-size:12px;color:var(--text-2);line-height:1.5;margin-bottom:12px;">
          Store your DBS, PLI, risk assessments and other certs. Add an expiry date and TrackMyGigs will remind you 30 and 7 days before and on the day.
        </div>
        <button onclick="openDocumentForm()" class="pill" style="margin-bottom:14px;">+ Upload document</button>`;

    if (docs.length === 0) {
      html += `
        <div style="padding:30px 16px;text-align:center;color:var(--text-2);border:1px dashed var(--border);border-radius:var(--r);">
          <div style="font-size:28px;margin-bottom:8px;">📄</div>
          <div style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:4px;">No documents yet</div>
          <div style="font-size:12px;line-height:1.5;">Upload your first cert and it will show up here with a colour-coded expiry.</div>
        </div>`;
    } else {
      html += docs.map(d => {
        const badge = _docExpiryBadge(d.expiry_date);
        const typeLabel = DOC_TYPE_LABELS[d.doc_type] || DOC_TYPE_LABELS.other;
        const expiryText = d.expiry_date ? `Expires ${_docFmtDate(d.expiry_date)}` : 'No expiry set';
        return `
        <div onclick="openDocumentDetail('${escapeHtml(d.id)}')" style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;margin-bottom:10px;cursor:pointer;">
          <div style="display:flex;align-items:start;justify-content:space-between;gap:10px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:2px;">${escapeHtml(d.name)}</div>
              <div style="font-size:11px;color:var(--text-2);margin-bottom:6px;">${escapeHtml(typeLabel)}</div>
              <div style="font-size:12px;color:var(--text-2);">${expiryText}</div>
            </div>
            <div style="background:${badge.bg};color:${badge.color};font-size:11px;font-weight:700;padding:4px 8px;border-radius:999px;white-space:nowrap;">${badge.label}</div>
          </div>
        </div>`;
      }).join('');
    }

    html += `</div>`;
    body.innerHTML = html;
  } catch (err) {
    console.error('Documents panel error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load documents</div>';
  }
}

function openDocumentForm(docId) {
  const body = document.getElementById('documentFormBody');
  const title = document.getElementById('documentFormTitle');
  if (!body) return;
  if (title) title.textContent = docId ? 'Edit document' : 'Upload document';
  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading...</div>';
  openPanel('panel-document-form');

  const buildForm = (doc) => {
    const isEdit = !!doc;
    const typeOptions = Object.entries(DOC_TYPE_LABELS)
      .map(([k, v]) => `<option value="${k}" ${doc && doc.doc_type === k ? 'selected' : ''}>${v}</option>`)
      .join('');
    const clamp = (v) => (v ? String(v).slice(0, 10) : '');
    body.innerHTML = `
      <div style="padding:14px 16px;">
        <form id="docForm" onsubmit="saveDocument(event, ${isEdit ? `'${escapeHtml(doc.id)}'` : 'null'})">
          <div style="margin-bottom:12px;">
            <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Name *</label>
            <input id="docName" class="fi" required maxlength="255" placeholder="e.g. Enhanced DBS, PLI 2026" value="${isEdit ? escapeHtml(doc.name) : ''}" />
          </div>
          <div style="margin-bottom:12px;">
            <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Type</label>
            <select id="docType" class="fi">${typeOptions}</select>
          </div>
          <div style="display:flex;gap:10px;margin-bottom:12px;">
            <div style="flex:1;">
              <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Issue date</label>
              <input id="docIssued" type="date" class="fi" value="${isEdit ? clamp(doc.issued_date) : ''}" />
            </div>
            <div style="flex:1;">
              <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Expiry date</label>
              <input id="docExpiry" type="date" class="fi" value="${isEdit ? clamp(doc.expiry_date) : ''}" />
            </div>
          </div>
          <div style="margin-bottom:12px;">
            <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">File ${isEdit ? '(leave blank to keep existing)' : ''}</label>
            <input id="docFile" type="file" accept="application/pdf,image/*" style="display:block;width:100%;padding:10px;background:var(--card);border:1px dashed var(--border);border-radius:var(--rs);color:var(--text-2);font-size:12px;cursor:pointer;" />
            ${isEdit && doc.has_file ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px;">Current file: ${escapeHtml(doc.file_name || 'document')}</div>` : ''}
          </div>
          <div style="margin-bottom:16px;">
            <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;">Notes</label>
            <textarea id="docNotes" class="fi" rows="3" maxlength="2000" placeholder="Policy number, reference, renewal contact">${isEdit ? escapeHtml(doc.notes || '') : ''}</textarea>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="submit" class="pill" id="docSaveBtn">${isEdit ? 'Save changes' : 'Upload'}</button>
            ${isEdit ? `<button type="button" onclick="deleteDocument('${escapeHtml(doc.id)}')" style="background:transparent;color:#f85149;border:1px solid rgba(248,81,73,.4);border-radius:999px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;">Delete</button>` : ''}
          </div>
        </form>
      </div>`;
  };

  if (docId) {
    fetch(`/api/documents/${docId}`).then(r => r.json()).then(data => {
      if (!data || !data.document) throw new Error('not found');
      buildForm(data.document);
    }).catch(() => { body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load document</div>'; });
  } else {
    buildForm(null);
  }
}

async function openDocumentDetail(docId) {
  // Simple flow: open the edit form so users can update metadata, replace the
  // file, or delete. A read-only detail screen would be nice-to-have but the
  // form already shows everything.
  openDocumentForm(docId);
}

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function saveDocument(ev, docId) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const btn = document.getElementById('docSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    const name = (document.getElementById('docName').value || '').trim();
    if (!name) { alert('Give the document a name.'); if (btn) { btn.disabled = false; btn.textContent = docId ? 'Save changes' : 'Upload'; } return; }
    const doc_type = document.getElementById('docType').value;
    const issued_date = document.getElementById('docIssued').value || null;
    const expiry_date = document.getElementById('docExpiry').value || null;
    const notes = document.getElementById('docNotes').value || '';
    const fileEl = document.getElementById('docFile');
    const file = fileEl && fileEl.files && fileEl.files[0];
    const payload = { name, doc_type, issued_date, notes };
    // Explicit clear when user wipes the expiry on edit.
    if (docId && !expiry_date) payload.clear_expiry = true;
    else payload.expiry_date = expiry_date;
    if (file) {
      if (file.size > 8 * 1024 * 1024) {
        alert('File is too big. Max 8MB.');
        if (btn) { btn.disabled = false; btn.textContent = docId ? 'Save changes' : 'Upload'; }
        return;
      }
      payload.file_base64 = await _fileToBase64(file);
      payload.file_name = file.name;
      payload.mime_type = file.type || 'application/octet-stream';
    }
    const url = docId ? `/api/documents/${docId}` : '/api/documents';
    const method = docId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Save failed');
    }
    closePanel('panel-document-form');
    await openDocumentsPanel();
    await refreshDocsExpiryDot();
  } catch (err) {
    console.error('Save document error:', err);
    alert(err.message || 'Save failed');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = docId ? 'Save changes' : 'Upload'; }
  }
}

async function deleteDocument(docId) {
  if (!docId) return;
  if (!confirm('Delete this document? The file and all its reminders will be removed.')) return;
  try {
    const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed');
    closePanel('panel-document-form');
    await openDocumentsPanel();
    await refreshDocsExpiryDot();
  } catch (err) {
    console.error('Delete document error:', err);
    alert('Failed to delete');
  }
}

// Red dot on the Profile row — visible if any doc is within 7 days or expired.
async function refreshDocsExpiryDot() {
  try {
    const res = await fetch('/api/documents');
    if (!res.ok) return;
    const data = await res.json();
    const docs = Array.isArray(data.documents) ? data.documents : [];
    const now = Date.now();
    const hasRed = docs.some(d => {
      if (!d.expiry_date) return false;
      const expMs = new Date(String(d.expiry_date).slice(0, 10) + 'T00:00:00Z').getTime();
      const days = Math.round((expMs - now) / (24 * 60 * 60 * 1000));
      return days <= 7;
    });
    const dot = document.getElementById('docsExpiryDot');
    if (dot) dot.style.display = hasRed ? 'inline-block' : 'none';
  } catch (e) { /* silent */ }
}

window.openDocumentsPanel = openDocumentsPanel;
window.openDocumentForm = openDocumentForm;
window.openDocumentDetail = openDocumentDetail;
window.saveDocument = saveDocument;
window.deleteDocument = deleteDocument;
window.refreshDocsExpiryDot = refreshDocsExpiryDot;

// ── My Availability Panel ───────────────────────────────────────────────────
// Full-screen 12-month tap-to-toggle availability grid, rendered in the same
// visual language as the public /share/:slug page. Tapping a free day blocks
// it, tapping a manually-blocked day unblocks it, tapping a gig day surfaces
// a toast (gig-owned dates can only be changed by editing the gig itself).
const _myAvailState = { blockedMap: new Map(), bookedSet: new Set(), ownerSet: new Set() };

async function openMyAvailabilityPanel() {
  const body = document.getElementById('myAvailabilityBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading availability...</div>';

  try {
    // Fire in parallel: gigs (for booked dates), blocked rows, and slug (for URL hint).
    const [gigsRes, blockedRes, slug] = await Promise.all([
      fetch('/api/gigs').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/blocked-dates').then(r => r.ok ? r.json() : []).catch(() => []),
      _ensurePublicSlug(),
    ]);

    const gigs = Array.isArray(gigsRes) ? gigsRes : (gigsRes.gigs || []);
    const blocked = Array.isArray(blockedRes) ? blockedRes : [];

    // Map of dateStr → { id, expanded_dates_len } so unblock knows which row
    // to delete and whether it's part of a recurring/range pattern.
    const blockedMap = new Map();
    blocked.forEach(row => {
      const dates = Array.isArray(row.expanded_dates) && row.expanded_dates.length > 0
        ? row.expanded_dates
        : [(row.start_date || row.date || '').slice(0, 10)];
      dates.forEach(d => {
        if (d) blockedMap.set(d, { id: row.id, size: dates.length });
      });
    });

    const bookedSet = new Set(gigs.map(g => String(g.date || '').slice(0, 10)).filter(Boolean));
    _myAvailState.blockedMap = blockedMap;
    _myAvailState.bookedSet = bookedSet;

    const origin = window.location.origin;
    const slugUrl = slug ? `${origin}/share/${slug}` : '';

    let html = `
      <style>
        .avail-legend { display:flex; gap:16px; font-size:11px; color:var(--text-2); justify-content:center; margin:4px 0 12px; flex-wrap:wrap; }
        .avail-legend span { display:flex; align-items:center; gap:6px; }
        .avail-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
        .avail-month-label { font-size:13px; font-weight:700; color:var(--text); margin:18px 4px 8px; letter-spacing:.3px; }
        .avail-grid { display:grid; grid-template-columns: repeat(7, 1fr); gap:4px; }
        .avail-hd { font-size:10px; font-weight:600; color:var(--text-3); text-align:center; text-transform:uppercase; letter-spacing:.5px; padding:4px 0; }
        .avail-cell { aspect-ratio:1; display:flex; align-items:center; justify-content:center; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; user-select:none; transition: transform .05s ease, opacity .1s ease; }
        .avail-cell:active { transform: scale(.92); }
        .avail-cell.free { background:var(--card); border:1px solid var(--border); color:var(--text); }
        .avail-cell.blocked { background:var(--danger); color:#fff; border:1px solid var(--danger); }
        .avail-cell.booked { background:var(--info-dim); color:var(--info); border:1px solid var(--info); cursor:not-allowed; }
        .avail-cell.past { opacity:.3; cursor:not-allowed; }
        .avail-empty { aspect-ratio:1; }
      </style>
      <div style="padding:14px 16px 80px;">
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;margin-bottom:12px;">
          <div style="font-size:12px;color:var(--text-2);line-height:1.5;">
            Tap a free day to block it. Tap a blocked day to unblock. Gig days are locked.
          </div>
          ${slugUrl ? `
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <span style="font-size:11px;color:var(--text-3);">Share your availability with bookers</span>
            <button onclick="shareAvailability()" style="background:var(--accent);border:none;color:#000;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">Share link</button>
          </div>` : ''}
        </div>

        <div class="avail-legend">
          <span><span class="avail-dot" style="background:var(--card);border:1px solid var(--border);"></span>Free</span>
          <span><span class="avail-dot" style="background:var(--info);"></span>Gig</span>
          <span><span class="avail-dot" style="background:var(--danger);"></span>Blocked</span>
        </div>

        <div id="myAvailMonths"></div>
      </div>`;

    body.innerHTML = html;
    _renderAvailabilityMonths();

    // If the user opened this panel from a specific day (via the day action sheet's
    // Block date button), that date is queued on window._prefillBlockDate. Auto-block
    // it now — tapping "Block date" from a specific day is an explicit enough intent
    // that a second tap on the calendar would be redundant. If the date is already a
    // gig day, toggleAvailabilityDate surfaces the "edit the gig" toast; if it's
    // already blocked, it's a no-op (user-safe: ends in the same state).
    const prefill = window._prefillBlockDate;
    window._prefillBlockDate = null;
    if (prefill) {
      const state = _myAvailState.bookedSet.has(prefill)
        ? 'booked'
        : (_myAvailState.blockedMap.has(prefill) ? 'blocked' : 'free');
      if (state === 'free') toggleAvailabilityDate(prefill, 'free');
      else if (state === 'booked') showToast('This date has a gig. Edit the gig to change it.');
    }
  } catch (err) {
    console.error('Availability panel error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load availability</div>';
  }
}

function _renderAvailabilityMonths() {
  const container = document.getElementById('myAvailMonths');
  if (!container) return;
  const today = new Date();
  const startYear = today.getFullYear();
  const startMonth = today.getMonth();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let html = '';
  for (let offset = 0; offset < 12; offset++) {
    const first = new Date(startYear, startMonth + offset, 1);
    const monthLabel = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const firstDow = (first.getDay() + 6) % 7; // Mon-first

    let cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => `<div class="avail-hd">${d}</div>`).join('');
    for (let i = 0; i < firstDow; i++) cells += `<div class="avail-empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isPast = dateStr < todayIso;
      let cls = 'free';
      let state = 'free';
      if (_myAvailState.bookedSet.has(dateStr)) { cls = 'booked'; state = 'booked'; }
      else if (_myAvailState.blockedMap.has(dateStr)) { cls = 'blocked'; state = 'blocked'; }
      if (isPast) cls += ' past';
      const clickHandler = isPast ? '' : `onclick="toggleAvailabilityDate('${dateStr}','${state}')"`;
      cells += `<div class="avail-cell ${cls}" ${clickHandler}>${d}</div>`;
    }
    html += `<div class="avail-month-label">${monthLabel}</div><div class="avail-grid">${cells}</div>`;
  }
  container.innerHTML = html;
}

async function toggleAvailabilityDate(dateStr, currentState) {
  if (currentState === 'booked') {
    showToast('This date has a gig. Edit the gig to change it.');
    return;
  }
  try {
    if (currentState === 'free') {
      const res = await fetch('/api/blocked-dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'single', date: dateStr }),
      });
      if (!res.ok) throw new Error('block failed');
      // Optimistically update local state so re-render is instant.
      _myAvailState.blockedMap.set(dateStr, { id: null, size: 1 });
      // Refetch blocked rows in the background so the id is filled in for
      // subsequent unblock taps without blocking the UI.
      fetch('/api/blocked-dates').then(r => r.ok ? r.json() : []).then(rows => {
        const m = new Map();
        (Array.isArray(rows) ? rows : []).forEach(row => {
          const dates = Array.isArray(row.expanded_dates) && row.expanded_dates.length > 0
            ? row.expanded_dates
            : [(row.start_date || row.date || '').slice(0, 10)];
          dates.forEach(d => { if (d) m.set(d, { id: row.id, size: dates.length }); });
        });
        _myAvailState.blockedMap = m;
        _renderAvailabilityMonths();
      }).catch(() => {});
      _renderAvailabilityMonths();
    } else if (currentState === 'blocked') {
      const entry = _myAvailState.blockedMap.get(dateStr);
      if (!entry || !entry.id) {
        showToast('Still saving — try again in a moment.');
        return;
      }
      if (entry.size > 1) {
        if (!confirm('This date is part of a recurring or range block. Unblock the whole pattern?')) return;
      }
      const res = await fetch(`/api/blocked-dates/${entry.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('unblock failed');
      // Remove every date that shared this id (handles pattern rows cleanly).
      for (const [d, v] of _myAvailState.blockedMap.entries()) {
        if (v.id === entry.id) _myAvailState.blockedMap.delete(d);
      }
      _renderAvailabilityMonths();
    }
  } catch (err) {
    console.error('Toggle availability error:', err);
    showToast('Could not update — try again.');
  }
}

window.openMyAvailabilityPanel = openMyAvailabilityPanel;
window.toggleAvailabilityDate = toggleAvailabilityDate;

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('Copied'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    toast('Copied');
  }
}

function toast(msg) {
  let t = document.getElementById('toastMessage');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastMessage';
    t.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;opacity:0;transition:opacity .2s;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
}

window.copyToClipboard = copyToClipboard;
window.toast = toast;

// ── Monthly Insight: deterministic 12-variation generator ───────────────────
// Replaces the Haiku-backed Monthly Insight card. Reads the month's gigs,
// invoices and expenses from /api/finance/month-detail and renders a narrative
// card whose tone rotates through 12 voices. Rotation index is
//   ((year * 5 + month) % 12 + 12) % 12
// 5 is coprime with 12, so the same calendar month drifts +5 slots each year
// and a given voice won't repeat for 12 years. Highlights and suggestions are
// rule-based per scenario (EMPTY / LIGHT / STEADY / BUSY). No AI calls.
(function () {
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const INSIGHT_GBP = new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'GBP',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
  const money = (n) => INSIGHT_GBP.format(Math.round(Number(n) || 0));

  function escH(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function joinVenues(venues, max) {
    const uniq = Array.from(new Set((venues || []).filter(Boolean)));
    if (!uniq.length) return '';
    const cap = max || 2;
    if (uniq.length === 1) return uniq[0];
    if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
    if (uniq.length <= cap + 1) {
      return uniq.slice(0, -1).join(', ') + ' and ' + uniq[uniq.length - 1];
    }
    const head = uniq.slice(0, cap).join(', ');
    const rest = uniq.length - cap;
    return `${head}, and ${rest} other venue${rest === 1 ? '' : 's'}`;
  }

  // Build a normalised context object from raw payload.
  function buildInsightContext(payload) {
    const year = payload.year || new Date().getFullYear();
    const month = payload.month || (new Date().getMonth() + 1);
    const gigs = payload.gigs || [];
    const invoices = payload.invoices || [];
    const expenses = payload.expenses || [];

    const totalFees = gigs.reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const net = totalFees - totalExpenses;

    const paidCount = invoices.filter((i) => (i.status || '').toLowerCase() === 'paid').length;
    const venues = gigs.map((g) => g.venue_name).filter(Boolean);
    const distinctVenues = Array.from(new Set(venues));

    let topGig = null;
    for (const g of gigs) {
      const fee = parseFloat(g.fee) || 0;
      if (!topGig || fee > (parseFloat(topGig.fee) || 0)) topGig = g;
    }

    let scenario = 'EMPTY';
    if (gigs.length >= 6) scenario = 'BUSY';
    else if (gigs.length >= 3) scenario = 'STEADY';
    else if (gigs.length >= 1) scenario = 'LIGHT';

    const nextMonthIdx = month % 12; // 0-11
    const nextMonthName = MONTH_NAMES[nextMonthIdx];

    return {
      year, month,
      monthName: MONTH_NAMES[month - 1],
      nextMonthName,
      gigCount: gigs.length,
      totalFees, totalExpenses, net,
      hasExpenses: totalExpenses > 0,
      expenseCount: expenses.length,
      invoiceCount: invoices.length,
      paidCount,
      outstandingCount: Number(payload.outstanding_invoice_count) || 0,
      outstandingTotal: Number(payload.outstanding_invoice_total) || 0,
      nextMonthGigCount: Number(payload.next_month_gig_count) || 0,
      venueList: joinVenues(venues, 2),
      distinctVenueCount: distinctVenues.length,
      topGig,
      scenario,
      isEmpty: scenario === 'EMPTY',
      isLight: scenario === 'LIGHT',
      isSteady: scenario === 'STEADY',
      isBusy: scenario === 'BUSY',
    };
  }

  // Small shared helpers used inside voice templates.
  const expPhrase = (c) => c.hasExpenses
    ? `${money(c.totalExpenses)} went out against them`
    : 'nothing went out against them';
  const expShort = (c) => c.hasExpenses
    ? `${money(c.totalExpenses)} in expenses`
    : 'no expenses logged';
  const toneWord = (c) => c.isBusy ? 'busy' : c.isSteady ? 'steady' : c.isLight ? 'quiet' : 'quiet';
  const toneTitle = (c) => c.isBusy ? 'Busy' : c.isSteady ? 'Steady' : c.isLight ? 'Quiet' : 'Quiet';
  const gigWord = (c) => c.gigCount === 1 ? 'gig' : 'gigs';
  const bookingWord = (c) => c.gigCount === 1 ? 'booking' : 'bookings';
  const showWord = (c) => c.gigCount === 1 ? 'show' : 'shows';

  // 12 voice templates. Each returns { headline, summary } for a context.
  // Scenarios: EMPTY (0) / LIGHT (1-2) / STEADY (3-5) / BUSY (6+).
  const MONTHLY_VOICES = [
    // V1 — "Quiet/Steady/Busy {month}, clean books"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `Quiet ${c.monthName}, clean slate`,
          summary: `No gigs in ${c.monthName} and nothing logged against the month. The books are exactly where you left them.`,
        };
        if (c.isLight) return {
          headline: `Quiet ${c.monthName}, clean books`,
          summary: `${c.monthName} kept things calm with ${c.gigCount} ${bookingWord(c)}${c.venueList ? ` at ${c.venueList}` : ''}. Fees came in at ${money(c.totalFees)}, and ${expPhrase(c)}. The ledger is tidy.`,
        };
        if (c.isSteady) return {
          headline: `Steady ${c.monthName}, clean books`,
          summary: `${c.monthName} held a steady rhythm with ${c.gigCount} gigs across ${c.distinctVenueCount} venue${c.distinctVenueCount === 1 ? '' : 's'}. Fees came in at ${money(c.totalFees)}, and ${expPhrase(c)}.`,
        };
        return {
          headline: `Busy ${c.monthName}, clean books`,
          summary: `${c.monthName} stayed busy on the calendar with ${c.gigCount} ${bookingWord(c)}${c.venueList ? ` across ${c.venueList}` : ''}. Fees came in at ${money(c.totalFees)}, and ${expPhrase(c)}, leaving ${money(c.net)} on the books.`,
        };
      },
    },
    // V2 — raw numbers lead
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `Zero gigs, zero spend`,
          summary: `No bookings landed in ${c.monthName}. Nothing went out either, so the books stay exactly where they were.`,
        };
        const hlBase = `${c.gigCount} ${gigWord(c)}, ${c.hasExpenses ? 'solid' : 'clean'} numbers`;
        if (c.isLight) return {
          headline: c.hasExpenses ? `${c.gigCount} ${gigWord(c)}, tidy sums` : `${c.gigCount} ${gigWord(c)}, zero expenses`,
          summary: `${c.monthName} brought ${c.gigCount} ${bookingWord(c)} for a combined ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} in expenses, so` : 'Nothing logged against it, which leaves'} ${money(c.net)} net.`,
        };
        if (c.isSteady) return {
          headline: hlBase,
          summary: `${c.gigCount} ${bookingWord(c)} in ${c.monthName} pulled in ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} out against them puts` : 'No expenses logged puts'} ${money(c.net)} in the profit column.`,
        };
        return {
          headline: `${c.gigCount} ${gigWord(c)}, ${money(c.totalFees)} banked`,
          summary: `A strong ${c.gigCount}-gig month in ${c.monthName}. Fees totalled ${money(c.totalFees)}; expenses came to ${money(c.totalExpenses)}. Net: ${money(c.net)}.`,
        };
      },
    },
    // V3 — "A pair/handful of …" friendly count-phrase
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `${c.monthName} sat this one out`,
          summary: `Not a single gig in ${c.monthName} and nothing logged against it. A quiet month, nothing lost.`,
        };
        if (c.isLight) {
          const phrase = c.gigCount === 1 ? `A single ${c.monthName} gig` : `A pair of ${c.monthName} gigs`;
          return {
            headline: c.hasExpenses ? `${phrase}, balanced books` : `${phrase}, all profit`,
            summary: `${c.gigCount === 1 ? 'One booking' : 'Two bookings'} in ${c.monthName}${c.venueList ? ` at ${c.venueList}` : ''} brought in ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} went out, leaving` : 'Nothing went out, so'} ${money(c.net)} stays in your pocket.`,
          };
        }
        if (c.isSteady) return {
          headline: `A handful of ${c.monthName} gigs, ${c.hasExpenses ? 'balanced' : 'clean'} books`,
          summary: `${c.gigCount} bookings brought in ${money(c.totalFees)} across ${c.distinctVenueCount} venue${c.distinctVenueCount === 1 ? '' : 's'}. ${c.hasExpenses ? `${money(c.totalExpenses)} out` : 'No expenses logged'}, leaving ${money(c.net)} net.`,
        };
        return {
          headline: `A packed ${c.monthName}, healthy books`,
          summary: `A full ${c.monthName} diary with ${c.gigCount} gigs across ${c.distinctVenueCount} venues. Fees landed at ${money(c.totalFees)}, expenses at ${money(c.totalExpenses)}, net ${money(c.net)}.`,
        };
      },
    },
    // V4 — parallel construction "Light on stage, tidy on paper"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `Empty on stage, clean on paper`,
          summary: `Nothing hit the diary in ${c.monthName} and nothing hit the ledger. The month stays neutral on both sides.`,
        };
        if (c.isLight) return {
          headline: `Light month on stage, tidy month on paper`,
          summary: `${c.gigCount} ${bookingWord(c)} pulled in ${money(c.totalFees)} across ${c.monthName}. ${c.hasExpenses ? `${money(c.totalExpenses)} logged in expenses.` : 'No expenses to set against them.'} Net: ${money(c.net)}.`,
        };
        if (c.isSteady) return {
          headline: `Steady on stage, ${c.hasExpenses ? 'tidy' : 'clean'} on paper`,
          summary: `${c.gigCount} gigs in ${c.monthName} earned ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} went out` : 'Nothing logged against them'}, leaving ${money(c.net)} net.`,
        };
        return {
          headline: `Busy on stage, busy on paper`,
          summary: `${c.gigCount} bookings in ${c.monthName} for ${money(c.totalFees)} in fees. Expenses of ${money(c.totalExpenses)} bring net to ${money(c.net)}.`,
        };
      },
    },
    // V5 — terse "£X in, £Y out"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `Nothing in, nothing out`,
          summary: `${c.monthName} went quiet on every line. No gigs, no expenses, no invoices issued. Sometimes that's the month.`,
        };
        const headIn = c.hasExpenses
          ? `${money(c.totalFees)} in, ${money(c.totalExpenses)} out`
          : `${money(c.totalFees)} in, nothing out`;
        if (c.isLight) return {
          headline: headIn,
          summary: `${c.gigCount} ${bookingWord(c)} in ${c.monthName}${c.venueList ? ` (${c.venueList})` : ''} brought in ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} went out against them.` : 'Nothing went out against them.'}`,
        };
        if (c.isSteady) return {
          headline: headIn,
          summary: `${c.gigCount} gigs in ${c.monthName} added up to ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} in expenses` : 'No expenses logged'}, so net sits at ${money(c.net)}.`,
        };
        return {
          headline: headIn,
          summary: `${c.gigCount} bookings in ${c.monthName} pulled in ${money(c.totalFees)}. Expenses came to ${money(c.totalExpenses)}. Net for the month: ${money(c.net)}.`,
        };
      },
    },
    // V6 — explicit "Month: [tone] month, [state] ledger"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `${c.monthName}: empty diary, spotless ledger`,
          summary: `No gigs and no expenses in ${c.monthName}. The ledger stays spotless and the diary is wide open for ${c.nextMonthName}.`,
        };
        if (c.isLight) return {
          headline: `${c.monthName}: quieter month, ${c.hasExpenses ? 'balanced' : 'spotless'} ledger`,
          summary: `Two ${bookingWord(c).replace('s','')}s hardly counts as busy, but ${c.monthName} still brought in ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} went out.` : 'No costs logged against it.'}`,
        };
        if (c.isSteady) return {
          headline: `${c.monthName}: steady month, ${c.hasExpenses ? 'balanced' : 'clean'} ledger`,
          summary: `${c.gigCount} gigs in ${c.monthName} added ${money(c.totalFees)} to the books. ${c.hasExpenses ? `${money(c.totalExpenses)} went out, leaving` : 'Nothing went out, leaving'} ${money(c.net)} net.`,
        };
        return {
          headline: `${c.monthName}: busy month, healthy ledger`,
          summary: `${c.gigCount} bookings in ${c.monthName} pulled in ${money(c.totalFees)}. Expenses hit ${money(c.totalExpenses)}. Net ${money(c.net)}.`,
        };
      },
    },
    // V7 — "N shows, M lines" count-focused
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `No shows, no lines`,
          summary: `${c.monthName} had nothing on the stage and nothing on the books. A proper off-month.`,
        };
        const expLine = c.expenseCount === 1
          ? `1 expense line`
          : `${c.expenseCount} expense lines`;
        if (c.isLight) return {
          headline: c.hasExpenses ? `${c.gigCount} ${showWord(c)}, ${expLine}` : `${c.gigCount} ${showWord(c)}, no spend`,
          summary: `${c.gigCount} ${bookingWord(c)} in ${c.monthName} brought in ${money(c.totalFees)}. ${c.hasExpenses ? `${expLine.charAt(0).toUpperCase() + expLine.slice(1)} totalling ${money(c.totalExpenses)}.` : 'Nothing on the expense side.'}`,
        };
        if (c.isSteady) return {
          headline: `${c.gigCount} ${showWord(c)}, ${c.hasExpenses ? expLine : 'clean books'}`,
          summary: `${c.gigCount} gigs in ${c.monthName} earned ${money(c.totalFees)}. ${c.hasExpenses ? `${expLine} at ${money(c.totalExpenses)}.` : 'No expenses filed.'} Net ${money(c.net)}.`,
        };
        return {
          headline: `${c.gigCount} ${showWord(c)}, ${c.hasExpenses ? expLine : 'nothing filed against them'}`,
          summary: `${c.gigCount} bookings in ${c.monthName}, ${money(c.totalFees)} in fees. ${c.hasExpenses ? `${expLine} totalling ${money(c.totalExpenses)}.` : 'No expenses filed.'} Net ${money(c.net)}.`,
        };
      },
    },
    // V8 — colloquial "Small/Big month, full/balanced pocket"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `Slow month, steady pocket`,
          summary: `${c.monthName} didn't pay anything in, but it didn't take anything out either. The pocket stays where it was.`,
        };
        if (c.isLight) return {
          headline: c.hasExpenses ? `Small month, balanced pocket` : `Small month, full pocket`,
          summary: `${c.monthName} was a light one: ${c.gigCount} ${bookingWord(c)} for ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} went back out.` : 'Nothing went back out.'}`,
        };
        if (c.isSteady) return {
          headline: c.hasExpenses ? `Steady month, balanced pocket` : `Steady month, full pocket`,
          summary: `${c.gigCount} gigs and ${money(c.totalFees)} in ${c.monthName}. ${c.hasExpenses ? `${money(c.totalExpenses)} back out, net ${money(c.net)}.` : `Nothing back out, net ${money(c.net)}.`}`,
        };
        return {
          headline: `Big month, healthy pocket`,
          summary: `${c.gigCount} bookings and ${money(c.totalFees)} in ${c.monthName}. After ${money(c.totalExpenses)} in expenses you're up ${money(c.net)}.`,
        };
      },
    },
    // V9 — "Calm/Busy {month}, clean numbers"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `Calm ${c.monthName}, clean numbers`,
          summary: `${c.monthName} had no gigs on the board and no expenses recorded. Clean slate going into ${c.nextMonthName}.`,
        };
        if (c.isLight) return {
          headline: `Calm ${c.monthName}, clean numbers`,
          summary: `${c.gigCount} ${bookingWord(c)} earned ${money(c.totalFees)} in ${c.monthName}. ${c.hasExpenses ? `${money(c.totalExpenses)} in expenses logged.` : 'No expenses logged.'} Net ${money(c.net)}.`,
        };
        if (c.isSteady) return {
          headline: `Steady ${c.monthName}, clean numbers`,
          summary: `${c.gigCount} gigs in ${c.monthName} added up to ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} in expenses` : 'No expenses'}, net ${money(c.net)}.`,
        };
        return {
          headline: `Busy ${c.monthName}, clean numbers`,
          summary: `${c.gigCount} bookings in ${c.monthName}, ${money(c.totalFees)} in fees. ${money(c.totalExpenses)} in expenses leaves net ${money(c.net)}.`,
        };
      },
    },
    // V10 — poetic "A short/full diary, a clean/balanced slate"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `Empty diary, clean slate`,
          summary: `Nothing in the diary for ${c.monthName}, nothing on the ledger. Sometimes the month is just a deep breath.`,
        };
        if (c.isLight) return {
          headline: c.hasExpenses ? `A short diary, a balanced slate` : `A short diary, a clean slate`,
          summary: `${c.gigCount} ${bookingWord(c)} in ${c.monthName}${c.venueList ? ` at ${c.venueList}` : ''} earned ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} went out.` : 'Nothing went out.'}`,
        };
        if (c.isSteady) return {
          headline: c.hasExpenses ? `A steady diary, a balanced slate` : `A steady diary, a clean slate`,
          summary: `${c.gigCount} gigs in ${c.monthName} brought ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} back out, net ${money(c.net)}.` : `Nothing back out, net ${money(c.net)}.`}`,
        };
        return {
          headline: `A full diary, a balanced slate`,
          summary: `A busy ${c.monthName} of ${c.gigCount} gigs for ${money(c.totalFees)}. After ${money(c.totalExpenses)} in expenses, net ${money(c.net)}.`,
        };
      },
    },
    // V11 — "A couple of / Several bookings, {expense state}"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `No bookings, no costs`,
          summary: `No gigs on the ${c.monthName} calendar and no expenses logged. The ledger sits untouched.`,
        };
        if (c.isLight) return {
          headline: c.gigCount === 1
            ? (c.hasExpenses ? `One booking, a little spend` : `One booking, zero costs`)
            : (c.hasExpenses ? `A couple of bookings, balanced costs` : `A couple of bookings, zero costs`),
          summary: `${c.gigCount} ${bookingWord(c)} in ${c.monthName} brought in ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} spent against them.` : 'No costs logged against them.'}`,
        };
        if (c.isSteady) return {
          headline: c.hasExpenses ? `Several bookings, balanced costs` : `Several bookings, zero costs`,
          summary: `${c.gigCount} gigs in ${c.monthName} earned ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} out, net ${money(c.net)}.` : `Nothing out, net ${money(c.net)}.`}`,
        };
        return {
          headline: `Plenty of bookings, ${c.hasExpenses ? 'real costs' : 'zero costs'}`,
          summary: `${c.gigCount} bookings in ${c.monthName} totalling ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} in expenses, net ${money(c.net)}.` : `No expenses, net ${money(c.net)}.`}`,
        };
      },
    },
    // V12 — personification "{Month} kept it simple/busy/balanced"
    {
      build(c) {
        if (c.isEmpty) return {
          headline: `${c.monthName} kept to itself`,
          summary: `${c.monthName} passed without a gig or an expense. A rest month, nothing more.`,
        };
        if (c.isLight) return {
          headline: `${c.monthName} kept it simple`,
          summary: `${c.gigCount} ${bookingWord(c)} and ${money(c.totalFees)} in fees made up ${c.monthName}. ${c.hasExpenses ? `${money(c.totalExpenses)} in expenses to match.` : 'No expenses to match.'}`,
        };
        if (c.isSteady) return {
          headline: `${c.monthName} kept it steady`,
          summary: `${c.gigCount} gigs across ${c.monthName} brought in ${money(c.totalFees)}. ${c.hasExpenses ? `${money(c.totalExpenses)} went out, net ${money(c.net)}.` : `Nothing went out, net ${money(c.net)}.`}`,
        };
        return {
          headline: `${c.monthName} kept it busy`,
          summary: `${c.gigCount} bookings made ${c.monthName} a full diary for ${money(c.totalFees)} in fees. ${money(c.totalExpenses)} in expenses puts net at ${money(c.net)}.`,
        };
      },
    },
  ];

  function pickVoiceIndex(year, month) {
    const raw = (Number(year) || 0) * 5 + (Number(month) || 0);
    return ((raw % 12) + 12) % 12;
  }

  function buildHighlights(c) {
    const out = [];
    if (c.isEmpty) {
      out.push('No gigs logged this month');
      if (c.invoiceCount > 0) out.push(`${c.invoiceCount} invoice${c.invoiceCount === 1 ? '' : 's'} issued${c.paidCount ? ` (${c.paidCount} paid)` : ''}`);
      if (c.hasExpenses) out.push(`${c.expenseCount} expense${c.expenseCount === 1 ? '' : 's'} recorded (${money(c.totalExpenses)})`);
      return out;
    }
    out.push(`${money(c.totalFees)} in gig fees from ${c.gigCount} ${bookingWord(c)}`);
    if (c.invoiceCount > 0) {
      out.push(`${c.invoiceCount} invoice${c.invoiceCount === 1 ? '' : 's'} issued${c.paidCount ? ` (${c.paidCount} paid)` : ''}`);
    }
    if (c.hasExpenses) {
      out.push(`${c.expenseCount} expense${c.expenseCount === 1 ? '' : 's'} recorded (${money(c.totalExpenses)})`);
    } else {
      out.push('No expenses recorded this month');
    }
    if (c.topGig && (parseFloat(c.topGig.fee) || 0) > 0 && c.gigCount > 1) {
      out.push(`Highest fee: ${money(c.topGig.fee)} at ${c.topGig.venue_name || c.topGig.band_name || 'a booking'}`);
    }
    return out.slice(0, 4);
  }

  function buildSuggestions(c) {
    const out = [];
    if (c.outstandingCount > 0) {
      out.push(`Chase ${c.outstandingCount} outstanding invoice${c.outstandingCount === 1 ? '' : 's'} totalling ${money(c.outstandingTotal)}`);
    }
    if (!c.hasExpenses && c.gigCount > 0) {
      out.push('Log fuel and gear receipts so the tax estimate reflects them');
    }
    if (c.nextMonthGigCount <= 2) {
      out.push(`${c.nextMonthName} has ${c.nextMonthGigCount} booking${c.nextMonthGigCount === 1 ? '' : 's'} so far. Time to fill the diary`);
    } else if (c.isBusy) {
      out.push('Busy stretch. Worth reviewing whether fees match the workload');
    }
    if (!out.length) {
      out.push(`Plan ahead for ${c.nextMonthName} to keep momentum`);
    }
    return out.slice(0, 3);
  }

  function generateMonthlyInsight(payload) {
    const c = buildInsightContext(payload || {});
    const idx = pickVoiceIndex(c.year, c.month);
    const voice = MONTHLY_VOICES[idx];
    const head = voice.build(c);
    return {
      headline: head.headline,
      summary: head.summary,
      highlights: buildHighlights(c),
      suggestions: buildSuggestions(c),
      _voiceIndex: idx,
      _scenario: c.scenario,
    };
  }

  // Fetch + render into a target element. Keeps the same "AI monthly insight"
  // card layout the old Haiku renderer used so no CSS change is needed.
  async function renderMonthlyInsight(year, month, targetEl) {
    const slot = targetEl || document.getElementById('aiInsightSlot');
    if (!slot) return;
    slot.innerHTML = '<div style="font-size:12px;color:var(--text-3,#666);padding:8px 0;">Loading...</div>';
    let payload = null;
    try {
      const resp = await fetch(`/api/finance/month-detail?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
      if (!resp.ok) throw new Error('month-detail fetch failed');
      payload = await resp.json();
    } catch (e) {
      slot.innerHTML = '<div style="font-size:12px;color:var(--text-3,#666);padding:8px 0;">Couldn\'t load this month\'s insight.</div>';
      return;
    }
    const data = generateMonthlyInsight(payload);
    const hl = (data.highlights || []).map((x) => `<li style="margin-bottom:4px;">${escH(x)}</li>`).join('');
    const sg = (data.suggestions || []).map((x) => `<li style="margin-bottom:4px;">${escH(x)}</li>`).join('');
    slot.innerHTML = `
      <div class="ai-result-card" style="margin-top:0;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <span style="font-size:18px;">&#128221;</span>
          <div style="font-weight:700;">${escH(data.headline || 'Your month')}</div>
        </div>
        <div style="font-size:13px;line-height:1.55;margin-bottom:10px;">${escH(data.summary || '')}</div>
        ${hl ? `<div style="font-size:12px;color:var(--text-2,#ccc);font-weight:600;margin-bottom:4px;">Highlights</div><ul style="margin:0 0 10px;padding-left:18px;font-size:13px;line-height:1.5;">${hl}</ul>` : ''}
        ${sg ? `<div style="font-size:12px;color:var(--text-2,#ccc);font-weight:600;margin-bottom:4px;">Try next month</div><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;">${sg}</ul>` : ''}
      </div>`;
  }

  window.generateMonthlyInsight = generateMonthlyInsight;
  window.renderMonthlyInsight = renderMonthlyInsight;
})();

// ── Finance Panel ───────────────────────────────────────────────────────────
async function renderFinancePanel() {
  // Target the panel body inside #panel-finance (the Finance Dashboard panel
  // that actually opens from Settings). Kept the legacy #financePanelBody
  // selector as a fallback so both mountings work until index.html is cleaned.
  const body = document.getElementById('financeBody') || document.getElementById('financePanelBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading finance...</div>';

  try {
    const resp = await fetch('/api/earnings?period=year');
    if (!resp.ok) throw new Error('Failed to fetch earnings');
    const data = await resp.json();

    const paidTot = Number(data.paid_total) || 0;
    const unpaidTot = Number(data.unpaid_total) || 0;
    const overdueTot = Number(data.overdue_total) || 0;
    const expensesTot = Number(data.expenses_total) || Number(data.total_expenses) || 0;
    const grossTot = paidTot + unpaidTot + overdueTot;
    const hasAnyActivity = grossTot + expensesTot > 0;

    const taxYear = data.tax_year || '2026/27';
    const earnings = Number(data.total_earnings) || 0;
    const gigs = Number(data.total_gigs) || 0;
    const net = earnings - expensesTot;
    const monthly = data.monthly_breakdown || [];
    const taxEstimate = estimateTax(net);
    const yoyPct = data.year_over_year_pct !== undefined && data.year_over_year_pct !== null
      ? data.year_over_year_pct : null;

    // S5-03 / S5-07: consistent GBP formatting across hero, tiles, mileage, and
    // tax-year rows. Intl.NumberFormat gives us the £ symbol, thousands
    // separators, and pinned two decimal places (£45.50 not £45.5).
    const _gbpFormatter = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const fmtGBP = (n) => _gbpFormatter.format(Number(n) || 0);
    const fmtBar = (n) => {
      const v = Math.round(Number(n) || 0);
      if (v >= 1000) return '£' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
      return '£' + v;
    };

    // Empty state
    if (!hasAnyActivity) {
      body.innerHTML = `
        <div style="padding:32px 24px;text-align:center;">
          <div style="font-size:48px;margin-bottom:12px;">&#x1F4B0;</div>
          <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:8px;">No earnings yet</div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.5;margin-bottom:20px;">
            Add a gig with a fee, or log an expense, and you'll see your income, tax profile and monthly breakdown appear here.
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;max-width:240px;margin:0 auto;">
            <button onclick="closePanel('panel-finance'); openGigWizard();" class="pill-g">Log a gig</button>
            <button onclick="closePanel('panel-finance'); openPanel('panel-receipt'); setTimeout(()=>showReceiptForm('manual'),150); loadReceipts();" class="pill-o">Log an expense</button>
          </div>
        </div>`;
      return;
    }

    const pct = (v) => grossTot > 0 ? Math.max(0, Math.min(100, (v / grossTot) * 100)) : 0;
    const pctPaid = pct(paidTot);
    const pctOverdue = pct(overdueTot);
    const pctUnpaid = Math.max(0, 100 - pctPaid - pctOverdue);

    let html = `
      <!-- Hero: total invoiced + paid/unpaid/overdue split -->
      <div data-finance-section="hero" style="padding:12px 16px 16px;text-align:center;">
        <div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Tax year ${escapeHtml(taxYear)} &middot; Total invoiced</div>
        <div style="font-size:28px;font-weight:800;color:var(--text);line-height:1.1;">${fmtGBP(grossTot)}</div>
        <div style="font-size:11px;color:var(--text-2);margin-top:4px;">${fmtGBP(paidTot)} paid &middot; ${fmtGBP(unpaidTot)} pending &middot; ${fmtGBP(overdueTot)} overdue${yoyPct !== null ? ` &middot; ${yoyPct >= 0 ? '+' : ''}${yoyPct}% YoY` : ' &middot; First tax year'}</div>
        <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bg,#0D1117);margin-top:10px;border:1px solid var(--border);">
          <div title="Paid ${fmtGBP(paidTot)}" style="width:${pctPaid.toFixed(2)}%;background:var(--success);"></div>
          <div title="Pending ${fmtGBP(unpaidTot)}" style="width:${pctUnpaid.toFixed(2)}%;background:var(--warning);"></div>
          <div title="Overdue ${fmtGBP(overdueTot)}" style="width:${pctOverdue.toFixed(2)}%;background:var(--danger);"></div>
        </div>
        <div style="display:flex;justify-content:center;gap:14px;margin-top:8px;font-size:10px;color:var(--text-2);">
          <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;background:var(--success);border-radius:2px;"></span>Paid</span>
          <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;background:var(--warning);border-radius:2px;"></span>Pending</span>
          <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;background:var(--danger);border-radius:2px;"></span>Overdue</span>
        </div>
        <div style="font-size:10px;color:var(--text-3);margin-top:4px;">${gigs} gig${gigs === 1 ? '' : 's'}</div>
      </div>

      <!-- Monthly breakdown with &pound; labels on bars -->
      <div data-finance-section="monthly" style="padding:0 16px 16px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
          <span>Monthly breakdown</span>
          <span style="font-weight:500;text-transform:none;letter-spacing:0;font-size:10px;color:var(--text-3);">Last 12 months</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:4px;height:110px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px 8px 22px;position:relative;">
          ${monthly.length > 0 ? monthly.map(m => {
            const max = Math.max(...monthly.map(x => Number(x.earnings) || 0));
            const val = Number(m.earnings) || 0;
            const height = Math.min(100, (val / (max || 1)) * 100);
            const isForecast = m.status === 'forecast';
            const label = m.label || m.month_label || m.month || '';
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;height:100%;justify-content:flex-end;">
              <div style="font-size:9px;color:var(--text-2);line-height:1;white-space:nowrap;">${val > 0 ? fmtBar(val) : ''}</div>
              <div style="width:100%;background:var(--success);border-radius:2px;height:${Math.max(4, height)}%;opacity:${isForecast ? 0.4 : 1};" title="${escapeHtml(label)}: &pound;${val}"></div>
              <div style="font-size:8px;color:var(--text-3);line-height:1;">${escapeHtml((label || '').slice(0, 3))}</div>
            </div>`;
          }).join('') : '<div style="flex:1;text-align:center;color:var(--text-3);font-size:11px;align-self:center;">No data</div>'}
        </div>
        <div style="display:flex;justify-content:center;gap:14px;margin-top:6px;font-size:10px;color:var(--text-2);">
          <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;background:var(--success);border-radius:2px;opacity:1;"></span>Confirmed</span>
          <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;background:var(--success);border-radius:2px;opacity:0.4;"></span>Forecast</span>
        </div>
      </div>

      <!-- Quick tiles: paid / unpaid / overdue / expenses -->
      <div style="padding:0 16px 16px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Paid</div>
            <div style="font-size:14px;font-weight:700;color:var(--success);">${fmtGBP(paidTot)}</div>
          </div>
          <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Unpaid</div>
            <div style="font-size:14px;font-weight:700;color:var(--warning);">${fmtGBP(unpaidTot)}</div>
          </div>
          <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Overdue</div>
            <div style="font-size:14px;font-weight:700;color:var(--danger);">${fmtGBP(overdueTot)}</div>
          </div>
          <div onclick="renderExpenseBreakdown()" style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:10px;text-align:center;cursor:pointer;">
            <div style="font-size:10px;color:var(--text-2);margin-bottom:4px;">Expenses</div>
            <div style="font-size:14px;font-weight:700;color:var(--text);">${fmtGBP(expensesTot)}</div>
          </div>
        </div>
      </div>

      <!-- Tax year overview -->
      <div data-finance-section="tax-year" style="padding:0 16px 16px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Tax year overview</div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px;">
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;">
            <span style="color:var(--text-2);">Income</span>
            <span style="color:var(--text);font-weight:600;">${fmtGBP(data.year_income || earnings)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;">
            <span style="color:var(--text-2);">Expenses</span>
            <span style="color:var(--text);font-weight:600;">${fmtGBP(data.year_expenses || expensesTot)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:12px;font-weight:600;">
            <span style="color:var(--text);">Taxable profit</span>
            <span style="color:var(--success);">${fmtGBP((data.year_income || earnings) - (data.year_expenses || expensesTot))}</span>
          </div>
        </div>
      </div>

      <!-- Tax estimate -->
      <div style="padding:0 16px 16px;">
        <div style="background:var(--warning-dim);border:1px solid rgba(240,165,0,.3);border-radius:var(--r);padding:14px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:14px;">&#x1F4DD;</span>
            <span style="font-size:11px;font-weight:700;color:var(--warning);text-transform:uppercase;letter-spacing:.5px;">Tax estimate</span>
          </div>
          <div style="font-size:20px;font-weight:800;color:var(--text);">${fmtGBP(taxEstimate)}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:4px;">Rough estimate for self-employed sole trader. Talk to an accountant before filing.</div>
        </div>
      </div>

      <!-- Mileage -->
      <div style="padding:0 16px 16px;">
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div style="font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;">Mileage</div>
            <div style="font-size:10px;color:var(--text-3);">45p/mile HMRC rate</div>
          </div>
          <div style="font-size:18px;font-weight:700;color:var(--text);">${(data.total_miles || 0).toLocaleString()} mi</div>
          <div style="font-size:12px;color:var(--success);margin-top:2px;">${fmtGBP((data.total_miles || 0) * 0.45)} claimable</div>
        </div>
      </div>

      <!-- Monthly Insight (rendered async below) -->
      <div data-finance-section="month-insight" style="padding:0 16px 16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;">Monthly insight</div>
          <button type="button" onclick="(function(){var d=new Date();window.renderMonthlyInsight && window.renderMonthlyInsight(d.getFullYear(), d.getMonth()+1);})()" style="background:none;border:none;color:var(--accent,#f0a500);font-size:11px;cursor:pointer;font-weight:600;">Refresh</button>
        </div>
        <div id="aiInsightSlot"></div>
      </div>

      <!-- HMRC category breakdown (rendered async below) -->
      <div id="financeCategoryBreakdown" style="padding:0 16px 16px;"></div>

      <!-- Export -->
      <div style="padding:0 16px 24px;">
        <div style="font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Export</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="pill-g" onclick="exportGigsCSV()">Export gigs (CSV)</button>
          <button class="pill-g" onclick="exportExpensesCSV()">Export expenses (CSV)</button>
          <button class="pill-o" onclick="exportGigsPDF()">Export gigs (PDF)</button>
          <button class="pill-o" onclick="exportFinancePDF()">Export finance summary (PDF)</button>
        </div>
      </div>`;

    body.innerHTML = html;
    if (typeof renderFinanceCategoryBreakdown === 'function') renderFinanceCategoryBreakdown();
    try {
      const d = new Date();
      if (typeof window.renderMonthlyInsight === 'function') {
        window.renderMonthlyInsight(d.getFullYear(), d.getMonth() + 1);
      }
    } catch (_) { /* noop */ }
    // #140: honour pending scroll target set by window.openFinanceAt. The Home
    // dashboard uses this to land each teaser (This month card, Tax year card,
    // 12-month forecast) at its relevant section inside the Finance panel
    // instead of dumping every tap at the top. Consumed once and cleared, so a
    // direct openPanel('panel-finance') from the bottom-nav just scrolls to
    // the natural top.
    if (window._pendingFinanceScroll) {
      const targetKey = window._pendingFinanceScroll;
      window._pendingFinanceScroll = null;
      requestAnimationFrame(() => {
        const el = body.querySelector(`[data-finance-section="${targetKey}"]`);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
  } catch (err) {
    console.error('Finance panel error:', err);
    body.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Couldn't load finance data.</div>`;
  }
}

// #140: Home-dashboard entry point for the Finance panel. Sets a pending
// scroll target (consumed by renderFinancePanel once the fetch resolves) and
// opens the panel. Safe to call with an unknown section — scrollIntoView just
// no-ops if the selector misses (e.g. empty-state render with no sections).
function openFinanceAt(section) {
  window._pendingFinanceScroll = section || null;
  openPanel('panel-finance');
}
window.openFinanceAt = openFinanceAt;

function estimateTax(net) {
  // UK 2026/27 self-employed rough estimate: personal allowance 12,570
  // 20% basic rate to 50,270, 40% to 125,140, 45% above
  // Plus Class 4 NI: 6% between 12,570 and 50,270
  if (net <= 12570) return 0;
  let tax = 0, ni = 0;
  const a = Math.min(net, 50270) - 12570;
  if (a > 0) { tax += a * 0.20; ni += a * 0.06; }
  const b = Math.min(net, 125140) - 50270;
  if (b > 0) { tax += b * 0.40; ni += b * 0.02; }
  const c = net - 125140;
  if (c > 0) { tax += c * 0.45; ni += c * 0.02; }
  return Math.round(tax + ni);
}

window.renderFinancePanel = renderFinancePanel;

// ── Chat Inbox Panel ────────────────────────────────────────────────────────
// Thin delegate: real implementation lives in openChatInbox() further down.
async function renderChatInbox() {
  if (typeof openChatInbox === 'function') return openChatInbox();
}
window.renderChatInbox = renderChatInbox;

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
  // S12-06: stop chat polling whenever the chat thread panel closes.
  if (id === 'panel-chat-thread' && typeof stopChatThreadPolling === 'function') {
    stopChatThreadPolling();
  }
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
      ${gig.venue_address ? `<div onclick="openDirections('${escapeHtml(gig.venue_address).replace(/'/g, '&#39;')}')" style="font-size:14px;color:var(--text-2);margin-bottom:6px;cursor:pointer;"><span style="color:var(--accent);">\uD83D\uDCCD</span> ${escapeHtml(gig.venue_address)} <span style="color:var(--accent);font-size:12px;font-weight:600;margin-left:4px;">Open in Maps \u203A</span></div>` : ''}
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
      ${gig.status !== 'cancelled' ? `<button style="width:100%;background:var(--card);color:var(--warning);border:1px solid var(--warning);border-radius:24px;padding:12px;font-size:14px;font-weight:500;cursor:pointer;margin-bottom:8px;" onclick="cancelGig('${gig.id}')">Cancel gig</button>` : `<div style="width:100%;background:var(--card);color:var(--text-3);border:1px solid var(--border);border-radius:24px;padding:12px;font-size:14px;font-weight:500;text-align:center;margin-bottom:8px;">Gig is cancelled</div>`}
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
    persistCachedCalendar();
    openGigDetail(gigId);
    showToast('Marked as complete');
  } catch (e) {
    console.error('Mark complete error:', e);
  }
}

async function cancelGig(gigId) {
  const ok = await showConfirm('This will mark the gig as cancelled. You can still invoice for it if needed.', {
    title: 'Cancel this gig?',
    confirmLabel: 'Cancel gig',
    danger: false,
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/gigs/${gigId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Cancel gig failed:', res.status, err);
      showToast('Failed to cancel gig');
      return;
    }
    // Update cache
    window._cachedGigs = (window._cachedGigs || []).map(g =>
      g.id === gigId ? { ...g, status: 'cancelled' } : g
    );
    window._cachedStats = null;
    persistCachedCalendar();
    // Re-render gig detail to show updated status
    await openGigDetail(gigId);
    showToast('Gig cancelled');
  } catch (e) {
    console.error('Cancel gig error:', e);
    showToast('Failed to cancel gig');
  }
}

async function deleteGig(gigId) {
  // S1-05: in-app modal replaces window.confirm so the dialog matches the app
  // design system and does not leak the host domain in its title.
  const ok = await showConfirm('This will remove the gig, its set times, and any unpaid chase cadence. Invoices already sent will not be deleted.', {
    title: 'Delete this gig?',
    confirmLabel: 'Delete gig',
    danger: true,
  });
  if (!ok) return;
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
    persistCachedCalendar();
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
    persistCachedCalendar();
    closePanel('panel-edit-gig');
    renderGigsList(window._cachedGigs);
    // S1-04 / #84: if the gig detail panel is still open underneath the edit panel,
    // it is rendered from the pre-edit gig payload. Re-fetch and re-open so the user
    // sees the new fee / date / venue immediately instead of the stale figures.
    // NOTE: panel overlays use class `open` (see openPanel at ~L4078), not `active`.
    // The old check for `active` never matched, so the panel stayed stale until the
    // user closed + reopened it manually.
    try {
      const detailPanel = document.getElementById('panel-gig-detail');
      if (detailPanel && detailPanel.classList.contains('open')) {
        await openGigDetail(gigId);
      }
    } catch (_) { /* non-fatal — list has already refreshed */ }
  } catch (err) {
    console.error('Save gig error:', err);
    showToast('Failed to save gig');
  }
}

// openPanel / closePanel defined earlier (line ~1969) — removed duplicate here

// Phase IX-E: Directory profile section in the Edit Profile panel. Pulled out
// into its own helper because it has a lot of state (discoverable toggle, bio
// counter, photo URL, genres chip grid) and inlining it made editProfile()
// hard to scan.
function buildDirectoryProfileEditor(profile) {
  const discoverable = profile.discoverable !== false; // default TRUE if never set
  const bioText = profile.bio || '';
  const bioLen = bioText.length;
  const photoUrl = profile.photo_url || '';
  const selectedGenres = Array.isArray(profile.genres) ? profile.genres.filter(Boolean) : [];
  // Phase X: Urgent-gigs marketplace preferences. min_fee_pence defaults to
  // 3000 (£30) per the paid-tab floor; notify_free_gigs defaults to FALSE so
  // the badge stays quiet for users who don't play unpaid work.
  const minFeePence = Number.isFinite(profile.min_fee_pence) ? profile.min_fee_pence : 3000;
  const minFeePounds = Math.max(0, Math.round(minFeePence / 100));
  const notifyFreeGigs = profile.notify_free_gigs === true;
  const genreSeeds = [
    'Vocals', 'Guitar', 'Bass', 'Keys', 'Piano', 'Drums',
    'Saxophone', 'Trumpet', 'Trombone', 'Violin', 'Cello',
    'DJ', 'Percussion', 'Flute', 'Clarinet'
  ];

  const chipHTML = genreSeeds.map(g => {
    const isOn = selectedGenres.some(sel => sel.toLowerCase() === g.toLowerCase());
    return `<button type="button" data-genre="${escapeHtml(g)}" data-on="${isOn ? '1' : '0'}" onclick="toggleGenreChip(this)" style="background:${isOn ? 'var(--accent-dim)' : 'var(--card)'};color:${isOn ? 'var(--accent)' : 'var(--text-2)'};border:1px solid ${isOn ? 'var(--accent)' : 'var(--border)'};border-radius:999px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">${escapeHtml(g)}</button>`;
  }).join('');

  return `
    <div style="margin-top:20px;margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Directory Profile</div>
    <div style="margin-bottom:14px;padding:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);">
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <label style="position:relative;display:inline-block;width:44px;height:24px;flex:0 0 44px;cursor:pointer;margin-top:2px;">
          <input id="editDiscoverable" type="checkbox" ${discoverable ? 'checked' : ''} style="opacity:0;width:0;height:0;" onchange="this.parentElement.querySelector('.tmg-toggle-dot').style.transform = this.checked ? 'translateX(20px)' : 'translateX(0)'; this.parentElement.style.background = this.checked ? 'var(--accent)' : 'var(--border)';" />
          <span style="position:absolute;inset:0;background:${discoverable ? 'var(--accent)' : 'var(--border)'};border-radius:12px;transition:background .2s;"></span>
          <span class="tmg-toggle-dot" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:transform .2s;transform:${discoverable ? 'translateX(20px)' : 'translateX(0)'};"></span>
        </label>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px;">Appear in Find Musicians</div>
          <div style="font-size:11px;color:var(--text-2);line-height:1.4;">Lets other TrackMyGigs users discover you by name, instrument or location. Your email and phone stay private and are only matched for Add Contact lookups you control.</div>
        </div>
      </div>
    </div>
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <span>Short bio</span>
        <span id="editBioCount" style="color:${bioLen > 280 ? 'var(--danger)' : 'var(--text-3)'};font-weight:500;text-transform:none;letter-spacing:0;">${bioLen}/280</span>
      </label>
      <textarea id="editBio" rows="3" maxlength="280" placeholder="One or two lines about you. Shown on your directory card." oninput="const c=document.getElementById('editBioCount'); if(c){c.textContent=this.value.length+'/280'; c.style.color=this.value.length>280?'var(--danger)':'var(--text-3)';}" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;min-height:60px;font-family:inherit;">${escapeHtml(bioText)}</textarea>
    </div>
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Profile photo URL</label>
      <input id="editPhotoUrl" type="url" value="${escapeHtml(photoUrl)}" placeholder="https://..." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
      <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Paste a link to a headshot. Used on your directory card (and your EPK if you haven't set a separate EPK photo).</div>
    </div>
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:6px;">Genres &amp; tags</label>
      <div id="editGenresGrid" style="display:flex;flex-wrap:wrap;gap:6px;">${chipHTML}</div>
      <div style="font-size:10px;color:var(--text-3);margin-top:6px;">Tap up to 8 that describe your sound. Shown on your directory card.</div>
    </div>
    <div style="margin-top:20px;margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Urgent Gigs</div>
    <div style="margin-bottom:14px;">
      <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Minimum fee you'll consider</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="color:var(--text-2);font-size:14px;">&pound;</span>
        <input id="editMinFeePounds" type="number" min="0" step="5" value="${minFeePounds}" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
      </div>
      <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Default for the urgent gigs Browse filter and your notification badge. &pound;30 matches the paid-tab floor.</div>
    </div>
    <div style="margin-bottom:14px;padding:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);">
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <label style="position:relative;display:inline-block;width:44px;height:24px;flex:0 0 44px;cursor:pointer;margin-top:2px;">
          <input id="editNotifyFreeGigs" type="checkbox" ${notifyFreeGigs ? 'checked' : ''} style="opacity:0;width:0;height:0;" onchange="this.parentElement.querySelector('.tmg-toggle-dot').style.transform = this.checked ? 'translateX(20px)' : 'translateX(0)'; this.parentElement.querySelector('.tmg-toggle-bg').style.background = this.checked ? 'var(--accent)' : 'var(--border)';" />
          <span class="tmg-toggle-bg" style="position:absolute;inset:0;background:${notifyFreeGigs ? 'var(--accent)' : 'var(--border)'};border-radius:12px;transition:background .2s;"></span>
          <span class="tmg-toggle-dot" style="position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:transform .2s;transform:${notifyFreeGigs ? 'translateX(20px)' : 'translateX(0)'};"></span>
        </label>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px;">Notify me about free gigs</div>
          <div style="font-size:11px;color:var(--text-2);line-height:1.4;">Opt in to the Free tab of urgent gigs: charity, open mic, promo slots and favours. Off by default so your badge stays clean for paid work.</div>
        </div>
      </div>
    </div>
  `;
}

// Toggle a genre chip on/off. Kept simple: flips data-on and restyles the chip.
// Save wiring reads data-on from each chip, so no separate state array needed.
function toggleGenreChip(btn) {
  if (!btn) return;
  const isOn = btn.getAttribute('data-on') === '1';
  // Cap at 8 selected. Count current on-chips first so we can block the 9th.
  if (!isOn) {
    const grid = document.getElementById('editGenresGrid');
    const onCount = grid ? grid.querySelectorAll('[data-on="1"]').length : 0;
    if (onCount >= 8) {
      showToast && showToast('Up to 8 genres');
      return;
    }
  }
  const next = !isOn;
  btn.setAttribute('data-on', next ? '1' : '0');
  btn.style.background = next ? 'var(--accent-dim)' : 'var(--card)';
  btn.style.color = next ? 'var(--accent)' : 'var(--text-2)';
  btn.style.borderColor = next ? 'var(--accent)' : 'var(--border)';
}
window.toggleGenreChip = toggleGenreChip;

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
      ${buildDirectoryProfileEditor(profile)}
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Home Postcode</label>
        <input id="editHomePostcode" type="text" value="${escapeHtml(profile.home_postcode || '')}" placeholder="e.g. CF10 1AA" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;text-transform:uppercase;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Used to calculate mileage to gig venues and filter dep offers by distance</div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <span>Travel Radius</span>
          <span id="editTravelRadiusValue" style="color:var(--accent);font-weight:700;">${profile.travel_radius_miles != null ? profile.travel_radius_miles : 50} mi</span>
        </label>
        <input id="editTravelRadius" type="range" min="10" max="500" step="5" value="${profile.travel_radius_miles != null ? profile.travel_radius_miles : 50}" oninput="document.getElementById('editTravelRadiusValue').textContent = this.value + ' mi'" style="width:100%;accent-color:var(--accent);" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">How far you'll travel for a gig. Broadcast dep offers beyond this distance are silently filtered out. Direct pick-dep offers still reach you but are flagged as outside your radius.</div>
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
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Business Address</label>
        <textarea id="editBusinessAddress" rows="3" placeholder="e.g. 12 High Street&#10;London&#10;SW1A 1AA" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;min-height:60px;font-family:inherit;">${escapeHtml(profile.business_address || '')}</textarea>
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Shows under your name on invoices</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Business Phone</label>
          <input id="editBusinessPhone" type="tel" value="${escapeHtml(profile.business_phone || '')}" placeholder="07…" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">VAT Number</label>
          <input id="editVatNumber" type="text" value="${escapeHtml(profile.vat_number || '')}" placeholder="GB123456789" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Bank / Payment Details</label>
        <textarea id="editBankDetails" rows="3" placeholder="e.g. Sort code: 12-34-56&#10;Account: 12345678&#10;Gareth Gwyn" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;min-height:60px;font-family:inherit;">${escapeHtml(profile.bank_details || '')}</textarea>
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Auto-fills on every new invoice</div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Pay link <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-3);">(optional)</span></label>
        <input id="editPaymentLinkUrl" type="url" inputmode="url" value="${escapeHtml(profile.payment_link_url || '')}" placeholder="https://buy.stripe.com/... or https://paypal.me/yourhandle" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;line-height:1.5;">Stripe Payment Link, PayPal.me, SumUp, Wise, anything that works for you. Adds a Pay Online button to every invoice and tells you when a client clicks it.</div>
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
      <div style="margin-top:20px;margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Saved Clients</div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;line-height:1.45;">Names you&#8217;ve billed before. They auto-fill the client address when you pick one in the invoice composer.</div>
      <div id="savedClientsList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;"><div style="font-size:12px;color:var(--text-3);padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);">Loading&#8230;</div></div>
      ${buildRateCardEditor(profile)}
    </div>`;

  openPanel('panel-edit-profile');
  // Populate the Saved Clients list asynchronously so the panel doesn't
  // block on an API call.
  setTimeout(() => { if (typeof renderSavedClientsList === 'function') renderSavedClientsList(); }, 0);

  // Live preview of EPK video if we're rendering an editor that includes it
  setTimeout(() => {
    const inp = document.getElementById('epkVideo');
    if (inp && typeof renderEpkVideoPreview === 'function') renderEpkVideoPreview(inp.value);
  }, 0);
}

async function saveProfile() {
  const name = document.getElementById('editName')?.value?.trim();
  const displayName = document.getElementById('editDisplayName')?.value?.trim();
  const phone = document.getElementById('editPhone')?.value?.trim();
  const instrumentsRaw = document.getElementById('editInstruments')?.value?.trim();
  const homePostcode = document.getElementById('editHomePostcode')?.value?.trim().toUpperCase();
  const travelRadiusRaw = document.getElementById('editTravelRadius')?.value;
  const travelRadius = travelRadiusRaw != null && travelRadiusRaw !== '' ? parseInt(travelRadiusRaw, 10) : null;
  const googleReviewUrl = document.getElementById('editGoogleReview')?.value?.trim();
  const facebookReviewUrl = document.getElementById('editFacebookReview')?.value?.trim();
  const bankDetails = document.getElementById('editBankDetails')?.value?.trim();
  const paymentLinkUrl = document.getElementById('editPaymentLinkUrl')?.value?.trim();
  const businessAddress = document.getElementById('editBusinessAddress')?.value?.trim();
  const businessPhone = document.getElementById('editBusinessPhone')?.value?.trim();
  const vatNumber = document.getElementById('editVatNumber')?.value?.trim();
  const invoicePrefix = document.getElementById('editInvoicePrefix')?.value?.trim().toUpperCase();
  const invoiceNextNum = parseInt(document.getElementById('editInvoiceNextNum')?.value, 10) || null;
  const invoiceFormat = document.getElementById('editInvoiceFormat')?.value || null;

  const instruments = instrumentsRaw ? instrumentsRaw.split(',').map(s => s.trim()).filter(Boolean).join(', ') : '';

  // Phase IX-E: Directory profile fields. Only read them if the fields are
  // present (the panel may be rendering a legacy build without them, though
  // after this commit every build should have them).
  const discoverableEl = document.getElementById('editDiscoverable');
  const discoverable = discoverableEl ? !!discoverableEl.checked : undefined;
  const bioEl = document.getElementById('editBio');
  const bio = bioEl ? bioEl.value : undefined;
  const photoUrlEl = document.getElementById('editPhotoUrl');
  const photoUrl = photoUrlEl ? photoUrlEl.value.trim() : undefined;
  let genres;
  const genresGrid = document.getElementById('editGenresGrid');
  if (genresGrid) {
    genres = Array.from(genresGrid.querySelectorAll('[data-on="1"]'))
      .map(el => el.getAttribute('data-genre'))
      .filter(Boolean);
  }

  // Phase X: Urgent-gigs marketplace preferences. UI collects the minimum fee
  // in whole pounds (number spinner) because pence are confusing to type; we
  // convert to pence here before sending. Leave undefined if the field isn't
  // present so we don't accidentally stomp a legacy build.
  const minFeePoundsEl = document.getElementById('editMinFeePounds');
  let minFeePence;
  if (minFeePoundsEl) {
    const pounds = parseFloat(minFeePoundsEl.value);
    if (isFinite(pounds) && pounds >= 0) {
      minFeePence = Math.round(pounds * 100);
    } else {
      minFeePence = 0;
    }
  }
  const notifyFreeGigsEl = document.getElementById('editNotifyFreeGigs');
  const notifyFreeGigs = notifyFreeGigsEl ? !!notifyFreeGigsEl.checked : undefined;

  try {
    const payload = {
      name: name !== undefined ? name : null,
      display_name: displayName || null,
      phone: phone || null,
      instruments: instruments || null,
      home_postcode: homePostcode || null,
      travel_radius_miles: travelRadius,
      google_review_url: googleReviewUrl || null,
      facebook_review_url: facebookReviewUrl || null,
      bank_details: bankDetails || null,
      payment_link_url: paymentLinkUrl !== undefined ? (paymentLinkUrl || '') : undefined,
      business_address: businessAddress || null,
      business_phone: businessPhone || null,
      vat_number: vatNumber || null,
      invoice_prefix: invoicePrefix || null,
      invoice_next_number: invoiceNextNum,
      invoice_format: invoiceFormat,
    };
    if (discoverable !== undefined) payload.discoverable = discoverable;
    if (bio !== undefined) payload.bio = bio;
    if (photoUrl !== undefined) payload.photo_url = photoUrl;
    if (genres !== undefined) payload.genres = genres;
    if (minFeePence !== undefined) payload.min_fee_pence = minFeePence;
    if (notifyFreeGigs !== undefined) payload.notify_free_gigs = notifyFreeGigs;

    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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

// S9-03: shareAvailability used to be defined twice. The second copy (further
// down this file) shadowed this one, which left dead code and a confusing
// diff-of-messaging. Keeping only the later definition, which has the copy the
// promoter actually sees.

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
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;">Bio</label>
          <button type="button" onclick="window.aiBioWriter && window.aiBioWriter({ onApply: function(d){ var t=document.getElementById('epkBio'); if(t && d && d.medium){ t.value = d.medium; } } })" style="background:var(--accent-dim, rgba(240,165,0,.18));color:var(--accent,#f0a500);border:1px solid rgba(240,165,0,.4);border-radius:12px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;">&#10024; Write with AI</button>
        </div>
        <textarea id="epkBio" rows="5" placeholder="A short bio promoters can read at a glance. Style of music, notable gigs, what makes you worth booking." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;font-family:inherit;">${escapeHtml(profile.epk_bio || '')}</textarea>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Photo URL</label>
        <input id="epkPhoto" type="url" value="${escapeHtml(profile.epk_photo_url || '')}" placeholder="https://..." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">A wide hero photo works best. Upload to Imgur or Dropbox and paste the direct image URL.</div>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Video URL</label>
        <input id="epkVideo" type="url" value="${escapeHtml(profile.epk_video_url || '')}" placeholder="https://youtube.com/watch?v=..." oninput="renderEpkVideoPreview(this.value)" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        <div style="font-size:10px;color:var(--text-3);margin-top:3px;">YouTube, Vimeo, or any direct video link.</div>
        <div id="epkVideoPreview" style="margin-top:8px;"></div>
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

// Parse a YouTube or Vimeo URL and return an embed URL, or null for direct files.
function epkEmbedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host.endsWith('youtube.com')) {
      const id = u.searchParams.get('v');
      if (id) return `https://www.youtube.com/embed/${id}`;
      // handle /embed/ and /shorts/
      const m = u.pathname.match(/\/(?:embed|shorts)\/([^/?#]+)/);
      if (m) return `https://www.youtube.com/embed/${m[1]}`;
    }
    if (host.endsWith('vimeo.com')) {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch (_) {}
  return null;
}

function renderEpkVideoPreview(url) {
  const box = document.getElementById('epkVideoPreview');
  if (!box) return;
  const embed = epkEmbedUrl(url);
  if (embed) {
    box.innerHTML = `
      <div style="position:relative;width:100%;padding-bottom:56.25%;background:var(--card);border-radius:var(--rs);overflow:hidden;">
        <iframe src="${embed}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
      </div>
      <div style="font-size:10px;color:var(--text-3);margin-top:3px;">This is how it will show on your public EPK.</div>
    `;
  } else if (url && /^https?:\/\//i.test(url)) {
    box.innerHTML = `
      <video controls style="width:100%;border-radius:var(--rs);background:#000;">
        <source src="${url}">
      </video>
      <div style="font-size:10px;color:var(--text-3);margin-top:3px;">Direct video preview. If it does not play, check the URL.</div>
    `;
  } else {
    box.innerHTML = '';
  }
}
window.renderEpkVideoPreview = renderEpkVideoPreview;

// Rate card editor — rendered in the Invoice settings panel
function buildRateCardEditor(profile) {
  const p = profile || window._currentUser || {};
  return `
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border);">
      <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">Default rates / rate card</div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:12px;">These auto-fill when you create a new gig or invoice. Leave blank if you price each gig from scratch.</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Standard (£)</label>
          <input id="rateStandard" type="number" inputmode="decimal" step="1" value="${p.rate_standard != null ? p.rate_standard : ''}" placeholder="280" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Premium / peak (£)</label>
          <input id="ratePremium" type="number" inputmode="decimal" step="1" value="${p.rate_premium != null ? p.rate_premium : ''}" placeholder="400" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Dep rate (£)</label>
          <input id="rateDep" type="number" inputmode="decimal" step="1" value="${p.rate_dep != null ? p.rate_dep : ''}" placeholder="200" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Deposit %</label>
          <input id="rateDepositPct" type="number" inputmode="numeric" min="0" max="100" step="1" value="${p.rate_deposit_pct != null ? p.rate_deposit_pct : ''}" placeholder="25" style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;">
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:4px;">Notes for bookers</label>
        <textarea id="rateNotes" rows="2" placeholder="e.g. Rates include PA and lights. Travel outside 30 miles quoted separately." style="width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;font-family:inherit;">${escapeHtml(p.rate_notes || '')}</textarea>
      </div>

      <button onclick="saveRateCard()" class="pill-g" style="width:100%;">Save rate card</button>
    </div>
  `;
}
window.buildRateCardEditor = buildRateCardEditor;

async function saveRateCard() {
  const rate_standard = document.getElementById('rateStandard')?.value?.trim();
  const rate_premium = document.getElementById('ratePremium')?.value?.trim();
  const rate_dep = document.getElementById('rateDep')?.value?.trim();
  const rate_deposit_pct = document.getElementById('rateDepositPct')?.value?.trim();
  const rate_notes = document.getElementById('rateNotes')?.value?.trim();
  try {
    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rate_standard: rate_standard || null,
        rate_premium: rate_premium || null,
        rate_dep: rate_dep || null,
        rate_deposit_pct: rate_deposit_pct || null,
        rate_notes: rate_notes || '',
      }),
    });
    if (!res.ok) throw new Error('save failed');
    const updated = await res.json();
    window._cachedProfile = updated;
    window._currentUser = { ...window._currentUser, ...updated };
    showToast('Rate card saved');
  } catch (err) {
    console.error('Save rate card error:', err);
    showToast('Failed to save rate card');
  }
}
window.saveRateCard = saveRateCard;

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

async function openNetworkPanel() {
  const body = document.getElementById('networkBody');
  if (!body) return;

  // Keep previously-selected tab across panel re-opens within the same
  // session. Default to Find on first open.
  if (!window._netTab) window._netTab = 'find';

  body.innerHTML = `
    <div style="padding:16px 20px 8px;display:flex;align-items:center;justify-content:space-between;">
      <button onclick="closePanel('panel-network')" style="background:none;border:none;color:var(--accent);font-size:16px;cursor:pointer;">&#8249;</button>
      <div style="font-size:16px;font-weight:700;color:var(--text);">My Network</div>
      <button onclick="openPanel('panel-add-contact')" style="background:var(--accent);color:#000;border:none;border-radius:12px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">+ Add</button>
    </div>
    <div class="net-tabs">
      <button class="net-tab ${window._netTab === 'find' ? 'ac' : ''}" onclick="switchNetTab('find')">Find musicians</button>
      <button class="net-tab ${window._netTab === 'contacts' ? 'ac' : ''}" onclick="switchNetTab('contacts')">My contacts</button>
    </div>
    <div id="netTabBody"></div>`;

  if (window._netTab === 'find') {
    renderFindTab();
  } else {
    renderContactsTab();
  }
}

function switchNetTab(tab) {
  window._netTab = tab;
  // Re-render only the tab-body + header tabs, not the whole panel.
  document.querySelectorAll('.net-tab').forEach((btn, i) => {
    const isActive = (i === 0 && tab === 'find') || (i === 1 && tab === 'contacts');
    btn.classList.toggle('ac', isActive);
  });
  if (tab === 'find') {
    renderFindTab();
  } else {
    renderContactsTab();
  }
}
window.switchNetTab = switchNetTab;

// ── My contacts tab (legacy behaviour moved out of openNetworkPanel) ──
async function renderContactsTab() {
  const tabBody = document.getElementById('netTabBody');
  if (!tabBody) return;
  tabBody.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading contacts...</div>';

  try {
    const res = await fetch('/api/contacts');
    if (!res.ok) throw new Error('Failed to fetch contacts');
    const contacts = await res.json();
    window._cachedContacts = contacts;
    window._contactFilterType = 'all';

    tabBody.innerHTML = `
      <div style="padding:0 16px 8px;">
        <input type="text" class="fi" placeholder="Search contacts..." id="contactSearch" oninput="filterContacts()" />
      </div>
      <div id="contactFilterBadges" style="display:flex;gap:6px;padding:0 16px 8px;overflow-x:auto;">
        <button class="filter-badge ac" onclick="filterContactsByType('all')">All</button>
        <button class="filter-badge" onclick="filterContactsByType('favourite')">Favourites</button>
        <button class="filter-badge" onclick="filterContactsByType('instrument')">By instrument</button>
      </div>
      <div id="contactsList" style="padding:0 16px;"></div>`;
    renderContactsList();
  } catch (err) {
    console.error('Network panel error:', err);
    tabBody.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load contacts</div>';
  }
}

// ── Find musicians tab (Phase IX-C) ───────────────────────────────────

// Controlled seed list for instrument filter chips. Matches common
// TrackMyGigs instruments. Not exhaustive — freeform instruments on a
// user's profile are still searchable via the server (&& overlap).
const DISCOVER_INSTRUMENT_SEEDS = [
  'Vocals', 'Guitar', 'Bass', 'Keys', 'Piano', 'Drums',
  'Saxophone', 'Trumpet', 'Trombone', 'Violin', 'Cello',
  'DJ', 'Percussion', 'Flute', 'Clarinet'
];

function getDiscoverStickyInstruments() {
  try {
    const raw = localStorage.getItem('tmg_discover_instruments');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function setDiscoverStickyInstruments(list) {
  try {
    localStorage.setItem('tmg_discover_instruments', JSON.stringify(list || []));
  } catch (_) {}
}

function renderFindTab() {
  const tabBody = document.getElementById('netTabBody');
  if (!tabBody) return;

  // Lazy-init per-panel state (survives tab toggles within a session).
  if (!window._discoverState) {
    window._discoverState = {
      mode: 'name',        // 'name' | 'email' | 'phone'
      query: '',
      instruments: getDiscoverStickyInstruments(),
      lastSubmit: ''
    };
  }
  const st = window._discoverState;

  const placeholder = st.mode === 'name'
    ? 'Search by name...'
    : st.mode === 'email'
      ? 'Exact email match'
      : 'Phone number (UK or E.164)';

  tabBody.innerHTML = `
    <div style="padding:0 16px 10px;">
      <input type="text" class="form-input" placeholder="${placeholder}" id="discoverQuery"
             value="${escapeHtml(st.query)}"
             oninput="onDiscoverQueryInput(event)"
             onkeydown="if(event.key==='Enter'){ event.preventDefault(); submitDiscoverSearch(); }"
             autocomplete="off" />
    </div>
    <div class="disc-modes">
      <button class="disc-mode ${st.mode === 'name' ? 'ac' : ''}"  onclick="setDiscoverMode('name')">Name</button>
      <button class="disc-mode ${st.mode === 'email' ? 'ac' : ''}" onclick="setDiscoverMode('email')">Email</button>
      <button class="disc-mode ${st.mode === 'phone' ? 'ac' : ''}" onclick="setDiscoverMode('phone')">Phone</button>
    </div>
    <div class="disc-chips" id="discoverChips">${renderDiscoverChips()}</div>
    <div id="discoverResults"></div>`;

  // Empty on first render = show empty-state rails; otherwise re-run last search
  // so tab round-trips remember where you were.
  if (st.query.trim()) {
    submitDiscoverSearch();
  } else {
    renderDiscoverEmptyState();
  }
}

function renderDiscoverChips() {
  const st = window._discoverState;
  const active = new Set(st.instruments || []);
  const anyActive = active.size === 0;
  let html = `<button class="filter-badge ${anyActive ? 'ac' : ''}" onclick="clearDiscoverChips()">Any</button>`;
  for (const instr of DISCOVER_INSTRUMENT_SEEDS) {
    const on = active.has(instr);
    html += `<button class="filter-badge ${on ? 'ac' : ''}" onclick="toggleDiscoverChip('${escapeAttr(instr)}')">${escapeHtml(instr)}</button>`;
  }
  return html;
}

function setDiscoverMode(mode) {
  const st = window._discoverState;
  st.mode = mode;
  // Re-render the tab so placeholder updates.
  renderFindTab();
}
window.setDiscoverMode = setDiscoverMode;

function onDiscoverQueryInput(ev) {
  const st = window._discoverState;
  st.query = (ev && ev.target && ev.target.value) || '';
  // Debounce name mode; email/phone wait for Enter/submit.
  if (st.mode === 'name') {
    clearTimeout(window._discoverDebounce);
    window._discoverDebounce = setTimeout(() => {
      if ((st.query || '').trim().length >= 2) submitDiscoverSearch();
      else renderDiscoverEmptyState();
    }, 350);
  }
}
window.onDiscoverQueryInput = onDiscoverQueryInput;

function toggleDiscoverChip(instr) {
  const st = window._discoverState;
  const set = new Set(st.instruments || []);
  if (set.has(instr)) set.delete(instr); else set.add(instr);
  st.instruments = Array.from(set);
  setDiscoverStickyInstruments(st.instruments);
  // Re-render chips in place.
  const chips = document.getElementById('discoverChips');
  if (chips) chips.innerHTML = renderDiscoverChips();
  // Re-run whatever view is active so filter takes effect.
  if ((st.query || '').trim()) submitDiscoverSearch();
  else renderDiscoverEmptyState();
}
window.toggleDiscoverChip = toggleDiscoverChip;

function clearDiscoverChips() {
  const st = window._discoverState;
  st.instruments = [];
  setDiscoverStickyInstruments([]);
  const chips = document.getElementById('discoverChips');
  if (chips) chips.innerHTML = renderDiscoverChips();
  if ((st.query || '').trim()) submitDiscoverSearch();
  else renderDiscoverEmptyState();
}
window.clearDiscoverChips = clearDiscoverChips;

async function submitDiscoverSearch() {
  const st = window._discoverState;
  const q = (st.query || '').trim();
  const results = document.getElementById('discoverResults');
  if (!results) return;

  if (!q) {
    renderDiscoverEmptyState();
    return;
  }
  if (q.length < 2 && st.mode === 'name') {
    results.innerHTML = '<div class="disc-empty">Keep typing — at least 2 characters.</div>';
    return;
  }

  results.innerHTML = '<div class="disc-loading">Searching...</div>';
  st.lastSubmit = q;

  const params = new URLSearchParams();
  params.set('mode', st.mode);
  params.set('q', q);
  if (st.instruments && st.instruments.length) {
    params.set('instruments', st.instruments.join(','));
  }

  try {
    const res = await fetch('/api/discover?' + params.toString());
    if (res.status === 429) {
      const retry = res.headers.get('Retry-After') || '';
      results.innerHTML = `<div class="disc-empty">You've hit the hourly lookup limit. Try again ${retry ? 'in ' + retry + ' seconds' : 'shortly'}.</div>`;
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      results.innerHTML = `<div class="disc-empty">${escapeHtml(body.error || 'Search failed')}</div>`;
      return;
    }
    const data = await res.json();
    // self-lookup on email mode
    if (data && data.self_lookup) {
      results.innerHTML = `<div class="disc-empty">That's your own email address.</div>`;
      return;
    }
    const list = Array.isArray(data) ? data : (Array.isArray(data.results) ? data.results : []);
    if (!list.length) {
      const label = st.mode === 'name' ? 'No musicians match that name.' : 'No one on TrackMyGigs matches that exactly.';
      results.innerHTML = `<div class="disc-empty">${label}</div>`;
      return;
    }
    results.innerHTML = list.map(renderDiscoverCard).join('');
  } catch (err) {
    console.error('Discover search error:', err);
    results.innerHTML = '<div class="disc-empty">Search failed. Check your connection and try again.</div>';
  }
}
window.submitDiscoverSearch = submitDiscoverSearch;

async function renderDiscoverEmptyState() {
  const results = document.getElementById('discoverResults');
  if (!results) return;
  const st = window._discoverState;
  results.innerHTML = '<div class="disc-loading">Loading suggestions...</div>';

  const instrumentsQs = (st.instruments && st.instruments.length)
    ? '&instruments=' + encodeURIComponent(st.instruments.join(','))
    : '';

  try {
    const [nearbyRes, instrRes] = await Promise.all([
      fetch('/api/discover?mode=nearby' + instrumentsQs),
      fetch('/api/discover?mode=instrument_match' + instrumentsQs)
    ]);

    const nearby = nearbyRes.ok ? await nearbyRes.json() : { results: [] };
    const instr  = instrRes.ok  ? await instrRes.json()  : { results: [] };

    const nearbyList = Array.isArray(nearby) ? nearby : (Array.isArray(nearby.results) ? nearby.results : []);
    const instrList  = Array.isArray(instr)  ? instr  : (Array.isArray(instr.results)  ? instr.results  : []);

    const nearbyHint = nearby && nearby.hint ? nearby.hint : '';
    const instrHint  = instr  && instr.hint  ? instr.hint  : '';

    let html = '';

    html += `<div class="disc-rail-label">Musicians near you</div>`;
    if (nearbyList.length) {
      html += nearbyList.map(renderDiscoverCard).join('');
    } else {
      html += `<div class="disc-empty">${escapeHtml(nearbyHint || 'Nobody nearby yet. Try widening your travel radius in Profile.')}</div>`;
    }

    html += `<div class="disc-rail-label">Plays your instrument</div>`;
    if (instrList.length) {
      html += instrList.map(renderDiscoverCard).join('');
    } else {
      html += `<div class="disc-empty">${escapeHtml(instrHint || 'Nobody matching your instruments yet.')}</div>`;
    }

    results.innerHTML = html;
  } catch (err) {
    console.error('Discover empty-state error:', err);
    results.innerHTML = '<div class="disc-empty">Couldn\'t load suggestions. Pull to refresh.</div>';
  }
}

function renderDiscoverCard(u) {
  if (!u || !u.id) return '';
  window._discoverCardCache = window._discoverCardCache || {};
  window._discoverCardCache[u.id] = u;

  const name = u.display_name || u.name || 'Musician';
  const initial = (name || 'U')[0].toUpperCase();
  const photo = u.photo_url
    ? `<img src="${escapeAttr(u.photo_url)}" alt="" onerror="this.style.display='none'; this.parentElement.textContent='${escapeAttr(initial)}'" />`
    : escapeHtml(initial);

  const instruments = Array.isArray(u.instruments) ? u.instruments.slice(0, 3) : [];
  const genres = Array.isArray(u.genres) ? u.genres.slice(0, 5) : [];
  const metaParts = [];
  if (instruments.length) metaParts.push(instruments.join(', '));
  if (genres.length) metaParts.push(genres.join(' / '));
  const meta = metaParts.join(' · ');

  const outward = u.outward_postcode || '';
  const radius = (u.travel_radius_miles != null) ? `${u.travel_radius_miles} mi` : '';
  const dist = (u.distance_miles != null) ? `${Math.round(u.distance_miles)} mi away` : '';
  const geoBits = [outward, radius && `travels ${radius}`, dist].filter(Boolean).join(' · ');

  const premium = (u.premium || u.is_premium) ? `<span class="disc-premium-dot" title="Premium"></span>` : '';
  const badges = renderTrustBadges(u);

  const bio = (u.bio || '').trim();
  const bioBlock = bio
    ? `<div class="disc-bio-preview" onclick="toggleDiscoverBio('${escapeAttr(u.id)}', event)" data-bio-id="${escapeAttr(u.id)}">${escapeHtml(bio.length > 100 ? bio.slice(0, 97) + '…' : bio)}</div>
       <div class="disc-bio-full" id="discBioFull-${escapeAttr(u.id)}" style="display:none;">${escapeHtml(bio)}</div>`
    : '';

  return `
    <div class="disc-card" data-user-id="${escapeAttr(u.id)}">
      <div class="disc-avatar">${photo}</div>
      <div class="disc-main">
        <div class="disc-name-row">
          <div class="disc-name">${escapeHtml(name)}</div>
          ${premium}
        </div>
        ${meta ? `<div class="disc-meta">${escapeHtml(meta)}</div>` : ''}
        ${geoBits ? `<div class="disc-geo">${escapeHtml(geoBits)}</div>` : ''}
        ${badges}
        ${bioBlock}
      </div>
      <button class="disc-kebab" aria-label="More actions" onclick="openDiscoverKebab('${escapeAttr(u.id)}')">⋯</button>
    </div>`;
}

function renderTrustBadges(u) {
  if (!u) return '';
  // Phase IX-B returns badges nested under `badges`; tolerate flat shape too.
  const b = (u.badges && typeof u.badges === 'object') ? u.badges : u;
  const items = [];

  if (b.email_verified) {
    items.push(`<span class="disc-badge verified" title="Email verified">✓ Verified</span>`);
  }
  if (b.joined_year) {
    items.push(`<span class="disc-badge">Joined ${escapeHtml(String(b.joined_year))}</span>`);
  }
  if (b.gigs_bucket) {
    const map = { '0': 'No gigs logged', '1-9': '1–9 gigs', '10-49': '10–49 gigs', '50-199': '50–199 gigs', '200+': '200+ gigs' };
    const label = map[b.gigs_bucket] || b.gigs_bucket;
    items.push(`<span class="disc-badge">${escapeHtml(label)}</span>`);
  }
  // Server already nulls out acceptance_pct when < 5 samples (decision 8).
  if (b.acceptance_pct != null) {
    items.push(`<span class="disc-badge">${Number(b.acceptance_pct)}% accept</span>`);
  }
  if (!items.length) return '';
  return `<div class="disc-badges">${items.slice(0, 4).join('')}</div>`;
}

function toggleDiscoverBio(userId, ev) {
  if (ev) ev.stopPropagation();
  const full = document.getElementById('discBioFull-' + userId);
  if (!full) return;
  full.style.display = full.style.display === 'none' ? 'block' : 'none';
}
window.toggleDiscoverBio = toggleDiscoverBio;

// ── Discover kebab bottom-sheet ────────────────────────────────────────

function openDiscoverKebab(userId) {
  const u = (window._discoverCardCache || {})[userId];
  if (!u) {
    showToast('Could not load actions');
    return;
  }
  closeDiscoverSheet();
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'discoverSheet';
  overlay.innerHTML = `
    <div class="sheet-panel" onclick="event.stopPropagation()">
      <div class="sheet-handle"></div>
      <div class="sheet-title">${escapeHtml(u.display_name || u.name || 'Musician')}</div>
      <button class="sheet-btn" onclick="discoverAction_addContact('${escapeAttr(userId)}')">Add to contacts</button>
      <button class="sheet-btn" onclick="discoverAction_sendDep('${escapeAttr(userId)}')">Send dep offer</button>
      <button class="sheet-btn danger" onclick="discoverAction_report('${escapeAttr(userId)}')">Report</button>
      <button class="sheet-btn danger" onclick="discoverAction_block('${escapeAttr(userId)}')">Block</button>
      <button class="sheet-btn" style="margin-top:10px;text-align:center;" onclick="closeDiscoverSheet()">Cancel</button>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) closeDiscoverSheet(); };
  document.body.appendChild(overlay);
}
window.openDiscoverKebab = openDiscoverKebab;

function closeDiscoverSheet() {
  const el = document.getElementById('discoverSheet');
  if (el) el.remove();
}
window.closeDiscoverSheet = closeDiscoverSheet;

async function discoverAction_addContact(userId) {
  const u = (window._discoverCardCache || {})[userId];
  closeDiscoverSheet();
  if (!u) return;

  try {
    // Phase IX-D: When adding from Find Musicians, the target user id is known
    // for certain, so auto-link. Server re-validates (discoverable, not self,
    // not blocked) and silently drops to NULL if the check fails; the row still
    // saves, so a stale cache never blocks the add.
    const payload = {
      name: u.display_name || u.name || 'Musician',
      instruments: Array.isArray(u.instruments) ? u.instruments : [],
      location: u.outward_postcode || '',
      notes: `Added from Find Musicians on ${new Date().toISOString().slice(0, 10)}`,
      linked_user_id: userId || null
    };
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('Added to contacts');
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || 'Could not add contact');
    }
  } catch (err) {
    console.error('Add discovered contact error:', err);
    showToast('Could not add contact');
  }
}
window.discoverAction_addContact = discoverAction_addContact;

function discoverAction_sendDep(userId) {
  closeDiscoverSheet();
  // Stash the discovered user's id for the dep picker to pre-select once a gig
  // is chosen. initDepPanel consumes this alongside _depPrefillContactId.
  window._depPrefillDiscoveredUserId = userId;
  closePanel('panel-network');
  if (typeof openDepPicker === 'function') openDepPicker();
}
window.discoverAction_sendDep = discoverAction_sendDep;

async function discoverAction_block(userId) {
  closeDiscoverSheet();
  const u = (window._discoverCardCache || {})[userId];
  const name = u ? (u.display_name || u.name || 'this musician') : 'this musician';
  const ok = await showConfirm(`Block ${name}? You won't see each other in search and dep-offers between you will be blocked.`, {
    title: 'Block musician',
    confirmLabel: 'Block',
    danger: true
  });
  if (!ok) return;

  try {
    const res = await fetch('/api/user-blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked_id: userId })
    });
    if (res.ok) {
      showToast('Blocked');
      // Remove card from current view.
      const card = document.querySelector(`.disc-card[data-user-id="${userId}"]`);
      if (card) card.remove();
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || 'Could not block');
    }
  } catch (err) {
    console.error('Block error:', err);
    showToast('Could not block');
  }
}
window.discoverAction_block = discoverAction_block;

function discoverAction_report(userId) {
  closeDiscoverSheet();
  const u = (window._discoverCardCache || {})[userId];
  const name = u ? (u.display_name || u.name || 'this musician') : 'this musician';

  closeDiscoverSheet();
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'discoverSheet';
  overlay.innerHTML = `
    <div class="sheet-panel" onclick="event.stopPropagation()">
      <div class="sheet-handle"></div>
      <div class="sheet-title">Report ${escapeHtml(name)}</div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;line-height:1.4;">Reports are reviewed by the TrackMyGigs team. Abuse of the report tool may result in your own account being restricted.</div>
      <button class="sheet-btn" onclick="submitDiscoverReport('${escapeAttr(userId)}','spam')">Spam or unwanted contact</button>
      <button class="sheet-btn" onclick="submitDiscoverReport('${escapeAttr(userId)}','impersonation')">Impersonation</button>
      <button class="sheet-btn" onclick="submitDiscoverReport('${escapeAttr(userId)}','harassment')">Harassment or abuse</button>
      <button class="sheet-btn" onclick="submitDiscoverReport('${escapeAttr(userId)}','fake')">Fake profile</button>
      <button class="sheet-btn" onclick="submitDiscoverReport('${escapeAttr(userId)}','other')">Something else</button>
      <button class="sheet-btn" style="margin-top:10px;text-align:center;" onclick="closeDiscoverSheet()">Cancel</button>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) closeDiscoverSheet(); };
  document.body.appendChild(overlay);
}
window.discoverAction_report = discoverAction_report;

async function submitDiscoverReport(userId, category) {
  closeDiscoverSheet();
  try {
    const res = await fetch('/api/user-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: userId, reason_category: category, reason_text: '' })
    });
    if (res.ok) {
      showToast('Report submitted. Thanks.');
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || 'Could not submit report');
    }
  } catch (err) {
    console.error('Report error:', err);
    showToast('Could not submit report');
  }
}
window.submitDiscoverReport = submitDiscoverReport;

async function openContactDetail(contactId) {
  const body = document.getElementById('contactDetailBody');
  if (!body) return;

  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading contact...</div>';
  openPanel('panel-contact-detail');

  try {
    const res = await fetch(`/api/contacts/${contactId}`);
    if (!res.ok) throw new Error('Failed to fetch contact');
    const contact = await res.json();

    const initial = (contact.name || 'U')[0].toUpperCase();
    const instrumentsText = Array.isArray(contact.instruments)
      ? contact.instruments.join(', ')
      : (contact.instruments || '');

    let html = `
      <div style="padding:0 16px;text-align:center;margin-bottom:12px;">
        <div style="width:48px;height:48px;margin:0 auto 12px;border-radius:24px;background:var(--accent-dim);border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:var(--accent);">${initial}</div>
        <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(contact.name)}</div>
        <div style="font-size:12px;color:var(--text-2);margin-top:2px;">${escapeHtml(instrumentsText || 'No instruments')}</div>
        ${contact.location ? `<div style="font-size:12px;color:var(--text-2);">&#x1F4CD; ${escapeHtml(contact.location)}</div>` : ''}
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
        <button onclick="editContact('${contact.id}')" class="pill-g">Edit contact</button>
        <button onclick="deleteContact('${contact.id}')" class="pill-g" style="background:var(--danger-dim);color:var(--danger);border-color:var(--danger);">Delete contact</button>
      </div>
      ${contact.notes ? `<div style="padding:0 16px;margin-bottom:12px;"><div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:12px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Notes</div>
        <div style="font-size:13px;color:var(--text);">${escapeHtml(contact.notes)}</div>
      </div></div>` : ''}`;

    body.innerHTML = html;
  } catch (err) {
    console.error('Contact detail error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load contact</div>';
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
        <div class="tb" onclick="switchRepertoireTab('import')">Import</div>
      </div>
      <div id="repertoireContent" style="padding:0 16px;">`;

    // Cache for filterSongs()
    window._cachedSongs = songs;

    // Songs tab
    html += `<div id="songsTab">
      <div style="padding:8px 0;">
        <input type="text" class="fi" placeholder="Search songs..." id="songSearch" oninput="filterSongs()" />
      </div>
      <button onclick="openSongForm()" class="pill" style="margin-bottom:12px;">+ Add Song</button>
      <div id="songList">
        ${songs.map(song => renderSongRow(song)).join('')}
      </div>
    </div>`;

    // Setlists tab
    html += `<div id="setlistsTab" style="display:none;">
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <button onclick="openPanel('panel-create-setlist')" class="pill">+ Create Setlist</button>
        <button type="button" onclick="window.aiSetListGenerator && window.aiSetListGenerator()" style="background:var(--accent-dim, rgba(240,165,0,.18));color:var(--accent,#f0a500);border:1px solid rgba(240,165,0,.4);border-radius:999px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;">&#10024; Generate with AI</button>
      </div>
      ${setlists.map(setlist => `
      <div style="padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(setlist.name)}</div>
        <div style="font-size:11px;color:var(--text-2);">${setlist.song_count} songs · ${setlist.duration || '?'} mins · ${setlist.linked_gig ? 'Linked to gig' : 'Not linked'}</div>
      </div>`).join('')}
    </div>`;

    // Import tab (ChordPro)
    html += `<div id="importTab" style="display:none;padding:12px 0;">
      <div style="font-size:13px;color:var(--text);margin-bottom:6px;font-weight:600;">ChordPro import</div>
      <div style="font-size:11px;color:var(--text-2);line-height:1.5;margin-bottom:12px;">
        Select one or more .chopro, .chordpro or .cho files. We read the title, artist, key and lyrics so you don't have to retype them. Chord brackets stay in the lyrics so they're visible when you expand the song.
      </div>
      <input type="file" id="chordProFile" accept=".chopro,.chordpro,.cho,text/plain" multiple
        onchange="parseChordProFiles(event)"
        style="display:block;width:100%;padding:12px;background:var(--card);border:1px dashed var(--border);border-radius:var(--rs);color:var(--text-2);font-size:12px;cursor:pointer;margin-bottom:12px;" />
      <div style="margin:10px 0 14px;padding:10px 12px;border:1px solid rgba(240,165,0,.35);background:rgba(240,165,0,.08);border-radius:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--accent,#f0a500);margin-bottom:4px;">&#10024; No ChordPro file? Paste messy text</div>
        <div style="font-size:11px;color:var(--text-2);line-height:1.5;margin-bottom:8px;">Paste any chart, lyrics-with-chords-above, or transcription and I will convert it to proper ChordPro with title, key and tempo.</div>
        <button type="button" onclick="window.aiChordProNormalise && window.aiChordProNormalise({ onApply: function(d){ if(!d) return; var item = { title: d.title || 'Untitled', artist: d.artist || '', key: d.key || '', tempo: d.tempo || '', time_signature: d.time_signature || '', lyrics: d.cleaned || '', _filename: 'AI cleaned' }; if(!Array.isArray(window._chordProPending)) window._chordProPending = []; window._chordProPending.push(item); if(typeof renderChordProPreview==='function') renderChordProPreview(); } })" style="background:var(--accent,#f0a500);color:#000;border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;">Clean up with AI</button>
      </div>
      <div id="chordProPreview"></div>
      <div style="font-size:10px;color:var(--text-3);line-height:1.5;margin-top:16px;">
        Tip: most ChordPro files include {title}, {artist} and {key} directives. Anything we can't read will show as blank so you can fill it in before saving.
      </div>
    </div>`;

    html += `</div>`;
    body.innerHTML = html;
  } catch (err) {
    console.error('Repertoire error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load repertoire</div>';
  }
}

async function openSongForm(songId) {
  const panel = document.getElementById('songFormBody');
  if (!panel) return;

  if (songId) {
    panel.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading song...</div>';
    try {
      const res = await fetch(`/api/songs/${songId}`);
      if (!res.ok) throw new Error('Failed to fetch song');
      const song = await res.json();

      panel.innerHTML = `
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
            <input type="text" class="fi" id="songTags" value="${escapeHtml(Array.isArray(song.tags) ? song.tags.join(', ') : (song.tags || ''))}" placeholder="comma separated" />
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

  openPanel('panel-song-form');
}

async function openStandaloneInvoice() {
  // Reset the create-invoice form and open panel-invoice
  const fields = ['invInvoiceNumber','invBillTo','invClientAddress','invDesc','invAmount','invDueDate','invNotes'];
  fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const linked = document.getElementById('invLinkedGig');
  if (linked) linked.value = '';
  openPanel('panel-invoice');
  // Wire gig dropdown, saved-client auto-fill, preview listeners, invoice
  // number generation. Without this the panel opens but auto-fill and live
  // preview do not work (regression from when the nav pill called this
  // itself and the screen-level "+ New" button skipped it).
  if (typeof initInvoicePanel === 'function') initInvoicePanel();
}

async function openSendInvoice(invoiceId) {
  const body = document.getElementById('sendInvoiceBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-2);">Loading...</div>';
  openPanel('panel-send-invoice');
  try {
    const res = await fetch(`/api/invoices/${invoiceId}`);
    if (!res.ok) throw new Error('Failed to fetch invoice');
    const invoice = await res.json();
    body.innerHTML = `
      <div style="padding:0 16px 20px;">
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:12px;">
          <div style="font-size:12px;color:var(--text-2);">Invoice</div>
          <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(invoice.invoice_number || ('INV-' + String(invoice.id).slice(0,6)))}</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:4px;">To: ${escapeHtml(invoice.band_name || '')}</div>
          <div style="font-size:13px;font-weight:700;color:var(--success);margin-top:6px;">&pound;${parseFloat(invoice.amount || 0).toFixed(2)}</div>
        </div>
        <div class="form-group"><label class="fl">Recipient email</label><input type="email" class="fi" id="sendInvoiceEmail" value="${escapeHtml(invoice.recipient_email || '')}" placeholder="client@example.com" /></div>
        <div class="form-group"><label class="fl">Message (optional)</label><textarea class="fi" id="sendInvoiceMessage" style="resize:vertical;height:100px;">Hi, please find attached invoice ${escapeHtml(invoice.invoice_number || '')} for recent work. Thanks!</textarea></div>
        <button onclick="confirmSendInvoice('${invoice.id}')" class="pill">Send now</button>
        <div id="sendInvoiceStatus" style="font-size:11px;color:var(--text-2);text-align:center;margin-top:10px;"></div>
      </div>`;
  } catch (err) {
    console.error('Send invoice panel error:', err);
    body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--danger);">Failed to load invoice</div>';
  }
}

async function confirmSendInvoice(invoiceId) {
  const emailEl = document.getElementById('sendInvoiceEmail');
  const msgEl = document.getElementById('sendInvoiceMessage');
  const status = document.getElementById('sendInvoiceStatus');
  if (!emailEl || !emailEl.value.trim()) { if (status) status.textContent = 'Email is required.'; return; }
  const toAddr = emailEl.value.trim();
  const message = (msgEl && msgEl.value.trim()) || '';
  try {
    // Flip the invoice to 'sent' and persist the recipient email so Chase can
    // reuse it without re-prompting. The server auto-stamps sent_at.
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'sent', recipient_email: toAddr })
    });
    if (!res.ok) throw new Error('Send failed');
    // Invalidate and refresh the list so totals + status badges update
    window._cachedInvoices = null;
    window._cachedInvoicesTime = 0;
    if (typeof renderInvoicesScreen === 'function') {
      try { await renderInvoicesScreen(); } catch (_) {}
    }
    if (status) status.textContent = 'Invoice saved. Opening email...';
    if (typeof showToast === 'function') showToast('Invoice sent');

    // Grab the invoice so we can build a sensible subject line.
    let invoice = {};
    try {
      const invR = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
      if (invR.ok) invoice = await invR.json();
    } catch (_) {}
    const invNum = invoice.invoice_number || `INV-${String(invoiceId).slice(0, 6)}`;
    const subject = `Invoice ${invNum}`;

    // Touch + Web Share with files: attach the PDF.
    const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const canShare = typeof navigator.share === 'function';
    let shared = false;
    if (isTouch && canShare && typeof navigator.canShare === 'function') {
      try {
        const pdfRes = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/pdf`, { credentials: 'same-origin' });
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          const file = new File([blob], `Invoice_${invNum}.pdf`, { type: 'application/pdf' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({
              files: [file],
              title: subject,
              text: `To: ${toAddr}\n\n${message}`,
            });
            shared = true;
          }
        }
      } catch (err) {
        if (!(err && err.name === 'AbortError')) {
          console.warn('Share with PDF failed, falling back:', err);
        } else {
          // User cancelled the share sheet; don't open mailto on top.
          shared = true;
        }
      }
    }

    // Desktop / fallback: trigger PDF download and open mailto so the user
    // drags the downloaded PDF into the email.
    if (!shared) {
      try {
        const a = document.createElement('a');
        a.href = `/api/invoices/${encodeURIComponent(invoiceId)}/pdf`;
        a.download = `Invoice_${invNum}.pdf`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 500);
      } catch (_) {}
      const mailto = `mailto:${encodeURIComponent(toAddr)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
      window.location.href = mailto;
    }

    setTimeout(() => {
      closePanel('panel-send-invoice');
      openInvoiceDetail(invoiceId).catch(() => {});
    }, 600);
  } catch (err) {
    console.error('Send invoice error:', err);
    if (status) status.textContent = 'Could not send invoice. Try again.';
  }
}

// ── Phase IX-D: Add Contact auto-suggest bridge ─────────────────────────────
// When the user types an email or phone into the Add Contact form and the
// value matches a discoverable TrackMyGigs user, we surface a chip above the
// form: "Link to Jane on TrackMyGigs". Clicking Link pre-fills the public
// fields (name, instruments, outward postcode) and stores linked_user_id on
// the contact so later dep cascades know this contact IS a TMG member.
//
// Behaviour rules:
//   - Debounce 500ms after input to avoid one lookup per keystroke.
//   - Only query once a value is parseable (email has '@...' shape, phone
//     passes E.164 normalise at the server — server returns 400 otherwise
//     and we silently drop).
//   - Don't re-query the same value we've already shown or dismissed.
//   - If server returns 429 (rate-limited), silently hide chip; user can
//     still save the contact as a plain row.
//   - If the user clicks Dismiss, we don't surface the chip again for the
//     same email/phone in this panel session.
//   - On panel close or successful save, reset all state.

window._addContactState = window._addContactState || {
  linked_user_id: null,
  linked_display_name: null,
  last_email_q: '',
  last_phone_q: '',
  dismissed_email_q: '',
  dismissed_phone_q: '',
  email_timer: null,
  phone_timer: null
};

function resetAddContactState() {
  const s = window._addContactState;
  if (s.email_timer) { clearTimeout(s.email_timer); s.email_timer = null; }
  if (s.phone_timer) { clearTimeout(s.phone_timer); s.phone_timer = null; }
  s.linked_user_id = null;
  s.linked_display_name = null;
  s.last_email_q = '';
  s.last_phone_q = '';
  s.dismissed_email_q = '';
  s.dismissed_phone_q = '';
  const chip = document.getElementById('addContactSuggestChip');
  if (chip) { chip.style.display = 'none'; chip.innerHTML = ''; }
}

function initAddContactPanel() {
  resetAddContactState();
  const email = document.getElementById('contactEmail');
  const phone = document.getElementById('contactPhone');
  // Attach listeners idempotently: strip any prior handlers by cloning. The
  // panel can be opened and closed many times per session so we don't want
  // to stack duplicate debounced lookups.
  if (email) {
    const fresh = email.cloneNode(true);
    email.parentNode.replaceChild(fresh, email);
    fresh.addEventListener('input', () => scheduleDiscoverMiniLookup('email'));
    fresh.addEventListener('blur', () => scheduleDiscoverMiniLookup('email', 0));
  }
  if (phone) {
    const fresh = phone.cloneNode(true);
    phone.parentNode.replaceChild(fresh, phone);
    fresh.addEventListener('input', () => scheduleDiscoverMiniLookup('phone'));
    fresh.addEventListener('blur', () => scheduleDiscoverMiniLookup('phone', 0));
  }
}
window.initAddContactPanel = initAddContactPanel;

function scheduleDiscoverMiniLookup(mode, delay) {
  const s = window._addContactState;
  const wait = (delay == null) ? 500 : delay;
  const timerKey = mode === 'email' ? 'email_timer' : 'phone_timer';
  if (s[timerKey]) clearTimeout(s[timerKey]);
  s[timerKey] = setTimeout(() => runDiscoverMiniLookup(mode), wait);
}

async function runDiscoverMiniLookup(mode) {
  const s = window._addContactState;
  const el = document.getElementById(mode === 'email' ? 'contactEmail' : 'contactPhone');
  if (!el) return;
  const raw = (el.value || '').trim();
  if (!raw) return;

  // Cheap client-side guard: email must include '@' and a dot; phone must
  // have 7+ digits. Server rejects invalid values anyway, but skipping them
  // saves one rate-limited lookup per keystroke while the user is still
  // typing.
  if (mode === 'email') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return;
  } else {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7) return;
  }

  // De-dupe: don't re-query the last value we already looked up, and don't
  // re-query a value the user has explicitly dismissed.
  const lastKey = mode === 'email' ? 'last_email_q' : 'last_phone_q';
  const dismissKey = mode === 'email' ? 'dismissed_email_q' : 'dismissed_phone_q';
  if (s[lastKey] === raw) return;
  if (s[dismissKey] === raw) return;
  s[lastKey] = raw;

  try {
    const url = `/api/discover-mini?mode=${mode}&q=${encodeURIComponent(raw)}`;
    const res = await fetch(url);
    if (!res.ok) {
      // 400 = invalid, 429 = rate limited, 401 = session expired. All silent.
      return;
    }
    const data = await res.json();
    if (!data || !data.match) return;
    renderAddContactChip(data.match, mode, raw);
  } catch (err) {
    // Network errors: silent. Chip is a convenience, not a required feature.
    console.warn('[discover-mini] lookup failed:', err && err.message);
  }
}

function renderAddContactChip(match, mode, originQuery) {
  const chip = document.getElementById('addContactSuggestChip');
  if (!chip) return;
  const name = match.display_name || 'TrackMyGigs user';
  const instruments = Array.isArray(match.instruments) && match.instruments.length > 0
    ? match.instruments.join(', ')
    : '';
  const postcode = match.outward_postcode || '';
  const initial = (name[0] || '?').toUpperCase();
  const avatar = match.photo_url
    ? `<img src="${escapeAttr(match.photo_url)}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
    : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0;">${escapeHtml(initial)}</div>`;
  const detailLine = [instruments, postcode].filter(Boolean).join(' \u00b7 ');

  // Stash the payload on window for the button handlers; we can't pass
  // objects through inline onclick attributes.
  window._addContactPendingMatch = {
    id: match.id,
    display_name: name,
    instruments: Array.isArray(match.instruments) ? match.instruments : [],
    outward_postcode: postcode,
    photo_url: match.photo_url || null,
    origin_mode: mode,
    origin_query: originQuery
  };

  chip.style.display = 'block';
  chip.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--accent);border-radius:12px;padding:12px 14px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${avatar}
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:1px;font-weight:700;">On TrackMyGigs</div>
          <div style="font-size:14px;color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
          ${detailLine ? `<div style="font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(detailLine)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button onclick="addContactLinkClick()" style="flex:1;background:var(--accent);color:#000;border:none;border-radius:10px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;">Link & pre-fill</button>
        <button onclick="addContactDismissChip()" style="background:transparent;color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;font-size:13px;cursor:pointer;">Dismiss</button>
      </div>
    </div>`;
}

function addContactLinkClick() {
  const m = window._addContactPendingMatch;
  if (!m) return;
  const s = window._addContactState;

  // Pre-fill only blank fields so we never overwrite what the user already
  // typed. Instruments is special: only pre-fill if the field is empty,
  // don't merge into an existing list.
  const nameEl = document.getElementById('contactName');
  if (nameEl && !nameEl.value.trim()) nameEl.value = m.display_name || '';
  const instrEl = document.getElementById('contactInstruments');
  if (instrEl && !instrEl.value.trim() && Array.isArray(m.instruments) && m.instruments.length) {
    instrEl.value = m.instruments.join(', ');
  }
  const locEl = document.getElementById('contactLocation');
  if (locEl && !locEl.value.trim() && m.outward_postcode) locEl.value = m.outward_postcode;

  s.linked_user_id = m.id;
  s.linked_display_name = m.display_name;

  // Collapse the chip to a "Linked" confirmation strip.
  const chip = document.getElementById('addContactSuggestChip');
  if (chip) {
    chip.innerHTML = `
      <div style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.4);border-radius:10px;padding:10px 12px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="font-size:12px;color:var(--text);">
          <span style="color:#10b981;font-weight:700;">\u2713</span>
          Linked to <strong>${escapeHtml(m.display_name || 'TrackMyGigs user')}</strong>
        </div>
        <button onclick="addContactUnlink()" style="background:transparent;border:none;color:var(--text-3);font-size:11px;text-decoration:underline;cursor:pointer;padding:4px;">Unlink</button>
      </div>`;
  }
}
window.addContactLinkClick = addContactLinkClick;

function addContactDismissChip() {
  const s = window._addContactState;
  const m = window._addContactPendingMatch;
  if (m && m.origin_mode === 'email') s.dismissed_email_q = m.origin_query;
  if (m && m.origin_mode === 'phone') s.dismissed_phone_q = m.origin_query;
  window._addContactPendingMatch = null;
  const chip = document.getElementById('addContactSuggestChip');
  if (chip) { chip.style.display = 'none'; chip.innerHTML = ''; }
}
window.addContactDismissChip = addContactDismissChip;

function addContactUnlink() {
  const s = window._addContactState;
  s.linked_user_id = null;
  s.linked_display_name = null;
  // Clear the dismissed caches so an unlink can re-surface the chip when
  // the user resaves the email/phone in the same panel session.
  s.dismissed_email_q = '';
  s.dismissed_phone_q = '';
  s.last_email_q = '';
  s.last_phone_q = '';
  const chip = document.getElementById('addContactSuggestChip');
  if (chip) { chip.style.display = 'none'; chip.innerHTML = ''; }
}
window.addContactUnlink = addContactUnlink;

async function saveNewContact() {
  const name = (document.getElementById('contactName')||{}).value || '';
  if (!name.trim()) { if (typeof showToast === 'function') showToast('Name is required'); return; }
  const s = window._addContactState || {};
  const payload = {
    name: name.trim(),
    instruments: ((document.getElementById('contactInstruments')||{}).value || '').split(',').map(s => s.trim()).filter(Boolean),
    phone: ((document.getElementById('contactPhone')||{}).value || '').trim() || null,
    email: ((document.getElementById('contactEmail')||{}).value || '').trim() || null,
    location: ((document.getElementById('contactLocation')||{}).value || '').trim() || null,
    notes: ((document.getElementById('contactNotes')||{}).value || '').trim() || null,
    is_favourite: !!(document.getElementById('contactFavourite') || {}).checked,
    linked_user_id: s.linked_user_id || null
  };
  try {
    const res = await fetch('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('Create failed');
    // Reset fields
    ['contactName','contactInstruments','contactPhone','contactEmail','contactLocation','contactNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const fav = document.getElementById('contactFavourite'); if (fav) fav.checked = false;
    resetAddContactState();
    if (typeof showToast === 'function') showToast('Contact saved');
    closePanel('panel-add-contact');
    if (typeof openNetworkPanel === 'function') openNetworkPanel();
  } catch (err) {
    console.error('Save contact error:', err);
    if (typeof showToast === 'function') showToast('Could not save contact');
  }
}

async function saveNewSetlist() {
  const name = ((document.getElementById('setlistName')||{}).value || '').trim();
  if (!name) { if (typeof showToast === 'function') showToast('Setlist name is required'); return; }
  const duration = ((document.getElementById('setlistDuration')||{}).value || '').trim();
  const notes = ((document.getElementById('setlistNotes')||{}).value || '').trim();
  try {
    const res = await fetch('/api/setlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, duration: duration ? parseInt(duration, 10) : null, notes: notes || null })
    });
    if (!res.ok) throw new Error('Create failed');
    ['setlistName','setlistDuration','setlistNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    if (typeof showToast === 'function') showToast('Setlist created');
    closePanel('panel-create-setlist');
    if (typeof openRepertoirePanel === 'function') openRepertoirePanel();
  } catch (err) {
    console.error('Save setlist error:', err);
    if (typeof showToast === 'function') showToast('Could not create setlist');
  }
}

// BUG-AUDIT-01: Loader for the notification-preferences panel. The panel open hook already
// tries typeof loadNotificationSettings, so we simply need to define it so the checkboxes
// hydrate with what the user has actually saved.
async function loadNotificationSettings() {
  const status = document.getElementById('notifSettingsStatus');
  try {
    const res = await fetch('/api/user/notification-preferences');
    if (!res.ok) throw new Error('Load failed');
    const prefs = await res.json();
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.checked = v !== false; // missing -> default on
    };
    set('notifyDepOffers', prefs.dep_offers);
    set('notifyChat', prefs.chat);
    set('notifyGigReminders', prefs.gig_reminders);
    set('notifyInvoices', prefs.invoices);
    set('notifyWeekly', prefs.weekly);
    set('notifyEmailImportant', prefs.email_important);
    if (status) status.textContent = '';
  } catch (err) {
    // Silent fail: defaults stay checked so the panel is usable even offline.
    console.warn('Load notif prefs error:', err);
  }
}
window.loadNotificationSettings = loadNotificationSettings;

async function saveNotificationSettings() {
  const status = document.getElementById('notifSettingsStatus');
  const prefs = {
    dep_offers: !!(document.getElementById('notifyDepOffers') || {}).checked,
    chat: !!(document.getElementById('notifyChat') || {}).checked,
    gig_reminders: !!(document.getElementById('notifyGigReminders') || {}).checked,
    invoices: !!(document.getElementById('notifyInvoices') || {}).checked,
    weekly: !!(document.getElementById('notifyWeekly') || {}).checked,
    email_important: !!(document.getElementById('notifyEmailImportant') || {}).checked
  };
  try {
    const res = await fetch('/api/user/notification-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs)
    });
    if (!res.ok) throw new Error('Save failed');
    if (status) status.textContent = 'Preferences saved.';
    if (typeof showToast === 'function') showToast('Preferences saved');
  } catch (err) {
    console.error('Save notif prefs error:', err);
    if (status) status.textContent = 'Could not save preferences.';
  }
}
window.saveNotificationSettings = saveNotificationSettings;

async function editContact(contactId) {
  // Reuse add-contact panel pre-filled
  try {
    const res = await fetch(`/api/contacts/${contactId}`);
    if (!res.ok) throw new Error('Failed to fetch contact');
    const c = await res.json();
    openPanel('panel-add-contact');
    const instrumentsText = Array.isArray(c.instruments) ? c.instruments.join(', ') : (c.instruments || '');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    set('contactName', c.name);
    set('contactInstruments', instrumentsText);
    set('contactPhone', c.phone);
    set('contactEmail', c.email);
    set('contactLocation', c.location);
    set('contactNotes', c.notes);
    const fav = document.getElementById('contactFavourite'); if (fav) fav.checked = !!c.is_favourite;
    // Override save button to PATCH instead of POST
    const body = document.getElementById('addContactBody');
    const btn = body && body.querySelector('button.pill');
    if (btn) btn.setAttribute('onclick', `updateContact('${c.id}')`);
  } catch (err) {
    console.error('Edit contact error:', err);
    if (typeof showToast === 'function') showToast('Could not load contact');
  }
}

async function updateContact(contactId) {
  const payload = {
    name: ((document.getElementById('contactName')||{}).value || '').trim(),
    instruments: ((document.getElementById('contactInstruments')||{}).value || '').split(',').map(s => s.trim()).filter(Boolean),
    phone: ((document.getElementById('contactPhone')||{}).value || '').trim() || null,
    email: ((document.getElementById('contactEmail')||{}).value || '').trim() || null,
    location: ((document.getElementById('contactLocation')||{}).value || '').trim() || null,
    notes: ((document.getElementById('contactNotes')||{}).value || '').trim() || null,
    is_favourite: !!(document.getElementById('contactFavourite') || {}).checked
  };
  try {
    const res = await fetch(`/api/contacts/${contactId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('Update failed');
    if (typeof showToast === 'function') showToast('Contact updated');
    closePanel('panel-add-contact');
    if (typeof openNetworkPanel === 'function') openNetworkPanel();
  } catch (err) {
    console.error('Update contact error:', err);
    if (typeof showToast === 'function') showToast('Could not update contact');
  }
}

async function deleteContact(contactId) {
  const ok = await showConfirm('Delete this contact? This cannot be undone.', {
    title: 'Delete contact?',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/contacts/${contactId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    if (typeof showToast === 'function') showToast('Contact deleted');
    closePanel('panel-contact-detail');
    if (typeof openNetworkPanel === 'function') openNetworkPanel();
  } catch (err) {
    console.error('Delete contact error:', err);
    if (typeof showToast === 'function') showToast('Could not delete contact');
  }
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

// Legacy openFinancePanel() removed — renderFinancePanel() now handles the
// unified Finance Dashboard inside #panel-finance. The orphan #finance-panel
// overlay in index.html (with #financePanelBody) is also unused; left in place
// as a dormant fallback target for renderFinancePanel so nothing breaks at runtime.

// Toggle the expense breakdown: show category rows the first time, hide on next tap
function renderExpenseBreakdown() {
  const container = document.getElementById('financeCategoryBreakdown');
  if (!container) return;
  if (container.innerHTML && container.innerHTML.trim() !== '') {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text-3);font-size:11px;">Loading breakdown...</div>';
  renderFinanceCategoryBreakdown();
}

async function renderFinanceCategoryBreakdown() {
  const container = document.getElementById('financeCategoryBreakdown');
  if (!container) return;
  try {
    const res = await fetch('/api/expenses');
    if (!res.ok) return;
    const data = await res.json();
    const expenses = data.expenses || [];
    if (expenses.length === 0) { container.innerHTML = ''; return; }

    // Filter to current UK tax year (6 Apr - 5 Apr)
    const now = new Date();
    const taxYearStart = new Date(now.getMonth() < 3 || (now.getMonth() === 3 && now.getDate() < 6)
      ? now.getFullYear() - 1 : now.getFullYear(), 3, 6);
    const taxYearEnd = new Date(taxYearStart.getFullYear() + 1, 3, 6);

    const inYear = expenses.filter(e => {
      const d = new Date(e.date);
      return d >= taxYearStart && d < taxYearEnd;
    });
    if (inYear.length === 0) { container.innerHTML = ''; return; }

    const totals = {};
    let grand = 0;
    inYear.forEach(e => {
      const cat = (e.category || 'Other').trim() || 'Other';
      const amt = parseFloat(e.amount) || 0;
      totals[cat] = (totals[cat] || 0) + amt;
      grand += amt;
    });
    const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);

    let html = `<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
      <span>HMRC category breakdown</span>
      <span style="font-weight:500;text-transform:none;letter-spacing:0;font-size:10px;color:var(--text-3);">${taxYearStart.getFullYear()}/${(taxYearStart.getFullYear() + 1).toString().slice(2)}</span>
    </div>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:4px 12px;">`;
    rows.forEach(([cat, total], i) => {
      const pct = grand > 0 ? Math.round((total / grand) * 100) : 0;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;${i < rows.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}font-size:12px;">
        <div style="flex:1;min-width:0;">
          <div style="color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(cat)}</div>
          <div style="height:3px;background:var(--bg,#0D1117);border-radius:2px;margin-top:4px;overflow:hidden;max-width:140px;">
            <div style="width:${pct}%;height:100%;background:var(--accent);"></div>
          </div>
        </div>
        <div style="text-align:right;margin-left:12px;">
          <div style="color:var(--text);font-weight:600;">£${total.toFixed(0)}</div>
          <div style="color:var(--text-3);font-size:10px;">${pct}%</div>
        </div>
      </div>`;
    });
    html += `</div>
      <div style="font-size:10px;color:var(--text-3);margin-top:6px;line-height:1.4;">
        Totals roll into the matching HMRC SA103 (self-employment) box at tax time.
      </div>`;
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '';
  }
}

async function saveSong(songId) {
  const titleEl = document.getElementById('songTitle');
  const title = (titleEl?.value || '').trim();
  if (!title) {
    alert('Title is required');
    titleEl?.focus();
    return;
  }
  const payload = {
    title,
    artist: (document.getElementById('songArtist')?.value || '').trim() || null,
    key: (document.getElementById('songKey')?.value || '').trim() || null,
    tempo: parseInt(document.getElementById('songTempo')?.value, 10) || null,
    duration: parseInt(document.getElementById('songDuration')?.value, 10) || null,
    genre: (document.getElementById('songGenre')?.value || '').trim() || null,
    tags: (document.getElementById('songTags')?.value || '').trim() || null,
    lyrics: (document.getElementById('songLyrics')?.value || '').trim() || null,
  };
  try {
    const url = songId ? `/api/songs/${encodeURIComponent(songId)}` : '/api/songs';
    const method = songId ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Save failed');
    }
    closePanel('panel-song-form');
    if (typeof openRepertoirePanel === 'function') openRepertoirePanel();
    else if (typeof renderRepertoireList === 'function') renderRepertoireList();
  } catch (e) {
    console.error('Save song error:', e);
    alert('Could not save song: ' + (e.message || 'unknown error'));
  }
}

function renderContactsList() {
  const container = document.getElementById('contactsList');
  if (!container) return;

  const searchQuery = (document.getElementById('contactSearch')?.value || '').toLowerCase().trim();
  let contacts = window._cachedContacts || [];
  const filterType = window._contactFilterType || 'all';

  // Text search across name and instruments (instruments is text[] in DB)
  if (searchQuery) {
    contacts = contacts.filter(c => {
      const instrStr = Array.isArray(c.instruments) ? c.instruments.join(', ') : (c.instruments || '');
      return (c.name || '').toLowerCase().includes(searchQuery) ||
        instrStr.toLowerCase().includes(searchQuery);
    });
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
      const instr = Array.isArray(c.instruments)
        ? c.instruments.map(s => String(s).trim()).filter(Boolean)
        : String(c.instruments || '').split(',').map(s => s.trim()).filter(Boolean);
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
        <div style="font-size:11px;color:var(--text-2);">${escapeHtml(Array.isArray(contact.instruments) ? (contact.instruments.join(', ') || 'No instruments') : (contact.instruments || 'No instruments'))}</div>
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
  // Remember which contact the user started from so the dep picker can
  // prefill them once a gig is chosen.
  window._depPrefillContactId = contactId;
  closePanel('panel-contact-detail');
  openDepPicker();
}
window.sendDepOffer = sendDepOffer;

async function messageContact(contactId) {
  try {
    const res = await fetch(`/api/contacts/${encodeURIComponent(contactId)}`);
    if (!res.ok) throw new Error('Failed to load contact');
    const contact = await res.json();
    // Prefer SMS if we have a phone number, fall back to email.
    if (contact.phone) {
      window.location.href = `sms:${contact.phone.replace(/\s+/g, '')}`;
      return;
    }
    if (contact.email) {
      window.location.href = `mailto:${contact.email}`;
      return;
    }
    alert('No phone or email saved for this contact.');
  } catch (e) {
    console.error('Message contact error:', e);
    alert('Could not open messaging: ' + (e.message || 'unknown error'));
  }
}

async function callContact(contactId) {
  try {
    const res = await fetch(`/api/contacts/${encodeURIComponent(contactId)}`);
    if (!res.ok) throw new Error('Failed to load contact');
    const contact = await res.json();
    if (!contact.phone) {
      alert('No phone number saved for this contact.');
      return;
    }
    window.location.href = `tel:${contact.phone.replace(/\s+/g, '')}`;
  } catch (e) {
    console.error('Call contact error:', e);
    alert('Could not place call: ' + (e.message || 'unknown error'));
  }
}

function renderSongRow(song) {
  return `<div onclick="openSongForm('${song.id}')" style="padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;">
    <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(song.title || '')}</div>
    <div style="font-size:11px;color:var(--text-2);">${escapeHtml(song.artist || '')} · Key: ${escapeHtml(song.key || 'N/A')} · ${song.tempo || '?'} BPM</div>
  </div>`;
}

function filterSongs() {
  const input = document.getElementById('songSearch');
  const list = document.getElementById('songList');
  if (!input || !list) return;
  const q = (input.value || '').trim().toLowerCase();
  const all = Array.isArray(window._cachedSongs) ? window._cachedSongs : [];
  const filtered = !q ? all : all.filter(s => {
    const title = (s.title || '').toLowerCase();
    const artist = (s.artist || '').toLowerCase();
    const tags = Array.isArray(s.tags) ? s.tags.join(' ').toLowerCase() : String(s.tags || '').toLowerCase();
    const key = (s.song_key || s.key || '').toLowerCase();
    return title.includes(q) || artist.includes(q) || tags.includes(q) || key.includes(q);
  });
  list.innerHTML = filtered.length === 0
    ? '<div style="padding:20px;text-align:center;color:var(--text-2);font-size:13px;">No matching songs.</div>'
    : filtered.map(s => renderSongRow(s)).join('');
}

function switchRepertoireTab(tab) {
  const songsEl = document.getElementById('songsTab');
  const setlistsEl = document.getElementById('setlistsTab');
  const importEl = document.getElementById('importTab');
  if (songsEl) songsEl.style.display = tab === 'songs' ? 'block' : 'none';
  if (setlistsEl) setlistsEl.style.display = tab === 'setlists' ? 'block' : 'none';
  if (importEl) importEl.style.display = tab === 'import' ? 'block' : 'none';
  document.querySelectorAll('#repertoireContent .tb, #panel-repertoire .tb').forEach((t) => {
    const label = (t.textContent || '').trim().toLowerCase();
    t.classList.toggle('ac', label === tab);
  });
}

// ─── ChordPro parser & import ─────────────────────────────────────────────────
// Parses a single ChordPro document. Supports {title}, {artist}, {key}, {tempo},
// {capo}, {comment}/{c} directives, inline [chord] tags, verse/chorus markers.
function parseChordPro(text) {
  const lines = String(text || '').split(/\r?\n/);
  let title = '', artist = '', key = '', tempo = null;
  const contentLines = [];
  const chordSet = new Set();
  for (const raw of lines) {
    const line = raw || '';
    // Directive: {name: value} or {name}
    const dir = line.match(/^\s*\{([^:}]+)(?::\s*(.*?))?\}\s*$/);
    if (dir) {
      const name = dir[1].trim().toLowerCase();
      const value = (dir[2] || '').trim();
      if (!title && (name === 'title' || name === 't')) { title = value; continue; }
      if (!artist && (name === 'artist' || name === 'subtitle' || name === 'st')) { artist = value; continue; }
      if (!key && name === 'key') { key = value; continue; }
      if (!tempo && name === 'tempo') { const n = parseInt(value, 10); if (!isNaN(n)) tempo = n; continue; }
      // Skip structural directives so they don't pollute the lyrics body.
      if (['start_of_chorus','soc','end_of_chorus','eoc','start_of_verse','sov','end_of_verse','eov','start_of_bridge','sob','end_of_bridge','eob','capo','comment','c','chorus','verse','bridge'].includes(name)) {
        continue;
      }
      // Unknown directive: drop it.
      continue;
    }
    // Collect chords referenced inline
    const matches = line.match(/\[([^\]]+)\]/g);
    if (matches) matches.forEach(m => chordSet.add(m.slice(1, -1)));
    contentLines.push(line);
  }
  // If no title directive, fall back to first non-blank line.
  if (!title) {
    const firstReal = contentLines.find(l => l.trim());
    if (firstReal) title = firstReal.replace(/\[[^\]]+\]/g, '').trim().slice(0, 120);
  }
  // Trim leading/trailing blank lines
  while (contentLines.length && !contentLines[0].trim()) contentLines.shift();
  while (contentLines.length && !contentLines[contentLines.length - 1].trim()) contentLines.pop();
  return {
    title: title || 'Untitled',
    artist: artist || '',
    key: key || '',
    tempo,
    lyrics: contentLines.join('\n'),
    chords: Array.from(chordSet).join(', '),
  };
}

// Cache parsed files until user confirms import.
window._chordProPending = [];

async function parseChordProFiles(event) {
  const files = Array.from(event?.target?.files || []);
  if (!files.length) return;
  const parsed = [];
  for (const f of files) {
    try {
      const text = await f.text();
      const song = parseChordPro(text);
      parsed.push({ ...song, _filename: f.name });
    } catch (e) {
      console.error('ChordPro parse error for', f.name, e);
    }
  }
  window._chordProPending = parsed;
  renderChordProPreview();
}

function renderChordProPreview() {
  const container = document.getElementById('chordProPreview');
  if (!container) return;
  const list = window._chordProPending || [];
  if (!list.length) {
    container.innerHTML = '';
    return;
  }
  let html = `<div style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Ready to import (${list.length})</div>`;
  html += `<div style="background:var(--card);border:1px solid var(--border);border-radius:var(--rs);padding:4px 12px;margin-bottom:12px;">`;
  list.forEach((s, i) => {
    html += `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 0;${i < list.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
      <div style="flex:1;min-width:0;padding-right:8px;">
        <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(s.title)}</div>
        <div style="font-size:11px;color:var(--text-2);">${escapeHtml(s.artist || 'Unknown artist')}${s.key ? ' · Key ' + escapeHtml(s.key) : ''}${s.tempo ? ' · ' + s.tempo + ' BPM' : ''}</div>
        <div style="font-size:10px;color:var(--text-3);margin-top:2px;">${escapeHtml(s._filename || '')}</div>
      </div>
      <button onclick="removeChordProItem(${i})" style="background:none;border:none;color:var(--text-3);font-size:18px;line-height:1;cursor:pointer;padding:0 4px;">×</button>
    </div>`;
  });
  html += `</div>
    <div style="display:flex;gap:8px;">
      <button onclick="importChordProSongs()" class="pill-g" style="flex:1;">Import ${list.length} song${list.length === 1 ? '' : 's'}</button>
      <button onclick="cancelChordProImport()" class="pill-o">Cancel</button>
    </div>`;
  container.innerHTML = html;
}

function removeChordProItem(i) {
  if (!Array.isArray(window._chordProPending)) return;
  window._chordProPending.splice(i, 1);
  renderChordProPreview();
}

function cancelChordProImport() {
  window._chordProPending = [];
  const f = document.getElementById('chordProFile');
  if (f) f.value = '';
  renderChordProPreview();
}

async function importChordProSongs() {
  const list = (window._chordProPending || []).map(s => ({
    title: s.title,
    artist: s.artist || null,
    key: s.key || null,
    tempo: s.tempo || null,
    lyrics: s.lyrics || null,
    chords: s.chords || null,
  }));
  if (!list.length) return;
  try {
    const res = await fetch('/api/songs/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songs: list }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Import failed');
    }
    const out = await res.json();
    window._chordProPending = [];
    const f = document.getElementById('chordProFile');
    if (f) f.value = '';
    alert(`Imported ${out.count} song${out.count === 1 ? '' : 's'}.`);
    openRepertoirePanel();
  } catch (e) {
    console.error('ChordPro import error:', e);
    alert('Could not import songs: ' + (e.message || 'unknown error'));
  }
}

async function markInvoiceAsPaid(invoiceId) {
  const ok = await showConfirm('The invoice will show as paid in your finance totals and drop off the overdue list.', {
    title: 'Mark as paid?',
    confirmLabel: 'Mark paid',
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paid' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update invoice');
    }
    // Invalidate cache and re-render the list so row status + totals are fresh
    window._cachedInvoices = null;
    window._cachedInvoicesTime = 0;
    if (typeof renderInvoicesScreen === 'function') {
      try { await renderInvoicesScreen(); } catch (_) {}
    }
    // Re-open the invoice detail so the status chip and buttons update
    await openInvoiceDetail(invoiceId);
  } catch (e) {
    console.error('Mark as paid error:', e);
    alert('Could not mark invoice as paid: ' + (e.message || 'unknown error'));
  }
}

async function deleteInvoice(invoiceId) {
  const ok = await showConfirm('Delete this invoice? This cannot be undone.', {
    title: 'Delete invoice?',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to delete invoice');
    }
    // Refresh list and close the detail panel
    window._cachedInvoices = null;
    window._cachedInvoicesTime = 0;
    if (typeof renderInvoicesScreen === 'function') {
      try { await renderInvoicesScreen(); } catch (_) {}
    }
    closePanel('panel-invoice-detail');
    showToast('Invoice deleted');
  } catch (e) {
    console.error('Delete invoice error:', e);
    alert('Could not delete invoice: ' + (e.message || 'unknown error'));
  }
}
window.deleteInvoice = deleteInvoice;

// Pay-link copy helper (#292). Reads the URL from the readonly input the
// invoice detail panel rendered, copies it to the clipboard, and toasts so
// the user knows it worked. Falls back to the input.select() path on
// environments without async clipboard access.
window.copyPayLink = function copyPayLink() {
  const el = document.getElementById('payLinkUrlInput');
  if (!el) return;
  const url = el.value;
  const done = () => { if (typeof toast === 'function') toast('Pay link copied'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => {
      try { el.select(); document.execCommand('copy'); done(); } catch (_) {}
    });
  } else {
    try { el.select(); document.execCommand('copy'); done(); } catch (_) {}
  }
};

async function downloadInvoicePDF(invoiceId) {
  // Fetch the server-rendered PDF and trigger a real download. Works offline
  // of the print dialog workflow and produces a proper PDF file the user can
  // attach to an email or text.
  try {
    showToast && showToast('Building PDF...');
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/pdf`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`PDF request failed (${res.status})`);
    const blob = await res.blob();

    // Try to pick up filename from Content-Disposition; fall back to a sane default.
    const disp = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"]+)"?/i.exec(disp);
    const filename = (m && m[1]) || `Invoice_${String(invoiceId).slice(0, 6)}.pdf`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
    showToast && showToast('Invoice downloaded');
  } catch (err) {
    console.error('Download invoice PDF failed:', err);
    // Fallback: open the printable HTML version so the user still gets something.
    window.open(`/api/print/invoice/${encodeURIComponent(invoiceId)}`, '_blank');
  }
}

async function chaseInvoicePayment(invoiceId) {
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
    if (!res.ok) throw new Error('Failed to load invoice');
    const invoice = await res.json();
    const invNum = invoice.invoice_number || `INV-${String(invoice.id).slice(0, 6)}`;
    const amount = parseFloat(invoice.amount || 0).toFixed(2);
    const due = invoice.due_date ? formatDateShort(invoice.due_date) : '';
    const venue = invoice.venue_name || invoice.band_name || 'your booking';

    // Prefer the recipient_email we captured on Send; fall back to prompting.
    let toAddr = invoice.recipient_email || '';
    if (!toAddr) {
      toAddr = prompt('Send reminder to which email address?') || '';
      if (!toAddr) return;
      // Persist it back so next chase is one click
      try {
        await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient_email: toAddr }),
        });
      } catch (_) {}
    }

    const chaseOrdinal = (invoice.chase_count || 0) + 1;
    const subject = `Payment reminder ${chaseOrdinal > 1 ? `(#${chaseOrdinal}) ` : ''}: ${invNum}`;
    const bodyLines = [
      `Hi,`,
      ``,
      `Just a friendly reminder that invoice ${invNum} for £${amount} is outstanding${due ? ` and was due on ${due}` : ''}. For your reference this invoice relates to ${venue}.`,
      ``,
      `The invoice PDF can be downloaded again at any time from the TrackMyGigs link I sent when the invoice was first raised. If you have already arranged payment please ignore this note, otherwise a quick reply with an expected payment date would be much appreciated.`,
      ``,
      `Thanks,`,
    ];

    // Record the chase server-side so chase_count / last_chase_at update
    try {
      await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/chase`, { method: 'POST' });
      window._cachedInvoices = null;
      window._cachedInvoicesTime = 0;
    } catch (_) {
      // Fire and forget: if recording the chase fails we still open the email
      // so the user can hit send.
    }

    const mailto = `mailto:${encodeURIComponent(toAddr)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join('\n'))}`;
    window.location.href = mailto;
    showToast('Opening email client...');
  } catch (e) {
    console.error('Chase invoice error:', e);
    showToast('Could not build reminder email: ' + (e.message || 'unknown error'));
  }
}

async function acceptOffer(offerId) {
  try {
    // Look up offer type before patch so we know whether to open the dep-accepted panel after
    let offerType = null;
    try {
      const cached = Array.isArray(window._cachedOffers) ? window._cachedOffers : [];
      const c = cached.find(o => o && o.id === offerId);
      if (c && c.offer_type) offerType = c.offer_type;
    } catch (_) {}

    const res = await fetch(`/api/offers/${offerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted' }),
    });
    if (!res.ok) throw new Error('Failed to accept');
    recordNudgeFeedback('offer', 'accepted', offerId);
    await refreshOffersAndBadge();

    // For dep offers: show the dep-accepted confirmation panel with gig pack
    if (offerType === 'dep' && typeof showDepAccepted === 'function') {
      showDepAccepted(offerId);
    }
  } catch (err) {
    console.error('Accept offer error:', err);
    alert('Could not accept that offer, please try again');
  }
}

// Open a chat thread with the offer's sender, scoped to the gig in question
// so the sender immediately sees what gig the message is about. POST
// /api/chat/threads is idempotent for gig+participant pairs (returns the
// existing thread if one already exists), so this is safe to tap multiple
// times. The thread shows up in the "Gig messages" list on Home with the
// gig name attached.
async function messageAboutOffer(gigId, senderUserId) {
  if (!gigId || !senderUserId) {
    if (typeof toast === 'function') toast('Could not open chat for this offer');
    return;
  }
  try {
    const res = await fetch('/api/chat/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gig_id: gigId,
        thread_type: 'gig',
        participant_ids: [senderUserId],
      }),
    });
    const data = await res.json();
    const thread = data?.thread;
    if (!res.ok || !thread || !thread.id) {
      throw new Error(data?.error || `thread create failed (${res.status})`);
    }
    if (typeof openChatThread === 'function') {
      openChatThread(thread.id);
    } else {
      // Fallback: open the inbox if the thread opener isn't defined.
      openPanel('panel-chat-inbox');
      if (typeof renderChatInbox === 'function') renderChatInbox();
    }
  } catch (err) {
    console.error('messageAboutOffer error:', err);
    if (typeof toast === 'function') toast('Could not open chat. Try again.');
  }
}
window.messageAboutOffer = messageAboutOffer;

async function declineOffer(offerId) {
  const ok = await showConfirm('The sender will see this offer as declined. They can resend or pick someone else.', {
    title: 'Decline this offer?',
    confirmLabel: 'Decline',
    danger: true,
  });
  if (!ok) return;
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
  // S7-08: snooze is now persisted on the server via `snoozed_until` so the
  // state survives device switches and re-login. We keep a tiny localStorage
  // mirror so offline snoozes still mask the offer optimistically; it gets
  // overwritten on the next successful refresh.
  const until = Date.now() + (hours * 3600 * 1000);
  const key = 'snoozedOffers';
  const store = JSON.parse(localStorage.getItem(key) || '{}');
  store[offerId] = until;
  localStorage.setItem(key, JSON.stringify(store));
  try {
    await fetch(`/api/offers/${offerId}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours }),
    });
  } catch (err) {
    // Non-fatal: the localStorage mirror still masks the offer on this
    // device; next online refresh will retry.
    console.error('Snooze offer server call failed (non-fatal):', err);
  }
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
      window._cachedStatsUser = window._currentUser?.id || null;
      if (typeof persistCachedStats === 'function') persistCachedStats();
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

// ── Dep Flow: Gig Picker, Accepted, Cancel ─────────────────────────────────

// Opens the "Which gig?" picker (step 1 of sending a dep offer).
// Shows the user's upcoming confirmed gigs, plus an inline create-gig form
// so they can set up a new gig and send a dep in one step.
async function openDepPicker() {
  openPanel('send-dep-picker');
  const body = document.getElementById('sendDepPickerBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-2);">Loading your gigs...</div>';
  try {
    // Use cached gigs or fetch
    let gigs = window._cachedGigs;
    if (!gigs) {
      const resp = await fetch('/api/gigs');
      gigs = await resp.json();
      window._cachedGigs = gigs;
      persistCachedCalendar();
    }
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = (gigs || [])
      .filter(g => g.status !== 'cancelled' && (g.date || '').slice(0, 10) >= today)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // Stash the full upcoming list so "Show more gigs" can re-render without
    // refetching. Initial view caps at 10 for fast scan; user can expand.
    window._depPickerAllUpcoming = upcoming;

    body.innerHTML = `
      <div class="form-section-label" style="margin-bottom:8px;">Choose a gig to send a dep offer for</div>
      <div id="depPickerGigList" style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px;">
        ${renderDepPickerGigRows(upcoming, 10)}
      </div>

      <div style="margin-bottom:12px;">
        <div style="font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;text-align:center;">\u2014 or \u2014</div>
        <div id="depNewGigBtn" onclick="showDepNewGigForm()" style="background:var(--card);border:2px dashed var(--accent);border-radius:var(--radius);padding:14px;text-align:center;cursor:pointer;">
          <div style="font-size:18px;margin-bottom:4px;">\uD83C\uDFB5</div>
          <div style="font-size:14px;font-weight:700;color:var(--accent);">New gig, set up &amp; send dep</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px;">Enter the gig details, then pick who to send the dep offer to</div>
        </div>
      </div>

      <div id="depNewGigForm" style="display:none;background:var(--card);border:1px solid var(--accent);border-radius:var(--radius);padding:16px;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:700;color:var(--accent);margin-bottom:12px;">\uD83C\uDFB5 Quick gig setup</div>
        <div class="form-group"><div class="form-label">Band / client name</div><input class="form-input" id="depNewGigBand" placeholder="e.g. The Silverstone Band"></div>
        <div class="form-group"><div class="form-label">Venue</div><input class="form-input" id="depNewGigVenue" placeholder="e.g. The Grand, Birmingham"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group"><div class="form-label">Date</div><input class="form-input" id="depNewGigDate" type="date"></div>
          <div class="form-group"><div class="form-label">Fee (\u00A3)</div><input class="form-input" id="depNewGigFee" type="number" placeholder="280"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group"><div class="form-label">Start time</div><input class="form-input" id="depNewGigStart" type="time"></div>
          <div class="form-group"><div class="form-label">End time</div><input class="form-input" id="depNewGigEnd" type="time"></div>
        </div>
        <div class="form-group"><div class="form-label">Instrument / role needed</div><input class="form-input" id="depNewGigRole" placeholder="e.g. Keys player"></div>
        <div style="background:var(--info-dim);border:1px solid rgba(88,166,255,.2);border-radius:var(--radius);padding:8px 10px;margin-bottom:12px;">
          <div style="font-size:11px;color:var(--text-2);line-height:1.4;">\uD83D\uDCA1 This creates the gig in TrackMyGigs AND takes you straight to the dep offer \u2014 no double entry.</div>
        </div>
        <button class="btn-pill" onclick="createGigAndSendDep()">Save gig &amp; send dep offer \u2192</button>
      </div>
    `;
  } catch (err) {
    console.error('openDepPicker error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load gigs. Try again.</div>';
  }
}

// Renders the rows inside the dep-picker gig list. If there are more gigs
// than `limit`, appends a "Show more gigs" link that expands to the full list.
// Passing Infinity shows everything.
function renderDepPickerGigRows(upcoming, limit) {
  if (!upcoming || !upcoming.length) {
    return '<div style="padding:20px;text-align:center;color:var(--text-2);font-size:12px;">No upcoming gigs yet. Create a new one below.</div>';
  }
  const visible = upcoming.slice(0, limit);
  const rows = visible.map(g => {
    const d = new Date(g.date);
    const dateLabel = isNaN(d) ? (g.date || '') : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const times = g.start_time ? `${(g.start_time || '').slice(0, 5)}${g.end_time ? '\u2013' + g.end_time.slice(0, 5) : ''}` : '';
    const fee = g.fee ? `\u00A3${Math.round(g.fee)}` : '';
    const bar = g.status === 'tentative' ? 'var(--warning)' : 'var(--success)';
    return `
      <div onclick="selectGigForDep('${g.id}')" style="padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:10px;">
        <div style="width:3px;height:28px;border-radius:2px;background:${bar};flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(g.band_name || g.venue_name || 'Gig')}</div>
          <div style="font-size:10px;color:var(--text-2);">${escapeHtml(dateLabel)}${times ? ' \u00B7 ' + times : ''}${fee ? ' \u00B7 ' + fee : ''}</div>
        </div>
      </div>
    `;
  }).join('');
  const hiddenCount = upcoming.length - visible.length;
  const moreLink = hiddenCount > 0
    ? `<div onclick="expandDepPickerGigs()" style="padding:10px 14px;text-align:center;cursor:pointer;font-size:12px;font-weight:600;color:var(--accent);">Show ${hiddenCount} more gig${hiddenCount === 1 ? '' : 's'}</div>`
    : '';
  return rows + moreLink;
}

// Expands the dep-picker gig list to show every upcoming gig (no cap).
function expandDepPickerGigs() {
  const list = document.getElementById('depPickerGigList');
  const all = window._depPickerAllUpcoming || [];
  if (list) list.innerHTML = renderDepPickerGigRows(all, Infinity);
}

function showDepNewGigForm() {
  const btn = document.getElementById('depNewGigBtn');
  const form = document.getElementById('depNewGigForm');
  if (btn) btn.style.display = 'none';
  if (form) form.style.display = 'block';
}

function selectGigForDep(gigId) {
  closePanel('send-dep-picker');
  // Open the existing send-dep form with the gig pre-selected
  openPanel('panel-dep');
  // Populate the gig select if it exists
  setTimeout(() => {
    const sel = document.getElementById('depGigSelect');
    if (sel) {
      sel.value = gigId;
      // Fire change so any listeners pick it up
      sel.dispatchEvent(new Event('change'));
    }
  }, 50);
}

async function createGigAndSendDep() {
  const band = document.getElementById('depNewGigBand')?.value?.trim();
  const venue = document.getElementById('depNewGigVenue')?.value?.trim();
  const date = document.getElementById('depNewGigDate')?.value;
  const fee = document.getElementById('depNewGigFee')?.value;
  const start = document.getElementById('depNewGigStart')?.value;
  const end = document.getElementById('depNewGigEnd')?.value;
  const role = document.getElementById('depNewGigRole')?.value?.trim();

  if (!band && !venue) { toast('Add a band or venue name'); return; }
  if (!date) { toast('Pick a date'); return; }

  try {
    const resp = await fetch('/api/gigs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        band_name: band || null,
        venue_name: venue || null,
        date,
        fee: fee ? parseFloat(fee) : null,
        start_time: start || null,
        end_time: end || null,
        status: 'confirmed',
      }),
    });
    if (!resp.ok) throw new Error('Could not save gig');
    const gig = await resp.json();
    // Clear gig cache so next picker load refreshes
    window._cachedGigs = null;
    persistCachedCalendar();
    toast('Gig saved');
    selectGigForDep(gig.id);
    // Pre-fill the role on the send-dep form
    setTimeout(() => {
      const roleInput = document.getElementById('depRole');
      if (roleInput && role) roleInput.value = role;
    }, 100);
  } catch (err) {
    console.error('createGigAndSendDep error:', err);
    toast('Could not save gig');
  }
}

// Show the dep-accepted success panel after a user accepts a dep offer.
// Pulls full offer+gig+sender details so we can render the gig pack, lineup etc.
async function showDepAccepted(offerId) {
  openPanel('dep-accepted');
  const body = document.getElementById('depAcceptedBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>';
  try {
    const resp = await fetch(`/api/offers/${offerId}/details`);
    if (!resp.ok) throw new Error('Failed to load offer');
    const o = await resp.json();

    const d = o.gig_date ? new Date(o.gig_date) : null;
    const dateLabel = d && !isNaN(d) ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const times = o.start_time ? `${(o.start_time || '').slice(0, 5)}${o.end_time ? '\u2013' + o.end_time.slice(0, 5) : ''}` : '';
    const loadIn = o.load_in_time ? ` \u00B7 Arrive ${o.load_in_time.slice(0, 5)}` : '';
    const fee = o.fee ? `\u00A3${Math.round(o.fee)}` : '\u00A3 \u2014';
    const senderName = o.sender_display_name || o.sender_name || 'the band';

    const addressHtml = o.venue_address
      ? `<span onclick="openDirections('${escapeHtml(o.venue_address).replace(/'/g, '&#39;')}')" style="color:var(--info);font-weight:500;cursor:pointer;">\uD83D\uDCCD Get directions</span>`
      : '<span style="color:var(--text-3);">Not set</span>';

    body.innerHTML = `
      <div style="background:var(--surface);padding:16px 20px;border-bottom:1px solid var(--border);">
        <button onclick="closePanel('dep-accepted')" style="display:flex;align-items:center;gap:6px;color:var(--accent);font-size:14px;font-weight:500;cursor:pointer;margin-bottom:12px;background:none;border:none;">&#8249; Back to offers</button>
        <div style="background:var(--success-dim);border:1px solid rgba(63,185,80,.3);border-radius:var(--radius);padding:16px;text-align:center;">
          <div style="font-size:32px;margin-bottom:8px;">\u2705</div>
          <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px;">You're on the gig!</div>
          <div style="font-size:13px;color:var(--text-2);">${escapeHtml(senderName)} has been notified. The gig is now in your calendar.</div>
        </div>
        <div style="background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25);border-radius:var(--radius);padding:14px;margin-top:10px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <div style="font-size:16px;flex-shrink:0;margin-top:1px;">\uD83D\uDCCB</div>
            <div>
              <div style="font-size:13px;font-weight:700;color:#A78BFA;margin-bottom:6px;">Ownership agreement</div>
              <div style="font-size:12px;color:var(--text-2);line-height:1.5;">By accepting this dep, you agree to take full ownership of this gig. This includes arriving on time, meeting all requirements, and arranging your own replacement if you can no longer attend.</div>
            </div>
          </div>
        </div>
      </div>

      <div style="padding:16px 20px;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-size:14px;font-weight:700;color:var(--text);">\uD83C\uDF92 Your Gig Pack</div>
          <span style="font-size:10px;color:var(--success);background:var(--success-dim);border-radius:8px;padding:2px 8px;font-weight:600;">Auto-delivered</span>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
          <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Date</span><span style="color:var(--text);font-weight:500;">${escapeHtml(dateLabel)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Times</span><span style="color:var(--text);font-weight:500;">${escapeHtml(times)}${loadIn}</span></div>
          <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Venue</span><span style="color:var(--text);font-weight:500;">${escapeHtml(o.venue_name || '')}</span></div>
          <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Address</span>${addressHtml}</div>
          <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Dress code</span><span style="color:var(--text);font-weight:500;">${escapeHtml(o.dress_code || 'Not set')}</span></div>
          <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Fee</span><span style="color:var(--success);font-weight:700;">${fee}</span></div>
          <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px;"><span style="color:var(--text-2);">Band leader</span><span style="color:var(--text);font-weight:500;">${escapeHtml(senderName)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:10px 14px;font-size:13px;"><span style="color:var(--text-2);">Day-of contact</span><span style="color:var(--text);font-weight:500;">${escapeHtml(o.day_of_contact || (o.sender_phone ? senderName + ' \u00B7 ' + o.sender_phone : 'Not set'))}</span></div>
        </div>
      </div>

      <div style="padding:16px 20px;">
        <button class="btn-pill" onclick="openGigChat('${o.gig_id}')" style="background:#A78BFA;color:#fff;border:none;margin-bottom:8px;">\uD83D\uDCAC Message ${escapeHtml(senderName)}</button>
        <button class="btn-pill" onclick="openGigChat('${o.gig_id}')">\uD83D\uDCAC Message the band about this gig</button>
        <div style="margin-top:12px;background:var(--info-dim);border:1px solid rgba(88,166,255,.2);border-radius:var(--radius);padding:10px 12px;">
          <div style="font-size:12px;color:var(--text-2);line-height:1.5;">\uD83D\uDCC5 This gig has been added to your TrackMyGigs calendar and will sync to your connected calendars (Google, Outlook) automatically.</div>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;">
          <button class="btn-pill-outline" style="flex:1;" onclick="showCancelDep('${o.id}')">Can't make it anymore</button>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('showDepAccepted error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load offer details.</div>';
  }
}

// Show the cancel-dep panel for an accepted dep offer.
async function showCancelDep(offerId) {
  // Close dep-accepted first if it's open
  closePanel('dep-accepted');
  openPanel('cancel-dep');
  const body = document.getElementById('cancelDepBody');
  if (!body) return;
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-2);">Loading...</div>';
  try {
    const resp = await fetch(`/api/offers/${offerId}/details`);
    if (!resp.ok) throw new Error('Failed to load offer');
    const o = await resp.json();

    const d = o.gig_date ? new Date(o.gig_date) : null;
    const dateLabel = d && !isNaN(d) ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
    const fee = o.fee ? `\u00A3${Math.round(o.fee)}` : '';
    const senderName = o.sender_display_name || o.sender_name || 'the band';

    // Fetch contacts (network) for suggest-replacement list
    let contacts = [];
    try {
      const cRes = await fetch('/api/contacts');
      contacts = await cRes.json();
    } catch (_) { /* ignore */ }

    const suggestRows = (contacts || []).slice(0, 5).map(c => {
      const initial = (c.name || '?')[0].toUpperCase();
      return `
        <div onclick="selectReplacement('${c.id}', this)" data-replacement-id="${c.id}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);cursor:pointer;">
          <div style="width:32px;height:32px;border-radius:16px;background:var(--info-dim);border:1px solid var(--info);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--info);">${escapeHtml(initial)}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(c.name || 'Contact')}</div>
            <div style="font-size:11px;color:var(--text-2);">${escapeHtml((c.instruments || []).join(', ') || 'Network contact')}</div>
          </div>
          <span class="rep-btn" style="font-size:11px;color:var(--accent);font-weight:600;">Suggest \u2192</span>
        </div>
      `;
    }).join('');

    body.innerHTML = `
      <div style="background:var(--surface);padding:16px 20px;border-bottom:1px solid var(--border);">
        <button onclick="closePanel('cancel-dep')" style="display:flex;align-items:center;gap:6px;color:var(--accent);font-size:14px;font-weight:500;cursor:pointer;margin-bottom:12px;background:none;border:none;">&#8249; Back</button>
        <div style="font-size:20px;font-weight:700;color:var(--text);margin-bottom:4px;">Cancel your commitment</div>
        <div style="font-size:13px;color:var(--text-2);">${escapeHtml(o.band_name || o.venue_name || 'Gig')} \u00B7 ${escapeHtml(dateLabel)}${fee ? ' \u00B7 ' + fee : ''}</div>
      </div>

      <div style="padding:16px 20px;">
        <div style="background:var(--warning-dim);border:1px solid rgba(240,165,0,.3);border-radius:var(--radius);padding:14px;margin-bottom:16px;">
          <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px;">\u26A0\uFE0F This affects the whole lineup</div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.5;">${escapeHtml(senderName)} and the band are counting on you. If you can suggest a replacement, it makes this much easier for everyone.</div>
        </div>

        <div class="form-group">
          <div class="form-label">Reason (optional)</div>
          <input class="form-input" id="cancelDepReason" placeholder="e.g. double booked, illness, personal\u2026">
        </div>

        <div style="margin-top:12px;margin-bottom:16px;">
          <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:10px;">\uD83D\uDD04 Suggest a replacement</div>
          <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;">Know someone who can cover? They'll get the offer directly and ${escapeHtml(senderName)} will be notified.</div>
          ${suggestRows ? `
            <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:10px;">
              <div style="padding:8px 14px;font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border);">From your network</div>
              ${suggestRows}
            </div>
          ` : `
            <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;text-align:center;font-size:12px;color:var(--text-2);margin-bottom:10px;">No contacts in your network yet.</div>
          `}
        </div>

        <button class="btn-pill" id="cancelDepSubmitBtn" style="background:var(--warning);margin-bottom:10px;" onclick="submitCancelDep('${o.id}')">Cancel without suggesting a replacement</button>

        <div style="margin-top:12px;font-size:11px;color:var(--text-3);text-align:center;line-height:1.5;">
          ${escapeHtml(senderName)} will be notified immediately. If you suggest a replacement,<br>they'll receive the offer with all the gig details automatically.
        </div>
      </div>
    `;
    window._cancelDepReplacementId = null;
  } catch (err) {
    console.error('showCancelDep error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load cancel form.</div>';
  }
}

function selectReplacement(contactId, el) {
  // Clear previous selection
  document.querySelectorAll('[data-replacement-id]').forEach(row => {
    row.style.background = '';
    row.style.borderColor = '';
    const btn = row.querySelector('.rep-btn');
    if (btn) { btn.textContent = 'Suggest \u2192'; btn.style.color = 'var(--accent)'; }
  });
  // Mark new selection
  if (el) {
    el.style.background = 'var(--accent-dim)';
    el.style.borderColor = 'var(--accent)';
    const btn = el.querySelector('.rep-btn');
    if (btn) { btn.textContent = '\u2713 Selected'; btn.style.color = 'var(--success)'; }
  }
  window._cancelDepReplacementId = contactId;
  const btn = document.getElementById('cancelDepSubmitBtn');
  const nameEl = el?.querySelector('div[style*="font-weight:600"]');
  const name = nameEl?.textContent || 'this contact';
  if (btn) {
    btn.textContent = `Cancel gig & suggest ${name} as replacement`;
    btn.style.background = 'var(--warning)';
  }
}

async function submitCancelDep(offerId) {
  const reasonEl = document.getElementById('cancelDepReason');
  const reason = reasonEl?.value?.trim() || null;
  const replacement_user_id = window._cancelDepReplacementId || null;
  {
    const ok = await showConfirm('The band will be notified you can no longer do this gig. If you picked a replacement, they will receive the offer next.', {
      title: 'Cancel this commitment?',
      confirmLabel: 'Cancel commitment',
      cancelLabel: 'Keep commitment',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const resp = await fetch(`/api/offers/${offerId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, replacement_user_id }),
    });
    if (!resp.ok) throw new Error('Failed to cancel');
    toast(replacement_user_id ? 'Cancelled and replacement suggested' : 'Cancelled');
    closePanel('cancel-dep');
    await refreshOffersAndBadge();
  } catch (err) {
    console.error('submitCancelDep error:', err);
    toast('Could not cancel. Try again.');
  }
}

// Open directions to an address using the user's preferred nav app
// Maps preference: 'google' | 'apple' | 'waze' | null (null = ask every time)
// Stored in localStorage so the choice is per-device. If the user wants to
// change it they can either tap "Change maps app" in Profile or clear the
// stored value to trigger the chooser again.
function getMapsPreference() {
  const stored = localStorage.getItem('preferredMapsApp');
  return (stored === 'google' || stored === 'apple' || stored === 'waze') ? stored : null;
}

function setMapsPreference(app) {
  if (app === 'clear' || app === null) {
    localStorage.removeItem('preferredMapsApp');
  } else if (app === 'google' || app === 'apple' || app === 'waze') {
    localStorage.setItem('preferredMapsApp', app);
  }
}

function launchMapsApp(app, address) {
  const encoded = encodeURIComponent(address);
  let url;
  if (app === 'apple') {
    // maps.apple.com opens Apple Maps on iOS directly; on non-iOS it shows a
    // landing page so users who pick wrong get a soft fallback rather than a crash.
    url = `https://maps.apple.com/?daddr=${encoded}`;
  } else if (app === 'waze') {
    url = `https://waze.com/ul?q=${encoded}&navigate=yes`;
  } else {
    url = `https://www.google.com/maps/dir/?api=1&destination=${encoded}`;
  }
  window.open(url, '_blank');
}

function openDirections(address) {
  if (!address) return;
  const pref = getMapsPreference();
  if (pref) {
    launchMapsApp(pref, address);
    return;
  }
  showMapsChooser(address);
}

function showMapsChooser(address) {
  // Remove any existing chooser first so rapid taps don't stack overlays
  const existing = document.getElementById('mapsChooserOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mapsChooserOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:flex-end;justify-content:center;animation:fadeIn .15s ease-out;';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  // Safe-attr version of the address for inline handlers
  const safeAddr = String(address).replace(/'/g, "\\'").replace(/"/g, '&quot;');

  overlay.innerHTML = `
    <div style="width:100%;max-width:420px;background:var(--surface);border-top-left-radius:18px;border-top-right-radius:18px;border-top:1px solid var(--border);padding:18px 18px 24px;animation:slideUp .2s ease-out;">
      <div style="width:40px;height:4px;background:var(--border);border-radius:2px;margin:0 auto 14px;"></div>
      <div style="font-size:15px;font-weight:700;color:var(--text);text-align:center;margin-bottom:4px;">Open directions in</div>
      <div style="font-size:12px;color:var(--text-2);text-align:center;margin-bottom:16px;">Pick an app. We'll remember it next time if you tick the box below.</div>
      <button onclick="pickMapsApp('google','${safeAddr}')" class="pill-o" style="width:100%;justify-content:space-between;padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;">
        <span style="font-size:14px;font-weight:600;color:var(--text);">Google Maps</span>
        <span style="color:var(--accent);font-size:16px;">\u203A</span>
      </button>
      <button onclick="pickMapsApp('apple','${safeAddr}')" class="pill-o" style="width:100%;justify-content:space-between;padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;">
        <span style="font-size:14px;font-weight:600;color:var(--text);">Apple Maps</span>
        <span style="color:var(--accent);font-size:16px;">\u203A</span>
      </button>
      <button onclick="pickMapsApp('waze','${safeAddr}')" class="pill-o" style="width:100%;justify-content:space-between;padding:14px 16px;margin-bottom:14px;display:flex;align-items:center;">
        <span style="font-size:14px;font-weight:600;color:var(--text);">Waze</span>
        <span style="color:var(--accent);font-size:16px;">\u203A</span>
      </button>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 4px;cursor:pointer;">
        <input type="checkbox" id="mapsRememberChoice" checked style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;">
        <span style="font-size:13px;color:var(--text-2);">Remember my choice</span>
      </label>
      <button onclick="document.getElementById('mapsChooserOverlay').remove()" style="width:100%;background:none;border:none;color:var(--text-2);padding:12px;margin-top:4px;font-size:14px;cursor:pointer;">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function pickMapsApp(app, address) {
  const remember = document.getElementById('mapsRememberChoice')?.checked;
  if (remember) setMapsPreference(app);
  const overlay = document.getElementById('mapsChooserOverlay');
  if (overlay) overlay.remove();
  launchMapsApp(app, address);
}

function openMapsPreferencePicker() {
  const current = getMapsPreference();
  const existing = document.getElementById('mapsPrefPickerOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mapsPrefPickerOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:flex-end;justify-content:center;';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const row = (value, label) => {
    const active = current === value;
    const neutralActive = !current && value === 'ask';
    const isSelected = active || neutralActive;
    return `
      <button onclick="applyMapsPreference('${value}')" class="pill-o" style="width:100%;justify-content:space-between;padding:14px 16px;margin-bottom:8px;display:flex;align-items:center;${isSelected ? 'border-color:var(--accent);background:var(--accent-dim);' : ''}">
        <span style="font-size:14px;font-weight:600;color:var(--text);">${label}</span>
        ${isSelected ? '<span style="color:var(--accent);font-size:16px;">\u2713</span>' : '<span style="color:var(--accent);font-size:16px;">\u203A</span>'}
      </button>`;
  };

  overlay.innerHTML = `
    <div style="width:100%;max-width:420px;background:var(--surface);border-top-left-radius:18px;border-top-right-radius:18px;border-top:1px solid var(--border);padding:18px 18px 24px;">
      <div style="width:40px;height:4px;background:var(--border);border-radius:2px;margin:0 auto 14px;"></div>
      <div style="font-size:15px;font-weight:700;color:var(--text);text-align:center;margin-bottom:4px;">Preferred maps app</div>
      <div style="font-size:12px;color:var(--text-2);text-align:center;margin-bottom:16px;">Used when you tap a venue address.</div>
      ${row('google','Google Maps')}
      ${row('apple','Apple Maps')}
      ${row('waze','Waze')}
      ${row('ask','Ask me each time')}
      <button onclick="document.getElementById('mapsPrefPickerOverlay').remove()" style="width:100%;background:none;border:none;color:var(--text-2);padding:12px;margin-top:4px;font-size:14px;cursor:pointer;">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function applyMapsPreference(value) {
  if (value === 'ask') {
    setMapsPreference('clear');
  } else {
    setMapsPreference(value);
  }
  const overlay = document.getElementById('mapsPrefPickerOverlay');
  if (overlay) overlay.remove();
  // Re-render profile if open so the row label updates
  if (typeof renderProfileScreen === 'function') renderProfileScreen();
}

// Expose dep flow helpers
window.openDepPicker = openDepPicker;
window.selectGigForDep = selectGigForDep;
window.showDepNewGigForm = showDepNewGigForm;
window.createGigAndSendDep = createGigAndSendDep;
window.showDepAccepted = showDepAccepted;
window.showCancelDep = showCancelDep;
window.selectReplacement = selectReplacement;
window.submitCancelDep = submitCancelDep;
window.openDirections = openDirections;

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

  // Drop any entries the user has already imported or dismissed in this
  // session. Without this filter, the imported card re-renders in place
  // after importNudgeFromDetail() marks already_imported=true.
  _nudgeEvents = _nudgeEvents.filter(e => !e.already_imported);

  // Keep the Calendar grid's cached nudge set in sync so the amber pin
  // tags and count banner also drop the imported event.
  try {
    if (Array.isArray(window._calendarNudges)) {
      window._calendarNudges = window._calendarNudges.filter(e => !e.already_imported);
    }
    if (window._calendarNudgesById && typeof window._calendarNudgesById === 'object') {
      for (const ev of Object.values(window._calendarNudgesById)) {
        if (ev && ev.already_imported) delete window._calendarNudgesById[ev.id];
      }
    }
  } catch (_) { /* non-fatal */ }

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
    persistCachedCalendar();
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
    persistCachedCalendar();
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
    // S12-13: Hide empty threads the user never actually sent a message in.
    // "Message band" auto-creates a thread on open; if the user never types
    // anything, it's just clutter in the inbox. We keep the row only if a
    // message has been sent (last_message is non-null).
    const threads = (data.threads || []).filter(t => !!t.last_message);

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

    // S12-14: Fetching messages marks them as read on the server. The stats
    // cache would otherwise continue to report the stale unread count for up
    // to 30s. Invalidate so the next Home render refetches.
    window._cachedStats = null;
    window._cachedStatsTime = 0;

    renderChatThread(data.thread, data.messages);
  } catch (err) {
    console.error('Chat thread error:', err);
    body.innerHTML = '<div style="padding:20px;color:var(--text-2);">Could not load messages.</div>';
  }
}
window.openChatThread = openChatThread;

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
    // S12-08: Gig info only makes sense if this thread is attached to a gig.
    // Wire the onclick to openGigDetail; otherwise hide the button entirely so
    // it isn't a dead tap target.
    const gigInfoBtn = thread.gig_id
      ? `<div onclick="closePanel('panel-chat-thread');openGigDetail('${thread.gig_id}')" style="font-size:11px;color:var(--accent);cursor:pointer;width:50px;text-align:right;">Gig info</div>`
      : `<div style="width:50px;"></div>`;
    header.innerHTML = `
      <button class="panel-back" onclick="closePanel('panel-chat-thread')">&#8249; Back</button>
      <div style="text-align:center;flex:1;">
        <div class="panel-title" style="font-size:15px;">${escapeHtml(thread.band_name || 'Messages')}</div>
        <div style="font-size:10px;color:var(--text-3);">${participantCount} ${participantCount === 1 ? 'person' : 'people'}</div>
      </div>
      ${gigInfoBtn}
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
  // S12-12: textarea so users can compose multi-line messages. Shift+Enter
  // inserts a newline; Enter alone sends. Auto-grows up to 5 lines then scrolls.
  const inputHTML = `
    <div style="padding:12px 20px;border-top:1px solid var(--border);background:var(--surface);display:flex;gap:8px;align-items:flex-end;">
      <textarea id="chatMessageInput" rows="1" placeholder="Message..." style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:9px 16px;color:var(--text);font-size:14px;outline:none;resize:none;font-family:inherit;line-height:1.4;max-height:108px;" oninput="autoGrowChatInput(this)" onkeydown="handleChatKey(event)"></textarea>
      <button id="chatSendBtn" onclick="sendChatMessage()" style="width:36px;height:36px;border-radius:18px;background:var(--accent);border:none;color:#000;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">&#x2191;</button>
    </div>
  `;

  body.innerHTML = messagesHTML + inputHTML;

  // Scroll to bottom
  const area = document.getElementById('chatMessagesArea');
  if (area) area.scrollTop = area.scrollHeight;

  // S12-06: start a background poller so new messages from other participants
  // show up without the user having to reopen the thread. Intentionally light:
  // 6s interval, only while panel is open, and only refreshes when the message
  // count or last-timestamp changes so we don't blow away user scroll position.
  startChatThreadPolling(thread && thread.id ? thread.id : _currentThreadId, messages);
}

let _chatPollTimer = null;
let _chatPollLastCount = 0;
let _chatPollLastStamp = 0;

function stopChatThreadPolling() {
  if (_chatPollTimer) {
    clearInterval(_chatPollTimer);
    _chatPollTimer = null;
  }
}

function startChatThreadPolling(threadId, initialMessages) {
  stopChatThreadPolling();
  if (!threadId) return;
  _chatPollLastCount = Array.isArray(initialMessages) ? initialMessages.length : 0;
  _chatPollLastStamp = _chatPollLastCount > 0
    ? new Date(initialMessages[initialMessages.length - 1].created_at).getTime() || 0
    : 0;

  _chatPollTimer = setInterval(async () => {
    // Stop if the panel is no longer open (defensive; closePanel clears this anyway).
    const panel = document.getElementById('panel-chat-thread');
    if (!panel || !panel.classList.contains('open')) {
      stopChatThreadPolling();
      return;
    }
    if (!_currentThreadId || _currentThreadId !== threadId) {
      stopChatThreadPolling();
      return;
    }
    try {
      const resp = await fetch(`/api/chat/threads/${threadId}/messages`);
      if (!resp.ok) return;
      const data = await resp.json();
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      const lastStamp = msgs.length > 0
        ? new Date(msgs[msgs.length - 1].created_at).getTime() || 0
        : 0;
      // Only re-render if something actually changed, to preserve scroll
      // position during idle polls.
      if (msgs.length !== _chatPollLastCount || lastStamp !== _chatPollLastStamp) {
        _chatPollLastCount = msgs.length;
        _chatPollLastStamp = lastStamp;
        // Preserve scroll-at-bottom behaviour: if user was at bottom, keep them there;
        // otherwise leave scroll alone so they can read older messages in peace.
        const area = document.getElementById('chatMessagesArea');
        const wasAtBottom = area
          ? (area.scrollHeight - area.scrollTop - area.clientHeight) < 40
          : true;
        renderChatThread(data.thread, msgs);
        const newArea = document.getElementById('chatMessagesArea');
        if (newArea && !wasAtBottom) {
          // Try to keep the user approximately where they were.
          newArea.scrollTop = 0;
        }
      }
    } catch (err) {
      // Swallow; the next poll will try again.
    }
  }, 6000);
}

// S12-12: Enter alone sends, Shift+Enter inserts a newline. Also gated so we
// don't fire while the previous POST is still in flight (see _chatSendInFlight
// in sendChatMessage).
function handleChatKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
}

// S12-12: Keep the textarea height in step with content up to a 5-line cap.
function autoGrowChatInput(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 108) + 'px';
}

let _chatSendInFlight = false;

async function sendChatMessage() {
  const input = document.getElementById('chatMessageInput');
  const sendBtn = document.getElementById('chatSendBtn');
  if (!input || !input.value.trim() || !_currentThreadId) return;

  // S12-09: guard against double-sends. On slow links the previous response
  // may not have come back yet; we disable the button and ignore re-entrant
  // sends until this one resolves.
  if (_chatSendInFlight) return;
  _chatSendInFlight = true;

  const content = input.value.trim();
  input.value = '';
  autoGrowChatInput(input);

  // Disable button and show a subtle spinner glyph so the user sees progress.
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.55';
    sendBtn.style.cursor = 'default';
    sendBtn.dataset.originalHtml = sendBtn.innerHTML;
    sendBtn.innerHTML = '<span style="font-size:12px;">&hellip;</span>';
  }

  try {
    const res = await fetch(`/api/chat/threads/${_currentThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      // Surface server-side errors (e.g. S12-10 length cap 413) to the user.
      let errMsg = 'Message failed to send.';
      try {
        const data = await res.json();
        if (data && data.error) errMsg = data.error;
      } catch (_) {
        // ignore parse errors, keep default message
      }
      throw new Error(errMsg);
    }
    // Refresh thread to append the new message
    openChatThread(_currentThreadId);
  } catch (err) {
    console.error('Send message error:', err);
    // S12-09: tell the user something went wrong and restore their draft so
    // they can edit + retry instead of losing their message.
    input.value = content;
    autoGrowChatInput(input);
    try { toast(err.message || 'Message failed to send.'); } catch (_) {}
  } finally {
    _chatSendInFlight = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.opacity = '';
      sendBtn.style.cursor = 'pointer';
      if (sendBtn.dataset.originalHtml) {
        sendBtn.innerHTML = sendBtn.dataset.originalHtml;
        delete sendBtn.dataset.originalHtml;
      }
    }
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
  const fields = ['invBillTo', 'invClientAddress', 'invDesc', 'invAmount', 'invNotes', 'invInvoiceNumber'];
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateInvoicePreview);
  });

  // Populate the saved-client datalist and wire auto-fill when the user
  // picks a name that matches a saved record.
  loadInvoiceClientSuggest();
  const billToEl = document.getElementById('invBillTo');
  if (billToEl) {
    billToEl.addEventListener('input', maybeAutoFillClientAddress);
    billToEl.addEventListener('change', maybeAutoFillClientAddress);
  }

  // Gig selector auto-fill
  const gigSelect = document.getElementById('invLinkedGig');
  if (gigSelect) gigSelect.addEventListener('change', onGigSelected);

  // Pull profile for invoice number generation. Note: we used to auto-fill
  // the Notes field with bank_details here, but the invoice now has a
  // dedicated Payment Details panel that reads bank_details directly from
  // the user record, so copying it into notes made it appear twice on the
  // rendered invoice. Notes is now free-form only.
  const profile = window._cachedProfile || window._currentUser || {};
  // Generate next invoice number using format setting
  const prefix = profile.invoice_prefix || 'INV';
  const nextNum = profile.invoice_next_number || 1;
  const format = profile.invoice_format || 'plain';
  const invNum = generateInvoiceNumber(prefix, nextNum, format);
  const invNumEl = document.getElementById('invInvoiceNumber');
  if (invNumEl && !invNumEl.value) invNumEl.value = invNum;

  // Set default due date to today + 30 days
  const dueDateEl = document.getElementById('invDueDate');
  if (dueDateEl && !dueDateEl.value) {
    const today = new Date();
    const dueDate = new Date(today);
    dueDate.setDate(dueDate.getDate() + 30);
    dueDateEl.value = dueDate.toISOString().split('T')[0];
  }

  updateInvoicePreview();

  document.getElementById('sendInvoiceBtn').onclick = submitInvoice;
  document.getElementById('saveInvoiceDraft').onclick = () => saveInvoiceDraft();

  // Reset the teaching bundle panel to a clean state each time Invoice opens.
  window._invBundleSelected = null;
  const bundle = document.getElementById('invTeachingBundle');
  if (bundle) bundle.style.display = 'none';
  const toggle = document.getElementById('invTeachingBundleToggle');
  if (toggle) toggle.innerHTML = '\uD83D\uDCDA Bundle teaching lessons into this invoice \u2192';
  const bundleResults = document.getElementById('invBundleResults');
  if (bundleResults) bundleResults.innerHTML = '';
}

// ── Saved invoice clients (name + address address book) ─────────────────────
// The list is fetched once per composer open and cached on window so the
// autofill helper can look up the address without another round-trip. Names
// are indexed lowercase so lookup matches the composer input regardless of
// what case the user types.
window._invoiceClientsCache = null;
async function loadInvoiceClientSuggest() {
  const dl = document.getElementById('invClientSuggest');
  try {
    const res = await fetch('/api/invoice-clients');
    if (!res.ok) return;
    const clients = await res.json();
    window._invoiceClientsCache = clients;
    if (dl) {
      dl.innerHTML = clients
        .map((c) => `<option value="${escapeHtml(c.name)}"></option>`)
        .join('');
    }
  } catch (err) {
    console.warn('Invoice client suggest load failed:', err);
  }
}

function maybeAutoFillClientAddress() {
  const billToEl = document.getElementById('invBillTo');
  const addrEl = document.getElementById('invClientAddress');
  if (!billToEl || !addrEl) return;
  const typed = (billToEl.value || '').trim().toLowerCase();
  if (!typed) return;
  const clients = window._invoiceClientsCache || [];
  const match = clients.find((c) => (c.name || '').trim().toLowerCase() === typed);
  // Only autofill when the address field is empty, so we never clobber a
  // user-edited address.
  if (match && match.address && !addrEl.value.trim()) {
    addrEl.value = match.address;
    updateInvoicePreview();
  }
}

// Renders the Saved Clients section inside Edit Profile. Each row shows the
// client name + a first-line address preview, with a delete button. Edits
// aren't supported here because the source of truth is the next invoice you
// send to that client: changing the address on a fresh invoice will upsert
// the record.
async function renderSavedClientsList() {
  const container = document.getElementById('savedClientsList');
  if (!container) return;
  try {
    const res = await fetch('/api/invoice-clients');
    if (!res.ok) throw new Error('Failed to load clients');
    const clients = await res.json();
    if (!clients.length) {
      container.innerHTML = `<div style="font-size:12px;color:var(--text-3);padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);">No saved clients yet. They&#8217;ll appear here after you send your first invoice.</div>`;
      return;
    }
    container.innerHTML = clients.map((c) => {
      const firstLine = (c.address || '').split('\n')[0] || '';
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.name)}</div>
            ${firstLine ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(firstLine)}</div>` : ''}
          </div>
          <button type="button" onclick="deleteSavedClient(${c.id})" style="background:none;border:1px solid var(--border);color:var(--text-2);font-size:11px;padding:6px 10px;border-radius:var(--rs);cursor:pointer;">Delete</button>
        </div>`;
    }).join('');
  } catch (err) {
    console.error('Saved clients load error:', err);
    container.innerHTML = `<div style="font-size:12px;color:var(--error);padding:10px 12px;background:var(--card);border:1px solid var(--border);border-radius:var(--rs);">Could not load saved clients.</div>`;
  }
}
window.renderSavedClientsList = renderSavedClientsList;

async function deleteSavedClient(id) {
  if (!confirm('Remove this saved client? Future invoices won\u2019t autofill their address.')) return;
  try {
    const res = await fetch(`/api/invoice-clients/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    // Invalidate the composer cache so the datalist re-fetches next open
    window._invoiceClientsCache = null;
    renderSavedClientsList();
  } catch (err) {
    console.error('Delete client error:', err);
    alert('Could not delete client.');
  }
}
window.deleteSavedClient = deleteSavedClient;

// ── Teaching lesson bundling ─────────────────────────────────────────────────
// Lets a teacher pull every Teaching gig for a given student in a date range
// into a single invoice. We sum the fees and write a single-line description
// (the per-lesson breakdown stays in the gig records, not the invoice row).

function toggleInvoiceTeachingBundle() {
  const el = document.getElementById('invTeachingBundle');
  const toggle = document.getElementById('invTeachingBundleToggle');
  if (!el || !toggle) return;
  const isOpen = el.style.display !== 'none';
  if (isOpen) {
    el.style.display = 'none';
    toggle.innerHTML = '\uD83D\uDCDA Bundle teaching lessons into this invoice \u2192';
    return;
  }
  el.style.display = 'block';
  toggle.innerHTML = '\uD83D\uDCDA Hide lesson bundle &#8595;';

  // Prefill client field from Bill to so the common case needs zero typing.
  const client = document.getElementById('invBundleClient');
  const billTo = document.getElementById('invBillTo');
  if (client && billTo && !client.value && billTo.value) client.value = billTo.value;

  // Prefill date range: last 3 months to today.
  const fromEl = document.getElementById('invBundleFrom');
  const toEl = document.getElementById('invBundleTo');
  if (fromEl && !fromEl.value) {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    fromEl.value = d.toISOString().slice(0, 10);
  }
  if (toEl && !toEl.value) {
    toEl.value = new Date().toISOString().slice(0, 10);
  }
}

function loadTeachingBundleCandidates() {
  const results = document.getElementById('invBundleResults');
  if (!results) return;
  const raw = (document.getElementById('invBundleClient')?.value || '').trim().toLowerCase();
  const fromStr = document.getElementById('invBundleFrom')?.value || '';
  const toStr = document.getElementById('invBundleTo')?.value || '';
  if (!raw) {
    results.innerHTML = '<div style="color:var(--danger);font-size:12px;">Enter a student name or email.</div>';
    return;
  }
  if (!fromStr || !toStr) {
    results.innerHTML = '<div style="color:var(--danger);font-size:12px;">Pick both a From and To date.</div>';
    return;
  }
  if (fromStr > toStr) {
    results.innerHTML = '<div style="color:var(--danger);font-size:12px;">From date is after To date.</div>';
    return;
  }

  const gigs = (window._cachedGigs || []).filter((g) => {
    if ((g.gig_type || '') !== 'Teaching') return false;
    if (!g.date) return false;
    const d = String(g.date).slice(0, 10);
    if (d < fromStr || d > toStr) return false;
    const haystack = [g.client_name, g.client_email, g.band_name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.indexOf(raw) !== -1;
  });
  gigs.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (gigs.length === 0) {
    results.innerHTML = '<div style="color:var(--text-2);font-size:12px;">No teaching lessons match. Check the name/email or widen the date range.</div>';
    return;
  }

  // Default: all found lessons are pre-selected. User can uncheck any they've
  // already invoiced separately.
  window._invBundleSelected = new Set(gigs.map((g) => g.id));
  window._invBundleAll = gigs;

  renderInvoiceBundleList();
}

function renderInvoiceBundleList() {
  const results = document.getElementById('invBundleResults');
  const gigs = window._invBundleAll || [];
  const selected = window._invBundleSelected || new Set();
  if (!results || gigs.length === 0) return;

  const rows = gigs.map((g) => {
    const checked = selected.has(g.id) ? 'checked' : '';
    const d = new Date(String(g.date).slice(0, 10));
    const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const timeStr = [g.start_time, g.end_time].filter(Boolean).join('\u2013') || '';
    const fee = parseFloat(g.fee) || 0;
    return `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer;">
        <input type="checkbox" ${checked} onchange="toggleBundleLesson('${g.id}', this.checked)" style="width:18px;height:18px;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(dateStr)}</div>
          <div style="font-size:11px;color:var(--text-3);">${escapeHtml(timeStr)}</div>
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--text);">\u00A3${fee.toFixed(2)}</div>
      </label>
    `;
  }).join('');

  const count = selected.size;
  const total = gigs
    .filter((g) => selected.has(g.id))
    .reduce((acc, g) => acc + (parseFloat(g.fee) || 0), 0);

  results.innerHTML = `
    <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;">${gigs.length} lesson${gigs.length === 1 ? '' : 's'} found. Uncheck any already invoiced.</div>
    ${rows}
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="font-size:12px;color:var(--text-2);">${count} selected</div>
      <div style="font-size:16px;font-weight:800;color:var(--accent);">\u00A3${total.toFixed(2)}</div>
    </div>
    <button type="button" class="btn-pill" style="margin-top:10px;" onclick="applyTeachingBundleToInvoice()" ${count === 0 ? 'disabled' : ''}>
      Use ${count} lesson${count === 1 ? '' : 's'} on this invoice
    </button>
  `;
}

function toggleBundleLesson(gigId, on) {
  if (!window._invBundleSelected) return;
  if (on) window._invBundleSelected.add(gigId);
  else window._invBundleSelected.delete(gigId);
  renderInvoiceBundleList();
}

function applyTeachingBundleToInvoice() {
  const gigs = window._invBundleAll || [];
  const selected = window._invBundleSelected || new Set();
  const chosen = gigs.filter((g) => selected.has(g.id));
  if (chosen.length === 0) return;

  chosen.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const first = new Date(String(chosen[0].date).slice(0, 10));
  const last = new Date(String(chosen[chosen.length - 1].date).slice(0, 10));
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const total = chosen.reduce((acc, g) => acc + (parseFloat(g.fee) || 0), 0);

  const studentName = chosen[0].client_name || chosen[0].band_name || '';

  // Bill to defaults to the student's name if the field is empty.
  const billToEl = document.getElementById('invBillTo');
  if (billToEl && !billToEl.value && studentName) billToEl.value = studentName;

  // Description reads naturally for the single-line invoice layout.
  const descEl = document.getElementById('invDesc');
  if (descEl) {
    const dateRange = first.getTime() === last.getTime() ? fmt(first) : `${fmt(first)} \u2013 ${fmt(last)}`;
    const who = studentName ? ` for ${studentName}` : '';
    descEl.value = `Teaching: ${chosen.length} lesson${chosen.length === 1 ? '' : 's'}${who} (${dateRange})`;
  }

  const amtEl = document.getElementById('invAmount');
  if (amtEl) amtEl.value = total.toFixed(2);

  // Clear the linked-gig dropdown: a bundle can't point at a single gig.
  const linked = document.getElementById('invLinkedGig');
  if (linked) linked.value = '';
  const venueRow = document.getElementById('invPreviewVenueRow');
  if (venueRow) venueRow.style.display = 'none';
  const gigPreview = document.getElementById('invPreviewGig');
  if (gigPreview) {
    gigPreview.textContent = `${chosen.length} teaching lesson${chosen.length === 1 ? '' : 's'}`;
  }

  updateInvoicePreview();
  if (typeof showToast === 'function') showToast(`${chosen.length} lessons added, total \u00A3${total.toFixed(2)}.`);

  // Collapse the bundle panel now that the invoice fields are populated.
  const bundle = document.getElementById('invTeachingBundle');
  if (bundle) bundle.style.display = 'none';
  const toggle = document.getElementById('invTeachingBundleToggle');
  if (toggle) toggle.innerHTML = '\uD83D\uDCDA Bundle teaching lessons into this invoice \u2192';
}

window.toggleInvoiceTeachingBundle = toggleInvoiceTeachingBundle;
window.loadTeachingBundleCandidates = loadTeachingBundleCandidates;
window.toggleBundleLesson = toggleBundleLesson;
window.applyTeachingBundleToInvoice = applyTeachingBundleToInvoice;

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

  // Auto-fill fields from the linked gig.
  // "Bill to" is the band/client who booked you (who's paying the invoice).
  // We prefer band_name and only fall back to venue_name if no band name exists.
  const billToEl = document.getElementById('invBillTo');
  if (billToEl && !billToEl.value) {
    billToEl.value = gig.band_name || gig.venue_name || '';
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

  // Update preview with gig info (date only, venue is shown separately)
  document.getElementById('invPreviewGig').textContent = dateStr || 'No date set';

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

// ── Invoice PDF Preview ─────────────────────────────────────────────────────
// Show a fullscreen "paper" preview that looks like the PDF we would export.
// Currently client-only: populates the panel from the invoice form state so
// the user can visually check layout, wording, and payment details before
// clicking Send. A real PDF export can be added later by rendering this same
// markup with html-to-pdf.
function openInvoicePdfPreview() {
  const billTo = (document.getElementById('invBillTo')?.value || '').trim() || '--';
  const desc = (document.getElementById('invDesc')?.value || '').trim() || 'Performance fee';
  const amount = parseFloat(document.getElementById('invAmount')?.value) || 0;
  const dueDate = document.getElementById('invDueDate')?.value || '';
  const invNum = (document.getElementById('invInvoiceNumber')?.value || 'INV-001').trim();
  const bankNotes = (document.getElementById('invNotes')?.value || '').trim();
  const fmt = '\u00A3' + amount.toFixed(2);

  // From block — pull name, phone, email, postcode from current user
  const u = window._currentUser || {};
  const fromName = u.display_name || u.name || u.email || 'Your Name';
  const fromMetaParts = [];
  if (u.email) fromMetaParts.push(u.email);
  if (u.phone) fromMetaParts.push(u.phone);
  if (u.home_postcode) fromMetaParts.push(u.home_postcode);
  const fromMeta = fromMetaParts.join('\n');

  // Venue line — pull from linked gig if present
  const gigId = document.getElementById('invLinkedGig')?.value;
  let venueText = '';
  if (gigId) {
    const gigs = window._cachedGigs || [];
    const gig = gigs.find(g => g.id === gigId);
    if (gig) {
      const parts = [gig.venue_name, gig.venue_address, gig.date ? formatDate(gig.date) : null].filter(Boolean);
      venueText = parts.join(' · ');
    }
  }

  const byId = (id) => document.getElementById(id);
  byId('pdfFromName').textContent = fromName;
  byId('pdfFromMeta').textContent = fromMeta;
  byId('pdfInvNum').textContent = invNum;
  byId('pdfInvDate').textContent = 'Issued ' + formatDateShort(new Date().toISOString().slice(0, 10));
  byId('pdfBillTo').textContent = billTo;
  byId('pdfDueDate').textContent = dueDate ? formatDate(dueDate) : 'On receipt';
  byId('pdfDesc').textContent = desc;
  byId('pdfAmount').textContent = fmt;
  byId('pdfTotal').textContent = fmt;

  const venueRow = byId('pdfVenueRow');
  const venueEl = byId('pdfVenue');
  if (venueText && venueRow && venueEl) {
    venueEl.textContent = venueText;
    venueRow.style.display = '';
  } else if (venueRow) {
    venueRow.style.display = 'none';
  }

  const bankBlock = byId('pdfBankBlock');
  const bankEl = byId('pdfBank');
  if (bankNotes && bankBlock && bankEl) {
    bankEl.textContent = bankNotes;
    bankBlock.style.display = '';
  } else if (bankBlock) {
    bankBlock.style.display = 'none';
  }

  openPanel('panel-invoice-pdf');
}
window.openInvoicePdfPreview = openInvoicePdfPreview;

function sendInvoiceFromPdfPreview() {
  // Close the preview and trigger the normal Send flow
  closePanel('panel-invoice-pdf');
  const btn = document.getElementById('sendInvoiceBtn');
  if (btn) btn.click();
}
window.sendInvoiceFromPdfPreview = sendInvoiceFromPdfPreview;

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
        recipient_address: document.getElementById('invClientAddress')?.value?.trim() || null,
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
      // Re-render the invoices list so the new row and totals are current
      if (typeof renderInvoicesScreen === 'function') {
        try { await renderInvoicesScreen(); } catch (_) {}
      }
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

async function saveInvoiceDraft() {
  const billTo = document.getElementById('invBillTo').value.trim();
  const amountVal = parseFloat(document.getElementById('invAmount').value);
  if (!billTo && !amountVal) {
    // Let users close a blank form without hassle
    closePanel('panel-invoice');
    return;
  }

  // Pull the same set of fields submitInvoice sends, but stamp status='draft'
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
        amount: isNaN(amountVal) ? 0 : amountVal,
        due_date: document.getElementById('invDueDate').value || null,
        notes: document.getElementById('invNotes').value,
        invoice_number: invoiceNumber,
        venue_name: venueName,
        venue_address: venueAddress,
        recipient_address: document.getElementById('invClientAddress')?.value?.trim() || null,
        status: 'draft',
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to save draft');
    }
    // Invalidate the invoices cache and re-render the list so the draft shows up
    window._cachedInvoices = null;
    window._cachedInvoicesTime = 0;
    if (typeof renderInvoicesScreen === 'function') {
      try { await renderInvoicesScreen(); } catch (_) {}
    }
    closePanel('panel-invoice');
    showToast('Draft saved');
  } catch (e) {
    console.error('Save draft error:', e);
    showToast('Could not save draft');
  }
}
window.saveInvoiceDraft = saveInvoiceDraft;

// ── Send Dep Panel ────────────────────────────────────────────────────────────

async function initDepPanel() {
  // Populate gig selector from cached or fresh gigs
  let gigs = window._cachedGigs || [];
  if (!gigs.length) {
    try {
      const r = await fetch('/api/gigs');
      if (r.ok) {
        const data = await r.json();
        gigs = data.gigs || data || [];
        window._cachedGigs = gigs;
        persistCachedCalendar();
      }
    } catch {}
  }
  const sel = document.getElementById('depGigSelect');
  if (sel) {
    sel.innerHTML = '<option value="">Select a gig...</option>';
    gigs.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `${g.band_name || g.title || 'Gig'} \u00B7 ${formatDate(g.date)}`;
      sel.appendChild(opt);
    });
  }

  // Reset selected contacts
  window._depSelectedContacts = new Set();

  // Wire musician search
  const searchEl = document.getElementById('depMusicianSearch');
  const resultsEl = document.getElementById('depMusicianResults');
  if (searchEl && resultsEl) {
    searchEl.value = '';
    resultsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-3);">Type to search your contacts...</div>';
    searchEl.oninput = async () => {
      const q = (searchEl.value || '').trim().toLowerCase();
      let contacts = window._cachedContacts || [];
      if (!contacts.length) {
        try {
          const r = await fetch('/api/contacts');
          if (r.ok) contacts = await r.json();
          window._cachedContacts = contacts;
        } catch {}
      }
      const matched = contacts.filter(c => {
        if (!q) return false;
        const instrStr = Array.isArray(c.instruments) ? c.instruments.join(', ') : (c.instruments || '');
        return (c.name || '').toLowerCase().includes(q) || instrStr.toLowerCase().includes(q);
      }).slice(0, 10);
      if (!matched.length) {
        resultsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-3);">No contacts match.</div>';
        return;
      }
      resultsEl.innerHTML = matched.map(c => {
        const sel = window._depSelectedContacts.has(c.id);
        const instrStr = Array.isArray(c.instruments) ? c.instruments.join(', ') : (c.instruments || '');
        return `<div onclick="toggleDepContact('${c.id}')" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};border-radius:10px;margin-bottom:6px;cursor:pointer;background:${sel ? 'var(--accent-dim)' : 'transparent'};">
          <div style="width:32px;height:32px;border-radius:16px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--accent);">${escapeHtml((c.name || 'U')[0].toUpperCase())}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(c.name || '')}</div>
            <div style="font-size:11px;color:var(--text-2);">${escapeHtml(instrStr || 'No instruments')}</div>
          </div>
          <span style="font-size:16px;">${sel ? '\u2713' : '+'}</span>
        </div>`;
      }).join('');
    };
  }

  const btn = document.getElementById('sendDepBtn');
  if (btn) btn.onclick = submitDepOffer;

  // Consume contact prefill if the user arrived here from a Contact Detail panel.
  if (window._depPrefillContactId) {
    const prefillId = window._depPrefillContactId;
    window._depPrefillContactId = null;
    try {
      let contacts = window._cachedContacts || [];
      if (!contacts.length) {
        const r = await fetch('/api/contacts');
        if (r.ok) contacts = await r.json();
        window._cachedContacts = contacts;
      }
      const contact = contacts.find(c => c.id === prefillId);
      if (contact) {
        setDepMode('pick');
        window._depSelectedContacts.add(prefillId);
        if (searchEl) {
          searchEl.value = contact.name || '';
          if (typeof searchEl.oninput === 'function') await searchEl.oninput();
        }
      }
    } catch (e) {
      console.error('Dep prefill error:', e);
    }
  }

  // Consume discovered-user prefill if the user arrived here from the Find
  // Musicians kebab sheet. We look the discovered user up by linked_user_id in
  // the existing contacts list (Phase IX-D auto-links on Add to Contacts).
  // If no matching contact exists yet, we drop the prefill silently and let the
  // user search manually so the panel still opens cleanly.
  if (window._depPrefillDiscoveredUserId) {
    const prefillUserId = window._depPrefillDiscoveredUserId;
    window._depPrefillDiscoveredUserId = null;
    try {
      let contacts = window._cachedContacts || [];
      if (!contacts.length) {
        const r = await fetch('/api/contacts');
        if (r.ok) contacts = await r.json();
        window._cachedContacts = contacts;
      }
      const contact = contacts.find(c => c.linked_user_id === prefillUserId);
      if (contact) {
        setDepMode('pick');
        window._depSelectedContacts.add(contact.id);
        if (searchEl) {
          searchEl.value = contact.name || '';
          if (typeof searchEl.oninput === 'function') await searchEl.oninput();
        }
      }
    } catch (e) {
      console.error('Dep discovered-user prefill error:', e);
    }
  }
}

function toggleDepContact(contactId) {
  if (!window._depSelectedContacts) window._depSelectedContacts = new Set();
  if (window._depSelectedContacts.has(contactId)) window._depSelectedContacts.delete(contactId);
  else window._depSelectedContacts.add(contactId);
  const searchEl = document.getElementById('depMusicianSearch');
  if (searchEl && typeof searchEl.oninput === 'function') searchEl.oninput();
}
window.toggleDepContact = toggleDepContact;

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
  const contactIds = Array.from(window._depSelectedContacts || []);

  if (!gigId) { showToast('Select a gig'); return; }
  if (!role) { showToast('Enter the role needed'); return; }
  if (mode === 'pick' && contactIds.length === 0) { showToast('Select at least one contact'); return; }

  try {
    const res = await fetch('/api/dep-offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gig_id: gigId, role, message, mode, contact_ids: contactIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      closePanel('panel-dep');
      const sent = data.sent || 0;
      const unresolved = data.unresolved || 0;
      const filteredOOR = data.filtered_out_of_range || 0;
      const oorList = Array.isArray(data.out_of_range_contacts) ? data.out_of_range_contacts : [];
      const overridden = oorList.filter(c => c.overridden);
      // Nudge cap (2026-04-23): the server returns any contacts who already
      // have a pending offer from this user for this gig. We don't create a
      // new offer row for them — instead we offer a one-tap "Nudge them
      // instead?" confirm right after the send toast.
      const alreadySent = Array.isArray(data.already_sent) ? data.already_sent : [];
      const nudgeable = alreadySent.filter(a => (a.nudges_remaining || 0) > 0);

      // Build the result message. Priority: tell the user what actually
      // happened, including any distance-filter outcomes.
      let msg;
      if (mode === 'all' && filteredOOR > 0) {
        // Broadcast: show X of Y sent, Z filtered by distance.
        const total = sent + filteredOOR + alreadySent.length;
        msg = `Sent to ${sent} of ${total} (${filteredOOR} filtered by distance${alreadySent.length ? `, ${alreadySent.length} already sent` : ''})`;
      } else if (mode === 'pick' && overridden.length > 0) {
        // Pick: delivered anyway, but warn that some are outside their radius.
        const first = overridden[0];
        const name = first.name || 'that contact';
        if (overridden.length === 1) {
          msg = `Sent. ${name} is ${first.distance_miles} mi outside their ${first.radius_miles} mi radius`;
        } else {
          msg = `Sent to ${sent}. ${overridden.length} contacts are outside their travel radius`;
        }
      } else if (sent === 0 && alreadySent.length > 0) {
        // Every selected contact was already sent this gig: point them to
        // the nudge action directly.
        msg = alreadySent.length === 1
          ? `You've already sent this to them. ${nudgeable.length > 0 ? 'Nudge instead?' : 'No nudges left on that offer.'}`
          : `You've already sent this to ${alreadySent.length} of them. ${nudgeable.length > 0 ? 'Nudge instead?' : 'No nudges left.'}`;
      } else if (sent > 0 && alreadySent.length > 0) {
        msg = `Sent to ${sent}. ${alreadySent.length} were already sent this gig.`;
      } else if (sent > 0 && unresolved > 0) {
        msg = `Sent to ${sent}, ${unresolved} without a TrackMyGigs account`;
      } else if (sent > 0) {
        msg = `Dep offer sent to ${sent} ${sent === 1 ? 'person' : 'people'}`;
      } else if (unresolved > 0) {
        msg = `${unresolved} contacts are not on TrackMyGigs yet`;
      } else {
        msg = 'Dep offer sent!';
      }
      showToast(msg);

      // Second action: if any of the selected contacts are nudgeable, fire
      // a confirm so the user can nudge all of them in one tap. Waits 400ms
      // so the send toast lands first and doesn't feel stacked.
      if (nudgeable.length > 0) {
        setTimeout(() => {
          const who = nudgeable.length === 1 ? '1 person' : `${nudgeable.length} people`;
          if (confirm(`Nudge ${who} who already had this offer?`)) {
            nudgeMultipleOffers(nudgeable.map(n => n.existing_offer_id));
          }
        }, 400);
      }
    } else {
      showToast(data.error || 'Failed to send dep offer');
    }
  } catch {
    showToast('Failed to send dep offer');
  }
}

// Bulk-nudge helper invoked from the send-dep flow when the server reports
// that one or more selected contacts already had a pending offer. Fires
// POST /api/offers/:id/nudge in parallel for each id, counts successes, and
// shows a single summary toast.
async function nudgeMultipleOffers(offerIds) {
  if (!Array.isArray(offerIds) || offerIds.length === 0) return;
  const results = await Promise.allSettled(
    offerIds.map(id => fetch(`/api/offers/${id}/nudge`, { method: 'POST' }).then(r => r.json().catch(() => ({}))))
  );
  let ok = 0;
  let capped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.success) ok++;
    else if (r.status === 'fulfilled' && r.value && /nudges left/i.test(r.value.error || '')) capped++;
    else failed++;
  }
  if (ok && !capped && !failed) {
    showToast(`${ok} nudge${ok === 1 ? '' : 's'} sent`);
  } else if (ok || capped || failed) {
    showToast(`${ok} nudged, ${capped} out of nudges, ${failed} failed`);
  }
  // If the Offers screen's Sent tab is open, refresh it so nudge_count and
  // last_nudged_at reflect the new state without a page reload.
  if (typeof loadSentOffers === 'function' && document.getElementById('sentOffersList')) {
    loadSentOffers();
  }
}

// ── Receipts Panel ────────────────────────────────────────────────────────────

// Client-side filter state — we keep the full list in memory and re-render on
// category change, rather than re-querying the server each time.
let _receiptsCache = [];
let _receiptsActiveCategory = 'All';

async function initReceiptPanel() {
  const d1 = document.getElementById('receiptDate'); if (d1) d1.valueAsDate = new Date();
  const d2 = document.getElementById('receiptSnapDate'); if (d2) d2.valueAsDate = new Date();
  await loadReceipts();
}

function showReceiptForm(type) {
  // Toggle the correct form open and hide the other
  const snap = document.getElementById('receiptSnapForm');
  const manual = document.getElementById('receiptManualForm');
  if (type === 'snap') {
    if (manual) manual.style.display = 'none';
    if (snap) snap.style.display = 'block';
  } else {
    if (snap) snap.style.display = 'none';
    if (manual) manual.style.display = 'block';
  }
}
window.showReceiptForm = showReceiptForm;

function hideReceiptForm(type) {
  if (type === 'snap') {
    const snap = document.getElementById('receiptSnapForm');
    if (snap) snap.style.display = 'none';
  } else {
    const manual = document.getElementById('receiptManualForm');
    if (manual) manual.style.display = 'none';
  }
}
window.hideReceiptForm = hideReceiptForm;

function handleReceiptSnap(event) {
  // Preview the selected photo inline inside the Snap form. We do not upload
  // the photo yet — the backend expense endpoint doesn't accept file uploads,
  // so the photo currently lives only in the browser until the user picks Save.
  const file = event && event.target && event.target.files && event.target.files[0];
  if (!file) return;
  const preview = document.getElementById('receiptSnapPreview');
  const icon = document.getElementById('receiptSnapPreviewIcon');
  const hint = document.getElementById('receiptSnapHint');
  const reader = new FileReader();
  reader.onload = function (ev) {
    if (preview) {
      preview.src = ev.target.result;
      preview.style.display = 'block';
    }
    if (icon) icon.style.display = 'none';
    if (hint) hint.textContent = 'Tap to retake';
  };
  reader.readAsDataURL(file);
}
window.handleReceiptSnap = handleReceiptSnap;

// Apply AI-scanned receipt data to the manual-entry form. Called from
// public/js/ai.js after the user confirms the scan preview. Everything is
// editable before save — AI output is a draft, not gospel.
function applyAIScannedReceipt(data) {
  if (!data) return;
  showReceiptForm('manual');
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  setVal('receiptMerchant', data.merchant || '');
  setVal('receiptAmount', data.amount != null ? data.amount : '');
  setVal('receiptVat', data.vat != null ? data.vat : '');
  if (data.date) setVal('receiptDate', data.date);
  const catSel = document.getElementById('receiptCategory');
  if (catSel && data.category) {
    // Soft match category name against the dropdown. If no exact match, leave
    // the default — the user picks manually.
    const opts = Array.from(catSel.options).map((o) => o.value);
    const hit = opts.find((v) => v.toLowerCase() === String(data.category).toLowerCase())
             || opts.find((v) => v.toLowerCase().includes(String(data.category).toLowerCase().split(' ')[0]));
    if (hit) catSel.value = hit;
  }
  setVal('receiptNotes', data.notes || '');
  if (typeof showToast === 'function') showToast('Receipt scanned. Review and save.', 'success');
}
window.applyAIScannedReceipt = applyAIScannedReceipt;

// S13-10: Categories that map to HMRC SA103 deductible boxes. 'Other' and
// anything uncategorised does not roll up into the claimable total.
const HMRC_DEDUCTIBLE_CATEGORIES = new Set([
  'Travel & vehicle',
  'Equipment & instruments',
  'Equipment repairs',
  'Accommodation',
  'Subsistence (overnight)',
  'Phone & office',
  'Advertising & promotion',
  'Professional fees',
  'Subscriptions & dues',
  'Stage clothing',
  'Training & CPD',
]);

async function loadReceipts() {
  try {
    const res = await fetch('/api/expenses');
    if (!res.ok) throw new Error('Failed to load expenses');
    const data = await res.json();
    const expenses = data.expenses || [];
    _receiptsCache = expenses;
    renderReceiptCategoryPills();
    renderReceiptList();
    // S13-10: Total expenses is the full list; total claimable is only rows
    // tagged with a deductible HMRC category.
    const total = expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const claimable = expenses
      .filter(e => HMRC_DEDUCTIBLE_CATEGORIES.has((e.category || '').trim()))
      .reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    document.getElementById('receiptTotalExpenses').textContent = '£' + total.toFixed(0);
    document.getElementById('receiptClaimable').textContent = '£' + claimable.toFixed(0);
    document.getElementById('receiptCount').textContent = expenses.length + ' receipt' + (expenses.length !== 1 ? 's' : '');
  } catch (err) {
    // S13-12: surface the failure instead of swallowing it.
    console.error('Load receipts error:', err);
    try { showToast('Could not load receipts. Check your connection.'); } catch (_) {}
  }
}

function renderReceiptCategoryPills() {
  const container = document.getElementById('receiptCategoryPills');
  if (!container) return;
  const counts = { All: _receiptsCache.length };
  _receiptsCache.forEach(e => {
    const k = (e.category || 'Other').trim() || 'Other';
    counts[k] = (counts[k] || 0) + 1;
  });
  // Ensure All goes first then the rest in descending count order
  const cats = Object.keys(counts).filter(k => k !== 'All').sort((a, b) => counts[b] - counts[a]);
  const order = ['All', ...cats];
  container.innerHTML = order.map(cat => {
    const active = (_receiptsActiveCategory === cat);
    const style = active
      ? 'background:var(--accent);color:#000;border:none;border-radius:20px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;'
      : 'background:var(--card);border:1px solid var(--border);color:var(--text-2);border-radius:20px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;';
    return `<button style="${style}" onclick="setReceiptCategory('${escapeAttr(cat)}')">${escapeHtml(cat)} (${counts[cat]})</button>`;
  }).join('');
}

function setReceiptCategory(cat) {
  _receiptsActiveCategory = cat;
  renderReceiptCategoryPills();
  renderReceiptList();
}
window.setReceiptCategory = setReceiptCategory;

function renderReceiptList() {
  const list = document.getElementById('receiptList');
  if (!list) return;
  const filtered = (_receiptsActiveCategory === 'All')
    ? _receiptsCache
    : _receiptsCache.filter(e => ((e.category || 'Other').trim() || 'Other') === _receiptsActiveCategory);
  list.innerHTML = filtered.length ? filtered.map((e) => {
    // S13-15: parseFloat(null) yields NaN and ".toFixed(2)" prints 'NaN.00'.
    // Fall back to a placeholder so a corrupt row doesn't look like a bug.
    const n = parseFloat(e.amount);
    const amount = Number.isFinite(n) ? '&pound;' + n.toFixed(2) : '&mdash;';
    return `
    <div class="receipt-item" onclick="openReceiptDetail('${e.id}')" style="cursor:pointer;">
      <div>
        <div style="font-size:14px;font-weight:600;color:var(--text)">${escapeHtml(e.description || 'Expense')}</div>
        <div style="font-size:12px;color:var(--text-2)">${escapeHtml(e.category || '')} &middot; ${formatDate(e.date)}</div>
      </div>
      <div style="font-size:15px;font-weight:700;color:var(--text)">${amount}</div>
    </div>`;
  }).join('') : '<div style="text-align:center;color:var(--text-2);padding:20px;font-size:14px">No expenses in this category</div>';
}

// S13-13: Receipt edit/delete UI. Opens a lightweight inline modal from the
// receipt list row. Uses a dedicated form that mirrors the manual-entry fields.
function openReceiptDetail(id) {
  const e = (_receiptsCache || []).find(r => String(r.id) === String(id));
  if (!e) return;
  const host = document.getElementById('receiptEditHost') || (() => {
    const d = document.createElement('div');
    d.id = 'receiptEditHost';
    document.body.appendChild(d);
    return d;
  })();
  const escapedDesc = escapeAttr(e.description || '');
  const dateVal = e.date ? String(e.date).slice(0, 10) : '';
  const categories = Array.from(HMRC_DEDUCTIBLE_CATEGORIES);
  categories.push('Other');
  const catOptions = categories.map(c =>
    `<option value="${escapeAttr(c)}"${c === e.category ? ' selected' : ''}>${escapeHtml(c)}</option>`
  ).join('');

  host.innerHTML = `
    <div id="receiptEditOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;" onclick="if(event.target===this)closeReceiptDetail()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);max-width:420px;width:100%;padding:20px;">
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:12px;">Edit receipt</div>
        <div class="form-group"><div class="form-label">Amount (&pound;)</div><input type="number" class="form-input" id="editReceiptAmount" value="${parseFloat(e.amount || 0)}"></div>
        <div class="form-group"><div class="form-label">Description</div><input type="text" class="form-input" id="editReceiptDesc" value="${escapedDesc}" maxlength="200"></div>
        <div class="form-group"><div class="form-label">Date</div><input type="date" class="form-input" id="editReceiptDate" value="${dateVal}"></div>
        <div class="form-group"><div class="form-label">HMRC category</div>
          <select class="form-input" id="editReceiptCategory">${catOptions}</select>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button onclick="deleteReceipt('${e.id}')" class="btn-pill-outline" style="flex:1;color:var(--danger);border-color:var(--danger);">Delete</button>
          <button onclick="closeReceiptDetail()" class="btn-pill-outline" style="flex:1;">Cancel</button>
          <button onclick="saveReceiptEdit('${e.id}')" class="btn-pill" style="flex:1;">Save</button>
        </div>
      </div>
    </div>`;
}
window.openReceiptDetail = openReceiptDetail;

function closeReceiptDetail() {
  const host = document.getElementById('receiptEditHost');
  if (host) host.innerHTML = '';
}
window.closeReceiptDetail = closeReceiptDetail;

async function saveReceiptEdit(id) {
  const amount = parseFloat(document.getElementById('editReceiptAmount').value);
  const description = document.getElementById('editReceiptDesc').value.trim();
  const date = document.getElementById('editReceiptDate').value;
  const category = document.getElementById('editReceiptCategory').value;
  if (!amount || amount <= 0) { showToast('Enter a valid amount'); return; }
  if (!description) { showToast('Enter a description'); return; }
  try {
    const res = await fetch(`/api/expenses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, description, date, category }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to update');
    }
    closeReceiptDetail();
    await loadReceipts();
    showToast('Receipt updated');
  } catch (err) {
    console.error('Save receipt error:', err);
    showToast(err.message || 'Failed to update receipt');
  }
}
window.saveReceiptEdit = saveReceiptEdit;

async function deleteReceipt(id) {
  const ok = await showConfirm('Delete this receipt? This cannot be undone.', {
    title: 'Delete receipt?',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete');
    closeReceiptDetail();
    await loadReceipts();
    showToast('Receipt deleted');
  } catch (err) {
    console.error('Delete receipt error:', err);
    showToast('Failed to delete receipt');
  }
}
window.deleteReceipt = deleteReceipt;

async function submitReceipt(source) {
  // source === 'snap' uses the snap-form fields; anything else uses manual form
  const isSnap = source === 'snap';
  const amountEl = document.getElementById(isSnap ? 'receiptSnapAmount' : 'receiptAmount');
  const descEl = document.getElementById(isSnap ? 'receiptSnapDesc' : 'receiptDesc');
  const dateEl = document.getElementById(isSnap ? 'receiptSnapDate' : 'receiptDate');
  const catEl = document.getElementById(isSnap ? 'receiptSnapCategory' : 'receiptCategory');

  const amount = parseFloat(amountEl && amountEl.value);
  const desc = (descEl && descEl.value || '').trim();
  const date = dateEl && dateEl.value;
  const category = catEl && catEl.value;

  if (!amount || amount <= 0) { showToast('Enter an amount'); return; }
  if (!desc) { showToast('Enter a description'); return; }

  try {
    const res = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, description: desc, date, category }),
    });
    if (res.ok) {
      if (amountEl) amountEl.value = '';
      if (descEl) descEl.value = '';
      // Reset the snap photo preview if that was the source
      if (isSnap) {
        const preview = document.getElementById('receiptSnapPreview');
        const icon = document.getElementById('receiptSnapPreviewIcon');
        const hint = document.getElementById('receiptSnapHint');
        const fileInput = document.getElementById('receiptSnapPhoto');
        if (preview) { preview.src = ''; preview.style.display = 'none'; }
        if (icon) icon.style.display = '';
        if (hint) hint.textContent = 'Tap to take photo or choose from gallery';
        if (fileInput) fileInput.value = '';
      }
      hideReceiptForm(isSnap ? 'snap' : 'manual');
      await loadReceipts();
      showToast(isSnap ? 'Receipt saved!' : 'Expense saved!');
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

// S1-05: in-app confirm modal. Replaces native window.confirm() which (a) leaks the
// hosting domain in its title ("kirk.replit.dev says...") and (b) blocks the renderer
// in headless-test harnesses. Returns a Promise<boolean> so callers can `await showConfirm(...)`.
// Options: title, message, confirmLabel, cancelLabel, danger (styles confirm button red).
function showConfirm(message, options) {
  options = options || {};
  const title = options.title || 'Are you sure?';
  const confirmLabel = options.confirmLabel || 'Confirm';
  const cancelLabel = options.cancelLabel || 'Cancel';
  const danger = options.danger === true;
  return new Promise((resolve) => {
    // Remove any leftover confirm from a previous call.
    const existing = document.getElementById('confirmOverlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'confirmOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(13,17,23,.72);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:10050;display:flex;align-items:center;justify-content:center;padding:20px;';
    const confirmBg = danger ? 'var(--danger)' : 'var(--accent)';
    const confirmFg = danger ? '#fff' : '#000';
    overlay.innerHTML = `
      <div style="max-width:340px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px 20px 16px;box-shadow:0 30px 60px rgba(0,0,0,.6);">
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:8px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;color:var(--text-2);line-height:1.5;margin-bottom:18px;">${escapeHtml(message)}</div>
        <div style="display:flex;gap:10px;">
          <button id="confirmCancel" style="flex:1;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:14px;font-weight:600;cursor:pointer;">${escapeHtml(cancelLabel)}</button>
          <button id="confirmOk" style="flex:1;background:${confirmBg};color:${confirmFg};border:none;border-radius:10px;padding:10px;font-size:14px;font-weight:700;cursor:pointer;">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (value) => { overlay.remove(); resolve(value); };
    overlay.querySelector('#confirmOk').onclick = () => cleanup(true);
    overlay.querySelector('#confirmCancel').onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    // Escape key dismisses.
    const escHandler = (e) => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); cleanup(false); }
    };
    document.addEventListener('keydown', escHandler);
  });
}
window.showConfirm = showConfirm;

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

// ── PDF EXPORT (browser-native Save as PDF) ─────────────────────────────────
// The server returns a printable HTML page that auto-triggers window.print() on
// load. The user saves as PDF from the browser's print dialog. Zero-dependency.

function exportGigsPDF() {
  // New tab so auth cookies are carried over; the server route is behind authMiddleware.
  window.open('/api/print/gigs', '_blank', 'noopener');
}
window.exportGigsPDF = exportGigsPDF;

function exportFinancePDF() {
  window.open('/api/print/finance', '_blank', 'noopener');
}
window.exportFinancePDF = exportFinancePDF;

// ── ONBOARDING TOUR ─────────────────────────────────────────────────────────
// A simple first-run welcome shown once (gated by users.onboarded_at).
// Fires after prefetchAllData settles so we have the profile to check.

// S10-06: the old onboarding was five info-only slides. The user landed on a
// blank home screen with no act name, no postcode, no instruments, and no
// idea that their public EPK would just show the email local-part. Two of
// the slides are now forms whose values are POSTed to /api/user/profile so
// the first-run experience actually seeds the minimum profile the rest of
// the app depends on.
const ONBOARDING_STEPS = [
  {
    kind: 'info',
    emoji: '🎵',
    title: 'Welcome to TrackMyGigs',
    body: "Your home for every gig, invoice, expense and mile. Let's set up the basics in 30 seconds.",
    cta: 'Get started',
  },
  {
    kind: 'form',
    id: 'profile-basics',
    emoji: '👋',
    title: 'What should we call you?',
    render: (profile) => `
      <div style="text-align:left;margin-bottom:14px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Name or act name</label>
        <input id="onbName" type="text" value="${escapeHtml(profile.display_name || profile.name || '')}" placeholder="Your name or band/act" style="width:100%;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;box-sizing:border-box;">
      </div>
      <div style="text-align:left;margin-bottom:4px;">
        <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:4px;">Home postcode</label>
        <input id="onbPostcode" type="text" value="${escapeHtml(profile.home_postcode || profile.postcode || '')}" placeholder="e.g. SE1 9SG" style="width:100%;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;box-sizing:border-box;text-transform:uppercase;">
        <div style="font-size:11px;color:var(--text-3);margin-top:4px;">Used for mileage claims and travel-time estimates. Never shared.</div>
      </div>`,
    collect: () => {
      const name = (document.getElementById('onbName')?.value || '').trim();
      const postcode = (document.getElementById('onbPostcode')?.value || '').trim().toUpperCase();
      const body = {};
      if (name) { body.display_name = name; body.name = name; }
      if (postcode) body.home_postcode = postcode;
      return body;
    },
    cta: 'Next',
  },
  {
    kind: 'form',
    id: 'profile-music',
    emoji: '🎸',
    title: 'What do you play?',
    render: (profile) => {
      const current = Array.isArray(profile.instruments)
        ? profile.instruments
        : (typeof profile.instruments === 'string'
            ? profile.instruments.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)
            : []);
      const options = ['Vocals', 'Guitar', 'Bass', 'Drums', 'Keys', 'Sax', 'Trumpet', 'Violin', 'DJ'];
      const chips = options.map(opt => {
        const active = current.map(c => c.toLowerCase()).includes(opt.toLowerCase());
        return `<label style="display:inline-flex;align-items:center;gap:6px;background:${active ? 'var(--accent)' : 'var(--bg)'};color:${active ? '#000' : 'var(--text)'};border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;">
          <input type="checkbox" name="onbInstrument" value="${escapeHtml(opt)}" ${active ? 'checked' : ''} style="display:none;">
          ${escapeHtml(opt)}
        </label>`;
      }).join('');
      const avail = profile.available_for_deps === true;
      return `
        <div style="text-align:left;margin-bottom:14px;">
          <label style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:6px;">Instruments</label>
          <div id="onbInstrChips" style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
        </div>
        <div style="text-align:left;">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">
            <input id="onbDepToggle" type="checkbox" ${avail ? 'checked' : ''} style="accent-color:var(--accent);">
            <span style="font-size:14px;color:var(--text);">Available for dep gigs</span>
          </label>
          <div style="font-size:11px;color:var(--text-3);margin-top:4px;">Other users can invite you to cover their bookings. You can change this later.</div>
        </div>`;
    },
    collect: () => {
      const body = {};
      const inputs = document.querySelectorAll('input[name="onbInstrument"]:checked');
      body.instruments = Array.from(inputs).map(i => i.value);
      body.available_for_deps = !!document.getElementById('onbDepToggle')?.checked;
      return body;
    },
    cta: 'Next',
    // Wire chip toggle visual after render.
    afterRender: () => {
      const chipHost = document.getElementById('onbInstrChips');
      if (!chipHost) return;
      chipHost.querySelectorAll('label').forEach(lbl => {
        const input = lbl.querySelector('input');
        if (!input) return;
        input.addEventListener('change', () => {
          const active = input.checked;
          lbl.style.background = active ? 'var(--accent)' : 'var(--bg)';
          lbl.style.color = active ? '#000' : 'var(--text)';
          lbl.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
        });
      });
    },
  },
  {
    kind: 'info',
    emoji: '💷',
    title: 'Get paid, stay sane',
    body: "Every gig can turn into an invoice with one tap. Overdue invoices show up on your home screen so nothing slips.",
    cta: 'Next',
  },
  {
    kind: 'info',
    emoji: '✨',
    title: "You're ready",
    body: "Add your first gig and everything else falls into place. Your home and Finance panels fill up as you go.",
    cta: "Log my first gig",
    final: true,
  },
];

function maybeStartOnboarding() {
  try {
    // BUG-AUDIT-02: Server-side onboarded_at is the canonical truth.
    // The old localStorage 'tmg_onboarded' guard suppressed the tour for
    // fresh users who signed in on a browser that had previously hosted
    // a different TMG session (shared computer, demo user then real user,
    // etc.). window._onboardingShown already dedups within a single page
    // session, so localStorage is redundant AND causes false negatives
    // across users. Drop the localStorage gate entirely and trust the
    // server. If a cached stale profile is present, still defer so we
    // don't race a pending /api/user/profile fetch.
    if (window._onboardingShown) return;
    const profile = window._cachedProfile || {};
    if (profile.onboarded_at) return;
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

  // S10-06: render info steps with step.body, form steps with step.render(profile).
  // Form steps also get an optional afterRender() hook for post-insertion wiring
  // (chip toggles, etc.) and a collect() call on Next that POSTs to /api/user/profile.
  const profile = window._cachedProfile || {};
  const bodyHtml = step.kind === 'form' && typeof step.render === 'function'
    ? step.render(profile)
    : `<div style="font-size:14px;color:var(--text-2);line-height:1.5;">${escapeHtml(step.body || '')}</div>`;

  overlay.innerHTML = `
    <div style="max-width:360px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 24px;text-align:center;box-shadow:0 30px 60px rgba(0,0,0,.5);">
      <div style="font-size:52px;margin-bottom:12px;">${step.emoji}</div>
      <div style="font-size:20px;font-weight:700;color:var(--text);margin-bottom:14px;">${escapeHtml(step.title)}</div>
      <div style="margin-bottom:20px;">${bodyHtml}</div>
      <div style="display:flex;justify-content:center;gap:6px;margin-bottom:20px;">${pips}</div>
      <button id="onbNext" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:10px;padding:12px;font-size:15px;font-weight:700;cursor:pointer;">${escapeHtml(step.cta)}</button>
      <button id="onbSkip" style="margin-top:10px;width:100%;background:transparent;color:var(--text-3);border:none;padding:8px;font-size:13px;cursor:pointer;">Skip tour</button>
    </div>`;

  // Wire any post-render hooks (chip toggle visuals, focus, etc.)
  if (step.kind === 'form' && typeof step.afterRender === 'function') {
    try { step.afterRender(); } catch (err) { console.error('Onboarding afterRender failed:', err); }
  }

  const nextBtn = overlay.querySelector('#onbNext');
  const skipBtn = overlay.querySelector('#onbSkip');
  nextBtn.onclick = async () => {
    // For form steps, collect values and persist before advancing.
    if (step.kind === 'form' && typeof step.collect === 'function') {
      try {
        nextBtn.disabled = true;
        nextBtn.textContent = 'Saving…';
        const body = step.collect();
        if (body && Object.keys(body).length) {
          const res = await fetch('/api/user/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            const updated = await res.json().catch(() => null);
            if (updated) window._cachedProfile = Object.assign({}, window._cachedProfile || {}, updated);
            else window._cachedProfile = Object.assign({}, window._cachedProfile || {}, body);
          }
        }
      } catch (err) {
        console.error('Onboarding step save failed (non-fatal, continuing):', err);
      }
    }
    if (step.final) {
      await finishOnboarding({ openGigWizard: true });
    } else {
      showOnboardingStep(index + 1);
    }
  };
  skipBtn.onclick = () => finishOnboarding({ openGigWizard: false });
}

async function finishOnboarding(opts) {
  const overlay = document.getElementById('onboardingOverlay');
  if (overlay) overlay.remove();
  try {
    localStorage.setItem('tmg_onboarded', '1');
    await fetch('/api/user/onboarded', { method: 'POST' });
    if (window._cachedProfile) window._cachedProfile.onboarded_at = new Date().toISOString();
  } catch (err) {
    console.error('Mark onboarded failed (non-fatal):', err);
  }
  // S10-06: if the final step asked us to, jump straight into the gig wizard so
  // the first-run experience ends with the user adding their first booking.
  if (opts && opts.openGigWizard) {
    try {
      if (typeof openGigWizard === 'function') setTimeout(() => openGigWizard(), 200);
    } catch (err) {
      console.error('Auto-open gig wizard failed (non-fatal):', err);
    }
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

// ── First-import modal + quick-fire wizard ──────────────────────────────────
// Triggered automatically after the OAuth callback appends ?calendar_connected=true
// to the URL (see setupApp). User sees a full-screen overlay with a fetched
// count of likely gigs, three window choices (current tax year default, future
// only, custom range), and a single "Import all" CTA. On success, we kick off
// the quick-fire fee wizard which steps through each imported gig that came
// back without a fee, auto-focusing the fee input for keyboard-first entry.
//
// All markup is injected dynamically so there's no dependency on index.html
// having panels declared up-front. State lives on window._firstImport so a
// page refresh mid-flow can pick up where the user left off (best-effort).

(function () {
  const ov = () => document.getElementById('firstImportOverlay');
  const closeOverlay = () => { const el = ov(); if (el) el.remove(); };

  // Public entry point exposed on window. Idempotent - if the overlay is
  // already open, this just re-fetches the events.
  window.openFirstImportModal = async function openFirstImportModal(opts = {}) {
    const existing = ov();
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'firstImportOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;';
    overlay.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:18px;width:100%;max-width:440px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <div id="fiBody">
          <div style="text-align:center;padding:40px 20px;">
            <div style="width:44px;height:44px;border-radius:50%;border:3px solid var(--border);border-top-color:var(--accent);margin:0 auto 16px;animation:fiSpin 1s linear infinite;"></div>
            <div style="font-size:14px;color:var(--text-2);">Looking through your calendar...</div>
          </div>
        </div>
      </div>
      <style>@keyframes fiSpin{to{transform:rotate(360deg);}}</style>`;
    document.body.appendChild(overlay);

    // Fetch the current tax year by default; the UI lets users widen it.
    await fiFetchAndRender('current_tax_year');
  };

  async function fiFetchAndRender(windowMode, from, to) {
    const body = document.getElementById('fiBody');
    if (!body) return;
    body.innerHTML = `
      <div style="text-align:center;padding:40px 20px;">
        <div style="width:44px;height:44px;border-radius:50%;border:3px solid var(--border);border-top-color:var(--accent);margin:0 auto 16px;animation:fiSpin 1s linear infinite;"></div>
        <div style="font-size:14px;color:var(--text-2);">Classifying events with AI...</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px;">This takes 10-30 seconds for a full year.</div>
      </div>`;

    let url = '/api/calendar/events?window=' + encodeURIComponent(windowMode);
    if (windowMode === 'custom' && from && to) {
      url += '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    }
    let events = [];
    try {
      const r = await fetch(url);
      const data = await r.json();
      if (!data.connected) {
        body.innerHTML = `
          <div style="text-align:center;padding:30px 16px;">
            <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;">Calendar not connected</div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:16px;">Connect Google Calendar in Profile first.</div>
            <button onclick="document.getElementById('firstImportOverlay').remove();" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 20px;font-size:13px;cursor:pointer;">Close</button>
          </div>`;
        return;
      }
      events = (data.events || []).filter(e => !e.already_imported);
    } catch (err) {
      body.innerHTML = `
        <div style="text-align:center;padding:30px 16px;">
          <div style="font-size:15px;font-weight:600;color:var(--danger);margin-bottom:6px;">Couldn't read your calendar</div>
          <div style="font-size:12px;color:var(--text-2);margin-bottom:16px;">${escapeHtml(err.message || String(err))}</div>
          <button onclick="document.getElementById('firstImportOverlay').remove();" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 20px;font-size:13px;cursor:pointer;">Close</button>
        </div>`;
      return;
    }

    // No candidates? Friendly empty state and a "maybe try a wider range" tip.
    if (events.length === 0) {
      body.innerHTML = `
        <div style="text-align:center;padding:30px 16px;">
          <div style="font-size:32px;margin-bottom:10px;">&#x1F4C5;</div>
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;">No gigs found in this range</div>
          <div style="font-size:12px;color:var(--text-2);margin-bottom:20px;line-height:1.5;">We didn't spot anything that looks like a gig in ${windowLabel(windowMode)}. Try a wider range or check your calendar choice in Settings.</div>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:12px;">
            <button onclick="fiFetchAndRender('all')" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:8px 14px;font-size:12px;cursor:pointer;">Try last 2 years</button>
            <button onclick="document.getElementById('firstImportOverlay').remove();" style="background:transparent;color:var(--text-2);border:1px solid var(--border);border-radius:10px;padding:8px 14px;font-size:12px;cursor:pointer;">Skip for now</button>
          </div>
        </div>`;
      window.fiFetchAndRender = fiFetchAndRender;
      return;
    }

    // Store the fetched events for the import call. Also compute earliest
    // and latest dates so the copy can say "going back to 6 Apr 2025".
    window._firstImport = { events, windowMode };
    const sortedByDate = events.slice().sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    const earliest = sortedByDate[0] && sortedByDate[0].start ? new Date(sortedByDate[0].start) : null;
    const latest = sortedByDate[sortedByDate.length - 1] && sortedByDate[sortedByDate.length - 1].start
      ? new Date(sortedByDate[sortedByDate.length - 1].start) : null;
    const rangeLine = (earliest && latest)
      ? `${earliest.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} to ${latest.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : '';

    body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:var(--accent);text-transform:uppercase;">Calendar import</div>
        <button onclick="document.getElementById('firstImportOverlay').remove();" aria-label="Close" style="background:transparent;border:none;color:var(--text-3);font-size:22px;cursor:pointer;line-height:1;padding:0 4px;">&times;</button>
      </div>
      <div style="font-size:24px;font-weight:700;color:var(--text);margin-bottom:6px;line-height:1.2;">We found <span style="color:var(--accent);">${events.length}</span> gig${events.length === 1 ? '' : 's'} in your calendar.</div>
      <div style="font-size:13px;color:var(--text-2);margin-bottom:18px;line-height:1.5;">${rangeLine ? 'Covering ' + escapeHtml(rangeLine) + '. ' : ''}Importing pulls venues, dates, times, and fees into TrackMyGigs. Your Google Calendar isn't touched.</div>

      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">
        <div style="font-size:16px;line-height:1;">&#x1F50D;</div>
        <div style="flex:1;">
          <div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:2px;">Range</div>
          <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
            ${rangeChip('current_tax_year', 'This tax year', windowMode)}
            ${rangeChip('all', 'Last 2 years', windowMode)}
            ${rangeChip('future', 'Future only', windowMode)}
          </div>
        </div>
      </div>

      <button id="fiImportBtn" onclick="fiStartImport()" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px;">Import all ${events.length}</button>
      <button onclick="document.getElementById('firstImportOverlay').remove();localStorage.setItem('tmg_first_import_done','1');" style="width:100%;background:transparent;color:var(--text-2);border:1px solid var(--border);border-radius:14px;padding:12px;font-size:13px;cursor:pointer;">Skip for now</button>

      <div style="font-size:11px;color:var(--text-3);margin-top:14px;line-height:1.5;">We'll add fees, dress code, and load-in times where the AI could find them. Anything blank, you can fill in seconds with the quick-fire review.</div>`;

    // Expose for inline handlers; closures on re-render.
    window.fiFetchAndRender = fiFetchAndRender;
    window.fiStartImport = fiStartImport;
  }

  function rangeChip(val, label, current) {
    const on = val === current;
    return `<button onclick="fiFetchAndRender('${val}')" style="background:${on ? 'var(--accent)' : 'var(--card)'};color:${on ? '#000' : 'var(--text-2)'};border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:999px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;">${label}</button>`;
  }

  function windowLabel(mode) {
    if (mode === 'current_tax_year') return 'this tax year';
    if (mode === 'all') return 'the last two years';
    if (mode === 'future') return 'the next 60 days';
    return 'that range';
  }

  async function fiStartImport() {
    const state = window._firstImport;
    if (!state || !Array.isArray(state.events)) return;
    const body = document.getElementById('fiBody');
    if (!body) return;
    body.innerHTML = `
      <div style="text-align:center;padding:30px 16px;">
        <div style="width:44px;height:44px;border-radius:50%;border:3px solid var(--border);border-top-color:var(--accent);margin:0 auto 16px;animation:fiSpin 1s linear infinite;"></div>
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;">Importing ${state.events.length} gig${state.events.length === 1 ? '' : 's'}...</div>
        <div style="font-size:11px;color:var(--text-3);">This takes a few seconds.</div>
      </div>`;

    // Build the payload: one object per event with whatever the AI pulled
    // plus the fallbacks. Server UPSERTs by google_event_id so re-runs are safe.
    const payload = {
      events: state.events.map(e => ({
        event_id: e.id,
        title: e.title,
        location: e.location,
        start: e.start,
        end: e.end,
        band_name: e.suggested_band_name || null,
        venue_name: e.suggested_venue_name || null,
        fee: e.suggested_fee || null,
        dress_code: e.suggested_dress_code || null,
        load_in_time: e.suggested_load_in_time || null,
        client_name: e.suggested_client_name || null,
        client_email: e.suggested_client_email || null,
        client_phone: e.suggested_client_phone || null,
        notes: e.suggested_notes || null,
      })),
    };

    try {
      const r = await fetch('/api/calendar/import-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        throw new Error(data.error || ('HTTP ' + r.status));
      }

      localStorage.setItem('tmg_first_import_done', '1');
      // Invalidate cached gigs so the Gigs + Home screens re-pull on next render.
      if (typeof invalidateGigsCache === 'function') invalidateGigsCache();

      const imported = (data.imported || 0) + (data.merged || 0);
      const gigs = Array.isArray(data.gigs) ? data.gigs : [];
      const needsFee = gigs.filter(g => g.fee == null || g.fee === '' || g.fee === 0);

      // Success state - show totals and kick off quick-fire if there are any
      // rows with missing fees. Otherwise one-tap close.
      const totalFee = gigs.reduce((s, g) => s + (parseFloat(g.fee) || 0), 0);
      body.innerHTML = `
        <div style="text-align:center;padding:10px 6px 0;">
          <div style="font-size:32px;margin-bottom:10px;">&#x1F389;</div>
          <div style="font-size:20px;font-weight:700;color:var(--text);margin-bottom:6px;">Imported ${imported} gig${imported === 1 ? '' : 's'}.</div>
          <div style="font-size:13px;color:var(--text-2);margin-bottom:18px;line-height:1.5;">
            ${totalFee > 0 ? `Pre-filled fees total &pound;${totalFee.toLocaleString('en-GB')}. ` : ''}
            ${needsFee.length > 0 ? `${needsFee.length} need${needsFee.length === 1 ? 's' : ''} a fee filling in.` : 'Every gig has a fee.'}
          </div>
          ${needsFee.length > 0 ? `
            <button onclick="fiStartWizard()" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px;">Fill in fees now (${needsFee.length})</button>
            <button onclick="document.getElementById('firstImportOverlay').remove();" style="width:100%;background:transparent;color:var(--text-2);border:1px solid var(--border);border-radius:14px;padding:12px;font-size:13px;cursor:pointer;">Do it later</button>
          ` : `
            <button onclick="document.getElementById('firstImportOverlay').remove();" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;">See my gigs</button>
          `}
        </div>`;

      window._firstImport.imported = gigs;
      window._firstImport.needsFee = needsFee;
      window.fiStartWizard = fiStartWizard;
    } catch (err) {
      console.error('[first-import] bulk error:', err);
      body.innerHTML = `
        <div style="text-align:center;padding:30px 16px;">
          <div style="font-size:15px;font-weight:600;color:var(--danger);margin-bottom:6px;">Import failed</div>
          <div style="font-size:12px;color:var(--text-2);margin-bottom:16px;">${escapeHtml(err.message || String(err))}</div>
          <button onclick="document.getElementById('firstImportOverlay').remove();" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 20px;font-size:13px;cursor:pointer;">Close</button>
        </div>`;
    }
  }
  window.fiStartImport = fiStartImport;

  // ── Quick-fire wizard ────────────────────────────────────────────────────
  // Steps through each imported gig without a fee. One gig per screen, fee
  // input pre-focused, Enter saves and advances. Keyboard-first so a musician
  // with 30 gigs to fill can clear them in 2-3 minutes.

  function fiStartWizard() {
    const state = window._firstImport;
    if (!state || !Array.isArray(state.needsFee) || state.needsFee.length === 0) {
      const o = ov(); if (o) o.remove();
      return;
    }
    state.wizardIndex = 0;
    state.wizardCompleted = 0;
    fiRenderWizardStep();
  }
  window.fiStartWizard = fiStartWizard;

  function fiRenderWizardStep() {
    const state = window._firstImport;
    const body = document.getElementById('fiBody');
    if (!state || !body) return;
    const gig = state.needsFee[state.wizardIndex];
    if (!gig) { fiFinishWizard(); return; }
    const total = state.needsFee.length;
    const pos = state.wizardIndex + 1;
    const pct = Math.round((pos / total) * 100);
    const dateLabel = gig.date ? new Date(gig.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const venueLabel = gig.venue_name || '(no venue)';
    const bandLabel = gig.band_name || gig.title || 'Untitled';

    body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:var(--accent);text-transform:uppercase;">Fill in fees - ${pos} of ${total}</div>
        <button onclick="fiFinishWizard()" aria-label="Close wizard" style="background:transparent;border:none;color:var(--text-3);font-size:22px;cursor:pointer;line-height:1;padding:0 4px;">&times;</button>
      </div>
      <div style="height:4px;background:var(--border);border-radius:2px;margin-bottom:16px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:var(--accent);transition:width 0.25s;"></div>
      </div>

      <div style="font-size:17px;font-weight:600;color:var(--text);margin-bottom:2px;">${escapeHtml(bandLabel)}</div>
      <div style="font-size:13px;color:var(--text-2);margin-bottom:2px;">${escapeHtml(venueLabel)}</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:18px;">${escapeHtml(dateLabel)}${gig.start_time ? ' &middot; ' + String(gig.start_time).substring(0, 5) : ''}</div>

      <label style="display:block;font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Fee (&pound;)</label>
      <input id="fiFee" type="number" inputmode="decimal" step="10" placeholder="0" style="width:100%;padding:16px 14px;background:var(--bg);border:2px solid var(--accent);border-radius:12px;color:var(--text);font-size:24px;font-weight:700;box-sizing:border-box;margin-bottom:14px;" onkeydown="if(event.key==='Enter'){event.preventDefault();fiSaveAndNext();}" />

      <label style="display:block;font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Dress code</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;" id="fiDress">
        ${['Smart', 'Black tie', 'All black', 'Casual'].map(v => `<button type="button" onclick="fiPickDress('${v}')" data-dress="${v}" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:16px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">${v}</button>`).join('')}
      </div>

      <label style="display:block;font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Notes (optional)</label>
      <textarea id="fiNotes" rows="2" placeholder="Anything else to remember..." style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:13px;box-sizing:border-box;margin-bottom:16px;resize:vertical;font-family:inherit;"></textarea>

      <div style="display:flex;gap:8px;">
        <button onclick="fiSkip()" style="flex:1;background:var(--card);color:var(--text-2);border:1px solid var(--border);border-radius:14px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;">Skip</button>
        <button onclick="fiSaveAndNext()" style="flex:2;background:var(--accent);color:#000;border:none;border-radius:14px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;">Save &amp; next &rarr;</button>
      </div>
      <div style="font-size:10px;color:var(--text-3);margin-top:10px;text-align:center;">Tip: hit Enter to save and advance.</div>`;

    // Pre-focus the fee input so the user can start typing immediately.
    setTimeout(() => {
      const fee = document.getElementById('fiFee');
      if (fee) fee.focus();
    }, 50);
  }
  window.fiRenderWizardStep = fiRenderWizardStep;

  function fiPickDress(val) {
    const wrap = document.getElementById('fiDress');
    if (!wrap) return;
    wrap.dataset.chosen = val;
    Array.from(wrap.querySelectorAll('button')).forEach(btn => {
      const on = btn.dataset.dress === val;
      btn.style.background = on ? 'var(--accent)' : 'var(--card)';
      btn.style.color = on ? '#000' : 'var(--text)';
      btn.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
    });
  }
  window.fiPickDress = fiPickDress;

  async function fiSaveAndNext() {
    const state = window._firstImport;
    if (!state) return;
    const gig = state.needsFee[state.wizardIndex];
    if (!gig) { fiFinishWizard(); return; }
    const feeEl = document.getElementById('fiFee');
    const notesEl = document.getElementById('fiNotes');
    const dressEl = document.getElementById('fiDress');
    const feeVal = feeEl ? parseFloat(feeEl.value) : NaN;
    const notes = notesEl ? notesEl.value.trim() : '';
    const dress = dressEl ? dressEl.dataset.chosen : null;
    if (!Number.isFinite(feeVal) || feeVal < 0) {
      // No fee typed. Treat as Skip rather than blocking progress - we
      // want the wizard to feel quick even if some gigs have unknown fees.
      return fiSkip();
    }
    try {
      await fetch('/api/gigs/' + encodeURIComponent(gig.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fee: feeVal, notes: notes || null, dress_code: dress || null }),
      });
      state.wizardCompleted++;
    } catch (err) {
      console.error('[wizard] save error:', err);
    }
    state.wizardIndex++;
    if (state.wizardIndex >= state.needsFee.length) {
      fiFinishWizard();
    } else {
      fiRenderWizardStep();
    }
  }
  window.fiSaveAndNext = fiSaveAndNext;

  function fiSkip() {
    const state = window._firstImport;
    if (!state) return;
    state.wizardIndex++;
    if (state.wizardIndex >= state.needsFee.length) {
      fiFinishWizard();
    } else {
      fiRenderWizardStep();
    }
  }
  window.fiSkip = fiSkip;

  function fiFinishWizard() {
    const state = window._firstImport;
    const body = document.getElementById('fiBody');
    if (!body) { closeOverlay(); return; }
    const done = state ? state.wizardCompleted : 0;
    const total = state && state.needsFee ? state.needsFee.length : 0;
    body.innerHTML = `
      <div style="text-align:center;padding:20px 10px;">
        <div style="font-size:40px;margin-bottom:10px;">&#x2705;</div>
        <div style="font-size:20px;font-weight:700;color:var(--text);margin-bottom:6px;">Nice work.</div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:20px;line-height:1.5;">
          ${done} of ${total} fee${total === 1 ? '' : 's'} saved. ${total - done > 0 ? 'You can fill the rest any time from the Gigs tab.' : 'Every imported gig has a fee. Tax time just got easier.'}
        </div>
        <button onclick="document.getElementById('firstImportOverlay').remove();" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;">See my gigs</button>
      </div>`;
    // Invalidate gigs cache so the Gigs screen reflects all the saved fees.
    if (typeof invalidateGigsCache === 'function') invalidateGigsCache();
    // Nudge Home to re-fetch so the "needs a fee" banner reflects the new count.
    try {
      window._cachedStats = null;
      window._cachedStatsTime = 0;
    } catch (_) {}
  }
  window.fiFinishWizard = fiFinishWizard;

  // ── Reusable entry point (task #291) ─────────────────────────────────────
  // Opens the quick-fire wizard from anywhere (Home banner, Gigs screen,
  // manual call) without going through the first-import flow. Fetches the
  // current pool of imported gigs missing a fee, seeds the same state shape
  // the wizard expects, and kicks off at step 1. Idempotent — multiple calls
  // just re-open the overlay with a fresh fetch.
  window.openFeeReviewWizard = async function openFeeReviewWizard() {
    const existing = ov();
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'firstImportOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;';
    overlay.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:18px;width:100%;max-width:440px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <div id="fiBody">
          <div style="text-align:center;padding:40px 20px;">
            <div style="width:44px;height:44px;border-radius:50%;border:3px solid var(--border);border-top-color:var(--accent);margin:0 auto 16px;animation:fiSpin 1s linear infinite;"></div>
            <div style="font-size:14px;color:var(--text-2);">Finding imported gigs without a fee...</div>
          </div>
        </div>
      </div>
      <style>@keyframes fiSpin{to{transform:rotate(360deg);}}</style>`;
    document.body.appendChild(overlay);

    let gigs = [];
    try {
      const r = await fetch('/api/gigs');
      const data = await r.json();
      const all = Array.isArray(data) ? data : (data.gigs || []);
      // Candidates = gcal-sourced rows with no fee recorded. Matches the
      // /api/stats counting rule so the banner and the wizard stay in sync.
      gigs = all.filter((g) => {
        const src = g.source || '';
        const fee = g.fee;
        const missing = fee == null || Number(fee) === 0;
        return src.startsWith('gcal:') && missing;
      });
    } catch (err) {
      const body = document.getElementById('fiBody');
      if (body) {
        body.innerHTML = `
          <div style="text-align:center;padding:30px 16px;">
            <div style="font-size:15px;font-weight:600;color:var(--danger);margin-bottom:6px;">Couldn&#x2019;t load gigs</div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:16px;">${escapeHtml(err.message || String(err))}</div>
            <button onclick="document.getElementById('firstImportOverlay').remove();" style="background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 20px;font-size:13px;cursor:pointer;">Close</button>
          </div>`;
      }
      return;
    }

    if (gigs.length === 0) {
      const body = document.getElementById('fiBody');
      if (body) {
        body.innerHTML = `
          <div style="text-align:center;padding:30px 16px;">
            <div style="font-size:40px;margin-bottom:10px;">&#x1F389;</div>
            <div style="font-size:17px;font-weight:700;color:var(--text);margin-bottom:6px;">All caught up</div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:18px;line-height:1.5;">Every gig imported from Google has a fee recorded.</div>
            <button onclick="document.getElementById('firstImportOverlay').remove();" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;">Nice</button>
          </div>`;
      }
      return;
    }

    // Sort oldest first so the user works chronologically — makes it easier to
    // remember fees as they go (early-year gigs usually have better recall
    // than "yeah I did one in October, I think").
    gigs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // Seed the same state shape the first-import flow uses so the wizard
    // functions work without modification. `imported` is only used by the
    // summary screen that we bypass, but we set it defensively.
    window._firstImport = {
      events: [],
      windowMode: 'fee_review',
      imported: gigs,
      needsFee: gigs,
      wizardIndex: 0,
      wizardCompleted: 0,
    };

    fiRenderWizardStep();
  };
})();

// Helper referenced by the modal in case it isn't defined elsewhere.
if (typeof invalidateGigsCache !== 'function') {
  window.invalidateGigsCache = function () {
    try { window._cachedGigs = null; } catch (_) {}
    try { window._gigsCacheTime = 0; } catch (_) {}
  };
}

// "Import all" helper on the ongoing Imports-to-review bar. Piggy-backs on
// the first-import flow: pre-seeds the events from the cached nudges array
// and routes straight to the import + quick-fire path. Returns early if
// there are no nudges to import.
window.importAllNudges = async function importAllNudges() {
  const nudges = Array.isArray(window._calendarNudges) ? window._calendarNudges : [];
  if (nudges.length === 0) {
    if (typeof toast === 'function') toast('No imports to review');
    return;
  }
  // Open the same overlay the first-import modal uses, but skip the fetch
  // step by seeding _firstImport directly with the already-scored nudges.
  const overlay = document.createElement('div');
  overlay.id = 'firstImportOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;';
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:18px;width:100%;max-width:440px;padding:24px;">
      <div id="fiBody">
        <div style="text-align:center;padding:30px 16px;">
          <div style="font-size:24px;font-weight:700;color:var(--text);margin-bottom:6px;">Import all ${nudges.length}?</div>
          <div style="font-size:13px;color:var(--text-2);margin-bottom:18px;line-height:1.5;">Pulls the full batch into TrackMyGigs. Your Google Calendar isn't touched. You can fill in fees right after.</div>
          <button onclick="fiStartImport()" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:14px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px;">Import ${nudges.length} now</button>
          <button onclick="document.getElementById('firstImportOverlay').remove();" style="width:100%;background:transparent;color:var(--text-2);border:1px solid var(--border);border-radius:14px;padding:12px;font-size:13px;cursor:pointer;">Cancel</button>
        </div>
      </div>
    </div>
    <style>@keyframes fiSpin{to{transform:rotate(360deg);}}</style>`;
  document.body.appendChild(overlay);
  // Seed the same state the first-import modal uses so fiStartImport works.
  window._firstImport = { events: nudges, windowMode: 'future' };
};

// ── Premium checkout + billing portal wiring (task #282) ────────────────────
// startPremiumCheckout(plan) posts to /api/stripe/create-checkout-session and
// redirects the tab to the returned Stripe URL. openBillingPortal() does the
// same for existing subscribers, routing them to Stripe's hosted portal to
// manage card, plan, or cancellation. Both are idempotent and surface errors
// via toast rather than silent failure, which was the previous inert state.
window.startPremiumCheckout = async function startPremiumCheckout(plan) {
  const chosen = plan === 'annual' ? 'annual' : 'monthly';
  if (typeof toast === 'function') toast('Opening Stripe checkout...');
  try {
    const res = await fetch('/api/stripe/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: chosen }),
    });
    if (res.status === 401 || res.status === 403) {
      // Shouldn't happen from in-app (we only call this when authed), but
      // fall back to login anyway so we never leave the user stuck.
      window.location.href = '/login?next=' + encodeURIComponent('/app?intent=premium&plan=' + chosen);
      return;
    }
    if (res.status === 503) {
      if (typeof toast === 'function') toast('Premium signup is not live yet. Try again soon.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.url) {
      window.location.href = data.url;
      return;
    }
    if (typeof toast === 'function') toast((data && data.error) || 'Could not start checkout.');
  } catch (err) {
    console.error('[premium] checkout error:', err);
    if (typeof toast === 'function') toast('Network hiccup. Try again.');
  }
};

window.openBillingPortal = async function openBillingPortal() {
  if (typeof toast === 'function') toast('Opening billing portal...');
  try {
    const res = await fetch('/api/stripe/billing-portal', { method: 'POST' });
    if (res.status === 503) {
      if (typeof toast === 'function') toast('Billing portal is not live yet.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.url) {
      window.location.href = data.url;
      return;
    }
    if (data && data.error === 'no_subscription') {
      if (typeof toast === 'function') toast('Subscribe first to access the billing portal.');
      return;
    }
    if (typeof toast === 'function') toast((data && data.error) || 'Could not open portal.');
  } catch (err) {
    console.error('[premium] billing portal error:', err);
    if (typeof toast === 'function') toast('Network hiccup. Try again.');
  }
};

// Small plan-picker modal for free users tapping "Go premium" from Profile.
// Intentionally tiny — two big pills (Monthly / Annual save £50), copy
// matching the landing page so nothing changes semantically when the user
// crosses over from marketing to in-app.
window.openPremiumPicker = function openPremiumPicker() {
  const existing = document.getElementById('premiumPickerOverlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'premiumPickerOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:18px;width:100%;max-width:380px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.5);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div style="font-size:17px;font-weight:700;color:var(--text);">Go premium</div>
        <button onclick="document.getElementById('premiumPickerOverlay').remove();" aria-label="Close" style="background:transparent;border:none;color:var(--text-3);font-size:22px;cursor:pointer;line-height:1;padding:0 4px;">&times;</button>
      </div>
      <div style="font-size:12px;color:var(--text-2);margin-bottom:14px;line-height:1.5;">14-day free trial on both plans. Cancel any time before day 14 and you will not be charged.</div>
      <button onclick="document.getElementById('premiumPickerOverlay').remove(); window.startPremiumCheckout('monthly');" style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;font-size:14px;font-weight:600;color:var(--text);cursor:pointer;margin-bottom:8px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span><span style="font-weight:700;">Monthly</span><br><span style="font-size:11px;color:var(--text-2);font-weight:400;">&pound;14.99 per month</span></span>
        <span style="color:var(--accent);">&rsaquo;</span>
      </button>
      <button onclick="document.getElementById('premiumPickerOverlay').remove(); window.startPremiumCheckout('annual');" style="width:100%;background:var(--accent);color:#000;border:none;border-radius:14px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span><span>Annual <span style="background:#000;color:var(--accent);font-size:9px;font-weight:700;padding:2px 6px;border-radius:999px;margin-left:4px;letter-spacing:0.4px;">SAVE &pound;50</span></span><br><span style="font-size:11px;color:#000;opacity:.75;font-weight:500;">&pound;129 per year</span></span>
        <span>&rsaquo;</span>
      </button>
    </div>`;
  document.body.appendChild(overlay);
};
