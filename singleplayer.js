// Singleplayer speedrun mode. Deliberately self-contained rather than
// importing from game.js - the board model here has three cell states and a
// cascading capture/removal mechanic that doesn't map onto the 2-player
// state machine, so shape/orientation generation is duplicated (same
// approach replay.js already takes, for the same reason).

const BOARD_SIZE = 9;
const CELL_PX = 52;
const MAX_CAPTURE_SIZE = 4; // enclosures bigger than this don't count
const LOOKAHEAD_COUNT = 3; // how many upcoming pieces are shown ahead of the current one

// ---------- Shapes ----------
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

const PENTOMINO_NAMES = Object.keys(BASE_SHAPES).filter((n) => n.startsWith('P_'));
// Q_Z is Q_S mirrored, and Q_J is Q_L mirrored - since a piece can already
// be flipped in play (see generateOrientations()'s mirror step below), a
// piece named "Q_S" already covers every orientation "Q_Z" would too, and
// vice versa (same for Q_L/Q_J). Drawing both as separate pool entries
// silently doubled that one physical tetromino's odds relative to
// Q_I/Q_O/Q_T, which have no mirror partner - see the matching comment in
// game.js for the fuller explanation (this file has its own copy of
// BASE_SHAPES/ORIENTATIONS since it doesn't load game.js at all).
const TETROMINO_NAMES = ['Q_I', 'Q_O', 'Q_T', 'Q_S', 'Q_L'];
const TROMINO_NAMES = Object.keys(BASE_SHAPES).filter((n) => n.startsWith('R_'));

function normalize(coords) {
  const minR = Math.min(...coords.map((p) => p[0]));
  const minC = Math.min(...coords.map((p) => p[1]));
  return coords.map(([r, c]) => [r - minR, c - minC]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
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

function idx(r, c) { return r * BOARD_SIZE + c; }

// ---------- State ----------
// board cell values: 0 = empty, 1 = placed (uncaptured piece), 2 = captured (permanent)
const state = {
  board: new Uint8Array(BOARD_SIZE * BOARD_SIZE),
  pieceIdAt: new Int32Array(BOARD_SIZE * BOARD_SIZE),
  pieceCells: new Map(), // pieceId -> number[] of cell indices
  nextPieceId: 1,
  running: false,
  finished: false,
  failed: false,
  selected: null, // { shapeName, orientationIndex } - the current piece being placed
  pieceQueue: [], // shapeNames coming up after the current piece, length LOOKAHEAD_COUNT
  mouseRC: null,
  hover: null,
  lastTapCell: null,
  startTime: null,
  finalTimeMs: null,
};

function resetBoardState() {
  state.board = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceIdAt = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceCells = new Map();
  state.nextPieceId = 1;
  state.running = false;
  state.finished = false;
  state.failed = false;
  state.selected = null;
  state.pieceQueue = [];
  state.hover = null;
  state.lastTapCell = null;
  state.startTime = null;
  state.finalTimeMs = null;
}

// ---------- Placement legality ----------
function isValidPlacement(shapeName, orientationIndex, r0, c0, board) {
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  for (const [dr, dc] of orientation) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return false;
    if (board[idx(r, c)] !== 0) return false;
  }
  return true;
}

function hasAnyLegalMove(shapeName, board) {
  for (const orientation of ORIENTATIONS[shapeName]) {
    const maxDr = Math.max(...orientation.map((p) => p[0]));
    const maxDc = Math.max(...orientation.map((p) => p[1]));
    for (let r0 = 0; r0 <= BOARD_SIZE - 1 - maxDr; r0++) {
      for (let c0 = 0; c0 <= BOARD_SIZE - 1 - maxDc; c0++) {
        let ok = true;
        for (const [dr, dc] of orientation) {
          if (board[idx(r0 + dr, c0 + dc)] !== 0) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
  }
  return false;
}

// ---------- Piece supply ----------
function drawWeightedPiece() {
  const roll = Math.random();
  const pool = roll < 0.70 ? PENTOMINO_NAMES : roll < 0.90 ? TETROMINO_NAMES : TROMINO_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------- Capture / cascade ----------
function findEmptyRegions() {
  const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  const regions = [];
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === 0 && !visited[i]) {
      const region = [i];
      visited[i] = 1;
      let qi = 0;
      while (qi < region.length) {
        const cur = region[qi++];
        const r = Math.floor(cur / BOARD_SIZE), c = cur % BOARD_SIZE;
        for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
          if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
          const nidx = idx(nr, nc);
          if (state.board[nidx] === 0 && !visited[nidx]) { visited[nidx] = 1; region.push(nidx); }
        }
      }
      regions.push(region);
    }
  }
  return regions;
}

// Captures every enclosed empty pocket of size <= MAX_CAPTURE_SIZE, removes
// every placed piece bordering a newly-captured cell, and repeats - removal
// frees cells that may themselves now be enclosed by already-captured/placed
// neighbors, so a single placement can chain-clear a large area at once.
// Returns true if anything changed.
function runCaptureCascade() {
  let changed = false;
  let anyCapturedThisPass = true;
  while (anyCapturedThisPass) {
    anyCapturedThisPass = false;
    const capturedCells = [];
    for (const region of findEmptyRegions()) {
      if (region.length <= MAX_CAPTURE_SIZE) {
        for (const cell of region) state.board[cell] = 2;
        capturedCells.push(...region);
        anyCapturedThisPass = true;
      }
    }
    if (!anyCapturedThisPass) break;
    changed = true;

    const idsToRemove = new Set();
    for (const cell of capturedCells) {
      const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
        const nidx = idx(nr, nc);
        if (state.board[nidx] === 1) idsToRemove.add(state.pieceIdAt[nidx]);
      }
    }
    for (const id of idsToRemove) {
      for (const cell of state.pieceCells.get(id)) {
        state.board[cell] = 0;
        state.pieceIdAt[cell] = 0;
      }
      state.pieceCells.delete(id);
    }
  }
  return changed;
}

// The board is complete once no empty (0) cells remain - NOT once every
// cell is specifically captured (2). A piece that exactly fills the last
// remaining gap (leaving nothing empty behind it to enclose) never
// triggers the capture rule in runCaptureCascade(), since that rule only
// fires by finding a leftover empty region - so its own cells stay
// "placed" (1) forever even though the board is genuinely done. Checking
// for "== 2 everywhere" instead of "no 0s left" wrongly treated that as
// unfinished, which then made the next piece unplaceable anywhere and
// incorrectly failed the run instead of recognizing a win.
function isBoardComplete() {
  for (let i = 0; i < state.board.length; i++) if (state.board[i] === 0) return false;
  return true;
}

// ---------- Run flow ----------
function startRun() {
  resetBoardState();
  for (let i = 0; i < LOOKAHEAD_COUNT; i++) state.pieceQueue.push(drawWeightedPiece());
  state.running = true;
  state.startTime = Date.now();
  startTimerTick();
  spawnNextPiece();
  render();
}

// Pulls the current piece from the front of the lookahead queue and refills
// the back of it, so the next LOOKAHEAD_COUNT pieces are always visible in
// advance - lets you plan board space instead of being blindsided by
// whatever random shape shows up, especially late in a run.
function spawnNextPiece() {
  const shapeName = state.pieceQueue.shift();
  state.pieceQueue.push(drawWeightedPiece());
  state.selected = { shapeName, orientationIndex: 0 };
  recomputeHover();
  if (!hasAnyLegalMove(shapeName, state.board)) {
    failRun();
    return;
  }
  render();
}

function commitPlacement(r0, c0) {
  const { shapeName, orientationIndex } = state.selected;
  if (!isValidPlacement(shapeName, orientationIndex, r0, c0, state.board)) return;

  const id = state.nextPieceId++;
  const cells = [];
  for (const [dr, dc] of ORIENTATIONS[shapeName][orientationIndex]) {
    const cell = idx(r0 + dr, c0 + dc);
    state.board[cell] = 1;
    state.pieceIdAt[cell] = id;
    cells.push(cell);
  }
  state.pieceCells.set(id, cells);

  state.selected = null;
  state.hover = null;

  runCaptureCascade();

  if (isBoardComplete()) {
    // Cosmetic: any cells still sitting at "placed" (1) rather than
    // "captured" (2) at this point are only in that state because they
    // directly filled the last gap with nothing left over to enclose -
    // color them in like the rest of the board for the finished view.
    for (let i = 0; i < state.board.length; i++) if (state.board[i] === 1) state.board[i] = 2;
    finishRun();
    return;
  }
  spawnNextPiece();
}

function failRun() {
  state.running = false;
  state.finished = true;
  state.failed = true;
  stopTimerTick();
  render();
}

function finishRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  state.finalTimeMs = Date.now() - state.startTime;
  stopTimerTick();
  render();
  saveScoreIfBest(state.finalTimeMs);
}

// ---------- Rotation / hover ----------
function rotateSelected() {
  if (!state.selected) return;
  const len = ORIENTATIONS[state.selected.shapeName].length;
  state.selected.orientationIndex = (state.selected.orientationIndex + 1) % len;
  recomputeHover();
  render();
}

function recomputeHover() {
  if (!state.selected || !state.mouseRC) { state.hover = null; return; }
  const { shapeName, orientationIndex } = state.selected;
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  const h = Math.max(...orientation.map((p) => p[0])) + 1;
  const w = Math.max(...orientation.map((p) => p[1])) + 1;
  const r0 = state.mouseRC.row - Math.floor(h / 2);
  const c0 = state.mouseRC.col - Math.floor(w / 2);
  state.hover = { r0, c0, valid: isValidPlacement(shapeName, orientationIndex, r0, c0, state.board) };
}

// ---------- Timer ----------
let timerInterval = null;
function formatTime(ms) {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
function startTimerTick() {
  stopTimerTick();
  timerInterval = setInterval(() => {
    document.getElementById('spTimer').textContent = formatTime(Date.now() - state.startTime);
  }, 50);
}
function stopTimerTick() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ---------- Rendering ----------
const canvas = document.getElementById('board');
canvas.width = BOARD_SIZE * CELL_PX;
canvas.height = BOARD_SIZE * CELL_PX;
const ctx = canvas.getContext('2d');

function drawShapeIcon(canvasEl, coords) {
  const px = 8;
  const maxR = Math.max(...coords.map((p) => p[0])) + 1;
  const maxC = Math.max(...coords.map((p) => p[1])) + 1;
  canvasEl.width = maxC * px;
  canvasEl.height = maxR * px;
  const cctx = canvasEl.getContext('2d');
  cctx.fillStyle = '#ded6e3';
  for (const [r, c] of coords) cctx.fillRect(c * px, r * px, px - 1, px - 1);
}

function drawBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const val = state.board[idx(r, c)];
      ctx.fillStyle = val === 1 ? '#5b7fd9' : val === 2 ? '#74ae82' : '#1e1b24';
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= BOARD_SIZE; i++) {
    ctx.beginPath(); ctx.moveTo(i * CELL_PX, 0); ctx.lineTo(i * CELL_PX, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * CELL_PX); ctx.lineTo(canvas.width, i * CELL_PX); ctx.stroke();
  }

  if (state.selected && state.hover) {
    const orientation = ORIENTATIONS[state.selected.shapeName][state.selected.orientationIndex];
    ctx.fillStyle = state.hover.valid ? 'rgba(91,127,217,0.55)' : 'rgba(140,140,140,0.5)';
    for (const [dr, dc] of orientation) {
      const r = state.hover.r0 + dr, c = state.hover.c0 + dc;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
}

function render() {
  drawBoard();

  const banner = document.getElementById('spBanner');
  const pieceInfo = document.getElementById('spPieceInfo');
  const startBtn = document.getElementById('spStartBtn');
  startBtn.textContent = (state.running || state.finished) ? 'Restart' : 'Start';

  if (!state.running && !state.finished) {
    banner.textContent = 'Click Start to begin';
    pieceInfo.textContent = "You'll get one random piece at a time - place it anywhere it fits.";
  } else if (state.finished && state.failed) {
    banner.textContent = 'No legal moves - run failed';
    pieceInfo.textContent = "That piece didn't fit anywhere on the board. Click Restart to try again.";
  } else if (state.finished) {
    banner.textContent = `Cleared! Time: ${formatTime(state.finalTimeMs)}`;
    pieceInfo.textContent = 'Click Restart to run it back.';
  } else if (state.selected) {
    const len = ORIENTATIONS[state.selected.shapeName].length;
    pieceInfo.textContent = `Placing ${state.selected.shapeName} (orientation ${state.selected.orientationIndex + 1}/${len}). Click the board to place, or press R / scroll to rotate.`;
    banner.textContent = 'Go!';
  }

  document.getElementById('spCurrentPieceLabel').textContent = state.selected ? state.selected.shapeName : '-';
  const iconCanvas = document.getElementById('spCurrentPieceIcon');
  if (state.selected) {
    iconCanvas.style.display = '';
    drawShapeIcon(iconCanvas, BASE_SHAPES[state.selected.shapeName]);
  } else {
    iconCanvas.style.display = 'none';
  }

  const upcomingEl = document.getElementById('spUpcomingPieces');
  upcomingEl.innerHTML = '';
  if (state.running) {
    for (const shapeName of state.pieceQueue) {
      const item = document.createElement('div');
      item.className = 'sp-upcoming-item';
      const c = document.createElement('canvas');
      drawShapeIcon(c, BASE_SHAPES[shapeName]);
      item.appendChild(c);
      upcomingEl.appendChild(item);
    }
  }
}

// ---------- Canvas interaction ----------
function getBoardCell(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  return { row: Math.floor(y / CELL_PX), col: Math.floor(x / CELL_PX) };
}

canvas.addEventListener('mousemove', (e) => {
  if (!state.running) return;
  state.mouseRC = getBoardCell(e.clientX, e.clientY);
  recomputeHover();
  drawBoard();
});

canvas.addEventListener('mouseleave', () => {
  state.mouseRC = null;
  state.hover = null;
  drawBoard();
});

canvas.addEventListener('click', () => {
  if (!state.running || !state.selected || !state.hover || !state.hover.valid) return;
  commitPlacement(state.hover.r0, state.hover.c0);
});

canvas.addEventListener('touchstart', (e) => {
  if (!state.running || !state.selected) return;
  e.preventDefault();
  const touch = e.touches[0];
  const cell = getBoardCell(touch.clientX, touch.clientY);
  const wasSameCell = state.lastTapCell && state.lastTapCell.row === cell.row && state.lastTapCell.col === cell.col;
  state.lastTapCell = cell;

  if (wasSameCell && state.hover && state.hover.valid) {
    commitPlacement(state.hover.r0, state.hover.c0);
    state.lastTapCell = null;
    return;
  }

  state.mouseRC = cell;
  recomputeHover();
  drawBoard();
}, { passive: false });

canvas.addEventListener('wheel', (e) => {
  if (!state.running || !state.selected) return;
  e.preventDefault();
  rotateSelected();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') rotateSelected();
});

document.getElementById('mobileRotateBtn').addEventListener('click', rotateSelected);
document.getElementById('spStartBtn').addEventListener('click', startRun);

// ---------- Leaderboard ----------
async function saveScoreIfBest(timeMs) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your time to the leaderboard.';
    return;
  }
  // The "is this actually better than my existing best" comparison happens
  // server-side (submit_singleplayer_time) rather than client-side, so a
  // DevTools user can't just insert/update their own row with a fabricated
  // time_ms directly.
  const { data: bestTimeMs, error } = await supabaseClient.rpc('submit_singleplayer_time', { p_time_ms: timeMs });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your time: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestTimeMs === timeMs
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${formatTime(bestTimeMs)}.`;
  refreshLeaderboard();
}

async function refreshLeaderboard() {
  const container = document.getElementById('spLeaderboard');
  const { data, error } = await supabaseClient
    .from('singleplayer_runs')
    .select('time_ms, profiles(id, username, avatar_id, title_id)')
    .order('time_ms', { ascending: true })
    .limit(20);

  if (error) {
    container.innerHTML = `<p>Could not load leaderboard: ${escapeHtml(error.message)}</p>`;
    return;
  }

  await Catalog.ready();

  const rows = (data || []).map((row, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="leaderboard-player-cell">${avatarHtml(row.profiles.avatar_id, 20)} <a href="profile.html?user=${encodeURIComponent(row.profiles.id)}">${escapeHtml(row.profiles.username)}</a> ${titleBadgeHtml(row.profiles.title_id)}</td>
      <td>${formatTime(row.time_ms)}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>#</th><th>Player</th><th>Time</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No runs yet - be the first!</td></tr>'}</tbody>
    </table>
  `;
}

// ---------- Init ----------
render();
refreshLeaderboard();
