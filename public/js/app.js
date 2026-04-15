let currentUser = null;
let currentScreen = 'home';
let mockOffers = 4;
let mockOverdueInvoices = 1;
let mockDraftInvoices = 2;

// Wizard state
let gigWizardStep = 1;
let gigWizardData = {};
window._cachedGigs = null;

const mockGigs = [
  {
    id: '1',
    band_name: 'The Jazz Collective',
    venue_name: 'The Blue Note',
    date: '2026-04-20',
    start_time: '20:00',
    end_time: '23:00',
    fee: 150,
    status: 'confirmed',
  },
  {
    id: '2',
    band_name: 'Electric Dreams',
    venue_name: 'Riverside Pavilion',
    date: '2026-04-25',
    start_time: '18:30',
    end_time: '22:00',
    fee: 200,
    status: 'confirmed',
  },
  {
    id: '3',
    band_name: 'The Rhythm Kings',
    venue_name: 'Downtown Hall',
    date: '2026-05-02',
    start_time: '19:00',
    end_time: '23:30',
    fee: 180,
    status: 'tentative',
  },
];

const monthlyEarnings = [
  120, 180, 140, 200, 160, 220, 190, 170, 210, 150, 240, 200,
];

function initApp(user) {
  currentUser = user;
  window._currentUser = user;
  setupThemeToggle();
  setupNavigation();
  setupScreenHandlers();
  renderHomeScreen();
  showScreen('home');

  // Pre-fetch gigs in background so they're instant when the user taps the tab
  prefetchGigs();
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

function renderHomeScreen() {
  const content = document.getElementById('homeScreen');
  const nextGig = mockGigs[0];

  content.innerHTML = `
    <div class="section">
      <div class="banner warning">
        <div>
          <div style="font-weight: 600;">4 gig offers waiting</div>
          <div class="banner-badge">2 FROM YOUR NETWORK</div>
        </div>
        <div style="font-size: 1.5rem;">📬</div>
      </div>
    </div>

    <div class="section">
      <div class="card success" style="border-left: 4px solid var(--success);">
        <div class="card-header">
          <div>
            <div class="card-title">Next Gig</div>
          </div>
        </div>
        <div class="gig-date">${formatDate(nextGig.date)}</div>
        <div class="gig-venue">${nextGig.band_name}</div>
        <div class="gig-meta">
          <div class="gig-meta-item">📍 ${nextGig.venue_name}</div>
          <div class="gig-meta-item">🎵 ${nextGig.start_time}</div>
        </div>
        <div class="gig-bottom">
          <div>Confirmed</div>
          <div class="gig-fee">£${nextGig.fee}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="banner" style="border-left: 4px solid var(--info);">
        <div>
          <div style="font-weight: 600;">Active dep request</div>
          <div style="font-size: var(--font-size-sm); color: var(--text-2); margin-top: var(--spacing-2);">Looking for a drummer for The Jazz Collective - Tomorrow</div>
        </div>
        <div style="font-size: 1.5rem;">👥</div>
      </div>
    </div>

    <div class="section">
      <div class="grid grid-3">
        <div class="mini-card">
          <div class="mini-card-value" style="color: var(--danger);">${mockOverdueInvoices}</div>
          <div class="mini-card-label">Overdue</div>
        </div>
        <div class="mini-card">
          <div class="mini-card-value" style="color: var(--warning);">${mockDraftInvoices}</div>
          <div class="mini-card-label">Drafts</div>
        </div>
        <div class="mini-card">
          <div class="mini-card-value" style="color: var(--info);">2</div>
          <div class="mini-card-label">Reminders</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Monthly Earnings</div>
      <div class="chart-container">
        ${monthlyEarnings
          .map(
            (value) =>
              `<div class="chart-bar" style="height: ${(value / 250) * 100}%;" title="£${value}"></div>`
          )
          .join('')}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Recent Gigs</div>
      ${mockGigs
        .slice(0, 3)
        .map(
          (gig) => `
        <div class="gig-card ${gig.status === 'confirmed' ? 'upcoming' : ''}">
          <div class="gig-date">${formatDate(gig.date)}</div>
          <div class="gig-venue">${gig.band_name}</div>
          <div class="gig-meta">
            <div class="gig-meta-item">📍 ${gig.venue_name}</div>
            <div class="gig-meta-item">🎵 ${gig.start_time}</div>
          </div>
          <div class="gig-bottom">
            <span class="badge badge-success">${gig.status}</span>
            <div class="gig-fee">£${gig.fee}</div>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

async function renderGigsScreen() {
  const content = document.getElementById('gigsScreen');

  // If we already have cached gigs, render them instantly (no loading spinner)
  const cached = window._cachedGigs;

  content.innerHTML = `
    <div class="section">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing-4);">
        <div class="section-title" style="margin-bottom: 0;">Your Gigs</div>
        <button class="button button-primary button-small" onclick="openGigWizard()">+ Add</button>
      </div>
      <div id="gigsListContent">
        ${cached ? '' : '<div style="text-align: center; padding: var(--spacing-8); color: var(--text-2);">Loading...</div>'}
      </div>
    </div>
  `;

  // Show cached data immediately while we fetch fresh data in the background
  if (cached) {
    renderGigsList(cached);
  }

  try {
    const response = await fetch('/api/gigs');
    if (!response.ok) throw new Error('Failed to fetch');
    const gigs = await response.json();

    window._cachedGigs = gigs;
    renderGigsList(gigs);
  } catch (err) {
    console.error('Load gigs error:', err);
    // Only show error if we didn't already render from cache
    if (!cached) {
      const listContent = document.getElementById('gigsListContent');
      if (listContent) {
        listContent.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📋</div>
            <div class="empty-state-title">Couldn't load gigs</div>
            <div class="empty-state-text">Check your connection and try again</div>
          </div>
        `;
      }
    }
  }
}

function renderGigsList(gigs) {
  const listContent = document.getElementById('gigsListContent');
  if (!listContent) return;

  if (gigs.length === 0) {
    listContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎸</div>
        <div class="empty-state-title">No gigs yet</div>
        <div class="empty-state-text">Tap + Add to log your first gig</div>
      </div>
    `;
    return;
  }

  listContent.innerHTML = gigs
    .map(
      (gig) => `
    <div class="gig-card ${gig.status === 'confirmed' ? 'upcoming' : gig.status === 'cancelled' ? 'cancelled' : ''}">
      <div class="gig-date">${formatDate(gig.date)}</div>
      <div class="gig-venue">${escapeHtml(gig.band_name || 'Unnamed Gig')}</div>
      <div class="gig-meta">
        <div class="gig-meta-item">${escapeHtml(gig.venue_name || 'No venue')}</div>
        ${gig.start_time ? `<div class="gig-meta-item">${formatTime(gig.start_time)}${gig.end_time ? ' - ' + formatTime(gig.end_time) : ''}</div>` : ''}
      </div>
      <div class="gig-bottom">
        <span class="badge badge-${statusBadgeClass(gig.status)}">${statusLabel(gig.status)}</span>
        ${gig.fee ? `<div class="gig-fee">£${parseFloat(gig.fee).toFixed(0)}</div>` : ''}
      </div>
    </div>
  `
    )
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

function renderCalendarScreen() {
  const content = document.getElementById('calendarScreen');

  const today = new Date(2026, 3, 15);
  const daysInMonth = 30;
  const firstDay = new Date(2026, 3, 1).getDay();

  let calendarHTML = `
    <div class="section">
      <div class="section-title">April 2026</div>
      <div class="card">
        <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; padding: var(--spacing-4);">
  `;

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  dayLabels.forEach((day) => {
    calendarHTML += `<div style="text-align: center; font-weight: 600; padding: 8px; font-size: var(--font-size-sm); color: var(--text-2);">${day}</div>`;
  });

  for (let i = 0; i < firstDay; i++) {
    calendarHTML += `<div></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === 15;
    const hasGig = mockGigs.some((g) => parseInt(g.date.split('-')[2]) === day);

    calendarHTML += `
      <div style="
        padding: 8px;
        border-radius: 4px;
        text-align: center;
        background-color: ${isToday ? 'var(--accent)' : 'transparent'};
        color: ${isToday ? 'var(--bg)' : 'var(--text)'};
        border: ${hasGig ? '2px solid var(--success)' : 'none'};
        font-weight: ${isToday ? '600' : '400'};
      ">
        ${day}
      </div>
    `;
  }

  calendarHTML += `
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Gigs This Month</div>
      ${mockGigs
        .map(
          (gig) => `
        <div class="gig-card">
          <div class="gig-date">${formatDate(gig.date)}</div>
          <div class="gig-venue">${gig.band_name} at ${gig.venue_name}</div>
          <div class="gig-meta">
            <div class="gig-meta-item">🎵 ${gig.start_time}</div>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  content.innerHTML = calendarHTML;
}

function renderInvoicesScreen() {
  const content = document.getElementById('invoicesScreen');

  const mockInvoices = [
    {
      id: '1',
      band_name: 'The Jazz Collective',
      amount: 150,
      status: 'paid',
      due_date: '2026-04-10',
    },
    {
      id: '2',
      band_name: 'Electric Dreams',
      amount: 200,
      status: 'overdue',
      due_date: '2026-04-01',
    },
    {
      id: '3',
      band_name: 'The Rhythm Kings',
      amount: 180,
      status: 'draft',
      due_date: null,
    },
  ];

  content.innerHTML = `
    <div class="section">
      <div class="grid grid-3">
        <div class="mini-card">
          <div class="mini-card-value" style="color: var(--success);">£1,450</div>
          <div class="mini-card-label">Total Paid</div>
        </div>
        <div class="mini-card">
          <div class="mini-card-value" style="color: var(--danger);">£200</div>
          <div class="mini-card-label">Overdue</div>
        </div>
        <div class="mini-card">
          <div class="mini-card-value" style="color: var(--warning);">£360</div>
          <div class="mini-card-label">Pending</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Recent Invoices</div>
      ${mockInvoices
        .map(
          (inv) => `
        <div class="card">
          <div class="list-item-header">
            <div>
              <div class="list-item-title">${inv.band_name}</div>
              <div class="list-item-meta">Invoice #${inv.id}</div>
            </div>
            <div style="text-align: right;">
              <div style="font-weight: 600;">£${inv.amount}</div>
              <span class="badge ${
                inv.status === 'paid'
                  ? 'badge-success'
                  : inv.status === 'overdue'
                    ? 'badge-danger'
                    : 'badge-warning'
              }">${inv.status}</span>
            </div>
          </div>
          ${inv.due_date ? `<div class="list-item-meta">Due: ${formatDate(inv.due_date)}</div>` : ''}
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

function renderOffersScreen() {
  const content = document.getElementById('offersScreen');

  const mockOffersData = [
    {
      id: '1',
      sender: 'The Jazz Collective',
      type: 'dep_request',
      gig: 'Drummer needed',
      date: '2026-04-16',
      fee: 120,
      status: 'pending',
    },
    {
      id: '2',
      sender: 'Electric Dreams',
      type: 'lineup_callout',
      gig: 'Guitarist wanted',
      date: '2026-04-20',
      fee: 150,
      status: 'pending',
    },
    {
      id: '3',
      sender: 'The Rhythm Kings',
      type: 'marketplace',
      gig: 'Bassist needed',
      date: '2026-04-25',
      fee: 180,
      status: 'pending',
    },
    {
      id: '4',
      sender: 'Soul Sessions',
      type: 'marketplace',
      gig: 'Keyboard player',
      date: '2026-05-01',
      fee: 160,
      status: 'pending',
    },
  ];

  content.innerHTML = `
    <div class="section">
      <div class="section-title">Gig Offers (${mockOffersData.length})</div>
      ${mockOffersData
        .map(
          (offer) => `
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">${offer.sender}</div>
              <div class="card-subtitle">${offer.gig}</div>
            </div>
            <span class="badge badge-accent">${offer.type.replace('_', ' ')}</span>
          </div>
          <div class="gig-meta" style="margin: var(--spacing-3) 0;">
            <div class="gig-meta-item">📅 ${formatDate(offer.date)}</div>
            <div class="gig-meta-item">💷 £${offer.fee}</div>
          </div>
          <div style="display: flex; gap: var(--spacing-2);">
            <button class="button button-primary button-small" onclick="updateOfferStatus('${offer.id}', 'accepted')">Accept</button>
            <button class="button button-secondary button-small" onclick="updateOfferStatus('${offer.id}', 'declined')">Decline</button>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

function renderProfileScreen() {
  const content = document.getElementById('profileScreen');

  const userInitial = (currentUser.name || currentUser.email || 'G')[0].toUpperCase();

  content.innerHTML = `
    <div class="section">
      <div style="text-align: center; padding: var(--spacing-8); background-color: var(--card); border-radius: var(--radius-lg); border: 1px solid var(--border);">
        <div style="width: 80px; height: 80px; margin: 0 auto var(--spacing-4); border-radius: 50%; background-color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 2rem; color: var(--bg); font-weight: bold;">
          ${userInitial}
        </div>
        <div style="font-size: var(--font-size-lg); font-weight: 600; margin-bottom: var(--spacing-2);">${currentUser.name || 'Guest'}</div>
        <div style="color: var(--text-2); margin-bottom: var(--spacing-4);">${currentUser.email}</div>
        <button class="button button-secondary button-block" onclick="logout()">Sign Out</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Settings</div>
      <div class="card">
        <div class="list-item">
          <div class="list-item-title">Notifications</div>
        </div>
        <div class="list-item">
          <div class="list-item-title">Calendar Sync</div>
        </div>
        <div class="list-item">
          <div class="list-item-title">Billing</div>
        </div>
        <div class="list-item">
          <div class="list-item-title">Help & Support</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">App Info</div>
      <div class="card">
        <div class="list-item">
          <div class="list-item-title">Version</div>
          <div class="list-item-meta">0.2.0</div>
        </div>
        <div class="list-item">
          <div class="list-item-title">Last Updated</div>
          <div class="list-item-meta">April 2026</div>
        </div>
      </div>
    </div>
  `;
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
      <div class="wizard-header">
        <button class="wizard-back-btn" id="wizardBackBtn" onclick="wizardBack()">&#8249; Back</button>
        <div class="wizard-title">New Gig</div>
        <div class="wizard-step-counter" id="wizardStepCounter" onclick="renderFullGigForm()" style="cursor:pointer;color:var(--text-3);font-size:12px;">Show full form</div>
      </div>
      <div class="wizard-progress" id="wizardProgress">
        <div class="wizard-dot active" id="wizardDot1"></div>
        <div class="wizard-dot" id="wizardDot2"></div>
        <div class="wizard-dot" id="wizardDot3"></div>
        <div class="wizard-dot" id="wizardDot4"></div>
        <div class="wizard-dot" id="wizardDot5"></div>
      </div>
      <div id="wizardBody"></div>
    </div>
  `;

  renderWizardStep(gigWizardStep);
}

function renderWizardStep(step) {
  const body = document.getElementById('wizardBody');
  const backBtn = document.getElementById('wizardBackBtn');
  const counter = document.getElementById('wizardStepCounter');

  if (!body) return;

  // Update progress dots
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById(`wizardDot${i}`);
    if (!dot) continue;
    dot.className = 'wizard-dot';
    if (i < step) dot.classList.add('done');
    else if (i === step) dot.classList.add('active');
  }

  if (backBtn) backBtn.style.visibility = step === 1 ? 'hidden' : 'visible';

  let stepHTML = '';

  if (step === 1) {
    const recentBands = getRecentBands();
    stepHTML = `
      <div style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Step 1 of 5</div>
      <div class="wizard-step-question">Who's the gig with?</div>
      <div class="wizard-step-hint">Band name, client, or your own booking</div>
      <div class="form-group">
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
      ${
        recentBands.length > 0
          ? `
        <div style="margin-top: var(--spacing-2);">
          <div style="font-size: var(--font-size-sm); color: var(--text-2); margin-bottom: var(--spacing-2);">Recent</div>
          <div class="chip-group">
            ${recentBands
              .map(
                (b) =>
                  `<button class="chip" onclick="selectBand(this)">${escapeHtml(b)}</button>`
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }
    `;
  } else if (step === 2) {
    stepHTML = `
      <div style="font-size:11px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Step 2 of 5</div>
      <div class="wizard-step-question">Where's the gig?</div>
      <div class="wizard-step-hint">Search for the venue - we'll grab the full address for directions & mileage</div>
      <div class="form-group">
        <input
          type="text"
          class="form-input"
          id="wVenueName"
          placeholder="Search venues..."
          value="${escapeHtml(gigWizardData.venue_name)}"
          autocomplete="off"
        >
        <div class="wizard-error" id="wVenueError">Please enter the venue name</div>
      </div>
      <div class="form-group" style="display:none;">
        <input
          type="text"
          class="form-input"
          id="wVenueAddress"
          placeholder=""
          value="${escapeHtml(gigWizardData.venue_address)}"
        >
      </div>
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
        <div class="chip-group">
          <button
            class="chip chip-confirmed ${gigWizardData.status === 'confirmed' ? 'selected' : ''}"
            onclick="selectGigStatus('confirmed')"
          >Confirmed</button>
          <button
            class="chip chip-pencilled ${gigWizardData.status === 'tentative' ? 'selected' : ''}"
            onclick="selectGigStatus('tentative')"
          >Pencilled</button>
          <button
            class="chip chip-enquiry ${gigWizardData.status === 'enquiry' ? 'selected' : ''}"
            onclick="selectGigStatus('enquiry')"
          >Enquiry</button>
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
  document
    .querySelectorAll('.chip-confirmed, .chip-pencilled, .chip-enquiry')
    .forEach((c) => c.classList.remove('selected'));
  const map = {
    confirmed: 'chip-confirmed',
    tentative: 'chip-pencilled',
    enquiry: 'chip-enquiry',
  };
  document.querySelector(`.${map[status]}`)?.classList.add('selected');
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

function filterBandSuggestions(query) {
  const container = document.getElementById('bandSuggestions');
  if (!container) return;
  const recentBands = getRecentBands();
  if (!query || recentBands.length === 0) {
    container.style.display = 'none';
    return;
  }
  const filtered = recentBands.filter((b) =>
    b.toLowerCase().includes(query.toLowerCase())
  );
  if (filtered.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.innerHTML = filtered
    .map(
      (b) =>
        `<div class="suggestion-item" onmousedown="selectBandFromSuggestion('${escapeAttr(b)}')">${escapeHtml(b)}</div>`
    )
    .join('');
  container.style.display = 'block';
}

function selectBandFromSuggestion(name) {
  gigWizardData.band_name = name;
  const input = document.getElementById('wBandName');
  if (input) input.value = name;
  hideSuggestions('bandSuggestions');
}

function hideSuggestions(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
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

  content.innerHTML = `
    <div class="section">
      <div style="display: flex; align-items: center; gap: var(--spacing-3); margin-bottom: var(--spacing-4);">
        <button style="background:none;border:none;color:var(--text);font-size:var(--font-size-xl);cursor:pointer;" onclick="openGigWizard()">←</button>
        <div class="section-title" style="margin-bottom:0;">Add a Gig</div>
      </div>
      <form id="createGigForm" class="card">
        <div class="form-group">
          <label class="form-label">Band Name *</label>
          <input type="text" class="form-input" name="band_name" required>
        </div>
        <div class="form-group">
          <label class="form-label">Venue Name *</label>
          <input type="text" class="form-input" name="venue_name" required>
        </div>
        <div class="form-group">
          <label class="form-label">Venue Address</label>
          <input type="text" class="form-input" name="venue_address">
        </div>
        <div class="form-group">
          <label class="form-label">Date *</label>
          <input type="date" class="form-input" name="date" required>
        </div>
        <div class="form-group">
          <label class="form-label">Start Time</label>
          <input type="time" class="form-input" name="start_time">
        </div>
        <div class="form-group">
          <label class="form-label">End Time</label>
          <input type="time" class="form-input" name="end_time">
        </div>
        <div class="form-group">
          <label class="form-label">Load-in Time</label>
          <input type="time" class="form-input" name="load_in_time">
        </div>
        <div class="form-group">
          <label class="form-label">Fee (£)</label>
          <input type="number" class="form-input" name="fee" step="1" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-input" name="status">
            <option value="confirmed">Confirmed</option>
            <option value="tentative">Pencilled</option>
            <option value="enquiry">Enquiry</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Dress Code</label>
          <input type="text" class="form-input" name="dress_code" placeholder="e.g. Smart Casual, Black Tie">
        </div>
        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea class="form-textarea" name="notes" placeholder="Any additional details..."></textarea>
        </div>
        <div id="fullFormError" class="alert alert-error" style="display:none;margin-bottom:var(--spacing-4);"></div>
        <button type="submit" class="button button-primary button-block">Add Gig</button>
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
        submitBtn.textContent = 'Add Gig';
        submitBtn.disabled = false;
      }
    } catch (error) {
      console.error('Create gig error:', error);
      submitBtn.textContent = 'Add Gig';
      submitBtn.disabled = false;
    }
  });
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
}

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
}

// Make closePanel accessible from inline HTML onclick
window.closePanel = closePanel;

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
  const date = new Date(dateString + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]}`;
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
