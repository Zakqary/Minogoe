// Same formatting as singleplayer.js's own formatTime() - duplicated
// rather than shared since profile.js doesn't otherwise load that page's
// script at all.
function formatSpTime(ms) {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// "private" is the internal mode value (still what's stored in the
// database and used in code) for what the site now calls "Direct Connect"
// everywhere a user actually sees it - see recent.js's own copy of this
// function for the full reasoning.
function modeLabel(mode) {
  return mode === 'private' ? 'direct connect' : mode;
}

// Achievement badges - purely derived from stats already present on the
// profile row, so there's no separate "earned" table or grant trigger to
// maintain: every requirement here is just a threshold on a column this
// site already tracks (games_played, pvp_games_played, pvp_wins,
// highest_ranked_win_streak, highest_elo). Pentagon shape ties into the
// site's pentomino theme. "Surpass" is treated inclusively (>=), same as
// every other threshold here, to avoid a confusing "100/100 but still
// locked" display at the exact boundary.
const BADGES = [
  { id: 'player', name: 'Player', description: 'Play 100 games', statKey: 'games_played', threshold: 100 },
  { id: 'peoples_person', name: "People's Person", description: 'Play 100 pvp games', statKey: 'pvp_games_played', threshold: 100 },
  { id: 'winner', name: 'Winner', description: 'Win 50 pvp games', statKey: 'pvp_wins', threshold: 50 },
  { id: 'hot_stuff', name: 'Hot Stuff', description: 'Win 5 ranked matches in a row', statKey: 'highest_ranked_win_streak', threshold: 5 },
  { id: 'hottest_stuff', name: 'Hottest Stuff', description: 'Win 10 ranked matches in a row', statKey: 'highest_ranked_win_streak', threshold: 10 },
  { id: 'breaker', name: 'Breaker', description: 'Surpass 1300 ELO', statKey: 'highest_elo', threshold: 1300 },
  { id: 'elite', name: 'Elite', description: 'Surpass 1500 ELO', statKey: 'highest_elo', threshold: 1500 },
  { id: 'ranked_regular', name: 'Ranked Regular', description: 'Play 50 ranked games', statKey: 'ranked_games_played', threshold: 50 },
  { id: 'green_thumb', name: 'Green Thumb', description: 'Grow your garden to 5 pots', statKey: 'garden_pot_count', threshold: 5 },
  { id: 'coin_collector', name: 'Coin Collector', description: 'Earn 100 lifetime coins', statKey: 'lifetime_coins_earned', threshold: 100 },
];

function badgesHtml(profile) {
  const items = BADGES.map((b) => {
    const value = Number(profile[b.statKey]) || 0;
    const earned = value >= b.threshold;
    const progress = Math.min(value, b.threshold);
    const tooltip = earned
      ? `${b.name}: ${b.description} (earned)`
      : `${b.name}: ${b.description} - ${progress}/${b.threshold}`;
    return `
      <div class="badge${earned ? '' : ' locked'}" title="${escapeHtml(tooltip)}">
        <div class="badge-icon"></div>
        <div class="badge-name">${escapeHtml(b.name)}</div>
      </div>
    `;
  }).join('');
  return `
    <h3>Badges</h3>
    <div class="badge-grid">${items}</div>
  `;
}

async function renderProfilePage() {
  const container = document.getElementById('profileContent');
  const params = new URLSearchParams(location.search);
  const viewUserId = params.get('user');

  let profile;

  if (viewUserId) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*, companion:companion_mino_id(id, color, rarity, modifier, gradient, stage, name)')
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
  // Only meaningful for a player who's actually played a ranked game -
  // everyone else sits at the untouched 1200 default, which was never
  // earned and shouldn't be treated like a real rating (same reasoning as
  // leaderboard.js's own "Unranked" handling). Both the comparison pool
  // AND this profile's own rank/elo/peak-elo display are gated on that,
  // so a real ranked player's rank is computed only against other
  // genuinely-ranked players too, not diluted by never-played accounts
  // parked at the default.
  let rank = null;
  if (profile.ranked_games_played > 0) {
    const { count: higherEloCount, error: rankError } = await supabaseClient
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .gt('elo_rating', profile.elo_rating)
      .gt('ranked_games_played', 0);
    rank = rankError ? null : (higherEloCount ?? 0) + 1;
  }

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

  // Lower is better for Speedrun/Eogonim/Blind Eogonim (fastest time / fewest
  // captured squares), but HIGHER is better for Ascension (more rounds
  // cleared) -
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
      } else if (run.mode === 'blindeogonim') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'blindeogonim')
          .lt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Blind Eogonim &middot; ${run.score} captured</div></div>`);
      } else if (run.mode === 'ascension') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'ascension')
          .gt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Ascension &middot; ${run.score} round${run.score === 1 ? '' : 's'}</div></div>`);
      } else if (run.mode === 'blight') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'blight')
          .gt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Blight &middot; ${run.score} captured</div></div>`);
      } else if (run.mode === 'godbot') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'godbot')
          .gt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">GodBot &middot; ${run.score > 0 ? '+' : ''}${run.score}</div></div>`);
      } else if (run.mode === 'curse') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'curse')
          .lt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Curse &middot; ${run.score} open</div></div>`);
      } else if (run.mode === 'shrink') {
        const { count } = await supabaseClient
          .from('singleplayer_runs')
          .select('id', { count: 'exact', head: true })
          .eq('mode', 'shrink')
          .lt('score', run.score);
        boxes.push(`<div class="stat"><div class="stat-value">#${(count ?? 0) + 1}</div><div class="stat-label">Shrink &middot; ${run.score} lost</div></div>`);
      }
    }
    if (boxes.length > 0) {
      singleplayerHtml = `
        <h3>Minigame Leaderboards</h3>
        <div class="profile-stats">${boxes.join('')}</div>
      `;
    }
  }

  const [{ data: games, error }, { data: myFfaRows, error: ffaError }] = await Promise.all([
    supabaseClient
      .from('games')
      .select('*, player1:player1_id(id, username), player2:player2_id(id, username)')
      .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
      .order('ended_at', { ascending: false })
      .limit(20),
    // My own seat in each ffa game I played, plus its parent game's
    // ended_at/abandoned - a single, unambiguous embed direction (many
    // ffa_game_players rows -> one ffa_games row), unlike trying to also
    // embed the OTHER 3 seats' names in the same query, which would mean
    // going back out from ffa_games to ffa_game_players a second time (the
    // same table this query already starts from) - fetched separately
    // below instead, once the actual game ids are known, rather than
    // relying on that riskier self-referencing embed shape.
    supabaseClient
      .from('ffa_game_players')
      .select('score, rank, ffa_game_id, ffa_games(ended_at, abandoned)')
      .eq('player_id', userId)
      .limit(20),
  ]);

  if (error && ffaError) {
    container.innerHTML = `<p>Could not load match history: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const validFfaRows = (myFfaRows || []).filter((p) => p.ffa_games && !p.ffa_games.abandoned);
  const ffaGameIds = validFfaRows.map((p) => p.ffa_game_id);
  const { data: ffaOtherSeats } = ffaGameIds.length > 0
    ? await supabaseClient
        .from('ffa_game_players')
        .select('ffa_game_id, profiles:player_id(id, username)')
        .in('ffa_game_id', ffaGameIds)
    : { data: [] };
  const ffaSeatsByGame = new Map();
  for (const s of (ffaOtherSeats || [])) {
    if (!ffaSeatsByGame.has(s.ffa_game_id)) ffaSeatsByGame.set(s.ffa_game_id, []);
    ffaSeatsByGame.get(s.ffa_game_id).push(s);
  }

  const regularRows = (games || []).map((g) => {
    const isP1 = g.player1_id === userId;
    const myScore = isP1 ? g.score1 : g.score2;
    const oppScore = isP1 ? g.score2 : g.score1;
    const opp = isP1 ? g.player2 : g.player1;
    const oppName = opp ? opp.username : (g.mode === 'bot' ? 'Bot' : 'Guest');
    const oppLink = playerLink(opp ? opp.id : null, oppName);
    const myPlayerNum = isP1 ? 1 : 2;
    const resultText = g.winner == null ? 'Tie' : (g.winner === myPlayerNum ? 'Win' : 'Loss');
    // A forfeit/timeout win isn't decided by the board tally - show W/FF
    // instead of a territory score that was never actually the deciding
    // factor (and can even make the winner look like they had fewer points).
    const scoreText = g.forfeit
      ? (g.winner === myPlayerNum ? 'W - FF' : 'FF - W')
      : `${myScore} - ${oppScore}`;
    return {
      endedAt: g.ended_at,
      html: `<tr>
        <td>${new Date(g.ended_at).toLocaleString()}</td>
        <td>${escapeHtml(modeLabel(g.mode))}</td>
        <td>${oppLink}</td>
        <td>${scoreText}</td>
        <td class="result-${resultText.toLowerCase()}">${resultText}</td>
        <td><a href="replay.html?game=${encodeURIComponent(g.id)}">Replay</a></td>
      </tr>`,
    };
  });

  const ffaRows = validFfaRows.map((p) => {
    const others = (ffaSeatsByGame.get(p.ffa_game_id) || [])
      .filter((s) => s.profiles && s.profiles.id !== userId)
      .map((s) => playerLink(s.profiles.id, s.profiles.username))
      .join(', ');
    // rank = 1 counts as a win (ties for 1st included) - same "ties count
    // as wins" convention profiles.ffa_wins itself uses (schema.sql
    // Phase 55) - anything else just shows the actual placement, since
    // "Loss" alone would lose the "so close" of just missing 1st.
    const resultText = p.rank === 1 ? 'Win' : `#${p.rank}`;
    return {
      endedAt: p.ffa_games.ended_at,
      html: `<tr>
        <td>${new Date(p.ffa_games.ended_at).toLocaleString()}</td>
        <td>Free-For-All</td>
        <td>${others}</td>
        <td>${p.score}</td>
        <td class="result-${p.rank === 1 ? 'win' : 'loss'}">${resultText}</td>
        <td><a href="replay.html?ffa=${encodeURIComponent(p.ffa_game_id)}">Replay</a></td>
      </tr>`,
    };
  });

  const rows = [...regularRows, ...ffaRows]
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))
    .slice(0, 20)
    .map((r) => r.html)
    .join('');

  const joinedText = profile.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  const companionHtml = profile.companion
    ? `<span class="profile-companion" title="${escapeHtml(minoLabel(profile.companion))}${profile.companion.name ? ' - ' + escapeHtml(profile.companion.name) : ''}">${minoVisualHtml(profile.companion, 32)}</span>`
    : '';

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
    ${badgesHtml(profile)}
    <div class="profile-stats">
      <div class="stat"><div class="stat-value">${profile.ranked_games_played > 0 ? (rank != null ? '#' + rank : '-') : 'Unranked'}</div><div class="stat-label">Rank</div></div>
      <div class="stat"><div class="stat-value">${profile.ranked_games_played > 0 ? profile.elo_rating : 'Unranked'}</div><div class="stat-label">ELO</div></div>
      <div class="stat"><div class="stat-value">${profile.ranked_games_played > 0 ? profile.highest_elo : 'Unranked'}</div><div class="stat-label">Peak ELO</div></div>
      <div class="stat"><div class="stat-value">${profile.pvp_games_played}</div><div class="stat-label">Games</div></div>
      <div class="stat"><div class="stat-value">${profile.pvp_wins}</div><div class="stat-label">Wins</div></div>
      <div class="stat"><div class="stat-value">${profile.pvp_losses}</div><div class="stat-label">Losses</div></div>
      <div class="stat"><div class="stat-value">${profile.highest_ranked_win_streak}</div><div class="stat-label">Best Ranked Streak</div></div>
      <div class="stat"><div class="stat-value">${avgDiffText}</div><div class="stat-label">Avg Point Diff</div></div>
      <div class="stat"><div class="stat-value">${formatPoints(pointsFor)}</div><div class="stat-label">Points Scored</div></div>
      <div class="stat"><div class="stat-value">${formatPoints(pointsAgainst)}</div><div class="stat-label">Points Against</div></div>
    </div>
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
