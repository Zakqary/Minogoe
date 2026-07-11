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

function showGardenError(message) {
  const el = document.getElementById('gardenError');
  if (el) el.textContent = message;
}

function potSlotHtml(mino) {
  if (!mino) {
    return `
      <div class="garden-pot empty">
        <div class="garden-pot-icon">&#127940;</div>
        <div class="garden-pot-label">Empty pot</div>
      </div>
    `;
  }
  const progressText = mino.stage === 'adult' ? 'Fully grown' : `${mino.growth_progress}/5 games to grow`;
  return `
    <div class="garden-pot planted">
      ${minoVisualHtml(mino, 56)}
      <div class="garden-mino-name" data-id="${escapeHtml(mino.id)}" data-current="${escapeHtml(mino.name || '')}" title="Click to rename">
        ${mino.name ? escapeHtml(mino.name) : 'Unnamed Mino'} &#9998;
      </div>
      <div class="garden-mino-sub">${escapeHtml(minoLabel(mino))}</div>
      <div class="garden-mino-stage">${capitalize(mino.stage)} &middot; ${progressText}</div>
      <button class="garden-digup-btn" data-id="${escapeHtml(mino.id)}">Dig Up</button>
    </div>
  `;
}

function seedCardHtml(seed, canPlant) {
  return `
    <div class="garden-seed-card">
      ${minoVisualHtml(seed, 40)}
      <div class="garden-seed-label">${escapeHtml(minoLabel(seed))}</div>
      <button class="garden-plant-btn" data-id="${escapeHtml(seed.id)}" ${canPlant ? '' : 'disabled'}>Plant</button>
    </div>
  `;
}

async function renderGardenPage() {
  const container = document.getElementById('gardenContent');
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

  const pots = [];
  for (let i = 0; i < potCount; i++) pots.push(potSlotHtml(planted[i] || null));

  container.innerHTML = `
    <div class="shop-balance">${coinIconHtml(18)} You have <strong>${profile.coins}</strong> coin${profile.coins === 1 ? '' : 's'}. Visit the <a href="shop.html">shop</a> for extra pots and seed packs.</div>
    <div id="gardenError" class="shop-error"></div>

    <h3>Your Garden</h3>
    <div class="garden-pots">${pots.join('')}</div>

    <h3>Seed Inventory</h3>
    <div class="garden-seed-inventory">${seeds.map((s) => seedCardHtml(s, canPlant)).join('') || '<p>No seeds yet - play casual/ranked games or buy a seed pack in the shop.</p>'}</div>
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
}

Auth.onAuthChange(renderGardenPage);
renderGardenPage();
