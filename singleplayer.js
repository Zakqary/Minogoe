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
//     harmless no-op like clicking off the edge of the board is.
//   - Ascension: a roguelike built on Eogonim's no-removal capture rule.
//     Start with one randomly-offered shape (infinite supply), place until
//     stuck, and if that round's captured total clears an escalating
//     threshold, unlock a new shape, reset the board, and go again - see
//     the "Ascension run flow" section below.
//   - Exact Match: also built on Eogonim's no-removal capture rule, but
//     inverted into a precision puzzle instead of an escalating one. Each
//     round deals a hand of 15 random pieces (any of which may repeat) and
//     rolls a random target between 5 and 30 - you choose which piece to
//     place from your hand (rather than being handed one at a time), and
//     must land your captured total on EXACTLY that target. Overshooting
//     is unrecoverable (captures never reverse), and running out of
//     placeable pieces before reaching the target also ends the run. Score
//     is rounds cleared in a row - see the "Exact Match run flow" section.
// Board size varies by mode (Speedrun: 9x9, everything else: 10x10) - see
// BOARD_SIZES and setMode() below - so this is reassigned rather than a const.
let BOARD_SIZE = 9;
const BOARD_SIZES = { speedrun: 9, eogonim: 10, blindeogonim: 10, ascension: 10, exactmatch: 10 };
const EXACT_MATCH_HAND_SIZE = 15;
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
  mode: 'speedrun', // 'speedrun' | 'eogonim' | 'blindeogonim' | 'ascension' | 'exactmatch' - persists across resetBoardState(), only setMode()/startRun() change it
  board: new Uint8Array(BOARD_SIZE * BOARD_SIZE),
  pieceIdAt: new Int32Array(BOARD_SIZE * BOARD_SIZE),
  pieceCells: new Map(), // pieceId -> number[] of cell indices
  nextPieceId: 1,
  running: false,
  finished: false,
  failed: false, // speedrun only - eogonim/blindeogonim/ascension/exactmatch have no fail state, every ending is a valid (scored) result
  illegalMove: false, // blindeogonim only - whether this run's ending was a click on an occupied square rather than running out of legal placements
  exactOvershoot: false, // exactmatch only - whether this run's ending was overshooting the target rather than getting stuck under it
  selected: null, // { shapeName, orientationIndex } - the current piece being placed
  pieceQueue: [], // shapeNames coming up after the current piece, length LOOKAHEAD_COUNT - speedrun only
  mouseRC: null,
  hover: null,
  lastTapCell: null,
  startTime: null,
  finalTimeMs: null,
  totalCaptured: 0, // running captured-territory count - eogonim's score, and ascension/exactmatch's CURRENT ROUND score (reset every round, not every run). Also incremented by speedrun's cascade, but never displayed there.
  // Ascension/Exact Match only - deliberately NOT touched by
  // resetBoardState() (which runs between rounds too), only by
  // startRun()/setMode(), since these need to persist across a round reset
  // within the same run.
  round: 1,
  unlockedShapes: [], // ascension only
  // Ascension-only - true while the "pick your next shape" interstitial is
  // showing (between startRun()/a round pass and the next round's first
  // placement). IS reset by resetBoardState() since it's board-adjacent UI
  // state, not run-progress state.
  awaitingPieceChoice: false,
  pieceChoices: [], // shapeNames currently offered during the interstitial
  // Exact Match only - this round's hand (shapeName -> copies remaining)
  // and randomly-rolled capture target. Both ARE reset by resetBoardState()
  // (blanked to null there) since they're board-adjacent, per-round state -
  // startExactMatchRound() is what actually repopulates them right after,
  // same two-step pattern as awaitingPieceChoice/showPieceChoice() above.
  handCounts: null,
  exactTarget: null,
};

// Used both for a brand new run (startRun()) AND between Ascension/Exact
// Match rounds (chooseShape()/evaluateExactMatchRound()) - deliberately
// leaves state.round/unlockedShapes alone, since those need to survive a
// round reset within the same run.
function resetBoardState() {
  state.board = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceIdAt = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  state.pieceCells = new Map();
  state.nextPieceId = 1;
  state.running = false;
  state.finished = false;
  state.failed = false;
  state.illegalMove = false;
  state.exactOvershoot = false;
  state.selected = null;
  state.pieceQueue = [];
  state.hover = null;
  state.lastTapCell = null;
  state.startTime = null;
  state.finalTimeMs = null;
  state.totalCaptured = 0;
  state.awaitingPieceChoice = false;
  state.pieceChoices = [];
  state.handCounts = null;
  state.exactTarget = null;
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

// ---------- Piece supply ----------
function drawWeightedPiece() {
  const roll = Math.random();
  const pool = roll < 0.70 ? PENTOMINO_NAMES : roll < 0.90 ? TETROMINO_NAMES : TROMINO_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
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

// Exact Match's hand: 15 independent weighted draws (same 70/20/10 category
// odds as every other mode's random piece), tallied into counts rather than
// kept as a flat list - duplicates are expected and simply stack, and
// decrementing a count on placement is simpler than splicing an array.
function rollExactMatchHand() {
  const counts = {};
  for (let i = 0; i < EXACT_MATCH_HAND_SIZE; i++) {
    const shapeName = drawWeightedPiece();
    counts[shapeName] = (counts[shapeName] || 0) + 1;
  }
  return counts;
}

// Uniform random integer in [5, 30] - the "how much territory must you
// capture exactly, this round" target.
function randomExactTarget() {
  return 5 + Math.floor(Math.random() * 26);
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
  if (state.mode === 'ascension') {
    state.round = 1;
    state.unlockedShapes = [];
  }
  if (state.mode === 'exactmatch') {
    state.round = 1;
  }
  state.running = true;
  if (state.mode === 'ascension') {
    showPieceChoice();
  } else if (state.mode === 'exactmatch') {
    startExactMatchRound();
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

  const shapeName = state.mode === 'speedrun' ? state.pieceQueue.shift() : drawWeightedPiece();
  if (state.mode === 'speedrun') state.pieceQueue.push(drawWeightedPiece());
  state.selected = { shapeName, orientationIndex: 0 };
  recomputeHover();
  if (!hasAnyLegalMove(shapeName, state.board)) {
    if (state.mode === 'speedrun') failRun();
    else if (state.mode === 'blindeogonim') finishBlindEogonimRun(false);
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

  // Exact Match consumes one copy of the placed shape from the hand -
  // guaranteed to exist and be > 0, since selectHandShape() only ever lets
  // you select a shape you still have copies of.
  if (state.mode === 'exactmatch') {
    state.handCounts[shapeName] -= 1;
  }

  state.selected = null;
  state.hover = null;

  // Speedrun's cascade mutates the board (captures + removes the walling
  // pieces); eogonim/blindeogonim/ascension/exactmatch score like a real
  // Minogoe match instead - pieces stay put forever, so the "captured"
  // total (ascension/exactmatch's current ROUND score) is just recomputed
  // fresh here for the live display, with no board mutation at all.
  if (state.mode === 'speedrun') {
    runCaptureCascade();
  } else {
    state.totalCaptured = computeCapturedCount(state.board);
  }

  // Exact Match's round-end conditions (hit the target exactly, overshot
  // it, or got stuck under it) are independent of board fullness, unlike
  // every other mode here - handled entirely by evaluateExactMatchRound(),
  // so this returns before the isBoardComplete() check below ever runs.
  if (state.mode === 'exactmatch') {
    evaluateExactMatchRound();
    return;
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

// ---------- Exact Match run flow ----------

// Rolls a fresh hand + target for the round about to be played - does NOT
// touch the board or state.round itself (resetBoardState(), called just
// before this everywhere it's used, already handled the board; state.round
// is bumped by the caller before this runs, same as Ascension's
// showPieceChoice()/chooseShape() split). Explicitly re-sets state.running
// in case resetBoardState() (which sets it false) ran immediately before
// this on the same call stack, same defensive re-set chooseShape() does.
function startExactMatchRound() {
  state.handCounts = rollExactMatchHand();
  state.exactTarget = randomExactTarget();
  state.running = true;
  state.selected = null;
  state.hover = null;
  render();
}

// Picks a piece out of the current hand to place next - only callable while
// a copy remains. Unlike every other mode, the player chooses freely from
// whatever's left in hand rather than being handed a piece automatically.
function selectHandShape(shapeName) {
  if (!state.running || state.mode !== 'exactmatch') return;
  if (!state.handCounts[shapeName]) return;
  state.selected = { shapeName, orientationIndex: 0 };
  recomputeHover();
  render();
}

// Called after every placement in Exact Match mode. Captures never reverse
// (same no-removal rule as Eogonim), so there are exactly three outcomes:
//   - Captured total lands EXACTLY on this round's target: round cleared -
//     advance the round counter and deal a fresh hand/target/board.
//   - Captured total OVERSHOOTS the target: unrecoverable, run over.
//   - Still under target: keep going, unless every shape with copies left
//     in hand has nowhere left to fit anywhere on the board, in which case
//     the target can never be reached either - run over.
function evaluateExactMatchRound() {
  if (state.totalCaptured === state.exactTarget) {
    state.round += 1;
    resetBoardState();
    startExactMatchRound();
    return;
  }
  if (state.totalCaptured > state.exactTarget) {
    finishExactMatchRun(true);
    return;
  }
  const remainingShapes = Object.keys(state.handCounts).filter((s) => state.handCounts[s] > 0);
  if (!remainingShapes.some((s) => hasAnyLegalMove(s, state.board))) {
    finishExactMatchRun(false);
    return;
  }
  render();
}

function finishExactMatchRun(overshoot) {
  state.running = false;
  state.finished = true;
  state.failed = false;
  state.exactOvershoot = overshoot;
  render();
  saveExactMatchScoreIfBest(state.round - 1); // rounds successfully CLEARED, not the round that was failed
}

// ---------- Rotation / hover ----------
function rotateSelected() {
  if (!state.selected) return;
  const len = ORIENTATIONS[state.selected.shapeName].length;
  state.selected.orientationIndex = (state.selected.orientationIndex + 1) % len;
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
  // resetBoardState() deliberately leaves round/unlockedShapes alone (they
  // need to survive a mid-run round reset) - switching modes entirely is
  // the one place those need to be cleared explicitly instead. Harmless for
  // whichever mode isn't being switched to (exactmatch never reads
  // unlockedShapes, ascension never reads round the same way).
  state.round = 1;
  state.unlockedShapes = [];
  updateModeUI();
  render();
  refreshLeaderboard();
}

function updateModeUI() {
  const mode = state.mode;
  document.getElementById('spTabSpeedrun').classList.toggle('active', mode === 'speedrun');
  document.getElementById('spTabEogonim').classList.toggle('active', mode === 'eogonim');
  document.getElementById('spTabBlindEogonim').classList.toggle('active', mode === 'blindeogonim');
  document.getElementById('spTabAscension').classList.toggle('active', mode === 'ascension');
  document.getElementById('spTabExactMatch').classList.toggle('active', mode === 'exactmatch');
  document.getElementById('spModeTitle').textContent =
    mode === 'ascension' ? 'Ascension' : mode === 'exactmatch' ? 'Exact Match' : mode === 'blindeogonim' ? 'Blind Eogonim' : mode === 'eogonim' ? 'Eogonim' : 'Speedrun';
  document.getElementById('spModeCredit').style.display = mode === 'eogonim' ? '' : 'none';
  document.getElementById('spUpcomingLabel').style.display = mode === 'speedrun' ? '' : 'none';
  document.getElementById('spUpcomingPieces').style.display = mode === 'speedrun' ? '' : 'none';
  document.getElementById('spRulesSpeedrun').style.display = mode === 'speedrun' ? '' : 'none';
  document.getElementById('spRulesEogonim').style.display = mode === 'eogonim' ? '' : 'none';
  document.getElementById('spRulesBlindEogonim').style.display = mode === 'blindeogonim' ? '' : 'none';
  document.getElementById('spRulesAscension').style.display = mode === 'ascension' ? '' : 'none';
  document.getElementById('spRulesExactMatch').style.display = mode === 'exactmatch' ? '' : 'none';
  document.getElementById('spLeaderboardTitle').textContent =
    mode === 'ascension' ? 'Deepest Runs' : mode === 'exactmatch' ? 'Longest Streaks' : (mode === 'eogonim' || mode === 'blindeogonim') ? 'Lowest Scores' : 'Top Times';
  document.getElementById('spSaveStatus').textContent = '';
  document.getElementById('spPieceChoices').style.display = 'none';
  document.getElementById('spTimer').textContent =
    (mode === 'eogonim' || mode === 'blindeogonim') ? 'Captured: 0' : (mode === 'ascension') ? `Round 1 - 0/${ascensionThreshold(1)}` : mode === 'exactmatch' ? 'Round 1' : formatTime(0);
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
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const val = hidePieces ? 0 : state.board[idx(r, c)];
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

// Exact Match's hand - a grid of clickable shape buttons (unlike Ascension's
// purely informational "Your shapes" inventory, these are the actual
// selection UI: selectHandShape() is wired to each button's click). Shows
// every shape that was EVER in this round's hand (Object.keys(handCounts)
// - insertion order from rollExactMatchHand(), stable for the round), with
// a remaining-copies badge; a shape reaching 0 stays visible but disabled
// rather than disappearing, so the player can still see their whole
// starting hand while planning around what's left.
function renderExactMatchHand() {
  const label = document.getElementById('spHandLabel');
  const grid = document.getElementById('spHandGrid');
  if (state.mode !== 'exactmatch' || !state.handCounts) {
    label.style.display = 'none';
    grid.style.display = 'none';
    grid.innerHTML = '';
    return;
  }
  label.style.display = '';
  grid.style.display = '';
  const shapeNames = Object.keys(state.handCounts);
  grid.innerHTML = shapeNames.map((shapeName) => `
    <button type="button" class="sp-hand-btn${state.selected && state.selected.shapeName === shapeName ? ' active' : ''}"
      data-shape="${shapeName}" ${state.handCounts[shapeName] === 0 ? 'disabled' : ''}>
      <canvas class="sp-hand-canvas"></canvas>
      <span class="sp-hand-count">${state.handCounts[shapeName]}</span>
    </button>
  `).join('');
  const canvases = grid.querySelectorAll('.sp-hand-canvas');
  shapeNames.forEach((shapeName, i) => drawShapeIcon(canvases[i], BASE_SHAPES[shapeName], 10));
  grid.querySelectorAll('.sp-hand-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectHandShape(btn.dataset.shape));
  });
}

function render() {
  drawBoard();
  renderPieceChoices();
  renderExactMatchHand();

  const banner = document.getElementById('spBanner');
  const pieceInfo = document.getElementById('spPieceInfo');
  const startBtn = document.getElementById('spStartBtn');
  startBtn.textContent = (state.running || state.finished) ? 'Restart' : 'Start';

  document.getElementById('spTabSpeedrun').disabled = state.running;
  document.getElementById('spTabEogonim').disabled = state.running;
  document.getElementById('spTabBlindEogonim').disabled = state.running;
  document.getElementById('spTabAscension').disabled = state.running;
  document.getElementById('spTabExactMatch').disabled = state.running;

  if (state.mode === 'eogonim' || state.mode === 'blindeogonim') {
    document.getElementById('spTimer').textContent = `Captured: ${state.totalCaptured}`;
  } else if (state.mode === 'ascension') {
    document.getElementById('spTimer').textContent = `Round ${state.round} - ${state.totalCaptured}/${ascensionThreshold(state.round)}`;
  } else if (state.mode === 'exactmatch' && state.exactTarget !== null) {
    document.getElementById('spTimer').textContent = `Round ${state.round} - ${state.totalCaptured}/${state.exactTarget}`;
  }

  if (!state.running && !state.finished) {
    banner.textContent = 'Click Start to begin';
    pieceInfo.textContent = state.mode === 'eogonim'
      ? "You'll get one random piece at a time, with no preview of what's coming - keep your captured territory as low as possible."
      : state.mode === 'blindeogonim'
        ? "Same as Eogonim, but every piece vanishes the instant you place it. Remember where you've put them - clicking an occupied square ends your run."
        : state.mode === 'ascension'
          ? 'Pick a starting shape, then capture enough territory each round to keep unlocking more.'
          : state.mode === 'exactmatch'
            ? "Each round deals a hand of 15 random pieces and a random target - capture EXACTLY that much territory. Overshoot or run out of moves and it's over."
            : "You'll get one random piece at a time - place it anywhere it fits.";
  } else if (state.mode === 'ascension' && state.awaitingPieceChoice) {
    banner.textContent = state.round === 1 ? 'Choose your starting shape!' : `Round ${state.round - 1} cleared! Choose your next shape.`;
    pieceInfo.textContent = 'Pick a shape below to add it to your collection.';
  } else if (state.mode === 'ascension' && state.finished) {
    banner.textContent = `Run over — cleared ${state.round - 1} round${state.round - 1 === 1 ? '' : 's'}`;
    pieceInfo.textContent = `Needed ${ascensionThreshold(state.round)} this round, got ${state.totalCaptured}. Click Restart to try again.`;
  } else if (state.mode === 'eogonim' && state.finished) {
    banner.textContent = `Run over — captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`;
    pieceInfo.textContent = 'Click Restart to try for a lower score.';
  } else if (state.mode === 'blindeogonim' && state.finished) {
    banner.textContent = state.illegalMove
      ? `Illegal move — run over. Captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`
      : `Run over — captured ${state.totalCaptured} square${state.totalCaptured === 1 ? '' : 's'}`;
    pieceInfo.textContent = state.illegalMove
      ? 'That square was already occupied. The board above shows where everything actually was - click Restart to try again.'
      : 'Click Restart to try for a lower score.';
  } else if (state.mode === 'exactmatch' && state.finished) {
    banner.textContent = `Run over — cleared ${state.round - 1} round${state.round - 1 === 1 ? '' : 's'} in a row`;
    pieceInfo.textContent = state.exactOvershoot
      ? `Overshot the target - captured ${state.totalCaptured}, needed exactly ${state.exactTarget}. Click Restart to try again.`
      : `Ran out of placeable pieces at ${state.totalCaptured}/${state.exactTarget} captured. Click Restart to try again.`;
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
  // Blind Eogonim only ends the run for the 'occupied' case - clicking off
  // the edge of the board stays a harmless no-op, same as everywhere else,
  // since the board's edges are always visible regardless of mode.
  if (state.mode === 'blindeogonim') {
    const reason = placementConflictReason(state.selected.shapeName, state.selected.orientationIndex, state.hover.r0, state.hover.c0, state.board);
    if (reason === 'occupied') finishBlindEogonimRun(true);
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
    if (state.mode === 'blindeogonim') {
      const reason = placementConflictReason(state.selected.shapeName, state.selected.orientationIndex, state.hover.r0, state.hover.c0, state.board);
      if (reason === 'occupied') {
        finishBlindEogonimRun(true);
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

document.getElementById('mobileRotateBtn').addEventListener('click', rotateSelected);
document.getElementById('spStartBtn').addEventListener('click', startRun);
document.getElementById('spTabSpeedrun').addEventListener('click', () => setMode('speedrun'));
document.getElementById('spTabEogonim').addEventListener('click', () => setMode('eogonim'));
document.getElementById('spTabBlindEogonim').addEventListener('click', () => setMode('blindeogonim'));
document.getElementById('spTabAscension').addEventListener('click', () => setMode('ascension'));
document.getElementById('spTabExactMatch').addEventListener('click', () => setMode('exactmatch'));

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

// Same discipline again, via submit_exactmatch_score() - a separate RPC and
// leaderboard row from Ascension's, even though both are "higher (rounds
// cleared) is better" scoring.
async function saveExactMatchScoreIfBest(rounds) {
  const user = Auth.getUser();
  if (!user) {
    document.getElementById('spSaveStatus').textContent = 'Sign in to save your score to the leaderboard.';
    return;
  }
  const { data: bestRounds, error } = await supabaseClient.rpc('submit_exactmatch_score', { p_round: rounds });
  if (error) {
    document.getElementById('spSaveStatus').textContent = 'Could not save your score: ' + error.message;
    return;
  }
  document.getElementById('spSaveStatus').textContent = bestRounds === rounds
    ? 'New personal best - saved!'
    : `Saved. Your best is still ${bestRounds} round${bestRounds === 1 ? '' : 's'}.`;
  refreshLeaderboard();
}

async function refreshLeaderboard() {
  const container = document.getElementById('spLeaderboard');
  const mode = state.mode;
  const scoreColumn = mode === 'speedrun' ? 'time_ms' : 'score';
  // Every mode except ascension/exactmatch is "lower is better" (fastest
  // time, fewest captured squares) - those two are where more (rounds
  // cleared) is better.
  const ascending = mode !== 'ascension' && mode !== 'exactmatch';
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
    if (mode === 'ascension' || mode === 'exactmatch') return `${row.score} round${row.score === 1 ? '' : 's'}`;
    return row.score;
  };
  const columnLabel = mode === 'speedrun' ? 'Time' : (mode === 'ascension' || mode === 'exactmatch') ? 'Rounds' : 'Score';

  const rows = (data || []).map((row, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="leaderboard-player-cell">${avatarHtml(row.profiles.avatar_id, 20)} <a href="profile.html?user=${encodeURIComponent(row.profiles.id)}">${escapeHtml(row.profiles.username)}</a> ${titleBadgeHtml(row.profiles.title_id)}</td>
      <td>${formatScore(row)}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="games-table">
      <thead><tr><th>#</th><th>Player</th><th>${columnLabel}</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No runs yet - be the first!</td></tr>'}</tbody>
    </table>
  `;
}

// ---------- Init ----------
updateModeUI();
render();
refreshLeaderboard();
