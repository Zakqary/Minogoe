// Shape names are stored as e.g. "P_F" (Pentomino F), "Q_I" (Tetromino I),
// "R_L" (Tromino L) - see BASE_SHAPES in game.js. Split the prefix back into
// a readable category, used as this chart's hover tooltip now that the row
// label itself is drawn as an icon (see BASE_SHAPES/drawShapeIcon below).
function formatShapeName(shapeName) {
  const [prefix, letter] = (shapeName || '').split('_');
  const category = { P: 'Pentomino', Q: 'Tetromino', R: 'Tromino' }[prefix] || prefix;
  return letter ? `${letter} ${category}` : (shapeName || 'Unknown');
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

async function renderStatsPage() {
  const container = document.getElementById('statsContent');

  const [platform, p1p2, firstPiece, scores] = await Promise.all([
    supabaseClient.rpc('get_platform_stats'),
    supabaseClient.rpc('get_p1_p2_win_rates'),
    supabaseClient.rpc('get_first_piece_win_rates'),
    supabaseClient.rpc('get_score_averages'),
  ]);

  const firstError = platform.error || p1p2.error || firstPiece.error || scores.error;
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
  `;

  for (const canvasEl of container.querySelectorAll('.stats-piece-icon-canvas')) {
    const coords = BASE_SHAPES[canvasEl.dataset.shape];
    if (coords) drawShapeIcon(canvasEl, coords);
  }
}

renderStatsPage();
