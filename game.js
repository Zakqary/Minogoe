// ---------- Configuration ----------
const BOARD_SIZE = 12;
const CELL_PX = 52; // 12 * 52 = 624px board
const HAND_COMPOSITION = { pentomino: 7, tetromino: 2, tromino: 1 };
const HANDICAP_POINTS = 1; // whoever moves second gets a 1-point head start
const SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';
const TURN_TIME_LIMITS = { casual: 120, ranked: 60 }; // seconds; private/bot/hotseat are untimed
const ACTIVE_MATCH_KEY = 'minogoe_activeMatch'; // localStorage key for reconnect-after-reload
const MATCH_INTRO_DURATION_MS = 4500; // how long the pre-match "vs" intro card stays up before auto-dismissing

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
  startingPlayer: 1,  // whoever moved first this game - always 1, except vs Bot where it's randomized
  plyCount: 0,        // increments every turn switch (placement or pass) - used to detect turn transitions
  gameOver: false,
  winner: undefined,  // 1, 2, or null (tie) - set once gameOver
  forfeit: false,     // true if the game ended by timeout/forfeit rather than territory
  selected: null,     // { shapeName, orientationIndex }
  mouseRC: null,      // { row, col } raw hovered cell
  hover: null,        // { r0, c0, valid }
  history: [],        // stack of snapshots for undo
  online: false,      // true once paired with a remote peer
  myPlayer: null,     // 1 or 2 when online; null in local hotseat mode
  connecting: false,  // true from the moment Connect is clicked until paired (or given up)
  // True only while waiting in the casual/ranked queue for an opponent, as
  // opposed to state.connecting (which also covers reconnecting to an
  // ALREADY-existing match). Deliberately a separate flag: unlike
  // reconnecting, there's no live match's board to freeze yet while
  // merely searching, so a local hotseat/vs-bot game is free to keep
  // running underneath the search - none of the board-interaction guards
  // below check this flag, only state.connecting.
  queueSearching: false,
  opponentUserId: null,   // the connected peer's Supabase user id, if they're logged in
  opponentUsername: null, // the connected peer's username, if they're logged in
  opponentAvatarId: null, // the connected peer's equipped avatar item id, if any
  opponentTitleId: null,  // the connected peer's equipped title item id, if any
  opponentEloRating: null, // the connected peer's ELO rating, if they're logged in
  opponentCompanion: null, // the connected peer's chosen companion Mino ({ color, rarity, modifier, stage }), if any
  introShown: false,  // whether the match intro card has already been shown this match
  gameStartedAt: null,
  // Counts which game *within this connection* this is (1 = the first game,
  // 2 = the first rematch, etc.) - only ever set by the host (via newGame()
  // or the 'newgame' message) and adopted as-is by the joiner, never
  // independently incremented on that side, so both peers always agree on
  // the same value for the same game. Combined with Net.matchId to build a
  // per-GAME client_match_id (see recordGameResult()) - matchId alone is
  // the same for every rematch in a session, which used to make every
  // rematch after the first collide with it and get silently rejected as
  // a "duplicate" of the first game.
  gameSequence: 0,
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
    gameSequence: state.gameSequence,
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
  state.gameSequence = msg.gameSequence;
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

// Whoever didn't move first gets the handicap point - always player 2 except
// in vs Bot games, where the starting player (and so the handicap recipient)
// is randomized.
function handicapPlayer() {
  return state.startingPlayer === 1 ? 2 : 1;
}

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

// The avatar/title item ids equipped by whoever's in a given player slot -
// null for bot/guest slots (which have no profile), matching playerProfileId.
function playerAvatarId(playerNum) {
  if (state.online) {
    if (playerNum === state.myPlayer) {
      const profile = Auth.getProfile();
      return profile ? profile.avatar_id : null;
    }
    return state.opponentAvatarId || null;
  }
  if (playerNum === 1) {
    const profile = Auth.getProfile();
    return profile ? profile.avatar_id : null;
  }
  return null;
}

function playerTitleId(playerNum) {
  if (state.online) {
    if (playerNum === state.myPlayer) {
      const profile = Auth.getProfile();
      return profile ? profile.title_id : null;
    }
    return state.opponentTitleId || null;
  }
  if (playerNum === 1) {
    const profile = Auth.getProfile();
    return profile ? profile.title_id : null;
  }
  return null;
}

// The chosen companion Mino ({ color, rarity, modifier, stage }) for whoever's
// in a given player slot, or null - same shape as playerAvatarId/playerTitleId.
function playerCompanion(playerNum) {
  if (state.online) {
    if (playerNum === state.myPlayer) {
      const profile = Auth.getProfile();
      return profile ? profile.companion : null;
    }
    return state.opponentCompanion || null;
  }
  if (playerNum === 1) {
    const profile = Auth.getProfile();
    return profile ? profile.companion : null;
  }
  return null;
}

// Combines the existing name link with an avatar image + title badge -
// only for real accounts (bot/guest/local-hotseat-P2 have no profile, so
// playerProfileId is null and they show as plain name text, same as before).
function playerBadgeHtml(playerNum) {
  const id = playerProfileId(playerNum);
  const nameHtml = playerLink(id, playerLabel(playerNum));
  // Before any game has actually started, player 1 already resolves to the
  // signed-in account (so the scoreboard can show their real name while
  // choosing a mode) - but showing their equipped avatar/title that early
  // reads as presumptuous, since no match (and no real "player 1 vs 2") has
  // been decided yet. Cosmetics only show once a game is actually underway.
  if (!id || !state.gameStarted) return nameHtml;
  const companion = playerCompanion(playerNum);
  const companionHtml = companion ? `<span class="player-companion">${minoVisualHtml(companion, 20)}</span>` : '';
  return `${avatarHtml(playerAvatarId(playerNum), 20)} ${companionHtml}${nameHtml} ${titleBadgeHtml(playerTitleId(playerNum))}`;
}

// ---------- Pre-match "vs" intro card (casual/ranked only) ----------

// Number of players with a strictly higher ELO, plus one - same technique
// profile.js uses for its own "Rank" stat, via a count-only query instead
// of fetching every profile.
async function eloRank(eloRating) {
  if (eloRating == null) return null;
  const { count, error } = await supabaseClient
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .gt('elo_rating', eloRating);
  return error ? null : (count ?? 0) + 1;
}

function matchIntroPlayerHtml(p, rank) {
  const eloText = p.eloRating != null ? `ELO ${p.eloRating}` : 'Unranked';
  return `
    <div class="match-intro-player">
      ${avatarHtml(p.avatarId, 56)}
      <div class="match-intro-name">${playerLink(p.userId, p.username)}</div>
      ${titleBadgeHtml(p.titleId)}
      <div class="match-intro-elo">${escapeHtml(eloText)}</div>
      ${rank != null ? `<div class="match-intro-rank">#${rank}</div>` : ''}
    </div>
  `;
}

function dismissMatchIntroCard() {
  const el = document.getElementById('matchIntroOverlay');
  if (el) el.remove();
}

// Shown once per match, right when both players' identities are known
// (the moment the opponent's 'identify' message arrives) - skipped for
// private-room/bot/hotseat games, and never re-shown on a mid-game rejoin
// (guarded by state.introShown, only reset in handleNetReady() for a
// brand new match).
async function showMatchIntroCard() {
  if (state.introShown) return;
  if (state.gameMode !== 'casual' && state.gameMode !== 'ranked') return;
  state.introShown = true;

  const myProfile = Auth.getProfile();
  const me = {
    userId: Auth.getUser()?.id ?? null,
    username: myProfile ? myProfile.username : 'You',
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
    eloRating: myProfile ? myProfile.elo_rating : null,
  };
  const opponent = {
    userId: state.opponentUserId,
    username: state.opponentUsername || 'Opponent',
    avatarId: state.opponentAvatarId,
    titleId: state.opponentTitleId,
    eloRating: state.opponentEloRating,
  };

  const [myRank, opponentRank] = await Promise.all([eloRank(me.eloRating), eloRank(opponent.eloRating)]);

  const overlay = document.createElement('div');
  overlay.id = 'matchIntroOverlay';
  overlay.className = 'match-intro-overlay';
  overlay.innerHTML = `
    <div class="match-intro-card">
      ${matchIntroPlayerHtml(me, myRank)}
      <div class="match-intro-vs">VS</div>
      ${matchIntroPlayerHtml(opponent, opponentRank)}
    </div>
  `;
  overlay.addEventListener('click', dismissMatchIntroCard);
  document.body.appendChild(overlay);
  setTimeout(dismissMatchIntroCard, MATCH_INTRO_DURATION_MS);
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

function newGame(remoteHand, remoteSequence) {
  const isRemote = remoteHand !== undefined;

  if (state.connecting && !isRemote) return;

  if (state.online && !Net.isHost && !isRemote) {
    log('Only the host can start a new game - ask them to click New Game.');
    return;
  }

  // The host assigns the next sequence number itself; the joiner just
  // adopts whatever the host sent, so both sides always agree.
  state.gameSequence = isRemote ? remoteSequence : state.gameSequence + 1;

  state.gameStarted = true;
  state.board = new Int8Array(BOARD_SIZE * BOARD_SIZE);
  const hand = remoteHand || drawHand();
  state.hand1 = [...hand];
  state.hand2 = [...hand];
  state.initialHand = [...hand];
  state.moveLog = [];
  state.lastMove = null;
  // Who goes first is always player 1, except vs Bot, where it's a coin
  // flip each game - previously the human (always player 1) went first
  // every single time.
  state.startingPlayer = (state.vsBot && Math.random() < 0.5) ? 2 : 1;
  state.turn = state.startingPlayer;
  state.score1 = handicapPlayer() === 1 ? HANDICAP_POINTS : 0;
  state.score2 = handicapPlayer() === 2 ? HANDICAP_POINTS : 0;
  state.plyCount = 0;
  state.passStreak = 0;
  state.gameOver = false;
  state.winner = undefined;
  state.forfeit = false;
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
  log(`New game started. Both players drew the same hand. ${playerLabel(handicapPlayer())} starts with a ${HANDICAP_POINTS}-point handicap.`);
  playGameStartChime();
  checkGameEnd();
  render();

  if (state.online && Net.isHost && !isRemote) {
    Net.send({ type: 'newgame', hand, gameSequence: state.gameSequence });
  }

  scheduleBotMove(); // no-op unless this is a vs Bot game where the bot won the coin flip to go first
}

// Casual/ranked matches require both players to agree before starting a
// rematch - otherwise the host could force the other player straight into
// another ranked game with no say in it. Private rooms keep the old
// instant/host-only behavior (newGame() above still enforces host-only there).
function requestNewGame() {
  // Can't start (or ask for) a rematch until the current game has actually
  // ended - otherwise an abandoned in-progress game never reaches a real
  // conclusion and can never be recorded (no winner was ever decided).
  if (state.connecting || !state.gameStarted || !state.gameOver) return;

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

// For an empty cell next to a candidate placement, how many of its own 4
// sides are still "open" (empty, in bounds) once this piece is down. Fewer
// open sides means it's closer to being fully sealed off into a capture -
// 1 open side is one placement away, 2 is two away, and so on. A side that's
// already the opponent's means this cell can never be mine, so it's ignored
// entirely rather than counted as "progress."
function sealTierBonus(openSides) {
  if (openSides === 1) return 5;
  if (openSides === 2) return 2;
  if (openSides === 3) return 0.5;
  return 0;
}

// Pockets past this size are treated as "still just the open board," not a
// forming capture - walling one off takes several more turns, which is
// plenty of time for the opponent to walk a piece into the middle of it and
// permanently contest it. Capped below this size, a pocket is small enough
// to realistically finish sealing before that happens.
const REGION_SIZE_CAP = 8;

// Bounded flood fill from one empty cell, used only to size-check the pocket
// it belongs to. Stops early (capped: true) once it's clearly bigger than
// REGION_SIZE_CAP rather than walking the whole board.
function boundedRegionSize(simBoard, startIdx, opponent, cap) {
  const visited = new Set([startIdx]);
  const queue = [startIdx];
  let qi = 0;
  let touchesOpponent = false;
  while (qi < queue.length) {
    if (queue.length > cap) return { size: queue.length, touchesOpponent, capped: true };
    const cur = queue[qi++];
    const r = Math.floor(cur / BOARD_SIZE), c = cur % BOARD_SIZE;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      const nidx = idx(nr, nc);
      const val = simBoard[nidx];
      if (val === 0) {
        if (!visited.has(nidx)) { visited.add(nidx); queue.push(nidx); }
      } else if (val === opponent) {
        touchesOpponent = true;
      }
    }
  }
  return { size: queue.length, touchesOpponent, capped: false };
}

// Can any of the opponent's remaining hand pieces be legally placed on
// `board` (a specific candidate's simulated post-move board, so this is
// always checked against the exact position being scored - never a stale
// snapshot from before that candidate's own piece went down) with at least
// one cell landing inside `regionCells`? Search is restricted to the
// region's bounding box (expanded by each orientation's own footprint) and
// exits on the first fit found, so a large open region - which will have a
// fit almost immediately - resolves fast, and a small tightly-shaped region
// only searches a small area.
function opponentCanReachRegion(board, regionCells, opponentHand) {
  const regionSet = new Set(regionCells);
  let minR = BOARD_SIZE, maxR = -1, minC = BOARD_SIZE, maxC = -1;
  for (const cell of regionCells) {
    const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }
  const distinctShapes = new Set(opponentHand);
  for (const shapeName of distinctShapes) {
    for (const orientation of ORIENTATIONS[shapeName]) {
      const maxDr = Math.max(...orientation.map(p => p[0]));
      const maxDc = Math.max(...orientation.map(p => p[1]));
      const r0Start = Math.max(0, minR - maxDr);
      const r0End = Math.min(BOARD_SIZE - 1 - maxDr, maxR);
      const c0Start = Math.max(0, minC - maxDc);
      const c0End = Math.min(BOARD_SIZE - 1 - maxDc, maxC);
      for (let r0 = r0Start; r0 <= r0End; r0++) {
        for (let c0 = c0Start; c0 <= c0End; c0++) {
          let ok = true, touchesRegion = false;
          for (const [dr, dc] of orientation) {
            const cell = idx(r0 + dr, c0 + dc);
            if (board[cell] !== 0) { ok = false; break; }
            if (regionSet.has(cell)) touchesRegion = true;
          }
          if (ok && touchesRegion) return true;
        }
      }
    }
  }
  return false;
}

// Bot-only variant of computeFinalScores(): a region only counts toward
// this "trusted" tally if, on top of being fully mono-bordered, the OTHER
// player's remaining hand has no legal placement reaching into it - a
// region already owned by player 1 is checked against hand2 (can the bot
// still contest it), and vice versa. computeFinalScores answers "who would
// this belong to if the game ended right now," which is the right question
// for real end-of-game scoring but a poor one for move selection - a mono-
// bordered region the other side can still drop a piece into isn't a
// secured advantage, it's just space nobody's gotten around to contesting
// yet, and trusting it is exactly what leads the bot to stake out large,
// undefended "captures" that get walked into and nullified a turn or two
// later. This is also what lets the bot recognize a genuine threat: if the
// opponent's forming territory isn't reachable by the bot's own hand, it
// counts at full value here, which is precisely the signal that should
// drive the bot to cut in and contest it before it's too late while it
// still can.
function removeOnePiece(hand, shapeName) {
  const i = hand.indexOf(shapeName);
  if (i === -1) return hand;
  const copy = hand.slice();
  copy.splice(i, 1);
  return copy;
}

function computeTrustedScores(board, hand1, hand2) {
  const visited = new Uint8Array(board.length);
  let trusted1 = 0, trusted2 = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0 && !visited[i]) {
      const regionCells = [i];
      visited[i] = 1;
      let qi = 0;
      const borderOwners = new Set();
      while (qi < regionCells.length) {
        const cur = regionCells[qi++];
        const r = Math.floor(cur / BOARD_SIZE), c = cur % BOARD_SIZE;
        for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
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
        const invaderHand = owner === 1 ? hand2 : hand1;
        if (!opponentCanReachRegion(board, regionCells, invaderHand)) {
          if (owner === 1) trusted1 += regionCells.length;
          else trusted2 += regionCells.length;
        }
      }
    }
  }
  return { trusted1, trusted2 };
}

function scoreBotCandidate(candidate, board, player) {
  const opponent = player === 1 ? 2 : 1;
  const orientation = ORIENTATIONS[candidate.shapeName][candidate.orientationIndex];

  // Look ahead: simulate the placement and score the resulting position
  // with the exact same final-tally function the game uses at game end.
  // This lets the bot actually recognize and grab territory it can enclose
  // right now, instead of only reacting to adjacency.
  const simBoard = board.slice();
  const cells = [];
  for (const [dr, dc] of orientation) {
    const cell = idx(candidate.r0 + dr, candidate.c0 + dc);
    simBoard[cell] = player;
    cells.push(cell);
  }
  // The hand passed in for reachability purposes should reflect that this
  // candidate's own piece is no longer "available" - it's already down on
  // simBoard. Without this, a move that uses up the bot's only piece
  // capable of reaching some other opponent-leaning pocket would still get
  // credit as if that pocket were still contestable, hiding the real cost
  // of spending this piece here instead of there. This is also what
  // creates the incentive to actually block: if using a piece on a small
  // capture elsewhere would leave a bigger opponent pocket newly
  // unreachable (and therefore newly "trusted" for them), that shows up
  // directly as a worse territoryDelta for this candidate.
  const myHandForTrust = removeOnePiece(player === 1 ? state.hand1 : state.hand2, candidate.shapeName);
  const hand1ForTrust = player === 1 ? myHandForTrust : state.hand1;
  const hand2ForTrust = player === 2 ? myHandForTrust : state.hand2;
  const { trusted1, trusted2 } = computeTrustedScores(simBoard, hand1ForTrust, hand2ForTrust);
  const myScore = player === 1 ? trusted1 : trusted2;
  const oppScore = player === 1 ? trusted2 : trusted1;
  const territoryDelta = myScore - oppScore;

  // When no immediate capture is available (the common case, especially
  // early on), the old fallback just counted how many of the piece's own
  // cells touched a board edge - which meant any placement that ran flat
  // along an edge won regardless of whether it was actually building
  // toward anything, since a straight piece maximizes that count just by
  // lying parallel to the wall. sealProgress instead looks at the empty
  // cells the piece now borders and rewards ones that are genuinely close
  // to being boxed in, which is what a wall is actually useful for.
  let ownAdj = 0, oppAdj = 0, cornerTouches = 0, edgeTouches = 0, sealProgress = 0;
  const seenEmpty = new Set();
  for (const cell of cells) {
    const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
    const onEdgeR = r === 0 || r === BOARD_SIZE - 1;
    const onEdgeC = c === 0 || c === BOARD_SIZE - 1;
    if (onEdgeR && onEdgeC) cornerTouches++;
    else if (onEdgeR || onEdgeC) edgeTouches++;

    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      const val = board[idx(nr, nc)];
      if (val === player) ownAdj++;
      else if (val === opponent) oppAdj++;

      const nidx = idx(nr, nc);
      if (simBoard[nidx] !== 0 || seenEmpty.has(nidx)) continue;
      seenEmpty.add(nidx);

      let openSides = 0;
      for (const [nr2, nc2] of [[nr - 1, nc], [nr + 1, nc], [nr, nc - 1], [nr, nc + 1]]) {
        if (nr2 < 0 || nr2 >= BOARD_SIZE || nc2 < 0 || nc2 >= BOARD_SIZE) continue; // board edge - already sealed
        const v = simBoard[idx(nr2, nc2)];
        if (v === 0) openSides++;
      }

      // How big is the actual pocket this cell belongs to? A tight 1-open-
      // side cell that's part of a sprawling 20-cell region isn't "one
      // placement from a capture" the way it would be in a small pocket -
      // scale the tier bonus down toward zero as the true region grows past
      // REGION_SIZE_CAP, and drop it entirely if the opponent already
      // borders that pocket anywhere within the capped radius.
      const region = boundedRegionSize(simBoard, nidx, opponent, REGION_SIZE_CAP);
      if (!region.touchesOpponent && !region.capped) {
        const sizeFactor = 1 - (region.size - 1) / REGION_SIZE_CAP;
        sealProgress += sealTierBonus(openSides) * sizeFactor;
      }
    }
  }

  return territoryDelta * 1000
    + sealProgress
    + cornerTouches * 3
    + edgeTouches * 0.5
    + ownAdj * 2
    - oppAdj * 1.5
    + Math.random() * 0.5;
}

// Hardcoded override, kept separate from the scoring heuristic above: the
// bot should never voluntarily lead with the tromino. It's the hand's most
// flexible piece (small enough to fit gaps nothing else can), so burning it
// in the opening turns - when there's no real board state to react to yet -
// just wastes that flexibility for later, unless it's actually blocking
// something the opponent is building right now.
const EARLY_GAME_PLY_LIMIT = 6;

function blocksOpponent(candidate, board, opponent) {
  const orientation = ORIENTATIONS[candidate.shapeName][candidate.orientationIndex];
  for (const [dr, dc] of orientation) {
    const r = candidate.r0 + dr, c = candidate.c0 + dc;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      if (board[idx(nr, nc)] === opponent) return true;
    }
  }
  return false;
}

// Detects an opponent playing a perfect 180-degree mirror of the bot's
// moves - reflecting every placement through the board's center point,
// same shape and all. On this board (12x12, so there's no fixed center
// cell) with both players dealt an identical hand, that strategy keeps
// the position symmetric turn after turn if left unchallenged, forcing an
// exact tie in real territory. Almost every placement's mirror image is
// legal too, so most move choices can't escape it on their own - except
// one real structural escape hatch: a placement whose own cells are
// already closed under the board's mirror map (see isSelfMirroringPlacement
// below), which the opponent literally cannot copy since "mirroring" it
// would land on the exact same, now-occupied, cells. pickBotPlacement
// prefers that whenever it's available; MIRROR_DETECT_ROUNDS is the
// fallback for turns where it isn't (e.g. no self-mirroring piece in
// hand), and only makes the pattern harder to keep pulling off, not
// guaranteed to beat it.
const MIRROR_DETECT_ROUNDS = 3;

// True if every occupied/empty cell has an occupied/empty mirror partner
// under the board's 180-degree point reflection - i.e. the position is
// still exactly symmetric (either it's the very start of the game, or the
// opponent has mirrored every move so far).
function isBoardSymmetric(board) {
  for (let i = 0; i < board.length; i++) {
    const r = Math.floor(i / BOARD_SIZE), c = i % BOARD_SIZE;
    const mirrored = idx(BOARD_SIZE - 1 - r, BOARD_SIZE - 1 - c);
    if (mirrored < i) continue; // check each pair once
    if ((board[i] !== 0) !== (board[mirrored] !== 0)) return false;
  }
  return true;
}

// True if this candidate's own set of cells is closed under the board's
// 180-degree point reflection - every cell's mirror partner is also part
// of the same placement. Reflecting a move like this produces the exact
// same cells, which this move just occupied, so there is nothing left for
// an opponent to "mirror" it into. Only a handful of (shape, orientation,
// position) combinations satisfy this on a 12x12 board - e.g. the 2x2
// square tetromino placed dead-center - since it requires both the piece
// itself and its exact placement to line up with the board's fold line.
function isSelfMirroringPlacement(candidate) {
  const orientation = ORIENTATIONS[candidate.shapeName][candidate.orientationIndex];
  const cellSet = new Set(orientation.map(([dr, dc]) => idx(candidate.r0 + dr, candidate.c0 + dc)));
  for (const cell of cellSet) {
    const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
    const mirrored = idx(BOARD_SIZE - 1 - r, BOARD_SIZE - 1 - c);
    if (!cellSet.has(mirrored)) return false;
  }
  return true;
}

function cellsForMove(move) {
  const orientation = ORIENTATIONS[move.shapeName][move.orientationIndex];
  return orientation.map(([dr, dc]) => idx(move.r0 + dr, move.c0 + dc));
}

function isExactMirror(earlierMove, laterMove) {
  if (earlierMove.shapeName !== laterMove.shapeName) return false;
  const earlierCells = new Set(cellsForMove(earlierMove));
  const laterCells = cellsForMove(laterMove);
  if (laterCells.length !== earlierCells.size) return false;
  for (const cell of laterCells) {
    const r = Math.floor(cell / BOARD_SIZE), c = cell % BOARD_SIZE;
    const mirrored = idx(BOARD_SIZE - 1 - r, BOARD_SIZE - 1 - c);
    if (!earlierCells.has(mirrored)) return false;
  }
  return true;
}

function opponentIsMirroring(player) {
  const opponent = player === 1 ? 2 : 1;
  const log = state.moveLog;
  if (log.length < MIRROR_DETECT_ROUNDS * 2) return false;
  for (let round = 0; round < MIRROR_DETECT_ROUNDS; round++) {
    const opponentMove = log[log.length - 1 - round * 2];
    const myMove = log[log.length - 2 - round * 2];
    if (!myMove || !opponentMove) return false;
    if (myMove.player !== player || opponentMove.player !== opponent) return false;
    if (!isExactMirror(myMove, opponentMove)) return false;
  }
  return true;
}

function pickBotPlacement(hand, board, player) {
  let placements = enumerateLegalPlacements(hand, board);
  if (placements.length === 0) return null;

  if (state.plyCount < EARLY_GAME_PLY_LIMIT) {
    const opponent = player === 1 ? 2 : 1;
    const nonTromino = placements.filter((cand) =>
      !TROMINO_NAMES.includes(cand.shapeName) || blocksOpponent(cand, board, opponent)
    );
    if (nonTromino.length > 0) placements = nonTromino;
  }

  if (isBoardSymmetric(board)) {
    const selfMirroring = placements.filter(isSelfMirroringPlacement);
    if (selfMirroring.length > 0) {
      let mirrorBest = null, mirrorBestScore = -Infinity;
      for (const cand of selfMirroring) {
        const s = scoreBotCandidate(cand, board, player);
        if (s > mirrorBestScore) { mirrorBestScore = s; mirrorBest = cand; }
      }
      return mirrorBest;
    }
  }

  const scored = [];
  let best = null, bestScore = -Infinity;
  for (const cand of placements) {
    const s = scoreBotCandidate(cand, board, player);
    scored.push({ cand, score: s });
    if (s > bestScore) { bestScore = s; best = cand; }
  }

  // Once several rounds in a row have matched exactly, stop always taking
  // the single top-scoring candidate and pick randomly among a handful of
  // the best options instead - a human copying moves by eye now has to
  // work out a different mirror cell almost every turn instead of just
  // repeating the same obvious motion, which is where this strategy
  // actually falls apart for a real person playing through the UI even
  // though it can't be defeated in principle.
  if (opponentIsMirroring(player)) {
    scored.sort((a, b) => b.score - a.score);
    const pool = scored.slice(0, Math.min(5, scored.length));
    return pool[Math.floor(Math.random() * pool.length)].cand;
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

  // Sent before the game-over check below, not after - a pass that happens
  // to be the second in a row (ending the game) still needs to reach the
  // opponent, otherwise their client never learns the game ended and is
  // left waiting on a turn that will never come.
  if (state.online && !fromRemote) {
    Net.send({ type: 'pass', seq: state.plyCount });
  }

  if (state.passStreak >= 2) {
    endGame('Both players passed in a row.');
    return;
  }

  render();

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

function commitPlacement(shapeName, orientationIndex, r0, c0, fromRemote = false, t = Date.now()) {
  if (state.online && !fromRemote && state.myPlayer !== state.turn) return;

  state.history.push(snapshotState());

  const player = state.turn;
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  for (const [dr, dc] of orientation) {
    state.board[idx(r0 + dr, c0 + dc)] = player;
  }
  const hand = player === 1 ? state.hand1 : state.hand2;
  hand.splice(hand.indexOf(shapeName), 1);
  state.moveLog.push({ player, shapeName, orientationIndex, r0, c0, t });
  state.lastMove = { shapeName, orientationIndex, r0, c0, player };
  state.passStreak = 0;
  log(`${playerLabel(player)} placed ${shapeName}-pentomino. ${hand.length} piece(s) left.`);

  state.selected = null;
  state.hover = null;

  switchTurn();
  // Captured immediately after this move's own turn switch, before
  // checkGameEnd() below - which can itself call switchTurn() one or more
  // further times for automatic passes (a hand with no legal move left).
  // Those auto-passes are deterministic from the now-synced board/hand
  // state, so both clients apply them identically without needing a
  // network message - but sending a plyCount that already includes them
  // would jump by more than the +1 the receiver's isExpectedNextAction()
  // ever expects, wrongly triggering a resync (this was actually breaking
  // PvP games whenever a placement also emptied the opponent's remaining
  // legal moves, e.g. near the end of a game - including, if it happened
  // on the very last move, silently absorbing the finished game via a
  // resync instead of ever calling endGame()/recordGameResult() locally,
  // so the match never got saved).
  const seq = state.plyCount;
  checkGameEnd();
  render();

  if (state.online && !fromRemote) {
    Net.send({ type: 'move', shapeName, orientationIndex, r0, c0, t, seq });
  }

  scheduleBotMove();
}

function performUndo() {
  // Undoing past a finished game restores gameOver to false (it's part of
  // the snapshot), which would let endGame() run again on whatever new
  // outcome comes next - recording a second, separate result for what's
  // really the same game (e.g. lose to the bot, undo, replay until you
  // win, repeat for as many recorded "wins" as you want). Guarding here
  // covers every path that can trigger an undo (local vs-bot/hotseat, and
  // an accepted online undo-request), not just requestUndo()'s own check.
  if (state.gameOver || state.history.length === 0) return;
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
  if (state.connecting || !state.gameStarted || state.gameOver || state.history.length === 0) return;

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
  // Every call site that passes forcedWinner does so specifically because
  // the game ended by timeout/forfeit rather than by territory (see
  // forfeitGame, timeoutForfeit, timeoutOpponentForfeit, the network
  // 'forfeit' handler, and handleOpponentTimeout) - a natural end (both
  // players passed) never provides one. This is what downstream displays
  // (scoreboard, replays, profile/recent history) use to show "W - FF"
  // instead of a territory tally that was never actually the deciding
  // factor for how the game ended.
  state.forfeit = forcedWinner !== undefined;
  stopTurnTimer();
  clearInterval(reconnectCountdownTimer);
  clearTimeout(resyncFallbackTimer);
  if (state.online) {
    Net.leaveRoom();
    clearActiveMatch();
  }

  const { score1, score2, undecided, scoringCells } = computeFinalScores(state.board);
  state.score1 = score1 + (handicapPlayer() === 1 ? HANDICAP_POINTS : 0);
  state.score2 = score2 + (handicapPlayer() === 2 ? HANDICAP_POINTS : 0);
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
  state.winner = winner;

  const scoreLine = state.forfeit
    ? `${playerLabel(1)}: ${winner === 1 ? 'W' : 'FF'}, ${playerLabel(2)}: ${winner === 2 ? 'W' : 'FF'}`
    : `${playerLabel(1)}: ${state.score1}, ${playerLabel(2)}: ${state.score2}, Undecided: ${undecided}`;
  log(`Game over — ${reason} Final score - ${scoreLine}. ${result}`);
  recordGameResult(winner, state.forfeit);
  render();
}

async function recordGameResult(winner, forfeit) {
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
      forfeit,
      initial_hand: state.initialHand,
      move_log: state.moveLog,
      board_size: BOARD_SIZE,
      started_at: state.gameStartedAt,
    };
  } else {
    if (!state.online) return;
    const me = Auth.getUser();
    // Both sides independently attempt to record if THEY are currently
    // logged in, instead of only ever having one "preferred" side (the
    // host) try - that used a snapshot of whether the other player was
    // logged in from back when the match started, so a session lost mid-
    // match (e.g. a browser clearing cookies/storage) meant neither side
    // ended up recording it: the side that lost its session correctly
    // skips, but the other side's stale "is the host still logged in"
    // check kept it from recording too. client_match_id's unique
    // constraint (schema.sql Phase 15) makes both sides attempting this
    // harmless in the normal case where both are still logged in -
    // whichever insert lands first wins, the other is just rejected.
    if (!me) return;

    const player1_id = state.myPlayer === 1 ? me.id : state.opponentUserId;
    const player2_id = state.myPlayer === 2 ? me.id : state.opponentUserId;

    row = {
      mode: state.gameMode,
      player1_id,
      player2_id,
      score1: state.score1,
      score2: state.score2,
      winner,
      forfeit,
      initial_hand: state.initialHand,
      move_log: state.moveLog,
      board_size: BOARD_SIZE,
      started_at: state.gameStartedAt,
      // Net.matchId alone is the same for every rematch within this
      // connection - appending gameSequence makes this unique PER GAME, so
      // a rematch's result isn't wrongly rejected as a duplicate of the
      // first game (see state.gameSequence's definition for the full story).
      client_match_id: Net.matchId ? `${Net.matchId}-${state.gameSequence}` : null,
    };
  }

  const { data, error } = await supabaseClient.from('games').insert(row).select('id').single();
  if (error) {
    // A unique-violation on client_match_id just means the other player
    // (also still logged in) already recorded this exact match first -
    // not a real failure, since both sides now attempt this on purpose.
    if (error.code !== '23505') log('Could not save game result: ' + error.message);
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
  // Re-selecting the SAME piece that's already selected (e.g. picking a
  // dragged-and-dropped piece back up to move it somewhere else - see
  // wirePieceDrag()) keeps its current rotation instead of resetting to 0,
  // so rotating a piece is never lost just by dragging it again.
  const orientationIndex = (state.selected && state.selected.shapeName === shapeName)
    ? state.selected.orientationIndex
    : 0;
  state.selected = { shapeName, orientationIndex };
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
  refreshDragGhostShape();
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
    banner.textContent = 'Choose a mode to start playing';
  } else if (state.gameOver) {
    banner.textContent = 'Game over';
  } else if (state.online) {
    const you = state.myPlayer === state.turn ? ' (your turn)' : " (opponent's turn)";
    banner.textContent = `${playerLabel(state.turn)}'s turn${you}`;
  } else {
    banner.textContent = `${playerLabel(state.turn)}'s turn`;
  }

  document.getElementById('scoreLabel1').innerHTML = playerBadgeHtml(1);
  document.getElementById('scoreLabel2').innerHTML = playerBadgeHtml(2);
  if (state.gameOver && state.forfeit) {
    document.getElementById('score1').textContent = state.winner === 1 ? 'W' : 'FF';
    document.getElementById('score2').textContent = state.winner === 2 ? 'W' : 'FF';
  } else {
    document.getElementById('score1').textContent = state.score1;
    document.getElementById('score2').textContent = state.score2;
  }

  document.getElementById('handLabel1').innerHTML = `${playerLink(playerProfileId(1), playerLabel(1))}'s hand`;
  document.getElementById('handLabel2').innerHTML = `${playerLink(playerProfileId(2), playerLabel(2))}'s hand`;

  if (state.gameStarted) {
    const proj = computeFinalScores(state.board);
    const proj1 = proj.score1 + (handicapPlayer() === 1 ? HANDICAP_POINTS : 0);
    const proj2 = proj.score2 + (handicapPlayer() === 2 ? HANDICAP_POINTS : 0);
    document.getElementById('projected').innerHTML =
      `Projected if game ended now: ${playerLabel(1)} ${proj1} &middot; ${playerLabel(2)} ${proj2} &middot; Undecided ${proj.undecided}`;
  } else {
    document.getElementById('projected').textContent = 'No game in progress yet.';
  }

  renderHand('hand1', state.hand1, 1);
  renderHand('hand2', state.hand2, 2);

  updateSelectionInfo();

  canvas.classList.toggle('placing', !!state.selected && !state.gameOver);

  document.getElementById('rotateBtn').disabled = state.connecting || !state.gameStarted;
  document.getElementById('newGameBtn').disabled = state.connecting || !state.gameStarted || !state.gameOver || state.pendingNewGameRequest;
  document.getElementById('undoBtn').disabled = state.connecting || !state.gameStarted || state.gameOver
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

  document.getElementById('casualQueueBtn').disabled = state.online || state.connecting || state.queueSearching;
  document.getElementById('rankedQueueBtn').disabled = state.online || state.connecting || state.queueSearching;
  // Only show Cancel while genuinely establishing a first connection - not
  // while state.connecting is true because we're mid-game waiting for a
  // disconnected opponent to reconnect (state.online is already true then).
  // Also shown for a queue search in progress, even though that doesn't
  // set state.connecting (see queueSearching's own comment) - it's still
  // a "first connection being established" from the queue's perspective.
  document.getElementById('cancelConnectBtn').style.display = ((state.connecting || state.queueSearching) && !state.online) ? '' : 'none';

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

// ---------- Mobile drag-to-place ----------
// Touch users can already tap a piece then tap the board twice (see the
// canvas touchstart handler below), but dragging a piece straight from the
// hand tray onto the board is the more natural mobile gesture. Tracks a
// single in-progress drag at a time; a touch that never moves past
// DRAG_THRESHOLD_PX is just treated as a plain tap-to-select instead.
// Dropping the drag doesn't place the piece outright - see
// finishPieceDrag()'s comment - it just leaves a preview at the drop
// point, confirmed the same way a plain tap-tap placement is.
let pieceDrag = null; // { shapeName, startX, startY, moved, ghostEl }
const DRAG_THRESHOLD_PX = 8;

function createDragGhost(shapeName, orientationIndex) {
  const ghost = document.createElement('div');
  ghost.className = 'piece-drag-ghost';
  const c = document.createElement('canvas');
  drawShapeIcon(c, ORIENTATIONS[shapeName][orientationIndex]);
  ghost.appendChild(c);
  document.body.appendChild(ghost);
  return ghost;
}

function updateDragGhost(ghostEl, clientX, clientY) {
  if (!ghostEl) return;
  // Offset above the finger so the piece itself isn't hidden underneath it.
  ghostEl.style.left = `${clientX}px`;
  ghostEl.style.top = `${clientY - 60}px`;
}

// Lets the mobile rotate button (or the 'r' key/scroll-wheel, on the off
// chance a touch device also has one) actually rotate the piece being
// dragged - without this the ghost silently kept showing the pre-rotation
// orientation even though the board's hover preview underneath had already
// rotated, since the ghost is a static canvas snapshot taken once at drag
// start rather than something recomputed every frame like the hover.
function refreshDragGhostShape() {
  if (!pieceDrag || !pieceDrag.moved || !pieceDrag.ghostEl || !state.selected) return;
  const canvasEl = pieceDrag.ghostEl.querySelector('canvas');
  if (canvasEl) drawShapeIcon(canvasEl, ORIENTATIONS[state.selected.shapeName][state.selected.orientationIndex]);
}

// Shared with mouse/tap hover - just derives state.mouseRC from a raw touch
// point instead of a mousemove event, then reuses the exact same
// recomputeHover()/drawBoard() the rest of the board interaction already
// relies on for the live placement preview.
function updateBoardHoverFromPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const overBoard = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  state.mouseRC = overBoard ? getBoardCell(clientX, clientY) : null;
  recomputeHover();
  drawBoard();
}

// Dropping a dragged piece no longer commits it immediately - it leaves
// the placement as a live preview (the same on-board hover highlight the
// mouse shows) instead, so the piece can still be rotated afterward via
// the rotate button. Rotating mid-drag was awkward - the whole point of
// dropping first - so confirming now always takes a second, separate tap
// on the same board cell, reusing the exact "tap the same cell twice"
// confirm check the canvas's own touchstart handler below already
// implements for its keyboard-less tap-to-place flow.
function finishPieceDrag(clientX, clientY) {
  updateBoardHoverFromPoint(clientX, clientY);
  state.lastTapCell = state.mouseRC ? { row: state.mouseRC.row, col: state.mouseRC.col } : null;
}

function wirePieceDrag(item, name) {
  item.addEventListener('touchstart', (e) => {
    e.preventDefault();
    pieceDrag = { shapeName: name, startX: e.touches[0].clientX, startY: e.touches[0].clientY, moved: false, ghostEl: null };
  }, { passive: false });

  item.addEventListener('touchmove', (e) => {
    if (!pieceDrag || pieceDrag.shapeName !== name) return;
    e.preventDefault();
    const touch = e.touches[0];
    if (!pieceDrag.moved && Math.hypot(touch.clientX - pieceDrag.startX, touch.clientY - pieceDrag.startY) > DRAG_THRESHOLD_PX) {
      pieceDrag.moved = true;
      selectShape(pieceDrag.shapeName);
      pieceDrag.ghostEl = createDragGhost(pieceDrag.shapeName, state.selected.orientationIndex);
    }
    if (pieceDrag.moved) {
      updateDragGhost(pieceDrag.ghostEl, touch.clientX, touch.clientY);
      updateBoardHoverFromPoint(touch.clientX, touch.clientY);
    }
  }, { passive: false });

  item.addEventListener('touchend', (e) => {
    if (!pieceDrag || pieceDrag.shapeName !== name) return;
    if (pieceDrag.moved) {
      const touch = e.changedTouches[0];
      finishPieceDrag(touch.clientX, touch.clientY);
      if (pieceDrag.ghostEl) pieceDrag.ghostEl.remove();
    } else {
      // Never moved past the threshold - a plain tap, same as a click.
      selectShape(name);
    }
    pieceDrag = null;
  });

  item.addEventListener('touchcancel', () => {
    if (!pieceDrag || pieceDrag.shapeName !== name) return;
    if (pieceDrag.ghostEl) pieceDrag.ghostEl.remove();
    state.hover = null;
    drawBoard();
    pieceDrag = null;
  });
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
      wirePieceDrag(item, name);
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
let opponentDisconnectFallbackTimer = null;
let rejoinTimeoutId = null;
let resyncRequestTimeoutId = null;
const REJOIN_TIMEOUT_MS = 15000;
const RESYNC_REQUEST_TIMEOUT_MS = 5000;

// Requests the opponent's canonical state after noticing a gap in the move
// sequence - a lighter, faster fix than a full reconnect for the common
// case of one dropped message on an otherwise-fine connection. Freezes the
// board briefly while waiting; if the resync itself never arrives (the
// connection is actually unhealthy, not just missing one message), escalate
// to the heavier full-reconnect path instead of waiting forever.
function requestResync() {
  if (state.connecting) return; // already recovering some other way
  state.connecting = true;
  render();
  setLobbyStatus('Game state out of sync - resyncing...');
  Net.send({ type: 'resync-request' });

  clearTimeout(resyncRequestTimeoutId);
  resyncRequestTimeoutId = setTimeout(() => {
    if (!state.connecting) return; // already resolved
    // This attempt failed - reset connecting so handleConnectionStale()'s
    // own guard doesn't just bounce off it, then let it start a fresh
    // (heavier) recovery phase.
    state.connecting = false;
    handleConnectionStale();
  }, RESYNC_REQUEST_TIMEOUT_MS);
}

function saveActiveMatch() {
  if (state.gameMode !== 'casual' && state.gameMode !== 'ranked') return;
  const user = Auth.getUser();
  if (!user || !Net.matchId) return;
  localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify({ matchId: Net.matchId, userId: user.id }));
  updateResumeMatchBanner();
}

function clearActiveMatch() {
  localStorage.removeItem(ACTIVE_MATCH_KEY);
  updateResumeMatchBanner();
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

  // Safety net: this freeze is normally lifted by the server sending either
  // a fresh 'ready' (opponent reconnected) or 'opponent-timeout' (grace
  // period expired). If either message is ever lost - a server hiccup, or
  // this client's own signaling socket having issues during the wait -
  // there would otherwise be nothing to ever unfreeze the board again.
  // Force a local resolution shortly after the server's own grace period
  // should have ended if nothing else has by then.
  clearTimeout(opponentDisconnectFallbackTimer);
  opponentDisconnectFallbackTimer = setTimeout(() => {
    if (!state.connecting || state.gameOver) return;
    handleOpponentTimeout();
  }, (graceMs || 30000) + 5000);
}

function handleOpponentTimeout() {
  clearInterval(reconnectCountdownTimer);
  clearTimeout(opponentDisconnectFallbackTimer);
  state.connecting = false;
  if (state.gameOver || !state.gameStarted) return;
  endGame('Opponent did not reconnect in time.', state.myPlayer);
}

function handleRejoinReady() {
  clearInterval(reconnectCountdownTimer);
  clearTimeout(opponentDisconnectFallbackTimer);
  clearTimeout(rejoinTimeoutId);
  state.online = true;
  state.connecting = false;
  state.vsBot = false;
  state.gameMode = Net.matchedMode;
  state.myPlayer = Net.isHost ? 1 : 2;
  document.getElementById('connectBtn').disabled = true;
  document.getElementById('roomInput').disabled = true;

  // Net.isRejoin is server-driven and true for BOTH peers whenever either
  // one reconnects (the signaling server broadcasts the same 'ready' to
  // both slots) - but only ONE side should actually broadcast its state as
  // authoritative. Net.selfInitiatedRejoin is local instead: true only for
  // the peer that actually just called Net.rejoin() itself. A same-page
  // reconnect (e.g. handleConnectionStale() after a mobile tab-out, as
  // opposed to a full page reload) never resets state.gameStarted, so
  // without this check both peers could believe "I have a live game" and
  // each fire off their own resync at once - whichever arrived second would
  // win the race and could clobber a perfectly fine board with a stale one
  // from the side that just reconnected.
  const iInitiatedThisRejoin = Net.selfInitiatedRejoin;
  Net.clearSelfInitiatedRejoin();

  // Re-send identify - if I'm the one who just reloaded, state.opponentUserId
  // is back to null and recordGameResult() needs the real value.
  const myProfile = Auth.getProfile();
  Net.send({
    type: 'identify',
    userId: Auth.getUser()?.id ?? null,
    username: myProfile ? myProfile.username : null,
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
    eloRating: myProfile ? myProfile.elo_rating : null,
    companion: myProfile ? myProfile.companion : null,
  });

  const iHaveLiveGame = state.gameStarted && !state.gameOver;
  if (iHaveLiveGame && !iInitiatedThisRejoin) {
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

function hasActiveMatchRecord() {
  const raw = localStorage.getItem(ACTIVE_MATCH_KEY);
  if (!raw) return false;
  try {
    const record = JSON.parse(raw);
    return !!(record && record.matchId && record.userId);
  } catch {
    return false;
  }
}

// Shared by tryResumeActiveMatch() (page-load/manual-button path, using the
// matchId saved in localStorage) and handleConnectionStale() (mid-session
// proactive path, using the currently-live match's own matchId) - both just
// need a fresh signaling socket and a brand new WebRTC handshake for the
// same match, with the same safety-net timeout if the attempt never
// resolves either way.
function attemptRejoin(matchIdToJoin, userId, accessToken) {
  clearTimeout(rejoinTimeoutId);
  rejoinTimeoutId = setTimeout(() => {
    if (!state.connecting) return; // already resolved one way or another
    state.connecting = false;
    setLobbyStatus('Reconnect attempt timed out. Try again below.');
    render();
    updateResumeMatchBanner();
  }, REJOIN_TIMEOUT_MS);

  Net.rejoin({
    serverUrl: SIGNALING_SERVER_URL,
    matchId: matchIdToJoin,
    userId,
    accessToken,
    onStatus: setLobbyStatus,
    onReady: handleNetReady,
    onData: handleNetData,
    onPeerLeft: handleNetPeerLeft,
    onOpponentDisconnected: handleOpponentDisconnected,
    onOpponentTimeout: handleOpponentTimeout,
    onConnectionStale: handleConnectionStale,
    onRejoinFailed: (reason) => {
      clearTimeout(rejoinTimeoutId);
      clearActiveMatch();
      state.connecting = false;
      setLobbyStatus(reason || 'Could not reconnect to your previous match.');
      render();
    },
  });
}

// Fires when net.js's own data-channel liveness check decides nothing has
// come through in too long - independent of whatever the signaling server
// thinks. This matters most exactly when a mobile tab gets backgrounded and
// suspended: the underlying P2P channel can silently die without either
// side's browser cleanly reporting it, and the signaling-server-driven
// grace period (handleOpponentDisconnected) is never entered because the
// signaling socket itself may still look fine. Proactively rebuild the
// connection for the match we already know we're in, rather than waiting
// on a disconnect notice that may never arrive.
function handleConnectionStale() {
  if (!state.online || (state.gameMode !== 'casual' && state.gameMode !== 'ranked') || state.gameOver || state.connecting) return;
  const user = Auth.getUser();
  const accessToken = Auth.getAccessToken();
  if (!user || !accessToken || !Net.matchId) return;

  state.connecting = true;
  render();
  setLobbyStatus('Connection lost - reconnecting...');
  attemptRejoin(Net.matchId, user.id, accessToken);
}

// Called both automatically (once auth resolves after page load) and
// manually (the "Rejoin" button below) - a manual fallback matters because
// the automatic path depends on Auth's auth-state-change firing correctly,
// and there's no reason to strand someone mid-match if that ever hiccups.
function tryResumeActiveMatch(retriesLeft = 10) {
  updateResumeMatchBanner();
  if (state.online || state.connecting) return; // already mid-match - nothing to resume
  const raw = localStorage.getItem(ACTIVE_MATCH_KEY);
  if (!raw) return;
  let record;
  try { record = JSON.parse(raw); } catch { clearActiveMatch(); return; }
  if (!record || !record.matchId || !record.userId) { clearActiveMatch(); return; }

  const accessToken = Auth.getAccessToken();
  if (!accessToken) {
    // Auth may not have finished resolving yet on a fresh page load - retry
    // for a few seconds rather than silently giving up forever.
    if (retriesLeft > 0) setTimeout(() => tryResumeActiveMatch(retriesLeft - 1), 500);
    return;
  }

  state.connecting = true;
  render();
  updateResumeMatchBanner();
  setLobbyStatus('Reconnecting to your previous match...');
  attemptRejoin(record.matchId, record.userId, accessToken);
}

function updateResumeMatchBanner() {
  const banner = document.getElementById('resumeMatchBanner');
  if (!banner) return;
  banner.style.display = (!state.online && !state.connecting && !state.queueSearching && hasActiveMatchRecord()) ? 'flex' : 'none';
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
  // If this arrived while a local hotseat/vs-bot game was running in the
  // background during a queue search, it's abandoned here with no
  // forfeit recorded - by design, see queueSearching's own comment.
  state.vsBot = false;
  state.queueSearching = false;
  state.gameMode = Net.matchedMode;
  state.myPlayer = Net.isHost ? 1 : 2;
  state.opponentUserId = null;
  state.opponentUsername = null;
  state.opponentAvatarId = null;
  state.opponentTitleId = null;
  state.opponentEloRating = null;
  state.opponentCompanion = null;
  state.introShown = false;
  state.gameSequence = 0;
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
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
    eloRating: myProfile ? myProfile.elo_rating : null,
    companion: myProfile ? myProfile.companion : null,
  });

  if (Net.isHost) {
    newGame();
  } else {
    render();
  }

  saveActiveMatch();
}

// Wrapped so a bad/unexpected message (e.g. arriving mid-reconnect, out of
// the order a normal game would produce it) can never leave state changed
// but the DOM stale - an uncaught exception here would otherwise abort
// partway through a branch and skip its render() call, leaving click
// handlers bound to whatever was last drawn instead of current reality.
function handleNetData(msg) {
  try {
    handleNetDataInner(msg);
  } catch (err) {
    console.error('Pentomino: error handling network message', msg, err);
  } finally {
    render();
  }
}

// A move/pass carries the sender's plyCount right after they applied it -
// i.e. "this is action number seq." If it doesn't match exactly what we
// expect next, either we missed an earlier message (a brief connectivity
// blip too short to trip the data-channel staleness check, e.g. from
// switching tabs back and forth repeatedly) or this one is a stale
// duplicate - either way, applying it blindly would only compound the
// drift. Request a full resync instead of guessing.
function isExpectedNextAction(seq) {
  return typeof seq !== 'number' || seq === state.plyCount + 1;
}

function handleNetDataInner(msg) {
  if (msg.type === 'newgame') {
    newGame(msg.hand, msg.gameSequence);
  } else if (msg.type === 'move') {
    if (!isExpectedNextAction(msg.seq)) { requestResync(); return; }
    commitPlacement(msg.shapeName, msg.orientationIndex, msg.r0, msg.c0, true, msg.t);
  } else if (msg.type === 'pass') {
    if (!isExpectedNextAction(msg.seq)) { requestResync(); return; }
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
    state.opponentAvatarId = msg.avatarId ?? null;
    state.opponentTitleId = msg.titleId ?? null;
    state.opponentEloRating = msg.eloRating ?? null;
    state.opponentCompanion = msg.companion ?? null;
    showMatchIntroCard();
    render();
  } else if (msg.type === 'chat') {
    const opponentPlayerNum = state.myPlayer === 1 ? 2 : 1;
    log(`\u{1F4AC} ${playerLabel(opponentPlayerNum)}: ${msg.text}`);
    playChatPing();
  } else if (msg.type === 'elo-result') {
    showEloResult(state.myPlayer === 1 ? msg.delta_p1 : msg.delta_p2);
  } else if (msg.type === 'resync-request') {
    // The peer noticed a gap/mismatch in the move sequence and wants our
    // canonical state to catch up - same payload used for the post-rejoin
    // resync, just triggered in-band instead of after a reconnect.
    Net.send({ type: 'resync', ...serializeFullState() });
  } else if (msg.type === 'resync') {
    clearTimeout(resyncFallbackTimer);
    clearTimeout(resyncRequestTimeoutId);
    state.connecting = false;
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

// Room codes meant for a person to read/type/say out loud - avoid visually
// ambiguous characters (0/O, 1/I/L) rather than the server's own internal
// 8-char codes (generateRoomCode() in server.js), which nobody ever types.
function generatePrivateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function connectToPrivateRoom(room) {
  if (!room) {
    setLobbyStatus('Enter a room code.');
    return;
  }
  state.connecting = true;
  render();
  setLobbyStatus(`Connecting to room ${room}... (if this seems stuck for a while, it is safe to click again to retry)`);
  Net.connect({
    serverUrl: SIGNALING_SERVER_URL,
    joinMessage: { type: 'join', room },
    onStatus: setLobbyStatus,
    onReady: handleNetReady,
    onData: handleNetData,
    onPeerLeft: handleNetPeerLeft,
    onRoomFull: () => {
      state.connecting = false;
      render();
    },
  });
}

document.getElementById('connectBtn').addEventListener('click', () => {
  connectToPrivateRoom(document.getElementById('roomInput').value.trim());
});

document.getElementById('createRoomBtn').addEventListener('click', () => {
  // Auto-generating the code (rather than having the host type something
  // freeform, like the old "e.g. ABCD" placeholder) avoids unrelated pairs
  // of players both guessing the same obvious example and getting matched
  // with a stranger instead of their friend.
  const code = generatePrivateRoomCode();
  document.getElementById('roomInput').value = code;
  connectToPrivateRoom(code);
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

  // Deliberately state.queueSearching, not state.connecting - there's no
  // live match yet to freeze the board for, so a local hotseat/vs-bot game
  // already in progress (or started after this point) keeps running
  // normally while the search happens in the background.
  state.queueSearching = true;
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
    onConnectionStale: handleConnectionStale,
  });
}

document.getElementById('casualQueueBtn').addEventListener('click', () => startQueue('casual'));
document.getElementById('rankedQueueBtn').addEventListener('click', () => startQueue('ranked'));

document.getElementById('cancelConnectBtn').addEventListener('click', () => {
  Net.cancelQueue();
  state.connecting = false;
  state.queueSearching = false;
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

document.getElementById('resumeMatchBtn').addEventListener('click', () => tryResumeActiveMatch());

// A phone coming back from the background is exactly the case net.js's
// periodic staleness check is slowest to catch (it could be up to ~3s from
// the tab resuming before the next tick) - force an immediate check right
// when the tab becomes visible again instead of waiting on that.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.online) {
    Net.checkConnectionNow();
  }
});

// Navigating away and then back (browser back/forward button) commonly
// restores the page from the back-forward cache instead of doing a fresh
// load - the entire JS state (including state.online still being true)
// gets frozen and restored exactly as it was, but the browser closes the
// real WebSocket/RTCPeerConnection first, so none of this session's
// connect-time setup or Auth.onAuthChange(tryResumeActiveMatch) below ever
// reruns, and the board is left looking "connected" with a dead
// connection underneath - with no reconnect ever offered. pageshow's
// `persisted` flag is exactly how a bfcache restore is distinguished from
// a normal load (which already runs all of the init logic below on its
// own). If we were mid-match, treat the connection as stale and reuse the
// same rejoin path a dropped connection already goes through; otherwise
// fall back to the localStorage-based resume check, in case there's a
// record from a match that ended (or was left) while this page was cached.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (state.online) {
    handleConnectionStale();
  } else {
    tryResumeActiveMatch();
  }
});

// ---------- Init ----------
render();
updateResumeMatchBanner(); // show immediately if we have a record, even before auth resolves
Auth.onAuthChange(tryResumeActiveMatch);
refreshQueueCounts();
setInterval(refreshQueueCounts, QUEUE_COUNT_POLL_MS);
