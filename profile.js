async function renderProfilePage() {
  const container = document.getElementById('profileContent');
  const params = new URLSearchParams(location.search);
  const viewUserId = params.get('user');

  let profile;

  if (viewUserId) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', viewUserId)
      .single();
    if (error || !data) {
      container.innerHTML = '<p>Could not find that player.</p>';
      return;
    }
    profile = data;
  } else {
    const user = Auth.getUser();
    if (!user) {
      container.innerHTML = '<p>Sign in (top right) to see your profile.</p>';
      return;
    }
    profile = Auth.getProfile();
    if (!profile) {
      container.innerHTML = '<p>Could not load your profile.</p>';
      return;
    }
  }

  const userId = profile.id;

  await Catalog.ready();

  const { data: games, error } = await supabaseClient
    .from('games')
    .select('*, player1:player1_id(id, username), player2:player2_id(id, username)')
    .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
    .order('ended_at', { ascending: false })
    .limit(20);

  if (error) {
    container.innerHTML = `<p>Could not load match history: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (games || []).map((g) => {
    const isP1 = g.player1_id === userId;
    const myScore = isP1 ? g.score1 : g.score2;
    const oppScore = isP1 ? g.score2 : g.score1;
    const opp = isP1 ? g.player2 : g.player1;
    const oppName = opp ? opp.username : (g.mode === 'bot' ? 'Bot' : 'Guest');
    const oppLink = playerLink(opp ? opp.id : null, oppName);
    const myPlayerNum = isP1 ? 1 : 2;
    const resultText = g.winner == null ? 'Tie' : (g.winner === myPlayerNum ? 'Win' : 'Loss');
    const date = new Date(g.ended_at).toLocaleString();
    // A forfeit/timeout win isn't decided by the board tally - show W/FF
    // instead of a territory score that was never actually the deciding
    // factor (and can even make the winner look like they had fewer points).
    const scoreText = g.forfeit
      ? (g.winner === myPlayerNum ? 'W - FF' : 'FF - W')
      : `${myScore} - ${oppScore}`;
    return `<tr>
      <td>${date}</td>
      <td>${escapeHtml(g.mode)}</td>
      <td>${oppLink}</td>
      <td>${scoreText}</td>
      <td class="result-${resultText.toLowerCase()}">${resultText}</td>
      <td><a href="replay.html?game=${encodeURIComponent(g.id)}">Replay</a></td>
    </tr>`;
  }).join('');

  const joinedText = profile.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  container.innerHTML = `
    <h2 class="profile-heading">${avatarHtml(profile.avatar_id, 36)} ${escapeHtml(profile.username)} ${titleBadgeHtml(profile.title_id)}</h2>
    ${joinedText ? `<div class="profile-joined">Account created on ${escapeHtml(joinedText)}</div>` : ''}
    <div class="profile-stats">
      <div class="stat"><div class="stat-value">${profile.elo_rating}</div><div class="stat-label">ELO</div></div>
      <div class="stat"><div class="stat-value">${profile.games_played}</div><div class="stat-label">Games</div></div>
      <div class="stat"><div class="stat-value">${profile.wins}</div><div class="stat-label">Wins</div></div>
      <div class="stat"><div class="stat-value">${profile.losses}</div><div class="stat-label">Losses</div></div>
      <div class="stat"><div class="stat-value">${profile.ties}</div><div class="stat-label">Ties</div></div>
    </div>
    <h3>Recent Games</h3>
    <table class="games-table">
      <thead><tr><th>Date</th><th>Mode</th><th>Opponent</th><th>Score</th><th>Result</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">No games recorded yet.</td></tr>'}</tbody>
    </table>
  `;
}

Auth.onAuthChange(renderProfilePage);
renderProfilePage();
