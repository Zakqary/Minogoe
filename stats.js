// Shape names are stored as e.g. "P_F" (Pentomino F), "Q_I" (Tetromino I),
// "R_L" (Tromino L) - see BASE_SHAPES in game.js. Split the prefix back into
// a readable category, used as this chart's hover tooltip now that the row
// label itself is drawn as an icon (see BASE_SHAPES/drawShapeIcon below).
function formatShapeName(shapeName) {
  const [prefix, letter] = (shapeName || '').split('_');
  const category = { P: 'Pentomino', Q: 'Tetromino', R: 'Tromino' }[prefix] || prefix;
  return letter ? `${letter} ${category}` : (shapeName || 'Unknown');
}

// get_score_averages_by_day() returns a plain "YYYY-MM-DD" date - parsed
// via new Date(y, m-1, d) rather than new Date(dayStr) directly, since the
// latter treats a bare date string as UTC midnight and can display as the
// PREVIOUS day in any timezone behind UTC.
function formatDayLabel(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Duplicated from game.js rather than shared - same standalone-page
// convention replay.js already follows, since this page doesn't otherwise
// load any of game.js's live/interactive state machine.
const BASE_SHAPES = {
  P_F: [[0,1],[0,2],[1,0],[1,1],[2,1]],
  P_I: [[0,0],[1,0],[2,0],[3,0],[4,0]],
  P_L: [[0,0],[1,0],[2,0],[3,0],[3,1]],
  P_N: [[0,1],[1,1],[2,0],[2,1],[3,0]],
  P_P: [[0,0],[0,1],[1,0],[1,1],[2,0]],
  P_T: [[0,0],[0,1],[0,2],[1,1],[2,1]],
  P_U: [[0,0],[0,2],[1,0],[1,1],[1,2]],
  P_V: [[0,0],[1,0],[2,0],[2,1],[2,2]],
  P_W: [[0,0],[1,0],[1,1],[2,1],[2,2]],
  P_X: [[0,1],[1,0],[1,1],[1,2],[2,1]],
  P_Y: [[0,1],[1,0],[1,1],[2,1],[3,1]],
  P_Z: [[0,0],[0,1],[1,1],[2,1],[2,2]],
  Q_I: [[0,0],[0,1],[0,2],[0,3]],
  Q_O: [[0,0],[0,1],[1,0],[1,1]],
  Q_T: [[0,0],[0,1],[0,2],[1,1]],
  Q_S: [[0,1],[0,2],[1,0],[1,1]],
  Q_Z: [[0,0],[0,1],[1,1],[1,2]],
  Q_L: [[0,0],[1,0],[2,0],[2,1]],
  Q_J: [[0,1],[1,1],[2,1],[2,0]],
  R_I: [[0,0],[0,1],[0,2]],
  R_L: [[0,0],[1,0],[1,1]],
};

// Same px/color as game.js's hand-tray drawShapeIcon(), for visual
// consistency with how pieces look everywhere else on the site.
function drawShapeIcon(canvasEl, coords) {
  const px = 8;
  const maxR = Math.max(...coords.map((p) => p[0])) + 1;
  const maxC = Math.max(...coords.map((p) => p[1])) + 1;
  canvasEl.width = maxC * px;
  canvasEl.height = maxR * px;
  const ctx = canvasEl.getContext('2d');
  ctx.fillStyle = '#ded6e3';
  for (const [r, c] of coords) {
    ctx.fillRect(c * px, r * px, px - 1, px - 1);
  }
}

function statBoxHtml(value, label) {
  return `
    <div class="stats-top-box">
      <div class="stats-top-value">${value}</div>
      <div class="stats-top-label">${label}</div>
    </div>
  `;
}

function barRowHtml(label, pct, valueText, color) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  return `
    <div class="stats-bar-row">
      <div class="stats-bar-label">${escapeHtml(label)}</div>
      <div class="stats-bar-track">
        <div class="stats-bar-fill" style="width:${clampedPct}%; background:${color};"></div>
      </div>
      <div class="stats-bar-value">${escapeHtml(valueText)}</div>
    </div>
  `;
}

// Same row layout as barRowHtml(), but the label cell is a blank canvas
// (drawn afterward - see the drawShapeIcon loop in renderStatsPage()),
// since a string of HTML can't draw onto a <canvas> before it's actually
// in the document. Narrower than the text label column it replaces, which
// helps keep this chart compact with 12+ rows.
function pieceRowHtml(shapeName, pct, valueText, color) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  return `
    <div class="stats-bar-row">
      <div class="stats-piece-icon-cell" title="${escapeHtml(formatShapeName(shapeName))}">
        <canvas class="stats-piece-icon-canvas" data-shape="${escapeHtml(shapeName)}"></canvas>
      </div>
      <div class="stats-bar-track">
        <div class="stats-bar-fill" style="width:${clampedPct}%; background:${color};"></div>
      </div>
      <div class="stats-bar-value">${escapeHtml(valueText)}</div>
    </div>
  `;
}

// Renders a simple multi-series line chart as an inline SVG - no charting
// library, same "hand-rolled, no dependency beyond Supabase" convention as
// every other visual on this site (drawShapeIcon() etc.). preserveAspect
// Ratio "none" plus a fixed CSS height (see .stats-svg-chart) means it
// fills its container's width without distorting into an unreadably
// short/tall shape on narrow screens. height is adjustable (a smaller
// value for the 2x2 per-mode record-progression grid than the full-width
// score-over-time chart).
function lineChartSvg(series, xLabels, height = 200) {
  const width = 640;
  const padL = 34, padR = 10, padT = 10, padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = xLabels.length;

  const maxVal = Math.max(...series.flatMap((s) => s.points), 1);
  const xFor = (i) => padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yFor = (v) => padT + plotH - (v / maxVal) * plotH;

  const gridLines = [0, 0.5, 1].map((frac) => {
    const y = padT + plotH * (1 - frac);
    return `
      <line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="var(--border-soft)" stroke-width="1" />
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--text-faint)">${Math.round(maxVal * frac)}</text>
    `;
  }).join('');

  const lines = series.map((s) => {
    const pts = s.points.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');
    const dots = s.points.map((v, i) => `<circle cx="${xFor(i)}" cy="${yFor(v)}" r="2.5" fill="${s.color}" />`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" />${dots}`;
  }).join('');

  // A handful of date labels rather than one per point - with a point per
  // day, labeling every single one would overlap into an unreadable smear.
  const labelCount = Math.min(n, 6);
  const dateLabels = [];
  for (let k = 0; k < labelCount; k++) {
    const i = labelCount === 1 ? 0 : Math.round((k * (n - 1)) / (labelCount - 1));
    dateLabels.push(`<text x="${xFor(i)}" y="${height - 6}" text-anchor="middle" font-size="9" fill="var(--text-faint)">${escapeHtml(xLabels[i])}</text>`);
  }

  return `
    <svg viewBox="0 0 ${width} ${height}" class="stats-svg-chart" preserveAspectRatio="none" style="height:${height}px;">
      ${gridLines}
      ${lines}
      ${dateLabels.join('')}
    </svg>
  `;
}

// Same hand-rolled-SVG approach as lineChartSvg(), but vertical bars along
// a shared baseline - the conventional histogram look, as distinct from
// this page's horizontal bar-row charts (barRowHtml()/pieceRowHtml()).
function histogramSvg(buckets, color) {
  const width = 640, height = 200;
  const padL = 34, padR = 10, padT = 10, padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = buckets.length;
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const gap = 4;
  const barWidth = n > 0 ? Math.max(1, plotW / n - gap) : 0;

  const gridLines = [0, 0.5, 1].map((frac) => {
    const y = padT + plotH * (1 - frac);
    return `
      <line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="var(--border-soft)" stroke-width="1" />
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--text-faint)">${Math.round(maxCount * frac)}</text>
    `;
  }).join('');

  const bars = buckets.map((b, i) => {
    const barH = (b.count / maxCount) * plotH;
    const x = padL + i * (barWidth + gap);
    const y = padT + plotH - barH;
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" rx="2" />
      <text x="${x + barWidth / 2}" y="${height - 6}" text-anchor="middle" font-size="9" fill="var(--text-faint)">${escapeHtml(b.label)}</text>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" class="stats-svg-chart" preserveAspectRatio="none" style="height:${height}px;">
      ${gridLines}
      ${bars}
    </svg>
  `;
}

function lineChartLegendHtml(series) {
  return `
    <div class="stats-line-legend">
      ${series.map((s) => `
        <span class="stats-legend-item">
          <span class="stats-legend-swatch" style="background:${s.color};"></span>${escapeHtml(s.label)}
        </span>
      `).join('')}
    </div>
  `;
}

// "3d 4h" once it crosses a full day, otherwise "X.Xh" - a running ELO
// leader's reign is usually measured in hours early on and days/weeks once
// the game has more history.
function formatHoursAsRank1(hours) {
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = Math.round(hours - days * 24);
    return `${days}d ${remHours}h`;
  }
  return `${hours.toFixed(1)}h`;
}

// Duplicated from singleplayer.js's formatTime() rather than shared - same
// standalone-page convention this file already follows for BASE_SHAPES.
function formatTimeMs(ms) {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// Both duplicated from recent.js rather than shared - same standalone-page
// convention as BASE_SHAPES/formatTimeMs above.
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

const RECORD_MODE_LABELS = { speedrun: 'Speedrun', eogonim: 'Eogonim', blindeogonim: 'Blind Eogonim', ascension: 'Ascension', blight: 'Blight', godbot: 'GodBot', curse: 'Curse', shrink: 'Shrink', mutation: 'Mutation' };
const RECORD_MODE_COLORS = { speedrun: '#5b7fd9', eogonim: 'var(--accent)', blindeogonim: '#8b6fd9', ascension: '#6fbf73', blight: '#c05c5c', godbot: '#d95b8f', curse: '#5bc2d9', shrink: '#a8d84a', mutation: '#d9895b' };

function formatRecordValue(mode, value) {
  if (mode === 'speedrun') return formatTimeMs(value);
  if (mode === 'ascension') return `${value} round${value === 1 ? '' : 's'}`;
  if (mode === 'godbot') return `${value > 0 ? '+' : ''}${value}`;
  if (mode === 'curse') return `${value} open`;
  if (mode === 'shrink') return `${value} lost`;
  if (mode === 'mutation') return `${value} open`;
  return `${value} captured`;
}

async function renderStatsPage() {
  const container = document.getElementById('statsContent');

  const [platform, p1p2, firstPiece, scores, scoresByDay, rank1Leaders, eloDistribution, recordProgression] = await Promise.all([
    supabaseClient.rpc('get_platform_stats'),
    supabaseClient.rpc('get_p1_p2_win_rates'),
    supabaseClient.rpc('get_first_piece_win_rates'),
    supabaseClient.rpc('get_score_averages'),
    supabaseClient.rpc('get_score_averages_by_day'),
    supabaseClient.rpc('get_rank1_time_leaders'),
    supabaseClient.rpc('get_elo_distribution'),
    supabaseClient.rpc('get_record_progression'),
  ]);

  const firstError = platform.error || p1p2.error || firstPiece.error || scores.error || scoresByDay.error
    || rank1Leaders.error || eloDistribution.error || recordProgression.error;
  if (firstError) {
    container.innerHTML = `<p>Could not load stats: ${escapeHtml(firstError.message)}</p>`;
    return;
  }

  const stat = platform.data[0];
  const pp = p1p2.data[0];
  const sc = scores.data[0];
  const pieces = firstPiece.data || [];

  const topStats = `
    <div class="stats-top-grid">
      ${statBoxHtml(Number(stat.registered_users).toLocaleString(), 'Registered Users')}
      ${statBoxHtml(Number(stat.games_played).toLocaleString(), 'Games Played')}
      ${statBoxHtml(Number(stat.pvp_games_played).toLocaleString(), 'Player vs Player Games')}
      ${statBoxHtml(Number(stat.total_hours_played).toLocaleString(), 'Hours Played')}
    </div>
  `;

  let p1p2Chart;
  if (pp.total_games > 0) {
    const p1Pct = (100 * pp.p1_wins) / pp.total_games;
    const p2Pct = (100 * pp.p2_wins) / pp.total_games;
    p1p2Chart = `
      ${barRowHtml('Player 1', p1Pct, `${p1Pct.toFixed(1)}%`, '#5b7fd9')}
      ${barRowHtml('Player 2', p2Pct, `${p2Pct.toFixed(1)}%`, '#d97a52')}
    `;
  } else {
    p1p2Chart = '<p class="stats-chart-empty">Not enough pvp games recorded yet.</p>';
  }

  let pieceChart;
  if (pieces.length > 0) {
    const maxRate = Math.max(...pieces.map((p) => Number(p.win_rate)), 1);
    pieceChart = pieces.map((p) => pieceRowHtml(
      p.shape_name,
      (Number(p.win_rate) / maxRate) * 100,
      `${p.win_rate}% (${p.games_count})`,
      'var(--accent)'
    )).join('');
  } else {
    pieceChart = '<p class="stats-chart-empty">Not enough recorded move logs yet.</p>';
  }

  let scoreChart;
  if (sc.sample_size > 0) {
    const maxScore = Math.max(Number(sc.avg_winner_score), Number(sc.avg_loser_score), 1);
    scoreChart = `
      ${barRowHtml('Winner', (Number(sc.avg_winner_score) / maxScore) * 100, `${sc.avg_winner_score}`, 'var(--accent)')}
      ${barRowHtml('Loser', (Number(sc.avg_loser_score) / maxScore) * 100, `${sc.avg_loser_score}`, 'var(--danger)')}
    `;
  } else {
    scoreChart = '<p class="stats-chart-empty">Not enough decided pvp games recorded yet.</p>';
  }

  let scoreOverTimeChart;
  const byDay = scoresByDay.data || [];
  if (byDay.length > 0) {
    const dayLabels = byDay.map((r) => formatDayLabel(r.day));
    const series = [
      { label: 'Winner', color: 'var(--accent)', points: byDay.map((r) => Number(r.avg_winner_score)) },
      { label: 'Loser', color: 'var(--danger)', points: byDay.map((r) => Number(r.avg_loser_score)) },
    ];
    scoreOverTimeChart = `
      ${lineChartLegendHtml(series)}
      ${lineChartSvg(series, dayLabels)}
    `;
  } else {
    scoreOverTimeChart = '<p class="stats-chart-empty">Not enough decided pvp games recorded yet.</p>';
  }

  let rank1Chart;
  const leaders = rank1Leaders.data || [];
  if (leaders.length > 0) {
    const maxHours = Math.max(...leaders.map((l) => Number(l.hours_as_rank1)), 1);
    rank1Chart = leaders.map((l) => barRowHtml(
      l.username,
      (Number(l.hours_as_rank1) / maxHours) * 100,
      formatHoursAsRank1(Number(l.hours_as_rank1)),
      'var(--accent)'
    )).join('');
  } else {
    rank1Chart = '<p class="stats-chart-empty">Not enough ranked history recorded yet.</p>';
  }

  let eloChart;
  const buckets = eloDistribution.data || [];
  if (buckets.length > 0) {
    eloChart = histogramSvg(
      buckets.map((b) => ({ label: String(b.bucket_start), count: Number(b.player_count) })),
      'var(--accent)'
    );
  } else {
    eloChart = '<p class="stats-chart-empty">Not enough ranked players yet.</p>';
  }

  const recordsByMode = { speedrun: [], eogonim: [], blindeogonim: [], ascension: [], blight: [], godbot: [], curse: [] };
  for (const row of recordProgression.data || []) {
    if (recordsByMode[row.mode]) recordsByMode[row.mode].push(row);
  }
  const recordChartsHtml = Object.keys(RECORD_MODE_LABELS).map((mode) => {
    const rows = recordsByMode[mode];
    if (rows.length === 0) {
      return `
        <div class="stats-record-mode">
          <h4>${RECORD_MODE_LABELS[mode]}</h4>
          <p class="stats-chart-empty">No runs recorded yet.</p>
        </div>
      `;
    }
    const xLabels = rows.map((r) => new Date(r.achieved_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    const series = [{ color: RECORD_MODE_COLORS[mode], points: rows.map((r) => Number(r.value)) }];
    const currentBest = Number(rows[rows.length - 1].value);
    return `
      <div class="stats-record-mode">
        <h4>${RECORD_MODE_LABELS[mode]} <span class="stats-record-current">best: ${formatRecordValue(mode, currentBest)}</span></h4>
        ${lineChartSvg(series, xLabels, 110)}
      </div>
    `;
  }).join('');

  container.innerHTML = `
    ${topStats}

    <div class="stats-chart-card">
      <h3>Player 1 vs Player 2 Win Rate</h3>
      <p class="stats-chart-note">Player 2 always gets a small head-start to offset Player 1 moving first - this shows how close that comes out in practice.</p>
      ${p1p2Chart}
    </div>

    <div class="stats-chart-card">
      <h3>Win Rate by First Piece Played</h3>
      <p class="stats-chart-note">Win rate of the player who opened the game with each piece.</p>
      ${pieceChart}
    </div>

    <div class="stats-chart-card">
      <h3>Average Score: Winner vs Loser</h3>
      ${scoreChart}
    </div>

    <div class="stats-chart-card">
      <h3>Average Score Over Time</h3>
      <p class="stats-chart-note">One data point per day with at least one decided pvp game.</p>
      ${scoreOverTimeChart}
    </div>

    <div class="stats-chart-card">
      <h3>Most Time Spent as the #1 Ranked Player</h3>
      <p class="stats-chart-note">Total real time each player has actually held the highest ELO on the site, not just their peak rating.</p>
      ${rank1Chart}
    </div>

    <div class="stats-chart-card">
      <h3>ELO Distribution</h3>
      <p class="stats-chart-note">Players with at least one ranked game, bucketed by 100-point ELO band.</p>
      ${eloChart}
    </div>

    <div class="stats-chart-card">
      <h3>Minigame Record Progression</h3>
      <p class="stats-chart-note">World-record line per mode - lower is better except Ascension, Blight, and GodBot (higher). Reconstructed from current personal bests, so it may miss a record a player later broke themselves.</p>
      <div class="stats-record-grid">${recordChartsHtml}</div>
    </div>
  `;

  for (const canvasEl of container.querySelectorAll('.stats-piece-icon-canvas')) {
    const coords = BASE_SHAPES[canvasEl.dataset.shape];
    if (coords) drawShapeIcon(canvasEl, coords);
  }
}

// ---------- Head to head ----------
// Two independent typeahead pickers (structurally the same lookup as
// search.js's nav search box, just not tied to its hardcoded single-input
// IDs and navigating on pick instead of jumping to a profile) - reports
// the full W/L/T record and game list between whichever two players are
// picked. games is publicly readable (see schema.sql), so this is a plain
// client-side query, no RPC needed.
const H2H_SEARCH_DEBOUNCE_MS = 250;
const H2H_SEARCH_RESULT_LIMIT = 6;

function createPlayerPicker(input, resultsEl, onChange) {
  let picked = null;
  let debounceId = null;
  let activeIndex = -1;
  let currentMatches = [];

  function hideResults() {
    resultsEl.classList.remove('visible');
    resultsEl.innerHTML = '';
    activeIndex = -1;
    currentMatches = [];
  }

  function updateActive(items) {
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  }

  function renderResults(matches) {
    currentMatches = matches;
    activeIndex = -1;
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="nav-search-empty">No players found</div>';
      resultsEl.classList.add('visible');
      return;
    }
    resultsEl.innerHTML = matches.map((m, i) =>
      `<div class="nav-search-result" data-index="${i}">${escapeHtml(m.username)}</div>`
    ).join('');
    resultsEl.classList.add('visible');
    for (const el of resultsEl.querySelectorAll('.nav-search-result')) {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectPlayer(matches[Number(el.dataset.index)]);
      });
    }
  }

  async function runSearch(query) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, username')
      .ilike('username', `%${query}%`)
      .order('username', { ascending: true })
      .limit(H2H_SEARCH_RESULT_LIMIT);
    if (error || !data) { hideResults(); return; }
    renderResults(data);
  }

  function selectPlayer(match) {
    picked = match;
    input.value = match.username;
    input.classList.add('picked');
    hideResults();
    input.blur();
    onChange(picked);
  }

  input.addEventListener('input', () => {
    if (picked && input.value !== picked.username) {
      picked = null;
      input.classList.remove('picked');
      onChange(null);
    }
    const query = input.value.trim();
    clearTimeout(debounceId);
    if (!query) { hideResults(); return; }
    debounceId = setTimeout(() => runSearch(query), H2H_SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideResults();
      input.blur();
      return;
    }
    if (!resultsEl.classList.contains('visible') || currentMatches.length === 0) return;

    const items = resultsEl.querySelectorAll('.nav-search-result');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActive(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && currentMatches[activeIndex]) {
        selectPlayer(currentMatches[activeIndex]);
      } else if (currentMatches.length === 1) {
        selectPlayer(currentMatches[0]);
      }
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(hideResults, 150);
  });
}

async function loadHeadToHead(a, b, output) {
  output.innerHTML = '<p class="stats-chart-empty">Loading...</p>';

  const { data, error } = await supabaseClient
    .from('games')
    .select('*, player1:player1_id(id, username), player2:player2_id(id, username)')
    .or(`and(player1_id.eq.${a.id},player2_id.eq.${b.id}),and(player1_id.eq.${b.id},player2_id.eq.${a.id})`)
    .order('ended_at', { ascending: false });

  if (error) {
    output.innerHTML = `<p class="stats-chart-empty">Could not load head-to-head record: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const games = data || [];
  if (games.length === 0) {
    output.innerHTML = `<p class="stats-chart-empty">${escapeHtml(a.username)} and ${escapeHtml(b.username)} haven't played each other yet.</p>`;
    return;
  }

  let aWins = 0, bWins = 0, ties = 0;
  const rows = games.map((g) => {
    // Which of player1/player2 this specific game recorded A/B as varies
    // per row (whoever happened to be player1 that game) - normalize every
    // row to an A-then-B order so the score/result columns read
    // consistently regardless of who was actually player1 in the DB.
    const aIsP1 = g.player1_id === a.id;
    const aScore = aIsP1 ? g.score1 : g.score2;
    const bScore = aIsP1 ? g.score2 : g.score1;
    const aNum = aIsP1 ? 1 : 2;
    const bNum = aIsP1 ? 2 : 1;

    let outcome;
    if (g.winner === aNum) { outcome = 'win'; aWins++; }
    else if (g.winner === bNum) { outcome = 'loss'; bWins++; }
    else { outcome = 'tie'; ties++; }

    const scoreText = g.forfeit
      ? (outcome === 'win' ? 'W - FF' : outcome === 'loss' ? 'FF - W' : `${aScore} - ${bScore}`)
      : `${aScore} - ${bScore}`;
    const resultText = outcome === 'win' ? 'Win' : outcome === 'loss' ? 'Loss' : 'Tie';

    return `<tr>
      <td class="result-${outcome}">${resultText}</td>
      <td>${scoreText}</td>
      <td>${escapeHtml(modeLabel(g.mode))}</td>
      <td>${timeAgo(g.ended_at)}</td>
      <td><a href="replay.html?game=${encodeURIComponent(g.id)}">Replay</a></td>
    </tr>`;
  }).join('');

  const total = games.length;
  const aPct = (100 * aWins) / total;
  const bPct = (100 * bWins) / total;
  const tieNote = ties > 0 ? `<p class="stats-chart-note">${ties} tie${ties === 1 ? '' : 's'}.</p>` : '';

  output.innerHTML = `
    <div class="h2h-summary">
      ${barRowHtml(a.username, aPct, `${aWins}`, '#5b7fd9')}
      ${barRowHtml(b.username, bPct, `${bWins}`, '#d97a52')}
      ${tieNote}
    </div>
    <table class="games-table">
      <thead><tr><th>Result</th><th>Score</th><th>Mode</th><th>When</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function initHeadToHead() {
  const output = document.getElementById('h2hOutput');
  if (!output) return;

  let playerA = null;
  let playerB = null;

  function update() {
    if (!playerA || !playerB) { output.innerHTML = ''; return; }
    if (playerA.id === playerB.id) {
      output.innerHTML = '<p class="stats-chart-empty">Pick two different players.</p>';
      return;
    }
    loadHeadToHead(playerA, playerB, output);
  }

  createPlayerPicker(document.getElementById('h2hInputA'), document.getElementById('h2hResultsA'), (m) => { playerA = m; update(); });
  createPlayerPicker(document.getElementById('h2hInputB'), document.getElementById('h2hResultsB'), (m) => { playerB = m; update(); });
}

renderStatsPage();
initHeadToHead();
