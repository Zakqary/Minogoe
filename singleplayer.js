// Singleplayer modes. Deliberately self-contained rather than importing
// from game.js - shape/orientation generation is duplicated (same approach
// replay.js already takes, for the same reason). Three modes share this file:
//   - Speedrun: a cascading capture/removal mechanic all its own (enclose a
//     small pocket and the walling pieces vanish, freeing the space back
//     up) - see runCaptureCascade().
//   - Eogonim: scored like a real Minogoe match instead - pieces never
//     disappear, and a fully-enclosed empty pocket of ANY size counts as
//     captured territory (see computeCapturedCount(), which mirrors
//     game.js's computeFinalScores() minus the two-player owner-conflict
//     case, since there's only ever one color here).
//   - Blind Eogonim: Eogonim's exact same rules and scoring, played on hard
//     mode - a placed piece disappears from view the instant it's placed
//     (drawBoard() renders every occupied cell as empty while the run is
//     still going), so you have to remember where you've already put
//     pieces. Clicking a square that's actually occupied (visible or not)
//     ends the run immediately as an illegal move, instead of just being a
//     harmless no-op like clicking off the edge of the board is. Never
//     draws the same shape twice in a row (drawWeightedPieceExcluding()) -
//     with the board itself giving no visual feedback either way, a repeat
//     piece would be indistinguishable from a click that did nothing.
//   - Ascension: a roguelike built on Eogonim's no-removal capture rule.
//     Start with one randomly-offered shape (infinite supply), place until
//     stuck, and if that round's captured total clears an escalating
//     threshold, unlock a new shape, reset the board, and go again - see
//     the "Ascension run flow" section below.
//   - Blight: Eogonim's no-removal capture rule again, but the goal flips to
//     MAXIMIZING captured territory, and the board actively works against
//     you - it starts with 5 random "dead" squares, and one more spawns
//     (on a random still-empty square, but never inside territory you've
//     already captured) after every placement. A dead square can never be
//     placed on, and it poisons enclosure the same way an opponent's piece
//     would in a real match: an empty pocket bordering a dead square never
//     counts as your captured territory, even if it's also bordered by
//     your own pieces. See computeBlightRegions()/spawnDeadCell().
// Board size varies by mode (Speedrun: 9x9, everything else: 10x10) - see
// BOARD_SIZES and setMode() below - so this is reassigned rather than a const.
let BOARD_SIZE = 9;
const BOARD_SIZES = { speedrun: 9, eogonim: 10, blindeogonim: 10, ascension: 10, blight: 10, godbot: 12, curse: 10, shrink: 10, mutation: 12, puzzle: 12 };
const CELL_PX = 52;

// ---------- Seeded RNG (Duel mode only) ----------
// Every RNG call site in this file defaults to real randomness (rng/
// rngSecondary both start out as plain Math.random) - solo play is
// completely unaffected. duel.js (a separate page) calls setRng()/
// setSecondaryRng() with a seeded mulberry32 generator before startRun(), so
// both players in a duel get an identical sequence from a shared seed.
// Two separate streams, not one: `rng` only ever backs calls that are pure
// functions of draw-index (piece/shape draws, puzzle hand+layout
// generation) - safe to share losslessly since two duelling clients will
// call these in lockstep regardless of how their boards later diverge.
// `rngSecondary` backs calls that read state.board (curse-type filtering,
// blight's dead-cell target, GodBot's tie-breaks) - these can only be
// PARTIALLY synced once boards diverge, see rollCurse()/godbotRunBotTurn()'s
// own comments for how each handles that.
let rng = Math.random;
let rngSecondary = Math.random;
function setRng(fn) { rng = fn; }
function setSecondaryRng(fn) { rngSecondary = fn; }
// Duel-only: fired at the end of every finish*Run()/failRun() for a duel-
// eligible mode, right after that run's own render()/save-guard, so duel.js
// can react to "my round just ended" without polling state.finished on a
// timer. A no-op (null) for solo play.
let onRoundFinished = null;
function setOnRoundFinished(fn) { onRoundFinished = fn; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
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

// GodBot only - a real match hand, same composition as game.js's own
// HAND_COMPOSITION/drawHand()/pickRandom() (duplicated here for the same
// self-contained reason as everything else in this file). ALL_SHAPE_NAMES
// is what models the bot's "access to every piece" - passed as its
// candidate pool on every single turn instead of a real, depleting hand.
const HAND_COMPOSITION = { pentomino: 7, tetromino: 2, tromino: 1 };
const ALL_SHAPE_NAMES = [...PENTOMINO_NAMES, ...TETROMINO_NAMES, ...TROMINO_NAMES];
function pickRandom(names, count) {
  const picks = [];
  for (let i = 0; i < count; i++) picks.push(names[Math.floor(rng() * names.length)]);
  return picks;
}
function drawGodbotHand() {
  return [
    ...pickRandom(PENTOMINO_NAMES, HAND_COMPOSITION.pentomino),
    ...pickRandom(TETROMINO_NAMES, HAND_COMPOSITION.tetromino),
    ...pickRandom(TROMINO_NAMES, HAND_COMPOSITION.tromino),
  ];
}

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
// Mutation-only: the curated P_*/Q_*/R_* sets above only go up to
// pentomino, and are hand-picked to exclude mirror-duplicate entries (see
// the Q_Z/Q_J comment above) - Mutation instead needs the FULL free-
// polyomino set at hexomino/heptomino sizes, which is too large to hand-
// type accurately (35 hexominoes, 108 heptominoes).
// enumerateFreePolyominoes(n) generates every one algorithmically: starting
// from the single monomino, it repeatedly grows each known shape of size
// size-1 by one cell in every possible adjacent spot, then dedupes against
// a canonical form (the lexicographically-smallest of its 8 rotate/mirror
// variants, reusing rotate90()/mirror() above) so physically-identical
// shapes (including mirrors, same convention as the curated sets) collapse
// to one entry. Verified against the known free-polyomino counts (1, 1, 2,
// 5, 12, 35, 108 for n=1..7) before shipping.
function canonicalKey(shape) {
  let best = null;
  let cur = shape;
  for (const useMirror of [false, true]) {
    let variant = useMirror ? mirror(shape) : shape;
    for (let i = 0; i < 4; i++) {
      const key = JSON.stringify(variant);
      if (best === null || key < best) best = key;
      variant = rotate90(variant);
    }
  }
  return best;
}
function enumerateFreePolyominoes(n) {
  let current = [normalize([[0, 0]])];
  for (let size = 2; size <= n; size++) {
    const seen = new Map();
    for (const shape of current) {
      const cellSet = new Set(shape.map(([r, c]) => `${r},${c}`));
      for (const [r, c] of shape) {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
          const k = `${nr},${nc}`;
          if (cellSet.has(k)) continue;
          const grown = normalize([...shape, [nr, nc]]);
          const key = canonicalKey(grown);
          if (!seen.has(key)) seen.set(key, grown);
        }
      }
    }
    current = [...seen.values()];
  }
  return current;
}
// Generated sizes are only 6 and 7 - sizes 3/4/5 stay the hand-curated
// P_*/Q_*/R_* sets above (same physical shapes either way, just named/
// ordered differently, and those names are already depended on elsewhere -
// Ascension's unlock system, GodBot's HAND_COMPOSITION). Monomino/domino
// are deliberately NOT generated at all - Mutation only ever draws
// tromino-through-heptomino (see MUTATION_SIZE_POOLS below); 1x1/1x2
// pieces made the board trivially easy to pack tight, so they were pulled
// from the pool entirely rather than just downweighted.
const HEXOMINO_NAMES = [];
const HEPTOMINO_NAMES = [];
[[6, HEXOMINO_NAMES, 'M6'], [7, HEPTOMINO_NAMES, 'M7']].forEach(([size, names, prefix]) => {
  enumerateFreePolyominoes(size).forEach((shape, i) => {
    const name = `${prefix}_${String(i).padStart(3, '0')}`;
    BASE_SHAPES[name] = shape;
    names.push(name);
  });
});
// size -> pool of shape names, for Mutation's weighted-by-size draw.
// Tromino (3) through heptomino (7) only - see the comment above.
const MUTATION_SIZE_POOLS = {
  3: TROMINO_NAMES, 4: TETROMINO_NAMES,
  5: PENTOMINO_NAMES, 6: HEXOMINO_NAMES, 7: HEPTOMINO_NAMES,
};

const ORIENTATIONS = {};
for (const name of Object.keys(BASE_SHAPES)) ORIENTATIONS[name] = generateOrientations(BASE_SHAPES[name]);

function idx(r, c) { return r * BOARD_SIZE + c; }

// ---------- State ----------
// board cell values: 0 = empty, 1 = placed. Speedrun also uses 2 = captured
// (permanent, cleared of its walling pieces) - eogonim/blindeogonim/ascension
// never set a cell to 2 at all, since pieces there never disappear; their
// captured count is only ever a computed number (see computeCapturedCount()),
// not a board state. Blight is the one other mode that uses 2 - there it
// means a dead square (see computeBlightRegions()/spawnDeadCell()), a
// permanent board fixture from the moment it spawns, same "never mutates
// back" spirit as speedrun's captured cells just for a different reason.
const state = {
  mode: 'speedrun', // 'speedrun' | 'eogonim' | 'blindeogonim' | 'ascension' | 'blight' | 'godbot' | 'curse' - persists across resetBoardState(), only setMode()/startRun() change it
  board: new Uint8Array(BOARD_SIZE * BOARD_SIZE),
  pieceIdAt: new Int32Array(BOARD_SIZE * BOARD_SIZE),
  pieceCells: new Map(), // pieceId -> number[] of cell indices
  pieceOwner: new Map(), // pieceId -> 1|2, GodBot only - every mode already assigns a piece ID on placement, this just additionally tracks who placed it, which is exactly what "remove one of your pieces" needs to target only the player's own
  nextPieceId: 1,
  running: false,
  finished: false,
  failed: false, // speedrun only - eogonim/blindeogonim/ascension have no fail state, every ending is a valid (scored) result
  illegalMove: false, // blindeogonim only - whether this run's ending was a click on an occupied square rather than running out of legal placements
  selected: null, // { shapeName, orientationIndex } - the current piece being placed
  lastDrawnShape: null, // blindeogonim only - drawWeightedPieceExcluding() reads this to avoid drawing the same shape twice in a row
  pieceQueue: [], // shapeNames coming up after the current piece, length LOOKAHEAD_COUNT - speedrun only
  mouseRC: null,
  hover: null,
  lastTapCell: null,
  startTime: null,
  finalTimeMs: null,
  totalCaptured: 0, // running captured-territory count - eogonim's score, and ascension's CURRENT ROUND score (reset every round, not every run). Also incremented by speedrun's cascade, but never displayed there.
  // Ascension-only - deliberately NOT touched by resetBoardState() (which
  // runs between rounds too), only by startRun()/setMode(), since these
  // need to persist across a round reset within the same run.
  round: 1,
  unlockedShapes: [],
  // Ascension-only - true while the "pick your next shape" interstitial is
  // showing (between startRun()/a round pass and the next round's first
  // placement). IS reset by resetBoardState() since it's board-adjacent UI
  // state, not run-progress state.
  awaitingPieceChoice: false,
  pieceChoices: [], // shapeNames currently offered during the interstitial
  // GodBot-only - gbHand is the player's real, depleting hand (unlike every
  // other mode's one-piece-at-a-time flow). gbTurn/gbBotBusy gate input to
  // the player's own turns; gbLastPowerup ('again'|'remove'|null) drives the
  // required powerup-highlight UI, reset at the start of every bot turn.
  gbHand: [],
  gbTurn: 'player',
  gbBotBusy: false,
  gbLastPowerup: null,
  godbotScore1: 0,
  godbotScore2: 0,
  // Curse-only - the curse rolled for the currently-dealt piece, re-rolled
  // by spawnNextPiece() every time a new piece is drawn.
  curseActive: null,
  // Shrink-only - see resetBoardState()'s own comment. All-zero/0 for every
  // other mode, so isValidPlacement()/hasAnyLegalMove()/isBoardComplete()
  // checking it unconditionally is always a no-op elsewhere.
  voidMask: new Uint8Array(BOARD_SIZE * BOARD_SIZE),
  shrinkPieceCount: 0,
  shrinkRingDepth: 0,
  // Puzzle-only - puzzleHand is the player's real, depleting hand, same
  // "hand of many, placed freely" shape as gbHand above, but never
  // depleted permanently - a placement is never final in this mode (see
  // tryPuzzlePickup()'s own comment), so a shapeName removed here can come
  // right back via removePuzzlePiece(). puzzlePieceShapes (pieceId ->
  // shapeName) is what makes that possible - every other mode only needs
  // pieceCells/pieceIdAt to know WHERE a piece is, never what shape it
  // originally was, since nothing else ever needs to hand it back to a
  // hand. puzzleRound tracks which of the 3 boards this run is on.
  puzzleHand: [],
  puzzlePieceShapes: new Map(),
  puzzleRound: 1,
  // Duel-only (duel.js, a separate page, sets these before startRun()).
  // duelMode gates every duel-only branch above (rollCurse's unfiltered-
  // pool fix, godbotRunBotTurn's synced bonus-action draw) - a duel
  // round's score/time is deliberately NOT exempted from
  // saveXScoreIfBest() (a top score in a duel round still competes for the
  // solo personal-best leaderboard, same server-side "only if actually
  // better" check either way). puzzlePrecomputed, when
  // set, holds all 3 rounds' {hand, voidMask} generated as one synchronous
  // block right after the seeded rng is installed (see
  // precomputeAllPuzzleRounds()) - both duelling clients run that
  // generation from the identical seed before either player can place a
  // single piece, so all 3 boards are guaranteed identical without any
  // per-round network round-trip.
  duelMode: false,
  puzzlePrecomputed: null,
};

// Used both for a brand new run (startRun()) AND between Ascension rounds
// (chooseShape()) - deliberately leaves state.round/unlockedShapes alone,
// since those need to survive a round reset within the same run.
function resetBoardState() {
  state.board = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceIdAt = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceCells = new Map();
  state.pieceOwner = new Map();
  state.nextPieceId = 1;
  state.running = false;
  state.finished = false;
  state.failed = false;
  state.illegalMove = false;
  state.selected = null;
  state.lastDrawnShape = null;
  state.pieceQueue = [];
  state.hover = null;
  state.lastTapCell = null;
  state.startTime = null;
  state.finalTimeMs = null;
  state.totalCaptured = 0;
  state.awaitingPieceChoice = false;
  state.pieceChoices = [];
  state.gbHand = [];
  state.gbTurn = 'player';
  state.gbBotBusy = false;
  state.gbLastPowerup = null;
  state.godbotScore1 = 0;
  state.godbotScore2 = 0;
  state.curseActive = null;
  // Shrink only - an all-zero mask is a harmless no-op for every other mode
  // (isValidPlacement()/hasAnyLegalMove()/isBoardComplete() all check it
  // unconditionally). shrinkPieceCount/shrinkRingDepth track when the next
  // ring is due and how deep the border has shrunk so far this run.
  state.voidMask = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  state.shrinkPieceCount = 0;
  state.shrinkRingDepth = 0;
  // Puzzle only - startRun() calls startPuzzleRound(1) right after this to
  // actually populate the hand/voidMask for round 1; rounds 2 and 3 are
  // advanced by startPuzzleRound() directly (NOT this function), since
  // resetBoardState() also wipes startTime/finalTimeMs above, which a
  // Puzzle run needs to keep running continuously across all 3 boards.
  state.puzzleHand = [];
  state.puzzlePieceShapes = new Map();
  state.puzzleRound = 1;
}

// ---------- Placement legality ----------
function isValidPlacement(shapeName, orientationIndex, r0, c0, board) {
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  for (const [dr, dc] of orientation) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return false;
    if (board[idx(r, c)] !== 0) return false;
    // Shrink only - state.voidMask is all-zero for every other mode, so
    // this is a no-op everywhere else.
    if (state.voidMask[idx(r, c)]) return false;
  }
  return true;
}

// Blind Eogonim only: isValidPlacement() alone can't tell WHY a spot is
// illegal, but that distinction matters here - clicking off the edge of the
// board is harmless (the board's own edges are always visible, so that's
// not a memory test), while clicking onto a square that's actually occupied
// by an earlier, now-invisible piece is the one thing that ends the run.
// 'occupied' wins over 'offboard' if a placement manages to be both at
// once (some cells run off the board while others land on an existing
// piece) - the player has attempted to overlap a real piece either way.
function placementConflictReason(shapeName, orientationIndex, r0, c0, board) {
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  let offboard = false;
  for (const [dr, dc] of orientation) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) { offboard = true; continue; }
    if (board[idx(r, c)] !== 0) return 'occupied';
  }
  return offboard ? 'offboard' : 'ok';
}

function hasAnyLegalMove(shapeName, board) {
  for (const orientation of ORIENTATIONS[shapeName]) {
    const maxDr = Math.max(...orientation.map((p) => p[0]));
    const maxDc = Math.max(...orientation.map((p) => p[1]));
    for (let r0 = 0; r0 <= BOARD_SIZE - 1 - maxDr; r0++) {
      for (let c0 = 0; c0 <= BOARD_SIZE - 1 - maxDc; c0++) {
        let ok = true;
        for (const [dr, dc] of orientation) {
          const cellIdx = idx(r0 + dr, c0 + dc);
          // Shrink only - state.voidMask is all-zero for every other mode.
          if (board[cellIdx] !== 0 || state.voidMask[cellIdx]) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
  }
  return false;
}

// ---------- Curse mode ----------
// Eogonim's exact engine (spawnNextPiece()/commitPlacement() both fall into
// the same generic branches Eogonim/Blight already use), scored by leftover
// empty cells instead of captured territory (confirmed with the user - see
// the plan), with one random curse dealt alongside every piece.
const CURSE_TYPES = ['norotate', 'noborder', 'invisible', 'blightspot'];
const CURSE_LABELS = {
  norotate: "Can't rotate or flip this piece",
  noborder: "This piece can't touch the border",
  invisible: 'This piece is invisible while placing',
  blightspot: 'A blight spot appears after you place it',
};

// Only the no-border curse actually restricts WHERE a piece can go -
// no-rotate restricts WHICH orientation is usable (locked to orientation 0,
// the same default every mode already deals a piece at), so both need their
// own "would this leave zero legal placements" safety check before being
// offered - see rollCurse()'s own comment for why norotate gets the same
// treatment the user only explicitly asked for on noborder.
function curseNoBorderAllows(shapeName, orientationIndex, r0, c0) {
  for (const [dr, dc] of ORIENTATIONS[shapeName][orientationIndex]) {
    const r = r0 + dr, c = c0 + dc;
    if (r === 0 || r === BOARD_SIZE - 1 || c === 0 || c === BOARD_SIZE - 1) return false;
  }
  return true;
}

function hasLegalPlacementForOrientation(shapeName, orientationIndex, board, requireNoBorder) {
  const orientation = ORIENTATIONS[shapeName][orientationIndex];
  const maxDr = Math.max(...orientation.map((p) => p[0]));
  const maxDc = Math.max(...orientation.map((p) => p[1]));
  for (let r0 = 0; r0 <= BOARD_SIZE - 1 - maxDr; r0++) {
    for (let c0 = 0; c0 <= BOARD_SIZE - 1 - maxDc; c0++) {
      if (!isValidPlacement(shapeName, orientationIndex, r0, c0, board)) continue;
      if (requireNoBorder && !curseNoBorderAllows(shapeName, orientationIndex, r0, c0)) continue;
      return true;
    }
  }
  return false;
}

// Only ever called once spawnNextPiece() has already confirmed the piece
// has a legal placement SOMEWHERE (hasAnyLegalMove(), across every
// orientation) - norotate/noborder just narrow that down further, and
// invisible/blightspot never restrict legality at all, so the candidate
// pool can never end up empty.
//
// Duel mode takes a different path here, deliberately: filtering the
// candidate pool by THIS client's own board (as solo play does below)
// would make the curse-index draw see a different-sized pool on each
// duelling client the instant their boards diverge, corrupting the shared
// rngSecondary sequence for every piece after it. Instead, duel mode always
// draws from the full, unfiltered pool (so both clients consume identical
// draws regardless of board state), then substitutes a fixed, always-legal
// fallback ('invisible' - see the comment above, it never restricts
// legality) if the shared pick happens to be illegal on this client's own
// board. The substitution consumes zero extra draws, so it never perturbs
// the index for later pieces.
function rollCurse(shapeName, board) {
  if (state.duelMode) {
    const pick = CURSE_TYPES[Math.floor(rngSecondary() * CURSE_TYPES.length)];
    if (pick === 'norotate' && !hasLegalPlacementForOrientation(shapeName, 0, board, false)) return 'invisible';
    if (pick === 'noborder' && !hasLegalPlacementForOrientation(shapeName, 0, board, true)) return 'invisible';
    return pick;
  }
  let candidates = CURSE_TYPES.slice();
  if (!hasLegalPlacementForOrientation(shapeName, 0, board, false)) {
    candidates = candidates.filter((c) => c !== 'norotate');
  }
  if (!hasLegalPlacementForOrientation(shapeName, 0, board, true)) {
    candidates = candidates.filter((c) => c !== 'noborder');
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// The extra placement constraint the no-border curse layers on top of the
// normal isValidPlacement() check - a no-op for every other curse (or no
// curse at all).
function curseAllowsPlacement(shapeName, orientationIndex, r0, c0) {
  if (state.mode !== 'curse' || state.curseActive !== 'noborder') return true;
  return curseNoBorderAllows(shapeName, orientationIndex, r0, c0);
}

// A blight-spot cell (board value 2) is permanently unplaceable, same as a
// literal empty cell for the purpose of "how tightly did you pack the
// board" - it counts AGAINST the player, not for them. Counting only
// val===0 would have let a blight spot quietly shrink the open-square
// total (since it's no longer literally empty), rewarding the very curse
// that's supposed to be a handicap. Curse's board only ever holds 0
// (empty), 1 (placed), or 2 (blight spot), so "not player-placed" and
// "empty or blighted" are exactly the same set of cells.
function countCurseOpenSquares(board) {
  return board.reduce((n, v) => n + (v !== 1 ? 1 : 0), 0);
}

function finishCurseRun(illegal) {
  state.running = false;
  state.finished = true;
  state.failed = false;
  state.illegalMove = illegal;
  render();
  saveCurseScoreIfBest(countCurseOpenSquares(state.board));
  if (onRoundFinished) onRoundFinished();
}

// ---------- Piece supply ----------
function drawWeightedPiece() {
  const roll = rng();
  const pool = roll < 0.70 ? PENTOMINO_NAMES : roll < 0.90 ? TETROMINO_NAMES : TROMINO_NAMES;
  return pool[Math.floor(rng() * pool.length)];
}

// Mutation only: tromino (3) through heptomino (7) - monomino/domino are
// excluded from the pool entirely (see MUTATION_SIZE_POOLS's own comment),
// not just downweighted, since a 1x1/1x2 piece could always plug almost
// any gap and made packing the board trivially easy. Size is picked with
// weight proportional to the size itself (weight 3 for tromino, ... 7 for
// heptomino, out of a 25 total) - larger pieces are still proportionally
// more common, a tromino is the rarest draw at 3/25 (12%) while a
// heptomino is the most common at 7/25 (28%). A random shape is then
// picked within that size - not a uniform draw across all individual
// shapes, which would have swamped the board in heptominoes even harder
// (108 of them vs. only 2 trominoes).
const MUTATION_SIZE_WEIGHTS = [[3, 3], [4, 4], [5, 5], [6, 6], [7, 7]]; // [size, weight]
const MUTATION_SIZE_WEIGHT_TOTAL = MUTATION_SIZE_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
function drawMutationPiece() {
  let roll = rng() * MUTATION_SIZE_WEIGHT_TOTAL;
  let size = MUTATION_SIZE_WEIGHTS[MUTATION_SIZE_WEIGHTS.length - 1][0];
  for (const [candidateSize, weight] of MUTATION_SIZE_WEIGHTS) {
    if (roll < weight) { size = candidateSize; break; }
    roll -= weight;
  }
  const pool = MUTATION_SIZE_POOLS[size];
  return pool[Math.floor(rng() * pool.length)];
}

// Blind Eogonim only: re-rolls on a repeat of the immediately previous
// shape. With placed pieces genuinely invisible, drawing the same shape
// twice in a row looks identical to "my click did nothing" - same outline
// shown, no visible board change either way - so this rules that out
// entirely. Keeps the same 70/20/10 category weighting for everything
// else; excludeName is only ever one of ~19 shapes, so this always
// terminates quickly. excludeName = null (the very first piece of a run)
// never matches anything, so this behaves exactly like drawWeightedPiece().
function drawWeightedPieceExcluding(excludeName) {
  let shapeName;
  do {
    shapeName = drawWeightedPiece();
  } while (shapeName === excludeName);
  return shapeName;
}

// Ascension-only: same 70/20/10 category weighting as drawWeightedPiece(),
// but scoped to a caller-supplied pool of still-available shapes (already-
// unlocked ones excluded) - falls back to whichever category still has
// anything left if the weighted-roll's own category is empty, so this
// always returns something as long as `available` is non-empty.
function drawWeightedPieceFrom(available) {
  const avail = (names) => names.filter((n) => available.includes(n));
  const availPent = avail(PENTOMINO_NAMES);
  const availTetra = avail(TETROMINO_NAMES);
  const availTri = avail(TROMINO_NAMES);
  const roll = Math.random();
  let pool = roll < 0.70 ? availPent : roll < 0.90 ? availTetra : availTri;
  if (pool.length === 0) pool = availPent.length ? availPent : availTetra.length ? availTetra : availTri;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Offers up to 3 distinct shapes the player hasn't already unlocked. Scoped
// to ALL_SHAPE_NAMES (the original 19 curated pentomino/tetromino/tromino
// shapes), NOT every key in BASE_SHAPES - that object also now holds
// Mutation mode's full monomino/domino/hexomino/heptomino sets, which
// Ascension was never designed around and shouldn't suddenly start
// offering.
function rollPieceChoices() {
  const remaining = ALL_SHAPE_NAMES.filter((n) => !state.unlockedShapes.includes(n));
  const choices = [];
  while (choices.length < 3 && remaining.length > 0) {
    const pick = drawWeightedPieceFrom(remaining);
    choices.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return choices;
}

// Round score thresholds: 10, 15, 18, then +2 every round after that
// (20, 22, 24, ...) - see the plan/user spec for why these specific numbers.
function ascensionThreshold(round) {
  if (round === 1) return 10;
  if (round === 2) return 15;
  return 18 + (round - 3) * 2;
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

// Blight's scoring - same flood fill as computeCapturedCount(), but dead
// squares (board value 2) poison a region instead of scoring it: a region
// only counts if it borders your own pieces AND never borders a dead
// square, mirroring how a real match's computeFinalScores() only scores a
// region bordered by exactly one owner (here, "the other owner" is dead
// squares standing in for an opponent). A region bordered by nothing at
// all, or only dead squares, is never yours - this is what guarantees the
// score starts at 0 even though dead squares already exist on turn one.
// Also returns every cell index that's part of a captured region, so
// spawnDeadCell() can keep new dead squares out of territory you've
// already secured (see its own comment).
function computeBlightRegions(board) {
  const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  let score = 0;
  const capturedCells = new Set();
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0 && !visited[i]) {
      const region = [i];
      visited[i] = 1;
      let qi = 0;
      let touchesPlayer = false;
      let touchesDead = false;
      while (qi < region.length) {
        const cur = region[qi++];
        const r = Math.floor(cur / BOARD_SIZE), c = cur % BOARD_SIZE;
        for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
          if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
          const nidx = idx(nr, nc);
          if (board[nidx] === 0) {
            if (!visited[nidx]) { visited[nidx] = 1; region.push(nidx); }
          } else if (board[nidx] === 1) {
            touchesPlayer = true;
          } else {
            touchesDead = true;
          }
        }
      }
      if (touchesPlayer && !touchesDead) {
        score += region.length;
        for (const cellIdx of region) capturedCells.add(cellIdx);
      }
    }
  }
  return { score, capturedCells };
}

// Picks one random still-empty (0) square that ISN'T part of already-
// captured territory and marks it dead (2) - used both for the 5 starting
// dead squares (startRun(), no exclusions needed since nothing's captured
// yet) and the one more that spawns after every placement
// (commitPlacement(), passing the capturedCells set computeBlightRegions()
// just computed). No-ops if there's nowhere eligible left, including the
// edge case where every remaining empty cell happens to already be
// captured - dead squares never invade secured territory, full stop, even
// if that means skipping a spawn this turn.
function spawnDeadCell(excludeCells) {
  const emptyCells = [];
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === 0 && !(excludeCells && excludeCells.has(i))) emptyCells.push(i);
  }
  if (emptyCells.length === 0) return;
  const pick = emptyCells[Math.floor(rngSecondary() * emptyCells.length)];
  state.board[pick] = 2;
}

// ---------- Shrink mode ----------
// No flood-fill/enclosure concept at all - score is simply how many squares
// never got a piece on them (open or voided, both count the same way),
// mirroring countCurseOpenSquares()'s exact "not player-placed" tally.
// Lower is better; the goal is just to physically pack the board as tight
// as possible before you get stuck, same as Curse's own framing.
function countShrinkOpenSquares(board) {
  return board.reduce((n, v) => n + (v !== 1 ? 1 : 0), 0);
}

// Every 4th piece placed, the border shrinks by one ring on every side. A
// placed piece is the only thing ever safe - it's already non-zero, so it
// was never a candidate here in the first place; every still-empty ring
// cell (whether it looked "safe" a moment ago or not) is swallowed, which is
// exactly what makes the walls actually close in. Clamped so it never runs
// past the board's own center (a no-op safety net - in practice the run
// always ends via "no legal placement" long before this).
function applyShrinkRing() {
  if (state.shrinkRingDepth >= Math.floor(BOARD_SIZE / 2)) return;
  const depth = state.shrinkRingDepth;
  const far = BOARD_SIZE - 1 - depth;
  for (let i = 0; i < BOARD_SIZE; i++) {
    for (const cellIdx of [idx(depth, i), idx(far, i), idx(i, depth), idx(i, far)]) {
      if (state.board[cellIdx] === 0) state.voidMask[cellIdx] = 1;
    }
  }
}

// ---------- Mutation mode ----------
// Same "no flood-fill/enclosure" scoring as Shrink/Curse - board only ever
// holds 0 (empty) or 1 (placed), no voidMask/dead-square wrinkle here, so
// this is just the plain open-cell tally. Lower is better; unlike Shrink, a
// perfect 0 IS possible here (nothing ever permanently closes off a
// square), since a monomino can always plug a lone 1-cell gap - it just
// takes the right piece showing up at the right time.
function countMutationOpenSquares(board) {
  return board.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
}

// ---------- Puzzle mode ----------
// The board shape is generated by solving it FIRST, then hiding the
// solution: every one of the 10 hand pieces (drawGodbotHand()'s same real-
// match composition - 7 pentominoes, 2 tetrominoes, 1 tromino) is placed,
// one at a time in a random shuffle order and a random orientation, onto
// an initially-empty working grid at a randomly-chosen legal position -
// the union of every placed cell becomes the puzzle's actual playable
// shape (voidMask marks everything else permanently unplaceable, same
// convention Shrink's ring-shrink already established). The grid itself is
// then thrown away - only its shape (voidMask) survives - so the player
// has to find their own way to refill it; any valid tiling counts, not
// just the one generated here.
//
// Most placements (see PUZZLE_CONNECT_CHANCE below) are required to touch
// an already-placed cell, growing a single connected blob the way a real
// jigsaw would - but a fraction of the time (and always for the very first
// piece), a placement is allowed to land anywhere else on the grid with no
// adjacency requirement at all, seeding a brand new, separate pocket.
// That's what produces the "non-continuous pockets" a generated board can
// end up with - some runs stay one connected blob, others end up with 2-3
// separate islands, depending on how those rolls land.
const PUZZLE_CONNECT_CHANCE = 0.8;

// Every cell of shapeName/orientationIndex placed at (r0, c0), or null if
// any of them fall off the board - deliberately does NOT check state.board
// or state.voidMask (unlike isValidPlacement()), since this runs against a
// scratch working grid during generation, before either of those is even
// meaningful for this round yet.
function puzzleShapeCellsAt(shapeName, orientationIndex, r0, c0) {
  const cells = [];
  for (const [dr, dc] of ORIENTATIONS[shapeName][orientationIndex]) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return null;
    cells.push(r * BOARD_SIZE + c);
  }
  return cells;
}

// True if any cell of a candidate placement is orthogonally adjacent to an
// already-filled cell of the working grid - what "growing the blob" means
// during generation.
function gridTouchesFilled(grid, cells) {
  for (const cellIdx of cells) {
    const r = Math.floor(cellIdx / BOARD_SIZE), c = cellIdx % BOARD_SIZE;
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      if (grid[nr * BOARD_SIZE + nc]) return true;
    }
  }
  return false;
}

// One full attempt at solving a board for `hand` - returns the resulting
// working grid (1 = part of the puzzle's playable shape), or null if a
// piece got stuck with nowhere at all left to go (see
// generatePuzzleVoidMask()'s retry loop, which is what actually calls
// this). connectChance = 0 disables the "must touch the existing blob"
// requirement entirely, used only as a last-resort fallback.
function tryBuildPuzzleLayout(hand, connectChance) {
  const grid = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  const shuffled = [...hand].sort(() => rng() - 0.5);

  for (let i = 0; i < shuffled.length; i++) {
    const shapeName = shuffled[i];
    const requireTouch = i > 0 && rng() < connectChance;
    const collectCandidates = (needTouch) => {
      const found = [];
      for (let oi = 0; oi < ORIENTATIONS[shapeName].length; oi++) {
        for (let r0 = 0; r0 < BOARD_SIZE; r0++) {
          for (let c0 = 0; c0 < BOARD_SIZE; c0++) {
            const cells = puzzleShapeCellsAt(shapeName, oi, r0, c0);
            if (!cells) continue;
            if (cells.some((cellIdx) => grid[cellIdx])) continue;
            if (needTouch && !gridTouchesFilled(grid, cells)) continue;
            found.push(cells);
          }
        }
      }
      return found;
    };

    let candidates = collectCandidates(requireTouch);
    // A connected placement wasn't available this attempt (can happen late
    // in a crowded layout) - fall back to any legal spot at all rather than
    // failing the whole layout over a cosmetic preference.
    if (candidates.length === 0 && requireTouch) candidates = collectCandidates(false);
    if (candidates.length === 0) return null;

    const chosen = candidates[Math.floor(rng() * candidates.length)];
    for (const cellIdx of chosen) grid[cellIdx] = 1;
  }
  return grid;
}

function gridToVoidMask(grid) {
  const voidMask = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) voidMask[i] = grid[i] ? 0 : 1;
  return voidMask;
}

// Regenerates a voidMask by solving a fresh layout for `hand`, retrying
// with a new random shuffle/orientation order up to 30 times in the rare
// case tryBuildPuzzleLayout() paints itself into a corner - a full 10-
// piece hand (~46 cells) is sparse enough on a 144-cell board that this
// should succeed on close to the first try in practice. If every attempt
// somehow still fails, one final try with connectChance = 0 (no adjacency
// requirement at all) is virtually guaranteed to succeed, just possibly as
// a less visually "blobby" shape than usual.
function generatePuzzleVoidMask(hand) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const grid = tryBuildPuzzleLayout(hand, PUZZLE_CONNECT_CHANCE);
    if (grid) return gridToVoidMask(grid);
  }
  const fallback = tryBuildPuzzleLayout(hand, 0);
  return fallback ? gridToVoidMask(fallback) : new Uint8Array(BOARD_SIZE * BOARD_SIZE);
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
  // A void cell (shrink only - state.voidMask is all-zero everywhere else)
  // can never be filled, so it shouldn't block "complete" either.
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === 0 && !state.voidMask[i]) return false;
  }
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
  if (state.mode === 'ascension') {
    state.round = 1;
    state.unlockedShapes = [];
  }
  if (state.mode === 'blight') {
    for (let i = 0; i < 5; i++) spawnDeadCell();
  }
  if (state.mode === 'godbot') {
    state.gbHand = drawGodbotHand();
    state.gbTurn = 'player';
  }
  if (state.mode === 'puzzle') {
    state.startTime = Date.now();
    startTimerTick();
  }
  state.running = true;
  if (state.mode === 'ascension') {
    showPieceChoice();
  } else if (state.mode === 'godbot') {
    // No "current piece" to spawn - the player picks one of their own hand
    // pieces (see selectGodbotHandPiece()) rather than being handed one.
  } else if (state.mode === 'puzzle') {
    // Same idea as GodBot above, plus this is what actually builds round
    // 1's hand/board (resetBoardState() just ran, so voidMask is still
    // all-zero at this point).
    startPuzzleRound(1);
  } else {
    spawnNextPiece();
  }
  render();
}

// Speedrun pulls the current piece from the front of the lookahead queue and
// refills the back of it, so the next LOOKAHEAD_COUNT pieces are always
// visible in advance. Eogonim has no preview at all - each piece is drawn
// fresh, right when it's handed to you. Ascension draws randomly from
// whichever shapes are currently unlocked, but only from among the ones
// that actually have a legal placement right now - so the player is never
// handed something unplaceable while an unlocked alternative would fit; the
// round only ends once literally none of them do.
function spawnNextPiece() {
  if (state.mode === 'ascension') {
    const placeable = state.unlockedShapes.filter((s) => hasAnyLegalMove(s, state.board));
    if (placeable.length === 0) {
      evaluateRoundEnd();
      return;
    }
    const shapeName = placeable[Math.floor(Math.random() * placeable.length)];
    state.selected = { shapeName, orientationIndex: 0 };
    recomputeHover();
    render();
    return;
  }

  const shapeName = state.mode === 'speedrun' ? state.pieceQueue.shift()
    : state.mode === 'blindeogonim' ? drawWeightedPieceExcluding(state.lastDrawnShape)
    : state.mode === 'mutation' ? drawMutationPiece()
    : drawWeightedPiece();
  if (state.mode === 'speedrun') state.pieceQueue.push(drawWeightedPiece());
  state.lastDrawnShape = shapeName;
  state.selected = { shapeName, orientationIndex: 0 };
  if (!hasAnyLegalMove(shapeName, state.board)) {
    recomputeHover();
    if (state.mode === 'speedrun') failRun();
    else if (state.mode === 'blindeogonim') finishBlindEogonimRun(false);
    else if (state.mode === 'blight') finishBlightRun();
    else if (state.mode === 'curse') finishCurseRun(false);
    else if (state.mode === 'shrink') finishShrinkRun();
    else if (state.mode === 'mutation') finishMutationRun();
    else finishEogonimRun();
    return;
  }
  // Only rolled once the piece is confirmed placeable at all (see
  // rollCurse()'s own comment) - curseActive has to be set before
  // recomputeHover() below, since curseAllowsPlacement() (used inside it)
  // reads it.
  if (state.mode === 'curse') state.curseActive = rollCurse(shapeName, state.board);
  recomputeHover();
  render();
}

function commitPlacement(r0, c0) {
  // GodBot's turn-based, hand-of-many flow is different enough from every
  // other mode's one-piece-at-a-time loop below that it gets its own
  // dedicated dispatch, same idea as Ascension's separate run-flow section.
  if (state.mode === 'godbot') { godbotCommitPlacement(r0, c0); return; }
  // Puzzle's hand-of-many-but-not-turn-based flow gets the same treatment,
  // for the same reason (see puzzleCommitPlacement()'s own comment).
  if (state.mode === 'puzzle') { puzzleCommitPlacement(r0, c0); return; }
  const { shapeName, orientationIndex } = state.selected;
  if (!isValidPlacement(shapeName, orientationIndex, r0, c0, state.board)) return;
  if (!curseAllowsPlacement(shapeName, orientationIndex, r0, c0)) return;

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
  // pieces); eogonim/blindeogonim/ascension score like a real Minogoe match
  // instead - pieces stay put forever, so the "captured" total (ascension's
  // current ROUND score) is just recomputed fresh here for the live
  // display, with no board mutation at all. Blight uses its own dead-square-
  // aware scoring, and additionally spawns this placement's one new dead
  // square right here, AFTER scoring (so the just-placed piece's own
  // capture reflects only that placement) and BEFORE the board-complete/
  // next-piece checks below (so a dead square landing in the last open gap
  // can itself end the run, same as the player's own placement can).
  if (state.mode === 'speedrun') {
    runCaptureCascade();
  } else if (state.mode === 'blight') {
    const blightRegions = computeBlightRegions(state.board);
    state.totalCaptured = blightRegions.score;
    spawnDeadCell(blightRegions.capturedCells);
  } else if (state.mode === 'curse') {
    // No captured-territory tally needed here - the score is just leftover
    // empty cells, read fresh off the board wherever it's displayed/saved.
    // The blight-spot curse's one square is spawned right here, same timing
    // as Blight mode's own (after this placement, before the board-complete
    // check below, so it can itself end the run by filling the last gap).
    if (state.curseActive === 'blightspot') spawnDeadCell();
  } else if (state.mode === 'shrink') {
    // No captured-territory tally needed here either (same reasoning as
    // Curse above) - score is just leftover open/void squares, read fresh
    // wherever it's displayed/saved.
    state.shrinkPieceCount++;
    state.totalCaptured = countShrinkOpenSquares(state.board);
    // Every 4th placement, one ring shrinks in - BEFORE the board-complete/
    // next-piece checks below, same timing Blight's dead-square spawn
    // already uses, so a ring landing on the last open gap can itself end
    // the run.
    if (state.shrinkPieceCount % 4 === 0) {
      applyShrinkRing();
      state.shrinkRingDepth++;
    }
  } else if (state.mode === 'mutation') {
    // No captured-territory tally here either - same reasoning as Curse/
    // Shrink above, just without either mode's extra wrinkle (no voidMask,
    // no dead squares).
    state.totalCaptured = countMutationOpenSquares(state.board);
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
    } else if (state.mode === 'eogonim') {
      finishEogonimRun();
    } else if (state.mode === 'blindeogonim') {
      finishBlindEogonimRun(false);
    } else if (state.mode === 'blight') {
      finishBlightRun();
    } else if (state.mode === 'curse') {
      finishCurseRun(false);
    } else if (state.mode === 'shrink') {
      finishShrinkRun();
    } else if (state.mode === 'mutation') {
      finishMutationRun();
    } else {
      // A completely full board is just a special case of "nothing fits
      // anywhere" for ascension too - same round-end evaluation either way.
      evaluateRoundEnd();
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
  if (onRoundFinished) onRoundFinished();
}

function finishRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  state.finalTimeMs = Date.now() - state.startTime;
  stopTimerTick();
  render();
  saveScoreIfBest(state.finalTimeMs);
  if (onRoundFinished) onRoundFinished();
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
  if (onRoundFinished) onRoundFinished();
}

// Same "no separate failed ending" shape as Eogonim - running out of legal
// placements (increasingly likely as dead squares pile up) and filling the
// board are both just "the run is over," scored the same way either way.
function finishBlightRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  render();
  saveBlightScoreIfBest(state.totalCaptured);
  if (onRoundFinished) onRoundFinished();
}

// Blind Eogonim's run always ends one of two ways: the normal Eogonim
// ending (out of legal placements, or the board filled up), or a click on
// an occupied-but-invisible square (illegal = true). Either way the score
// is the same "however much you'd captured so far" - the illegal-move case
// just cuts the run short at whatever point that happened, the same way a
// misremembered piece naturally would.
function finishBlindEogonimRun(illegal) {
  state.running = false;
  state.finished = true;
  state.failed = false;
  state.illegalMove = illegal;
  render();
  saveBlindEogonimScoreIfBest(state.totalCaptured);
}

// Same "no separate failed ending" shape as Eogonim/Blight - running out of
// legal placements (guaranteed eventually, as the border keeps shrinking)
// and filling the remaining live board are both just "the run is over."
// Score is squares never filled by a piece (open or voided, both count) -
// a perfect 0 is impossible, since the shrink always claims some squares
// before you can ever cover the whole original board.
function finishShrinkRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  render();
  saveShrinkScoreIfBest(state.totalCaptured);
  if (onRoundFinished) onRoundFinished();
}

// Same "no separate failed ending" shape as Shrink/Curse - running out of
// legal placements and filling the board completely (a genuine 0-score
// win) are both just "the run is over," scored the same way either way.
function finishMutationRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  render();
  saveMutationScoreIfBest(state.totalCaptured);
  if (onRoundFinished) onRoundFinished();
}

// ---------- GodBot mode ----------
// A real match against the bot on a real (12x12) board, with a real 10-piece
// hand for the player - but the bot can place any of the 19 distinct shapes,
// unlimited supply (ALL_SHAPE_NAMES, never depleted), and gets a bonus
// action every single turn on top of its own normal placement, one of:
// go again (place a second time immediately), delete one of the player's
// placed pieces, blight one of the player's secured territories (poisons
// the whole region's scoring, same idea as Blight mode's dead squares -
// see pickGodbotBlightTarget()), or reroll the player's remaining hand for
// an equal number of fresh random pieces. Final score is the player's real
// territory minus the bot's (computeGodbotFinalScores()) - higher is
// better, negative is the common/expected outcome.
//
// The bot's move-selection heuristic (godbotScoreCandidate/
// computeGodbotTrustedScores/godbotOpponentCanReachRegion/
// godbotBoundedRegionSize) is a trimmed port of game.js's real "vs Bot" AI
// (territory-delta + seal-progress scoring) - deliberately dropping its
// mirror-defense logic (isBoardSymmetric/opponentIsMirroring), which only
// matters when both sides share an identical hand, not true here.

const REGION_SIZE_CAP = 8; // see game.js's own copy of this same constant for the full reasoning

function removeOnePiece(hand, shapeName) {
  const i = hand.indexOf(shapeName);
  if (i === -1) return hand;
  const copy = hand.slice();
  copy.splice(i, 1);
  return copy;
}

function handHasAnyLegalMove(hand, board) {
  const distinct = new Set(hand);
  for (const shapeName of distinct) if (hasAnyLegalMove(shapeName, board)) return true;
  return false;
}

function enumerateLegalPlacementsFor(shapeNames, board) {
  const distinct = new Set(shapeNames);
  const placements = [];
  for (const shapeName of distinct) {
    for (let orientationIndex = 0; orientationIndex < ORIENTATIONS[shapeName].length; orientationIndex++) {
      const orientation = ORIENTATIONS[shapeName][orientationIndex];
      const maxDr = Math.max(...orientation.map((p) => p[0]));
      const maxDc = Math.max(...orientation.map((p) => p[1]));
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

function sealTierBonus(openSides) {
  if (openSides === 1) return 5;
  if (openSides === 2) return 2;
  if (openSides === 3) return 0.5;
  return 0;
}

function godbotBoundedRegionSize(simBoard, startIdx, opponent, cap) {
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

function godbotOpponentCanReachRegion(board, regionCells, opponentHand) {
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
      const maxDr = Math.max(...orientation.map((p) => p[0]));
      const maxDc = Math.max(...orientation.map((p) => p[1]));
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

function computeGodbotTrustedScores(board, hand1, hand2) {
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
        if (!godbotOpponentCanReachRegion(board, regionCells, invaderHand)) {
          if (owner === 1) trusted1 += regionCells.length;
          else trusted2 += regionCells.length;
        }
      }
    }
  }
  return { trusted1, trusted2 };
}

function godbotScoreCandidate(candidate, board, player) {
  const opponent = player === 1 ? 2 : 1;
  const orientation = ORIENTATIONS[candidate.shapeName][candidate.orientationIndex];
  const simBoard = board.slice();
  const cells = [];
  for (const [dr, dc] of orientation) {
    const cell = idx(candidate.r0 + dr, candidate.c0 + dc);
    simBoard[cell] = player;
    cells.push(cell);
  }
  // The player's hand really does shrink (removeOnePiece reflects that this
  // candidate's own piece is no longer available); the bot's "hand" is
  // ALL_SHAPE_NAMES every single time, modeling unlimited access rather than
  // depleting anything.
  const hand1ForTrust = player === 1 ? removeOnePiece(state.gbHand, candidate.shapeName) : state.gbHand;
  const hand2ForTrust = ALL_SHAPE_NAMES;
  const { trusted1, trusted2 } = computeGodbotTrustedScores(simBoard, hand1ForTrust, hand2ForTrust);
  const myScore = player === 1 ? trusted1 : trusted2;
  const oppScore = player === 1 ? trusted2 : trusted1;
  const territoryDelta = myScore - oppScore;

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
        if (nr2 < 0 || nr2 >= BOARD_SIZE || nc2 < 0 || nc2 >= BOARD_SIZE) continue;
        if (simBoard[idx(nr2, nc2)] === 0) openSides++;
      }
      const region = godbotBoundedRegionSize(simBoard, nidx, opponent, REGION_SIZE_CAP);
      if (!region.touchesOpponent && !region.capped) {
        const sizeFactor = 1 - (region.size - 1) / REGION_SIZE_CAP;
        sealProgress += sealTierBonus(openSides) * sizeFactor;
      }
    }
  }

  return territoryDelta * 1000 + sealProgress + cornerTouches * 3 + edgeTouches * 0.5 + ownAdj * 2 - oppAdj * 1.5 + rngSecondary() * 0.5;
}

function pickGodbotPlacement(hand, board, player) {
  const placements = enumerateLegalPlacementsFor(hand, board);
  if (placements.length === 0) return null;
  let best = null, bestScore = -Infinity;
  for (const cand of placements) {
    const s = godbotScoreCandidate(cand, board, player);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  return best;
}

// Real end-of-run scoring - same mono-owner flood-fill rule as an actual
// match's computeFinalScores() (a region counts for whoever's the ONLY
// owner bordering it; a region touching both, or neither, is undecided).
// Also reused by pickGodbotRemovalTarget() below to evaluate "how much of
// the player's currently-secured score would deleting this exact piece
// destroy" against the real current board - a direct, immediate question,
// unlike the forward-looking "trusted" heuristic pickGodbotPlacement() uses
// to decide WHERE to place next.
function computeGodbotFinalScores(board) {
  const visited = new Uint8Array(board.length);
  let score1 = 0, score2 = 0;
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
        if (owner === 1) score1 += regionCells.length; else score2 += regionCells.length;
      }
    }
  }
  return { score1, score2 };
}

// Picks whichever of the player's currently-placed pieces, if deleted,
// would cost the player the most real secured score right now. Returns null
// if the player has no pieces on the board yet, or if no removal would
// actually cost them anything (nothing secured yet to sabotage) - that's
// what keeps this option out of godbotRunBotTurn()'s random pool until
// there's actually something worth removing. Ties broken randomly. The
// returned damage figure isn't currently used for anything beyond that
// null/non-null gate (the bot's bonus action is picked uniformly at random
// among whichever options apply, not by comparing damage sizes).
function pickGodbotRemovalTarget() {
  const playerPieceIds = [...state.pieceOwner.entries()].filter(([, owner]) => owner === 1).map(([id]) => id);
  if (playerPieceIds.length === 0) return null;
  const currentScore = computeGodbotFinalScores(state.board).score1;
  let bestDamage = 0;
  let tied = [];
  for (const id of playerPieceIds) {
    const testBoard = state.board.slice();
    for (const cell of state.pieceCells.get(id)) testBoard[cell] = 0;
    const damage = currentScore - computeGodbotFinalScores(testBoard).score1;
    if (damage > bestDamage) { bestDamage = damage; tied = [id]; }
    else if (damage === bestDamage && damage > 0) { tied.push(id); }
  }
  if (bestDamage <= 0) return null;
  return { id: tied[Math.floor(rngSecondary() * tied.length)], damage: bestDamage };
}

function godbotRemovePiece(pieceId) {
  for (const cell of state.pieceCells.get(pieceId)) {
    state.board[cell] = 0;
    state.pieceIdAt[cell] = 0;
  }
  state.pieceCells.delete(pieceId);
  state.pieceOwner.delete(pieceId);
}

// Finds the player's largest currently-secured region (a mono-owner=1
// empty pocket, same flood fill computeGodbotFinalScores() itself uses)
// and drops a permanent blight marker (board value 3 - deliberately a
// THIRD distinct value, never player/bot) on one random cell inside it.
// This needs no special-casing anywhere else: every existing flood fill in
// this section (computeGodbotFinalScores, computeGodbotTrustedScores,
// godbotBoundedRegionSize, godbotOpponentCanReachRegion) already treats any
// non-zero board value as "not empty" for placement/traversal purposes and
// folds it into a generic borderOwners Set for scoring - a region bordering
// both owner 1 and owner 3 has borderOwners.size 2, so it's automatically
// undecided (poisoned) exactly like Blight mode's dead squares poison a
// region there, without computeGodbotFinalScores itself needing to know
// blight markers exist at all. Returns null if the player has nothing
// secured yet to target - same as pickGodbotRemovalTarget(), that's what
// keeps this option out of godbotRunBotTurn()'s random pool until there's
// something worth blighting.
function pickGodbotBlightTarget() {
  const visited = new Uint8Array(state.board.length);
  let bestCell = null;
  let bestDamage = 0;
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === 0 && !visited[i]) {
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
          const val = state.board[nidx];
          if (val === 0) {
            if (!visited[nidx]) { visited[nidx] = 1; regionCells.push(nidx); }
          } else {
            borderOwners.add(val);
          }
        }
      }
      if (borderOwners.size === 1 && [...borderOwners][0] === 1 && regionCells.length > bestDamage) {
        bestDamage = regionCells.length;
        bestCell = regionCells[Math.floor(rngSecondary() * regionCells.length)];
      }
    }
  }
  if (bestCell === null) return null;
  return { cell: bestCell, damage: bestDamage };
}

// Rerolls the player's remaining hand for an equal number of fresh random
// pieces (the same 70/20/10 category weighting every other piece draw in
// this file uses) - deliberately NOT the original 7/2/1 composition, since
// a partially-played hand's remaining count rarely divides evenly into
// that ratio anyway. A hand of N pieces always rerolls into exactly N new
// ones, per the user's own spec ("if you only have 6 left, you only get 6
// new ones").
function godbotRerollHand() {
  const count = state.gbHand.length;
  state.gbHand = [];
  for (let i = 0; i < count; i++) state.gbHand.push(drawWeightedPiece());
}

function godbotApplyPlacement(candidate, player) {
  const id = state.nextPieceId++;
  const cells = [];
  for (const [dr, dc] of ORIENTATIONS[candidate.shapeName][candidate.orientationIndex]) {
    const cell = idx(candidate.r0 + dr, candidate.c0 + dc);
    state.board[cell] = player;
    state.pieceIdAt[cell] = id;
    cells.push(cell);
  }
  state.pieceCells.set(id, cells);
  state.pieceOwner.set(id, player);
}

// Called by clicking a hand piece (see renderGodbotHand()) - selects it the
// same way spawnNextPiece() does for every other mode, just sourced from
// the player's own remaining hand instead of being handed one at random.
function selectGodbotHandPiece(shapeName) {
  if (state.mode !== 'godbot' || !state.running || state.gbTurn !== 'player') return;
  state.selected = { shapeName, orientationIndex: 0 };
  recomputeHover();
  render();
}

function godbotCommitPlacement(r0, c0) {
  if (state.gbTurn !== 'player' || !state.selected) return;
  const { shapeName, orientationIndex } = state.selected;
  if (!isValidPlacement(shapeName, orientationIndex, r0, c0, state.board)) return;

  godbotApplyPlacement({ shapeName, orientationIndex, r0, c0 }, 1);
  state.gbHand.splice(state.gbHand.indexOf(shapeName), 1);
  state.selected = null;
  state.hover = null;
  state.gbTurn = 'bot';
  state.gbLastPowerup = null;
  render();

  setTimeout(godbotRunBotTurn, 500);
}

// The bot's own turn: its one normal placement, then - after a short pause,
// so the two sub-actions read as distinct turns rather than an instant
// double-move - its bonus action, picked uniformly at random from whichever
// of the 4 options actually apply this turn. "Go again" and "reroll hand"
// are always available; "remove a piece" and "blight a territory" only
// join the pool when they'd actually cost the player something (see
// pickGodbotRemovalTarget()/pickGodbotBlightTarget()'s own comments) - so
// early in a run, before anything's secured, the bot can only go again or
// reroll, but once there's real territory to attack, all 4 are equally
// likely rather than the strongest sabotage always winning.
function godbotRunBotTurn() {
  if (!state.running || state.mode !== 'godbot') return;
  const normalMove = pickGodbotPlacement(ALL_SHAPE_NAMES, state.board, 2);
  if (normalMove) godbotApplyPlacement(normalMove, 2);
  render();

  setTimeout(() => {
    if (!state.running || state.mode !== 'godbot') return;
    const removalTarget = pickGodbotRemovalTarget();
    const blightTarget = pickGodbotBlightTarget();

    // Duel mode: each duelling client plays GodBot on its OWN independent
    // board (not a shared one), so which of the 4 bonus actions are even
    // eligible ('remove'/'blight' only apply once something's actually
    // worth targeting) can differ client to client the moment the two
    // boards diverge - exactly the same problem rollCurse() solves above.
    // Draw from the full, always-4-option list at a shared position so
    // both clients land on the same NAMED action on the same turn (per the
    // user's "GodBot selects the same powerups on the same turns" spec),
    // then fall back to 'again' (always legal) if that action doesn't
    // currently apply on this client's own board - a substitution that
    // consumes zero extra draws.
    let choice;
    if (state.duelMode) {
      choice = GODBOT_POWERUPS[Math.floor(rngSecondary() * GODBOT_POWERUPS.length)];
      if (choice === 'remove' && !removalTarget) choice = 'again';
      if (choice === 'blight' && !blightTarget) choice = 'again';
    } else {
      const options = ['again', 'reroll'];
      if (removalTarget) options.push('remove');
      if (blightTarget) options.push('blight');
      choice = options[Math.floor(Math.random() * options.length)];
    }

    if (choice === 'remove') {
      godbotRemovePiece(removalTarget.id);
    } else if (choice === 'blight') {
      state.board[blightTarget.cell] = 3;
    } else if (choice === 'again') {
      const againMove = pickGodbotPlacement(ALL_SHAPE_NAMES, state.board, 2);
      if (againMove) godbotApplyPlacement(againMove, 2);
    } else {
      godbotRerollHand();
    }
    state.gbLastPowerup = choice;
    godbotEndBotTurn();
  }, 500);
}

function godbotEndBotTurn() {
  state.gbTurn = 'player';
  state.selected = null;
  state.hover = null;
  if (!handHasAnyLegalMove(state.gbHand, state.board)) {
    godbotFinishRun();
    return;
  }
  render();
}

function godbotFinishRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  const { score1, score2 } = computeGodbotFinalScores(state.board);
  state.godbotScore1 = score1;
  state.godbotScore2 = score2;
  render();
  saveGodbotScoreIfBest(score1 - score2);
  if (onRoundFinished) onRoundFinished();
}

// ---------- Ascension run flow ----------

// Shown at the very start of a run and again after every round pass -
// state.running stays true throughout (so Restart/tab-disabling behave the
// same as mid-placement), it's just a different interactive state than
// actually placing pieces on the board.
function showPieceChoice() {
  state.pieceChoices = rollPieceChoices();
  state.awaitingPieceChoice = true;
  state.selected = null;
  state.hover = null;
  render();
}

// Called when the player clicks one of the offered shapes, both for round 1
// (from startRun()) and every round after (from evaluateRoundEnd()).
function chooseShape(shapeName) {
  state.unlockedShapes.push(shapeName);
  resetBoardState(); // clears the board/totalCaptured for the new round - does NOT touch state.round/unlockedShapes
  state.running = true; // resetBoardState() sets this false, same re-set startRun() already does after calling it
  spawnNextPiece();
  render();
}

// Called once spawnNextPiece() finds that none of the currently-unlocked
// shapes have a legal placement anywhere (including the "board is
// completely full" case, via commitPlacement()'s isBoardComplete() check).
function evaluateRoundEnd() {
  if (state.totalCaptured >= ascensionThreshold(state.round)) {
    state.round += 1;
    showPieceChoice();
  } else {
    finishAscensionRun();
  }
}

function finishAscensionRun() {
  state.running = false;
  state.finished = true;
  state.failed = false; // no separate visual "failed" state - the dedicated ascension render() branch covers this
  render();
  saveAscensionScoreIfBest(state.round - 1); // rounds successfully CLEARED, not the round that was failed
}

// ---------- Puzzle run flow ----------

// Sets up one fresh board+hand for the given round number (1-3). Does NOT
// call resetBoardState() and does NOT touch state.startTime/finalTimeMs -
// a Puzzle run's clock needs to keep running continuously across all 3
// boards, only stopping once the third is cleared (see finishPuzzleRun()).
// Round 1 is entered via startRun() (right after its own, one-time
// resetBoardState() call); rounds 2 and 3 are entered here directly from
// puzzleCommitPlacement()'s board-complete branch.
function startPuzzleRound(round) {
  state.puzzleRound = round;
  state.board = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceIdAt = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceCells = new Map();
  state.puzzlePieceShapes = new Map();
  // Duel mode: all 3 rounds' hand+voidMask were already generated together
  // as one synchronous block (precomputeAllPuzzleRounds(), called by
  // duel.js right after the seeded rng is installed) - reuse round `round`'s
  // precomputed data instead of generating fresh here, so both duelling
  // clients see the identical board 2/3 boards even though they each reach
  // them at different real-world times.
  if (state.duelMode && state.puzzlePrecomputed) {
    const precomputed = state.puzzlePrecomputed[round - 1];
    state.puzzleHand = precomputed.hand.slice();
    state.voidMask = precomputed.voidMask.slice();
  } else {
    state.puzzleHand = drawGodbotHand(); // same real-match hand composition, reused as-is
    state.voidMask = generatePuzzleVoidMask(state.puzzleHand);
  }
  state.selected = null;
  state.hover = null;
  render();
}

// Duel-only: generates all 3 Puzzle rounds' hand+voidMask up front, as one
// synchronous block, immediately after duel.js installs the round's seeded
// rng and before either player can place a single piece. Neither
// drawGodbotHand() nor generatePuzzleVoidMask() ever reads state.board, so
// this is a pure function of the rng stream alone - running it identically
// on both clients guarantees all 3 boards match exactly, with no need to
// track how many draws generatePuzzleVoidMask()'s internal retry loop
// happened to consume.
function precomputeAllPuzzleRounds() {
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    const hand = drawGodbotHand();
    const voidMask = generatePuzzleVoidMask(hand);
    rounds.push({ hand, voidMask });
  }
  state.puzzlePrecomputed = rounds;
}

// Called by clicking a hand piece (see renderPuzzleHand()) - selects it the
// same way selectGodbotHandPiece() does, just with no turn/bot gating,
// since every piece is available to the player at once from round start.
// Clicking the ALREADY-selected piece again instead lets go of it (clears
// state.selected with no placement) - without this, a piece that doesn't
// fit anywhere among the cells you have left would be stuck attached to
// your cursor forever, since placing it is otherwise the only way to stop
// holding it.
function selectPuzzleHandPiece(shapeName) {
  if (state.mode !== 'puzzle' || !state.running) return;
  if (state.selected && state.selected.shapeName === shapeName) {
    state.selected = null;
    state.hover = null;
    render();
    return;
  }
  state.selected = { shapeName, orientationIndex: 0 };
  recomputeHover();
  render();
}

// Puzzle's own dedicated dispatch (bypassing the shared commitPlacement()
// entirely, same idea as GodBot's) - there's no totalCaptured tally and no
// "no legal move" failure state to check here at all: the player always
// holds their whole hand at once, and (per tryPuzzlePickup()'s own
// comment) can pick any placement back up, so the run can never actually
// get stuck the way a one-piece-at-a-time mode can.
function puzzleCommitPlacement(r0, c0) {
  if (!state.selected) return;
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
  state.puzzlePieceShapes.set(id, shapeName);
  state.puzzleHand.splice(state.puzzleHand.indexOf(shapeName), 1);
  state.selected = null;
  state.hover = null;

  if (isBoardComplete()) {
    if (state.puzzleRound < 3) startPuzzleRound(state.puzzleRound + 1);
    else finishPuzzleRun();
    return;
  }
  render();
}

// The ONE mode where a placement isn't final - clicking directly on an
// already-placed piece (see tryPuzzlePickup(), wired into the canvas
// click/touchstart handlers below) sends it back to the hand, freeing its
// board cells. Lets the player back out of a bad guess instead of being
// stuck with it, since unlike every other mode's one-piece-at-a-time flow,
// Puzzle hands over the whole hand up front and expects real trial and
// error to find a fit.
function removePuzzlePiece(pieceId) {
  const shapeName = state.puzzlePieceShapes.get(pieceId);
  if (!shapeName) return;
  for (const cellIdx of state.pieceCells.get(pieceId)) {
    state.board[cellIdx] = 0;
    state.pieceIdAt[cellIdx] = 0;
  }
  state.pieceCells.delete(pieceId);
  state.puzzlePieceShapes.delete(pieceId);
  state.puzzleHand.push(shapeName);
  state.selected = null;
  state.hover = null;
  render();
}

// Returns true (and performs the pickup) if (row, col) lands on an already-
// placed piece while running Puzzle mode - only ever called by the shared
// click/touchstart handlers when NOTHING is currently selected. While
// holding a piece, a click always means "try to place it here" (or a
// harmless no-op if that spot isn't valid), even if the hover happens to
// overlap an already-placed piece - otherwise a placement attempt that
// simply doesn't fit would surprise-pick-up whatever was underneath it
// instead of just failing quietly like every other mode's invalid click.
function tryPuzzlePickup(row, col) {
  if (state.mode !== 'puzzle' || !state.running) return false;
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return false;
  const cellIdx = idx(row, col);
  if (state.board[cellIdx] !== 1) return false;
  removePuzzlePiece(state.pieceIdAt[cellIdx]);
  return true;
}

function finishPuzzleRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  state.finalTimeMs = Date.now() - state.startTime;
  stopTimerTick();
  render();
  savePuzzleTimeIfBest(state.finalTimeMs);
  if (onRoundFinished) onRoundFinished();
}

// ---------- Rotation / hover ----------
function rotateSelected(reverse = false) {
  if (!state.selected) return;
  if (state.mode === 'curse' && state.curseActive === 'norotate') return;
  const len = ORIENTATIONS[state.selected.shapeName].length;
  state.selected.orientationIndex = reverse
    ? (state.selected.orientationIndex - 1 + len) % len
    : (state.selected.orientationIndex + 1) % len;
  recomputeHover();
  render();
}

// Desktop-only hotkey (F) - same approach as game.js's flipSelected(): find
// the mirrored counterpart of the CURRENT orientation by matching mirror()
// against every entry in ORIENTATIONS, rather than assuming a fixed offset
// (wrong for shapes with fewer than 8 total orientations due to symmetry-
// driven dedup in generateOrientations()). A no-op for a piece whose mirror
// is itself (fully symmetric shapes, e.g. Q_O/P_X).
function flipSelected() {
  if (!state.selected) return;
  if (state.mode === 'curse' && state.curseActive === 'norotate') return;
  const { shapeName, orientationIndex } = state.selected;
  const orientations = ORIENTATIONS[shapeName];
  const mirroredKey = JSON.stringify(mirror(orientations[orientationIndex]));
  const mirroredIndex = orientations.findIndex((o) => JSON.stringify(o) === mirroredKey);
  if (mirroredIndex === -1 || mirroredIndex === orientationIndex) return;
  state.selected.orientationIndex = mirroredIndex;
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
  state.hover = {
    r0, c0,
    valid: isValidPlacement(shapeName, orientationIndex, r0, c0, state.board) && curseAllowsPlacement(shapeName, orientationIndex, r0, c0),
  };
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
    const elapsed = formatTime(Date.now() - state.startTime);
    // Puzzle also shows which of the 3 boards is currently in progress -
    // every other user of this ticking timer (Speedrun) just shows the
    // plain elapsed time.
    document.getElementById('spTimer').textContent = state.mode === 'puzzle'
      ? `Board ${state.puzzleRound}/3 - ${elapsed}`
      : elapsed;
  }, 50);
}
function stopTimerTick() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// Duel-only: forcibly halts the current run without going through any
// mode's normal finish*Run() path (no save-to-leaderboard, no
// onRoundFinished callback) - used when a duel round has already been
// decided by something OTHER than this client's own natural finish (the
// opponent won a timed race first, a post-opponent-finish grace period
// expired, or either side forfeited the round outright) and this client's
// still-active run just needs to stop so the next round can begin (see
// beginRound()'s own "refuse to run while Engine.state.running" guard in
// duel.js, which would otherwise permanently stall this client).
function forceEndRun() {
  state.running = false;
  state.finished = true;
  stopTimerTick();
  render();
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
  // resetBoardState() deliberately leaves round/unlockedShapes alone (they
  // need to survive a mid-run round reset) - switching modes entirely is
  // the one place those need to be cleared explicitly instead.
  state.round = 1;
  state.unlockedShapes = [];
  updateModeUI();
  render();
  refreshLeaderboard();
}

// Growing past 5 near-identical ternary branches per label - lookup maps
// read a lot more clearly than an 7-way nested ternary at this point.
const MODE_TITLES = {
  speedrun: 'Speedrun', eogonim: 'Eogonim', blindeogonim: 'Blind Eogonim',
  ascension: 'Ascension', blight: 'Blight', godbot: 'GodBot', curse: 'Curse', shrink: 'Shrink',
  mutation: 'Mutation', puzzle: 'Puzzle',
};
const LEADERBOARD_TITLES = {
  speedrun: 'Top Times', eogonim: 'Lowest Scores', blindeogonim: 'Lowest Scores',
  ascension: 'Deepest Runs', blight: 'Highest Scores', godbot: 'Best Differential', curse: 'Fewest Open Squares',
  shrink: 'Lowest Losses', mutation: 'Fewest Open Squares', puzzle: 'Top Times',
};

function updateModeUI() {
  const mode = state.mode;
  document.getElementById('spTabSpeedrun').classList.toggle('active', mode === 'speedrun');
  document.getElementById('spTabEogonim').classList.toggle('active', mode === 'eogonim');
  document.getElementById('spTabBlindEogonim').classList.toggle('active', mode === 'blindeogonim');
  document.getElementById('spTabAscension').classList.toggle('active', mode === 'ascension');
  document.getElementById('spTabBlight').classList.toggle('active', mode === 'blight');
  document.getElementById('spTabGodbot').classList.toggle('active', mode === 'godbot');
  document.getElementById('spTabCurse').classList.toggle('active', mode === 'curse');
  document.getElementById('spTabShrink').classList.toggle('active', mode === 'shrink');
  document.getElementById('spTabMutation').classList.toggle('active', mode === 'mutation');
  document.getElementById('spTabPuzzle').classList.toggle('active', mode === 'puzzle');
  document.getElementById('spModeTitle').textContent = MODE_TITLES[mode];
  document.getElementById('spModeCredit').style.display = mode === 'eogonim' ? '' : 'none';
  document.getElementById('spUpcomingLabel').style.display = mode === 'speedrun' ? '' : 'none';
  document.getElementById('spUpcomingPieces').style.display = mode === 'speedrun' ? '' : 'none';
  document.getElementById('spRulesSpeedrun').style.display = mode === 'speedrun' ? '' : 'none';
  document.getElementById('spRulesEogonim').style.display = mode === 'eogonim' ? '' : 'none';
  document.getElementById('spRulesBlindEogonim').style.display = mode === 'blindeogonim' ? '' : 'none';
  document.getElementById('spRulesAscension').style.display = mode === 'ascension' ? '' : 'none';
  document.getElementById('spRulesBlight').style.display = mode === 'blight' ? '' : 'none';
  document.getElementById('spRulesGodbot').style.display = mode === 'godbot' ? '' : 'none';
  document.getElementById('spRulesCurse').style.display = mode === 'curse' ? '' : 'none';
  document.getElementById('spRulesShrink').style.display = mode === 'shrink' ? '' : 'none';
  document.getElementById('spRulesMutation').style.display = mode === 'mutation' ? '' : 'none';
  document.getElementById('spRulesPuzzle').style.display = mode === 'puzzle' ? '' : 'none';
  document.getElementById('spLeaderboardTitle').textContent = LEADERBOARD_TITLES[mode];
  document.getElementById('spSaveStatus').textContent = '';
  document.getElementById('spPieceChoices').style.display = 'none';
  document.getElementById('spGodbotHand').style.display = mode === 'godbot' ? '' : 'none';
  document.getElementById('spGodbotPowerups').style.display = mode === 'godbot' ? '' : 'none';
  document.getElementById('spCursePanel').style.display = mode === 'curse' ? '' : 'none';
  document.getElementById('spPuzzleHand').style.display = mode === 'puzzle' ? '' : 'none';
  document.getElementById('spTimer').textContent =
    (mode === 'eogonim' || mode === 'blindeogonim' || mode === 'blight') ? 'Captured: 0'
    : mode === 'ascension' ? `Round 1 - 0/${ascensionThreshold(1)}`
    : mode === 'godbot' ? 'You: 0 - Bot: 0'
    : mode === 'curse' ? 'Open squares: 0'
    : mode === 'shrink' ? 'Lost: 0'
    : mode === 'mutation' ? 'Open squares: 0'
    : mode === 'puzzle' ? `Board 1/3 - ${formatTime(0)}`
    : formatTime(0);
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

// For the translucent hover-preview fill below - duplicated from game.js's
// own hexToRgba() (same "duplicate small pieces rather than share a module"
// convention as everything else in this file).
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Blind Eogonim's whole gimmick: every occupied cell renders as if empty
  // while the run is still going, so a placed piece is genuinely invisible
  // from the moment it's placed. Once the run ends, the true board is
  // revealed (same rendering as every other mode) so the player can see
  // exactly what they were working with.
  const hidePieces = state.mode === 'blindeogonim' && !state.finished;
  // Board value 2 means different things depending on mode (see the
  // state.board comment up top) - speedrun's cleared-pocket green,
  // blight/curse's dead-square color (a dark blighted red distinct from
  // both the background and either player color), or GodBot's bot-owned
  // piece (the same orange already used for "player 2" everywhere else on
  // the site, so the color association carries over from a real match).
  const deadColor = '#4a2a30';
  // Only the human player's own pieces (val === 1) ever take a custom
  // equipped color - the other values are semantic game-state colors (bot-
  // owned, dead/blighted, cleared pocket), not "whose pieces," and must
  // stay fixed regardless of what the player has equipped.
  const myColor = pieceColorHex(Auth.getProfile()?.piece_color_id) || '#5b7fd9';
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cellIdx = idx(r, c);
      // Shrink only - a void cell is permanently gone, rendered like the
      // main game's own custom board shapes (an explicit "cut out" color
      // rather than looking like a normal empty square).
      if (state.voidMask[cellIdx]) {
        ctx.fillStyle = '#0b0a0e';
        ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
        continue;
      }
      const val = hidePieces ? 0 : state.board[cellIdx];
      ctx.fillStyle = val === 1 ? myColor
        : val === 2 ? (state.mode === 'godbot' ? '#d97a52' : (state.mode === 'blight' || state.mode === 'curse') ? deadColor : '#74ae82')
        : val === 3 ? deadColor // GodBot's "blight one of your territories" bonus action only - see pickGodbotBlightTarget()
        : '#1e1b24';
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= BOARD_SIZE; i++) {
    ctx.beginPath(); ctx.moveTo(i * CELL_PX, 0); ctx.lineTo(i * CELL_PX, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * CELL_PX); ctx.lineTo(canvas.width, i * CELL_PX); ctx.stroke();
  }

  // Curse's "invisible while placing" curse skips the hover ghost-preview
  // entirely for that one placement - the whole point is placing blind.
  const skipPreview = state.mode === 'curse' && state.curseActive === 'invisible';
  if (state.selected && state.hover && !skipPreview) {
    const orientation = ORIENTATIONS[state.selected.shapeName][state.selected.orientationIndex];
    // Blind Eogonim never color-codes valid vs. invalid - doing so would
    // just tell the player exactly which hidden squares are occupied by
    // hovering over them, defeating the entire memory mechanic. Every
    // other mode keeps the normal blue/gray valid/invalid preview.
    ctx.fillStyle = state.mode === 'blindeogonim'
      ? 'rgba(255,255,255,0.35)'
      : state.hover.valid ? hexToRgba(myColor, 0.55) : 'rgba(140,140,140,0.5)';
    for (const [dr, dc] of orientation) {
      const r = state.hover.r0 + dr, c = state.hover.c0 + dc;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue;
      ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
    }
  }
}

// Renders the "pick your next shape" interstitial into #spPieceChoices -
// only ever visible while state.awaitingPieceChoice is true (ascension only).
function renderPieceChoices() {
  const container = document.getElementById('spPieceChoices');
  if (!state.awaitingPieceChoice) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = '';
  container.innerHTML = state.pieceChoices.map((shapeName, i) => `
    <button type="button" class="sp-piece-choice-btn" data-index="${i}">
      <canvas class="sp-piece-choice-canvas"></canvas>
      <span>${shapeName}</span>
    </button>
  `).join('');
  const canvases = container.querySelectorAll('.sp-piece-choice-canvas');
  state.pieceChoices.forEach((shapeName, i) => drawShapeIcon(canvases[i], BASE_SHAPES[shapeName], 12));
  container.querySelectorAll('.sp-piece-choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => chooseShape(state.pieceChoices[Number(btn.dataset.index)]));
  });
}

function render() {
  drawBoard();
  renderPieceChoices();

  const banner = document.getElementById('spBanner');
  const pieceInfo = document.getElementById('spPieceInfo');
  const startBtn = document.getElementById('spStartBtn');
  startBtn.textContent = (state.running || state.finished) ? 'Restart' : 'Start';

  document.getElementById('spTabSpeedrun').disabled = state.running;
  document.getElementById('spTabEogonim').disabled = state.running;
  document.getElementById('spTabBlindEogonim').disabled = state.running;
  document.getElementById('spTabAscension').disabled = state.running;
  document.getElementById('spTabBlight').disabled = state.running;
  document.getElementById('spTabGodbot').disabled = state.running;
  document.getElementById('spTabCurse').disabled = state.running;
  document.getElementById('spTabShrink').disabled = state.running;
  document.getElementById('spTabMutation').disabled = state.running;
  document.getElementById('spTabPuzzle').disabled = state.running;

  if (state.mode === 'eogonim' || state.mode === 'blindeogonim') {
    document.getElementById('spTimer').textContent = `Captured: ${state.totalCaptured}`;
  } else if (state.mode === 'ascension') {
    document.getElementById('spTimer').textContent = `Round ${state.round} - ${state.totalCaptured}/${ascensionThreshold(state.round)}`;
  } else if (state.mode === 'blight') {
    const deadCount = state.running || state.finished ? state.board.reduce((n, v) => n + (v === 2 ? 1 : 0), 0) : 0;
    document.getElementById('spTimer').textContent = `Captured: ${state.totalCaptured} (${deadCount} dead)`;
  } else if (state.mode === 'godbot') {
    document.getElementById('spTimer').textContent = state.finished
      ? `You: ${state.godbotScore1} - Bot: ${state.godbotScore2}`
      : `You: ${computeGodbotFinalScores(state.board).score1} - Bot: ${computeGodbotFinalScores(state.board).score2}`;
  } else if (state.mode === 'curse') {
    const openCount = state.running || state.finished ? countCurseOpenSquares(state.board) : BOARD_SIZE * BOARD_SIZE;
    document.getElementById('spTimer').textContent = `Open squares: ${openCount}`;
  } else if (state.mode === 'shrink') {
    document.getElementById('spTimer').textContent = `Lost: ${state.totalCaptured}`;
  } else if (state.mode === 'mutation') {
    const openCount = state.running || state.finished ? countMutationOpenSquares(state.board) : BOARD_SIZE * BOARD_SIZE;
    document.getElementById('spTimer').textContent = `Open squares: ${openCount}`;
  }

  if (!state.running && !state.finished) {
    banner.textContent = 'Click Start to begin';
    pieceInfo.textContent = state.mode === 'eogonim'
      ? "You'll get one random piece at a time, with no preview of what's coming - keep your captured territory as low as possible."
      : state.mode === 'blindeogonim'
        ? "Same as Eogonim, but every piece vanishes the instant you place it. Remember where you've put them - clicking an occupied square ends your run."
        : state.mode === 'ascension'
          ? 'Pick a starting shape, then capture enough territory each round to keep unlocking more.'
          : state.mode === 'blight'
            ? 'The board starts with 5 dead squares, and one more spreads after every piece you place - maximize your captured territory before you run out of room.'
            : state.mode === 'godbot'
              ? "You get a real hand. The bot can place any piece, unlimited supply, and gets a bonus move every turn - it goes again, removes one of your pieces, blights your territory, or rerolls your hand. Beat it anyway."
              : state.mode === 'curse'
                ? "One random piece at a time, no preview, nothing ever disappears - but every piece comes cursed. Pack the board as tight as you can; an illegal move ends your run instantly."
                : state.mode === 'shrink'
                  ? "One random piece at a time, no preview, nothing ever disappears - but every 4th piece you place, the border shrinks in by one ring on every side. Only a placed piece is ever safe. Pack the board as tight as you can before the walls close in - squares never filled count against you."
                  : state.mode === 'mutation'
                    ? "One random piece at a time, no preview, nothing ever disappears - but pieces range from a 3-block tromino up to a full 7-block heptomino, with bigger pieces showing up far more often than small ones. Pack the 12x12 board as tight as you can; a perfect 0 is possible, but only if the right piece shows up at the right time."
                    : state.mode === 'puzzle'
                      ? "You'll get a random 10-piece hand and a custom board built to fit it exactly - solve 3 boards as fast as you can. Placements aren't final: click a piece you've already placed to send it back to your hand and try a different spot."
                      : "You'll get one random piece at a time - place it anywhere it fits.";
  } else if (state.mode === 'godbot' && state.finished) {
    const diff = state.godbotScore1 - state.godbotScore2;
    banner.textContent = `Run over. You ${state.godbotScore1} - Bot ${state.godbotScore2} (${diff > 0 ? '+' : ''}${diff})`;
    pieceInfo.textContent = 'Click Restart to try again.';
  } else if (state.mode === 'godbot' && state.gbTurn === 'bot') {
    banner.textContent = "Bot's turn...";
    pieceInfo.textContent = 'Watch which bonus action it uses.';
  } else if (state.mode === 'godbot') {
    banner.textContent = 'Your turn';
    pieceInfo.textContent = state.selected
      ? `Placing ${state.selected.shapeName}. Click the board to place, or press Q/E / scroll to rotate.`
      : 'Pick a piece from your hand below.';
  } else if (state.mode === 'curse' && state.finished) {
    const openCount = countCurseOpenSquares(state.board);
    banner.textContent = state.illegalMove
      ? `Illegal move. Run over. ${openCount} open square${openCount === 1 ? '' : 's'} left`
      : `Run over. ${openCount} open square${openCount === 1 ? '' : 's'} left`;
    pieceInfo.textContent = state.illegalMove
      ? 'That square was already occupied. Click Restart to try again.'
      : 'Click Restart to try for fewer.';
  } else if (state.mode === 'ascension' && state.awaitingPieceChoice) {
    banner.textContent = state.round === 1 ? 'Choose your starting shape!' : `Round ${state.round - 1} cleared! Choose your next shape.`;
    pieceInfo.textContent = 'Pick a shape below to add it to your collection.';
  } else if (state.mode === 'ascension' && state.finished) {
    banner.textContent = `Run over. Cleared ${state.round - 1} round${state.round - 1 === 1 ? '' : 's'}`;
    pieceInfo.textContent = `Needed ${ascensionThreshold(state.round)} this round, got ${state.totalCaptured}. Click Restart to try again.`;
  } else if (state.mode === 'eogonim' && state.finished) {
    banner.textContent = `Run over. Captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`;
    pieceInfo.textContent = 'Click Restart to try for a lower score.';
  } else if (state.mode === 'blight' && state.finished) {
    banner.textContent = `Run over. Captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`;
    pieceInfo.textContent = 'Click Restart to try for a higher score.';
  } else if (state.mode === 'shrink' && state.finished) {
    banner.textContent = `Run over. Lost ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`;
    pieceInfo.textContent = 'Click Restart to try for fewer.';
  } else if (state.mode === 'mutation' && state.finished) {
    const openCount = countMutationOpenSquares(state.board);
    banner.textContent = openCount === 0
      ? 'Perfect run! Every square filled'
      : `Run over. ${openCount} open square${openCount === 1 ? '' : 's'} left`;
    pieceInfo.textContent = 'Click Restart to try for fewer.';
  } else if (state.mode === 'puzzle' && state.finished) {
    banner.textContent = `All 3 boards cleared! Time: ${formatTime(state.finalTimeMs)}`;
    pieceInfo.textContent = 'Click Restart to try for a faster time.';
  } else if (state.mode === 'puzzle') {
    banner.textContent = `Board ${state.puzzleRound} of 3`;
    pieceInfo.textContent = state.selected
      ? `Placing ${state.selected.shapeName}. Click the board to place, or press Q/E / scroll to rotate. Click it again in your hand to let go of it, or click a placed piece to send it back to your hand.`
      : 'Pick a piece from your hand below, or click a placed piece to take it back.';
  } else if (state.mode === 'blindeogonim' && state.finished) {
    banner.textContent = state.illegalMove
      ? `Illegal move. Run over. Captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`
      : `Run over. Captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`;
    pieceInfo.textContent = state.illegalMove
      ? 'That square was already occupied. The board above shows where everything actually was - click Restart to try again.'
      : 'Click Restart to try for a lower score.';
  } else if (state.finished && state.failed) {
    banner.textContent = 'No legal moves - run failed';
    pieceInfo.textContent = "That piece didn't fit anywhere on the board. Click Restart to try again.";
  } else if (state.finished) {
    banner.textContent = `Cleared! Time: ${formatTime(state.finalTimeMs)}`;
    pieceInfo.textContent = 'Click Restart to run it back.';
  } else if (state.selected) {
    const len = ORIENTATIONS[state.selected.shapeName].length;
    pieceInfo.textContent = `Placing ${state.selected.shapeName} (orientation ${state.selected.orientationIndex + 1}/${len}). Click the board to place, or press Q/E / scroll to rotate.`;
    banner.textContent = 'Go!';
  }

  // Curse's "invisible while placing" curse would otherwise be pointless -
  // the current-piece panel names/draws the exact shape right next to the
  // board, so the hover preview being suppressed (see drawBoard()'s
  // skipPreview) wouldn't actually hide anything without this too.
  const hideCurrentPiece = state.mode === 'curse' && state.curseActive === 'invisible';
  document.getElementById('spCurrentPieceLabel').textContent = (state.selected && !hideCurrentPiece) ? state.selected.shapeName : '-';
  const iconCanvas = document.getElementById('spCurrentPieceIcon');
  if (state.selected && !hideCurrentPiece) {
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

  // Ascension's "inventory" - every shape unlocked so far this run, so the
  // player doesn't have to remember their own collection while planning
  // placements. The currently-drawn piece gets a highlight so it's obvious
  // which one of the collection is actually in play right now.
  const unlockedLabel = document.getElementById('spUnlockedLabel');
  const unlockedEl = document.getElementById('spUnlockedShapes');
  if (state.mode === 'ascension' && state.unlockedShapes.length > 0) {
    unlockedLabel.style.display = '';
    unlockedEl.style.display = '';
    unlockedEl.innerHTML = '';
    for (const shapeName of state.unlockedShapes) {
      const item = document.createElement('div');
      item.className = 'sp-upcoming-item';
      if (state.selected && state.selected.shapeName === shapeName) item.classList.add('sp-upcoming-item-active');
      const c = document.createElement('canvas');
      drawShapeIcon(c, BASE_SHAPES[shapeName], 14);
      item.appendChild(c);
      unlockedEl.appendChild(item);
    }
  } else {
    unlockedLabel.style.display = 'none';
    unlockedEl.style.display = 'none';
    unlockedEl.innerHTML = '';
  }

  renderGodbotHand();
  renderGodbotPowerups();
  renderCursePanel();
  renderPuzzleHand();
}

// GodBot's hand-of-many picker - the first mode where the player chooses
// from several pieces at once instead of being handed exactly one. Each
// hand piece is a clickable icon (drawShapeIcon(), same helper every other
// piece preview in this file already uses); the currently-selected one (if
// any) gets a highlight so it's clear what's about to be placed.
function renderGodbotHand() {
  const container = document.getElementById('spGodbotHand');
  if (state.mode !== 'godbot') { container.innerHTML = ''; return; }
  container.innerHTML = '';
  if (!state.running) return;
  state.gbHand.forEach((shapeName, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-godbot-hand-item';
    if (state.gbTurn !== 'player') btn.disabled = true;
    if (state.selected && state.selected.shapeName === shapeName) btn.classList.add('sp-godbot-hand-item-active');
    const c = document.createElement('canvas');
    drawShapeIcon(c, BASE_SHAPES[shapeName], 12);
    btn.appendChild(c);
    btn.addEventListener('click', () => selectGodbotHandPiece(shapeName));
    container.appendChild(btn);
  });
}

// Same layout/behavior as renderGodbotHand() (reuses its exact CSS
// classes), just with no turn/bot gating - every hand item is always
// clickable while the run is going, since Puzzle has no turns at all.
function renderPuzzleHand() {
  const container = document.getElementById('spPuzzleHand');
  if (state.mode !== 'puzzle') { container.innerHTML = ''; return; }
  container.innerHTML = '';
  if (!state.running) return;
  state.puzzleHand.forEach((shapeName) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-godbot-hand-item';
    if (state.selected && state.selected.shapeName === shapeName) btn.classList.add('sp-godbot-hand-item-active');
    const c = document.createElement('canvas');
    drawShapeIcon(c, BASE_SHAPES[shapeName], 12);
    btn.appendChild(c);
    btn.addEventListener('click', () => selectPuzzleHandPiece(shapeName));
    container.appendChild(btn);
  });
}

// The required "grayed out, current one highlighted red" powerup readout -
// state.gbLastPowerup is set the moment the bot's bonus action resolves
// (godbotRunBotTurn()) and cleared the moment the player's next placement
// hands the turn back to the bot (godbotCommitPlacement()), so it always
// reflects "what the bot just did," not a stale action from turns ago.
const GODBOT_POWERUPS = ['again', 'remove', 'reroll', 'blight'];

function renderGodbotPowerups() {
  const container = document.getElementById('spGodbotPowerups');
  if (state.mode !== 'godbot') return;
  for (const power of GODBOT_POWERUPS) {
    const el = container.querySelector(`[data-power="${power}"]`);
    if (el) el.classList.toggle('sp-power-active', state.gbLastPowerup === power);
  }
}

// Same "grayed out, current one highlighted red" treatment as GodBot's
// powerup panel, one line per curse - state.curseActive is re-rolled by
// spawnNextPiece() every time a new piece is drawn (see rollCurse()).
function renderCursePanel() {
  const container = document.getElementById('spCursePanel');
  if (state.mode !== 'curse') return;
  for (const curse of CURSE_TYPES) {
    const el = container.querySelector(`[data-curse="${curse}"]`);
    if (el) el.classList.toggle('sp-power-active', state.running && state.curseActive === curse);
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
  if (!state.running) return;
  // Puzzle only - clicking an already-placed piece picks it up, but ONLY
  // when nothing is currently selected. Holding a piece always means "try
  // to place it here" instead - see tryPuzzlePickup()'s own comment for
  // why. A no-op for every other mode either way.
  if (state.mode === 'puzzle' && !state.selected && state.mouseRC && tryPuzzlePickup(state.mouseRC.row, state.mouseRC.col)) return;
  if (!state.selected || !state.hover) return;
  if (state.hover.valid) {
    commitPlacement(state.hover.r0, state.hover.c0);
    return;
  }
  // Every other mode just silently ignores a click on an invalid square.
  // Blind Eogonim and Curse both end the run for the 'occupied' case only -
  // clicking off the edge of the board (or, for Curse, onto an otherwise-
  // empty square the active curse just forbids) stays a harmless no-op.
  if (state.mode === 'blindeogonim' || state.mode === 'curse') {
    const reason = placementConflictReason(state.selected.shapeName, state.selected.orientationIndex, state.hover.r0, state.hover.c0, state.board);
    if (reason === 'occupied') {
      if (state.mode === 'blindeogonim') finishBlindEogonimRun(true);
      else finishCurseRun(true);
    }
  }
});

canvas.addEventListener('touchstart', (e) => {
  if (!state.running) return;
  e.preventDefault();
  const touch = e.touches[0];
  const cell = getBoardCell(touch.clientX, touch.clientY);
  const wasSameCell = state.lastTapCell && state.lastTapCell.row === cell.row && state.lastTapCell.col === cell.col;
  state.lastTapCell = cell;

  // Puzzle only - a second tap on an already-placed piece picks it back up
  // into the hand, but ONLY when nothing is currently selected - holding a
  // piece always means "try to place it here" instead (see
  // tryPuzzlePickup()'s own comment).
  if (state.mode === 'puzzle' && !state.selected && wasSameCell && tryPuzzlePickup(cell.row, cell.col)) {
    state.lastTapCell = null;
    return;
  }

  if (!state.selected) {
    state.mouseRC = cell;
    recomputeHover();
    drawBoard();
    return;
  }

  if (wasSameCell && state.hover) {
    if (state.hover.valid) {
      commitPlacement(state.hover.r0, state.hover.c0);
      state.lastTapCell = null;
      return;
    }
    if (state.mode === 'blindeogonim' || state.mode === 'curse') {
      const reason = placementConflictReason(state.selected.shapeName, state.selected.orientationIndex, state.hover.r0, state.hover.c0, state.board);
      if (reason === 'occupied') {
        if (state.mode === 'blindeogonim') finishBlindEogonimRun(true);
        else finishCurseRun(true);
        state.lastTapCell = null;
        return;
      }
    }
  }

  state.mouseRC = cell;
  recomputeHover();
  drawBoard();
}, { passive: false });

// Scroll up rotates clockwise/"right" (the default no-arg rotateSelected()),
// scroll down rotates counter-clockwise/"left" (rotateSelected(true)) - see
// game.js's rotate90() comment for why the default direction is clockwise
// (this file's own rotate90() is an identical, self-contained copy).
canvas.addEventListener('wheel', (e) => {
  if (!state.running || !state.selected) return;
  e.preventDefault();
  rotateSelected(e.deltaY > 0);
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') rotateSelected(true); // counter-clockwise/"left"
  else if (e.key === 'e' || e.key === 'E') rotateSelected(); // clockwise/"right"
  else if (e.key === 'f' || e.key === 'F') flipSelected();
});

document.getElementById('mobileRotateBtn').addEventListener('click', () => rotateSelected());
document.getElementById('mobileRotateCcwBtn').addEventListener('click', () => rotateSelected(true));
document.getElementById('spStartBtn').addEventListener('click', startRun);
document.getElementById('spTabSpeedrun').addEventListener('click', () => setMode('speedrun'));
document.getElementById('spTabEogonim').addEventListener('click', () => setMode('eogonim'));
document.getElementById('spTabBlindEogonim').addEventListener('click', () => setMode('blindeogonim'));
document.getElementById('spTabAscension').addEventListener('click', () => setMode('ascension'));
document.getElementById('spTabBlight').addEventListener('click', () => setMode('blight'));
document.getElementById('spTabGodbot').addEventListener('click', () => setMode('godbot'));
document.getElementById('spTabCurse').addEventListener('click', () => setMode('curse'));
document.getElementById('spTabShrink').addEventListener('click', () => setMode('shrink'));
document.getElementById('spTabMutation').addEventListener('click', () => setMode('mutation'));
document.getElementById('spTabPuzzle').addEventListener('click', () => setMode('puzzle'));

// Clicking the "How to Play" header collapses/expands the whole rules panel.
document.querySelector('.rules-panel h3')?.addEventListener('click', () => {
  document.querySelector('.rules-panel').classList.toggle('collapsed');
});

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

// Same discipline again, via submit_puzzle_time() - lower is better, same
// direction/shape as submit_singleplayer_time(), just a total across 3
// boards instead of one.
async function savePuzzleTimeIfBest(timeMs) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your time to the leaderboard.';
    return;
  }
  const { data: bestTimeMs, error } = await supabaseClient.rpc('submit_puzzle_time', { p_time_ms: timeMs });
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

// Same discipline again, via submit_blindeogonim_score() - a separate RPC
// (rather than reusing submit_singleplayer_score()) since that one is
// hardcoded to mode = 'eogonim' and Blind Eogonim keeps its own leaderboard
// row per user, same as every other mode.
async function saveBlindEogonimScoreIfBest(score) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestScore, error } = await supabaseClient.rpc('submit_blindeogonim_score', { p_score: score });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestScore === score
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestScore}.`;
  refreshLeaderboard();
}

// Same discipline again, via submit_ascension_score() - the one case where
// "better" means HIGHER, not lower (more rounds cleared).
async function saveAscensionScoreIfBest(rounds) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestRounds, error } = await supabaseClient.rpc('submit_ascension_score', { p_round: rounds });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestRounds === rounds
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestRounds} round${bestRounds === 1 ? '' : 's'}.`;
  refreshLeaderboard();
}

// Same discipline again, via submit_blight_score() - higher is better, same
// direction as submit_ascension_score(), just captured squares instead of
// rounds cleared.
async function saveBlightScoreIfBest(score) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestScore, error } = await supabaseClient.rpc('submit_blight_score', { p_score: score });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestScore === score
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestScore}.`;
  refreshLeaderboard();
}

// Same discipline again, via submit_godbot_score() - higher is better, same
// direction as submit_ascension_score()/submit_blight_score(), but this is
// the one mode where the score itself can be negative (you losing to the
// bot, which is common), so the message doesn't assume a plain positive
// number the way every other mode's does.
async function saveGodbotScoreIfBest(score) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestScore, error } = await supabaseClient.rpc('submit_godbot_score', { p_score: score });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestScore === score
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestScore > 0 ? '+' : ''}${bestScore}.`;
  refreshLeaderboard();
}

// Same discipline again, via submit_curse_score() - lower is better, same
// direction as submit_singleplayer_score()/submit_blindeogonim_score(), just
// counting leftover open squares instead of captured territory.
async function saveCurseScoreIfBest(score) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestScore, error } = await supabaseClient.rpc('submit_curse_score', { p_score: score });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestScore === score
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestScore}.`;
  refreshLeaderboard();
}

// Same discipline again, via submit_shrink_score() - lower is better, same
// direction as submit_curse_score(), just squares lost to the void instead
// of leftover open squares.
async function saveShrinkScoreIfBest(score) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestScore, error } = await supabaseClient.rpc('submit_shrink_score', { p_score: score });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestScore === score
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestScore}.`;
  refreshLeaderboard();
}

// Same discipline again, via submit_mutation_score() - lower is better,
// same direction as submit_curse_score()/submit_shrink_score(), just plain
// leftover open squares with no void/dead-square wrinkle.
async function saveMutationScoreIfBest(score) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestScore, error } = await supabaseClient.rpc('submit_mutation_score', { p_score: score });
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
  const mode = state.mode;
  // Puzzle joins Speedrun as the second (and, so far, only other) time_ms-
  // based mode - every other mode's leaderboard is the "score" column.
  const isTimeMode = mode === 'speedrun' || mode === 'puzzle';
  const scoreColumn = isTimeMode ? 'time_ms' : 'score';
  // Most modes are "lower is better" (fastest time, fewest captured
  // squares/open squares) - ascension (rounds cleared), blight (captured
  // territory, maximized), and godbot (score differential, maximized) are
  // the ones where more is better.
  const ascending = mode !== 'ascension' && mode !== 'blight' && mode !== 'godbot';
  const { data, error } = await supabaseClient
    .from('singleplayer_runs')
    .select(`${scoreColumn}, profiles(id, username, avatar_id, title_id)`)
    .eq('mode', mode)
    .order(scoreColumn, { ascending })
    .limit(10);

  if (error) {
    container.innerHTML = `<p>Could not load leaderboard: ${escapeHtml(error.message)}</p>`;
    return;
  }

  await Catalog.ready();

  const formatScore = (row) => {
    if (isTimeMode) return formatTime(row.time_ms);
    if (mode === 'ascension') return `${row.score} round${row.score === 1 ? '' : 's'}`;
    if (mode === 'godbot') return `${row.score > 0 ? '+' : ''}${row.score}`;
    return row.score;
  };
  const columnLabel = isTimeMode ? 'Time' : mode === 'ascension' ? 'Rounds' : 'Score';

  // Standard competition ("1224") ranking: two runs with the identical
  // time/score share the same rank number, and the rank after a tie skips
  // ahead by the tie's size, same idea as leaderboard.js's own
  // computeRankLabels(). data is already sorted by scoreColumn, so this is
  // just a running comparison against the previous row's value.
  let lastValue = null, lastRank = 0;
  const rows = (data || []).map((row, i) => {
    const value = isTimeMode ? row.time_ms : row.score;
    if (lastValue === null || value !== lastValue) {
      lastRank = i + 1;
      lastValue = value;
    }
    return `
      <tr>
        <td>${lastRank}</td>
        <td class="leaderboard-player-cell">${avatarHtml(row.profiles.avatar_id, 20)} <a href="profile.html?user=${encodeURIComponent(row.profiles.id)}">${escapeHtml(row.profiles.username)}</a> ${titleBadgeHtml(row.profiles.title_id)}</td>
        <td>${formatScore(row)}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>#</th><th>Player</th><th>${columnLabel}</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No runs yet - be the first!</td></tr>'}</tbody>
    </table>
  `;
}

// ---------- Live queue counts ----------
// Duplicated from game.js's refreshQueueCounts()/formatQueueCount() rather
// than shared - same standalone-page convention this file already follows
// for BASE_SHAPES/ORIENTATIONS. This page never loads net.js at all (no
// WebRTC connection happens here), so it polls the signaling server's
// plain HTTP /queue-counts endpoint directly instead - lets a player
// keep an eye on the real queues while playing singleplayer.
const SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';
const SIGNALING_HTTP_URL = SIGNALING_SERVER_URL.replace(/^ws/, 'http');
// Matches game.js's own QUEUE_COUNT_POLL_MS - was 7000, visibly laggy.
const QUEUE_COUNT_POLL_MS = 3500;

function formatQueueCount(n) {
  if (n === 1) return '1 waiting';
  return `${n} waiting`;
}

async function refreshQueueCounts() {
  try {
    const res = await fetch(`${SIGNALING_HTTP_URL}/queue-counts`);
    if (!res.ok) return;
    const { casual, ranked } = await res.json();
    document.getElementById('spCasualQueueCount').textContent = formatQueueCount(casual);
    document.getElementById('spRankedQueueCount').textContent = formatQueueCount(ranked);
  } catch {
    // signaling server unreachable - leave whatever was last shown
  }
}

// ---------- Init ----------
updateModeUI();
render();
refreshLeaderboard();
refreshQueueCounts();
setInterval(refreshQueueCounts, QUEUE_COUNT_POLL_MS);

// ---------- Duel mode engine exposure ----------
// duel.js (a separate page, minogoe.html-style shell reusing this file's
// canvas/hand-panel markup) drives this file's game loop programmatically
// instead of via the tab/Start-button UI singleplayer.html uses - this is
// the one seam it needs. Nothing here changes solo behavior; every function
// below already exists above, this just names them for an outside caller.
window.SingleplayerEngine = {
  state,
  startRun,
  setMode,
  setRng,
  setSecondaryRng,
  mulberry32,
  precomputeAllPuzzleRounds,
  setOnRoundFinished,
  formatTime,
  forceEndRun,
  // Duel-only: lets duel.js force Eogonim/Blight rounds to end early at
  // their 90-second cap (the user's spec calls for), reusing these modes'
  // own normal ending path (render()/duelMode-guarded save/onRoundFinished)
  // rather than a separate ad hoc "time's up" code path.
  finishEogonimRun,
  finishBlightRun,
};
