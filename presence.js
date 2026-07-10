// Tracks "players online" (accounts active in the last 15 minutes) and
// shows a live count in the header on every page. Loaded after auth.js.
const PRESENCE_HEARTBEAT_MS = 60000;
const PRESENCE_POLL_MS = 30000;
const ONLINE_WINDOW_MINUTES = 15;

let presenceHeartbeatId = null;

async function sendHeartbeat() {
  const user = Auth.getUser();
  if (!user) return;
  await supabaseClient.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', user.id);
}

function startHeartbeat() {
  if (presenceHeartbeatId) return;
  sendHeartbeat();
  presenceHeartbeatId = setInterval(sendHeartbeat, PRESENCE_HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (presenceHeartbeatId) {
    clearInterval(presenceHeartbeatId);
    presenceHeartbeatId = null;
  }
}

async function refreshOnlineCount() {
  const el = document.getElementById('onlineCount');
  if (!el) return;
  const cutoff = new Date(Date.now() - ONLINE_WINDOW_MINUTES * 60000).toISOString();
  const { count, error } = await supabaseClient
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gt('last_seen', cutoff);
  if (!error && count !== null) {
    el.innerHTML = `<span class="online-dot"></span>${count} online`;
  }
}

async function refreshGamesPlayedCount() {
  const el = document.getElementById('gamesPlayedCount');
  if (!el) return;
  const { count, error } = await supabaseClient
    .from('games')
    .select('*', { count: 'exact', head: true });
  if (!error && count !== null) {
    el.textContent = `${count.toLocaleString()} games of Minogoe played`;
  }
}

Auth.onAuthChange(() => {
  if (Auth.getUser()) startHeartbeat();
  else stopHeartbeat();
});

refreshOnlineCount();
refreshGamesPlayedCount();
setInterval(refreshOnlineCount, PRESENCE_POLL_MS);
setInterval(refreshGamesPlayedCount, PRESENCE_POLL_MS);
