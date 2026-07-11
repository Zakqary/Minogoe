let ownedIds = new Set();

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
      ${preview}
      <div class="shop-item-name">${escapeHtml(item.name)}</div>
      ${action}
    </div>
  `;
}

async function renderShopPage() {
  const container = document.getElementById('shopContent');
  const user = Auth.getUser();
  if (!user) {
    container.innerHTML = '<p>Sign in (top right) to visit the shop.</p>';
    return;
  }

  await Catalog.ready();
  const profile = Auth.getProfile();
  if (!profile) {
    container.innerHTML = '<p>Could not load your profile.</p>';
    return;
  }

  await loadOwnedIds(user.id);

  const avatars = Catalog.all().filter((i) => i.type === 'avatar');
  const titles = Catalog.all().filter((i) => i.type === 'title');

  container.innerHTML = `
    <div class="shop-balance">${coinIconHtml(18)} You have <strong>${profile.coins}</strong> coin${profile.coins === 1 ? '' : 's'}.</div>
    <div id="shopError" class="shop-error"></div>

    <h3>Profile Pictures</h3>
    <div class="shop-grid">${avatars.map((i) => itemCardHtml(i, profile)).join('') || '<p>No avatars in the shop yet.</p>'}</div>

    <h3>Titles</h3>
    <div class="shop-grid">${titles.map((i) => itemCardHtml(i, profile)).join('') || '<p>No titles in the shop yet.</p>'}</div>
  `;

  wireShopButtons();
}

function showShopError(message) {
  const el = document.getElementById('shopError');
  if (el) el.textContent = message;
}

function wireShopButtons() {
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
      await Auth.refreshProfile();
      renderShopPage();
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
      await Auth.refreshProfile();
      renderShopPage();
    });
  }

}

Auth.onAuthChange(renderShopPage);
renderShopPage();
