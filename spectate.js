// Live spectator viewer. Connects directly to the signaling server (not
// through net.js/game.js at all - a spectator is never a WebRTC peer, has
// no data channel, and is invisible to the two actual players) and renders
// moves as they're relayed in. Shape/board rendering is duplicated from
// replay.js rather than shared, same reasoning replay.js itself gives for
// duplicating from game.js: this only needs to draw a board and hands from
// a move log, not run the interactive game.

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

const SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';

// ---------- Spectate state ----------
let boardSize = 12;
let moveLog = [];
let initialHand = [];
let board = null;
let mode = null;
let player1 = null;
let player2 = null;
let status = 'connecting'; // connecting | not-found | full | live | ended
let ws = null;

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

function computeScores() {
  const visited = new Uint8Array(boardSize * boardSize);
  let score1 = 0, score2 = 0, undecided = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0 && !visited[i]) {
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
        if (owner === 1) score1 += regionCells.length; else score2 += regionCells.length;
      } else {
        undecided += regionCells.length;
      }
    }
  }
  return {
    score1: score1 + (HANDICAP_PLAYER === 1 ? HANDICAP_POINTS : 0),
    score2: score2 + (HANDICAP_PLAYER === 2 ? HANDICAP_POINTS : 0),
    undecided,
  };
}

function renderScore() {
  const el = document.getElementById('spectateScore');
  if (!board) { el.textContent = ''; return; }
  const s = computeScores();
  const label = status === 'ended' ? 'Final' : 'Projected';
  el.innerHTML = `
    <span class="projected-label">${label}</span>
    <span class="projected-value projected-p1">P1 ${s.score1}</span>
    <span class="projected-value projected-p2">P2 ${s.score2}</span>
    <span class="projected-undecided">${s.undecided} undecided</span>
  `;
}

function handsNow() {
  const hand1 = [...initialHand];
  const hand2 = [...initialHand];
  for (const mv of moveLog) {
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
  const { hand1, hand2 } = handsNow();
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

  const p1Name = playerDisplayName(player1, 1);
  const p2Name = playerDisplayName(player2, 2);
  const p1Html = player1
    ? `${avatarHtml(player1.avatarId, 20)} <strong>${escapeHtml(p1Name)}</strong> ${titleBadgeHtml(player1.titleId)}`
    : `<strong>${escapeHtml(p1Name)}</strong>`;
  const p2Html = player2
    ? `${avatarHtml(player2.avatarId, 20)} <strong>${escapeHtml(p2Name)}</strong> ${titleBadgeHtml(player2.titleId)}`
    : `<strong>${escapeHtml(p2Name)}</strong>`;
  const statusText = status === 'ended' ? 'Game over' : 'Live';

  el.innerHTML = `
    <div>${p1Html} (Player 1, blue) vs ${p2Html} (Player 2, red)</div>
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
  initialHand = msg.initialHand || [];
  moveLog = msg.moveLog || [];
  player1 = msg.player1 || null;
  player2 = msg.player2 || null;
  mode = msg.mode || null;
  status = 'live';
}

function handleSpectateMessage(msg) {
  if (msg.type === 'spectate-not-found') {
    status = 'not-found';
    renderMeta();
    return;
  }
  if (msg.type === 'spectate-full') {
    status = 'full';
    renderMeta();
    return;
  }
  if (msg.type === 'spectate-snapshot') {
    resetGameState(msg);
    renderAll();
    return;
  }
  if (msg.type === 'spectate-reset') {
    resetGameState({ ...msg, moveLog: [] });
    renderAll();
    return;
  }
  if (msg.type === 'spectate-move') {
    moveLog.push({ player: msg.player, shapeName: msg.shapeName, orientationIndex: msg.orientationIndex, r0: msg.r0, c0: msg.c0, t: msg.t });
    renderAll();
    return;
  }
  if (msg.type === 'spectate-ended') {
    status = 'ended';
    renderMeta();
    renderScore(); // flips the label from "Projected" to "Final"
    return;
  }
}

function connectSpectator() {
  const params = new URLSearchParams(location.search);
  const matchId = params.get('match');
  const metaEl = document.getElementById('spectateMeta');

  if (!matchId) {
    metaEl.textContent = 'No game specified. Open a spectate link from the Play page.';
    return;
  }

  try {
    ws = new WebSocket(SIGNALING_SERVER_URL);
  } catch {
    metaEl.textContent = 'Could not reach the signaling server.';
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'spectate-join', matchId }));
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
