// Admin-only account monitor. The nav link to this page is hidden from
// everyone except AVNJ (auth-ui.js's updateAdminNavLink()), but that's only
// cosmetic - the real gate is server-side: admin_get_monitor_data() (schema.sql
// Phase 39) checks the caller's own username and raises an exception for
// anyone else, so loading this page directly as a different account just
// gets a rejected RPC call, not real data.

const COLUMNS = [
  { key: 'username', label: 'Player' },
  { key: 'coins', label: 'Coins' },
  { key: 'lifetime_coins_earned', label: 'Lifetime Earned' },
  { key: 'coins_purchased', label: 'Bought' },
  { key: 'coins_from_minos', label: 'Mino Coins' },
  { key: 'items_owned', label: 'Items' },
  { key: 'minos_owned', label: 'Seeds' },
  { key: 'unopened_seed_packs', label: 'Packs' },
  { key: 'garden_pot_count', label: 'Pots' },
  { key: 'elo_rating', label: 'ELO' },
  { key: 'highest_elo', label: 'Peak ELO' },
  { key: 'games_played', label: 'Games' },
  { key: 'pvp_games_played', label: 'PvP' },
  { key: 'ranked_games_played', label: 'Ranked' },
  { key: 'ranked_win_streak', label: 'Streak' },
  { key: 'highest_ranked_win_streak', label: 'Peak Streak' },
  { key: 'created_at', label: 'Joined' },
  { key: 'last_seen', label: 'Last Seen' },
];

let accounts = null;
let sortKey = 'lifetime_coins_earned';
let sortDescending = true;

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString();
}

function cellValue(p, key) {
  if (key === 'username') return playerLink(p.id, p.username);
  if (key === 'created_at' || key === 'last_seen') return formatDate(p[key]);
  return p[key] ?? 0;
}

async function loadAdminData() {
  const content = document.getElementById('adminContent');
  const profile = Auth.getProfile();

  if (!profile || profile.username !== 'AVNJ') {
    content.innerHTML = '<p>Not authorized.</p>';
    return;
  }

  const { data, error } = await supabaseClient.rpc('admin_get_monitor_data');
  if (error) {
    content.innerHTML = `<p>Could not load admin data: ${escapeHtml(error.message)}</p>`;
    return;
  }
  accounts = data || [];
  renderAdminTable();
}

function renderAdminTable() {
  const container = document.getElementById('adminContent');
  if (!accounts) return;

  const sorted = [...accounts].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') { av = av.toLowerCase(); bv = (bv || '').toLowerCase(); }
    av = av ?? 0;
    bv = bv ?? 0;
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
    <tr>
      <td>${i + 1}</td>
      ${COLUMNS.map((col) => `<td>${cellValue(p, col.key)}</td>`).join('')}
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="admin-table-wrap">
      <table class="games-table">
        <thead><tr><th>#</th>${headerCells}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${COLUMNS.length + 1}">No accounts yet.</td></tr>`}</tbody>
      </table>
    </div>
  `;

  for (const th of container.querySelectorAll('th.sortable-col')) {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDescending = !sortDescending;
      } else {
        sortKey = key;
        sortDescending = key !== 'username';
      }
      renderAdminTable();
    });
  }
}

Auth.onAuthChange(loadAdminData);
