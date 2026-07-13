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

// A top-level `const Catalog = ...` (in catalog.js) never becomes a
// property of `window` - only `var`/function declarations do - so
// `window.Catalog` is always undefined even once Catalog is fully loaded.
// Guard against catalog.js simply not being on the page (or not loaded
// yet) via `typeof` instead, which checks the real binding.
function catalogGet(id) {
  return (typeof Catalog !== 'undefined' && Catalog) ? Catalog.get(id) : null;
}

// Small <img> for a bought-and-equipped avatar, or a default "?" placeholder
// when the player has none equipped (or the catalog hasn't loaded yet).
function avatarHtml(avatarId, size = 24) {
  const item = catalogGet(avatarId);
  if (item && item.image_path) {
    return `<img src="${escapeHtml(item.image_path)}" alt="" class="avatar-img" style="width:${size}px;height:${size}px;">`;
  }
  return `<span class="avatar-img avatar-default" style="width:${size}px;height:${size}px;">?</span>`;
}

// The equipped title's display text, or the default "Freshy" for players
// who haven't bought/equipped one.
function titleText(titleId) {
  const item = catalogGet(titleId);
  return item && item.title_text ? item.title_text : 'Freshy';
}

// Each title can carry its own color (shop_items.color) so sellable titles
// don't all look the same - falls back to the site's default accent color.
function titleColor(titleId) {
  const item = catalogGet(titleId);
  return (item && item.color) || '#e0a75c';
}

function titleBadgeHtml(titleId) {
  const color = escapeHtml(titleColor(titleId));
  const style = `color:${color}; background:color-mix(in srgb, ${color} 18%, transparent); border-color:color-mix(in srgb, ${color} 55%, transparent);`;
  return `<span class="title-badge" style="${style}">${escapeHtml(titleText(titleId))}</span>`;
}

function coinIconHtml(size = 14) {
  return `<img src="assets/coin.png" alt="" class="coin-icon" style="width:${size}px;height:${size}px;">`;
}

// ---------- Mino (garden creature) rendering - shared so game.js/profile.js
// can render a player's companion without loading garden.js's full page logic ----------

// Hex swatches for each seed color - keep in sync with schema.sql's
// random_mino_color() (Phase 16). Purely a display concern: the DB only
// ever stores the color name, never a hex value.
const MINO_COLOR_HEX = {
  Crimson: '#c0392b',
  Amber: '#e6923a',
  Gold: '#d4af37',
  Verdant: '#4a9b4a',
  Teal: '#3aa6a6',
  Azure: '#3b82c4',
  Violet: '#8b6fd9',
  Magenta: '#c74fb0',
  Umber: '#8a5a3b',
  Slate: '#6b7280',
};

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Classic "loot rarity" text colors - lets a Mino/seed's name be read at a
// glance without having to also read its rarity word next to it.
const MINO_RARITY_COLOR = {
  common: '#9a9a9a',
  uncommon: '#6fbf73',
  rare: '#5dade2',
  epic: '#b06fd9',
  legendary: '#ffd700',
};

function minoRarityColor(rarity) {
  return MINO_RARITY_COLOR[rarity] || MINO_RARITY_COLOR.common;
}

// A small procedural SVG "creature" rather than illustrated art - there's
// no art pipeline for 10 colors x 5 rarities x 4 stages x 10 modifiers the
// way avatars have one (those are hand-supplied image files). Stage
// changes the silhouette (seed -> sprouting leaves -> eyes -> limbs);
// rarity is a CSS glow applied around the shape via mino-rarity-<rarity>.
function minoVisualHtml(mino, size = 48) {
  const hex = MINO_COLOR_HEX[mino.color] || '#999';
  const hasEyes = mino.stage === 'adolescent' || mino.stage === 'adult';
  const hasLimbs = mino.stage === 'adult';
  const hasLeaves = mino.stage === 'sapling';
  const bodyRy = mino.stage === 'seed' ? 22 : 35;
  const bodyRx = mino.stage === 'seed' ? 26 : 40;

  const leaves = hasLeaves
    ? `<path d="M50 22 Q34 8 26 22 Q40 24 50 22 Z" fill="#4a9b4a"/><path d="M50 22 Q66 8 74 22 Q60 24 50 22 Z" fill="#4a9b4a"/>`
    : '';
  const eyes = hasEyes
    ? `<circle cx="38" cy="55" r="5" fill="#1a1a1a"/><circle cx="62" cy="55" r="5" fill="#1a1a1a"/>`
    : '';
  // Positioned outside the body ellipse's horizontal edges (cx +/- bodyRx)
  // so they read as distinct limb nubs rather than disappearing inside the
  // larger same-colored body shape.
  const limbs = hasLimbs
    ? `<ellipse cx="${50 - bodyRx + 2}" cy="86" rx="10" ry="8" fill="${hex}"/><ellipse cx="${50 + bodyRx - 2}" cy="86" rx="10" ry="8" fill="${hex}"/>`
    : '';

  return `
    <div class="mino-visual mino-rarity-${mino.rarity}" style="width:${size}px;height:${size}px;">
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        ${leaves}
        <ellipse cx="50" cy="60" rx="${bodyRx}" ry="${bodyRy}" fill="${hex}" />
        ${eyes}
        ${limbs}
      </svg>
    </div>
  `;
}

function minoLabel(mino) {
  return `${capitalize(mino.rarity)}${mino.modifier ? ' ' + mino.modifier : ''} ${mino.color}`;
}

// Nudges signed-out visitors toward creating an account (a lot of people
// try the game as a guest and never come back) - hidden until auth
// actually resolves, so an already-registered player never sees it flash
// on load before their signed-in state is known.
function updateRegisterBanner() {
  const banner = document.getElementById('registerBanner');
  if (!banner) return;
  banner.style.display = (Auth.isInitialized && !Auth.getUser()) ? '' : 'none';
}

function renderAuthWidget() {
  updateRegisterBanner();
  const el = document.getElementById('authWidget');
  const user = Auth.getUser();
  const profile = Auth.getProfile();

  if (user) {
    el.innerHTML = `
      <div class="auth-user-block">
        ${avatarHtml(profile ? profile.avatar_id : null)}
        <a href="profile.html" class="auth-username">${escapeHtml(profile ? profile.username : user.email)}</a>
        ${profile ? titleBadgeHtml(profile.title_id) : ''}
        ${profile ? `<span class="auth-coins">${coinIconHtml()} ${profile.coins} coin${profile.coins === 1 ? '' : 's'}</span>` : ''}
      </div>
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
if (typeof Catalog !== 'undefined') Catalog.ready().then(renderAuthWidget);

// The banner button is static markup (unlike #authToggleBtn/#authPanel,
// which renderAuthWidget() recreates from scratch every call) - wired
// once here rather than re-attached on every render.
document.getElementById('registerBannerBtn')?.addEventListener('click', () => {
  const panel = document.getElementById('authPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  document.getElementById('tabSignUp')?.click();
  document.getElementById('authWidget')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
