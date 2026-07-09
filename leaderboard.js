async function renderLeaderboard() {
  const container = document.getElementById('leaderboardContent');

  const { data, error } = await supabaseClient
    .from('profiles')
    .select('username, elo_rating, games_played, wins, losses, ties')
    .order('elo_rating', { ascending: false })
    .limit(50);

  if (error) {
    container.innerHTML = `<p>Could not load leaderboard: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (data || []).map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(p.username)}</td>
      <td>${p.elo_rating}</td>
      <td>${p.games_played}</td>
      <td>${p.wins}</td>
      <td>${p.losses}</td>
      <td>${p.ties}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead>
        <tr><th>#</th><th>Player</th><th>ELO</th><th>Games</th><th>W</th><th>L</th><th>T</th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="7">No players yet.</td></tr>'}</tbody>
    </table>
  `;
}

renderLeaderboard();
