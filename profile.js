async function renderProfilePage() {
  const container = document.getElementById('profileContent');
  const user = Auth.getUser();

  if (!user) {
    container.innerHTML = '<p>Sign in (top right) to see your profile.</p>';
    return;
  }

  const profile = Auth.getProfile();
  if (!profile) {
    container.innerHTML = '<p>Could not load your profile.</p>';
    return;
  }

  const { data: games, error } = await supabaseClient
    .from('games')
    .select('*, player1:player1_id(username), player2:player2_id(username)')
    .or(`player1_id.eq.${user.id},player2_id.eq.${user.id}`)
    .order('ended_at', { ascending: false })
    .limit(20);

  if (error) {
    container.innerHTML = `<p>Could not load match history: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (games || []).map((g) => {
    const isP1 = g.player1_id === user.id;
    const myScore = isP1 ? g.score1 : g.score2;
    const oppScore = isP1 ? g.score2 : g.score1;
    const oppName = isP1 ? (g.player2 ? g.player2.username : 'Guest') : (g.player1 ? g.player1.username : 'Guest');
    const myPlayerNum = isP1 ? 1 : 2;
    const resultText = g.winner == null ? 'Tie' : (g.winner === myPlayerNum ? 'Win' : 'Loss');
    const date = new Date(g.ended_at).toLocaleString();
    return `<tr>
      <td>${date}</td>
      <td>${escapeHtml(g.mode)}</td>
      <td>${escapeHtml(oppName)}</td>
      <td>${myScore} - ${oppScore}</td>
      <td class="result-${resultText.toLowerCase()}">${resultText}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <h2>${escapeHtml(profile.username)}</h2>
    <div class="profile-stats">
      <div class="stat"><div class="stat-value">${profile.elo_rating}</div><div class="stat-label">ELO</div></div>
      <div class="stat"><div class="stat-value">${profile.games_played}</div><div class="stat-label">Games</div></div>
      <div class="stat"><div class="stat-value">${profile.wins}</div><div class="stat-label">Wins</div></div>
      <div class="stat"><div class="stat-value">${profile.losses}</div><div class="stat-label">Losses</div></div>
      <div class="stat"><div class="stat-value">${profile.ties}</div><div class="stat-label">Ties</div></div>
    </div>
    <h3>Recent Games</h3>
    <table class="games-table">
      <thead><tr><th>Date</th><th>Mode</th><th>Opponent</th><th>Score</th><th>Result</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No games recorded yet.</td></tr>'}</tbody>
    </table>
  `;
}

Auth.onAuthChange(renderProfilePage);
renderProfilePage();
