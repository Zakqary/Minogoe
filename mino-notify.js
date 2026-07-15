// Small toast (same pattern as checkin.js) that surfaces a game-reward
// seed pack the next time the player loads any page, since the trigger
// that grants it (schema.sql Phase 22) runs entirely server-side with no
// way to push a notification to an open tab. Purchased seed packs already
// show their own reveal inline in the shop and never touch this counter.
function checkForNewPacks() {
  const user = Auth.getUser();
  const profile = Auth.getProfile();
  if (!user || !profile || !profile.pending_pack_notifications) return;
  showPackToast(profile.pending_pack_notifications);
}

function removePackToast() {
  const el = document.getElementById('minoSeedToast');
  if (el) el.remove();
}

function showPackToast(count) {
  if (document.getElementById('minoSeedToast')) return;

  const summary = count === 1
    ? 'You found a sealed seed pack!'
    : `You found ${count} sealed seed packs!`;

  const el = document.createElement('div');
  el.id = 'minoSeedToast';
  el.className = 'mino-seed-toast';
  el.innerHTML = `
    <button id="minoSeedToastDismiss" class="mino-seed-toast-dismiss" aria-label="Dismiss">&times;</button>
    <div class="mino-seed-toast-message">&#127793; ${escapeHtml(summary)}</div>
    <div class="mino-seed-toast-sub">Open it in your <a href="garden.html">garden</a>.</div>
  `;
  document.body.appendChild(el);

  document.getElementById('minoSeedToastDismiss').addEventListener('click', async () => {
    removePackToast();
    await supabaseClient.rpc('acknowledge_pack_notifications');
  });
}

// Same idea as the seed pack toast above, but for coins/items a planted
// adult Mino has actually given out (schema.sql Phase 34's mino_gifts
// table) - these used to happen completely silently server-side, so a
// player could easily rack up titles/coins from their garden without ever
// noticing. Needs an actual query (not just a cached profile counter,
// like pending_pack_notifications) since each gift has its own detail -
// which mino, what it gave - worth showing.
async function checkForNewGifts() {
  const user = Auth.getUser();
  if (!user) return;

  const { data: gifts, error } = await supabaseClient
    .from('mino_gifts')
    .select('*, mino:mino_id(id, color, rarity, modifier, name)')
    .eq('user_id', user.id)
    .eq('acknowledged', false)
    .order('created_at', { ascending: true });

  if (error || !gifts || gifts.length === 0) return;

  await Catalog.ready();
  showGiftToast(gifts);
}

function removeGiftToast() {
  const el = document.getElementById('minoGiftToast');
  if (el) el.remove();
}

function giftLineHtml(gift) {
  const who = gift.mino ? (gift.mino.name || minoLabel(gift.mino)) : 'Your mino';
  if (gift.gift_type === 'coins') {
    return `${escapeHtml(who)} gave you ${gift.coins_amount} coin${gift.coins_amount === 1 ? '' : 's'}!`;
  }
  const item = Catalog.get(gift.item_id);
  const itemName = item ? item.name : 'an item';
  const itemKind = item && item.type === 'title' ? 'title' : 'avatar';
  return `${escapeHtml(who)} gave you the "${escapeHtml(itemName)}" ${itemKind}!`;
}

function showGiftToast(gifts) {
  if (document.getElementById('minoGiftToast')) return;

  const lines = gifts.map((g) => `<div class="mino-gift-toast-line">&#127873; ${giftLineHtml(g)}</div>`).join('');

  const el = document.createElement('div');
  el.id = 'minoGiftToast';
  el.className = 'mino-seed-toast mino-gift-toast';
  el.innerHTML = `
    <button id="minoGiftToastDismiss" class="mino-seed-toast-dismiss" aria-label="Dismiss">&times;</button>
    <div class="mino-seed-toast-message">Your Minos have been busy!</div>
    ${lines}
  `;
  document.body.appendChild(el);

  document.getElementById('minoGiftToastDismiss').addEventListener('click', async () => {
    removeGiftToast();
    await supabaseClient.rpc('acknowledge_mino_gifts');
  });
}

// Same acknowledge-on-dismiss idea as the two toasts above, but for coins
// won from the 48-hour "most ranked matches played" leaderboard
// (schema.sql Phase 47) - that reward is granted entirely server-side by
// rollover_ranked_period_if_needed(), so this is the only way a winner
// ever finds out.
async function checkForCoinAwards() {
  const user = Auth.getUser();
  if (!user) return;

  const { data: awards, error } = await supabaseClient
    .from('coin_award_notifications')
    .select('*')
    .eq('user_id', user.id)
    .eq('acknowledged', false)
    .order('created_at', { ascending: true });

  if (error || !awards || awards.length === 0) return;

  showCoinAwardToast(awards);
}

function removeCoinAwardToast() {
  const el = document.getElementById('minoCoinAwardToast');
  if (el) el.remove();
}

function showCoinAwardToast(awards) {
  if (document.getElementById('minoCoinAwardToast')) return;

  const lines = awards.map((a) => `<div class="mino-gift-toast-line">&#127942; You won ${a.coins_amount} coin${a.coins_amount === 1 ? '' : 's'} for the ${escapeHtml(a.reason)}!</div>`).join('');

  const el = document.createElement('div');
  el.id = 'minoCoinAwardToast';
  el.className = 'mino-seed-toast mino-gift-toast';
  el.innerHTML = `
    <button id="minoCoinAwardToastDismiss" class="mino-seed-toast-dismiss" aria-label="Dismiss">&times;</button>
    <div class="mino-seed-toast-message">Nice work!</div>
    ${lines}
  `;
  document.body.appendChild(el);

  document.getElementById('minoCoinAwardToastDismiss').addEventListener('click', async () => {
    removeCoinAwardToast();
    await supabaseClient.rpc('acknowledge_coin_award_notifications');
  });
}

Auth.onAuthChange(checkForNewPacks);
Auth.onAuthChange(checkForNewGifts);
Auth.onAuthChange(checkForCoinAwards);
