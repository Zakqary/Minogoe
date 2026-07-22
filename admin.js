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

// Duplicated from stats.js/recent.js rather than shared - same standalone-
// page convention every other page in this codebase already follows.
function formatTimeMs(ms) {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

const RECORD_MODE_LABELS = { speedrun: 'Speedrun', eogonim: 'Eogonim', blindeogonim: 'Blind Eogonim', ascension: 'Ascension', blight: 'Blight', godbot: 'GodBot', curse: 'Curse', shrink: 'Shrink', mutation: 'Mutation' };

function formatRecordValue(mode, value) {
  if (mode === 'speedrun') return formatTimeMs(value);
  if (mode === 'ascension') return `${value} round${value === 1 ? '' : 's'}`;
  if (mode === 'godbot') return `${value > 0 ? '+' : ''}${value}`;
  if (mode === 'curse') return `${value} open`;
  if (mode === 'shrink') return `${value} lost`;
  if (mode === 'mutation') return `${value} open`;
  return `${value} captured`;
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

async function loadPbFeed() {
  const content = document.getElementById('adminPbFeed');
  const profile = Auth.getProfile();

  if (!profile || profile.username !== 'AVNJ') {
    content.innerHTML = '<p>Not authorized.</p>';
    return;
  }

  // avatarHtml()/titleBadgeHtml() below look up shop_items via Catalog -
  // without waiting for it, every row would render the "?" default avatar
  // and default title on the very first load.
  await Catalog.ready();

  const { data, error } = await supabaseClient.rpc('admin_get_recent_personal_bests');
  if (error) {
    content.innerHTML = `<p>Could not load personal bests: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = (data || []).map((e) => `
    <tr>
      <td>${avatarHtml(e.avatar_id, 20)} ${playerLink(e.user_id, e.username)} ${titleBadgeHtml(e.title_id)}</td>
      <td>${escapeHtml(RECORD_MODE_LABELS[e.mode] || e.mode)}</td>
      <td>${escapeHtml(formatRecordValue(e.mode, Number(e.value)))}</td>
      <td>${timeAgo(e.achieved_at)}</td>
    </tr>
  `).join('');

  content.innerHTML = `
    <table class="games-table">
      <thead><tr><th>Player</th><th>Mode</th><th>New Best</th><th>When</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No personal bests recorded yet.</td></tr>'}</tbody>
    </table>
  `;
}

Auth.onAuthChange(loadAdminData);
Auth.onAuthChange(loadPbFeed);
