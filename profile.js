// Same formatting as singleplayer.js's own formatTime() - duplicated
// rather than shared since profile.js doesn't otherwise load that page's
// script at all.
function formatSpTime(ms) {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

async function renderProfilePage() {
  const container = document.getElementById('profileContent');
  const params = new URLSearchParams(location.search);
  const viewUserId = params.get('user');

  let profile;

  if (viewUserId) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*, companion:companion_mino_id(id, color, rarity, modifier, stage, name)')
      .eq('id', viewUserId)
      .single();
    if (error || !data) {
      container.innerHTML = '<p>Could not find that player.</p>';
      return;
    }
    profile = data;
  } else {
    // Auth resolves asynchronously - without this check, the very first
    // render (right after page load, before the first onAuthStateChange
    // event fires) would see getUser()/getProfile() both still null and
    // briefly flash "sign in" or "could not load your profile" even for an
    // already-logged-in user, before the real state arrives a moment later.
    if (!Auth.isInitialized) {
      container.innerHTML = '<p>Loading...</p>';
      return;
    }
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

  // Rank on the ELO leaderboard - number of players with a strictly higher
  // rating, plus one. A count query instead of fetching every profile.
  const { count: higherEloCount, error: rankError } = await supabaseClient
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .gt('elo_rating', profile.elo_rating);
  const rank = rankError ? null : (higherEloCount ?? 0) + 1;

  // Only meaningful when looking at someone ELSE's profile while signed
  // in - there's no "vs yourself" record to show otherwise.
  const myUserId = Auth.getUser()?.id ?? null;
  let headToHeadHtml = '';
  if (myUserId && myUserId !== userId) {
    const { data: h2hGames } = await supabaseClient
      .from('games')
      .select('player1_id, winner')
      .or(`and(player1_id.eq.${myUserId},player2_id.eq.${userId}),and(player1_id.eq.${userId},player2_id.eq.${myUserId})`);

    if (h2hGames && h2hGames.length > 0) {
      // A tie (winner is null) is folded into a win for whoever was
      // player1 in that specific game - same reclassification as
      // schema.sql's aggregate counters (Phase 28), since ties are no
      // longer reachable under the current 0.5 handicap.
      let myWins = 0, myLosses = 0;
      for (const g of h2hGames) {
        const iWasP1 = g.player1_id === myUserId;
        if (g.winner == null) {
          if (iWasP1) myWins++; else myLosses++;
        } else if ((g.winner === 1) === iWasP1) {
          myWins++;
        } else {
          myLosses++;
        }
      }
      headToHeadHtml = `
        <h3>Your Head-to-Head vs ${escapeHtml(profile.username)}</h3>
        <div class="profile-stats">
          <div class="stat"><div class="stat-value">${h2hGames.length}</div><div class="stat-label">Games</div></div>
          <div class="stat"><div class="stat-value">${myWins}</div><div class="stat-label">Your Wins</div></div>
          <div class="stat"><div class="stat-value">${myLosses}</div><div class="stat-label">Your Losses</div></div>
        </div>
      `;
    }
  }

  // Lower is better for Speedrun/Eogonim (fastest time / fewest captured
  // squares), but HIGHER is better for Ascension (more rounds cleared) -
  // rank is "how many OTHER runs in that mode beat this one", plus one,
  // same count-query-instead-of-fetch-everyone technique as the ELO rank
  // above, just flipped (.gt instead of .lt) for ascension. Only shown for
  // a mode this player actually has a personal best in.
  const { data: spRuns } = await supabaseClient
    .from('singleplayer_runs')
    .select('mode, time_ms, score')
    .eq('user_id', userId);

  let singleplayerHtml = '';
  if (spRuns && spRuns.length > 0) {
    const boxes = [];
    for (const run of spRuns) {
      if (run.mode === 'speedrun') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'speedrun')
          .lt('time_ms', run.time_ms);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Speedrun &middot; ${formatSpTime(run.time_ms)}</div></div>`);
      } else if (run.mode === 'eogonim') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'eogonim')
          .lt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Eogonim &middot; ${run.score} captured</div></div>`);
      } else if (run.mode === 'ascension') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'ascension')
          .gt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Ascension &middot; ${run.score} round${run.score === 1 ? '' : 's'}</div></div>`);
      }
    }
    if (boxes.length > 0) {
      singleplayerHtml = `
        <h3>Singleplayer Leaderboards</h3>
        <div class="profile-stats">${boxes.join('')}</div>
      `;
    }
  }

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

  const companionHtml = profile.companion
    ? `<span class="profile-companion" title="${escapeHtml(minoLabel(profile.companion))}${profile.companion.name ? ' - ' + escapeHtml(profile.companion.name) : ''}">${minoVisualHtml(profile.companion, 32)}</span>`
    : '';

  // pvp_*/bot_* split out a vs-bot practice game from a "regular" game
  // against a real opponent (schema.sql Phase 23) - shown as two clearly
  // separate stat rows instead of blending them into one number the way
  // games_played/wins/losses (still used as-is elsewhere, e.g. the
  // leaderboard) do. The bot row only appears once there's actually
  // something to show, so most profiles aren't cluttered with a zeroed-
  // out row for a mode they've never touched. No ties column - ties are
  // no longer reachable under the current 0.5 handicap, and historical
  // ones are folded into wins (schema.sql Phase 28).
  const botStatsHtml = profile.bot_games_played > 0 ? `
    <h3>vs Bot</h3>
    <div class="profile-stats">
      <div class="stat"><div class="stat-value">${profile.bot_games_played}</div><div class="stat-label">Games</div></div>
      <div class="stat"><div class="stat-value">${profile.bot_wins}</div><div class="stat-label">Wins</div></div>
      <div class="stat"><div class="stat-value">${profile.bot_losses}</div><div class="stat-label">Losses</div></div>
    </div>
  ` : '';

  // numeric columns (score1/score2 and anything summed from them) come
  // back from PostgREST as strings, not numbers, to avoid float precision
  // loss - same reason stats.js wraps every numeric RPC result in Number().
  // Averaged over pvp_scored_games (non-forfeit pvp games only), NOT
  // pvp_games_played - a forfeit's score1/score2 is just whatever the
  // board happened to look like when someone quit/timed out, not a real
  // final score (schema.sql Phase 38), so including it in the average
  // would dilute/skew it against a number that was never meaningful.
  const pvpScoredGames = Number(profile.pvp_scored_games) || 0;
  const pointsFor = Number(profile.pvp_points_for) || 0;
  const pointsAgainst = Number(profile.pvp_points_against) || 0;
  const avgDiff = pvpScoredGames > 0 ? (pointsFor - pointsAgainst) / pvpScoredGames : 0;
  const avgDiffText = pvpScoredGames > 0 ? `${avgDiff > 0 ? '+' : ''}${avgDiff.toFixed(1)}` : '-';
  const formatPoints = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  container.innerHTML = `
    <h2 class="profile-heading">${avatarHtml(profile.avatar_id, 36)} ${escapeHtml(profile.username)} ${titleBadgeHtml(profile.title_id)} ${companionHtml}</h2>
    ${joinedText ? `<div class="profile-joined">Account created on ${escapeHtml(joinedText)}</div>` : ''}
    <div class="profile-stats">
      <div class="stat"><div class="stat-value">${rank != null ? '#' + rank : '-'}</div><div class="stat-label">Rank</div></div>
      <div class="stat"><div class="stat-value">${profile.elo_rating}</div><div class="stat-label">ELO</div></div>
      <div class="stat"><div class="stat-value">${profile.highest_elo}</div><div class="stat-label">Peak ELO</div></div>
      <div class="stat"><div class="stat-value">${profile.pvp_games_played}</div><div class="stat-label">Games</div></div>
      <div class="stat"><div class="stat-value">${profile.pvp_wins}</div><div class="stat-label">Wins</div></div>
      <div class="stat"><div class="stat-value">${profile.pvp_losses}</div><div class="stat-label">Losses</div></div>
      <div class="stat"><div class="stat-value">${profile.highest_ranked_win_streak}</div><div class="stat-label">Best Ranked Streak</div></div>
      <div class="stat"><div class="stat-value">${avgDiffText}</div><div class="stat-label">Avg Point Diff</div></div>
      <div class="stat"><div class="stat-value">${formatPoints(pointsFor)}</div><div class="stat-label">Points Scored</div></div>
      <div class="stat"><div class="stat-value">${formatPoints(pointsAgainst)}</div><div class="stat-label">Points Against</div></div>
    </div>
    ${botStatsHtml}
    ${singleplayerHtml}
    ${headToHeadHtml}
    <h3>Recent Games</h3>
    <table class="games-table">
      <thead><tr><th>Date</th><th>Mode</th><th>Opponent</th><th>Score</th><th>Result</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">No games recorded yet.</td></tr>'}</tbody>
    </table>
  `;
}

Auth.onAuthChange(renderProfilePage);
renderProfilePage();
