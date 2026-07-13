// Singleplayer modes. Deliberately self-contained rather than importing
// from game.js - shape/orientation generation is duplicated (same approach
// replay.js already takes, for the same reason). Two modes share this file:
//   - Speedrun: a cascading capture/removal mechanic all its own (enclose a
//     small pocket and the walling pieces vanish, freeing the space back
//     up) - see runCaptureCascade().
//   - Eogonim: scored like a real Minogoe match instead - pieces never
//     disappear, and a fully-enclosed empty pocket of ANY size counts as
//     captured territory (see computeCapturedCount(), which mirrors
//     game.js's computeFinalScores() minus the two-player owner-conflict
//     case, since there's only ever one color here).
// Board size varies by mode (Speedrun: 9x9, Eogonim: 10x10) - see
// BOARD_SIZES and setMode() below - so this is reassigned rather than a const.
let BOARD_SIZE = 9;
const BOARD_SIZES = { speedrun: 9, eogonim: 10 };
const CELL_PX = 52;
const MAX_CAPTURE_SIZE = 4; // speedrun only - enclosures bigger than this don't count. Eogonim has no size cap, matching real Minogoe scoring.
const LOOKAHEAD_COUNT = 3; // how many upcoming pieces are shown ahead of the current one - speedrun only, eogonim has no preview

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
// board cell values: 0 = empty, 1 = placed. Speedrun also uses 2 = captured
// (permanent, cleared of its walling pieces) - eogonim never sets a cell to
// 2 at all, since pieces there never disappear; its captured count is only
// ever a computed number (see computeCapturedCount()), not a board state.
const state = {
  mode: 'speedrun', // 'speedrun' | 'eogonim' - persists across resetBoardState(), only setMode() changes it
  board: new Uint8Array(BOARD_SIZE * BOARD_SIZE),
  pieceIdAt: new Int32Array(BOARD_SIZE * BOARD_SIZE),
  pieceCells: new Map(), // pieceId -> number[] of cell indices
  nextPieceId: 1,
  running: false,
  finished: false,
  failed: false, // speedrun only - eogonim has no fail state, every ending is a valid (scored) result
  selected: null, // { shapeName, orientationIndex } - the current piece being placed
  pieceQueue: [], // shapeNames coming up after the current piece, length LOOKAHEAD_COUNT - speedrun only
  mouseRC: null,
  hover: null,
  lastTapCell: null,
  startTime: null,
  finalTimeMs: null,
  totalCaptured: 0, // running captured-territory count - this is eogonim's score. Also incremented by speedrun's cascade, but never displayed there.
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
  state.totalCaptured = 0;
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
    state.totalCaptured += capturedCells.length;

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

// Eogonim's scoring - mirrors game.js's computeFinalScores() but for a
// single color: every empty region gets flood-filled, and if it borders
// ANY placed piece (board edges don't count as a border at all - going
// off-board just contributes nothing), the whole region is captured
// territory, no matter its size. A region touching zero pieces at all
// (fully open board, or a pocket nothing has been placed next to yet)
// isn't decided either way. Unlike runCaptureCascade(), this never mutates
// state.board - pieces don't disappear in this mode, so it's just a
// read-only tally, cheap enough (100 cells at most) to recompute fresh
// after every placement for a live "Captured" count.
function computeCapturedCount(board) {
  const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  let captured = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0 && !visited[i]) {
      const region = [i];
      visited[i] = 1;
      let qi = 0;
      let touchesAnyPiece = false;
      while (qi < region.length) {
        const cur = region[qi++];
        const r = Math.floor(cur / BOARD_SIZE), c = cur % BOARD_SIZE;
        for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
          if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
          const nidx = idx(nr, nc);
          if (board[nidx] === 0) {
            if (!visited[nidx]) { visited[nidx] = 1; region.push(nidx); }
          } else {
            touchesAnyPiece = true;
          }
        }
      }
      if (touchesAnyPiece) captured += region.length;
    }
  }
  return captured;
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
  if (state.mode === 'speedrun') {
    for (let i = 0; i < LOOKAHEAD_COUNT; i++) state.pieceQueue.push(drawWeightedPiece());
    state.startTime = Date.now();
    startTimerTick();
  }
  state.running = true;
  spawnNextPiece();
  render();
}

// Speedrun pulls the current piece from the front of the lookahead queue and
// refills the back of it, so the next LOOKAHEAD_COUNT pieces are always
// visible in advance. Eogonim has no preview at all - each piece is drawn
// fresh, right when it's handed to you.
function spawnNextPiece() {
  const shapeName = state.mode === 'speedrun' ? state.pieceQueue.shift() : drawWeightedPiece();
  if (state.mode === 'speedrun') state.pieceQueue.push(drawWeightedPiece());
  state.selected = { shapeName, orientationIndex: 0 };
  recomputeHover();
  if (!hasAnyLegalMove(shapeName, state.board)) {
    if (state.mode === 'speedrun') failRun();
    else finishEogonimRun();
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

  // Speedrun's cascade mutates the board (captures + removes the walling
  // pieces); eogonim scores like a real Minogoe match instead - pieces stay
  // put forever, so its "captured" total is just recomputed fresh here for
  // the live display, with no board mutation at all.
  if (state.mode === 'speedrun') {
    runCaptureCascade();
  } else {
    state.totalCaptured = computeCapturedCount(state.board);
  }

  if (isBoardComplete()) {
    if (state.mode === 'speedrun') {
      // Cosmetic: any cells still sitting at "placed" (1) rather than
      // "captured" (2) at this point are only in that state because they
      // directly filled the last gap with nothing left over to enclose -
      // color them in like the rest of the board for the finished view.
      for (let i = 0; i < state.board.length; i++) if (state.board[i] === 1) state.board[i] = 2;
      finishRun();
    } else {
      finishEogonimRun();
    }
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

// Eogonim has no separate "failed" ending - running out of legal placements
// (the usual way a run ends, since you're never given a choice to pass) and
// filling the board completely are both just "the run is over," scored the
// same way either way.
function finishEogonimRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  render();
  saveEogonimScoreIfBest(state.totalCaptured);
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

// ---------- Mode switching ----------
function resizeCanvasForMode() {
  canvas.width = BOARD_SIZE * CELL_PX;
  canvas.height = BOARD_SIZE * CELL_PX;
}

// Switching mid-run is blocked (the Start button becomes Restart, and the
// tab buttons themselves are disabled while running - see render()), so
// this only ever runs against an idle or finished board.
function setMode(mode) {
  if (state.running || state.mode === mode) return;
  state.mode = mode;
  BOARD_SIZE = BOARD_SIZES[mode];
  resizeCanvasForMode();
  resetBoardState();
  updateModeUI();
  render();
  refreshLeaderboard();
}

function updateModeUI() {
  const isEogonim = state.mode === 'eogonim';
  document.getElementById('spTabSpeedrun').classList.toggle('active', !isEogonim);
  document.getElementById('spTabEogonim').classList.toggle('active', isEogonim);
  document.getElementById('spModeTitle').textContent = isEogonim ? 'Eogonim' : 'Speedrun';
  document.getElementById('spUpcomingLabel').style.display = isEogonim ? 'none' : '';
  document.getElementById('spUpcomingPieces').style.display = isEogonim ? 'none' : '';
  document.getElementById('spRulesSpeedrun').style.display = isEogonim ? 'none' : '';
  document.getElementById('spRulesEogonim').style.display = isEogonim ? '' : 'none';
  document.getElementById('spLeaderboardTitle').textContent = isEogonim ? 'Lowest Scores' : 'Top Times';
  document.getElementById('spSaveStatus').textContent = '';
  document.getElementById('spTimer').textContent = isEogonim ? 'Captured: 0' : formatTime(0);
}

// ---------- Rendering ----------
const canvas = document.getElementById('board');
canvas.width = BOARD_SIZE * CELL_PX;
canvas.height = BOARD_SIZE * CELL_PX;
const ctx = canvas.getContext('2d');

function drawShapeIcon(canvasEl, coords, px = 8) {
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

  document.getElementById('spTabSpeedrun').disabled = state.running;
  document.getElementById('spTabEogonim').disabled = state.running;

  if (state.mode === 'eogonim') {
    document.getElementById('spTimer').textContent = `Captured: ${state.totalCaptured}`;
  }

  if (!state.running && !state.finished) {
    banner.textContent = 'Click Start to begin';
    pieceInfo.textContent = state.mode === 'eogonim'
      ? "You'll get one random piece at a time, with no preview of what's coming - keep your captured territory as low as possible."
      : "You'll get one random piece at a time - place it anywhere it fits.";
  } else if (state.mode === 'eogonim' && state.finished) {
    banner.textContent = `Run over — captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`;
    pieceInfo.textContent = 'Click Restart to try for a lower score.';
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
      // Bigger than the default 8px/cell (used for the current-piece icon
      // and elsewhere) - these are the pieces players most need to plan
      // ahead around, so they're worth the extra visual weight.
      drawShapeIcon(c, BASE_SHAPES[shapeName], 14);
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
document.getElementById('spTabSpeedrun').addEventListener('click', () => setMode('speedrun'));
document.getElementById('spTabEogonim').addEventListener('click', () => setMode('eogonim'));

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

// Same server-decides-if-it's-better discipline as saveScoreIfBest(), via
// submit_singleplayer_score() instead of submit_singleplayer_time().
async function saveEogonimScoreIfBest(score) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestScore, error } = await supabaseClient.rpc('submit_singleplayer_score', { p_score: score });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestScore === score
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestScore}.`;
  refreshLeaderboard();
}

async function refreshLeaderboard() {
  const container = document.getElementById('spLeaderboard');
  const isEogonim = state.mode === 'eogonim';
  const scoreColumn = isEogonim ? 'score' : 'time_ms';
  const { data, error } = await supabaseClient
    .from('singleplayer_runs')
    .select(`${scoreColumn}, profiles(id, username, avatar_id, title_id)`)
    .eq('mode', state.mode)
    .order(scoreColumn, { ascending: true })
    .limit(10);

  if (error) {
    container.innerHTML = `<p>Could not load leaderboard: ${escapeHtml(error.message)}</p>`;
    return;
  }

  await Catalog.ready();

  const rows = (data || []).map((row, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="leaderboard-player-cell">${avatarHtml(row.profiles.avatar_id, 20)} <a href="profile.html?user=${encodeURIComponent(row.profiles.id)}">${escapeHtml(row.profiles.username)}</a> ${titleBadgeHtml(row.profiles.title_id)}</td>
      <td>${isEogonim ? row.score : formatTime(row.time_ms)}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>#</th><th>Player</th><th>${isEogonim ? 'Score' : 'Time'}</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No runs yet - be the first!</td></tr>'}</tbody>
    </table>
  `;
}

// ---------- Init ----------
updateModeUI();
render();
refreshLeaderboard();
