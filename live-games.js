// Small "Live Games" panel on the main play page - lists currently ongoing
// pvp matches (casual/ranked/private, never vs-bot/hotseat, which the
// signaling server never even sees) and links each to a read-only spectate
// view (spectate.html). Purely a poller against the signaling server's
// plain HTTP /live-games endpoint - same pattern game.js/singleplayer.js
// already use for /queue-counts. Named distinctly from game.js's own
// SIGNALING_SERVER_URL/SIGNALING_HTTP_URL (both loaded on this same page)
// to avoid a top-level const collision between the two scripts.
const LIVE_GAMES_SIGNALING_HTTP_URL = 'https://minogoe.onrender.com';
const LIVE_GAMES_POLL_MS = 8000;

function liveGamesModeLabel(mode) {
  if (mode === 'ranked') return 'Ranked';
  if (mode === 'casual') return 'Casual';
  if (mode === 'private') return 'Private';
  return mode || '';
}

function liveGamesPlayerName(p) {
  return p ? (p.username || 'Guest') : '...';
}

async function refreshLiveGames() {
  const container = document.getElementById('liveGamesContent');
  if (!container) return;

  let games;
  try {
    const res = await fetch(`${LIVE_GAMES_SIGNALING_HTTP_URL}/live-games`);
    if (!res.ok) return;
    games = await res.json();
  } catch {
    // signaling server unreachable - leave whatever was last shown
    return;
  }

  if (!Array.isArray(games) || games.length === 0) {
    container.innerHTML = '<p class="ranked-period-empty">No live games right now.</p>';
    return;
  }

  const rows = games.map((g) => `
    <div class="live-game-row">
      <div class="live-game-players">${escapeHtml(liveGamesPlayerName(g.player1))} <span class="live-game-vs">vs</span> ${escapeHtml(liveGamesPlayerName(g.player2))}</div>
      <div class="live-game-meta">
        <span>${escapeHtml(liveGamesModeLabel(g.mode))} &middot; move ${Number(g.moveCount) || 0}</span>
        <a href="spectate.html?match=${encodeURIComponent(g.matchId)}">Spectate</a>
      </div>
    </div>
  `).join('');

  container.innerHTML = rows;
}

refreshLiveGames();
setInterval(refreshLiveGames, LIVE_GAMES_POLL_MS);
