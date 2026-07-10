// ---------- Configuration ----------
const BOARD_SIZE = 12;
const CELL_PX = 52; // 12 * 52 = 624px board
const HAND_COMPOSITION = { pentomino: 7, tetromino: 2, tromino: 1 };
const HANDICAP_P2 = 1; // player 2 moves second, so they start with a 1-point head start
const SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';
const TURN_TIME_LIMITS = { casual: 120, ranked: 60 }; // seconds; private/bot/hotseat are untimed
const ACTIVE_MATCH_KEY = 'minogoe_activeMatch'; // localStorage key for reconnect-after-reload

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
  gameStarted: false, // true once a hand has actually been drawn and a game is underway
  board: new Int8Array(BOARD_SIZE * BOARD_SIZE),
  hand1: [],
  hand2: [],
  score1: 0,
  score2: 0,
  turn: 1,
  plyCount: 0,        // increments every turn switch (placement or pass) - used to detect turn transitions
  gameOver: false,
  selected: null,     // { shapeName, orientationIndex }
  mouseRC: null,      // { row, col } raw hovered cell
  hover: null,        // { r0, c0, valid }
  history: [],        // stack of snapshots for undo
  online: false,      // true once paired with a remote peer
  myPlayer: null,     // 1 or 2 when online; null in local hotseat mode
  connecting: false,  // true from the moment Connect is clicked until paired (or given up)
  opponentUserId: null,   // the connected peer's Supabase user id, if they're logged in
  opponentUsername: null, // the connected peer's username, if they're logged in
  gameStartedAt: null,
  initialHand: [],    // the pristine drawn hand, for replay reconstruction
  moveLog: [],        // ordered { player, shapeName, orientationIndex, r0, c0 } placements
  lastMove: null,     // { shapeName, orientationIndex, r0, c0, player } - for the on-board highlight
  vsBot: false,       // true when player 2 is controlled by the local bot AI
  gameMode: 'private', // 'private' | 'casual' | 'ranked', set from Net.matchedMode once paired
  passStreak: 0,      // consecutive passes (forced or voluntary); 2 in a row ends the game
  pendingUndoRequest: false,  // true once I've asked to undo and am waiting on my opponent
  incomingUndoRequest: false, // true when my opponent has asked to undo and I need to respond
  pendingNewGameRequest: false,  // true once I've asked for a rematch and am waiting on my opponent (casual/ranked)
  incomingNewGameRequest: false, // true when my opponent has asked for a rematch and I need to respond
  turnDeadline: null, // epoch ms when the current online turn times out (casual/ranked only)
  lastTapCell: null,  // touch only: last cell tapped on the board, for tap-to-preview/tap-again-to-confirm
  scoringCells: null, // [{index, owner}] - set once the game ends, for the scoring-square dots
};

function snapshotState() {
  return {
    board: state.board.slice(),
    hand1: [...state.hand1],
    hand2: [...state.hand2],
    score1: state.score1,
    score2: state.score2,
    turn: state.turn,
    plyCount: state.plyCount,
    gameOver: state.gameOver,
    moveLog: [...state.moveLog],
    lastMove: state.lastMove,
    passStreak: state.passStreak,
  };
}

function applySnapshot(snap) {
  state.board = snap.board;
  state.hand1 = snap.hand1;
  state.hand2 = snap.hand2;
  state.score1 = snap.score1;
  state.score2 = snap.score2;
  state.turn = snap.turn;
  state.plyCount = snap.plyCount;
  state.gameOver = snap.gameOver;
  state.moveLog = snap.moveLog;
  state.lastMove = snap.lastMove;
  state.passStreak = snap.passStreak;
}

// Full-game resync, sent by whichever peer never left to catch up a peer
// that just reconnected after a page reload (their in-memory state is gone,
// unlike an undo snapshot this also needs the pieces that make replay/ELO
// recording work, since either side might end up recording the result).
function serializeFullState() {
  return {
    board: Array.from(state.board),
    hand1: state.hand1,
    hand2: state.hand2,
    score1: state.score1,
    score2: state.score2,
    turn: state.turn,
    plyCount: state.plyCount,
    passStreak: state.passStreak,
    gameOver: state.gameOver,
    moveLog: state.moveLog,
    initialHand: state.initialHand,
    lastMove: state.lastMove,
    gameStartedAt: state.gameStartedAt,
    scoringCells: state.scoringCells,
  };
}

function applyFullState(msg) {
  state.gameStarted = true;
  state.board = Int8Array.from(msg.board);
  state.hand1 = msg.hand1;
  state.hand2 = msg.hand2;
  state.score1 = msg.score1;
  state.score2 = msg.score2;
  state.turn = msg.turn;
  state.plyCount = msg.plyCount;
  state.passStreak = msg.passStreak;
  state.gameOver = msg.gameOver;
  state.moveLog = msg.moveLog;
  state.initialHand = msg.initialHand;
  state.lastMove = msg.lastMove;
  state.gameStartedAt = msg.gameStartedAt;
  state.scoringCells = msg.scoringCells;
  state.selected = null;
  state.hover = null;
  state.mouseRC = null;
  state.lastTapCell = null;
  state.history = []; // undo history doesn't survive a reconnect
  state.pendingUndoRequest = false;
  state.incomingUndoRequest = false;
}

function idx(r, c) { return r * BOARD_SIZE + c; }

// ---------- Player display names ----------
function playerLabel(playerNum) {
  if (state.online) {
    if (playerNum === state.myPlayer) {
      const profile = Auth.getProfile();
      return profile ? profile.username : `Player ${playerNum}`;
    }
    return state.opponentUsername || `Player ${playerNum}`;
  }
  if (state.vsBot && playerNum === 2) return 'Bot';
  if (playerNum === 1) {
    const profile = Auth.getProfile();
    return profile ? profile.username : 'Player 1';
  }
  return 'Player 2';
}

// The account id behind a given player slot, if it's a real (non-guest,
// non-bot) account - used to link their name to their profile.
function playerProfileId(playerNum) {
  if (state.online) {
    if (playerNum === state.myPlayer) {
      const user = Auth.getUser();
      return user ? user.id : null;
    }
    return state.opponentUserId || null;
  }
  if (playerNum === 1) {
    const user = Auth.getUser();
    return user ? user.id : null;
  }
  return null;
}

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

  state.gameStarted = true;
  state.board = new Int8Array(BOARD_SIZE * BOARD_SIZE);
  const hand = remoteHand || drawHand();
  state.hand1 = [...hand];
  state.hand2 = [...hand];
  state.initialHand = [...hand];
  state.moveLog = [];
  state.lastMove = null;
  state.score1 = 0;
  state.score2 = HANDICAP_P2;
  state.turn = 1;
  state.plyCount = 0;
  state.passStreak = 0;
  state.gameOver = false;
  state.selected = null;
  state.mouseRC = null;
  state.hover = null;
  state.lastTapCell = null;
  state.scoringCells = null;
  state.history = [];
  state.pendingUndoRequest = false;
  clearTimeout(eloResultTimer);
  document.getElementById('eloResultBanner').style.display = 'none';
  state.incomingUndoRequest = false;
  state.pendingNewGameRequest = false;
  state.incomingNewGameRequest = false;
  state.gameStartedAt = new Date().toISOString();
  lastObservedTurnKey = null;
  clearLog();
  log(`New game started. Both players drew the same hand. ${playerLabel(2)} starts with a ${HANDICAP_P2}-point handicap.`);
  playGameStartChime();
  checkGameEnd();
  render();

  if (state.online && Net.isHost && !isRemote) {
    Net.send({ type: 'newgame', hand });
  }
}

// Casual/ranked matches require both players to agree before starting a
// rematch - otherwise the host could force the other player straight into
// another ranked game with no say in it. Private rooms keep the old
// instant/host-only behavior (newGame() above still enforces host-only there).
function requestNewGame() {
  if (state.connecting || !state.gameStarted) return;

  if (!state.online || (state.gameMode !== 'casual' && state.gameMode !== 'ranked')) {
    newGame();
    return;
  }

  if (state.pendingNewGameRequest) return;
  state.pendingNewGameRequest = true;
  render();
  setLobbyStatus('New game request sent - waiting for your opponent to respond...');
  Net.send({ type: 'newgame-request' });
}

function respondToNewGameRequest(accept) {
  state.incomingNewGameRequest = false;
  Net.send({ type: 'newgame-response', accepted: accept });
  if (accept) {
    if (Net.isHost) {
      newGame();
    } else {
      setLobbyStatus('Waiting for the host to start the new game...');
    }
  } else {
    log('You declined the new game request.');
  }
  render();
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

  // Look ahead: simulate the placement and score the resulting position
  // with the exact same final-tally function the game uses at game end.
  // This lets the bot actually recognize and grab territory it can enclose
  // right now, instead of only reacting to adjacency.
  const simBoard = board.slice();
  for (const [dr, dc] of orientation) {
    simBoard[idx(candidate.r0 + dr, candidate.c0 + dc)] = player;
  }
  const { score1, score2 } = computeFinalScores(simBoard);
  const myScore = player === 1 ? score1 : score2;
  const oppScore = player === 1 ? score2 : score1;
  const territoryDelta = myScore - oppScore;

  // When no immediate territory swing is available (the common case early
  // on), fall back to building toward future enclosures: cluster near your
  // own pieces, avoid the opponent's, and hug the board edge (a free
  // "wall" that makes enclosing cheaper).
  let ownAdj = 0, oppAdj = 0, edgeTouches = 0;
  for (const [dr, dc] of orientation) {
    const r = candidate.r0 + dr, c = candidate.c0 + dc;
    if (r === 0 || r === BOARD_SIZE - 1 || c === 0 || c === BOARD_SIZE - 1) edgeTouches++;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      const val = board[idx(nr, nc)];
      if (val === player) ownAdj++;
      else if (val === opponent) oppAdj++;
    }
  }

  return territoryDelta * 1000 + ownAdj * 2 - oppAdj * 1.5 + edgeTouches * 1.5 + Math.random() * 0.5;
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
  const scoringCells = []; // { index, owner } for every cell that counted toward a score
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
        for (const cellIdx of regionCells) scoringCells.push({ index: cellIdx, owner });
      } else {
        undecided += regionCells.length;
      }
    }
  }
  return { score1, score2, undecided, scoringCells };
}

// ---------- Turn / pass / end-game logic ----------
function switchTurn() {
  state.turn = state.turn === 1 ? 2 : 1;
  state.plyCount += 1;
}

// Voluntary passing is only allowed once your opponent's hand is empty (they
// can never place again) - otherwise you could hoard passes on your early
// turns to play with more board information than they had. Once their hand
// is empty there's no more information asymmetry to protect against.
function opponentHandEmpty() {
  const oppHand = state.turn === 1 ? state.hand2 : state.hand1;
  return oppHand.length === 0;
}

// Auto-passes the current turn holder for as long as they have no legal
// move at all (empty hand, or nothing fits) - ending the game once that
// makes two forced/voluntary passes in a row.
function checkGameEnd() {
  if (state.gameOver) return;
  while (!state.gameOver) {
    const hand = state.turn === 1 ? state.hand1 : state.hand2;
    if (hasAnyLegalMove(hand, state.board)) return;

    const player = state.turn;
    log(`${playerLabel(player)} has no legal move and passes.`);
    state.passStreak += 1;
    switchTurn();

    if (state.passStreak >= 2) {
      endGame('Both players passed in a row.');
      return;
    }
  }
}

function manualPass(fromRemote = false) {
  if (state.gameOver) return;
  if (state.online && !fromRemote && state.myPlayer !== state.turn) return;

  const player = state.turn;
  state.history.push(snapshotState());
  log(`${playerLabel(player)} passes their turn.`);
  state.passStreak += 1;
  switchTurn();
  state.selected = null;
  state.hover = null;

  if (state.passStreak >= 2) {
    endGame('Both players passed in a row.');
    return;
  }

  render();

  if (state.online && !fromRemote) {
    Net.send({ type: 'pass' });
  }

  checkGameEnd();
  scheduleBotMove();
}

function requestPass() {
  if (state.gameOver || state.connecting || !state.gameStarted) return;
  if (state.online && state.myPlayer !== state.turn) return;
  if (state.vsBot && state.turn === 2) return; // it's the bot's turn, not yours
  if (!opponentHandEmpty()) return;
  manualPass(false);
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
  state.lastMove = { shapeName, orientationIndex, r0, c0, player };
  state.passStreak = 0;
  log(`${playerLabel(player)} placed ${shapeName}-pentomino. ${hand.length} piece(s) left.`);

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

function performUndo() {
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
}

function requestUndo() {
  if (state.connecting || !state.gameStarted || state.history.length === 0) return;

  if (!state.online) {
    performUndo();
    return;
  }

  if (state.pendingUndoRequest) return;
  state.pendingUndoRequest = true;
  render();
  setLobbyStatus("Undo request sent - waiting for your opponent's response...");
  Net.send({ type: 'undo-request' });
}

function respondToUndoRequest(accept) {
  state.incomingUndoRequest = false;
  Net.send({ type: 'undo-response', accepted: accept });
  if (accept) {
    performUndo();
  } else {
    log('You declined the undo request.');
  }
  render();
}

function forfeitGame() {
  if (!state.gameStarted || state.gameOver || state.connecting) return;
  if (!window.confirm('Are you sure you want to forfeit this game?')) return;

  const forfeitingPlayer = state.online ? state.myPlayer : (state.vsBot ? 1 : state.turn);
  const winner = forfeitingPlayer === 1 ? 2 : 1;

  if (state.online) {
    Net.send({ type: 'forfeit', forfeitingPlayer });
  }
  endGame(`${playerLabel(forfeitingPlayer)} forfeited.`, winner);
}

function endGame(reason, forcedWinner) {
  if (state.gameOver) return;
  state.gameOver = true;
  stopTurnTimer();
  clearInterval(reconnectCountdownTimer);
  clearTimeout(resyncFallbackTimer);
  if (state.online) {
    Net.leaveRoom();
    clearActiveMatch();
  }

  const { score1, score2, undecided, scoringCells } = computeFinalScores(state.board);
  state.score1 = score1;
  state.score2 = score2 + HANDICAP_P2;
  state.scoringCells = scoringCells;

  let winner;
  let result;
  if (forcedWinner !== undefined) {
    winner = forcedWinner;
    result = `${playerLabel(winner)} wins!`;
  } else if (state.score1 > state.score2) {
    winner = 1;
    result = `${playerLabel(1)} wins!`;
  } else if (state.score2 > state.score1) {
    winner = 2;
    result = `${playerLabel(2)} wins!`;
  } else {
    winner = null;
    result = "It's a tie!";
  }

  log(`Game over — ${reason} Final score - ${playerLabel(1)}: ${state.score1}, ${playerLabel(2)}: ${state.score2}, Undecided: ${undecided}. ${result}`);
  recordGameResult(winner);
  render();
}

async function recordGameResult(winner) {
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
    if (!state.online) return;
    const me = Auth.getUser();
    const amILoggedIn = !!me;
    // Only one side should insert. Prefer the host; if the host isn't
    // logged in but the joiner is, the joiner records instead, so a game
    // against a guest host still lands in the logged-in joiner's history.
    const hostIsLoggedIn = Net.isHost ? amILoggedIn : (state.opponentUserId !== null);
    const iShouldRecord = Net.isHost ? amILoggedIn : (amILoggedIn && !hostIsLoggedIn);
    if (!iShouldRecord) return;

    const player1_id = state.myPlayer === 1 ? me.id : state.opponentUserId;
    const player2_id = state.myPlayer === 2 ? me.id : state.opponentUserId;

    row = {
      mode: state.gameMode,
      player1_id,
      player2_id,
      score1: state.score1,
      score2: state.score2,
      winner,
      initial_hand: state.initialHand,
      move_log: state.moveLog,
      board_size: BOARD_SIZE,
      started_at: state.gameStartedAt,
    };
  }

  const { data, error } = await supabaseClient.from('games').insert(row).select('id').single();
  if (error) {
    log('Could not save game result: ' + error.message);
    return;
  }
  log('Game result saved to your match history.');

  if (row.mode === 'ranked') {
    // The elo_delta_p1/p2 columns are populated by a separate AFTER INSERT
    // trigger (a follow-up UPDATE), so they won't be present on the row we
    // just inserted - a fresh select is needed to see the trigger's result.
    const { data: eloRow, error: eloError } = await supabaseClient
      .from('games')
      .select('elo_delta_p1, elo_delta_p2')
      .eq('id', data.id)
      .single();
    if (!eloError && eloRow && eloRow.elo_delta_p1 != null) {
      if (state.online) {
        Net.send({ type: 'elo-result', delta_p1: eloRow.elo_delta_p1, delta_p2: eloRow.elo_delta_p2 });
      }
      showEloResult(state.myPlayer === 1 ? eloRow.elo_delta_p1 : eloRow.elo_delta_p2);
    }
  }
}

let eloResultTimer = null;
function showEloResult(myDelta) {
  Auth.refreshProfile();
  const banner = document.getElementById('eloResultBanner');
  const sign = myDelta > 0 ? '+' : '';
  banner.textContent = `Ranked result: ${sign}${myDelta} ELO`;
  banner.classList.toggle('positive', myDelta > 0);
  banner.classList.toggle('negative', myDelta < 0);
  banner.style.display = 'flex';
  clearTimeout(eloResultTimer);
  eloResultTimer = setTimeout(() => { banner.style.display = 'none'; }, 8000);
}

// ---------- Selection / hover ----------
function selectShape(shapeName) {
  if (state.gameOver || state.connecting) return;
  if (state.online && state.myPlayer !== state.turn) return;
  state.selected = { shapeName, orientationIndex: 0 };
  state.lastTapCell = null;
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

// ---------- Sound ----------
let audioCtx = null;
function playDing() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
  } catch {
    // audio unavailable/blocked - not critical, ignore
  }
}

function maybeDingForTurn() {
  const isMyTurn = state.online ? state.turn === state.myPlayer : (state.vsBot ? state.turn === 1 : true);
  if (isMyTurn) playDing();
}

// A bright two-note chime, distinct from the single-tone turn ding, so a
// fresh game starting doesn't sound like just another turn notification.
function playGameStartChime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    for (const freq of [523.25, 659.25]) { // C5 + E5
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.1, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.6);
    }
  } catch {
    // audio unavailable/blocked - not critical, ignore
  }
}

// Two quick ascending notes, so an incoming chat message is clearly
// distinguishable by ear from the turn ding and the game-start chime.
function playChatPing() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    for (const { freq, start } of [{ freq: 660, start: 0 }, { freq: 990, start: 0.09 }]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.1, now + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.18);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.2);
    }
  } catch {
    // audio unavailable/blocked - not critical, ignore
  }
}

// ---------- Per-turn timer (online casual/ranked only) ----------
let turnTimerInterval = null;

function stopTurnTimer() {
  if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
  state.turnDeadline = null;
  const el = document.getElementById('turnTimer');
  if (el) { el.textContent = ''; el.classList.remove('turn-timer-warning'); }
}

function tickTurnTimer() {
  const el = document.getElementById('turnTimer');
  if (!state.turnDeadline || state.gameOver) { stopTurnTimer(); return; }
  const remainingMs = state.turnDeadline - Date.now();
  if (remainingMs <= 0) {
    el.textContent = "Time's up!";
    stopTurnTimer();
    if (state.turn === state.myPlayer) {
      timeoutForfeit();
    } else {
      // Don't rely solely on the timed-out player's own client to self-report -
      // their tab may be backgrounded/throttled and never fire this at all,
      // leaving the game hanging on my end forever. My independently-ticking
      // timer (same shared deadline) can declare it just as well.
      timeoutOpponentForfeit();
    }
    return;
  }
  const secs = Math.ceil(remainingMs / 1000);
  el.textContent = `⏱ ${secs}s`;
  el.classList.toggle('turn-timer-warning', secs <= 10);
}

function restartTurnTimerIfNeeded() {
  stopTurnTimer();
  if (state.gameOver || !state.online) return;
  const limitSec = TURN_TIME_LIMITS[state.gameMode];
  if (!limitSec) return;
  state.turnDeadline = Date.now() + limitSec * 1000;
  turnTimerInterval = setInterval(tickTurnTimer, 250);
  tickTurnTimer();
}

function timeoutForfeit() {
  if (state.gameOver) return;
  const forfeitingPlayer = state.myPlayer;
  const winner = forfeitingPlayer === 1 ? 2 : 1;
  if (state.online) Net.send({ type: 'forfeit', forfeitingPlayer });
  endGame(`${playerLabel(forfeitingPlayer)} ran out of time.`, winner);
}

// Fallback for when the timed-out player's own client never reports its
// forfeit (backgrounded/throttled tab, closed laptop, dead connection, etc.) -
// the waiting player's own timer shares the same deadline, so it can declare
// the timeout independently instead of waiting forever on a message that may
// never arrive.
function timeoutOpponentForfeit() {
  if (state.gameOver) return;
  const forfeitingPlayer = state.turn;
  const winner = state.myPlayer;
  if (state.online) Net.send({ type: 'forfeit', forfeitingPlayer });
  endGame(`${playerLabel(forfeitingPlayer)} ran out of time.`, winner);
}

// Fires exactly once per actual turn transition (placement or pass),
// regardless of how many times render() gets called in between.
let lastObservedTurnKey = null;
function handleTurnTransition() {
  if (!state.gameStarted) { lastObservedTurnKey = null; return; }
  const key = `${state.turn}-${state.plyCount}-${state.gameOver}`;
  if (key === lastObservedTurnKey) return;
  lastObservedTurnKey = key;

  if (!state.gameOver) {
    maybeDingForTurn();
  }
  restartTurnTimerIfNeeded();
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
      ctx.fillStyle = val === 1 ? '#5b7fd9' : val === 2 ? '#d97a52' : '#1e1b24';
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

  // Once the game is over, mark every empty square that counted toward a
  // score with a small dot in the scoring player's color, so it's obvious
  // at a glance which enclosed territory actually decided the game.
  if (state.gameOver && state.scoringCells) {
    const dotRadius = CELL_PX * 0.16;
    for (const { index, owner } of state.scoringCells) {
      const r = Math.floor(index / BOARD_SIZE), c = index % BOARD_SIZE;
      ctx.fillStyle = owner === 1 ? '#5b7fd9' : '#d97a52';
      ctx.beginPath();
      ctx.arc(c * CELL_PX + CELL_PX / 2, r * CELL_PX + CELL_PX / 2, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Subtle highlight on the most recently placed piece, so it's easy to
  // spot if you looked away while the opponent was moving.
  if (state.lastMove) {
    const orientation = ORIENTATIONS[state.lastMove.shapeName][state.lastMove.orientationIndex];
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    for (const [dr, dc] of orientation) {
      const r = state.lastMove.r0 + dr, c = state.lastMove.c0 + dc;
      ctx.strokeRect(c * CELL_PX + 1.5, r * CELL_PX + 1.5, CELL_PX - 3, CELL_PX - 3);
    }
  }

  if (state.selected && state.hover && !state.gameOver) {
    const orientation = ORIENTATIONS[state.selected.shapeName][state.selected.orientationIndex];
    const color = state.hover.valid
      ? (state.turn === 1 ? 'rgba(91,127,217,0.55)' : 'rgba(217,122,82,0.55)')
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
  if (!state.gameStarted) {
    banner.textContent = 'Choose a mode below to start playing';
  } else if (state.gameOver) {
    banner.textContent = 'Game over';
  } else if (state.online) {
    const you = state.myPlayer === state.turn ? ' (your turn)' : " (opponent's turn)";
    banner.textContent = `${playerLabel(state.turn)}'s turn${you}`;
  } else {
    banner.textContent = `${playerLabel(state.turn)}'s turn`;
  }

  document.getElementById('scoreLabel1').innerHTML = playerLink(playerProfileId(1), playerLabel(1));
  document.getElementById('scoreLabel2').innerHTML = playerLink(playerProfileId(2), playerLabel(2));
  document.getElementById('score1').textContent = state.score1;
  document.getElementById('score2').textContent = state.score2;

  document.getElementById('handLabel1').innerHTML = `${playerLink(playerProfileId(1), playerLabel(1))}'s hand`;
  document.getElementById('handLabel2').innerHTML = `${playerLink(playerProfileId(2), playerLabel(2))}'s hand`;

  if (state.gameStarted) {
    const proj = computeFinalScores(state.board);
    document.getElementById('projected').innerHTML =
      `Projected if game ended now: ${playerLabel(1)} ${proj.score1} &middot; ${playerLabel(2)} ${proj.score2 + HANDICAP_P2} &middot; Undecided ${proj.undecided}`;
  } else {
    document.getElementById('projected').textContent = 'No game in progress yet.';
  }

  renderHand('hand1', state.hand1, 1);
  renderHand('hand2', state.hand2, 2);

  updateSelectionInfo();

  canvas.classList.toggle('placing', !!state.selected && !state.gameOver);

  document.getElementById('rotateBtn').disabled = state.connecting || !state.gameStarted;
  document.getElementById('newGameBtn').disabled = state.connecting || !state.gameStarted || state.pendingNewGameRequest;
  document.getElementById('undoBtn').disabled = state.connecting || !state.gameStarted
    || state.history.length === 0 || state.pendingUndoRequest;
  const tooEarlyToPass = state.gameStarted && !state.gameOver && !opponentHandEmpty();
  document.getElementById('passBtn').disabled = state.connecting || !state.gameStarted || state.gameOver
    || (state.online && state.myPlayer !== state.turn)
    || (state.vsBot && state.turn === 2)
    || tooEarlyToPass;
  document.getElementById('passBtn').title = tooEarlyToPass
    ? 'Pass unlocks once your opponent has no pieces left'
    : '';
  document.getElementById('forfeitBtn').disabled = state.connecting || !state.gameStarted || state.gameOver;

  document.getElementById('undoRequestBanner').style.display = state.incomingUndoRequest ? 'flex' : 'none';
  document.getElementById('newGameRequestBanner').style.display = state.incomingNewGameRequest ? 'flex' : 'none';

  document.getElementById('hotseatBtn').classList.toggle('active', !state.vsBot);
  document.getElementById('vsBotBtn').classList.toggle('active', state.vsBot);
  document.getElementById('hotseatBtn').disabled = state.online || state.connecting;
  document.getElementById('vsBotBtn').disabled = state.online || state.connecting;

  document.getElementById('casualQueueBtn').disabled = state.online || state.connecting;
  document.getElementById('rankedQueueBtn').disabled = state.online || state.connecting;
  // Only show Cancel while genuinely establishing a first connection - not
  // while state.connecting is true because we're mid-game waiting for a
  // disconnected opponent to reconnect (state.online is already true then).
  document.getElementById('cancelConnectBtn').style.display = (state.connecting && !state.online) ? '' : 'none';

  document.getElementById('chatInput').disabled = !state.online;
  document.getElementById('chatSendBtn').disabled = !state.online;

  handleTurnTransition();
}

function updateSelectionInfo() {
  const el = document.getElementById('selectionInfo');
  if (!state.gameStarted) {
    el.textContent = 'No game in progress yet.';
  } else if (state.gameOver) {
    el.textContent = 'Game over.';
  } else if (!state.selected) {
    el.textContent = `${playerLabel(state.turn)}: click a piece in your hand below to select it.`;
  } else {
    const len = ORIENTATIONS[state.selected.shapeName].length;
    el.textContent = `Placing ${state.selected.shapeName}-pentomino (orientation ${state.selected.orientationIndex + 1}/${len}). Click the board to place, or press R / scroll to rotate.`;
  }
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

function renderHand(elId, hand, player) {
  const counts = {};
  for (const s of hand) counts[s] = (counts[s] || 0) + 1;
  const el = document.getElementById(elId);
  el.innerHTML = '';

  const container = el.closest('.hand');
  const isActive = state.gameStarted && player === state.turn && !state.gameOver && !state.connecting
    && (!state.online || player === state.myPlayer)
    && !(state.vsBot && player === 2);
  container.classList.toggle('inactive', !isActive);

  const names = Object.keys(counts).sort();
  if (names.length === 0) {
    el.innerHTML = state.gameStarted ? '<span>empty</span>' : '<span>Waiting for a game to start&hellip;</span>';
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

// ---------- Log & chat ----------
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

function sendChat() {
  if (!state.online) return;
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  log(`\u{1F4AC} ${playerLabel(state.myPlayer)}: ${text}`);
  Net.send({ type: 'chat', text });
}

// ---------- Canvas interaction ----------
// Shared by mouse and touch: converts a raw client point into a board cell,
// accounting for the canvas possibly being CSS-scaled (e.g. shrunk to fit a
// narrow mobile screen) relative to its internal drawing resolution.
function getBoardCell(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  return { row: Math.floor(y / CELL_PX), col: Math.floor(x / CELL_PX) };
}

canvas.addEventListener('mousemove', (e) => {
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
  if (state.gameOver || state.connecting || !state.selected || !state.hover || !state.hover.valid) return;
  if (state.online && state.myPlayer !== state.turn) return;
  commitPlacement(state.selected.shapeName, state.selected.orientationIndex, state.hover.r0, state.hover.c0);
});

// Touch has no hover, so placement is two-step: tap once to preview a cell,
// tap the same cell again to confirm. Tapping a different cell just moves
// the preview there (like moving a mouse), and always overrides a stale
// preview left over from selecting the piece with the mouse.
canvas.addEventListener('touchstart', (e) => {
  if (!state.selected || state.gameOver || state.connecting) return;
  e.preventDefault();

  const touch = e.touches[0];
  const cell = getBoardCell(touch.clientX, touch.clientY);
  const wasSameCell = state.lastTapCell && state.lastTapCell.row === cell.row && state.lastTapCell.col === cell.col;
  state.lastTapCell = cell;

  if (wasSameCell && state.hover && state.hover.valid) {
    if (state.online && state.myPlayer !== state.turn) return;
    commitPlacement(state.selected.shapeName, state.selected.orientationIndex, state.hover.r0, state.hover.c0);
    state.lastTapCell = null;
    return;
  }

  state.mouseRC = cell;
  recomputeHover();
  drawBoard();
}, { passive: false });

canvas.addEventListener('wheel', (e) => {
  if (!state.selected) return;
  e.preventDefault();
  rotateSelected();
}, { passive: false });

// ---------- Controls ----------
document.getElementById('rotateBtn').addEventListener('click', rotateSelected);
document.getElementById('mobileRotateBtn').addEventListener('click', rotateSelected);
document.getElementById('undoBtn').addEventListener('click', () => requestUndo());
document.getElementById('passBtn').addEventListener('click', () => requestPass());
document.getElementById('forfeitBtn').addEventListener('click', () => forfeitGame());

document.getElementById('undoAcceptBtn').addEventListener('click', () => respondToUndoRequest(true));
document.getElementById('undoDeclineBtn').addEventListener('click', () => respondToUndoRequest(false));

document.getElementById('newGameAcceptBtn').addEventListener('click', () => respondToNewGameRequest(true));
document.getElementById('newGameDeclineBtn').addEventListener('click', () => respondToNewGameRequest(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    rotateSelected();
  }
});

document.getElementById('newGameBtn').addEventListener('click', () => {
  requestNewGame();
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

document.getElementById('chatSendBtn').addEventListener('click', sendChat);
document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChat();
  }
});

// ---------- Online play ----------
function setLobbyStatus(text) {
  document.getElementById('onlineStatus').textContent = text;
}

// ---------- Reconnect (casual/ranked only) ----------
let reconnectCountdownTimer = null;
let resyncFallbackTimer = null;

function saveActiveMatch() {
  if (state.gameMode !== 'casual' && state.gameMode !== 'ranked') return;
  const user = Auth.getUser();
  if (!user || !Net.matchId) return;
  localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify({ matchId: Net.matchId, userId: user.id }));
}

function clearActiveMatch() {
  localStorage.removeItem(ACTIVE_MATCH_KEY);
}

function handleOpponentDisconnected(graceMs) {
  // Freezes the board via the same state.connecting guards used while
  // establishing a connection in the first place - see cancelConnectBtn's
  // visibility logic in render() for how this is distinguished from that.
  state.connecting = true;
  render();

  let remainingSec = Math.ceil((graceMs || 30000) / 1000);
  const tick = () => {
    setLobbyStatus(`Opponent disconnected — waiting up to ${remainingSec}s for them to reconnect...`);
    remainingSec--;
  };
  clearInterval(reconnectCountdownTimer);
  tick();
  reconnectCountdownTimer = setInterval(tick, 1000);
}

function handleOpponentTimeout() {
  clearInterval(reconnectCountdownTimer);
  state.connecting = false;
  if (state.gameOver || !state.gameStarted) return;
  endGame('Opponent did not reconnect in time.', state.myPlayer);
}

function handleRejoinReady() {
  clearInterval(reconnectCountdownTimer);
  state.online = true;
  state.connecting = false;
  state.vsBot = false;
  state.gameMode = Net.matchedMode;
  state.myPlayer = Net.isHost ? 1 : 2;
  document.getElementById('connectBtn').disabled = true;
  document.getElementById('roomInput').disabled = true;

  // Re-send identify - if I'm the one who just reloaded, state.opponentUserId
  // is back to null and recordGameResult() needs the real value.
  const myProfile = Auth.getProfile();
  Net.send({
    type: 'identify',
    userId: Auth.getUser()?.id ?? null,
    username: myProfile ? myProfile.username : null,
  });

  const iHaveLiveGame = state.gameStarted && !state.gameOver;
  if (iHaveLiveGame) {
    setLobbyStatus('Opponent reconnected!');
    log('Opponent reconnected.');
    Net.send({ type: 'resync', ...serializeFullState() });
    render();
  } else {
    setLobbyStatus('Reconnected! Recovering your match...');
    clearTimeout(resyncFallbackTimer);
    resyncFallbackTimer = setTimeout(() => {
      setLobbyStatus('Could not recover your match state. Returning to the lobby.');
      log('Could not recover your match state.');
      clearActiveMatch();
      state.online = false;
      document.getElementById('connectBtn').disabled = false;
      document.getElementById('roomInput').disabled = false;
      render();
    }, 10000);
  }
}

function tryResumeActiveMatch() {
  if (state.online || state.connecting) return; // already mid-match - nothing to resume
  const raw = localStorage.getItem(ACTIVE_MATCH_KEY);
  if (!raw) return;
  let record;
  try { record = JSON.parse(raw); } catch { clearActiveMatch(); return; }
  if (!record || !record.matchId || !record.userId) { clearActiveMatch(); return; }

  const accessToken = Auth.getAccessToken();
  if (!accessToken) return; // not signed in yet - retried on the next auth-state change

  state.connecting = true;
  render();
  setLobbyStatus('Reconnecting to your previous match...');
  Net.rejoin({
    serverUrl: SIGNALING_SERVER_URL,
    matchId: record.matchId,
    userId: record.userId,
    accessToken,
    onStatus: setLobbyStatus,
    onReady: handleNetReady,
    onData: handleNetData,
    onPeerLeft: handleNetPeerLeft,
    onOpponentDisconnected: handleOpponentDisconnected,
    onOpponentTimeout: handleOpponentTimeout,
    onRejoinFailed: (reason) => {
      clearActiveMatch();
      state.connecting = false;
      setLobbyStatus(reason || 'Could not reconnect to your previous match.');
      render();
    },
  });
}

function handleNetReady() {
  if (Net.isRejoin) {
    handleRejoinReady();
    return;
  }

  clearInterval(reconnectCountdownTimer);
  clearTimeout(resyncFallbackTimer);
  state.online = true;
  state.connecting = false;
  state.vsBot = false;
  state.gameMode = Net.matchedMode;
  state.myPlayer = Net.isHost ? 1 : 2;
  state.opponentUserId = null;
  state.opponentUsername = null;
  state.pendingUndoRequest = false;
  state.incomingUndoRequest = false;
  document.getElementById('connectBtn').disabled = true;
  document.getElementById('roomInput').disabled = true;
  setLobbyStatus(`Connected! You are Player ${state.myPlayer}. (${state.gameMode})`);
  log(`Connected to opponent. You are Player ${state.myPlayer}. Mode: ${state.gameMode}.`);

  const myProfile = Auth.getProfile();
  Net.send({
    type: 'identify',
    userId: Auth.getUser()?.id ?? null,
    username: myProfile ? myProfile.username : null,
  });

  if (Net.isHost) {
    newGame();
  } else {
    render();
  }

  saveActiveMatch();
}

function handleNetData(msg) {
  if (msg.type === 'newgame') {
    newGame(msg.hand);
  } else if (msg.type === 'move') {
    commitPlacement(msg.shapeName, msg.orientationIndex, msg.r0, msg.c0, true);
  } else if (msg.type === 'pass') {
    manualPass(true);
  } else if (msg.type === 'undo-request') {
    state.incomingUndoRequest = true;
    render();
  } else if (msg.type === 'undo-response') {
    state.pendingUndoRequest = false;
    if (msg.accepted) {
      performUndo();
      log('Opponent accepted your undo request.');
    } else {
      log('Opponent declined your undo request.');
    }
    render();
  } else if (msg.type === 'forfeit') {
    const winner = msg.forfeitingPlayer === 1 ? 2 : 1;
    endGame(`${playerLabel(msg.forfeitingPlayer)} forfeited.`, winner);
  } else if (msg.type === 'identify') {
    state.opponentUserId = msg.userId;
    state.opponentUsername = msg.username;
    render();
  } else if (msg.type === 'chat') {
    const opponentPlayerNum = state.myPlayer === 1 ? 2 : 1;
    log(`\u{1F4AC} ${playerLabel(opponentPlayerNum)}: ${msg.text}`);
    playChatPing();
  } else if (msg.type === 'elo-result') {
    showEloResult(state.myPlayer === 1 ? msg.delta_p1 : msg.delta_p2);
  } else if (msg.type === 'resync') {
    clearTimeout(resyncFallbackTimer);
    applyFullState(msg);
    log('Reconnected — game state restored.');
    setLobbyStatus(`Connected! You are Player ${state.myPlayer}. (${state.gameMode})`);
    render();
  } else if (msg.type === 'newgame-request') {
    state.incomingNewGameRequest = true;
    render();
  } else if (msg.type === 'newgame-response') {
    state.pendingNewGameRequest = false;
    if (msg.accepted) {
      log('Opponent accepted your new game request.');
      if (Net.isHost) {
        newGame();
      } else {
        setLobbyStatus('Waiting for the host to start the new game...');
      }
    } else {
      log('Opponent declined your new game request.');
    }
    render();
  }
}

function handleNetPeerLeft() {
  if (state.online && (state.gameMode === 'casual' || state.gameMode === 'ranked') && !state.gameOver) {
    // For casual/ranked, the signaling-server-driven grace period
    // (handleOpponentDisconnected/handleOpponentTimeout) is authoritative -
    // a transient WebRTC-layer blip shouldn't jump straight to "gone".
    return;
  }
  log('Your opponent disconnected.');
  setLobbyStatus('Opponent disconnected.');
  stopTurnTimer();
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
    joinMessage: { type: 'join', room },
    onStatus: setLobbyStatus,
    onReady: handleNetReady,
    onData: handleNetData,
    onPeerLeft: handleNetPeerLeft,
  });
});

function startQueue(queueType) {
  const user = Auth.getUser();
  if (!user) {
    setLobbyStatus('Sign in (top right) first to use casual/ranked queues.');
    return;
  }
  const profile = Auth.getProfile();
  const eloRating = profile ? profile.elo_rating : 1200;
  const accessToken = Auth.getAccessToken();

  state.connecting = true;
  render();
  setLobbyStatus(`Searching for a ${queueType} opponent...`);
  Net.connect({
    serverUrl: SIGNALING_SERVER_URL,
    joinMessage: { type: 'queue', queueType, userId: user.id, eloRating, accessToken },
    onStatus: setLobbyStatus,
    onReady: handleNetReady,
    onData: handleNetData,
    onPeerLeft: handleNetPeerLeft,
    onOpponentDisconnected: handleOpponentDisconnected,
    onOpponentTimeout: handleOpponentTimeout,
  });
}

document.getElementById('casualQueueBtn').addEventListener('click', () => startQueue('casual'));
document.getElementById('rankedQueueBtn').addEventListener('click', () => startQueue('ranked'));

document.getElementById('cancelConnectBtn').addEventListener('click', () => {
  Net.cancelQueue();
  state.connecting = false;
  setLobbyStatus('Cancelled.');
  render();
});

// Lets players see whether it's worth queueing before they commit to it -
// polls the signaling server's HTTP endpoint (same host/port as the WS),
// separate from the WebRTC connection itself.
const QUEUE_COUNT_POLL_MS = 7000;
const SIGNALING_HTTP_URL = SIGNALING_SERVER_URL.replace(/^ws/, 'http');

function formatQueueCount(n) {
  if (n === 1) return '1 waiting';
  return `${n} waiting`;
}

async function refreshQueueCounts() {
  try {
    const res = await fetch(`${SIGNALING_HTTP_URL}/queue-counts`);
    if (!res.ok) return;
    const { casual, ranked } = await res.json();
    document.getElementById('casualQueueCount').textContent = formatQueueCount(casual);
    document.getElementById('rankedQueueCount').textContent = formatQueueCount(ranked);
  } catch {
    // signaling server unreachable - leave whatever was last shown
  }
}

// ---------- Init ----------
render();
Auth.onAuthChange(tryResumeActiveMatch);
refreshQueueCounts();
setInterval(refreshQueueCounts, QUEUE_COUNT_POLL_MS);
