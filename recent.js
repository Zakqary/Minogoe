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
    .select('*, player1:player1_id(username), player2:player2_id(username)')
    .order('ended_at', { ascending: false })
    .limit(20);

  if (error) {
    container.innerHTML = `<p>Could not load recent games: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (data || []).map((g) => {
    const p1Name = g.player1 ? g.player1.username : 'Guest';
    const p2Name = g.player2 ? g.player2.username : (g.mode === 'bot' ? 'Bot' : 'Guest');
    return `<tr>
      <td>${escapeHtml(p1Name)} vs ${escapeHtml(p2Name)}</td>
      <td>${g.score1} - ${g.score2}</td>
      <td>${escapeHtml(g.mode)}</td>
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
