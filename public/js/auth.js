const authForm = document.getElementById('authForm');
const emailInput = document.getElementById('emailInput');
const authError = document.getElementById('authError');
const authSuccess = document.getElementById('authSuccess');

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
      headers: {
        'Content-Type': 'application/json',
      },
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

    await requestMagicLink(email);

    authSuccess.textContent = `Magic link sent to ${email}. Check your email to sign in.`;
    authSuccess.style.display = 'block';
    emailInput.value = '';
  } catch (error) {
    showError(error.message || 'Failed to send magic link. Please try again.');
  }
});

function showError(message) {
  authError.textContent = message;
  authError.style.display = 'block';
}

async function initAuth() {
  const user = await checkAuth();

  if (user) {
    showApp(user);
  } else {
    showAuthScreen();
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
    await fetch('/auth/logout', {
      method: 'POST',
    });
    location.reload();
  } catch (error) {
    console.error('Logout error:', error);
  }
}

initAuth();
