// MINO_COLOR_HEX / capitalize / minoVisualHtml / minoLabel live in
// auth-ui.js - shared with game.js/profile.js so a player's companion can be
// rendered on the scoreboard and profile page without loading this whole
// garden page's logic.

function showGardenError(message) {
  const el = document.getElementById('gardenError');
  if (el) el.textContent = message;
}

function potSlotHtml(mino, companionId) {
  if (!mino) {
    return `
      <div class="garden-pot empty">
        <div class="pot-icon"></div>
        <div class="garden-pot-label">Empty pot</div>
      </div>
    `;
  }
  const progressText = mino.stage === 'adult' ? 'Fully grown' : `${mino.growth_progress}/5 games to grow`;
  const isCompanion = mino.id === companionId;
  // The companion picker only makes sense once a Mino is fully grown - a
  // seedling would look odd trailing a player around mid-game.
  const companionBtn = mino.stage === 'adult'
    ? `<button class="garden-companion-btn${isCompanion ? ' active' : ''}" data-id="${escapeHtml(mino.id)}" data-current="${isCompanion ? 'true' : 'false'}">${isCompanion ? '★ Companion' : 'Make Companion'}</button>`
    : '';
  return `
    <div class="garden-pot planted${isCompanion ? ' is-companion' : ''}">
      ${minoVisualHtml(mino, 56)}
      <div class="garden-mino-name" style="color:${minoRarityColor(mino.rarity)}" data-id="${escapeHtml(mino.id)}" data-current="${escapeHtml(mino.name || '')}" title="Click to rename">
        ${mino.name ? escapeHtml(mino.name) : 'Unnamed Mino'} &#9998;
      </div>
      <div class="garden-mino-sub">${escapeHtml(minoLabel(mino))}</div>
      <div class="garden-mino-stage">${capitalize(mino.stage)} &middot; ${progressText}</div>
      ${companionBtn}
      <button class="garden-digup-btn" data-id="${escapeHtml(mino.id)}">Dig Up</button>
    </div>
  `;
}

function seedCardHtml(seed, canPlant) {
  return `
    <div class="garden-seed-card">
      ${minoVisualHtml(seed, 40)}
      <div class="garden-seed-label" style="color:${minoRarityColor(seed.rarity)}">${escapeHtml(minoLabel(seed))}</div>
      <button class="garden-plant-btn" data-id="${escapeHtml(seed.id)}" ${canPlant ? '' : 'disabled'}>Plant</button>
    </div>
  `;
}

function seedPackCardHtml() {
  return `
    <div class="garden-seed-card seed-pack-card">
      <div class="seed-pack-icon">&#127793;</div>
      <div class="garden-seed-label">Sealed Seed Pack</div>
      <button class="garden-open-pack-btn">Open</button>
    </div>
  `;
}

async function renderGardenPage() {
  const container = document.getElementById('gardenContent');
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
    container.innerHTML = '<p>Sign in (top right) to visit your garden.</p>';
    return;
  }

  const profile = Auth.getProfile();
  if (!profile) {
    container.innerHTML = '<p>Could not load your profile.</p>';
    return;
  }

  const { data: minos, error } = await supabaseClient
    .from('minos')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (error) {
    container.innerHTML = `<p>Could not load your garden: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const all = minos || [];
  const planted = all.filter((m) => m.planted);
  const seeds = all.filter((m) => !m.planted);
  const potCount = profile.garden_pot_count;
  const canPlant = planted.length < potCount;
  const companionId = profile.companion_mino_id || null;
  const packCount = profile.unopened_seed_packs || 0;

  const pots = [];
  for (let i = 0; i < potCount; i++) pots.push(potSlotHtml(planted[i] || null, companionId));

  const packCards = Array.from({ length: packCount }, () => seedPackCardHtml()).join('');
  const seedCards = seeds.map((s) => seedCardHtml(s, canPlant)).join('');
  const inventoryEmpty = !packCards && !seedCards
    ? '<p>No seeds yet - play casual/ranked games or buy a seed pack in the shop.</p>'
    : '';

  container.innerHTML = `
    <div class="shop-balance">${coinIconHtml(18)} You have <strong>${profile.coins}</strong> coin${profile.coins === 1 ? '' : 's'}. Visit the <a href="shop.html">shop</a> for extra pots and seed packs.</div>
    <div id="gardenError" class="shop-error"></div>

    <h3>Your Garden</h3>
    <div class="garden-pots">${pots.join('')}</div>

    <h3>Seed Inventory</h3>
    <div class="garden-seed-inventory">${packCards}${seedCards}${inventoryEmpty}</div>
  `;

  wireGardenButtons();
}

async function promptRename(minoId, currentName) {
  const input = window.prompt('Name your Mino (leave blank to clear):', currentName || '');
  if (input === null) return;
  const { error } = await supabaseClient.rpc('rename_mino', { p_mino_id: minoId, p_name: input });
  if (error) {
    showGardenError(error.message);
    return;
  }
  renderGardenPage();
}

// Opens a seed pack in place: a brief shake animation, then the reveal - the
// full page (new seed in inventory, one fewer sealed pack) only re-renders
// after the reveal has had a moment to show, so the player actually sees
// what they got instead of the grid just reshuffling under them.
async function openPackWithAnimation(cardEl) {
  cardEl.classList.add('seed-pack-shaking');
  await new Promise((resolve) => setTimeout(resolve, 900));

  const { data: newMinoId, error } = await supabaseClient.rpc('open_seed_pack');
  if (error) {
    showGardenError(error.message);
    renderGardenPage();
    return;
  }

  const { data: mino } = await supabaseClient.from('minos').select('*').eq('id', newMinoId).single();
  cardEl.classList.remove('seed-pack-shaking');
  if (mino) {
    cardEl.classList.add('seed-pack-revealed');
    cardEl.innerHTML = `${minoVisualHtml(mino, 44)}<div class="garden-seed-label" style="color:${minoRarityColor(mino.rarity)}">New: ${escapeHtml(minoLabel(mino))}!</div>`;
  }

  await Auth.refreshProfile();
  setTimeout(renderGardenPage, 1600);
}

function wireGardenButtons() {
  for (const el of document.querySelectorAll('.garden-mino-name')) {
    el.addEventListener('click', () => promptRename(el.dataset.id, el.dataset.current));
  }

  for (const btn of document.querySelectorAll('.garden-digup-btn')) {
    btn.addEventListener('click', async () => {
      showGardenError('');
      btn.disabled = true;
      const { error } = await supabaseClient.rpc('dig_up_mino', { p_mino_id: btn.dataset.id });
      if (error) {
        showGardenError(error.message);
        btn.disabled = false;
        return;
      }
      await Auth.refreshProfile();
      renderGardenPage();
    });
  }

  for (const btn of document.querySelectorAll('.garden-plant-btn')) {
    btn.addEventListener('click', async () => {
      showGardenError('');
      btn.disabled = true;
      const { error } = await supabaseClient.rpc('plant_seed', { p_mino_id: btn.dataset.id });
      if (error) {
        showGardenError(error.message);
        btn.disabled = false;
        return;
      }
      renderGardenPage();
    });
  }

  for (const btn of document.querySelectorAll('.garden-companion-btn')) {
    btn.addEventListener('click', async () => {
      showGardenError('');
      btn.disabled = true;
      const isCurrent = btn.dataset.current === 'true';
      const { error } = await supabaseClient.rpc('set_companion', { p_mino_id: isCurrent ? null : btn.dataset.id });
      if (error) {
        showGardenError(error.message);
        btn.disabled = false;
        return;
      }
      await Auth.refreshProfile();
      if (typeof renderAuthWidget === 'function') renderAuthWidget();
      renderGardenPage();
    });
  }

  for (const btn of document.querySelectorAll('.garden-open-pack-btn')) {
    btn.addEventListener('click', () => {
      showGardenError('');
      btn.disabled = true;
      openPackWithAnimation(btn.closest('.seed-pack-card'));
    });
  }
}

Auth.onAuthChange(renderGardenPage);
renderGardenPage();
