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

// ---------- Replay state ----------
let boardSize = 12;
let moveLog = [];
let board = null;
let stepIndex = 0;
let playTimer = null;

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

function drawBoard() {
  const canvas = document.getElementById('board');
  canvas.width = boardSize * CELL_PX;
  canvas.height = boardSize * CELL_PX;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const val = board[idxOf(r, c)];
      ctx.fillStyle = val === 1 ? '#3b82f6' : val === 2 ? '#ef4444' : '#20242c';
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

function updateStepInfo() {
  document.getElementById('stepInfo').textContent = `Move ${stepIndex} / ${moveLog.length}`;
}

function stepForward() {
  if (stepIndex >= moveLog.length) return;
  stepIndex++;
  applyMovesUpTo(stepIndex);
  drawBoard();
  updateStepInfo();
}

function stepBackward() {
  if (stepIndex <= 0) return;
  stepIndex--;
  applyMovesUpTo(stepIndex);
  drawBoard();
  updateStepInfo();
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
  stepIndex = 0;
  board = new Int8Array(boardSize * boardSize);

  const p1Name = data.player1 ? data.player1.username : 'Guest';
  const p2Name = data.player2 ? data.player2.username : 'Guest';
  const resultText = data.winner == null
    ? 'Tie'
    : `${data.winner === 1 ? p1Name : p2Name} won`;

  metaEl.innerHTML = `
    <div><strong>${escapeHtml(p1Name)}</strong> (Player 1, blue) vs <strong>${escapeHtml(p2Name)}</strong> (Player 2, red)</div>
    <div>Mode: ${escapeHtml(data.mode)} &middot; Final score: ${data.score1} - ${data.score2} &middot; ${escapeHtml(resultText)}</div>
    <div>${new Date(data.ended_at).toLocaleString()}</div>
  `;

  drawBoard();
  updateStepInfo();
}

document.getElementById('stepBackBtn').addEventListener('click', () => { stopPlaying(); stepBackward(); });
document.getElementById('stepFwdBtn').addEventListener('click', () => { stopPlaying(); stepForward(); });
document.getElementById('playBtn').addEventListener('click', togglePlay);
document.getElementById('restartBtn').addEventListener('click', () => {
  stopPlaying();
  stepIndex = 0;
  applyMovesUpTo(0);
  drawBoard();
  updateStepInfo();
});

loadReplay();
