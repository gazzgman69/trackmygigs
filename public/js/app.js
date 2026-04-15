let currentUser = null;
let currentScreen = 'home';
let mockOffers = 4;
let mockOverdueInvoices = 1;
let mockDraftInvoices = 2;

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
  setupThemeToggle();
  setupNavigation();
  setupScreenHandlers();
  renderHomeScreen();
  showScreen('home');
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
  setupCreateGigScreen();
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

  const greeting = getGreeting();

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

function renderGigsScreen() {
  const content = document.getElementById('gigsScreen');

  content.innerHTML = `
    <div class="section">
      <div class="section-title">Your Gigs</div>
      ${mockGigs
        .map(
          (gig) => `
        <div class="gig-card ${gig.status === 'confirmed' ? 'upcoming' : ''}">
          <div class="gig-date">${formatDate(gig.date)}</div>
          <div class="gig-venue">${gig.band_name}</div>
          <div class="gig-meta">
            <div class="gig-meta-item">📍 ${gig.venue_name}</div>
            <div class="gig-meta-item">🎵 ${gig.start_time} - ${gig.end_time}</div>
          </div>
          <div class="gig-bottom">
            <span class="badge badge-${gig.status === 'confirmed' ? 'success' : 'info'}">${gig.status}</span>
            <div class="gig-fee">£${gig.fee}</div>
          </div>
        </div>
      `
        )
        .join('')}
    </div>
  `;
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

  const userInitial = (currentUser.name || 'G')[0].toUpperCase();

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
          <div class="list-item-meta">0.1.0</div>
        </div>
        <div class="list-item">
          <div class="list-item-title">Last Updated</div>
          <div class="list-item-meta">April 2026</div>
        </div>
      </div>
    </div>
  `;
}

function renderCreateGigScreen() {
  const content = document.getElementById('createGigScreen');

  content.innerHTML = `
    <div class="section">
      <div class="section-title">Add a Gig</div>
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
          <input type="number" class="form-input" name="fee" step="0.01" min="0">
        </div>

        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" name="status">
            <option value="confirmed">Confirmed</option>
            <option value="tentative">Tentative</option>
            <option value="depped_out">Depped Out</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Dress Code</label>
          <input type="text" class="form-input" name="dress_code" placeholder="e.g., Smart Casual, Black Tie">
        </div>

        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea class="form-textarea" name="notes" placeholder="Any additional details..."></textarea>
        </div>

        <button type="submit" class="button button-primary button-block">Add Gig</button>
      </form>
    </div>
  `;

  document.getElementById('createGigForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);

    try {
      const response = await fetch('/api/gigs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (response.ok) {
        showScreen('gigs');
      }
    } catch (error) {
      console.error('Create gig error:', error);
    }
  });
}

function setupGigsScreen() {
  document.getElementById('gigsScreen');
}

function setupInvoicesScreen() {
  document.getElementById('invoicesScreen');
}

function setupOffersScreen() {
  document.getElementById('offersScreen');
}

function setupCreateGigScreen() {
  document.getElementById('createGigScreen');
}

function handleQuickAction(action) {
  if (action === 'add-gig') {
    renderCreateGigScreen();
    showScreen('createGig');
  } else if (action === 'invoice') {
    showScreen('invoices');
  } else if (action === 'block-date') {
    showScreen('calendar');
  } else if (action === 'send-dep') {
    showScreen('offers');
  } else if (action === 'receipt') {
    alert('Receipt upload feature coming soon!');
  }
}

function updateOfferStatus(offerId, status) {
  console.log(`Updated offer ${offerId} to ${status}`);
  alert(`Offer ${status}! We'll update your calendar.`);
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
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const day = days[date.getDay()];
  const date_num = date.getDate();
  const month = months[date.getMonth()];
  return `${day}, ${date_num} ${month}`;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.log('ServiceWorker registration failed: ', err);
  });
}
