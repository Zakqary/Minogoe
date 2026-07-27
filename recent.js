// "private" is the internal mode value (still what's stored in the
// database and used in code) for what the site now calls "Direct Connect"
// everywhere a user actually sees it - a raw room-code connection between
// two specific people was never actually kept private from anyone who
// knows/finds the code (and, since the live spectate feature, is now
// publicly listed like any other match), so the old name overpromised.
function modeLabel(mode) {
  return mode === 'private' ? 'direct connect' : mode;
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

// Same formatting as singleplayer.js's own formatTime() - duplicated
// rather than shared since recent.js doesn't otherwise load that page's
// script at all.
function formatSpTime(ms) {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

const DUEL_MODE_LABELS = {
  speedrun: 'Speedrun', eogonim: 'Eogonim', blight: 'Blight', godbot: 'GodBot',
  curse: 'Curse', shrink: 'Shrink', mutation: 'Mutation', puzzle: 'Puzzle',
};

// A round's stored player{1,2}_result is the same {completed, metric,
// timeMs} shape duel.js's own normalizeResult() produces (see schema.sql
// Phase 63) - a round recorded before that phase shipped won't have it at
// all, hence the leading null check.
function formatDuelRoundValue(result, mode) {
  if (!result) return '-';
  if (mode === 'speedrun' || mode === 'puzzle') {
    return result.completed ? formatSpTime(result.timeMs) : 'DNF';
  }
  if (result.metric == null) return '-';
  if (mode === 'godbot') return `${result.metric > 0 ? '+' : ''}${result.metric}`;
  return String(result.metric);
}

// The expandable per-round breakdown shown under a duel match row - one
// line per minigame actually played (best-of-3 plus sudden death if it
// went that far), with both players' real score/time, not just who won.
function duelDetailTableHtml(rounds, p1Name, p2Name) {
  const roundRows = rounds.map((r) => {
    const label = r.round_winner == null ? 'Tied' : `${escapeHtml(r.round_winner === 1 ? p1Name : p2Name)} won`;
    return `<tr>
      <td>${escapeHtml(DUEL_MODE_LABELS[r.mode] || r.mode)}</td>
      <td>${formatDuelRoundValue(r.player1_result, r.mode)}</td>
      <td>${formatDuelRoundValue(r.player2_result, r.mode)}</td>
      <td>${label}</td>
    </tr>`;
  }).join('');
  return `
    <table class="duel-detail-table">
      <thead><tr><th>Minigame</th><th>${escapeHtml(p1Name)}</th><th>${escapeHtml(p2Name)}</th><th>Result</th></tr></thead>
      <tbody>${roundRows}</tbody>
    </table>
  `;
}

// Wires up every already-inserted .duel-summary-row's click-to-expand
// toggle - must run AFTER the row HTML actually lands in the DOM
// (container.innerHTML = ...), same as leaderboard.js's own post-render
// sortable-column wiring.
function wireDuelDetailToggles(container) {
  for (const row of container.querySelectorAll('.duel-summary-row')) {
    row.addEventListener('click', () => {
      const detail = document.getElementById(row.dataset.detailTarget);
      if (detail) detail.style.display = detail.style.display === 'none' ? '' : 'none';
    });
  }
}

// Plain comma-separated name list, seat order - for the Players column.
function ffaPlayersHtml(players) {
  return [...players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => playerLink(p.profiles ? p.profiles.id : null, p.profiles ? p.profiles.username : 'Guest'))
    .join(', ');
}

// Score display for an ffa_game_players row set, already in rank order -
// no need to also print "#1"/"#2"/etc next to each name, since the rank is
// entirely implied by the listed order (and repeating it for all 4 players
// was making this column absurdly wide, distorting the whole table).
function ffaStandingsHtml(players) {
  return [...players]
    .sort((a, b) => a.rank - b.rank)
    .map((p) => `${escapeHtml(p.profiles ? p.profiles.username : 'Guest')} (${p.score})`)
    .join(', ');
}

async function renderRecentGames() {
  const container = document.getElementById('recentGamesContent');

  const [{ data, error }, { data: ffaData, error: ffaError }, { data: duelData, error: duelError }] = await Promise.all([
    supabaseClient
      .from('games')
      .select('*, player1:player1_id(id, username), player2:player2_id(id, username)')
      .order('ended_at', { ascending: false })
      .limit(20),
    supabaseClient
      .from('ffa_games')
      .select('*, ffa_game_players(seat, score, rank, profiles:player_id(id, username))')
      .eq('abandoned', false)
      .order('ended_at', { ascending: false })
      .limit(20),
    supabaseClient
      .from('duel_matches')
      .select('*, player1:player1_id(id, username), player2:player2_id(id, username)')
      .order('ended_at', { ascending: false })
      .limit(20),
  ]);

  if (error && ffaError && duelError) {
    container.innerHTML = `<p>Could not load recent games: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const regularRows = (data || []).map((g) => {
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
    return {
      endedAt: g.ended_at,
      html: `<tr>
        <td>${p1Link} vs ${p2Link}</td>
        <td>${scoreText}</td>
        <td>${escapeHtml(modeLabel(g.mode))}</td>
        <td>${timeAgo(g.ended_at)}</td>
        <td><a href="replay.html?game=${encodeURIComponent(g.id)}">Replay</a></td>
      </tr>`,
    };
  });

  const ffaRows = (ffaData || []).map((g) => ({
    endedAt: g.ended_at,
    html: `<tr>
      <td>${ffaPlayersHtml(g.ffa_game_players || [])}</td>
      <td>${ffaStandingsHtml(g.ffa_game_players || [])}</td>
      <td>Free-For-All</td>
      <td>${timeAgo(g.ended_at)}</td>
      <td><a href="replay.html?ffa=${encodeURIComponent(g.id)}">Replay</a></td>
    </tr>`,
  }));

  // Score here is the round tally (best-of-3 plus sudden death), derived
  // from the jsonb round log rather than a stored column - duel_matches
  // only stores the overall winner (1 or 2), not a running round score.
  // No replay link - duels don't record a move log/replay the way a
  // regular 2-player game does.
  // Click a duel row to expand a per-minigame breakdown (duelDetailTableHtml()).
  const duelRows = (duelData || []).map((g) => {
    const p1Name = g.player1 ? g.player1.username : 'Guest';
    const p2Name = g.player2 ? g.player2.username : 'Guest';
    const p1Link = playerLink(g.player1 ? g.player1.id : null, p1Name);
    const p2Link = playerLink(g.player2 ? g.player2.id : null, p2Name);
    const rounds = g.rounds || [];
    const p1Wins = rounds.filter((r) => r.round_winner === 1).length;
    const p2Wins = rounds.filter((r) => r.round_winner === 2).length;
    const detailId = `duelDetail-${g.id}`;
    return {
      endedAt: g.ended_at,
      html: `<tr class="duel-summary-row" data-detail-target="${detailId}">
        <td>${p1Link} vs ${p2Link}</td>
        <td>${p1Wins} - ${p2Wins}</td>
        <td>Minigame Duel &#9662;</td>
        <td>${timeAgo(g.ended_at)}</td>
        <td></td>
      </tr>
      <tr class="duel-detail-container" id="${detailId}" style="display:none;">
        <td colspan="5">${duelDetailTableHtml(rounds, p1Name, p2Name)}</td>
      </tr>`,
    };
  });

  const rows = [...regularRows, ...ffaRows, ...duelRows]
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))
    .slice(0, 20)
    .map((r) => r.html)
    .join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>Players</th><th>Score</th><th>Mode</th><th>When</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No games played yet.</td></tr>'}</tbody>
    </table>
  `;
  wireDuelDetailToggles(container);
}

renderRecentGames();
