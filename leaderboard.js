// Columns are addressed by a neutral key regardless of whether "ranked
// matches only" is checked - fieldFor() resolves which underlying profile
// column that key actually reads from in the current mode, so the sort
// column doesn't need to be remapped when the checkbox is toggled.
// No ties column - ties are no longer reachable under the current 0.5
// handicap, and historical ones are folded into wins (schema.sql Phase 28).
const COLUMNS = [
  { key: 'username', label: 'Player' },
  { key: 'elo_rating', label: 'ELO' },
  { key: 'games', label: 'Games' },
  { key: 'wins', label: 'W' },
  { key: 'losses', label: 'L' },
];

const FIELD_MAP = {
  all: { games: 'games_played', wins: 'wins', losses: 'losses' },
  ranked: { games: 'ranked_games_played', wins: 'ranked_wins', losses: 'ranked_losses' },
};

let players = null;
let rankedOnly = false;
let sortKey = 'elo_rating';
let sortDescending = true;

function fieldFor(key) {
  return FIELD_MAP[rankedOnly ? 'ranked' : 'all'][key] || key; // username/elo_rating pass through unchanged
}

async function loadLeaderboard() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, username, elo_rating, games_played, wins, losses, ranked_games_played, ranked_wins, ranked_losses, avatar_id, title_id');

  if (error) {
    document.getElementById('leaderboardContent').innerHTML = `<p>Could not load leaderboard: ${escapeHtml(error.message)}</p>`;
    return;
  }
  players = data || [];
  await Catalog.ready();
  renderLeaderboard();
}

// Takes the actual rank NUMBER (1224 competition ranking - see
// computeRankLabels() below), not a row index, so every player tied for
// e.g. rank 1 gets the gold styling, not just whichever one happens to
// render first. '-' (unranked, no numeric rank) never matches any of these.
function rankRowClass(rank) {
  if (rank === 1) return 'rank-gold';
  if (rank === 2) return 'rank-silver';
  if (rank === 3) return 'rank-bronze';
  if (rank === 4 || rank === 5) return 'rank-top5';
  return '';
}

// Standard competition ("1224") ranking: players tied on the active sort
// field share the same rank number, and the rank after a tie skips ahead
// by the tie's size (two players tied for #1 are both #1, the next
// distinct player is #3, not #2) - same idea as profile.js's own rank
// stat (a "how many players are strictly better than me, plus one" count).
// `rows` must already be sorted in the order they'll render. Unranked
// players (elo sort only) get '-' instead of a number - there's nothing
// meaningful to tie them on since their elo_rating is just the untouched
// default, not a real rating.
function computeRankLabels(rows, field) {
  const labels = [];
  let lastValue = null, lastRank = 0;
  rows.forEach((p, i) => {
    if (field === 'elo_rating' && p.ranked_games_played === 0) {
      labels.push('-');
      return;
    }
    const value = p[field];
    if (lastValue === null || value !== lastValue) {
      lastRank = i + 1;
      lastValue = value;
    }
    labels.push(lastRank);
  });
  return labels;
}

function renderLeaderboard() {
  const container = document.getElementById('leaderboardContent');
  if (!players) return;

  // "Ranked matches only" should mean an actual ranked leaderboard - a
  // player who's never queued ranked at all has nothing to rank on and
  // just clutters the list with a 0/0/0/0 row.
  const visible = rankedOnly ? players.filter((p) => p.ranked_games_played > 0) : players;

  // A player who's never queued ranked still carries the flat 1200 default
  // in elo_rating - sorting on that verbatim would rank them above every
  // real player below 1200, which is misleading since 1200 was never
  // actually earned. When sorting by ELO specifically, unranked players
  // (ranked_games_played === 0) always sink to the bottom regardless of
  // sort direction, and are shown as "Unranked" in the ELO cell below
  // rather than a number that looks like a real rating. Every other column
  // sorts normally - Games/W/L are all-modes counts here (unless "ranked
  // only" is checked, which already filters unranked players out entirely
  // via `visible` above), so there's no equivalent fake-default problem.
  const sorted = sortKey === 'elo_rating'
    ? [
        ...visible.filter((p) => p.ranked_games_played > 0).sort((a, b) => {
          if (a.elo_rating !== b.elo_rating) return sortDescending ? b.elo_rating - a.elo_rating : a.elo_rating - b.elo_rating;
          return 0;
        }),
        ...visible.filter((p) => p.ranked_games_played === 0).sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase())),
      ]
    : [...visible].sort((a, b) => {
        const field = fieldFor(sortKey);
        let av = a[field], bv = b[field];
        if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
        if (av < bv) return sortDescending ? 1 : -1;
        if (av > bv) return sortDescending ? -1 : 1;
        return 0;
      });

  const headerCells = COLUMNS.map((col) => {
    const active = col.key === sortKey;
    const arrow = active ? (sortDescending ? ' ▼' : ' ▲') : '';
    return `<th class="sortable-col${active ? ' sorted' : ''}" data-key="${col.key}">${escapeHtml(col.label)}${arrow}</th>`;
  }).join('');

  // Ties computed against whichever field is actually driving the current
  // sort (username sorting never ties, since usernames are unique).
  // fieldFor('elo_rating') passes through unchanged, so this still
  // correctly triggers computeRankLabels()'s "unranked" special case.
  const rankLabels = computeRankLabels(sorted, fieldFor(sortKey));

  const rows = sorted.map((p, i) => `
    <tr class="${rankRowClass(rankLabels[i])}">
      <td>${rankLabels[i]}</td>
      <td class="leaderboard-player-cell">${avatarHtml(p.avatar_id, 20)} <a href="profile.html?user=${encodeURIComponent(p.id)}">${escapeHtml(p.username)}</a> ${titleBadgeHtml(p.title_id)}</td>
      <td>${p.ranked_games_played > 0 ? p.elo_rating : 'Unranked'}</td>
      <td>${p[fieldFor('games')]}</td>
      <td>${p[fieldFor('wins')]}</td>
      <td>${p[fieldFor('losses')]}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>#</th>${headerCells}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${COLUMNS.length + 1}">No players yet.</td></tr>`}</tbody>
    </table>
  `;

  for (const th of container.querySelectorAll('th.sortable-col')) {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDescending = !sortDescending;
      } else {
        sortKey = key;
        sortDescending = true;
      }
      renderLeaderboard();
    });
  }
}

document.getElementById('rankedOnlyCheckbox').addEventListener('change', (e) => {
  rankedOnly = e.target.checked;
  renderLeaderboard();
});

loadLeaderboard();
