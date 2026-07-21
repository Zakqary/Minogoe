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

// "private" is the internal mode value (still what's stored in the
// database and used in code) for what the site now calls "Direct Connect"
// everywhere a user actually sees it - a raw room-code connection between
// two specific people was never actually kept private from anyone who
// knows/finds the code (and, now that this very panel lists it, is
// publicly visible like any other match), so the old name overpromised.
function liveGamesModeLabel(mode) {
  if (mode === 'ranked') return 'Ranked';
  if (mode === 'casual') return 'Casual';
  if (mode === 'private') return 'Direct Connect';
  if (mode === 'ffa') return 'Free-For-All';
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

  // Net.matchId/NetFfa.matchId is this tab's own currently-connected match
  // (if any) - a player is never a WebRTC peer AND a spectator of the same
  // match at once, so their own live row gets no Spectate link. Compared
  // by matchId (not username) so it only ever affects the one match this
  // tab is actually in, never a coincidence of two other players sharing a
  // display name.
  const myMatchId = (typeof Net !== 'undefined' && Net.matchId) || null;
  const myFfaMatchId = (typeof NetFfa !== 'undefined' && NetFfa.matchId) || null;

  const rows = games.map((g) => {
    const isFfaRow = g.mode === 'ffa';
    const isMine = isFfaRow
      ? (myFfaMatchId && g.matchId === myFfaMatchId)
      : (myMatchId && g.matchId === myMatchId);
    const spectateUrl = isFfaRow
      ? `spectate.html?ffa=${encodeURIComponent(g.matchId)}`
      : `spectate.html?match=${encodeURIComponent(g.matchId)}`;
    const action = isMine
      ? '<span class="live-game-mine">Your game</span>'
      : `<a href="${spectateUrl}">Spectate</a>`;
    const playersText = isFfaRow
      ? (g.players || []).map((p) => escapeHtml(liveGamesPlayerName(p))).join(', ')
      : `${escapeHtml(liveGamesPlayerName(g.player1))} <span class="live-game-vs">vs</span> ${escapeHtml(liveGamesPlayerName(g.player2))}`;
    return `
    <div class="live-game-row">
      <div class="live-game-players">${playersText}</div>
      <div class="live-game-meta">
        <span>${escapeHtml(liveGamesModeLabel(g.mode))} &middot; move ${Number(g.moveCount) || 0}</span>
        ${action}
      </div>
    </div>
  `;
  }).join('');

  container.innerHTML = rows;
}

refreshLiveGames();
setInterval(refreshLiveGames, LIVE_GAMES_POLL_MS);
