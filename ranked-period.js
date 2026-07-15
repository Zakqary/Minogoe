// Small "48-hour ranked challenge" panel on the main play page - tracks
// each player's ranked matches played within the current rolling period
// (schema.sql Phase 47). The period's rollover (awarding coins to the top
// players and starting a fresh period) happens entirely server-side in
// rollover_ranked_period_if_needed(), triggered opportunistically by
// get_ranked_period_leaderboard() below - simply having this panel open is
// enough to keep the period honest even if nobody's actively playing
// ranked right at the 48-hour mark.
const RANKED_PERIOD_POLL_MS = 30000;
const RANKED_PERIOD_DURATION_MS = 48 * 60 * 60 * 1000;

function formatRankedPeriodCountdown(ms) {
  if (ms <= 0) return 'resetting...';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

async function refreshRankedPeriodLeaderboard() {
  const container = document.getElementById('rankedPeriodContent');
  const countdownEl = document.getElementById('rankedPeriodCountdown');
  if (!container) return;

  const [{ data, error }, { data: periodData }] = await Promise.all([
    supabaseClient.rpc('get_ranked_period_leaderboard'),
    supabaseClient.from('ranked_leaderboard_period').select('started_at').eq('id', 1).single(),
  ]);

  if (error) {
    container.innerHTML = `<p>Could not load leaderboard: ${escapeHtml(error.message)}</p>`;
    return;
  }

  if (periodData && countdownEl) {
    const startedAt = new Date(periodData.started_at).getTime();
    const remaining = startedAt + RANKED_PERIOD_DURATION_MS - Date.now();
    countdownEl.textContent = `Resets in ${formatRankedPeriodCountdown(remaining)}`;
  }

  if (!data || data.length === 0) {
    container.innerHTML = '<p class="ranked-period-empty">No ranked matches played yet this period.</p>';
    return;
  }

  await Catalog.ready();

  // Same tie-aware ranking as leaderboard.js/singleplayer.js - ties share a
  // rank. Coin prizes follow the DISTINCT-value tier, not the rank number:
  // everyone in the top tier gets 2 coins each, everyone in the next
  // distinct tier gets 1 coin each, matching rollover_ranked_period_if_needed().
  let lastValue = null, lastRank = 0, tierIndex = 0;
  const rows = data.map((row, i) => {
    if (lastValue === null || row.games_count !== lastValue) {
      lastRank = i + 1;
      lastValue = row.games_count;
      tierIndex += 1;
    }
    const coinPrize = tierIndex === 1 ? 2 : tierIndex === 2 ? 1 : 0;
    return `
      <tr>
        <td>${lastRank}</td>
        <td class="leaderboard-player-cell">${avatarHtml(row.avatar_id, 18)} <a href="profile.html?user=${encodeURIComponent(row.user_id)}">${escapeHtml(row.username)}</a> ${titleBadgeHtml(row.title_id)}</td>
        <td>${row.games_count}</td>
        <td>${coinPrize > 0 ? `+${coinPrize}` : ''}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>#</th><th>Player</th><th>Matches</th><th>Prize</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

refreshRankedPeriodLeaderboard();
setInterval(refreshRankedPeriodLeaderboard, RANKED_PERIOD_POLL_MS);
