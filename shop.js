let ownedIds = new Set();

async function loadOwnedIds(userId) {
  const { data } = await supabaseClient.from('user_inventory').select('item_id').eq('user_id', userId);
  ownedIds = new Set((data || []).map((r) => r.item_id));
}

function itemCardHtml(item, profile) {
  const owned = ownedIds.has(item.id);
  const equipped = item.type === 'avatar' ? profile.avatar_id === item.id : profile.title_id === item.id;

  let preview;
  if (item.type === 'avatar') {
    preview = item.image_path
      ? `<img src="${escapeHtml(item.image_path)}" alt="" class="shop-item-preview">`
      : `<span class="shop-item-preview avatar-default">?</span>`;
  } else {
    preview = `<span class="shop-item-preview title-preview">${escapeHtml(item.title_text || item.name)}</span>`;
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
      ${preview}
      <div class="shop-item-name">${escapeHtml(item.name)}</div>
      ${action}
    </div>
  `;
}

function unequipButtonHtml(type, currentId) {
  if (!currentId) return '';
  return `<button class="shop-unequip-btn" data-type="${type}">Revert to default</button>`;
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
    <div class="shop-balance">You have <strong>${profile.coins}</strong> coin${profile.coins === 1 ? '' : 's'}.</div>
    <div id="shopError" class="shop-error"></div>

    <h3>Profile Pictures</h3>
    <div class="shop-grid">${avatars.map((i) => itemCardHtml(i, profile)).join('') || '<p>No avatars in the shop yet.</p>'}</div>
    ${unequipButtonHtml('avatar', profile.avatar_id)}

    <h3>Titles</h3>
    <div class="shop-grid">${titles.map((i) => itemCardHtml(i, profile)).join('') || '<p>No titles in the shop yet.</p>'}</div>
    ${unequipButtonHtml('title', profile.title_id)}
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

  for (const unequipBtn of document.querySelectorAll('.shop-unequip-btn')) {
    unequipBtn.addEventListener('click', async () => {
      showShopError('');
      unequipBtn.disabled = true;
      const fn = unequipBtn.dataset.type === 'avatar' ? 'equip_avatar' : 'equip_title';
      const { error } = await supabaseClient.rpc(fn, { p_item_id: null });
      if (error) {
        showShopError(error.message);
        unequipBtn.disabled = false;
        return;
      }
      await Auth.refreshProfile();
      renderShopPage();
    });
  }
}

Auth.onAuthChange(renderShopPage);
renderShopPage();
