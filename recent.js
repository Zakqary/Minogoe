// "private" is the internal mode value (still what's stored in the
// database and used in code) for what the site now calls "Direct Connect"
// everywhere a user actually sees it - a raw room-code connection between
// two specific people was never actually kept private from anyone who
// knows/finds the code (and, since the live spectate feature, is now
// publicly listed like any other match), so the old name overpromised.
function modeLabel(mode) {
  return mode === 'private' ? 'Direct Connect' : mode;
}

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

async function renderRecentGames() {
  const container = document.getElementById('recentGamesContent');

  const { data, error } = await supabaseClient
    .from('games')
    .select('*, player1:player1_id(id, username), player2:player2_id(id, username)')
    .order('ended_at', { ascending: false })
    .limit(20);

  if (error) {
    container.innerHTML = `<p>Could not load recent games: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (data || []).map((g) => {
    const p1Name = g.player1 ? g.player1.username : 'Guest';
    const p2Name = g.player2 ? g.player2.username : (g.mode === 'bot' ? 'Bot' : 'Guest');
    const p1Link = playerLink(g.player1 ? g.player1.id : null, p1Name);
    const p2Link = playerLink(g.player2 ? g.player2.id : null, p2Name);
    // A forfeit/timeout win isn't decided by the board tally - show W/FF
    // instead of a territory score that was never actually the deciding
    // factor for how the game ended.
    const scoreText = g.forfeit
      ? (g.winner === 1 ? 'W - FF' : 'FF - W')
      : `${g.score1} - ${g.score2}`;
    return `<tr>
      <td>${p1Link} vs ${p2Link}</td>
      <td>${scoreText}</td>
      <td>${escapeHtml(modeLabel(g.mode))}</td>
      <td>${timeAgo(g.ended_at)}</td>
      <td><a href="replay.html?game=${encodeURIComponent(g.id)}">Replay</a></td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>Players</th><th>Score</th><th>Mode</th><th>When</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No games played yet.</td></tr>'}</tbody>
    </table>
  `;
}

renderRecentGames();
