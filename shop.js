let ownedIds = new Set();

// Fixed coin packages - must match the COIN_PACKAGES map in the
// create-checkout-session Edge Function exactly (that's the copy that
// actually decides the price; this one is display-only). Split into
// price/coins (rather than one combined label string) so each button can
// be laid out like a miniature version of the coin-balance display above
// it - coin icon + amount, price as a subtitle.
const COIN_PACKAGES = [
  { key: 'small', price: '$1', coins: 10 },
  { key: 'medium', price: '$5', coins: 60 },
  { key: 'large', price: '$10', coins: 150 },
];

// Set by consumeCheckoutRedirectParam() after a Stripe Checkout redirect -
// kept as a variable (not written directly to the DOM) so it survives
// renderShopPage() re-rendering the whole #shopContent innerHTML during the
// post-purchase coin-balance polling below.
let checkoutStatusText = '';

// Every account owns these two by default (see schema.sql Phase 13) - the
// shop's "equipped" check falls back to them when avatar_id/title_id is
// null, so the default look shows as a normal Equipped item instead of a
// separate revert-to-default special case.
const DEFAULT_AVATAR_ID = 'avatar_default';
const DEFAULT_TITLE_ID = 'title_freshy';

async function loadOwnedIds(userId) {
  const { data } = await supabaseClient.from('user_inventory').select('item_id').eq('user_id', userId);
  ownedIds = new Set((data || []).map((r) => r.item_id));
}

function itemCardHtml(item, profile) {
  const owned = ownedIds.has(item.id);
  const equippedId = item.type === 'avatar'
    ? (profile.avatar_id || DEFAULT_AVATAR_ID)
    : (profile.title_id || DEFAULT_TITLE_ID);
  const equipped = equippedId === item.id;

  let preview;
  if (item.type === 'avatar') {
    preview = item.image_path
      ? `<img src="${escapeHtml(item.image_path)}" alt="" class="shop-item-preview">`
      : `<span class="shop-item-preview avatar-default">?</span>`;
  } else {
    const color = escapeHtml(item.color || '#e0a75c');
    const style = `color:${color}; background:color-mix(in srgb, ${color} 22%, transparent); border-color:color-mix(in srgb, ${color} 55%, transparent);`;
    preview = `<span class="shop-item-preview title-preview" style="${style}">${escapeHtml(item.title_text || item.name)}</span>`;
  }

  let action;
  if (equipped) {
    action = `<button class="shop-equipped-btn" disabled>Equipped</button>`;
  } else if (owned) {
    action = `<button class="shop-equip-btn" data-id="${escapeHtml(item.id)}" data-type="${item.type}">Equip</button>`;
  } else {
    action = `<button class="shop-buy-btn" data-id="${escapeHtml(item.id)}">Buy for ${item.price} coin${item.price === 1 ? '' : 's'}</button>`;
  }

  return `
    <div class="shop-item-card${equipped ? ' equipped' : ''}">
      ${item.notice ? `<div class="shop-item-notice">${escapeHtml(item.notice)}</div>` : ''}
      <div class="shop-item-row">
        ${preview}
        <div class="shop-item-info">
          <div class="shop-item-name">${escapeHtml(item.name)}</div>
        </div>
        ${action}
      </div>
    </div>
  `;
}

// Coins are only ever actually granted by the signature-verified
// stripe-webhook Edge Function, which runs slightly AFTER Stripe redirects
// the browser back here - so the balance shown on the very first render
// right after a successful checkout may still be stale. Polls a few times
// so it catches up without the player needing to manually refresh.
function consumeCheckoutRedirectParam() {
  const params = new URLSearchParams(location.search);
  const status = params.get('checkout');
  if (!status) return;

  // coins here is purely a display hint the Edge Function put on the
  // success_url (see create-checkout-session) - it never grants anything
  // itself, so there's nothing to gain by tampering with it in the URL bar.
  const coins = Number(params.get('coins'));

  // Strip the query params immediately so a manual page refresh later
  // doesn't re-show this popup.
  const url = new URL(location.href);
  url.searchParams.delete('checkout');
  url.searchParams.delete('coins');
  history.replaceState({}, '', url);

  if (status === 'success') {
    if (Number.isFinite(coins) && coins > 0) showCoinPurchaseToast(coins);
    pollForCoinsUpdate();
  } else if (status === 'cancelled') {
    checkoutStatusText = 'Checkout cancelled - no charge was made.';
    setTimeout(() => { checkoutStatusText = ''; renderShopPage(); }, 8000);
  }
}

function showCoinPurchaseToast(coins) {
  if (document.getElementById('coinPurchaseToast')) return;
  const el = document.createElement('div');
  el.id = 'coinPurchaseToast';
  el.className = 'coin-purchase-toast';
  el.innerHTML = `
    <button id="coinPurchaseToastDismiss" class="coin-purchase-toast-dismiss" aria-label="Dismiss">&times;</button>
    <div class="coin-purchase-toast-message">${coinIconHtml(20)} Successfully purchased ${coins} coin${coins === 1 ? '' : 's'}!</div>
  `;
  document.body.appendChild(el);
  document.getElementById('coinPurchaseToastDismiss').addEventListener('click', () => el.remove());
  setTimeout(() => el.remove(), 8000);
}

function pollForCoinsUpdate(attempt = 0) {
  if (attempt >= 5) {
    checkoutStatusText = '';
    renderShopPage();
    return;
  }
  setTimeout(async () => {
    await refreshAfterMutation();
    pollForCoinsUpdate(attempt + 1);
  }, 2000);
}

async function renderShopPage() {
  const container = document.getElementById('shopContent');
  // Auth resolves asynchronously - without this check, the very first
  // render (right after page load, before the first onAuthStateChange
  // event fires) would see getUser()/getProfile() both still null and
  // briefly flash "sign in" or "could not load your profile" even for an
  // already-logged-in user, before the real state arrives a moment later.
  if (!Auth.isInitialized) {
    container.innerHTML = '<p>Loading...</p>';
    return;
  }
  const user = Auth.getUser();
  if (!user) {
    container.innerHTML = '<p>Sign in (top right) to visit the shop.</p>';
    return;
  }

  consumeCheckoutRedirectParam();

  await Catalog.ready();
  const profile = Auth.getProfile();
  if (!profile) {
    container.innerHTML = '<p>Could not load your profile.</p>';
    return;
  }

  await loadOwnedIds(user.id);

  // Hidden items (e.g. an admin-only title) never show up for browsing/
  // purchase - only someone who already owns one (granted directly, not
  // bought) sees it, so they can still equip it from their own shop page.
  const visible = (i) => !i.hidden || ownedIds.has(i.id);
  const avatars = Catalog.all().filter((i) => i.type === 'avatar' && visible(i));
  const titles = Catalog.all().filter((i) => i.type === 'title' && visible(i));

  container.innerHTML = `
    <div class="shop-balance">${coinIconHtml(18)} You have <strong>${profile.coins}</strong> coin${profile.coins === 1 ? '' : 's'}.</div>
    ${checkoutStatusText ? `<div class="shop-checkout-status">${escapeHtml(checkoutStatusText)}</div>` : ''}
    <div class="buy-coins-block">
      ${COIN_PACKAGES.map((p) => `
        <button class="buy-coins-btn" data-package="${p.key}">
          <span class="buy-coins-btn-amount">${coinIconHtml(20)} ${p.coins}</span>
          <span class="buy-coins-btn-price">${escapeHtml(p.price)}</span>
        </button>
      `).join('')}
    </div>
    <div id="shopError" class="shop-error"></div>

    <div class="shop-categories">
      <div class="shop-category">
        <h3>Profile Pictures</h3>
        <div class="shop-grid">${avatars.map((i) => itemCardHtml(i, profile)).join('') || '<p>No avatars in the shop yet.</p>'}</div>
      </div>

      <div class="shop-category">
        <h3>Titles</h3>
        <div class="shop-grid">${titles.map((i) => itemCardHtml(i, profile)).join('') || '<p>No titles in the shop yet.</p>'}</div>
      </div>

      <div class="shop-category">
        <h3>Garden Supplies</h3>
        <div class="shop-grid">
          <div class="shop-item-card">
            <div class="shop-item-row">
              <div class="pot-icon shop-item-preview"></div>
              <div class="shop-item-info">
                <div class="shop-item-name">Extra Pot</div>
                <div class="shop-item-sub">You have ${profile.garden_pot_count}</div>
              </div>
              <button class="shop-buy-pot-btn">Buy for 10 coins</button>
            </div>
          </div>
          <div class="shop-item-card">
            <div class="shop-item-row">
              <span class="shop-item-preview seed-pack-preview">&#127793;</span>
              <div class="shop-item-info">
                <div class="shop-item-name">Seed Pack</div>
                <div class="shop-item-sub">You have ${profile.unopened_seed_packs || 0} unopened</div>
              </div>
              <button class="shop-buy-seedpack-btn">Buy for 10 coins</button>
            </div>
          </div>
        </div>
        <div id="seedRevealMessage" class="shop-seed-reveal"></div>
      </div>
    </div>
  `;

  wireShopButtons();
}

function showShopError(message) {
  const el = document.getElementById('shopError');
  if (el) el.textContent = message;
}

// After any successful coin/inventory/equip mutation, the shop's own view
// of Auth.getProfile() needs a refetch - but so does the nav widget at the
// top of this (and every) page, which otherwise keeps showing the old
// coins/avatar/title until the next full page load, since refreshProfile()
// alone doesn't re-render anything.
async function refreshAfterMutation() {
  await Auth.refreshProfile();
  if (typeof renderAuthWidget === 'function') renderAuthWidget();
  await renderShopPage();
}

function wireShopButtons() {
  for (const btn of document.querySelectorAll('.buy-coins-btn')) {
    btn.addEventListener('click', async () => {
      showShopError('');
      btn.disabled = true;
      const { data, error } = await supabaseClient.functions.invoke('create-checkout-session', {
        body: { package: btn.dataset.package },
      });
      if (error || !data?.url) {
        showShopError(error ? error.message : 'Could not start checkout.');
        btn.disabled = false;
        return;
      }
      window.location.href = data.url;
    });
  }

  for (const btn of document.querySelectorAll('.shop-buy-btn')) {
    btn.addEventListener('click', async () => {
      showShopError('');
      btn.disabled = true;
      const { error } = await supabaseClient.rpc('purchase_item', { p_item_id: btn.dataset.id });
      if (error) {
        showShopError(error.message);
        btn.disabled = false;
        return;
      }
      await refreshAfterMutation();
    });
  }

  for (const btn of document.querySelectorAll('.shop-equip-btn')) {
    btn.addEventListener('click', async () => {
      showShopError('');
      btn.disabled = true;
      const fn = btn.dataset.type === 'avatar' ? 'equip_avatar' : 'equip_title';
      const { error } = await supabaseClient.rpc(fn, { p_item_id: btn.dataset.id });
      if (error) {
        showShopError(error.message);
        btn.disabled = false;
        return;
      }
      await refreshAfterMutation();
    });
  }

  const buyPotBtn = document.querySelector('.shop-buy-pot-btn');
  if (buyPotBtn) {
    buyPotBtn.addEventListener('click', async () => {
      showShopError('');
      buyPotBtn.disabled = true;
      const { error } = await supabaseClient.rpc('buy_pot');
      if (error) {
        showShopError(error.message);
        buyPotBtn.disabled = false;
        return;
      }
      await refreshAfterMutation();
    });
  }

  const buySeedPackBtn = document.querySelector('.shop-buy-seedpack-btn');
  if (buySeedPackBtn) {
    buySeedPackBtn.addEventListener('click', async () => {
      showShopError('');
      buySeedPackBtn.disabled = true;
      const { error } = await supabaseClient.rpc('buy_seed_pack');
      if (error) {
        showShopError(error.message);
        buySeedPackBtn.disabled = false;
        return;
      }
      await refreshAfterMutation();
      const el = document.getElementById('seedRevealMessage');
      if (el) el.textContent = 'Sealed seed pack added to your inventory - open it whenever you like in your garden.';
    });
  }
}

Auth.onAuthChange(renderShopPage);
renderShopPage();
