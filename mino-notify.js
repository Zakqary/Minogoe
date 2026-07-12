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

Auth.onAuthChange(checkForNewPacks);
