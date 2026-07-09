// Renders the account widget in the site header and wires up the
// sign-in/sign-up forms. Pure UI glue on top of auth.js.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Renders a player's name as a link to their profile when we know their
// account id (a real, non-deleted account), or as plain text otherwise
// (guests, bots, or accounts that have since been deleted).
function playerLink(id, name) {
  if (!id) return escapeHtml(name);
  return `<a href="profile.html?user=${encodeURIComponent(id)}">${escapeHtml(name)}</a>`;
}

function renderAuthWidget() {
  const el = document.getElementById('authWidget');
  const user = Auth.getUser();
  const profile = Auth.getProfile();

  if (user) {
    el.innerHTML = `
      <a href="profile.html" class="auth-username">${escapeHtml(profile ? profile.username : user.email)}</a>
      ${profile ? `<span class="auth-elo">ELO ${profile.elo_rating}</span>` : ''}
      <button id="signOutBtn">Log out</button>
    `;
    document.getElementById('signOutBtn').addEventListener('click', () => Auth.signOut());
    return;
  }

  el.innerHTML = `
    <button id="authToggleBtn">Sign In / Sign Up</button>
    <div id="authPanel" class="auth-panel hidden">
      <div class="auth-tabs">
        <button type="button" id="tabSignIn" class="auth-tab active">Sign In</button>
        <button type="button" id="tabSignUp" class="auth-tab">Sign Up</button>
      </div>
      <form id="signInForm" class="auth-form">
        <input type="email" id="siEmail" placeholder="Email" required>
        <input type="password" id="siPassword" placeholder="Password" required>
        <button type="submit">Sign In</button>
        <div class="auth-error" id="siError"></div>
      </form>
      <form id="signUpForm" class="auth-form hidden">
        <input type="text" id="suUsername" placeholder="Username" required minlength="3" maxlength="20">
        <input type="email" id="suEmail" placeholder="Email" required>
        <input type="password" id="suPassword" placeholder="Password (min 6 chars)" required minlength="6">
        <button type="submit">Sign Up</button>
        <div class="auth-error" id="suError"></div>
      </form>
    </div>
  `;
  wireLoggedOutHandlers();
}

function wireLoggedOutHandlers() {
  const toggleBtn = document.getElementById('authToggleBtn');
  const panel = document.getElementById('authPanel');
  toggleBtn.addEventListener('click', () => panel.classList.toggle('hidden'));

  const tabSignIn = document.getElementById('tabSignIn');
  const tabSignUp = document.getElementById('tabSignUp');
  const signInForm = document.getElementById('signInForm');
  const signUpForm = document.getElementById('signUpForm');

  tabSignIn.addEventListener('click', () => {
    tabSignIn.classList.add('active');
    tabSignUp.classList.remove('active');
    signInForm.classList.remove('hidden');
    signUpForm.classList.add('hidden');
  });
  tabSignUp.addEventListener('click', () => {
    tabSignUp.classList.add('active');
    tabSignIn.classList.remove('active');
    signUpForm.classList.remove('hidden');
    signInForm.classList.add('hidden');
  });

  signInForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('siEmail').value.trim();
    const password = document.getElementById('siPassword').value;
    const errEl = document.getElementById('siError');
    errEl.style.color = '';
    errEl.textContent = 'Signing in...';
    const { error } = await Auth.signIn(email, password);
    errEl.textContent = error ? error.message : '';
  });

  signUpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('suUsername').value.trim();
    const email = document.getElementById('suEmail').value.trim();
    const password = document.getElementById('suPassword').value;
    const errEl = document.getElementById('suError');
    errEl.style.color = '';
    errEl.textContent = 'Creating account...';
    const { error } = await Auth.signUp(email, password, username);
    if (error) {
      errEl.style.color = '';
      errEl.textContent = error.message;
    } else {
      errEl.style.color = '#4ade80';
      errEl.textContent = 'Account created! Check your email to confirm, then sign in.';
    }
  });
}

Auth.onAuthChange(renderAuthWidget);
renderAuthWidget();
