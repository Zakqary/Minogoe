// Live spectator viewer. Connects directly to the signaling server (not
// through net.js/game.js at all - a spectator is never a WebRTC peer, has
// no data channel, and is invisible to the two actual players) and renders
// moves as they're relayed in. Shape/board rendering is duplicated from
// replay.js rather than shared, same reasoning replay.js itself gives for
// duplicating from game.js: this only needs to draw a board and hands from
// a move log, not run the interactive game.

const TARGET_BOARD_PX = 480; // 12 * 40, the normal square board's on-screen size
let CELL_PX = 40;

// Duplicated from game.js's own BOARD_SHAPES (same reasoning as everything
// else in this file) - must generate byte-identical masks, since the host
// only ever transmits the shape id, never the raw mask (see game.js's
// recordGameResult()/live-game-start comment).
const BOARD_SHAPES = {
  square: null,
  plus: (size) => {
    const mask = new Uint8Array(size * size);
    const armWidth = Math.round(size / 2.4);
    const lo = Math.floor((size - armWidth) / 2);
    const hi = lo + armWidth;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!(c >= lo && c < hi) && !(r >= lo && r < hi)) mask[r * size + c] = 1;
      }
    }
    return mask;
  },
  x: (size) => {
    const mask = new Uint8Array(size * size);
    const halfThickness = Math.round(size / 3.4);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const onMainDiag = Math.abs(r - c) <= halfThickness;
        const onAntiDiag = Math.abs(r - (size - 1 - c)) <= halfThickness;
        if (!onMainDiag && !onAntiDiag) mask[r * size + c] = 1;
      }
    }
    return mask;
  },
  heart: (size) => {
    const mask = new Uint8Array(size * size);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = ((c + 0.5) / size - 0.5) * 2.4;
        const y = (0.5 - (r + 0.5) / size) * 2.4 + 0.35;
        const val = (x * x + y * y - 1) ** 3 - x * x * y * y * y;
        if (val > 0) mask[r * size + c] = 1;
      }
    }
    return mask;
  },
};

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

const SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';

// ---------- Spectate state ----------
let boardSize = 12;
let boardShape = null; // null (square) | 'plus' | 'x' | 'heart'
let voidMask = new Uint8Array(boardSize * boardSize); // all-zero for square, always sized to match `board`
let moveLog = [];
let initialHand = [];
let board = null;
let mode = null;
let player1 = null;
let player2 = null;
let status = 'connecting'; // connecting | not-found | full | live | ended
let ws = null;
// Set once, at connect time, from which URL param was present (?match= vs
// ?ffa=) - never both. playerCount/players[] mirror game.js's own ffa
// shape; player1/player2 above stay exactly as before and are simply
// unused whenever isFfa is true.
let isFfa = false;
let playerCount = 2;
let players = [null, null, null, null]; // ffa only, seat-indexed
const PLAYER_COLORS = ['#5b7fd9', '#d97a52', '#7ec982', '#c96bd6'];
// Per-player resolved colors for this live game - recomputed once in
// resetGameState() (game start), same fallback logic as game.js's
// playerPieceColorHex()/replay.js's resolvedColors.
let resolvedColors = PLAYER_COLORS.slice();

function idxOf(r, c) { return r * boardSize + c; }

function applyAllMoves() {
  board = new Int8Array(boardSize * boardSize);
  for (const mv of moveLog) {
    const orientation = ORIENTATIONS[mv.shapeName][mv.orientationIndex];
    for (const [dr, dc] of orientation) {
      board[idxOf(mv.r0 + dr, mv.c0 + dc)] = mv.player;
    }
  }
}

// Same flood-fill scoring as game.js's own computeFinalScores() (duplicated
// rather than shared, same reasoning as everything else in this file),
// parameterized by boardSize since that's fixed in game.js but arrives
// from the server here. Every enclosed empty region bordered by only one
// player's pieces (or the board edge) scores for that player; a region
// touching both players' pieces stays undecided.
const HANDICAP_POINTS = 0.5;

// Whoever moves second gets the handicap (game.js's handicapPlayer()).
// state.startingPlayer is only ever randomized for vs-bot games - every
// game a spectator can watch is real online pvp, where the starting
// player is always 1, so the handicap recipient is always player 2. No
// need to transmit startingPlayer at all just to re-derive this.
const HANDICAP_PLAYER = 2;

// score3/score4 are always computed (the flood-fill/borderOwners core is
// owner-count-agnostic) but only ever non-zero when isFfa - the 2-player
// caller just ignores them, same generalization game.js's own
// computeFinalScores() uses.
function computeScores() {
  const visited = new Uint8Array(boardSize * boardSize);
  let score1 = 0, score2 = 0, score3 = 0, score4 = 0, undecided = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0 && !visited[i] && !voidMask[i]) {
      const regionCells = [i];
      visited[i] = 1;
      let qi = 0;
      const borderOwners = new Set();
      while (qi < regionCells.length) {
        const cur = regionCells[qi++];
        const r = Math.floor(cur / boardSize), c = cur % boardSize;
        const neighbors = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
        for (const [nr, nc] of neighbors) {
          if (nr < 0 || nr >= boardSize || nc < 0 || nc >= boardSize) continue;
          const nidx = idxOf(nr, nc);
          if (voidMask[nidx]) continue;
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
        else if (owner === 2) score2 += regionCells.length;
        else if (owner === 3) score3 += regionCells.length;
        else score4 += regionCells.length;
      } else {
        undecided += regionCells.length;
      }
    }
  }
  return {
    score1: score1 + (!isFfa && HANDICAP_PLAYER === 1 ? HANDICAP_POINTS : 0),
    score2: score2 + (!isFfa && HANDICAP_PLAYER === 2 ? HANDICAP_POINTS : 0),
    score3,
    score4,
    undecided,
  };
}

function renderScore() {
  const el = document.getElementById('spectateScore');
  if (!board) { el.textContent = ''; return; }
  const s = computeScores();
  const label = status === 'ended' ? 'Final' : 'Projected';
  if (isFfa) {
    const chips = [1, 2, 3, 4]
      .map((p) => `<span class="projected-value projected-p${p}">P${p} ${s[`score${p}`]}</span>`)
      .join('');
    el.innerHTML = `<span class="projected-label">${label}</span>${chips}<span class="projected-undecided">${s.undecided} undecided</span>`;
    return;
  }
  el.innerHTML = `
    <span class="projected-label">${label}</span>
    <span class="projected-value projected-p1">P1 ${s.score1}</span>
    <span class="projected-value projected-p2">P2 ${s.score2}</span>
    <span class="projected-undecided">${s.undecided} undecided</span>
  `;
}

function handsNow() {
  const hands = Array.from({ length: playerCount }, () => [...initialHand]);
  for (const mv of moveLog) {
    const hand = hands[mv.player - 1];
    const pos = hand.indexOf(mv.shapeName);
    if (pos !== -1) hand.splice(pos, 1);
  }
  return hands;
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
  const hands = handsNow();
  for (let p = 1; p <= playerCount; p++) renderHand(`hand${p}`, hands[p - 1]);
}

function drawBoard() {
  const canvas = document.getElementById('board');
  CELL_PX = TARGET_BOARD_PX / boardSize;
  canvas.width = boardSize * CELL_PX;
  canvas.height = boardSize * CELL_PX;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const cellIdx = idxOf(r, c);
      if (voidMask[cellIdx]) {
        ctx.fillStyle = '#0b0a0e';
        ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
        continue;
      }
      const val = board[cellIdx];
      ctx.fillStyle = val === 0 ? '#1e1b24' : resolvedColors[val - 1];
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
      ctx.strokeRect(c * CELL_PX + 0.5, r * CELL_PX + 0.5, CELL_PX - 1, CELL_PX - 1);
    }
  }
}

function playerDisplayName(p, num) {
  return p ? (p.username || 'Guest') : `Player ${num}`;
}

function renderMeta() {
  const el = document.getElementById('spectateMeta');
  if (status === 'connecting') {
    el.textContent = 'Connecting...';
    return;
  }
  if (status === 'not-found') {
    el.textContent = 'This game is no longer live - it may have already ended.';
    return;
  }
  if (status === 'full') {
    el.textContent = 'Too many people are already watching this game right now. Try again in a bit.';
    return;
  }

  const statusText = status === 'ended' ? 'Game over' : 'Live';

  if (isFfa) {
    const names = players.map((p, i) => playerDisplayName(p, i + 1));
    const html = players
      .map((p, i) => (p
        ? `${avatarHtml(p.avatarId, 20)} <strong style="color:${resolvedColors[i]}">${escapeHtml(names[i])}</strong> ${titleBadgeHtml(p.titleId)}`
        : `<strong style="color:${resolvedColors[i]}">${escapeHtml(names[i])}</strong>`))
      .join(' vs ');
    el.innerHTML = `
      <div>${html}</div>
      <div>Mode: free-for-all &middot; <strong>${statusText}</strong></div>
    `;
    return;
  }

  const p1Name = playerDisplayName(player1, 1);
  const p2Name = playerDisplayName(player2, 2);
  const p1Html = player1
    ? `${avatarHtml(player1.avatarId, 20)} <strong style="color:${resolvedColors[0]}">${escapeHtml(p1Name)}</strong> ${titleBadgeHtml(player1.titleId)}`
    : `<strong style="color:${resolvedColors[0]}">${escapeHtml(p1Name)}</strong>`;
  const p2Html = player2
    ? `${avatarHtml(player2.avatarId, 20)} <strong style="color:${resolvedColors[1]}">${escapeHtml(p2Name)}</strong> ${titleBadgeHtml(player2.titleId)}`
    : `<strong style="color:${resolvedColors[1]}">${escapeHtml(p2Name)}</strong>`;

  el.innerHTML = `
    <div>${p1Html} vs ${p2Html}</div>
    <div>Mode: ${escapeHtml(mode || '')} &middot; <strong>${statusText}</strong></div>
  `;
}

function renderAll() {
  renderMeta();
  applyAllMoves();
  drawBoard();
  renderHands();
  renderScore();
  document.getElementById('stepInfo').textContent = `Move ${moveLog.length}`;
}

function resetGameState(msg) {
  boardSize = msg.boardSize || 12;
  if (isFfa) {
    playerCount = 4;
    boardShape = null;
    voidMask = new Uint8Array(boardSize * boardSize); // ffa never uses a custom board shape
    players = msg.players || [null, null, null, null];
    resolvedColors = players.map((p, i) => pieceColorHex(p ? p.pieceColorId : null) || PLAYER_COLORS[i]);
    document.getElementById('handBlock3').classList.remove('ffa-only');
    document.getElementById('handBlock4').classList.remove('ffa-only');
  } else {
    boardShape = msg.boardShape || null;
    const shapeMaskFn = boardShape && BOARD_SHAPES[boardShape];
    voidMask = shapeMaskFn ? shapeMaskFn(boardSize) : new Uint8Array(boardSize * boardSize);
    player1 = msg.player1 || null;
    player2 = msg.player2 || null;
    resolvedColors = [
      pieceColorHex(player1 ? player1.pieceColorId : null) || PLAYER_COLORS[0],
      pieceColorHex(player2 ? player2.pieceColorId : null) || PLAYER_COLORS[1],
    ];
    // Same collision rule as game.js's playerPieceColorHex() - player 1
    // wins a tie, player 2 falls back to their positional default.
    if (resolvedColors[1] === resolvedColors[0]) resolvedColors[1] = PLAYER_COLORS[1];
    mode = msg.mode || null;
  }
  initialHand = msg.initialHand || [];
  moveLog = msg.moveLog || [];
  status = 'live';
}

function handleSpectateMessage(msg) {
  // ffa- prefixed message types carry the exact same payload shape as
  // their 2-player equivalents (just a `players` array instead of
  // player1/player2, handled inside resetGameState()) - normalizing the
  // type here means the rest of this function doesn't need to know which
  // protocol it came from.
  const type = msg.type.startsWith('ffa-spectate') ? msg.type.slice(4) : msg.type;

  if (type === 'spectate-not-found') {
    status = 'not-found';
    renderMeta();
    return;
  }
  if (type === 'spectate-full') {
    status = 'full';
    renderMeta();
    return;
  }
  if (type === 'spectate-snapshot') {
    resetGameState(msg);
    renderAll();
    return;
  }
  if (type === 'spectate-reset') {
    resetGameState({ ...msg, moveLog: [] });
    renderAll();
    return;
  }
  if (type === 'spectate-move') {
    moveLog.push({ player: msg.player, shapeName: msg.shapeName, orientationIndex: msg.orientationIndex, r0: msg.r0, c0: msg.c0, t: msg.t });
    renderAll();
    return;
  }
  if (type === 'spectate-ended') {
    status = 'ended';
    renderMeta();
    renderScore(); // flips the label from "Projected" to "Final"
    return;
  }
}

async function connectSpectator() {
  const params = new URLSearchParams(location.search);
  const matchId = params.get('match') || params.get('ffa');
  isFfa = !params.get('match') && !!params.get('ffa');
  const metaEl = document.getElementById('spectateMeta');

  if (!matchId) {
    metaEl.textContent = 'No game specified. Open a spectate link from the Play page.';
    return;
  }

  // Ensures Catalog.get() can resolve a piece-color id the moment the first
  // 'live-game-start'/'ffa-live-game-start' message arrives - resetGameState()
  // only computes resolvedColors once, at game start, so if Catalog weren't
  // ready yet a custom color would otherwise never show for that connection.
  await Catalog.ready();

  try {
    ws = new WebSocket(SIGNALING_SERVER_URL);
  } catch {
    metaEl.textContent = 'Could not reach the signaling server.';
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: isFfa ? 'ffa-spectate-join' : 'spectate-join', matchId }));
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleSpectateMessage(msg);
  };
  ws.onerror = () => {
    if (status === 'connecting') metaEl.textContent = 'Could not reach the signaling server.';
  };
  ws.onclose = () => {
    if (status === 'live') {
      metaEl.textContent = 'Connection lost. Reload the page to resume watching.';
    }
  };
}

connectSpectator();
