// Small toast (same pattern as checkin.js) that surfaces a game-reward
// seed the next time the player loads any page, since the trigger that
// grants it (schema.sql Phase 16) runs entirely server-side with no way to
// push a notification to an open tab. Purchased seed packs already show
// their own reveal inline in the shop, so those are inserted pre-marked
// seen and never show up here.
async function checkForNewSeeds() {
  const user = Auth.getUser();
  if (!user) return;
  const { data, error } = await supabaseClient
    .from('minos')
    .select('*')
    .eq('user_id', user.id)
    .eq('seen', false);
  if (error || !data || data.length === 0) return;
  showSeedToast(data);
}

function removeSeedToast() {
  const el = document.getElementById('minoSeedToast');
  if (el) el.remove();
}

function showSeedToast(seeds) {
  if (document.getElementById('minoSeedToast')) return;

  const summary = seeds.length === 1
    ? `You found a ${seeds[0].rarity}${seeds[0].modifier ? ' ' + seeds[0].modifier : ''} ${seeds[0].color} seed!`
    : `You found ${seeds.length} new seeds!`;

  const el = document.createElement('div');
  el.id = 'minoSeedToast';
  el.className = 'mino-seed-toast';
  el.innerHTML = `
    <button id="minoSeedToastDismiss" class="mino-seed-toast-dismiss" aria-label="Dismiss">&times;</button>
    <div class="mino-seed-toast-message">&#127793; ${escapeHtml(summary)}</div>
    <div class="mino-seed-toast-sub">Plant it in your <a href="garden.html">garden</a>.</div>
  `;
  document.body.appendChild(el);

  document.getElementById('minoSeedToastDismiss').addEventListener('click', async () => {
    removeSeedToast();
    for (const seed of seeds) {
      await supabaseClient.rpc('mark_mino_seen', { p_mino_id: seed.id });
    }
  });
}

Auth.onAuthChange(checkForNewSeeds);
