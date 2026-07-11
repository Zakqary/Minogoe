// Daily check-in popup: shows once per session (while eligible) on any page,
// letting a signed-in player claim their one coin for the day. Built and
// injected in JS rather than duplicated in every page's HTML.
const CHECKIN_DISMISSED_KEY = 'minogoeCheckinDismissed';
const CHECKIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isCheckinEligible(profile) {
  if (!profile) return false;
  if (!profile.last_checkin_at) return true;
  return Date.now() - new Date(profile.last_checkin_at).getTime() >= CHECKIN_INTERVAL_MS;
}

function dismissedThisSession() {
  return sessionStorage.getItem(CHECKIN_DISMISSED_KEY) === '1';
}

function removeCheckinPopup() {
  const el = document.getElementById('checkinPopup');
  if (el) el.remove();
}

function showCheckinPopup() {
  if (document.getElementById('checkinPopup')) return;
  const el = document.createElement('div');
  el.id = 'checkinPopup';
  el.className = 'checkin-popup';
  el.innerHTML = `
    <button id="checkinDismissBtn" class="checkin-dismiss" aria-label="Dismiss">&times;</button>
    <div class="checkin-message">Daily check-in ready!</div>
    <button id="checkinClaimBtn" class="checkin-claim-btn">Check in (+1 coin)</button>
    <div id="checkinError" class="checkin-error"></div>
  `;
  document.body.appendChild(el);

  document.getElementById('checkinDismissBtn').addEventListener('click', () => {
    sessionStorage.setItem(CHECKIN_DISMISSED_KEY, '1');
    removeCheckinPopup();
  });

  document.getElementById('checkinClaimBtn').addEventListener('click', async () => {
    const btn = document.getElementById('checkinClaimBtn');
    btn.disabled = true;
    const { error } = await supabaseClient.rpc('claim_daily_checkin');
    if (error) {
      document.getElementById('checkinError').textContent = error.message;
      btn.disabled = false;
      return;
    }
    await Auth.refreshProfile();
    if (typeof renderAuthWidget === 'function') renderAuthWidget();
    removeCheckinPopup();
  });
}

function maybeShowCheckinPopup() {
  const profile = Auth.getProfile();
  if (!Auth.getUser() || !isCheckinEligible(profile) || dismissedThisSession()) {
    removeCheckinPopup();
    return;
  }
  showCheckinPopup();
}

Auth.onAuthChange(maybeShowCheckinPopup);
