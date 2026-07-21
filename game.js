// ---------- Configuration ----------
// Both mutable (not const) - a private room can pick a custom board shape
// (see BOARD_SHAPES below), which uses a bigger bounding box than the
// normal square board. Reassigned together in newGame(), same pattern
// singleplayer.js already uses per-mode. TARGET_BOARD_PX is the on-screen
// footprint every shape renders at - CELL_PX is derived from it instead of
// being fixed, so a bigger bounding box (custom shapes) doesn't visually
// balloon the board panel bigger than a normal game's.
let BOARD_SIZE = 12;
const TARGET_BOARD_PX = 624; // 12 * 52, the normal square board's on-screen size
let CELL_PX = TARGET_BOARD_PX / BOARD_SIZE;
const CUSTOM_SHAPE_BOARD_SIZE = 14; // bounding box for plus/x/heart - bigger than 12x12 so the carved-out shape still has room for a full hand
const HAND_COMPOSITION = { pentomino: 7, tetromino: 2, tromino: 1 };
const HANDICAP_POINTS = 0.5; // whoever moves second gets a half-point head start
const SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';
const TURN_TIME_LIMITS = { casual: 120, ranked: 60, ffa: 90 }; // seconds; bot/hotseat are always untimed. Private rooms are host-configurable (see state.privateTimerSeconds) - untimed by default.
// Board fill color per player number (1-indexed, array is 0-indexed) -
// matches --p1/--p2/--p3/--p4 in style.css exactly (kept in sync by hand;
// this file has no access to CSS custom properties from canvas drawing).
const PLAYER_COLORS = ['#5b7fd9', '#d97a52', '#7ec982', '#c96bd6'];
const ACTIVE_MATCH_KEY = 'minogoe_activeMatch'; // localStorage key for reconnect-after-reload
const MATCH_INTRO_DURATION_MS = 4500; // how long the pre-match "vs" intro card stays up before auto-dismissing

// ---------- Custom board shapes (private rooms only) ----------
// Each entry (other than 'square', which needs no mask) is a function
// (size) => Uint8Array of length size*size, 1 meaning "void" - a cell that
// can never be placed on and never counts as anyone's territory, treated
// exactly like being off the edge of the board everywhere this is
// consulted (isValidPlacement, computeFinalScores's flood-fill, drawBoard).
// Never a sentinel value inside state.board itself - computeFinalScores()
// would treat any non-zero cell as a border owner, so a void sentinel
// there would poison every adjacent region into "undecided" instead of
// behaving like a neutral wall.
const BOARD_SHAPES = {
  square: null,
  plus: (size) => {
    const mask = new Uint8Array(size * size);
    const armWidth = Math.round(size / 2.4);
    const lo = Math.floor((size - armWidth) / 2);
    const hi = lo + armWidth;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const inVerticalArm = c >= lo && c < hi;
        const inHorizontalArm = r >= lo && r < hi;
        if (!inVerticalArm && !inHorizontalArm) mask[r * size + c] = 1;
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
  // Classic implicit heart curve (x^2+y^2-1)^3 - x^2*y^3 <= 0 is "inside",
  // scaled to the board and with y flipped (row 0 is the top of the
  // screen, but the curve's two lobes sit at positive y) so the lobes land
  // at the top of the board and the point at the bottom.
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

// Shared by newGame() (a fresh board) and applyFullState() (a resync must
// restore the SAME sizing before applying the resynced board contents, or
// idx()/voidMask lookups would misalign against a custom shape's bigger
// bounding box - see applyFullState()'s comment). Sets BOARD_SIZE/CELL_PX/
// canvas dimensions and returns the matching voidMask; does not touch
// state.board itself, since the two callers populate it differently (a
// fresh empty array vs. the resynced contents).
function applyBoardShapeSizing(shape) {
  BOARD_SIZE = shape === 'square' ? 12 : CUSTOM_SHAPE_BOARD_SIZE;
  CELL_PX = TARGET_BOARD_PX / BOARD_SIZE;
  canvas.width = BOARD_SIZE * CELL_PX;
  canvas.height = BOARD_SIZE * CELL_PX;
  const shapeMaskFn = BOARD_SHAPES[shape];
  return shapeMaskFn ? shapeMaskFn(BOARD_SIZE) : new Uint8Array(BOARD_SIZE * BOARD_SIZE);
}

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
// Q_Z is Q_S mirrored, and Q_J is Q_L mirrored - since every piece can
// already be flipped in play (see generateOrientations()'s mirror step
// below), a hand piece named "Q_S" already covers every orientation
// "Q_Z" would too, and vice versa (same for Q_L/Q_J). Drawing both as
// separate hand entries silently doubled that one physical tetromino's
// odds of turning up in a hand relative to Q_I/Q_O/Q_T, which have no
// mirror partner. Q_Z/Q_J deliberately stay defined in BASE_SHAPES
// itself (just excluded from the drawable pool here) so an already-dealt
// hand or in-flight opponent move from before this fix still renders and
// validates correctly.
const TETROMINO_NAMES = ['Q_I', 'Q_O', 'Q_T', 'Q_S', 'Q_L'];
const TROMINO_NAMES = Object.keys(BASE_SHAPES).filter(n => n.startsWith('R_'));

function normalize(coords) {
  const minR = Math.min(...coords.map(p => p[0]));
  const minC = Math.min(...coords.map(p => p[1]));
  return coords
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
}

// Clockwise on screen: (r, c) here means (row, col) with row increasing
// DOWNWARD (screen space, not math space), so a cell directly below the
// anchor (r=1, c=0) maps to (c=0, -r=-1) - directly to its LEFT - and
// down-to-left is the clockwise direction. rotateSelected()'s default
// (no reverse) applies this as-is; reverse=true applies it 3 more times
// instead (a 270 clockwise = 90 counter-clockwise), for the other direction.
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
  // 1 per void cell (see BOARD_SHAPES) - all-zero for the normal square
  // board. Always sized to match state.board, reassigned together in
  // newGame(); safe to index unconditionally everywhere else since it's
  // never null.
  voidMask: new Uint8Array(BOARD_SIZE * BOARD_SIZE),
  boardShape: 'square', // 'square' | 'plus' | 'x' | 'heart' - private rooms only
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
  // Decided once per connection (a coin flip, by the host, right when a
  // match is actually found - see handleNetReady()) rather than always
  // defaulting to "host is player 1" - otherwise whoever the signaling
  // server happened to seat as host (e.g. whoever queued first) always
  // got to go first (and dodge the handicap) in the opening game of every
  // single match. Shared with the joiner via the 'newgame' message and
  // combined with gameSequence's parity (see computeMyPlayerForCurrentGame())
  // to keep alternating fairly across rematches from that random start.
  hostIsPlayerOneBase: true,
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
  turnDeadline: null, // epoch ms when the current online turn times out (casual/ranked, or a timed private room)
  lastTapCell: null,  // touch only: last cell tapped on the board, for tap-to-preview/tap-again-to-confirm
  scoringCells: null, // [{index, owner}] - set once the game ends, for the scoring-square dots

  // Private-room pre-game setup (see renderRoomSettingsPanel() below). Only
  // meaningful while state.gameMode === 'private' and no game is running yet
  // (the moment between both peers connecting - or the host clicking New
  // Game for a rematch - and the game actually starting). Only the host's
  // choices matter; the joiner's copies are just a synced read-only mirror
  // (see the 'room-settings' message). Structured as a settings object plus
  // a room for future per-piece-type state, rather than one hand-specific
  // flag, so future private-room toggles/modes have an obvious place to
  // add their own fields alongside handMode without a rework.
  awaitingRoomStart: false,
  roomSettings: { handMode: 'random', timerSeconds: null }, // handMode: 'random' | 'select'; timerSeconds: null (untimed) | 60 | 120
  roomHandCounts: {}, // shapeName -> count, only used while handMode === 'select'

  // The timer choice actually in effect for the CURRENT private-room game
  // (as opposed to state.roomSettings.timerSeconds, which is only the
  // pending choice while the settings overlay is open) - set from
  // roomSettings.timerSeconds the moment Start Game is clicked (host) or
  // from the 'newgame' message (joiner), and restored via a resync like
  // every other piece of real game state. null means untimed, matching
  // hotseat/vsBot/an unconfigured private room's existing behavior.
  privateTimerSeconds: null,

  // ---------- 4-player free-for-all (gameMode === 'ffa' only) ----------
  // Every existing mode uses hand1/hand2/score1/score2/opponentX above,
  // completely untouched - FFA gets its own parallel seat-indexed
  // representation instead of trying to force 4 seats into those pairwise
  // fields. player numbers stay 1-indexed everywhere (board values,
  // state.turn, playerLabel()) exactly like today, just up to 4 instead of
  // capped at 2 - array index [player - 1] throughout.
  playerCount: 2,      // 2 for every existing mode; 4 only in ffa
  hands: null,         // ffa only: [hand1, hand2, hand3, hand4]
  scores: null,        // ffa only: [score1, score2, score3, score4]
  ffaSeat: null,        // my own seat, 0-3 (== player - 1), once matched
  ffaPlayers: null,     // ffa only: [{userId,username,avatarId,titleId}|null, x4], seat-indexed - replaces the singular opponentX fields, which only ever assumed one opponent
  ffaEliminatedSeats: null, // ffa only: Set<seat 0-3> - permanently auto-passed after that seat's own reconnect grace expired; the others play on
  ffaAbandoned: false,  // ffa only: true once the host disconnected and never came back - match ended with no real result
  ffaRanks: null,       // ffa only: [rank1, rank2, rank3, rank4] seat-indexed, set once the game ends (standard competition ranking - ties share a rank)
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
    hostIsPlayerOneBase: state.hostIsPlayerOneBase,
    scoringCells: state.scoringCells,
    turnDeadline: state.turnDeadline,
    privateTimerSeconds: state.privateTimerSeconds,
    boardShape: state.boardShape,
    // ffa only - harmless/unused on the receiving end for every other mode.
    playerCount: state.playerCount,
    hands: state.hands,
    scores: state.scores,
    ffaEliminatedSeats: state.ffaEliminatedSeats ? [...state.ffaEliminatedSeats] : null,
    ffaRanks: state.ffaRanks,
  };
}

function applyFullState(msg) {
  state.gameStarted = true;
  // Must be restored BEFORE state.board, since a custom shape's board is a
  // different size (BOARD_SIZE/CELL_PX/canvas/voidMask) than whatever this
  // tab happened to have lying around locally - e.g. a fresh page reload
  // defaults back to a normal 12x12 board until this runs, which would
  // otherwise misalign every idx()/voidMask lookup against the resynced
  // (possibly 14x14 custom-shape) board contents.
  if (state.gameMode === 'ffa') {
    // FFA always forces a fixed 20x20 square board (never a custom shape,
    // and BOARD_SIZE/CELL_PX sizing here mirrors beginFfaGame() rather than
    // applyBoardShapeSizing(), which only knows the 12/14 sizes the other
    // modes use).
    BOARD_SIZE = 20;
    CELL_PX = TARGET_BOARD_PX / BOARD_SIZE;
    canvas.width = BOARD_SIZE * CELL_PX;
    canvas.height = BOARD_SIZE * CELL_PX;
    state.boardShape = 'square';
    state.voidMask = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  } else {
    state.boardShape = msg.boardShape || 'square';
    state.voidMask = applyBoardShapeSizing(state.boardShape);
  }
  state.board = Int8Array.from(msg.board);
  state.playerCount = msg.playerCount || 2;
  if (state.gameMode === 'ffa') {
    state.hands = msg.hands;
    state.scores = msg.scores;
    state.ffaEliminatedSeats = new Set(msg.ffaEliminatedSeats || []);
    state.ffaRanks = msg.ffaRanks || null;
  } else {
    state.hand1 = msg.hand1;
    state.hand2 = msg.hand2;
    state.score1 = msg.score1;
    state.score2 = msg.score2;
  }
  state.turn = msg.turn;
  state.plyCount = msg.plyCount;
  state.passStreak = msg.passStreak;
  state.gameOver = msg.gameOver;
  state.moveLog = msg.moveLog;
  state.initialHand = msg.initialHand;
  state.lastMove = msg.lastMove;
  state.gameStartedAt = msg.gameStartedAt;
  state.gameSequence = msg.gameSequence;
  state.hostIsPlayerOneBase = msg.hostIsPlayerOneBase;
  // state.myPlayer isn't part of this payload (it depends on Net.isHost,
  // which is the one thing that legitimately differs between the two
  // peers) - recomputed locally instead, now that gameSequence and
  // hostIsPlayerOneBase have just been caught up to the sender's. FFA has
  // no such ambiguity - a seat's player number never changes for the life
  // of a match (no rematches, no coin-flip) - so it's left exactly as
  // ffaSeat + 1 already set it.
  if (state.online && state.gameMode !== 'ffa') state.myPlayer = computeMyPlayerForCurrentGame();
  state.privateTimerSeconds = msg.privateTimerSeconds ?? null;
  state.scoringCells = msg.scoringCells;
  state.selected = null;
  state.hover = null;
  state.mouseRC = null;
  state.lastTapCell = null;
  state.history = []; // undo history doesn't survive a reconnect
  state.pendingUndoRequest = false;
  state.incomingUndoRequest = false;

  // Restore the SENDER's actual in-progress turn deadline rather than
  // leaving it to handleTurnTransition() to compute a fresh one - that path
  // treats any turn it hasn't seen before as brand new and hands out a full
  // fresh timer, which is exactly wrong right after a reconnect (the turn
  // may already be, say, 45 seconds into a 60-second clock). Marking this
  // turn as already-observed here (matching handleTurnTransition()'s own
  // key) suppresses that reset; resumeTurnTimerTicking() then just starts
  // the countdown ticking against the restored deadline instead.
  state.turnDeadline = msg.turnDeadline ?? null;
  lastObservedTurnKey = `${state.turn}-${state.plyCount}-${state.gameOver}`;
  // Same idea as the turnDeadline restore above, for turn-DURATION tracking
  // (turnStartedAtMs) instead of the countdown display: derive how long
  // this turn has already been running from the sender's authoritative
  // deadline, rather than either "now" (would understate it) or whatever
  // stale value survived a page reload (meaningless once a reload actually
  // happened). Only possible when a timer is active - an untimed game has
  // no such reference to derive from, so it falls back to
  // handleTurnTransition()'s normal "now" seeding instead.
  if (state.turnDeadline) {
    const limitSec = currentTurnTimeLimitSec();
    if (limitSec) {
      turnStartedAtMs = state.turnDeadline - limitSec * 1000;
      turnStartedAtMsRestoredByResync = true;
    }
  }
  // Also suppresses syncTurnTimerWithConnecting()'s own resume logic (see
  // its comment) - state.connecting is about to be cleared by the 'resync'
  // handler right after this returns, and without this it would try to
  // "resume" on top of the deadline just restored above using a locally-
  // estimated remaining time from whenever the freeze started, clobbering
  // the sender's actually-authoritative one.
  turnTimerPaused = false;
  // Same reasoning - this may be a turn we haven't actually observed a
  // fresh restartTurnTimerIfNeeded() call for yet (handleTurnTransition()
  // would otherwise treat it as already-seen, since lastObservedTurnKey
  // was just set above), so a stale "already warned" from a previous turn
  // shouldn't suppress a real low-time warning on this one.
  lowTimeWarningPlayed = false;
  resumeTurnTimerTicking();
}

function idx(r, c) { return r * BOARD_SIZE + c; }

// Which real player is "player 1" for the CURRENT game - online only.
// hostIsPlayerOneBase is a per-connection coin flip (decided once, by the
// host, when the match is first found); gameSequence's parity alternates
// it fairly from there across rematches (odd games use the base as-is,
// even games flip it) - see hostIsPlayerOneBase's own comment on state
// for why this isn't simply "host is always player 1". Shared by
// newGame(), applyFullState() (after a resync), and handleRejoinReady().
function computeMyPlayerForCurrentGame() {
  const hostIsPlayerOneThisGame = (state.gameSequence % 2 === 1)
    ? state.hostIsPlayerOneBase
    : !state.hostIsPlayerOneBase;
  return Net.isHost
    ? (hostIsPlayerOneThisGame ? 1 : 2)
    : (hostIsPlayerOneThisGame ? 2 : 1);
}

// Whoever didn't move first gets the handicap point - always player 2 except
// in vs Bot games, where the starting player (and so the handicap recipient)
// is randomized.
function handicapPlayer() {
  return state.startingPlayer === 1 ? 2 : 1;
}

// ---------- Player display names ----------
// ffa's "up to 3 other seats" identity (state.ffaPlayers, seat-indexed) is
// looked up first in each of these four - the singular opponentX fields
// below only ever meant anything when there was exactly one opponent.
function playerLabel(playerNum) {
  if (state.gameMode === 'ffa') {
    if (playerNum === state.myPlayer) {
      const profile = Auth.getProfile();
      return profile ? profile.username : `Player ${playerNum}`;
    }
    const info = state.ffaPlayers && state.ffaPlayers[playerNum - 1];
    return (info && info.username) || `Player ${playerNum}`;
  }
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
  if (state.gameMode === 'ffa') {
    if (playerNum === state.myPlayer) {
      const user = Auth.getUser();
      return user ? user.id : null;
    }
    const info = state.ffaPlayers && state.ffaPlayers[playerNum - 1];
    return (info && info.userId) || null;
  }
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
  if (state.gameMode === 'ffa') {
    if (playerNum === state.myPlayer) {
      const profile = Auth.getProfile();
      return profile ? profile.avatar_id : null;
    }
    const info = state.ffaPlayers && state.ffaPlayers[playerNum - 1];
    return (info && info.avatarId) || null;
  }
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
  if (state.gameMode === 'ffa') {
    if (playerNum === state.myPlayer) {
      const profile = Auth.getProfile();
      return profile ? profile.title_id : null;
    }
    const info = state.ffaPlayers && state.ffaPlayers[playerNum - 1];
    return (info && info.titleId) || null;
  }
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
  const companionHtml = companion
    ? `<span class="player-companion" title="${escapeHtml(minoLabel(companion))}${companion.name ? ' - ' + escapeHtml(companion.name) : ''}">${minoVisualHtml(companion, 20)}</span>`
    : '';
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

function newGame(remoteHand, remoteSequence, remoteHostIsPlayerOneBase, localHandOverride) {
  const isRemote = remoteHand !== undefined;

  if (state.connecting && !isRemote) return;

  if (state.online && !Net.isHost && !isRemote) {
    log('Only the host can start a new game - ask them to click Rematch.');
    return;
  }

  // A game actually starting (locally or via the incoming 'newgame')
  // always supersedes any pending private-room settings step.
  state.awaitingRoomStart = false;

  // A rematch of THIS room/match - cancel the previous game's endGame()'s
  // deferred Net.leaveRoom() (see its comment in net.js) so the room and
  // live-game spectator feed survive instead of getting torn down right
  // as this new game starts. Runs on both the host (calling this
  // directly) and the joiner (receiving it via the 'newgame' message) -
  // this is the single choke point both paths funnel through. Harmless
  // no-op for the very first game of a match, where nothing is pending yet.
  if (state.online) Net.cancelPendingLeaveRoom();

  // The host assigns the next sequence number itself; the joiner just
  // adopts whatever the host sent, so both sides always agree.
  state.gameSequence = isRemote ? remoteSequence : state.gameSequence + 1;
  if (isRemote) state.hostIsPlayerOneBase = remoteHostIsPlayerOneBase;

  // Alternates who's "player 1" (goes first, no handicap) each rematch,
  // starting from the random coin flip decided once for this connection
  // (see hostIsPlayerOneBase's comment on state) rather than always
  // "host is player 1" - not meaningful for vsBot (already randomizes who
  // starts via its own coin flip below) or hotseat (no concept of "which
  // human is which player").
  if (state.online) {
    state.myPlayer = computeMyPlayerForCurrentGame();
  }

  state.gameStarted = true;
  // Custom board shapes are a private-room-only setting (see
  // beginGameSetup()/the 'newgame' message) - always normalize back to
  // 'square' for every other mode so a stale value left over from an
  // earlier private game in this tab can never leak into a casual/ranked/
  // hotseat/vsBot game. BOARD_SIZE/CELL_PX are mutable (not const)
  // specifically so a game can size the board differently than the last
  // one - see their declaration comment.
  state.boardShape = state.gameMode === 'private' ? state.boardShape : 'square';
  state.voidMask = applyBoardShapeSizing(state.boardShape);
  state.board = new Int8Array(BOARD_SIZE * BOARD_SIZE);
  const hand = remoteHand || localHandOverride || drawHand();
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
    Net.send({ type: 'newgame', hand, gameSequence: state.gameSequence, hostIsPlayerOneBase: state.hostIsPlayerOneBase, privateTimerSeconds: state.privateTimerSeconds, boardShape: state.boardShape });
    // Registers/resets this match's spectator feed - host-only (mirroring
    // the 'newgame' send above), and re-sent on every rematch since the
    // board and hostPlayerNum (who's coloring is who this game) both reset
    // too. See signaling-server/server.js's liveGames comment.
    Net.sendToServer({ type: 'live-game-start', boardSize: BOARD_SIZE, boardShape: state.boardShape === 'square' ? null : state.boardShape, initialHand: hand, hostPlayerNum: state.myPlayer });
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

  if (!state.online) {
    beginGameSetup();
    return;
  }

  if (state.gameMode === 'private') {
    // newGame() already logs and bails for a non-host, but that would skip
    // straight past the settings panel entirely - check here too so a
    // joiner clicking Rematch gets the same explanation instead of nothing
    // visibly happening.
    if (!Net.isHost) {
      log('Only the host can start a new game - ask them to click Rematch.');
      return;
    }
    beginGameSetup();
    return;
  }

  if (state.pendingNewGameRequest) return;
  state.pendingNewGameRequest = true;
  render();
  setLobbyStatus('Rematch request sent - waiting for your opponent to respond...');
  Net.send({ type: 'newgame-request' });
}

function respondToNewGameRequest(accept) {
  state.incomingNewGameRequest = false;
  Net.send({ type: 'newgame-response', accepted: accept });
  if (accept) {
    if (Net.isHost) {
      newGame();
    } else {
      setLobbyStatus('Waiting for the host to start the rematch...');
    }
  } else {
    log('You declined the rematch request.');
  }
  render();
}

// ---------- Placement validity ----------
function isValidPlacement(shapeName, orientationIndex, r0, c0, board) {
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  for (const [dr, dc] of orientation) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return false;
    const cellIdx = idx(r, c);
    if (state.voidMask[cellIdx] || board[cellIdx] !== 0) return false;
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
            const cellIdx = idx(r0 + dr, c0 + dc);
            if (state.voidMask[cellIdx] || board[cellIdx] !== 0) { ok = false; break; }
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
            const cellIdx = idx(r0 + dr, c0 + dc);
            if (state.voidMask[cellIdx] || board[cellIdx] !== 0) { ok = false; break; }
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
// score3/score4 are always computed (cheap - the flood-fill/borderOwners
// core was already owner-count-agnostic) but only ever non-zero in ffa
// mode - every existing 2-player caller destructures just
// {score1, score2, undecided, scoringCells} and silently ignores them, so
// this needed no branching at all to generalize past 2 owners.
function computeFinalScores(board) {
  const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  let score1 = 0, score2 = 0, score3 = 0, score4 = 0, undecided = 0;
  const scoringCells = []; // { index, owner } for every cell that counted toward a score
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0 && !visited[i] && !state.voidMask[i]) {
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
          // A void cell behaves exactly like being off the edge of the
          // board - skipped entirely, never added as a border owner, so a
          // region hugging a void boundary can still be fully enclosed by
          // just one color (same treatment the array bounds already get).
          if (state.voidMask[nidx]) continue;
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
        for (const cellIdx of regionCells) scoringCells.push({ index: cellIdx, owner });
      } else {
        undecided += regionCells.length;
      }
    }
  }
  return { score1, score2, score3, score4, undecided, scoringCells };
}

// ---------- Turn / pass / end-game logic ----------
// Player numbers stay 1-indexed (board values, state.turn) for every mode,
// ffa included - handFor()/scoreFor() below index into state.hands/scores
// at [player - 1].
function handFor(player) {
  // Defensive fallback for the brief window between handleFfaReady() (which
  // already sets state.gameMode/playerCount so an incoming 'identify' can
  // legitimately trigger a render() before state.hands has anything real
  // in it yet) and beginFfaGame()/the 'ffa-start' message actually dealing
  // real hands.
  if (state.gameMode === 'ffa') return (state.hands && state.hands[player - 1]) || [];
  return player === 1 ? state.hand1 : state.hand2;
}
function scoreFor(player) {
  if (state.gameMode === 'ffa') return (state.scores && state.scores[player - 1]) || 0;
  return player === 1 ? state.score1 : state.score2;
}
function setScoreFor(player, value) {
  if (state.gameMode === 'ffa') { state.scores[player - 1] = value; return; }
  if (player === 1) state.score1 = value; else state.score2 = value;
}

// Routes a real-time gameplay message (move/pass/chat/resync/forfeit) over
// whichever transport this mode actually uses - NetFfa's host-relay star
// for ffa, Net's plain 1:1 data channel for everything else. Message
// TYPE strings are shared as-is between the two (never ambiguous - they
// travel over entirely separate channels), so no translation is needed
// here, unlike netSendToServer() below.
function netSend(obj) {
  if (state.gameMode === 'ffa') NetFfa.send(obj); else Net.send(obj);
}

// The signaling server itself hosts BOTH the 2-player live-game-* handlers
// and their ffa- prefixed equivalents (see server.js) - unlike netSend()'s
// data channel, this one physical process needs the type strings
// disambiguated, so ffa mode gets a small rename here rather than the
// server having to guess which protocol a bare 'live-game-move' belongs to.
const FFA_SERVER_MESSAGE_TYPES = {
  'live-game-start': 'ffa-live-game-start',
  'live-game-move': 'ffa-live-game-move',
  'live-player-info': 'ffa-live-player-info',
};
function netSendToServer(obj) {
  if (state.gameMode === 'ffa') {
    NetFfa.sendToServer({ ...obj, type: FFA_SERVER_MESSAGE_TYPES[obj.type] || obj.type });
  } else {
    Net.sendToServer(obj);
  }
}

// How many seats are still actually playing - equal to state.playerCount
// everywhere except ffa once a seat's own reconnect grace has expired and
// it's been permanently eliminated (the others play on without it).
function activePlayerCount() {
  if (state.gameMode === 'ffa' && state.ffaEliminatedSeats) return state.playerCount - state.ffaEliminatedSeats.size;
  return state.playerCount;
}

// `(turn % playerCount) + 1` is provably identical to the old hardcoded
// `turn === 1 ? 2 : 1` when playerCount is 2 (1 -> (1%2)+1=2, 2 -> (2%2)+1=1)
// - every non-ffa mode is unaffected by this generalization. The extra
// do-while skip-eliminated-seats loop is a no-op whenever
// ffaEliminatedSeats is empty/null, which is always true outside ffa.
function switchTurn() {
  let next = state.turn;
  do {
    next = (next % state.playerCount) + 1;
  } while (state.gameMode === 'ffa' && state.ffaEliminatedSeats && state.ffaEliminatedSeats.has(next - 1) && next !== state.turn);
  state.turn = next;
  state.plyCount += 1;
}

// Voluntary passing is only allowed once every OTHER (still-active) seat's
// hand is already empty (none of them can ever place again) OR it's your
// own last piece (you can never place again either, after this) -
// otherwise you could hoard passes on your early turns to play with more
// board information than everyone else had. Every seat is dealt the same
// number of pieces, so "my hand has exactly 1 left" is the precise,
// symmetric equivalent of "every other active seat's hand is already
// empty" - previously (2-player only) this checked a single opponent;
// generalizes directly to "all of them" for ffa.
function canVoluntarilyPass() {
  const myHand = handFor(state.turn);
  if (state.gameMode === 'ffa') {
    const others = [1, 2, 3, 4].filter((p) => p !== state.turn && !state.ffaEliminatedSeats.has(p - 1));
    return others.every((p) => state.hands[p - 1].length === 0) || myHand.length === 1;
  }
  const oppHand = state.turn === 1 ? state.hand2 : state.hand1;
  return oppHand.length === 0 || myHand.length === 1;
}

// Auto-passes the current turn holder for as long as they have no legal
// move at all (empty hand, or nothing fits) - ending the game once every
// currently-active seat has forced/voluntarily passed in a row (2 for the
// normal 2-player case, fewer once ffa seats have been eliminated).
function checkGameEnd() {
  if (state.gameOver) return;
  while (!state.gameOver) {
    const hand = handFor(state.turn);
    if (hasAnyLegalMove(hand, state.board)) return;

    const player = state.turn;
    log(`${playerLabel(player)} has no legal move and passes.`);
    state.passStreak += 1;
    switchTurn();

    if (state.passStreak >= activePlayerCount()) {
      endGame(state.gameMode === 'ffa' ? 'Everyone remaining passed in a row.' : 'Both players passed in a row.');
      return;
    }
  }
}

// A new move or pass supersedes any undo-request still sitting unanswered
// from before it - the top of state.history is about to change out from
// under it, so accepting it now would undo the WRONG thing (whatever just
// landed, not whatever the original request was actually about). Called
// from both commitPlacement() and manualPass(), on both the local and the
// remote-applied side (they both run this same code), so a stale request
// silently disappears for both players - this is what stops later
// accepting an old request from undoing your own just-played move by
// accident, instead of leaving an "accept" banner sitting there forever.
function expireStaleUndoRequest() {
  if (!state.pendingUndoRequest && !state.incomingUndoRequest) return;
  state.pendingUndoRequest = false;
  state.incomingUndoRequest = false;
  log('An outstanding undo request expired since a new move was made.');
}

function manualPass(fromRemote = false) {
  if (state.gameOver) return;
  if (state.online && !fromRemote && state.myPlayer !== state.turn) return;

  expireStaleUndoRequest();
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
    netSend({ type: 'pass', seq: state.plyCount });
  }

  if (state.passStreak >= activePlayerCount()) {
    endGame(state.gameMode === 'ffa' ? 'Everyone remaining passed in a row.' : 'Both players passed in a row.');
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
  if (!canVoluntarilyPass()) return;
  manualPass(false);
}

function commitPlacement(shapeName, orientationIndex, r0, c0, fromRemote = false, t = Date.now(), autoTimeout = false, durationMs = null) {
  if (state.online && !fromRemote && state.myPlayer !== state.turn) return;

  expireStaleUndoRequest();
  state.history.push(snapshotState());

  // Measured on THIS device's own clock only when this device is the one
  // actually committing the move live (see turnStartedAtMs's own comment
  // for why a remote move's transmitted durationMs is used as-is instead
  // of ever being recomputed here against our own turnStartedAtMs, which
  // is tracking OUR turn, not necessarily one that just arrived from afar).
  const finalDurationMs = fromRemote ? durationMs : Math.max(0, Date.now() - turnStartedAtMs);

  const player = state.turn;
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  for (const [dr, dc] of orientation) {
    state.board[idx(r0 + dr, c0 + dc)] = player;
  }
  const hand = handFor(player);
  hand.splice(hand.indexOf(shapeName), 1);
  // autoTimeout travels with the move itself (moveLog + the network
  // message below) rather than as a separate synced counter - it's what
  // countMyAutoPlacementsThisGame() derives "have I already used this
  // game's one auto-place leniency" from, so a reconnect/resync (which
  // already restores the full moveLog) can't accidentally forget it.
  state.moveLog.push({ player, shapeName, orientationIndex, r0, c0, t, autoTimeout, durationMs: finalDurationMs });
  state.lastMove = { shapeName, orientationIndex, r0, c0, player };
  state.passStreak = 0;
  if (autoTimeout) {
    log(`${playerLabel(player)} ran out of time - a piece was placed for them automatically. ${hand.length} piece(s) left.`);
  } else {
    log(`${playerLabel(player)} placed ${shapeName}-pentomino. ${hand.length} piece(s) left.`);
  }

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

  // Sent here, BEFORE checkGameEnd() below - not after, even though that
  // reads slightly out of order with "commit locally, then check for game
  // end, then notify network." If this placement ends the game,
  // checkGameEnd() calls endGame() -> Net.leaveRoom(), which tells the
  // signaling server to tear down this room (including the live-game
  // spectator registry) - though only after a grace period now (see
  // leaveRoom()'s comment in net.js), so this ordering isn't the load-
  // bearing fix it used to be. Kept anyway: the P2P move send is
  // unaffected by the ordering either way (dc and the signaling ws are
  // separate channels), and sending live-game-move for the final move
  // before anything that could ever tear the room down keeps this
  // provably correct rather than "correct because the grace period is
  // long enough."
  if (state.online && !fromRemote) {
    netSend({ type: 'move', shapeName, orientationIndex, r0, c0, t, seq, autoTimeout, durationMs: finalDurationMs });
    netSendToServer({ type: 'live-game-move', player, shapeName, orientationIndex, r0, c0, t });
  }

  checkGameEnd();
  render();

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

  // If the bot went first this game and this undo was for its very first
  // move, there's no earlier human turn to fall back to - the snapshot
  // above just restored the game's actual starting state (bot's turn),
  // and the check right before this one is a no-op since there's nothing
  // left in history to pop. scheduleBotMove() is normally only ever
  // triggered right after a move/pass commits, so without this the game
  // would otherwise sit frozen on the bot's turn forever.
  if (state.vsBot && !state.gameOver && state.turn === 2) {
    scheduleBotMove();
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

// FFA never ends the whole match just because one seat gives up or times
// out (unlike the 2-player forfeit, which always ends the game outright) -
// the seat is permanently removed from turn rotation (see switchTurn()'s
// own skip-eliminated-seats loop) and the other still-active seats keep
// playing normally. Whatever that seat had already placed stays on the
// board and is scored exactly as normal at the end (scoring is board-
// state-driven, not turn-driven), so eliminating them costs their future
// turns, not their already-claimed territory. Apply-only (no network I/O
// of its own) - every call site is responsible for broadcasting an
// 'ffa-eliminate' itself exactly once, whether that's a self-declared
// voluntary forfeit/self-timeout or the host's authoritative declaration
// of someone ELSE'S timeout (see tickTurnTimer()'s ffa branch).
function eliminateFfaSeat(seat, reason) {
  if (state.gameOver || !state.ffaEliminatedSeats || state.ffaEliminatedSeats.has(seat)) return;
  state.ffaEliminatedSeats.add(seat);
  const player = seat + 1;
  log(reason === 'forfeit'
    ? `${playerLabel(player)} forfeited. The remaining players continue.`
    : `${playerLabel(player)} ran out of time and was eliminated. The remaining players continue.`);
  if (state.turn === player) switchTurn();
  if (activePlayerCount() <= 1) {
    endGame('Only one player remains.');
    return;
  }
  checkGameEnd();
  render();
}

function forfeitGame() {
  if (!state.gameStarted || state.gameOver || state.connecting) return;
  if (!window.confirm('Are you sure you want to forfeit this game?')) return;

  const forfeitingPlayer = state.online ? state.myPlayer : (state.vsBot ? 1 : state.turn);

  if (state.gameMode === 'ffa') {
    eliminateFfaSeat(forfeitingPlayer - 1, 'forfeit');
    netSend({ type: 'ffa-eliminate', seat: forfeitingPlayer - 1, reason: 'forfeit' });
    return;
  }

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
  clearTimeout(timeoutConfirmTimer);
  timeoutConfirmTimer = null;
  clearInterval(timeoutConfirmRetryTimer);
  timeoutConfirmRetryTimer = null;
  if (state.online) {
    if (state.gameMode === 'ffa') NetFfa.leaveRoom(); else Net.leaveRoom();
    clearActiveMatch();
  }

  if (state.gameMode === 'ffa') {
    endFfaGame(reason);
    return;
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
  log(`Game over. ${reason} Final score - ${scoreLine}. ${result}`);
  recordGameResult(winner, state.forfeit);
  render();
}

async function recordGameResult(winner, forfeit) {
  let row = null;
  if (state.vsBot) {
    // Recorded either way, logged in or not - a guest's practice game
    // against the bot is still a real game of Minogoe, and schema.sql's
    // insert policy allows a fully-anonymous mode='bot' row through
    // specifically for this (recent.js/profile.js/replay.js already all
    // render a null player1_id as "Guest").
    const me = Auth.getUser();
    row = {
      mode: 'bot',
      player1_id: me ? me.id : null,
      player2_id: null,
      score1: state.score1,
      score2: state.score2,
      winner,
      forfeit,
      initial_hand: state.initialHand,
      move_log: state.moveLog,
      board_size: BOARD_SIZE,
      board_shape: state.boardShape === 'square' ? null : state.boardShape,
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
      board_shape: state.boardShape === 'square' ? null : state.boardShape,
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

  // Casual/ranked games can grant a random seed pack server-side
  // (schema.sql Phase 22, via the on_human_game_played trigger), but
  // Auth.getProfile()'s cached copy is otherwise never refetched mid-
  // session - without this, mino-notify.js's toasts would only ever
  // appear on the NEXT full page load, not right after the game that
  // actually earned them. checkForNewPacks()/checkForNewGifts() are
  // defined in mino-notify.js; guarded since not every page that loads
  // game.js also loads that one.
  await Auth.refreshProfile();
  if (typeof checkForNewPacks === 'function') checkForNewPacks();
  if (typeof checkForNewGifts === 'function') checkForNewGifts();

  if (row.mode === 'ranked') {
    // The elo_delta_p1/p2 columns are populated by a separate AFTER INSERT
    // trigger (a follow-up UPDATE), so they won't be present on the row we
    // just inserted - a fresh select is needed to see the trigger's result.
    const { data: eloRow, error: eloError } = await supabaseClient
      .from('games')
      .select('elo_delta_p1, elo_delta_p2, elo_halved')
      .eq('id', data.id)
      .single();
    if (!eloError && eloRow && eloRow.elo_delta_p1 != null) {
      if (state.online) {
        Net.send({ type: 'elo-result', delta_p1: eloRow.elo_delta_p1, delta_p2: eloRow.elo_delta_p2, halved: eloRow.elo_halved });
      }
      showEloResult(state.myPlayer === 1 ? eloRow.elo_delta_p1 : eloRow.elo_delta_p2, eloRow.elo_halved);
    }
  }
}

// FFA's winner determination is a ranking, not a binary win/lose/tie - a
// tie for 1st is entirely possible with 4 independent scores, unlike the
// 2-player case's simple > / < / = compare. Standard competition ranking:
// ties share a rank, and the next distinct score skips ahead accordingly
// (1, 1, 3, 4), computed fresh each time rather than incrementally.
function computeFfaRanks(scores) {
  const seats = [0, 1, 2, 3];
  const ranked = [...seats].sort((a, b) => scores[b] - scores[a]);
  const ranks = new Array(4);
  ranked.forEach((seat, i) => {
    ranks[seat] = (i > 0 && scores[seat] === scores[ranked[i - 1]]) ? ranks[ranked[i - 1]] : i + 1;
  });
  return ranks;
}

function endFfaGame(reason) {
  const { score1, score2, score3, score4, undecided, scoringCells } = computeFinalScores(state.board);
  state.scores = [score1, score2, score3, score4];
  state.scoringCells = scoringCells;

  if (state.ffaAbandoned) {
    log(`Game over. ${reason}`);
    recordFfaGameResult(true);
    render();
    return;
  }

  state.ffaRanks = computeFfaRanks(state.scores);
  const standings = [0, 1, 2, 3]
    .sort((a, b) => state.ffaRanks[a] - state.ffaRanks[b])
    .map((seat) => `#${state.ffaRanks[seat]} ${playerLabel(seat + 1)} (${state.scores[seat]})`)
    .join(', ');
  log(`Game over. ${reason} Final standings - ${standings}. (${undecided} undecided)`);
  recordFfaGameResult(false);
  render();
}

// Both sides independently attempting this and letting client_match_id's
// unique constraint reject the duplicates is the exact same dedup pattern
// recordGameResult() already relies on for 2-player games - here all 4
// clients attempt it, and the submit_ffa_result() RPC's own uniqueness
// check (schema.sql Phase 55) makes every call after the first a harmless
// no-op regardless of which of the 4 lands first.
async function recordFfaGameResult(abandoned) {
  if (!state.online) return;
  const matchId = NetFfa.matchId;
  if (!matchId) return;

  const seatsPayload = [0, 1, 2, 3].map((seat) => ({
    seat,
    player_id: (state.ffaPlayers[seat] && state.ffaPlayers[seat].userId) || null,
    score: state.scores[seat],
    rank: abandoned ? null : state.ffaRanks[seat],
  }));
  // Every seat needs a real account id for the RPC's participant check - if
  // an identify never arrived from some seat (e.g. they dropped before
  // ever sending one), skip recording entirely rather than submit a result
  // with a hole in it.
  if (seatsPayload.some((s) => !s.player_id)) return;

  const { error } = await supabaseClient.rpc('submit_ffa_result', {
    p_client_match_id: matchId,
    p_board_size: BOARD_SIZE,
    p_started_at: state.gameStartedAt,
    p_abandoned: abandoned,
    p_seats: seatsPayload,
    p_initial_hand: state.initialHand,
    p_move_log: state.moveLog,
  });
  if (error) {
    if (error.code !== '23505') log('Could not save FFA game result: ' + error.message);
    return;
  }
  log('FFA game result saved to match history.');
  await Auth.refreshProfile();
  if (typeof checkForNewPacks === 'function') checkForNewPacks();
  if (typeof checkForNewGifts === 'function') checkForNewGifts();
}

let eloResultTimer = null;
// halved is true when the server (schema.sql's handle_ranked_game(),
// Phase 30) detected this is the 3rd+ consecutive ranked game between
// exactly these two accounts with the same winner, uninterrupted by either
// player facing anyone else in between - ELO movement is cut in half to
// slow down win-trading, and this banner explains why the number looks
// smaller than expected instead of just silently showing it.
function showEloResult(myDelta, halved) {
  Auth.refreshProfile();
  const banner = document.getElementById('eloResultBanner');
  const sign = myDelta > 0 ? '+' : '';
  banner.innerHTML = halved
    ? `<div>Ranked result: ${sign}${myDelta} ELO (halved)</div><div class="elo-halved-note">You've played this opponent 3+ times in a row with the same result, so ELO movement is halved to discourage win-trading.</div>`
    : `Ranked result: ${sign}${myDelta} ELO`;
  banner.classList.toggle('positive', myDelta > 0);
  banner.classList.toggle('negative', myDelta < 0);
  banner.classList.toggle('halved', !!halved);
  banner.style.display = 'flex';
  clearTimeout(eloResultTimer);
  eloResultTimer = setTimeout(() => { banner.style.display = 'none'; }, halved ? 12000 : 8000);
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

function rotateSelected(reverse = false) {
  if (!state.selected) return;
  const len = ORIENTATIONS[state.selected.shapeName].length;
  state.selected.orientationIndex = reverse
    ? (state.selected.orientationIndex - 1 + len) % len
    : (state.selected.orientationIndex + 1) % len;
  recomputeHover();
  updateSelectionInfo();
  drawBoard();
  refreshDragGhostShape();
}

// Jumps directly to the mirrored counterpart of the CURRENT orientation
// (same rotation, opposite handedness) instead of cycling rotateSelected()
// up to 7 times to reach it by hand. ORIENTATIONS[shapeName] already stores
// every orientation pre-normalized (see mirror()/normalize() above), so the
// mirrored coords can be looked up directly by matching content rather than
// assuming a fixed index offset - piece-specific de-duplication (symmetric
// pieces have fewer than 8 total orientations) means that offset isn't
// reliably +4 for every shape. A no-op for a piece that's symmetric under
// mirroring (mirrored coords equal the current ones), which is correct -
// there's nothing to flip.
function flipSelected() {
  if (!state.selected) return;
  const orientations = ORIENTATIONS[state.selected.shapeName];
  const mirrored = mirror(orientations[state.selected.orientationIndex]);
  const key = JSON.stringify(mirrored);
  const targetIndex = orientations.findIndex((o) => JSON.stringify(o) === key);
  if (targetIndex === -1) return;
  state.selected.orientationIndex = targetIndex;
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

// A sharper double-beep (square wave, not sine/triangle like the calmer
// sounds above) so it reads as urgent - fires once when your own turn
// timer first drops to 10s or under, see tickTurnTimer()'s
// lowTimeWarningPlayed guard below.
function playLowTimeWarning() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    for (const start of [0, 0.15]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.09, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.14);
    }
  } catch {
    // audio unavailable/blocked - not critical, ignore
  }
}

// ---------- Per-turn timer (online casual/ranked only) ----------
let turnTimerInterval = null;
// Reset only on a genuinely new turn (restartTurnTimerIfNeeded) - NOT on a
// syncTurnTimerWithConnecting() pause/resume, so a resync/reconnect that
// happens to land after 10s doesn't cost you (or grant you) an extra warning
// for the same turn.
let lowTimeWarningPlayed = false;

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
      handleSelfTimeout();
    } else if (state.gameMode === 'ffa') {
      // No symmetric "confirm with the peer before declaring it" dance for
      // ffa (see timeoutOpponentForfeit()'s own comment) - the host is
      // already the sole relay/authority for every message in a star
      // topology, so its own local state IS ground truth; it never needs
      // to double-check with anyone. A non-host just waits for the host's
      // authoritative ffa-eliminate broadcast instead of guessing itself.
      if (NetFfa.isHost) {
        const seat = state.turn - 1;
        eliminateFfaSeat(seat, 'timeout');
        netSend({ type: 'ffa-eliminate', seat, reason: 'timeout' });
      }
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
  // Only for the player who actually needs to act - an opponent's low-time
  // warning firing on your own screen would just be noise (matches
  // maybeDingForTurn()'s own "only for my turn" scoping).
  if (secs <= 10 && !lowTimeWarningPlayed && state.turn === state.myPlayer) {
    lowTimeWarningPlayed = true;
    playLowTimeWarning();
  }
}

// Starts (or restarts) the ticking interval against whatever deadline is
// already sitting in state.turnDeadline, without recomputing it - shared by
// restartTurnTimerIfNeeded() (a genuinely new turn, fresh full-length
// deadline) and applyFullState() (a resync, which restores the peer's real
// remaining deadline and just needs the display/timeout-check loop resumed
// against it).
function resumeTurnTimerTicking() {
  if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
  if (!state.turnDeadline || state.gameOver) return;
  turnTimerInterval = setInterval(tickTurnTimer, 250);
  tickTurnTimer();
}

// Tracks a timer paused mid-turn by syncTurnTimerWithConnecting() below -
// turnTimerPaused is a separate flag (not just "is turnTimerRemainingMsWhenPaused
// truthy") since 0ms remaining is a real, valid amount to resume with.
let turnTimerPaused = false;
let turnTimerRemainingMsWhenPaused = 0;

// When the CURRENT device actually commits a move (fromRemote === false in
// commitPlacement), its own turn duration is measured as Date.now() minus
// this - always a single device's own clock for both ends of the
// subtraction, then transmitted to the peer as-is. This is deliberately NOT
// "the other move's timestamp diffed against mine" (which is what moveLog
// entries' own .t field would give you) - .t is each mover's own wall
// clock, and two machines' wall clocks are never assumed to agree, so
// diffing an absolute timestamp from one device against one from another
// silently produces garbage (seconds off in either direction) proportional
// to however out-of-sync their clocks happen to be. This is exactly what
// broke the turn-timing chart in replay.js.
let turnStartedAtMs = Date.now();
// Set while state.connecting is true (see syncTurnTimerWithConnecting()
// below) so a resync/reconnect freeze doesn't get counted as thinking time
// once it clears - tracked independently of turnTimerPaused/limitSec since
// duration tracking matters even for untimed games, unlike the countdown
// display itself.
let turnDurationFreezeStartedAt = null;
// One-shot flag set by applyFullState() when it has already derived
// turnStartedAtMs itself from a restored, already-in-progress turnDeadline -
// tells the very next handleTurnTransition() call not to clobber that with
// a fresh "now", exactly mirroring how it pre-seeds lastObservedTurnKey for
// the same reason.
let turnStartedAtMsRestoredByResync = false;

// Casual/ranked have a fixed per-mode limit; a private room's limit is
// whatever the host picked in the settings overlay for this specific game
// (state.privateTimerSeconds - null/untimed by default, same as hotseat/vsBot).
function currentTurnTimeLimitSec() {
  if (state.gameMode === 'private') return state.privateTimerSeconds || null;
  return TURN_TIME_LIMITS[state.gameMode] || null;
}

function restartTurnTimerIfNeeded() {
  turnTimerPaused = false;
  lowTimeWarningPlayed = false;
  stopTurnTimer();
  if (state.gameOver || !state.online) return;
  const limitSec = currentTurnTimeLimitSec();
  if (!limitSec) return;
  if (state.connecting) {
    // The freeze (resync/reconnect) is already in effect right as this new
    // turn starts - don't count down time the player has no way to act on
    // (see syncTurnTimerWithConnecting()'s comment for why this matters).
    // "Remaining" is the full duration, so this turn starts fresh - not
    // from 0 - once the freeze actually clears.
    turnTimerPaused = true;
    turnTimerRemainingMsWhenPaused = limitSec * 1000;
    return;
  }
  state.turnDeadline = Date.now() + limitSec * 1000;
  resumeTurnTimerTicking();
}

// A resync/reconnect (state.connecting) already correctly freezes the
// hand (renderHand()'s isActive) and, since the earlier fix, the turn
// banner - but the turn timer kept ticking down completely independently
// of it. A player whose hand froze for the entire length of their turn
// still got auto-forfeited by their own timeout the moment it hit 0, even
// though they never had a real chance to act - this is what actually
// happened in a reported ranked match, on the very first move. Called
// from render() every time (idempotent either way - see the two branches
// below), this pauses the deadline the moment a freeze starts and resumes
// it with the same remaining time (not a fresh full duration, and not
// however long the freeze itself lasted) once it clears.
function syncTurnTimerWithConnecting() {
  if (state.gameOver || !state.online) return;

  // Runs regardless of whether a per-turn timer is even active - an
  // untimed game's recorded turn durations shouldn't balloon just because
  // a reconnect happened to freeze the board mid-turn either.
  if (state.connecting) {
    if (turnDurationFreezeStartedAt === null) turnDurationFreezeStartedAt = Date.now();
  } else if (turnDurationFreezeStartedAt !== null) {
    turnStartedAtMs += Date.now() - turnDurationFreezeStartedAt;
    turnDurationFreezeStartedAt = null;
  }

  const limitSec = currentTurnTimeLimitSec();
  if (!limitSec) return;

  if (state.connecting) {
    if (!turnTimerPaused && state.turnDeadline) {
      turnTimerPaused = true;
      turnTimerRemainingMsWhenPaused = Math.max(0, state.turnDeadline - Date.now());
      stopTurnTimer();
    }
  } else if (turnTimerPaused) {
    turnTimerPaused = false;
    state.turnDeadline = Date.now() + turnTimerRemainingMsWhenPaused;
    resumeTurnTimerTicking();
  }
}

// Derived from the moveLog itself (each auto-placed move carries its own
// autoTimeout flag - see commitPlacement()) rather than a separate synced
// counter, so a reconnect/resync - which already restores the full
// moveLog - can't lose track of whether this game's one-time leniency has
// already been used. Only ever checked against MY OWN player number: each
// client decides its own auto-place-vs-forfeit call unilaterally, the same
// way it already decides what to place on a normal turn - the opponent
// never needs to compute this for me, since they can never be the one to
// commit a move on my behalf (see handleSelfTimeout()'s own comment).
function countMyAutoPlacementsThisGame() {
  return state.moveLog.filter((m) => m.player === state.myPlayer && m.autoTimeout).length;
}

// Called only when MY OWN turn timer hits 0 (tickTurnTimer()'s
// state.turn === state.myPlayer branch) - gives one leniency auto-
// placement per game before an actual timeout forfeit, so a single slow
// reconnect doesn't immediately cost the match. Deliberately never
// triggered from the opponent's side (timeoutOpponentForfeit() below is
// unchanged) - only the timed-out player's own client can pick from their
// own hand and commit a move as themselves; having the OPPONENT'S client
// instead guess/commit a placement on their behalf would mean both sides
// could independently compute different "random" choices, a desync risk
// this avoids entirely by keeping the decision (and the random pick)
// strictly local to whoever's clock actually ran out. If their client is
// genuinely gone rather than just slow (backgrounded tab, dropped
// connection), this never runs at all and timeoutOpponentForfeit()'s
// existing confirm-then-forfeit safety net on the OTHER player's side is
// still what ends the game - unchanged, since there's nothing here for it
// to interfere with.
function handleSelfTimeout() {
  if (state.gameOver) return;
  if (countMyAutoPlacementsThisGame() >= 1) {
    timeoutForfeit();
    return;
  }
  const hand = handFor(state.myPlayer);
  const placements = enumerateLegalPlacements(hand, state.board);
  // Shouldn't actually be reachable - checkGameEnd() already auto-passes
  // a hand with zero legal moves before it can ever become "my turn" in
  // the first place - but falling back to a real forfeit rather than
  // silently doing nothing is the only safe option if this invariant is
  // ever wrong.
  if (placements.length === 0) {
    timeoutForfeit();
    return;
  }
  const choice = placements[Math.floor(Math.random() * placements.length)];
  commitPlacement(choice.shapeName, choice.orientationIndex, choice.r0, choice.c0, false, Date.now(), true);
}

function timeoutForfeit() {
  if (state.gameOver) return;
  const forfeitingPlayer = state.myPlayer;
  if (state.gameMode === 'ffa') {
    const seat = forfeitingPlayer - 1;
    eliminateFfaSeat(seat, 'timeout');
    netSend({ type: 'ffa-eliminate', seat, reason: 'timeout' });
    return;
  }
  const winner = forfeitingPlayer === 1 ? 2 : 1;
  if (state.online) Net.send({ type: 'forfeit', forfeitingPlayer });
  endGame(`${playerLabel(forfeitingPlayer)} ran out of time.`, winner);
}

// Fallback for when the timed-out player's own client never reports its
// forfeit (backgrounded/throttled tab, closed laptop, dead connection, etc.) -
// the waiting player's own timer shares the same deadline, so it can declare
// the timeout independently instead of waiting forever on a message that may
// never arrive.
//
// A single dropped 'move' message looks IDENTICAL to a real timeout from
// here - the opponent may have moved perfectly fine on their end, with only
// the message telling us about it lost in transit. Left unchecked, this can
// make both sides' independently-ticking timers expire waiting on each
// other at once, each concluding the other one ran out of time and each
// recording themselves as the winner. Rather than trusting local silence
// alone, confirm directly with the opponent's own client via a fresh resync
// before ending the game - see the 'resync' handler's use of
// timeoutConfirmTimer for how a confirmed still-their-turn vs. an actually-
// already-moved opponent are told apart.
//
// The resync-request itself (and its resync reply) are each just one more
// data-channel message, exactly as droppable as the original 'move' this
// whole mechanism exists to double-check - sending it only once just moves
// the same failure mode one level deeper instead of fixing it. Resending it
// periodically through the grace window (TIMEOUT_CONFIRM_RETRY_MS) means a
// single bad packet can't waste the entire window waiting on a reply that
// was never going to arrive; any resend is a no-op once a real reply lands,
// since the 'resync' handler clears both timers below immediately.
const TIMEOUT_CONFIRM_GRACE_MS = 5000;
const TIMEOUT_CONFIRM_RETRY_MS = 1500;
let timeoutConfirmTimer = null;
let timeoutConfirmRetryTimer = null;
// Snapshotted once, right when suspicion starts - NOT re-derived later
// from state.turn at whatever moment a resync reply happens to arrive.
// The 'resync' handler used to compare state.turn against itself
// (before/after applying that one resync), which quietly broke once the
// auto-timeout-placement feature made it possible for an ordinary 'move'
// message to ALSO legitimately land and advance state.turn while a
// confirm sequence was still in flight: by the time the resync reply
// showed up, state.turn already reflected the far side of that move, so
// "before" and "after" matched trivially and looked exactly like no
// progress had been made at all - forfeiting the player who was actually
// waiting on THEIR OWN turn, not the one who'd timed out. plyCount only
// ever moves forward by exactly one per move/pass, from whichever message
// gets there first, so comparing against this fixed snapshot is immune to
// that ordering.
let timeoutConfirmForfeitingPlayer = null;
let timeoutConfirmPlyCountAtStart = null;

function clearTimeoutConfirm() {
  clearTimeout(timeoutConfirmTimer);
  timeoutConfirmTimer = null;
  clearInterval(timeoutConfirmRetryTimer);
  timeoutConfirmRetryTimer = null;
}

// True if nothing has actually advanced the game since suspicion started -
// checked after possibly applying a resync, so this reflects the fully
// up-to-date plyCount either way.
function timeoutConfirmStillStuck() {
  return state.plyCount === timeoutConfirmPlyCountAtStart;
}

function timeoutOpponentForfeit() {
  if (state.gameOver) return;
  const forfeitingPlayer = state.turn;
  timeoutConfirmForfeitingPlayer = forfeitingPlayer;
  timeoutConfirmPlyCountAtStart = state.plyCount;
  setLobbyStatus("Confirming your opponent's turn timed out...");
  Net.send({ type: 'resync-request' });

  clearTimeoutConfirm();
  timeoutConfirmRetryTimer = setInterval(() => {
    Net.send({ type: 'resync-request' });
  }, TIMEOUT_CONFIRM_RETRY_MS);

  timeoutConfirmTimer = setTimeout(() => {
    clearTimeoutConfirm();
    // No resync ever came back within the grace window, despite several
    // attempts to ask for one - but an ordinary 'move' message (e.g. an
    // auto-placed piece) could still have landed independently in the
    // meantime and require no reply of its own. Only actually a timeout
    // if nothing has moved since we started worrying.
    if (!timeoutConfirmStillStuck()) return;
    finalizeOpponentTimeoutForfeit(forfeitingPlayer);
  }, TIMEOUT_CONFIRM_GRACE_MS);
}

function finalizeOpponentTimeoutForfeit(forfeitingPlayer) {
  if (state.gameOver) return;
  const winner = forfeitingPlayer === 1 ? 2 : 1;
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

  // Baseline for THIS device's own next duration measurement, whether or
  // not it ends up being the one to move next - see turnStartedAtMs's own
  // comment. Skipped once the game has actually ended (nothing left to
  // time), and skipped here for a turn applyFullState() has already
  // restored an in-progress deadline for (it seeds turnStartedAtMs itself
  // in that case, from the authoritative restored deadline rather than
  // "now").
  if (!state.gameOver && !turnStartedAtMsRestoredByResync) {
    turnStartedAtMs = Date.now();
  }
  turnStartedAtMsRestoredByResync = false;

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
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  // Fill and outline only playable cells, in one pass - grid lines
  // naturally hug the actual shape's silhouette instead of sweeping across
  // the whole bounding square. A void cell (see BOARD_SHAPES/
  // state.voidMask) gets an explicit, clearly-darker "cut out" fill rather
  // than being left fully transparent - relying on the page background
  // alone made a thin shape like the X barely readable, since it's close
  // in value to the empty-cell color.
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cellIdx = idx(r, c);
      if (state.voidMask[cellIdx]) {
        ctx.fillStyle = '#0b0a0e';
        ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
        continue;
      }
      const val = state.board[cellIdx];
      ctx.fillStyle = val === 0 ? '#1e1b24' : PLAYER_COLORS[val - 1];
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
      ctx.strokeRect(c * CELL_PX + 0.5, r * CELL_PX + 0.5, CELL_PX - 1, CELL_PX - 1);
    }
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
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || state.voidMask[idx(r, c)]) continue;
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
}

// Swaps between the pre-game lobby (#lobbyView - queues, 48h leaderboard,
// live games, ambient background) and the actual game UI (#gameView, the
// existing .app grid) the moment a game is underway. state.gameStarted
// flips true from two separate places (newGame() for a fresh game,
// applyFullState() for a rejoin/resync) rather than one, so this is called
// unconditionally from render() (already called after both) instead of
// threading a call into each - cheap and idempotent either way.
//
// #queueControls/#rankedPeriodPanel/#liveGamesPanel are single shared
// instances, not duplicated - they're physically relocated between the
// lobby and the in-game collapsed drawer via appendChild(), which just
// re-parents the existing DOM nodes (their own scripts keep polling/wiring
// the same element IDs regardless of which container currently holds them,
// so none of them needed any changes for this). Moving #queueControls in
// particular is what lets a hotseat/vs-bot game stay queued for a
// ranked/casual match in the background (state.queueSearching already ran
// fine independently of any local game - see startQueue()'s comment) without
// losing the Find Match/Cancel/status controls needed to manage that queue.
function updateLobbyGameVisibility() {
  const lobbyView = document.getElementById('lobbyView');
  const gameView = document.getElementById('gameView');
  if (!lobbyView || !gameView) return;

  const showGame = !!state.gameStarted;
  lobbyView.style.display = showGame ? 'none' : '';
  gameView.style.display = showGame ? '' : 'none';
  // Lets mobile CSS reclaim the header/announcement/nav's vertical space
  // while a game is actually in progress - see style.css's mobile board
  // layout. No effect on desktop, which doesn't key off this class.
  document.body.classList.toggle('in-game', showGame);

  const queueControls = document.getElementById('queueControls');
  const rankedPanel = document.getElementById('rankedPeriodPanel');
  const liveGamesPanel = document.getElementById('liveGamesPanel');
  const drawerBody = document.getElementById('inGameQueuesPanel')?.querySelector('.collapsible-body');
  const onlinePanel = document.querySelector('.play-panel[data-panel="online"]');
  const directConnectOption = document.querySelector('.online-option-direct');

  if (showGame && drawerBody && queueControls && rankedPanel && liveGamesPanel) {
    drawerBody.appendChild(queueControls);
    drawerBody.appendChild(rankedPanel);
    drawerBody.appendChild(liveGamesPanel);
  } else if (!showGame && onlinePanel && directConnectOption && queueControls && rankedPanel && liveGamesPanel) {
    const panelRow = document.querySelector('.panel-row');
    onlinePanel.insertBefore(queueControls, directConnectOption);
    if (panelRow) {
      panelRow.appendChild(rankedPanel);
      panelRow.appendChild(liveGamesPanel);
    }
  }
}

function render() {
  updateLobbyGameVisibility();
  renderRoomSettingsPanel();
  drawBoard();

  const banner = document.getElementById('turnBanner');
  if (!state.gameStarted) {
    banner.textContent = 'Choose a mode to start playing';
  } else if (state.gameOver) {
    banner.textContent = 'Game over';
  } else if (state.online && state.connecting) {
    // state.connecting freezes the hand (see renderHand()'s isActive) during
    // a resync/reconnect - the real explanation (setLobbyStatus()'s message,
    // e.g. "resyncing...", "Connection lost - reconnecting...") lands in
    // #onlineStatus, which sits inside the collapsed "Queues & Live Games"
    // drawer during an active game and is easy to never see. Without this,
    // the always-visible turn banner kept confidently saying "X's turn
    // (your turn)" the entire time the board was actually frozen, with
    // nothing visible explaining why the (correctly) grayed-out hand
    // wouldn't respond to clicks.
    const status = document.getElementById('onlineStatus')?.textContent;
    banner.textContent = status && status.trim() ? status : 'Reconnecting...';
  } else if (state.online) {
    // ffa has up to 3 possible "opponents," not one, so playerLabel()'s own
    // name (already seat-specific) says enough on its own without the
    // generic "(opponent's turn)" suffix.
    const you = state.myPlayer === state.turn
      ? ' (your turn)'
      : (state.gameMode === 'ffa' ? '' : " (opponent's turn)");
    banner.textContent = `${playerLabel(state.turn)}'s turn${you}`;
  } else {
    banner.textContent = `${playerLabel(state.turn)}'s turn`;
  }

  const isFfaMode = state.playerCount === 4;
  document.getElementById('scoreBlock3').classList.toggle('ffa-only', !isFfaMode);
  document.getElementById('scoreBlock4').classList.toggle('ffa-only', !isFfaMode);
  document.getElementById('handBlock3').classList.toggle('ffa-only', !isFfaMode);
  document.getElementById('handBlock4').classList.toggle('ffa-only', !isFfaMode);

  for (let p = 1; p <= state.playerCount; p++) {
    document.getElementById(`scoreLabel${p}`).innerHTML = playerBadgeHtml(p);
    const scoreEl = document.getElementById(`score${p}`);
    scoreEl.textContent = (state.gameOver && state.forfeit)
      ? (state.winner === p ? 'W' : 'FF')
      : scoreFor(p);
    document.getElementById(`handLabel${p}`).innerHTML = `${playerLink(playerProfileId(p), playerLabel(p))}'s hand`;
    renderHand(`hand${p}`, handFor(p), p);
  }

  if (state.gameStarted) {
    const proj = computeFinalScores(state.board);
    if (state.gameMode === 'ffa') {
      const chips = [1, 2, 3, 4]
        .map((p) => `<span class="projected-value projected-p${p}">${playerLabel(p)} ${proj[`score${p}`]}</span>`)
        .join('');
      document.getElementById('projected').innerHTML = `
        <span class="projected-label">Projected</span>
        ${chips}
        <span class="projected-undecided">${proj.undecided} undecided</span>
      `;
    } else {
      const proj1 = proj.score1 + (handicapPlayer() === 1 ? HANDICAP_POINTS : 0);
      const proj2 = proj.score2 + (handicapPlayer() === 2 ? HANDICAP_POINTS : 0);
      // Same information as before (if the game ended right now: P1's score,
      // P2's score, and how much of the board is still undecided), just laid
      // out as compact labeled chips instead of one dense sentence - still
      // sized/muted well below the real scoreboard above it, just easier to
      // actually scan at a glance mid-game.
      document.getElementById('projected').innerHTML = `
        <span class="projected-label">Projected</span>
        <span class="projected-value projected-p1">${playerLabel(1)} ${proj1}</span>
        <span class="projected-value projected-p2">${playerLabel(2)} ${proj2}</span>
        <span class="projected-undecided">${proj.undecided} undecided</span>
      `;
    }
  } else {
    document.getElementById('projected').textContent = 'No game in progress yet.';
  }

  updateSelectionInfo();

  canvas.classList.toggle('placing', !!state.selected && !state.gameOver);

  document.getElementById('rotateBtn').disabled = state.connecting || !state.gameStarted;
  document.getElementById('newGameBtn').disabled = state.connecting || !state.gameStarted || !state.gameOver || state.pendingNewGameRequest || state.awaitingRoomStart;
  document.getElementById('undoBtn').disabled = state.connecting || !state.gameStarted || state.gameOver
    || state.history.length === 0 || state.pendingUndoRequest;
  const tooEarlyToPass = state.gameStarted && !state.gameOver && !canVoluntarilyPass();
  document.getElementById('passBtn').disabled = state.connecting || !state.gameStarted || state.gameOver
    || (state.online && state.myPlayer !== state.turn)
    || (state.vsBot && state.turn === 2)
    || tooEarlyToPass;
  document.getElementById('passBtn').title = tooEarlyToPass
    ? 'Pass unlocks on your last piece, or once your opponent has none left'
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
  document.getElementById('ffaQueueBtn').disabled = state.online || state.connecting || state.queueSearching;
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
  syncTurnTimerWithConnecting();
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
    el.textContent = `Placing ${state.selected.shapeName}-pentomino (orientation ${state.selected.orientationIndex + 1}/${len}). Click the board to place, or press Q/E / scroll to rotate.`;
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

// Lets the mobile rotate button (or the Q/E keys/scroll-wheel, on the off
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
  netSend({ type: 'chat', text });
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

// Scroll up rotates clockwise/"right" (the default no-arg rotateSelected()),
// scroll down rotates counter-clockwise/"left" (rotateSelected(true)) - see
// rotate90()'s own comment for why the default direction is clockwise.
canvas.addEventListener('wheel', (e) => {
  if (!state.selected) return;
  e.preventDefault();
  rotateSelected(e.deltaY > 0);
}, { passive: false });

// ---------- Controls ----------
// Wrapped in arrow functions rather than passed directly - addEventListener
// calls a handler with the click Event as its first argument, which would
// otherwise land in rotateSelected()'s new `reverse` parameter (a truthy
// object), silently reversing every click.
document.getElementById('rotateBtn').addEventListener('click', () => rotateSelected());
document.getElementById('mobileRotateBtn').addEventListener('click', () => rotateSelected());
document.getElementById('mobileRotateCcwBtn').addEventListener('click', () => rotateSelected(true));
document.getElementById('undoBtn').addEventListener('click', () => requestUndo());
document.getElementById('passBtn').addEventListener('click', () => requestPass());
document.getElementById('forfeitBtn').addEventListener('click', () => forfeitGame());

document.getElementById('undoAcceptBtn').addEventListener('click', () => respondToUndoRequest(true));
document.getElementById('undoDeclineBtn').addEventListener('click', () => respondToUndoRequest(false));

document.getElementById('newGameAcceptBtn').addEventListener('click', () => respondToNewGameRequest(true));
document.getElementById('newGameDeclineBtn').addEventListener('click', () => respondToNewGameRequest(false));

// Clicking the "How to Play" header collapses/expands the whole rules panel.
document.querySelector('.rules-panel h3')?.addEventListener('click', () => {
  document.querySelector('.rules-panel').classList.toggle('collapsed');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') {
    rotateSelected(true); // counter-clockwise/"left"
  } else if (e.key === 'e' || e.key === 'E') {
    rotateSelected(); // clockwise/"right"
  } else if (e.key === 'f' || e.key === 'F') {
    flipSelected();
  }
});

document.getElementById('newGameBtn').addEventListener('click', () => {
  requestNewGame();
});

document.getElementById('hotseatBtn').addEventListener('click', () => {
  if (state.online) return;
  state.vsBot = false;
  beginGameSetup();
});

document.getElementById('vsBotBtn').addEventListener('click', () => {
  if (state.online) return;
  state.vsBot = true;
  beginGameSetup();
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
  netSend({ type: 'resync-request' });

  clearTimeout(resyncRequestTimeoutId);
  resyncRequestTimeoutId = setTimeout(() => {
    if (!state.connecting) return; // already resolved
    // This attempt failed - reset connecting so the next recovery phase's
    // own guard doesn't just bounce off it still being true.
    state.connecting = false;
    // handleConnectionStale() is 2-player-only (checks Net.matchId/
    // Net.rejoin, neither of which ffa uses) and would otherwise silently
    // no-op here, leaving an ffa game frozen on "resyncing..." forever
    // with no further recovery attempt at all.
    if (state.gameMode === 'ffa') attemptFfaRejoin();
    else handleConnectionStale();
  }, RESYNC_REQUEST_TIMEOUT_MS);
}

function saveActiveMatch() {
  if (state.gameMode !== 'casual' && state.gameMode !== 'ranked') return;
  const user = Auth.getUser();
  if (!user || !Net.matchId) return;
  // tabId lets tryResumeActiveMatch() recognize whether a saved record is
  // THIS tab's own match (safe to silently reconnect to) or some other
  // tab's - see its comment for why that distinction matters.
  localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify({ matchId: Net.matchId, userId: user.id, tabId: Net.tabId }));
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
    setLobbyStatus(`Opponent disconnected. Waiting up to ${remainingSec}s for them to reconnect...`);
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
  // A provisional value for whichever side just reloaded (its in-memory
  // gameSequence/hostIsPlayerOneBase are back to defaults until the
  // resync below catches them up, which recomputes this correctly) - for
  // the side that DIDN'T reload, its own gameSequence/hostIsPlayerOneBase
  // are still accurate from before the disconnect, so this already lands
  // on the right, possibly-swapped-from-game-1 answer instead of
  // clobbering it back to a naive "host is always player 1".
  state.myPlayer = computeMyPlayerForCurrentGame();
  document.getElementById('createRoomBtn').disabled = true;
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
  Net.sendToServer({
    type: 'live-player-info',
    username: myProfile ? myProfile.username : null,
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
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
      document.getElementById('createRoomBtn').disabled = false;
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

// Called both automatically (once auth resolves after page load, on a
// bfcache restore, and on each retry below) and manually (the "Rejoin"
// button) - a manual fallback matters because the automatic path depends
// on Auth's auth-state-change firing correctly, and there's no reason to
// strand someone mid-match if that ever hiccups.
//
// ACTIVE_MATCH_KEY lives in localStorage, which every tab of the site
// shares - so without the isManual/tabId check below, leaving an old tab
// open and later starting a fresh casual/ranked match in a DIFFERENT tab
// would make the OLD tab's own next auth-change event silently try to
// "resume" the NEW tab's live match instead. The server would honor that
// (same logged-in user, valid token) and evict the actually-playing tab's
// connection to hand the room to the stale one - exactly the "queued into
// ranked and ended up in an old match, board already finished, scoreboard
// garbled" bug this fixes. Net.tabId (net.js) is stable across a reload of
// THIS SAME tab but unique to every other tab, so comparing it against
// whatever tabId was saved with the record tells "my own tab reconnecting"
// apart from "some other tab's match." The automatic paths never bypass
// this; only an explicit Rejoin-button click (isManual) does, since the
// user might legitimately be doing this from a brand new tab because the
// original one is actually gone - the server's own tabId+liveness check
// (see server.js's 'rejoin' handler) is what makes that safe rather than
// this client-side check alone.
function tryResumeActiveMatch(retriesLeft = 10, isManual = false) {
  updateResumeMatchBanner();
  if (state.online || state.connecting) return; // already mid-match - nothing to resume
  const raw = localStorage.getItem(ACTIVE_MATCH_KEY);
  if (!raw) return;
  let record;
  try { record = JSON.parse(raw); } catch { clearActiveMatch(); return; }
  if (!record || !record.matchId || !record.userId) { clearActiveMatch(); return; }
  if (!isManual && record.tabId && record.tabId !== Net.tabId) return;

  const accessToken = Auth.getAccessToken();
  if (!accessToken) {
    // Auth may not have finished resolving yet on a fresh page load - retry
    // for a few seconds rather than silently giving up forever.
    if (retriesLeft > 0) setTimeout(() => tryResumeActiveMatch(retriesLeft - 1, isManual), 500);
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
  // Coin flip for who's player 1 in the FIRST game of this match - only
  // the host's value ends up used (sent to the joiner in newGame()'s
  // 'newgame' message once it's called below), but harmless to set on
  // both sides since it's about to be overwritten either way.
  state.hostIsPlayerOneBase = Math.random() < 0.5;
  state.pendingUndoRequest = false;
  state.incomingUndoRequest = false;
  document.getElementById('createRoomBtn').disabled = true;
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
  Net.sendToServer({
    type: 'live-player-info',
    username: myProfile ? myProfile.username : null,
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
  });

  if (state.gameMode === 'private' && Net.isHost) {
    beginGameSetup();
  } else if (Net.isHost) {
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
function handleNetData(msg, fromSeat) {
  try {
    handleNetDataInner(msg, fromSeat);
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

function handleNetDataInner(msg, fromSeat) {
  if (msg.type === 'ffa-start') {
    beginFfaGame(msg.hand);
  } else if (msg.type === 'ffa-eliminate') {
    eliminateFfaSeat(msg.seat, msg.reason);
  } else if (msg.type === 'newgame') {
    state.privateTimerSeconds = msg.privateTimerSeconds ?? null;
    state.boardShape = msg.boardShape || 'square';
    newGame(msg.hand, msg.gameSequence, msg.hostIsPlayerOneBase);
  } else if (msg.type === 'room-settings') {
    // Host-authoritative mirror - see beginGameSetup()'s comment.
    // Sent both to kick off the settings step and on every change the host
    // makes while it's open, so this is just "adopt whatever they sent."
    state.awaitingRoomStart = true;
    state.roomSettings = msg.settings;
    state.roomHandCounts = msg.handCounts;
    render();
  } else if (msg.type === 'move') {
    if (!isExpectedNextAction(msg.seq)) { requestResync(); return; }
    commitPlacement(msg.shapeName, msg.orientationIndex, msg.r0, msg.c0, true, msg.t, !!msg.autoTimeout, msg.durationMs);
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
    if (state.gameMode === 'ffa') {
      // Seat-indexed identity array, not the singular opponentX fields -
      // ffa has up to 3 "opponents" from any one seat's perspective, so
      // there's no single slot for those fields to mean anything.
      state.ffaPlayers[fromSeat] = {
        userId: msg.userId ?? null,
        username: msg.username ?? null,
        avatarId: msg.avatarId ?? null,
        titleId: msg.titleId ?? null,
      };
      render();
    } else {
      state.opponentUserId = msg.userId;
      state.opponentUsername = msg.username;
      state.opponentAvatarId = msg.avatarId ?? null;
      state.opponentTitleId = msg.titleId ?? null;
      state.opponentEloRating = msg.eloRating ?? null;
      state.opponentCompanion = msg.companion ?? null;
      showMatchIntroCard();
      render();
    }
  } else if (msg.type === 'chat') {
    if (state.gameMode === 'ffa') {
      const info = state.ffaPlayers[fromSeat];
      const label = info && info.username ? info.username : `Player ${fromSeat + 1}`;
      log(`\u{1F4AC} ${label}: ${msg.text}`);
    } else {
      const opponentPlayerNum = state.myPlayer === 1 ? 2 : 1;
      log(`\u{1F4AC} ${playerLabel(opponentPlayerNum)}: ${msg.text}`);
    }
    playChatPing();
  } else if (msg.type === 'elo-result') {
    showEloResult(state.myPlayer === 1 ? msg.delta_p1 : msg.delta_p2, msg.halved);
  } else if (msg.type === 'resync-request') {
    // The peer noticed a gap/mismatch in the move sequence and wants our
    // canonical state to catch up - same payload used for the post-rejoin
    // resync, just triggered in-band instead of after a reconnect. In ffa,
    // only the host ever responds - it's the sole relay/authority for
    // everyone, so it's the only side whose state should ever be treated
    // as canonical (a non-host "resyncing" someone would just be relaying
    // its own possibly-stale copy).
    if (state.gameMode === 'ffa' && !NetFfa.isHost) return;
    netSend({ type: 'resync', ...serializeFullState() });
  } else if (msg.type === 'resync') {
    clearTimeout(resyncFallbackTimer);
    clearTimeout(resyncRequestTimeoutId);
    state.connecting = false;

    const wasAwaitingTimeoutConfirm = !!timeoutConfirmTimer;
    clearTimeoutConfirm();

    if (msg.plyCount < state.plyCount) {
      // We're actually the more-advanced side here - the peer is the one
      // who's behind (e.g. they never received one of OUR moves). Send
      // ours back instead of accepting theirs, so they catch up instead
      // of us regressing to a state we've already moved past. Never
      // finalize a suspected opponent-timeout in this branch either: if
      // they're behind, they simply don't know it's their turn yet, so
      // ending the game now would be exactly the wrong call.
      netSend({ type: 'resync', ...serializeFullState() });
    } else {
      applyFullState(msg);
      if (wasAwaitingTimeoutConfirm) {
        if (timeoutConfirmStillStuck()) {
          // Confirmed directly with the opponent's own client, moments
          // ago, that they genuinely still haven't moved - not just a
          // dropped message. Safe to declare the timeout now.
          finalizeOpponentTimeoutForfeit(timeoutConfirmForfeitingPlayer);
          return;
        }
        const latestMove = state.moveLog[state.moveLog.length - 1];
        if (latestMove && latestMove.autoTimeout) {
          log("Your opponent's turn timed out, but the game auto-placed a piece for them - resuming.");
        } else {
          log("Your opponent's move had actually gone through - resuming.");
        }
      } else {
        log('Reconnected. Game state restored.');
      }
    }

    setLobbyStatus(`Connected! You are Player ${state.myPlayer}. (${state.gameMode})`);
    render();
  } else if (msg.type === 'newgame-request') {
    state.incomingNewGameRequest = true;
    render();
  } else if (msg.type === 'newgame-response') {
    state.pendingNewGameRequest = false;
    if (msg.accepted) {
      log('Opponent accepted your rematch request.');
      if (Net.isHost) {
        newGame();
      } else {
        setLobbyStatus('Waiting for the host to start the rematch...');
      }
    } else {
      log('Opponent declined your rematch request.');
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

// viaCreate distinguishes which of the two Direct Connect paths this call
// came from, purely to decide which controls to gray out below - Create
// Room and Join Room both being live at once while already mid-connection
// (waiting for a friend to join your room, or waiting on a room code
// lookup) was confusing, since only one of them can actually apply to
// what you're currently doing. Whichever path you DID take stays enabled,
// since the status message below explicitly invites clicking it again if
// the connection seems stuck.
function connectToPrivateRoom(room, viaCreate = false) {
  if (!room) {
    setLobbyStatus('Enter a room code.');
    return;
  }
  state.connecting = true;
  render();
  setLobbyStatus(`Connecting to room ${room}... (if this seems stuck for a while, it is safe to click again to retry)`);
  document.getElementById('createRoomBtn').disabled = !viaCreate;
  document.getElementById('connectBtn').disabled = viaCreate;
  document.getElementById('roomInput').disabled = viaCreate;
  // userId/accessToken are only included when actually signed in - a guest
  // joins exactly as before. The server verifies the token itself before
  // trusting userId for anything (see server.js's 'join' handler); this
  // is what lets it reject a logged-in player joining their own room from
  // a second tab/device.
  const user = Auth.getUser();
  const joinMessage = user
    ? { type: 'join', room, userId: user.id, accessToken: Auth.getAccessToken() }
    : { type: 'join', room };
  Net.connect({
    serverUrl: SIGNALING_SERVER_URL,
    joinMessage,
    onStatus: setLobbyStatus,
    onReady: handleNetReady,
    onData: handleNetData,
    onPeerLeft: handleNetPeerLeft,
    onRoomFull: () => {
      state.connecting = false;
      document.getElementById('createRoomBtn').disabled = false;
      document.getElementById('connectBtn').disabled = false;
      document.getElementById('roomInput').disabled = false;
      render();
    },
  });
}

document.getElementById('connectBtn').addEventListener('click', () => {
  connectToPrivateRoom(document.getElementById('roomInput').value.trim(), false);
});

document.getElementById('createRoomBtn').addEventListener('click', () => {
  // Auto-generating the code (rather than having the host type something
  // freeform, like the old "e.g. ABCD" placeholder) avoids unrelated pairs
  // of players both guessing the same obvious example and getting matched
  // with a stranger instead of their friend.
  const code = generatePrivateRoomCode();
  document.getElementById('roomInput').value = code;
  connectToPrivateRoom(code, true);
});

// ---------- Pre-game settings (private rooms, hotseat, vs Bot) ----------
// Entered whenever a game not gated behind casual/ranked matchmaking is
// about to (re)start: a private room's first game or rematch (both host-
// only - see below), and now hotseat/vs Bot's first game or rematch too
// (nothing to gate there, it's all one local browser). Casual/ranked never
// call this - those stay fully random, no customization, by design.
//
// Online, only the host calls this; the joiner never triggers it locally,
// it just reacts to the host's broadcast below, which keeps the "who's
// allowed to configure/start" rule in exactly one place. Offline there's
// only one player, so isGameSetupController() is always true.
function isGameSetupController() {
  return !state.online || Net.isHost;
}

function beginGameSetup() {
  state.awaitingRoomStart = true;
  state.roomSettings = { handMode: 'random', timerSeconds: null, boardShape: 'square' };
  state.roomHandCounts = {};
  render();
  broadcastRoomSettings(); // harmless no-op offline - Net.send() is a no-op with no data channel
}

// Full-snapshot broadcast (settings + counts) rather than incremental
// diffs - the payload is tiny and this way the joiner's mirrored view can
// never drift out of sync with the host's, no matter which message
// happens to arrive first or get missed.
function broadcastRoomSettings() {
  Net.send({ type: 'room-settings', settings: state.roomSettings, handCounts: state.roomHandCounts });
}

function isHandSelectionValid() {
  const total = (names) => names.reduce((sum, n) => sum + (state.roomHandCounts[n] || 0), 0);
  return total(PENTOMINO_NAMES) === HAND_COMPOSITION.pentomino
    && total(TETROMINO_NAMES) === HAND_COMPOSITION.tetromino
    && total(TROMINO_NAMES) === HAND_COMPOSITION.tromino;
}

function buildHandFromCounts(counts) {
  const hand = [];
  for (const name of Object.keys(counts)) {
    for (let i = 0; i < counts[name]; i++) hand.push(name);
  }
  return hand;
}

function adjustHandCount(name, delta) {
  if (!isGameSetupController()) return;
  const next = (state.roomHandCounts[name] || 0) + delta;
  if (next < 0) return;
  state.roomHandCounts[name] = next;
  broadcastRoomSettings();
  render();
}

function renderHandPickerCategory(gridId, countLabelId, names, required) {
  const isHost = isGameSetupController();
  const total = names.reduce((sum, n) => sum + (state.roomHandCounts[n] || 0), 0);
  const countLabel = document.getElementById(countLabelId);
  countLabel.textContent = `${total}/${required}`;
  countLabel.classList.toggle('complete', total === required);

  const grid = document.getElementById(gridId);
  grid.innerHTML = '';
  for (const name of names) {
    const count = state.roomHandCounts[name] || 0;
    const tile = document.createElement('div');
    tile.className = 'hand-picker-tile';

    const iconCanvas = document.createElement('canvas');
    drawShapeIcon(iconCanvas, BASE_SHAPES[name]);
    tile.appendChild(iconCanvas);

    const stepper = document.createElement('div');
    stepper.className = 'hand-picker-stepper';
    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.textContent = '−';
    minusBtn.disabled = !isHost || count === 0;
    minusBtn.addEventListener('click', () => adjustHandCount(name, -1));
    const countSpan = document.createElement('span');
    countSpan.textContent = count;
    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.textContent = '+';
    plusBtn.disabled = !isHost || total >= required;
    plusBtn.addEventListener('click', () => adjustHandCount(name, 1));
    stepper.append(minusBtn, countSpan, plusBtn);
    tile.appendChild(stepper);

    grid.appendChild(tile);
  }
}

// Called every render() - cheap and idempotent, same reasoning as
// updateLobbyGameVisibility() - rather than threading a call into every
// spot that can change state.awaitingRoomStart/roomSettings/roomHandCounts.
function renderRoomSettingsPanel() {
  const overlay = document.getElementById('roomSettingsOverlay');
  if (!overlay) return;

  const show = state.awaitingRoomStart;
  overlay.style.display = show ? 'flex' : 'none';
  if (!show) return;

  document.getElementById('roomSettingsTitle').textContent = state.online
    ? 'Room Settings'
    : (state.vsBot ? 'vs Bot Settings' : 'Local Game Settings');

  const isHost = isGameSetupController();
  const settings = state.roomSettings;
  const randomBtn = document.getElementById('handModeRandomBtn');
  const selectBtn = document.getElementById('handModeSelectBtn');
  randomBtn.classList.toggle('active', settings.handMode !== 'select');
  selectBtn.classList.toggle('active', settings.handMode === 'select');
  randomBtn.disabled = !isHost;
  selectBtn.disabled = !isHost;

  // Timer only makes sense for an actual online private room - hotseat/vsBot
  // share this same settings overlay but have no concept of a synced
  // opponent clock, so the row is hidden rather than shown disabled.
  const timerRow = document.getElementById('timerSettingRow');
  timerRow.style.display = state.online ? '' : 'none';
  if (state.online) {
    const timerSeconds = settings.timerSeconds ?? null;
    const timerButtons = [
      [document.getElementById('timerNoneBtn'), null],
      [document.getElementById('timer10Btn'), 10],
      [document.getElementById('timer60Btn'), 60],
      [document.getElementById('timer120Btn'), 120],
    ];
    for (const [btn, val] of timerButtons) {
      btn.classList.toggle('active', timerSeconds === val);
      btn.disabled = !isHost;
    }
  }

  // Custom board shapes are also online-private-room-only, same reasoning
  // as the Timer row.
  const boardShapeRow = document.getElementById('boardShapeSettingRow');
  boardShapeRow.style.display = state.online ? '' : 'none';
  if (state.online) {
    const boardShape = settings.boardShape || 'square';
    const shapeButtons = [
      [document.getElementById('boardShapeSquareBtn'), 'square'],
      [document.getElementById('boardShapePlusBtn'), 'plus'],
      [document.getElementById('boardShapeXBtn'), 'x'],
      [document.getElementById('boardShapeHeartBtn'), 'heart'],
    ];
    for (const [btn, val] of shapeButtons) {
      btn.classList.toggle('active', boardShape === val);
      btn.disabled = !isHost;
    }
  }

  const pickerPanel = document.getElementById('handPickerPanel');
  const selecting = settings.handMode === 'select';
  pickerPanel.style.display = selecting ? 'flex' : 'none';
  if (selecting) {
    renderHandPickerCategory('pentominoPicker', 'pentominoCount', PENTOMINO_NAMES, HAND_COMPOSITION.pentomino);
    renderHandPickerCategory('tetrominoPicker', 'tetrominoCount', TETROMINO_NAMES, HAND_COMPOSITION.tetromino);
    renderHandPickerCategory('trominoPicker', 'trominoCount', TROMINO_NAMES, HAND_COMPOSITION.tromino);
  }

  const startBtn = document.getElementById('startPrivateGameBtn');
  const statusEl = document.getElementById('roomSettingsStatus');
  if (isHost) {
    const valid = !selecting || isHandSelectionValid();
    startBtn.style.display = '';
    startBtn.disabled = !valid;
    statusEl.textContent = valid ? '' : 'Pick the exact number of pieces in each category to continue.';
  } else {
    startBtn.style.display = 'none';
    statusEl.textContent = 'Waiting for the host to configure and start the game…';
  }
}

document.getElementById('handModeRandomBtn').addEventListener('click', () => {
  if (!isGameSetupController()) return;
  state.roomSettings.handMode = 'random';
  broadcastRoomSettings();
  render();
});

document.getElementById('handModeSelectBtn').addEventListener('click', () => {
  if (!isGameSetupController()) return;
  state.roomSettings.handMode = 'select';
  broadcastRoomSettings();
  render();
});

function setRoomTimerChoice(seconds) {
  if (!isGameSetupController()) return;
  state.roomSettings.timerSeconds = seconds;
  broadcastRoomSettings();
  render();
}

document.getElementById('timerNoneBtn').addEventListener('click', () => setRoomTimerChoice(null));
document.getElementById('timer10Btn').addEventListener('click', () => setRoomTimerChoice(10));
document.getElementById('timer60Btn').addEventListener('click', () => setRoomTimerChoice(60));
document.getElementById('timer120Btn').addEventListener('click', () => setRoomTimerChoice(120));

function setRoomBoardShapeChoice(shape) {
  if (!isGameSetupController()) return;
  state.roomSettings.boardShape = shape;
  broadcastRoomSettings();
  render();
}

document.getElementById('boardShapeSquareBtn').addEventListener('click', () => setRoomBoardShapeChoice('square'));
document.getElementById('boardShapePlusBtn').addEventListener('click', () => setRoomBoardShapeChoice('plus'));
document.getElementById('boardShapeXBtn').addEventListener('click', () => setRoomBoardShapeChoice('x'));
document.getElementById('boardShapeHeartBtn').addEventListener('click', () => setRoomBoardShapeChoice('heart'));

document.getElementById('startPrivateGameBtn').addEventListener('click', () => {
  if (!isGameSetupController()) return;
  if (state.roomSettings.handMode === 'select' && !isHandSelectionValid()) return;
  const handOverride = state.roomSettings.handMode === 'select' ? buildHandFromCounts(state.roomHandCounts) : undefined;
  // Only ever a real choice for an online private room - hotseat/vsBot never
  // show the timer/board-shape rows (see renderRoomSettingsPanel()), so
  // these stay null/'square' (untimed, normal board) for them, same as
  // before either feature existed.
  state.privateTimerSeconds = state.roomSettings.timerSeconds ?? null;
  state.boardShape = state.roomSettings.boardShape || 'square';
  newGame(undefined, undefined, undefined, handOverride);
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

// ---------- 4-player free-for-all queue ----------
// Deliberately its own connect/ready/data flow rather than a branch inside
// startQueue()/handleNetReady() - it drives NetFfa (a whole separate
// networking module, see its own header comment for why), and enough of
// the surrounding bookkeeping (myPlayer never depends on a coin flip,
// there's no rematch, "the opponent" is up to 3 different seats instead of
// one) differs enough that folding it into the 2-player functions would
// mean threading an ffa branch through nearly every line of them.
function startFfaQueue() {
  const user = Auth.getUser();
  if (!user) {
    setLobbyStatus('Sign in (top right) first to use the FFA queue.');
    return;
  }
  const accessToken = Auth.getAccessToken();

  state.queueSearching = true;
  render();
  setLobbyStatus('Searching for 3 other free-for-all players...');
  NetFfa.connect({
    serverUrl: SIGNALING_SERVER_URL,
    userId: user.id,
    accessToken,
    onStatus: setLobbyStatus,
    onReady: handleFfaReady,
    onData: handleNetData, // (msg, fromSeat) - the same dispatcher the 2-player path uses, generalized to accept fromSeat
    onPeerLeft: handleFfaPeerLeft,
    onSeatDisconnected: handleFfaSeatDisconnected,
    onSeatForfeited: (seat) => eliminateFfaSeat(seat, 'timeout'),
    onMatchAbandoned: handleFfaMatchAbandoned,
    onConnectionStale: handleFfaConnectionStale,
  });
}

document.getElementById('ffaQueueBtn').addEventListener('click', () => startFfaQueue());

function handleFfaReady() {
  if (NetFfa.isRejoin) {
    handleFfaRejoinReady();
    return;
  }

  state.online = true;
  state.connecting = false;
  state.vsBot = false;
  state.queueSearching = false;
  state.gameMode = 'ffa';
  state.playerCount = 4;
  state.ffaSeat = NetFfa.mySeat;
  state.myPlayer = state.ffaSeat + 1;
  state.ffaPlayers = [null, null, null, null];
  state.ffaEliminatedSeats = new Set();
  state.ffaAbandoned = false;
  state.ffaRanks = null;
  state.introShown = false;
  state.gameSequence = 0;
  state.pendingUndoRequest = false;
  state.incomingUndoRequest = false;
  document.getElementById('createRoomBtn').disabled = true;
  document.getElementById('connectBtn').disabled = true;
  document.getElementById('roomInput').disabled = true;
  setLobbyStatus(`Connected! You are Player ${state.myPlayer}. (ffa)`);
  log(`Connected to the free-for-all match. You are Player ${state.myPlayer}.`);

  const myProfile = Auth.getProfile();
  const myIdentity = {
    userId: Auth.getUser()?.id ?? null,
    username: myProfile ? myProfile.username : null,
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
  };
  // Never echoed back to me over the network (see net-ffa.js's relay
  // comment - a sender never receives its own broadcast), so recorded
  // locally too, not just sent.
  state.ffaPlayers[state.ffaSeat] = myIdentity;
  netSend({ type: 'identify', ...myIdentity });

  if (NetFfa.isHost) beginFfaGame(drawHand());
  else render();

  saveActiveMatch(); // no-op outside casual/ranked - kept for symmetry/consistency, not because ffa resumes this way yet
}

function beginFfaGame(hand) {
  BOARD_SIZE = 20;
  CELL_PX = TARGET_BOARD_PX / BOARD_SIZE;
  canvas.width = BOARD_SIZE * CELL_PX;
  canvas.height = BOARD_SIZE * CELL_PX;
  state.boardShape = 'square';
  state.voidMask = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  state.board = new Int8Array(BOARD_SIZE * BOARD_SIZE);
  state.playerCount = 4;
  state.hands = [[...hand], [...hand], [...hand], [...hand]];
  state.scores = [0, 0, 0, 0];
  state.initialHand = [...hand];
  state.moveLog = [];
  state.lastMove = null;
  state.turn = 1;
  state.startingPlayer = 1;
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
  state.gameStarted = true;
  state.gameStartedAt = new Date().toISOString();
  state.ffaEliminatedSeats = state.ffaEliminatedSeats || new Set();
  state.ffaAbandoned = false;
  state.ffaRanks = null;
  lastObservedTurnKey = null;
  clearLog();
  log('New free-for-all game started. All 4 players drew the same hand.');
  playGameStartChime();
  checkGameEnd();
  render();

  // Re-sent here (already sent once, in handleFfaReady()/
  // handleFfaRejoinReady() right as this client's own connection came up)
  // rather than relied on as a one-shot - a joiner's identify sent the
  // instant ITS OWN link to the host opens can arrive at the host before
  // the host has finished connecting to every other seat, and the host
  // can only relay to connections that are already open when the message
  // arrives - there's no retry, so that identify is lost for whichever
  // seats weren't connected yet at that exact moment (this is what was
  // showing up as some seats never getting a name/avatar). By the time
  // EITHER side reaches this function - the host sending ffa-start, or a
  // joiner receiving it - the host is guaranteed fully connected to all 3
  // seats (that's exactly the condition ffa-start itself waits for), so a
  // resend here is guaranteed to actually reach everyone.
  const myProfile = Auth.getProfile();
  netSend({
    type: 'identify',
    userId: Auth.getUser()?.id ?? null,
    username: myProfile ? myProfile.username : null,
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
  });

  if (NetFfa.isHost) {
    netSend({ type: 'ffa-start', hand });
    netSendToServer({ type: 'live-game-start', boardSize: BOARD_SIZE, initialHand: hand });
  }
}

function handleFfaRejoinReady() {
  clearTimeout(rejoinTimeoutId);
  state.online = true;
  state.connecting = false;
  state.gameMode = 'ffa';
  state.playerCount = 4;
  state.ffaSeat = NetFfa.mySeat;
  state.myPlayer = state.ffaSeat + 1;
  state.ffaPlayers = state.ffaPlayers || [null, null, null, null];
  state.ffaEliminatedSeats = state.ffaEliminatedSeats || new Set();
  document.getElementById('createRoomBtn').disabled = true;
  document.getElementById('connectBtn').disabled = true;
  document.getElementById('roomInput').disabled = true;

  const myProfile = Auth.getProfile();
  const myIdentity = {
    userId: Auth.getUser()?.id ?? null,
    username: myProfile ? myProfile.username : null,
    avatarId: myProfile ? myProfile.avatar_id : null,
    titleId: myProfile ? myProfile.title_id : null,
  };
  state.ffaPlayers[state.ffaSeat] = myIdentity;
  netSend({ type: 'identify', ...myIdentity });

  if (state.gameStarted && !state.gameOver) {
    setLobbyStatus('Reconnected! Recovering the match...');
    // Only the host is authoritative for ffa resync (see the
    // 'resync-request' handler's own comment) - ask it directly instead of
    // waiting on a symmetric race the star topology doesn't actually have.
    netSend({ type: 'resync-request' });
  } else {
    setLobbyStatus('Reconnected! Waiting for the match to resume...');
  }
  render();
}

// Mirrors attemptRejoin()'s 2-player equivalent, against NetFfa instead of
// Net - only relevant for a NON-host seat, whose one connection (to the
// host) just died; a host-side seat dying is instead handled entirely via
// the signaling server's own independent disconnect-grace detection (see
// handleFfaSeatDisconnected/onSeatForfeited below).
function attemptFfaRejoin() {
  const user = Auth.getUser();
  const accessToken = Auth.getAccessToken();
  const matchId = NetFfa.matchId;
  if (!user || !accessToken || !matchId) return;

  state.connecting = true;
  render();
  setLobbyStatus('Connection lost - reconnecting...');

  clearTimeout(rejoinTimeoutId);
  rejoinTimeoutId = setTimeout(() => {
    if (!state.connecting) return;
    state.connecting = false;
    setLobbyStatus('Reconnect attempt timed out.');
    render();
  }, REJOIN_TIMEOUT_MS);

  NetFfa.rejoin({
    serverUrl: SIGNALING_SERVER_URL,
    matchId,
    userId: user.id,
    accessToken,
    onStatus: setLobbyStatus,
    onReady: handleFfaReady,
    onData: handleNetData,
    onPeerLeft: handleFfaPeerLeft,
    onSeatDisconnected: handleFfaSeatDisconnected,
    onSeatForfeited: (seat) => eliminateFfaSeat(seat, 'timeout'),
    onMatchAbandoned: handleFfaMatchAbandoned,
    onConnectionStale: handleFfaConnectionStale,
    onRejoinFailed: (reason) => {
      clearTimeout(rejoinTimeoutId);
      state.connecting = false;
      setLobbyStatus(reason || 'Could not reconnect to your previous match.');
      render();
    },
  });
}

function handleFfaPeerLeft() {
  if (!state.gameOver && !NetFfa.isHost) attemptFfaRejoin();
}

function handleFfaConnectionStale() {
  if (!state.gameOver && !state.connecting && !NetFfa.isHost) attemptFfaRejoin();
}

function handleFfaSeatDisconnected(seat, isHost, graceMs) {
  if (isHost) {
    setLobbyStatus('The host disconnected - waiting to see if they reconnect...');
    log('The host disconnected. Waiting for them to reconnect...');
  } else {
    log(`${playerLabel(seat + 1)} disconnected - they'll be eliminated if they don't reconnect soon.`);
  }
  render();
}

function handleFfaMatchAbandoned() {
  if (state.gameOver) return;
  state.ffaAbandoned = true;
  setLobbyStatus('The host never reconnected - this match has ended.');
  endGame('The host disconnected and the match could not continue.');
}

document.getElementById('cancelConnectBtn').addEventListener('click', () => {
  Net.cancelQueue();
  NetFfa.cancelQueue(); // harmless no-op if the FFA queue was never the active one
  state.connecting = false;
  state.queueSearching = false;
  // connectToPrivateRoom() disables one of createRoomBtn/connectBtn+roomInput
  // for the duration of a Create Room or Join Room attempt (whichever path
  // wasn't taken) - every other way that attempt can end (onRoomFull, the
  // resync-fallback timeout) already re-enables all three, but this Cancel
  // button is shared with the casual/ranked queue-search flow too and was
  // missing the same reset, leaving them stuck disabled after cancelling a
  // private-room connect. Harmless to always reset here even when cancelling
  // a queue search instead, since that flow never touches these three.
  document.getElementById('createRoomBtn').disabled = false;
  document.getElementById('connectBtn').disabled = false;
  document.getElementById('roomInput').disabled = false;
  setLobbyStatus('Cancelled.');
  render();
});

// Lets players see whether it's worth queueing before they commit to it -
// polls the signaling server's HTTP endpoint (same host/port as the WS),
// separate from the WebRTC connection itself. Was 7000 - visibly laggy for
// something players watch while actively deciding whether to queue;
// halved rather than dropped further, since this is a plain HTTP GET
// hitting the server from every open lobby tab.
const QUEUE_COUNT_POLL_MS = 3500;
const SIGNALING_HTTP_URL = SIGNALING_SERVER_URL.replace(/^ws/, 'http');

function formatQueueCount(n) {
  if (n === 1) return '1 waiting';
  return `${n} waiting`;
}

async function refreshQueueCounts() {
  try {
    const res = await fetch(`${SIGNALING_HTTP_URL}/queue-counts`);
    if (!res.ok) return;
    const { casual, ranked, ffa } = await res.json();
    document.getElementById('casualQueueCount').textContent = formatQueueCount(casual);
    document.getElementById('rankedQueueCount').textContent = formatQueueCount(ranked);
    document.getElementById('ffaQueueCount').textContent = formatQueueCount(ffa || 0);
  } catch {
    // signaling server unreachable - leave whatever was last shown
  }
}

document.getElementById('resumeMatchBtn').addEventListener('click', () => tryResumeActiveMatch(10, true));

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

// ---------- Desktop hand-tray position preference ----------
// A checkbox (next to the hand tray itself) rather than a fixed choice -
// added right after moving the tray to the right/above the rules panel
// by default, since it wasn't clear that's actually better for everyone.
// Persisted so it sticks across visits; purely a CSS class toggle (see
// .app.classic-hands), no effect on mobile's own fixed layout.
const HANDS_POSITION_KEY = 'minogoe_handsOnRight';
const handsPositionToggle = document.getElementById('handsPositionToggle');
if (handsPositionToggle) {
  const appEl = document.querySelector('.app');
  const saved = localStorage.getItem(HANDS_POSITION_KEY);
  const handsOnRight = saved === null ? true : saved === 'true';
  handsPositionToggle.checked = handsOnRight;
  appEl.classList.toggle('classic-hands', !handsOnRight);

  handsPositionToggle.addEventListener('change', () => {
    localStorage.setItem(HANDS_POSITION_KEY, String(handsPositionToggle.checked));
    appEl.classList.toggle('classic-hands', !handsPositionToggle.checked);
  });
}

// ---------- Init ----------
render();
updateResumeMatchBanner(); // show immediately if we have a record, even before auth resolves
Auth.onAuthChange(tryResumeActiveMatch);
refreshQueueCounts();
setInterval(refreshQueueCounts, QUEUE_COUNT_POLL_MS);
