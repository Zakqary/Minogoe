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
const BOARD_SIZES = { speedrun: 9, eogonim: 10, blindeogonim: 10, ascension: 10, blight: 10, godbot: 12, curse: 10 };
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

// GodBot only - a real match hand, same composition as game.js's own
// HAND_COMPOSITION/drawHand()/pickRandom() (duplicated here for the same
// self-contained reason as everything else in this file). ALL_SHAPE_NAMES
// is what models the bot's "access to every piece" - passed as its
// candidate pool on every single turn instead of a real, depleting hand.
const HAND_COMPOSITION = { pentomino: 7, tetromino: 2, tromino: 1 };
const ALL_SHAPE_NAMES = [...PENTOMINO_NAMES, ...TETROMINO_NAMES, ...TROMINO_NAMES];
function pickRandom(names, count) {
  const picks = [];
  for (let i = 0; i < count; i++) picks.push(names[Math.floor(Math.random() * names.length)]);
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
          if (board[idx(r0 + dr, c0 + dc)] !== 0) { ok = false; break; }
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
function rollCurse(shapeName, board) {
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
}

// ---------- Piece supply ----------
function drawWeightedPiece() {
  const roll = Math.random();
  const pool = roll < 0.70 ? PENTOMINO_NAMES : roll < 0.90 ? TETROMINO_NAMES : TROMINO_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
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

// Offers up to 3 distinct shapes the player hasn't already unlocked.
function rollPieceChoices() {
  const remaining = Object.keys(BASE_SHAPES).filter((n) => !state.unlockedShapes.includes(n));
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
  const pick = emptyCells[Math.floor(Math.random() * emptyCells.length)];
  state.board[pick] = 2;
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
  state.running = true;
  if (state.mode === 'ascension') {
    showPieceChoice();
  } else if (state.mode === 'godbot') {
    // No "current piece" to spawn - the player picks one of their own hand
    // pieces (see selectGodbotHandPiece()) rather than being handed one.
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

// Same "no separate failed ending" shape as Eogonim - running out of legal
// placements (increasingly likely as dead squares pile up) and filling the
// board are both just "the run is over," scored the same way either way.
function finishBlightRun() {
  state.running = false;
  state.finished = true;
  state.failed = false;
  render();
  saveBlightScoreIfBest(state.totalCaptured);
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

  return territoryDelta * 1000 + sealProgress + cornerTouches * 3 + edgeTouches * 0.5 + ownAdj * 2 - oppAdj * 1.5 + Math.random() * 0.5;
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
  return { id: tied[Math.floor(Math.random() * tied.length)], damage: bestDamage };
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
        bestCell = regionCells[Math.floor(Math.random() * regionCells.length)];
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

    const options = ['again', 'reroll'];
    if (removalTarget) options.push('remove');
    if (blightTarget) options.push('blight');
    const choice = options[Math.floor(Math.random() * options.length)];

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
  ascension: 'Ascension', blight: 'Blight', godbot: 'GodBot', curse: 'Curse',
};
const LEADERBOARD_TITLES = {
  speedrun: 'Top Times', eogonim: 'Lowest Scores', blindeogonim: 'Lowest Scores',
  ascension: 'Deepest Runs', blight: 'Highest Scores', godbot: 'Best Differential', curse: 'Fewest Open Squares',
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
  document.getElementById('spLeaderboardTitle').textContent = LEADERBOARD_TITLES[mode];
  document.getElementById('spSaveStatus').textContent = '';
  document.getElementById('spPieceChoices').style.display = 'none';
  document.getElementById('spGodbotHand').style.display = mode === 'godbot' ? '' : 'none';
  document.getElementById('spGodbotPowerups').style.display = mode === 'godbot' ? '' : 'none';
  document.getElementById('spCursePanel').style.display = mode === 'curse' ? '' : 'none';
  document.getElementById('spTimer').textContent =
    (mode === 'eogonim' || mode === 'blindeogonim' || mode === 'blight') ? 'Captured: 0'
    : mode === 'ascension' ? `Round 1 - 0/${ascensionThreshold(1)}`
    : mode === 'godbot' ? 'You: 0 - Bot: 0'
    : mode === 'curse' ? 'Open squares: 0'
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
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const val = hidePieces ? 0 : state.board[idx(r, c)];
      ctx.fillStyle = val === 1 ? '#5b7fd9'
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
      : state.hover.valid ? 'rgba(91,127,217,0.55)' : 'rgba(140,140,140,0.5)';
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
      ? `Placing ${state.selected.shapeName}. Click the board to place, or press R / scroll to rotate.`
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
    pieceInfo.textContent = `Placing ${state.selected.shapeName} (orientation ${state.selected.orientationIndex + 1}/${len}). Click the board to place, or press R / scroll to rotate.`;
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
  if (!state.running || !state.selected || !state.hover) return;
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
  if (!state.running || !state.selected) return;
  e.preventDefault();
  const touch = e.touches[0];
  const cell = getBoardCell(touch.clientX, touch.clientY);
  const wasSameCell = state.lastTapCell && state.lastTapCell.row === cell.row && state.lastTapCell.col === cell.col;
  state.lastTapCell = cell;

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

canvas.addEventListener('wheel', (e) => {
  if (!state.running || !state.selected) return;
  e.preventDefault();
  rotateSelected();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') rotateSelected();
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

async function refreshLeaderboard() {
  const container = document.getElementById('spLeaderboard');
  const mode = state.mode;
  const scoreColumn = mode === 'speedrun' ? 'time_ms' : 'score';
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
    if (mode === 'speedrun') return formatTime(row.time_ms);
    if (mode === 'ascension') return `${row.score} round${row.score === 1 ? '' : 's'}`;
    if (mode === 'godbot') return `${row.score > 0 ? '+' : ''}${row.score}`;
    return row.score;
  };
  const columnLabel = mode === 'speedrun' ? 'Time' : mode === 'ascension' ? 'Rounds' : 'Score';

  // Standard competition ("1224") ranking: two runs with the identical
  // time/score share the same rank number, and the rank after a tie skips
  // ahead by the tie's size, same idea as leaderboard.js's own
  // computeRankLabels(). data is already sorted by scoreColumn, so this is
  // just a running comparison against the previous row's value.
  let lastValue = null, lastRank = 0;
  const rows = (data || []).map((row, i) => {
    const value = mode === 'speedrun' ? row.time_ms : row.score;
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
const QUEUE_COUNT_POLL_MS = 7000;

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
