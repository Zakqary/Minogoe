// Columns are addressed by a neutral key regardless of whether "ranked
// matches only" is checked - fieldFor() resolves which underlying profile
// column that key actually reads from in the current mode, so the sort
// column doesn't need to be remapped when the checkbox is toggled.
const COLUMNS = [
  { key: 'username', label: 'Player' },
  { key: 'elo_rating', label: 'ELO' },
  { key: 'games', label: 'Games' },
  { key: 'wins', label: 'W' },
  { key: 'losses', label: 'L' },
  { key: 'ties', label: 'T' },
];

const FIELD_MAP = {
  all: { games: 'games_played', wins: 'wins', losses: 'losses', ties: 'ties' },
  ranked: { games: 'ranked_games_played', wins: 'ranked_wins', losses: 'ranked_losses', ties: 'ranked_ties' },
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
    .select('id, username, elo_rating, games_played, wins, losses, ties, ranked_games_played, ranked_wins, ranked_losses, ranked_ties, avatar_id, title_id');

  if (error) {
    document.getElementById('leaderboardContent').innerHTML = `<p>Could not load leaderboard: ${escapeHtml(error.message)}</p>`;
    return;
  }
  players = data || [];
  await Catalog.ready();
  renderLeaderboard();
}

function rankRowClass(i) {
  if (i === 0) return 'rank-gold';
  if (i === 1) return 'rank-silver';
  if (i === 2) return 'rank-bronze';
  if (i === 3 || i === 4) return 'rank-top5';
  return '';
}

function renderLeaderboard() {
  const container = document.getElementById('leaderboardContent');
  if (!players) return;

  // "Ranked matches only" should mean an actual ranked leaderboard - a
  // player who's never queued ranked at all has nothing to rank on and
  // just clutters the list with a 0/0/0/0 row.
  const visible = rankedOnly ? players.filter((p) => p.ranked_games_played > 0) : players;

  const sorted = [...visible].sort((a, b) => {
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

  const rows = sorted.map((p, i) => `
    <tr class="${rankRowClass(i)}">
      <td>${i + 1}</td>
      <td class="leaderboard-player-cell">${avatarHtml(p.avatar_id, 20)} <a href="profile.html?user=${encodeURIComponent(p.id)}">${escapeHtml(p.username)}</a> ${titleBadgeHtml(p.title_id)}</td>
      <td>${p.elo_rating}</td>
      <td>${p[fieldFor('games')]}</td>
      <td>${p[fieldFor('wins')]}</td>
      <td>${p[fieldFor('losses')]}</td>
      <td>${p[fieldFor('ties')]}</td>
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
