// ---------- Configuration ----------
const BOARD_SIZE = 12;
const CELL_PX = 40; // 12 * 40 = 480px board
const HAND_COMPOSITION = { pentomino: 7, tetromino: 2, tromino: 1 };
const HANDICAP_P2 = 1; // player 2 moves second, so they start with a 1-point head start
const SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';

// ---------- Base shapes (row, col), keyed and prefixed by piece size ----------
const BASE_SHAPES = {
  // Pentominoes (5 cells)
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

  // Tetrominoes (4 cells)
  Q_I: [[0,0],[0,1],[0,2],[0,3]],
  Q_O: [[0,0],[0,1],[1,0],[1,1]],
  Q_T: [[0,0],[0,1],[0,2],[1,1]],
  Q_S: [[0,1],[0,2],[1,0],[1,1]],
  Q_Z: [[0,0],[0,1],[1,1],[1,2]],
  Q_L: [[0,0],[1,0],[2,0],[2,1]],
  Q_J: [[0,1],[1,1],[2,1],[2,0]],

  // Trominoes (3 cells)
  R_I: [[0,0],[0,1],[0,2]],
  R_L: [[0,0],[1,0],[1,1]],
};

const PENTOMINO_NAMES = Object.keys(BASE_SHAPES).filter(n => n.startsWith('P_'));
const TETROMINO_NAMES = Object.keys(BASE_SHAPES).filter(n => n.startsWith('Q_'));
const TROMINO_NAMES = Object.keys(BASE_SHAPES).filter(n => n.startsWith('R_'));

function normalize(coords) {
  const minR = Math.min(...coords.map(p => p[0]));
  const minC = Math.min(...coords.map(p => p[1]));
  return coords
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
}

function rotate90(coords) {
  return normalize(coords.map(([r, c]) => [c, -r]));
}

function mirror(coords) {
  return normalize(coords.map(([r, c]) => [r, -c]));
}

function generateOrientations(base) {
  const seen = new Set();
  const result = [];
  let shape = normalize(base);
  for (const useMirror of [false, true]) {
    let cur = useMirror ? mirror(shape) : shape;
    for (let i = 0; i < 4; i++) {
      const key = JSON.stringify(cur);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(cur);
      }
      cur = rotate90(cur);
    }
  }
  return result;
}

const ORIENTATIONS = {};
for (const name of Object.keys(BASE_SHAPES)) {
  ORIENTATIONS[name] = generateOrientations(BASE_SHAPES[name]);
}

// ---------- Game state ----------
const state = {
  board: null,      // Int8Array, 0 empty, 1 = P1, 2 = P2
  hand1: [],
  hand2: [],
  score1: 0,
  score2: 0,
  turn: 1,
  gameOver: false,
  selected: null,   // { shapeName, orientationIndex }
  mouseRC: null,    // { row, col } raw hovered cell
  hover: null,      // { r0, c0, valid }
  history: [],      // stack of snapshots for undo
  online: false,    // true once paired with a remote peer
  myPlayer: null,   // 1 or 2 when online; null in local hotseat mode
  connecting: false, // true from the moment Connect is clicked until paired (or given up)
  opponentUserId: null, // the connected peer's Supabase user id, if they're logged in
  gameStartedAt: null,
  initialHand: [],  // the pristine drawn hand, for replay reconstruction
  moveLog: [],      // ordered { player, shapeName, orientationIndex, r0, c0 } placements
  vsBot: false,     // true when player 2 is controlled by the local bot AI
};

function snapshotState() {
  return {
    board: state.board.slice(),
    hand1: [...state.hand1],
    hand2: [...state.hand2],
    score1: state.score1,
    score2: state.score2,
    turn: state.turn,
    gameOver: state.gameOver,
    moveLog: [...state.moveLog],
  };
}

function idx(r, c) { return r * BOARD_SIZE + c; }

function pickRandom(names, count) {
  const picks = [];
  for (let i = 0; i < count; i++) {
    picks.push(names[Math.floor(Math.random() * names.length)]);
  }
  return picks;
}

function drawHand() {
  return [
    ...pickRandom(PENTOMINO_NAMES, HAND_COMPOSITION.pentomino),
    ...pickRandom(TETROMINO_NAMES, HAND_COMPOSITION.tetromino),
    ...pickRandom(TROMINO_NAMES, HAND_COMPOSITION.tromino),
  ];
}

function newGame(remoteHand) {
  const isRemote = remoteHand !== undefined;

  if (state.connecting && !isRemote) return;

  if (state.online && !Net.isHost && !isRemote) {
    log('Only the host can start a new game - ask them to click New Game.');
    return;
  }

  state.board = new Int8Array(BOARD_SIZE * BOARD_SIZE);
  const hand = remoteHand || drawHand();
  state.hand1 = [...hand];
  state.hand2 = [...hand];
  state.initialHand = [...hand];
  state.moveLog = [];
  state.score1 = 0;
  state.score2 = HANDICAP_P2;
  state.turn = 1;
  state.gameOver = false;
  state.selected = null;
  state.mouseRC = null;
  state.hover = null;
  state.history = [];
  state.gameStartedAt = new Date().toISOString();
  clearLog();
  log(`New game started. Both players drew the same hand. Player 2 starts with a ${HANDICAP_P2}-point handicap.`);
  checkGameEnd();
  render();

  if (state.online && Net.isHost && !isRemote) {
    Net.send({ type: 'newgame', hand });
  }
}

// ---------- Placement validity ----------
function isValidPlacement(shapeName, orientationIndex, r0, c0, board) {
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  for (const [dr, dc] of orientation) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return false;
    if (board[idx(r, c)] !== 0) return false;
  }
  return true;
}

function hasAnyLegalMove(hand, board) {
  const distinct = new Set(hand);
  for (const shapeName of distinct) {
    for (const orientation of ORIENTATIONS[shapeName]) {
      const maxDr = Math.max(...orientation.map(p => p[0]));
      const maxDc = Math.max(...orientation.map(p => p[1]));
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
  }
  return false;
}

// ---------- Bot AI (local "vs Bot" mode only) ----------
function enumerateLegalPlacements(hand, board) {
  const distinct = new Set(hand);
  const placements = [];
  for (const shapeName of distinct) {
    for (let orientationIndex = 0; orientationIndex < ORIENTATIONS[shapeName].length; orientationIndex++) {
      const orientation = ORIENTATIONS[shapeName][orientationIndex];
      const maxDr = Math.max(...orientation.map(p => p[0]));
      const maxDc = Math.max(...orientation.map(p => p[1]));
      for (let r0 = 0; r0 <= BOARD_SIZE - 1 - maxDr; r0++) {
        for (let c0 = 0; c0 <= BOARD_SIZE - 1 - maxDc; c0++) {
          let ok = true;
          for (const [dr, dc] of orientation) {
            if (board[idx(r0 + dr, c0 + dc)] !== 0) { ok = false; break; }
          }
          if (ok) placements.push({ shapeName, orientationIndex, r0, c0 });
        }
      }
    }
  }
  return placements;
}

function scoreBotCandidate(candidate, board, player) {
  const opponent = player === 1 ? 2 : 1;
  const orientation = ORIENTATIONS[candidate.shapeName][candidate.orientationIndex];
  let ownAdj = 0, oppAdj = 0;
  for (const [dr, dc] of orientation) {
    const r = candidate.r0 + dr, c = candidate.c0 + dc;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      const val = board[idx(nr, nc)];
      if (val === player) ownAdj++;
      else if (val === opponent) oppAdj++;
    }
  }
  return ownAdj * 2 - oppAdj + Math.random() * 0.5;
}

function pickBotPlacement(hand, board, player) {
  const placements = enumerateLegalPlacements(hand, board);
  if (placements.length === 0) return null;
  let best = null, bestScore = -Infinity;
  for (const cand of placements) {
    const s = scoreBotCandidate(cand, board, player);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  return best;
}

function scheduleBotMove() {
  if (!state.vsBot || state.gameOver || state.turn !== 2) return;
  setTimeout(() => {
    if (!state.vsBot || state.gameOver || state.turn !== 2) return;
    const best = pickBotPlacement(state.hand2, state.board, 2);
    if (best) {
      commitPlacement(best.shapeName, best.orientationIndex, best.r0, best.c0);
    }
  }, 500);
}

// ---------- Final scoring ----------
function computeFinalScores(board) {
  const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  let score1 = 0, score2 = 0, undecided = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0 && !visited[i]) {
      const regionCells = [i];
      visited[i] = 1;
      let qi = 0;
      const borderOwners = new Set();
      while (qi < regionCells.length) {
        const cur = regionCells[qi++];
        const r = Math.floor(cur / BOARD_SIZE), c = cur % BOARD_SIZE;
        const neighbors = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
        for (const [nr, nc] of neighbors) {
          if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
          const nidx = idx(nr, nc);
          const val = board[nidx];
          if (val === 0) {
            if (!visited[nidx]) { visited[nidx] = 1; regionCells.push(nidx); }
          } else {
            borderOwners.add(val);
          }
        }
      }
      if (borderOwners.size === 1) {
        const owner = [...borderOwners][0];
        if (owner === 1) score1 += regionCells.length;
        else score2 += regionCells.length;
      } else {
        undecided += regionCells.length;
      }
    }
  }
  return { score1, score2, undecided };
}

// ---------- Turn logic ----------
function switchTurn() {
  state.turn = state.turn === 1 ? 2 : 1;
}

function checkGameEnd() {
  if (state.gameOver) return;
  const p1Stuck = !hasAnyLegalMove(state.hand1, state.board);
  const p2Stuck = !hasAnyLegalMove(state.hand2, state.board);
  if (p1Stuck || p2Stuck) {
    endGame(p1Stuck, p2Stuck);
  }
}

function commitPlacement(shapeName, orientationIndex, r0, c0, fromRemote = false) {
  if (state.online && !fromRemote && state.myPlayer !== state.turn) return;

  state.history.push(snapshotState());

  const player = state.turn;
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  for (const [dr, dc] of orientation) {
    state.board[idx(r0 + dr, c0 + dc)] = player;
  }
  const hand = player === 1 ? state.hand1 : state.hand2;
  hand.splice(hand.indexOf(shapeName), 1);
  state.moveLog.push({ player, shapeName, orientationIndex, r0, c0 });
  log(`Player ${player} placed ${shapeName}-pentomino. ${hand.length} piece(s) left.`);

  state.selected = null;
  state.hover = null;

  switchTurn();
  checkGameEnd();
  render();

  if (state.online && !fromRemote) {
    Net.send({ type: 'move', shapeName, orientationIndex, r0, c0 });
  }

  scheduleBotMove();
}

function applySnapshot(snap) {
  state.board = snap.board;
  state.hand1 = snap.hand1;
  state.hand2 = snap.hand2;
  state.score1 = snap.score1;
  state.score2 = snap.score2;
  state.turn = snap.turn;
  state.gameOver = snap.gameOver;
  state.moveLog = snap.moveLog;
}

function undoTurn(fromRemote = false) {
  if (state.connecting && !fromRemote) return;
  if (state.history.length === 0) return;
  applySnapshot(state.history.pop());

  // In vs-bot mode, a single undo should always land back on the human's
  // turn, so also undo the bot's reply if that's what we just landed on.
  if (state.vsBot && !state.gameOver && state.turn === 2 && state.history.length > 0) {
    applySnapshot(state.history.pop());
  }

  state.selected = null;
  state.hover = null;
  log('Last move undone.');
  render();

  if (state.online && !fromRemote) {
    Net.send({ type: 'undo' });
  }
}

function endGame(p1Stuck, p2Stuck) {
  if (state.gameOver) return;
  state.gameOver = true;
  const { score1, score2, undecided } = computeFinalScores(state.board);
  state.score1 = score1;
  state.score2 = score2 + HANDICAP_P2;

  let reason;
  if (p1Stuck && p2Stuck) reason = 'Neither player has a legal move left.';
  else if (p1Stuck) reason = 'Player 1 has no legal move left.';
  else reason = 'Player 2 has no legal move left.';

  let result;
  if (state.score1 > state.score2) result = 'Player 1 wins!';
  else if (state.score2 > state.score1) result = 'Player 2 wins!';
  else result = "It's a tie!";
  log(`Game over — ${reason} Final score - P1: ${state.score1}, P2: ${state.score2}, Undecided: ${undecided}. ${result}`);

  recordGameResult();
}

async function recordGameResult() {
  const winner = state.score1 > state.score2 ? 1 : state.score2 > state.score1 ? 2 : null;

  let row = null;
  if (state.vsBot) {
    const me = Auth.getUser();
    if (!me) return; // must be logged in to save a bot match
    row = {
      mode: 'bot',
      player1_id: me.id,
      player2_id: null,
      score1: state.score1,
      score2: state.score2,
      winner,
      initial_hand: state.initialHand,
      move_log: state.moveLog,
      board_size: BOARD_SIZE,
      started_at: state.gameStartedAt,
    };
  } else {
    if (!state.online || !Net.isHost) return; // only the host records, and only for online games
    const me = Auth.getUser();
    if (!me || !state.opponentUserId) return; // both sides must be logged in
    row = {
      mode: 'private',
      player1_id: me.id,
      player2_id: state.opponentUserId,
      score1: state.score1,
      score2: state.score2,
      winner,
      initial_hand: state.initialHand,
      move_log: state.moveLog,
      board_size: BOARD_SIZE,
      started_at: state.gameStartedAt,
    };
  }

  const { error } = await supabaseClient.from('games').insert(row);
  if (error) {
    log('Could not save game result: ' + error.message);
  } else {
    log('Game result saved to your match history.');
  }
}

// ---------- Selection / hover ----------
function selectShape(shapeName) {
  if (state.gameOver || state.connecting) return;
  if (state.online && state.myPlayer !== state.turn) return;
  state.selected = { shapeName, orientationIndex: 0 };
  recomputeHover();
  render();
}

function rotateSelected() {
  if (!state.selected) return;
  const len = ORIENTATIONS[state.selected.shapeName].length;
  state.selected.orientationIndex = (state.selected.orientationIndex + 1) % len;
  recomputeHover();
  updateSelectionInfo();
  drawBoard();
}

function recomputeHover() {
  if (!state.selected || !state.mouseRC) { state.hover = null; return; }
  const { shapeName, orientationIndex } = state.selected;
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  const h = Math.max(...orientation.map(p => p[0])) + 1;
  const w = Math.max(...orientation.map(p => p[1])) + 1;
  const r0 = state.mouseRC.row - Math.floor(h / 2);
  const c0 = state.mouseRC.col - Math.floor(w / 2);
  state.hover = { r0, c0, valid: isValidPlacement(shapeName, orientationIndex, r0, c0, state.board) };
}

// ---------- Rendering ----------
const canvas = document.getElementById('board');
canvas.width = BOARD_SIZE * CELL_PX;
canvas.height = BOARD_SIZE * CELL_PX;
const ctx = canvas.getContext('2d');

function drawBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const val = state.board[idx(r, c)];
      ctx.fillStyle = val === 1 ? '#3b82f6' : val === 2 ? '#ef4444' : '#20242c';
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= BOARD_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL_PX, 0);
    ctx.lineTo(i * CELL_PX, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL_PX);
    ctx.lineTo(canvas.width, i * CELL_PX);
    ctx.stroke();
  }

  if (state.selected && state.hover && !state.gameOver) {
    const orientation = ORIENTATIONS[state.selected.shapeName][state.selected.orientationIndex];
    const color = state.hover.valid
      ? (state.turn === 1 ? 'rgba(59,130,246,0.55)' : 'rgba(239,68,68,0.55)')
      : 'rgba(140,140,140,0.5)';
    ctx.fillStyle = color;
    for (const [dr, dc] of orientation) {
      const r = state.hover.r0 + dr, c = state.hover.c0 + dc;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
}

function render() {
  drawBoard();

  const banner = document.getElementById('turnBanner');
  if (state.gameOver) {
    banner.textContent = 'Game over';
  } else if (state.online) {
    const you = state.myPlayer === state.turn ? ' (your turn)' : " (opponent's turn)";
    banner.textContent = `Player ${state.turn}'s turn${you}`;
  } else {
    banner.textContent = `Player ${state.turn}'s turn`;
  }

  document.getElementById('score1').textContent = state.score1;
  document.getElementById('score2').textContent = state.score2;

  const proj = computeFinalScores(state.board);
  document.getElementById('projected').innerHTML =
    `Projected if game ended now: P1 ${proj.score1} &middot; P2 ${proj.score2 + HANDICAP_P2} &middot; Undecided ${proj.undecided}`;

  renderHand('hand1', state.hand1, 1);
  renderHand('hand2', state.hand2, 2);

  updateSelectionInfo();

  canvas.classList.toggle('placing', !!state.selected && !state.gameOver);

  document.getElementById('rotateBtn').disabled = state.connecting;
  document.getElementById('newGameBtn').disabled = state.connecting;
  document.getElementById('undoBtn').disabled = state.connecting || state.history.length === 0;

  document.getElementById('hotseatBtn').classList.toggle('active', !state.vsBot);
  document.getElementById('vsBotBtn').classList.toggle('active', state.vsBot);
  document.getElementById('hotseatBtn').disabled = state.online;
  document.getElementById('vsBotBtn').disabled = state.online;
}

function updateSelectionInfo() {
  const el = document.getElementById('selectionInfo');
  if (state.gameOver) {
    el.textContent = 'Game over.';
  } else if (!state.selected) {
    el.textContent = `Player ${state.turn}: click a piece in your hand below to select it.`;
  } else {
    const len = ORIENTATIONS[state.selected.shapeName].length;
    el.textContent = `Placing ${state.selected.shapeName}-pentomino (orientation ${state.selected.orientationIndex + 1}/${len}). Click the board to place, or press R to rotate/flip.`;
  }
}

function drawShapeIcon(canvasEl, coords) {
  const px = 8;
  const maxR = Math.max(...coords.map(p => p[0])) + 1;
  const maxC = Math.max(...coords.map(p => p[1])) + 1;
  canvasEl.width = maxC * px;
  canvasEl.height = maxR * px;
  const cctx = canvasEl.getContext('2d');
  cctx.fillStyle = '#d8dbe0';
  for (const [r, c] of coords) {
    cctx.fillRect(c * px, r * px, px - 1, px - 1);
  }
}

function renderHand(elId, hand, player) {
  const counts = {};
  for (const s of hand) counts[s] = (counts[s] || 0) + 1;
  const el = document.getElementById(elId);
  el.innerHTML = '';

  const container = el.closest('.hand');
  const isActive = player === state.turn && !state.gameOver && !state.connecting
    && (!state.online || player === state.myPlayer)
    && !(state.vsBot && player === 2);
  container.classList.toggle('inactive', !isActive);

  const names = Object.keys(counts).sort();
  if (names.length === 0) {
    el.innerHTML = '<span>empty</span>';
    return;
  }
  for (const name of names) {
    const item = document.createElement('div');
    item.className = 'piece-icon';
    if (isActive && state.selected && state.selected.shapeName === name) {
      item.classList.add('selected');
    }
    const iconCanvas = document.createElement('canvas');
    drawShapeIcon(iconCanvas, BASE_SHAPES[name]);
    item.appendChild(iconCanvas);
    const countEl = document.createElement('div');
    countEl.className = 'count';
    countEl.textContent = `${counts[name]}`;
    item.appendChild(countEl);

    if (isActive) {
      item.addEventListener('click', () => selectShape(name));
    }
    el.appendChild(item);
  }
}

// ---------- Log ----------
function log(msg) {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  div.textContent = msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
}

// ---------- Canvas interaction ----------
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const col = Math.floor(x / CELL_PX), row = Math.floor(y / CELL_PX);
  state.mouseRC = { row, col };
  recomputeHover();
  drawBoard();
});

canvas.addEventListener('mouseleave', () => {
  state.mouseRC = null;
  state.hover = null;
  drawBoard();
});

canvas.addEventListener('click', () => {
  if (state.gameOver || state.connecting || !state.selected || !state.hover || !state.hover.valid) return;
  if (state.online && state.myPlayer !== state.turn) return;
  commitPlacement(state.selected.shapeName, state.selected.orientationIndex, state.hover.r0, state.hover.c0);
});

// ---------- Controls ----------
document.getElementById('rotateBtn').addEventListener('click', rotateSelected);
document.getElementById('undoBtn').addEventListener('click', () => undoTurn());

document.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    rotateSelected();
  }
});

document.getElementById('newGameBtn').addEventListener('click', () => {
  newGame();
});

document.getElementById('hotseatBtn').addEventListener('click', () => {
  if (state.online) return;
  state.vsBot = false;
  newGame();
});

document.getElementById('vsBotBtn').addEventListener('click', () => {
  if (state.online) return;
  state.vsBot = true;
  newGame();
});

// ---------- Online play ----------
function setLobbyStatus(text) {
  document.getElementById('onlineStatus').textContent = text;
}

function handleNetReady() {
  state.online = true;
  state.connecting = false;
  state.vsBot = false;
  state.myPlayer = Net.isHost ? 1 : 2;
  state.opponentUserId = null;
  document.getElementById('connectBtn').disabled = true;
  document.getElementById('roomInput').disabled = true;
  setLobbyStatus(`Connected! You are Player ${state.myPlayer}.`);
  log(`Connected to opponent. You are Player ${state.myPlayer}.`);

  Net.send({ type: 'identify', userId: Auth.getUser()?.id ?? null });

  if (Net.isHost) {
    newGame();
  } else {
    render();
  }
}

function handleNetData(msg) {
  if (msg.type === 'newgame') {
    newGame(msg.hand);
  } else if (msg.type === 'move') {
    commitPlacement(msg.shapeName, msg.orientationIndex, msg.r0, msg.c0, true);
  } else if (msg.type === 'undo') {
    undoTurn(true);
  } else if (msg.type === 'identify') {
    state.opponentUserId = msg.userId;
  }
}

function handleNetPeerLeft() {
  log('Your opponent disconnected.');
  setLobbyStatus('Opponent disconnected.');
  render();
}

document.getElementById('connectBtn').addEventListener('click', () => {
  const room = document.getElementById('roomInput').value.trim();
  if (!room) {
    setLobbyStatus('Enter a room code.');
    return;
  }
  state.connecting = true;
  render();
  setLobbyStatus('Connecting... (if this seems stuck for a while, it is safe to click Connect again to retry)');
  Net.connect({
    serverUrl: SIGNALING_SERVER_URL,
    room,
    onStatus: setLobbyStatus,
    onReady: handleNetReady,
    onData: handleNetData,
    onPeerLeft: handleNetPeerLeft,
  });
});

// ---------- Init ----------
newGame();
