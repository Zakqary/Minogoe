// Standalone replay viewer. Duplicates the shape-generation logic from
// game.js (rather than sharing a module) since game.js's rendering is
// tightly coupled to the live/interactive state machine and this page
// only needs to draw a board and step through a recorded move log.

const CELL_PX = 40;

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

function normalize(coords) {
  const minR = Math.min(...coords.map(p => p[0]));
  const minC = Math.min(...coords.map(p => p[1]));
  return coords
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
}
function rotate90(coords) { return normalize(coords.map(([r, c]) => [c, -r])); }
function mirror(coords) { return normalize(coords.map(([r, c]) => [r, -c])); }
function generateOrientations(base) {
  const seen = new Set();
  const result = [];
  let shape = normalize(base);
  for (const useMirror of [false, true]) {
    let cur = useMirror ? mirror(shape) : shape;
    for (let i = 0; i < 4; i++) {
      const key = JSON.stringify(cur);
      if (!seen.has(key)) { seen.add(key); result.push(cur); }
      cur = rotate90(cur);
    }
  }
  return result;
}
const ORIENTATIONS = {};
for (const name of Object.keys(BASE_SHAPES)) ORIENTATIONS[name] = generateOrientations(BASE_SHAPES[name]);

// "private" is the internal mode value (still what's stored in the
// database and used in code) for what the site now calls "Direct Connect"
// everywhere a user actually sees it - see recent.js's own copy of this
// function for the full reasoning.
function modeLabel(mode) {
  return mode === 'private' ? 'direct connect' : mode;
}

// ---------- Replay state ----------
let boardSize = 12;
let moveLog = [];
let initialHand = [];
let board = null;
let stepIndex = 0;
let playTimer = null;
let gameStartedAtMs = null;

function idxOf(r, c) { return r * boardSize + c; }

function applyMovesUpTo(n) {
  board = new Int8Array(boardSize * boardSize);
  for (let i = 0; i < n; i++) {
    const mv = moveLog[i];
    const orientation = ORIENTATIONS[mv.shapeName][mv.orientationIndex];
    for (const [dr, dc] of orientation) {
      board[idxOf(mv.r0 + dr, mv.c0 + dc)] = mv.player;
    }
  }
}

// Both players start with an identical copy of initialHand - a player's
// remaining hand at step n is that copy minus whatever they've placed so far.
function handsUpTo(n) {
  const hand1 = [...initialHand];
  const hand2 = [...initialHand];
  for (let i = 0; i < n; i++) {
    const mv = moveLog[i];
    const hand = mv.player === 1 ? hand1 : hand2;
    const pos = hand.indexOf(mv.shapeName);
    if (pos !== -1) hand.splice(pos, 1);
  }
  return { hand1, hand2 };
}

function drawShapeIcon(canvasEl, coords) {
  const px = 8;
  const maxR = Math.max(...coords.map(p => p[0])) + 1;
  const maxC = Math.max(...coords.map(p => p[1])) + 1;
  canvasEl.width = maxC * px;
  canvasEl.height = maxR * px;
  const cctx = canvasEl.getContext('2d');
  cctx.fillStyle = '#ded6e3';
  for (const [r, c] of coords) {
    cctx.fillRect(c * px, r * px, px - 1, px - 1);
  }
}

function renderHand(elId, hand) {
  const counts = {};
  for (const s of hand) counts[s] = (counts[s] || 0) + 1;
  const el = document.getElementById(elId);
  el.innerHTML = '';

  const names = Object.keys(counts).sort();
  if (names.length === 0) {
    el.innerHTML = '<span>empty</span>';
    return;
  }
  for (const name of names) {
    const item = document.createElement('div');
    item.className = 'piece-icon';
    const iconCanvas = document.createElement('canvas');
    drawShapeIcon(iconCanvas, BASE_SHAPES[name]);
    item.appendChild(iconCanvas);
    const countEl = document.createElement('div');
    countEl.className = 'count';
    countEl.textContent = `${counts[name]}`;
    item.appendChild(countEl);
    el.appendChild(item);
  }
}

function renderHands() {
  const { hand1, hand2 } = handsUpTo(stepIndex);
  renderHand('hand1', hand1);
  renderHand('hand2', hand2);
}

function drawBoard() {
  const canvas = document.getElementById('board');
  canvas.width = boardSize * CELL_PX;
  canvas.height = boardSize * CELL_PX;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const val = board[idxOf(r, c)];
      ctx.fillStyle = val === 1 ? '#5b7fd9' : val === 2 ? '#d97a52' : '#1e1b24';
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= boardSize; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL_PX, 0);
    ctx.lineTo(i * CELL_PX, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL_PX);
    ctx.lineTo(canvas.width, i * CELL_PX);
    ctx.stroke();
  }
}

// ---------- Turn-time chart ----------
const CHART_ROW_H = 20;
const CHART_WIDTH = 220;
const CHART_LABEL_W = 46; // reserved space for the "Xs" time label text

// Duration for move i is the gap between when it was made and whenever
// control passed to that player - either the previous move's timestamp, or
// the game's started_at for the very first move. Replays recorded before
// per-move timestamps existed won't have moveLog[].t at all - detected via
// the first entry missing it, since that's a whole-game, all-or-nothing
// property of when the game was played.
function computeTurnDurations() {
  if (moveLog.length === 0 || moveLog[0].t === undefined) return null;
  const durations = [];
  let prevT = gameStartedAtMs;
  for (const mv of moveLog) {
    durations.push({ player: mv.player, ms: Math.max(0, mv.t - prevT) });
    prevT = mv.t;
  }
  return durations;
}

function formatDurationLabel(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function drawTimingChart() {
  const canvas = document.getElementById('timingChart');
  const emptyEl = document.getElementById('timingChartEmpty');
  const durations = computeTurnDurations();

  if (!durations || durations.length === 0) {
    canvas.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  canvas.style.display = 'block';
  emptyEl.style.display = 'none';

  canvas.width = CHART_WIDTH;
  canvas.height = durations.length * CHART_ROW_H + 4;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const maxMs = Math.max(...durations.map((d) => d.ms), 1);
  const barAreaWidth = CHART_WIDTH - CHART_LABEL_W;

  durations.forEach((d, i) => {
    const y = i * CHART_ROW_H + 3;
    const barH = CHART_ROW_H - 6;
    const barW = Math.max(2, (d.ms / maxMs) * barAreaWidth);
    const isCurrent = i === stepIndex - 1;

    ctx.globalAlpha = isCurrent ? 1 : 0.7;
    ctx.fillStyle = d.player === 1 ? '#5b7fd9' : '#d97a52';
    ctx.fillRect(0, y, barW, barH);
    ctx.globalAlpha = 1;

    if (isCurrent) {
      ctx.strokeStyle = '#ece7f1';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, y + 0.5, barW - 1, barH - 1);
    }

    ctx.fillStyle = '#a89db2';
    ctx.font = '10px Manrope, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatDurationLabel(d.ms), barAreaWidth + 6, y + barH / 2);
  });
}

function updateStepInfo() {
  document.getElementById('stepInfo').textContent = `Move ${stepIndex} / ${moveLog.length}`;
}

function stepForward() {
  if (stepIndex >= moveLog.length) return;
  stepIndex++;
  applyMovesUpTo(stepIndex);
  drawBoard();
  drawTimingChart();
  updateStepInfo();
  renderHands();
}

function stepBackward() {
  if (stepIndex <= 0) return;
  stepIndex--;
  applyMovesUpTo(stepIndex);
  drawBoard();
  drawTimingChart();
  updateStepInfo();
  renderHands();
}

function stopPlaying() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
    document.getElementById('playBtn').textContent = 'Play';
  }
}

function togglePlay() {
  const btn = document.getElementById('playBtn');
  if (playTimer) {
    stopPlaying();
    return;
  }
  btn.textContent = 'Pause';
  playTimer = setInterval(() => {
    if (stepIndex >= moveLog.length) {
      stopPlaying();
      return;
    }
    stepForward();
  }, 400);
}

async function loadReplay() {
  const params = new URLSearchParams(location.search);
  const gameId = params.get('game');
  const metaEl = document.getElementById('replayMeta');

  if (!gameId) {
    metaEl.textContent = 'No game specified. Open a replay link from a profile page.';
    return;
  }

  const { data, error } = await supabaseClient
    .from('games')
    .select('*, player1:player1_id(username), player2:player2_id(username)')
    .eq('id', gameId)
    .single();

  if (error || !data) {
    metaEl.textContent = 'Could not load this game.';
    return;
  }

  if (!data.move_log || !data.initial_hand || data.move_log.length === 0) {
    metaEl.textContent = 'This game has no replay data available (it was likely recorded before replays were added).';
    return;
  }

  boardSize = data.board_size;
  moveLog = data.move_log;
  initialHand = data.initial_hand;
  gameStartedAtMs = new Date(data.started_at).getTime();
  stepIndex = 0;
  board = new Int8Array(boardSize * boardSize);

  const p1Name = data.player1 ? data.player1.username : 'Guest';
  const p2Name = data.player2 ? data.player2.username : (data.mode === 'bot' ? 'Bot' : 'Guest');
  const resultText = data.winner == null
    ? 'Tie'
    : `${data.winner === 1 ? p1Name : p2Name} won${data.forfeit ? ' by forfeit' : ''}`;
  // A forfeit/timeout win isn't decided by the board tally - show W/FF
  // instead of a territory score that was never actually the deciding
  // factor (and can even make the winner look like they had fewer points).
  const scoreText = data.forfeit
    ? (data.winner === 1 ? 'W - FF' : 'FF - W')
    : `${data.score1} - ${data.score2}`;

  metaEl.innerHTML = `
    <div><strong>${escapeHtml(p1Name)}</strong> (Player 1, blue) vs <strong>${escapeHtml(p2Name)}</strong> (Player 2, red)</div>
    <div>Mode: ${escapeHtml(modeLabel(data.mode))} &middot; Final score: ${scoreText} &middot; ${escapeHtml(resultText)}</div>
    <div>${new Date(data.ended_at).toLocaleString()}</div>
  `;

  document.getElementById('handLabel1').textContent = `${p1Name}'s hand`;
  document.getElementById('handLabel2').textContent = `${p2Name}'s hand`;

  drawBoard();
  drawTimingChart();
  updateStepInfo();
  renderHands();
}

document.getElementById('stepBackBtn').addEventListener('click', () => { stopPlaying(); stepBackward(); });
document.getElementById('stepFwdBtn').addEventListener('click', () => { stopPlaying(); stepForward(); });
document.getElementById('playBtn').addEventListener('click', togglePlay);
document.getElementById('restartBtn').addEventListener('click', () => {
  stopPlaying();
  stepIndex = 0;
  applyMovesUpTo(0);
  drawBoard();
  drawTimingChart();
  updateStepInfo();
  renderHands();
});

loadReplay();
