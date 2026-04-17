const authForm = document.getElementById('authForm');
const emailInput = document.getElementById('emailInput');
const authError = document.getElementById('authError');
const authSuccess = document.getElementById('authSuccess');

// Google Sign-In callback
async function handleGoogleSignIn(response) {
  try {
    authError.style.display = 'none';
    authSuccess.style.display = 'none';

    const res = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Google sign-in failed');
    }

    // Reload to enter the app
    location.reload();
  } catch (error) {
    showError(error.message || 'Google sign-in failed. Please try again.');
  }
}

// Make it globally accessible for Google callback
window.handleGoogleSignIn = handleGoogleSignIn;

async function checkAuth() {
  try {
    const response = await fetch('/auth/me');
    const data = await response.json();
    return data.user;
  } catch (error) {
    console.error('Auth check error:', error);
    return null;
  }
}

async function requestMagicLink(email) {
  try {
    const response = await fetch('/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to send magic link');
    }

    return data;
  } catch (error) {
    console.error('Magic link request error:', error);
    throw error;
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = emailInput.value.trim();

  if (!email) {
    showError('Please enter your email');
    return;
  }

  try {
    authError.style.display = 'none';
    authSuccess.style.display = 'none';

    const submitBtn = authForm.querySelector('button[type="submit"]');
    submitBtn.textContent = 'Sending...';
    submitBtn.disabled = true;

    await requestMagicLink(email);

    authSuccess.textContent = 'Check your email for the sign-in link.';
    authSuccess.style.display = 'block';
    emailInput.value = '';

    submitBtn.textContent = 'Send Magic Link';
    submitBtn.disabled = false;
  } catch (error) {
    const submitBtn = authForm.querySelector('button[type="submit"]');
    submitBtn.textContent = 'Send Magic Link';
    submitBtn.disabled = false;
    showError(error.message || 'Failed to send magic link. Please try again.');
  }
});

function showError(message) {
  authError.textContent = message;
  authError.style.display = 'block';
}

function initGoogleSignIn() {
  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.initialize({
      client_id: window.GOOGLE_CLIENT_ID,
      callback: handleGoogleSignIn,
    });

    google.accounts.id.renderButton(
      document.getElementById('googleSignIn'),
      {
        theme: 'filled_black',
        size: 'large',
        width: 320,
        text: 'signin_with',
        shape: 'rectangular',
        logo_alignment: 'left',
      }
    );
  } else {
    // Retry if Google script hasn't loaded yet
    setTimeout(initGoogleSignIn, 200);
  }
}

async function initAuth() {
  const user = await checkAuth();

  if (user) {
    showApp(user);
  } else {
    showAuthScreen();
    initGoogleSignIn();
  }
}

function showAuthScreen() {
  document.getElementById('authScreen').classList.add('active');
  document.getElementById('appScreen').classList.remove('active');
}

function showApp(user) {
  document.getElementById('authScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');
  initApp(user);
}

async function logout() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
    // S11-07: Clear all per-user caches before reload so if another user
    // signs in before the page fully rebuilds, we never render stale data
    // belonging to the logged-out user.
    window._cachedStats = null;
    window._cachedStatsTime = 0;
    window._cachedStatsUser = null;
    window._cachedGigs = null;
    window._cachedGigsTime = 0;
    window._cachedInvoices = null;
    window._cachedInvoicesTime = 0;
    window._cachedOffers = null;
    window._cachedOffersTime = 0;
    window._cachedProfile = null;
    window._cachedProfileTime = 0;
    window._cachedBlocked = null;
    window._cachedBlockedTime = 0;
    window._invoicesFullList = null;
    window._invoicesInitialFilter = null;
    // BUG-AUDIT-02: clear per-user localStorage keys on logout so the next
    // user signing in on this browser doesn't inherit them. The onboarded
    // flag is the critical one (a stale "1" suppresses the tour for a
    // genuine new user). Also clear snoozes, dismissed notifications, and
    // calendar layer prefs for the same reason.
    try {
      localStorage.removeItem('tmg_onboarded');
      localStorage.removeItem('snoozedOffers');
      localStorage.removeItem('globalSnoozeUntil');
      localStorage.removeItem('globalSnoozedAt');
      localStorage.removeItem('lastSnoozeEndedAt');
      localStorage.removeItem('showWhileAway');
      localStorage.removeItem('dismissedNotifications');
      localStorage.removeItem('calendarLayers');
    } catch (_) { /* storage may be unavailable, not fatal */ }
    location.reload();
  } catch (error) {
    console.error('Logout error:', error);
  }
}

initAuth();
