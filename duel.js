// Ranked minigame duels - orchestrates a best-of-3 (plus sudden death if
// needed) series across singleplayer.js's existing minigame engine, reused
// completely unmodified in gameplay terms (this file never reimplements any
// mode's rules). The only thing that makes a "duel" fair rather than a race
// against network luck is that both players run the SAME seeded RNG for a
// given round (see singleplayer.js's setRng()/setSecondaryRng()) - once a
// round starts, this file sends NO further gameplay traffic at all until
// that round ends; each side plays its own fully local, independent copy of
// the minigame and only reports its own final result once it's done.
//
// Blind Eogonim and Ascension are excluded from the duel pool per the
// user's own spec (open-ended round length / no natural "who's ahead"
// comparison that fits a duel format).
const DUEL_SIGNALING_SERVER_URL = 'wss://minogoe.onrender.com';
const DUEL_MODES = ['speedrun', 'eogonim', 'blight', 'godbot', 'curse', 'shrink', 'mutation', 'puzzle'];
const COUNTDOWN_MODES = new Set(['speedrun', 'puzzle']); // these get the 5s synced countdown, everything else a short 250ms buffer
const TIME_LIMITED_MODES = new Set(['eogonim', 'blight']); // the only two modes the user's spec gives an explicit 90s cap
const ROUND_TIME_LIMIT_MS = 90000;
const MODE_LABEL = {
  speedrun: 'Speedrun', eogonim: 'Eogonim', blight: 'Blight', godbot: 'GodBot',
  curse: 'Curse', shrink: 'Shrink', mutation: 'Mutation', puzzle: 'Puzzle',
};

const Net3 = createNet('duel');
const Engine = window.SingleplayerEngine;

const duelState = {
  active: false,           // true once matched, through match end
  isHost: false,
  opponent: { userId: null, username: 'Opponent', eloRating: 1200 },
  usedModes: [],            // regular-round modes already played (no repeats until sudden death)
  currentRound: null,       // { roundIndex, mode, seed, secondarySeed, startAtEpochMs, suddenDeath }
  myWins: 0, oppWins: 0, ties: 0,
  history: [],              // [{ roundIndex, mode, winner: 'me'|'opp'|'tie', suddenDeath }]
  myResult: null,
  oppResult: null,
  roundResolved: false,
  matchWinner: null,        // 'me' | 'opp', set once the series is decided
  matchOutcomeSubmitted: false,
};

let queueing = false;
let countdownTimer = null;
let roundTimeLimitTimer = null;
let roundTimerInterval = null;
let boardBroadcastInterval = null;
let latestOpponentSnapshot = null;

// How often the still-playing side sends a lightweight snapshot of its own
// board to the opponent - only ever actually displayed by the RECEIVING
// side once IT has already finished its own round and is just waiting (see
// maybeShowSpectate()), so there's no fairness concern with a still-active
// player seeing it early (they can't - hasResult gates it).
const BOARD_BROADCAST_INTERVAL_MS = 700;

// This page is always embedded in an iframe on index.html (see game.js's
// startDuelQueue()) - there's no queue button/status of its own here
// anymore, the parent page owns that UI and drives this document entirely
// via postMessage. setQueueStatus() relays status text back up to it
// instead of writing to a local element.
const PARENT_ORIGIN = location.origin;
function setQueueStatus(msg) {
  window.parent.postMessage({ type: 'duel-queue-status', message: msg || '' }, PARENT_ORIGIN);
}
function setBanner(msg) { document.getElementById('spBanner').textContent = msg; }

window.addEventListener('message', (e) => {
  if (e.origin !== PARENT_ORIGIN || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'start-duel-queue') startDuelQueue();
});

// Renders a player's avatar/username/title/companion mino - reuses
// auth-ui.js's avatarHtml()/titleBadgeHtml()/minoVisualHtml() (already
// loaded by this page), the same helpers profile.js/leaderboard.js use.
// Requires Catalog.ready() to have resolved first (avatarHtml/
// titleBadgeHtml look up shop item data from the catalog).
function renderIdentity(nameElId, eloElId, { username, eloRating, avatarId, titleId, companion }) {
  document.getElementById(nameElId).innerHTML = `
    <div class="duel-identity">
      ${avatarHtml(avatarId, 22)}
      <span>${escapeHtml(username || 'Player')}</span>
      ${titleBadgeHtml(titleId)}
      ${companion ? minoVisualHtml(companion, 20) : ''}
    </div>
  `;
  document.getElementById(eloElId).textContent = `ELO ${eloRating}`;
}

// ---------- Queueing ----------
function startDuelQueue() {
  const user = Auth.getUser();
  if (!user) { setQueueStatus('Sign in (top right) first to queue for duels.'); return; }
  const profile = Auth.getProfile();
  const duelEloRating = profile ? (profile.duel_elo_rating ?? 1200) : 1200;
  queueing = true;
  setQueueStatus('Searching for an opponent...');
  Net3.connect({
    serverUrl: DUEL_SIGNALING_SERVER_URL,
    joinMessage: { type: 'queue', queueType: 'duel', userId: user.id, duelEloRating, accessToken: Auth.getAccessToken() },
    onStatus: setQueueStatus,
    onReady: handleReady,
    onData: handleData,
    onPeerLeft: handlePeerLeft,
    onOpponentDisconnected: handleOpponentDisconnected,
    onOpponentTimeout: handleOpponentTimeout,
    onConnectionStale: () => {},
  });
}

// ---------- Match start ----------
async function handleReady() {
  queueing = false;
  setQueueStatus('');

  if (duelState.active) {
    // A reconnection mid-match (Net3.isRejoin) - the room/data channel is
    // back, but neither side should restart the series from scratch. The
    // simplest robust recovery: whichever side is still authoritative for
    // round scheduling (see handleOpponentTimeout()'s "I become host if my
    // opponent is the one who vanished" note) just re-sends the current
    // round's parameters so both sides are running the identical round
    // again - a full board reset is a small cost next to the alternative of
    // trying to reconstruct exact mid-round board state over the wire.
    if (duelState.isHost && duelState.currentRound && !duelState.roundResolved) {
      Net3.send({ type: 'duel-round-start', ...duelState.currentRound });
      beginRound(duelState.currentRound);
    }
    return;
  }

  duelState.active = true;
  duelState.isHost = Net3.isHost;
  document.getElementById('duelMatchPanel').style.display = '';
  document.getElementById('duelMatchHeader').style.display = '';
  document.querySelector('.sp-mode-tabs').style.display = 'none';
  document.getElementById('spStartBtn').style.display = 'none';
  document.getElementById('spModeTitle').style.display = 'none';

  // Tells the parent (index.html) to reveal this iframe in place of the
  // lobby/game view - see game.js's showDuelView().
  window.parent.postMessage({ type: 'duel-matched' }, PARENT_ORIGIN);

  Engine.setOnRoundFinished(onMyRoundFinished);

  await Catalog.ready();
  const profile = Auth.getProfile();
  const myElo = profile ? (profile.duel_elo_rating ?? 1200) : 1200;
  renderIdentity('duelMyName', 'duelMyElo', {
    username: profile?.username || 'You', eloRating: myElo,
    avatarId: profile?.avatar_id, titleId: profile?.title_id, companion: profile?.companion,
  });
  Net3.send({
    type: 'duel-identify', userId: Auth.getUser()?.id ?? null, username: profile?.username || 'Player', eloRating: myElo,
    avatarId: profile?.avatar_id ?? null, titleId: profile?.title_id ?? null, companion: profile?.companion ?? null,
  });

  if (duelState.isHost) {
    setBanner('Opponent found! Setting up round 1...');
    startNextRound(false);
  } else {
    setBanner('Opponent found! Waiting for round 1...');
  }
}

function handleData(msg) {
  if (msg.type === 'duel-identify') {
    duelState.opponent.userId = msg.userId;
    duelState.opponent.username = msg.username;
    duelState.opponent.eloRating = msg.eloRating;
    Catalog.ready().then(() => {
      renderIdentity('duelOppName', 'duelOppElo', {
        username: msg.username, eloRating: msg.eloRating,
        avatarId: msg.avatarId, titleId: msg.titleId, companion: msg.companion,
      });
    });
    return;
  }
  if (msg.type === 'duel-opponent-board') {
    latestOpponentSnapshot = msg;
    maybeShowSpectate();
    return;
  }
  if (msg.type === 'duel-round-start') {
    // Defense in depth: only the host ever originates a round (via
    // startNextRound(), applied locally via its own direct beginRound()
    // call, never round-tripped through the network) - a genuine host
    // should never receive this message type from its peer at all. Also
    // ignore anything that isn't exactly the next expected round, so a
    // stray duplicate/stale resend (e.g. during a rejoin) can't rewind or
    // skip the series.
    if (duelState.isHost) return;
    if (msg.roundIndex !== duelState.history.length + 1) return;
    beginRound(msg);
    return;
  }
  if (msg.type === 'duel-round-result') {
    duelState.oppResult = msg.result;
    tryResolveRound();
    return;
  }
}

// ---------- Round scheduling (host-authoritative) ----------
function pickNextMode(suddenDeath) {
  if (suddenDeath) return DUEL_MODES[Math.floor(Math.random() * DUEL_MODES.length)];
  const remaining = DUEL_MODES.filter((m) => !duelState.usedModes.includes(m));
  const pool = remaining.length > 0 ? remaining : DUEL_MODES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function startNextRound(suddenDeath) {
  const mode = pickNextMode(suddenDeath);
  if (!suddenDeath) duelState.usedModes.push(mode);
  const roundIndex = duelState.history.length + 1;
  const seed = Math.floor(Math.random() * 0xFFFFFFFF);
  const secondarySeed = Math.floor(Math.random() * 0xFFFFFFFF);
  const startAtEpochMs = Date.now() + (COUNTDOWN_MODES.has(mode) ? 5000 : 250);
  const roundInfo = { roundIndex, mode, seed, secondarySeed, startAtEpochMs, suddenDeath };
  Net3.send({ type: 'duel-round-start', ...roundInfo });
  beginRound(roundInfo);
}

function beginRound(info) {
  // Defense in depth: Engine.setMode() silently no-ops while
  // Engine.state.running is still true (see singleplayer.js's own guard),
  // which would otherwise leave duelState.currentRound pointing at the
  // NEW mode/round while the actual engine keeps running the OLD one
  // underneath it - exactly the split-brain that made a GodBot round once
  // get silently recorded as a tied Eogonim round (root-caused to the
  // onPeerLeft/isHost bug fixed above, which could cause beginRound() to
  // be invoked twice for the same round). Refuse to start a new round
  // while one is still genuinely in progress, rather than corrupting
  // state either way.
  if (Engine.state.running) return;
  clearTimeout(countdownTimer);
  clearTimeout(roundTimeLimitTimer);
  clearInterval(roundTimerInterval);
  clearInterval(boardBroadcastInterval);
  hideSpectate();
  duelState.currentRound = info;
  duelState.myResult = null;
  duelState.oppResult = null;
  duelState.roundResolved = false;

  Engine.setMode(info.mode);
  Engine.setRng(Engine.mulberry32(info.seed));
  Engine.setSecondaryRng(Engine.mulberry32(info.secondarySeed));
  Engine.state.duelMode = true;
  if (info.mode === 'puzzle') Engine.precomputeAllPuzzleRounds();

  updateMatchHeaderUI();
  const delayMs = Math.max(0, info.startAtEpochMs - Date.now());
  setBanner(`${info.suddenDeath ? 'Sudden Death' : `Round ${info.roundIndex} of 3`}: ${MODE_LABEL[info.mode]} starting${delayMs > 1000 ? ` in ${Math.ceil(delayMs / 1000)}s...` : '...'}`);

  countdownTimer = setTimeout(() => {
    Engine.startRun();
    startRoundTimerDisplay(info.mode, Date.now());
    boardBroadcastInterval = setInterval(broadcastBoardSnapshot, BOARD_BROADCAST_INTERVAL_MS);
    if (TIME_LIMITED_MODES.has(info.mode)) {
      roundTimeLimitTimer = setTimeout(() => {
        // Time's up - force this round to end right now with whatever
        // score is already on the board, exactly like the same mode's own
        // natural "out of legal placements" ending (same render()/
        // duelMode-guarded-save/onRoundFinished path), just triggered by
        // the clock instead.
        if (Engine.state.running && Engine.state.mode === info.mode) {
          if (info.mode === 'eogonim') Engine.finishEogonimRun();
          else Engine.finishBlightRun();
        }
      }, ROUND_TIME_LIMIT_MS);
    }
  }, delayMs);
}

// ---------- Round timer display ----------
function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Shown in the match header for every mode (not just the ones singleplayer.js
// already draws its own elapsed-time readout for, like Speedrun/Puzzle's
// #spTimer) - a countdown for the two 90-second-capped modes (Eogonim/
// Blight), a plain elapsed-time stopwatch for the rest, so there's always a
// visible sense of round duration regardless of mode.
function startRoundTimerDisplay(mode, startedAtMs) {
  clearInterval(roundTimerInterval);
  const el = document.getElementById('duelRoundTimer');
  const hasCap = TIME_LIMITED_MODES.has(mode);
  const tick = () => {
    const elapsedMs = Date.now() - startedAtMs;
    el.textContent = hasCap
      ? `Time left: ${formatClock(ROUND_TIME_LIMIT_MS - elapsedMs)}`
      : `Elapsed: ${formatClock(elapsedMs)}`;
  };
  tick();
  roundTimerInterval = setInterval(tick, 250);
}

function stopRoundTimerDisplay() {
  clearInterval(roundTimerInterval);
  roundTimerInterval = null;
  document.getElementById('duelRoundTimer').textContent = '';
}

// ---------- Spectating your opponent after you've finished ----------
// The still-playing side broadcasts a lightweight snapshot of its own
// board every BOARD_BROADCAST_INTERVAL_MS while its round is active; the
// OTHER side only actually renders it once it has already finished its own
// round and is just waiting (see maybeShowSpectate()) - there's no
// fairness concern in a still-active player seeing this, since neither
// side's own round can be affected by watching the other after their own
// result is already locked in.
function broadcastBoardSnapshot() {
  const s = Engine.state;
  if (!s.running) return;
  Net3.send({
    type: 'duel-opponent-board',
    mode: s.mode,
    board: Array.from(s.board),
    voidMask: Array.from(s.voidMask),
    boardSize: BOARD_SIZE,
    totalCaptured: s.totalCaptured,
    godbotScore1: s.godbotScore1,
    godbotScore2: s.godbotScore2,
  });
}

function renderSpectateSnapshot(snap) {
  const canvas = document.getElementById('duelSpectateCanvas');
  const ctx = canvas.getContext('2d');
  const size = snap.boardSize;
  const px = canvas.width / size;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < snap.board.length; i++) {
    const r = Math.floor(i / size), c = i % size;
    const voided = snap.voidMask && snap.voidMask[i];
    const val = snap.board[i];
    ctx.fillStyle = voided ? '#0b0a0e' : val === 0 ? '#1e1b24' : val === 1 ? '#5b7fd9' : val === 3 ? '#8a4a52' : '#74ae82';
    ctx.fillRect(c * px, r * px, px - 1, px - 1);
  }
  document.getElementById('duelSpectateScore').textContent = snap.mode === 'godbot'
    ? `Them: ${snap.godbotScore1} - Bot: ${snap.godbotScore2}`
    : `Their score: ${snap.totalCaptured}`;
}

function maybeShowSpectate() {
  if (duelState.roundResolved) return;
  if (duelState.myResult && !duelState.oppResult && latestOpponentSnapshot) {
    document.getElementById('duelSpectatePanel').style.display = '';
    renderSpectateSnapshot(latestOpponentSnapshot);
  }
}

function hideSpectate() {
  document.getElementById('duelSpectatePanel').style.display = 'none';
  latestOpponentSnapshot = null;
}

// ---------- Round end / result exchange ----------
function normalizeResult(mode) {
  const s = Engine.state;
  if (mode === 'speedrun') return { completed: !s.failed, metric: null, timeMs: s.failed ? null : s.finalTimeMs };
  if (mode === 'puzzle') return { completed: true, metric: null, timeMs: s.finalTimeMs };
  if (mode === 'godbot') return { completed: true, metric: s.godbotScore1 - s.godbotScore2, timeMs: null };
  // eogonim, blight, curse, shrink, mutation all use state.totalCaptured as
  // their live/final tally - see each mode's own finish*Run().
  return { completed: true, metric: s.totalCaptured, timeMs: null };
}

// Human-readable version of a normalizeResult() value, for the round-result
// banner and the round-history sidebar - so both players can actually see
// each other's final score, not just who won.
function formatResultValue(mode, result) {
  if (!result) return '-';
  if (mode === 'speedrun' || mode === 'puzzle') {
    return result.completed ? Engine.formatTime(result.timeMs) : 'DNF';
  }
  if (mode === 'godbot') return `${result.metric > 0 ? '+' : ''}${result.metric}`;
  return String(result.metric);
}

function onMyRoundFinished() {
  if (!duelState.currentRound || duelState.myResult) return;
  clearTimeout(roundTimeLimitTimer);
  stopRoundTimerDisplay();
  clearInterval(boardBroadcastInterval);
  const result = normalizeResult(duelState.currentRound.mode);
  duelState.myResult = result;
  Net3.send({ type: 'duel-round-result', roundIndex: duelState.currentRound.roundIndex, result });
  setBanner('Round over on your side. Waiting for your opponent to finish...');
  maybeShowSpectate();
  tryResolveRound();
}

// Deterministic and symmetric - both clients run this same comparison
// independently (mine computed directly, theirs received over the data
// channel) and always agree, with no live vote or race needed.
function compareDuelRound(mode, mine, theirs) {
  if (mode === 'speedrun' || mode === 'puzzle') {
    if (!mine.completed && !theirs.completed) return 'tie';
    if (mine.completed !== theirs.completed) return mine.completed ? 'me' : 'opp';
    if (mine.timeMs === theirs.timeMs) return 'tie';
    return mine.timeMs < theirs.timeMs ? 'me' : 'opp';
  }
  if (mine.metric === theirs.metric) return 'tie';
  const lowerIsBetter = mode === 'eogonim' || mode === 'curse' || mode === 'shrink' || mode === 'mutation';
  if (lowerIsBetter) return mine.metric < theirs.metric ? 'me' : 'opp';
  return mine.metric > theirs.metric ? 'me' : 'opp'; // blight, godbot
}

function tryResolveRound() {
  if (duelState.roundResolved || !duelState.myResult || !duelState.oppResult) return;
  duelState.roundResolved = true;
  hideSpectate();
  const mode = duelState.currentRound.mode;
  const winner = compareDuelRound(mode, duelState.myResult, duelState.oppResult);

  // Show both players' actual final score/time for this round, not just
  // who won - kept on screen for ROUND_RESULT_DISPLAY_MS before the next
  // round's own countdown/banner takes over (see advanceSeriesOrFinish()'s
  // matching delay on the "waiting for next round" messages below), so
  // there's always a real window to actually read it.
  const myVal = formatResultValue(mode, duelState.myResult);
  const oppVal = formatResultValue(mode, duelState.oppResult);
  const resultLabel = winner === 'me' ? 'You win this round!' : winner === 'opp' ? 'Opponent wins this round.' : 'This round is a tie.';
  setBanner(`${MODE_LABEL[mode]}: You ${myVal} - Opponent ${oppVal}. ${resultLabel}`);

  recordRoundOutcome(mode, winner, duelState.currentRound.suddenDeath);
  advanceSeriesOrFinish();
}

function recordRoundOutcome(mode, winner, suddenDeath) {
  if (winner === 'me') duelState.myWins++;
  else if (winner === 'opp') duelState.oppWins++;
  else duelState.ties++;
  duelState.history.push({
    roundIndex: duelState.currentRound.roundIndex,
    mode, winner, suddenDeath: !!suddenDeath,
    myResult: duelState.myResult,
    oppResult: duelState.oppResult,
  });
  renderHistoryUI();
  updateMatchHeaderUI();
}

// First to 2 round-wins ends the series outright. Otherwise, once 3 regular
// rounds are done, whoever has more wins takes it (a tie round doesn't cost
// either side a win, so e.g. 1-0 with one tied round still resolves here).
// Only a genuine tie after all 3 regular rounds (including 0-0 with 3 ties)
// goes to sudden death - and a sudden-death round that itself ties just
// gets replayed with a fresh mode, per the user's own decision.
// How long the round-result banner (set in tryResolveRound(), just before
// this runs) stays on screen before either the next round's own countdown
// banner or a "waiting" message replaces it - matched on both host and
// non-host so both players get the same window to read it.
const ROUND_RESULT_DISPLAY_MS = 2500;

function advanceSeriesOrFinish() {
  if (duelState.myWins >= 2 || duelState.oppWins >= 2) {
    finishMatch(duelState.myWins > duelState.oppWins ? 'me' : 'opp');
    return;
  }
  const last = duelState.history[duelState.history.length - 1];
  if (last.suddenDeath) {
    if (last.winner === 'tie') {
      if (duelState.isHost) setTimeout(() => startNextRound(true), ROUND_RESULT_DISPLAY_MS);
      else setTimeout(() => setBanner('Still tied - one more sudden-death round coming up...'), ROUND_RESULT_DISPLAY_MS);
    } else {
      finishMatch(last.winner);
    }
    return;
  }
  const regularRoundsPlayed = duelState.history.filter((h) => !h.suddenDeath).length;
  if (regularRoundsPlayed >= 3) {
    if (duelState.myWins !== duelState.oppWins) {
      finishMatch(duelState.myWins > duelState.oppWins ? 'me' : 'opp');
    } else if (duelState.isHost) {
      setTimeout(() => startNextRound(true), ROUND_RESULT_DISPLAY_MS);
    } else {
      setTimeout(() => setBanner('Series tied after 3 rounds - sudden death incoming...'), ROUND_RESULT_DISPLAY_MS);
    }
    return;
  }
  if (duelState.isHost) setTimeout(() => startNextRound(false), ROUND_RESULT_DISPLAY_MS);
  else setTimeout(() => setBanner('Round over - waiting for the next round...'), ROUND_RESULT_DISPLAY_MS);
}

function finishMatch(winnerSide) {
  duelState.matchWinner = winnerSide;
  clearTimeout(countdownTimer);
  clearTimeout(roundTimeLimitTimer);
  // Keep the score header (and the round-by-round history below it)
  // visible rather than hiding it - the whole point of the final banner is
  // to let both players actually see the final score, not just a
  // win/loss label.
  updateMatchHeaderUI();
  setBanner(`${winnerSide === 'me' ? 'You won' : 'You lost'} the duel! Final score: ${duelState.myWins}-${duelState.oppWins}`);
  document.getElementById('duelBackToLobbyBtn').style.display = '';
  submitDuelResult();
}

// The user decides when to leave the result screen (rather than this
// auto-closing the moment the match ends) so they actually get to read the
// final banner/history - tells the parent to tear this iframe down and
// restore the normal lobby/game view, see game.js's hideDuelView().
document.getElementById('duelBackToLobbyBtn').addEventListener('click', () => {
  window.parent.postMessage({ type: 'duel-match-ended' }, PARENT_ORIGIN);
});

// ---------- Result submission ----------
async function submitDuelResult() {
  if (duelState.matchOutcomeSubmitted) return;
  duelState.matchOutcomeSubmitted = true;
  const user = Auth.getUser();
  if (!user || !duelState.opponent.userId || !Net3.matchId) return;

  // player1/player2 assignment must agree identically on both clients with
  // no extra negotiation - host = player1 is already server-assigned and
  // symmetric (both sides already know isHost), same convention
  // pairSockets() itself uses.
  const iAmPlayer1 = duelState.isHost;
  const player1Id = iAmPlayer1 ? user.id : duelState.opponent.userId;
  const player2Id = iAmPlayer1 ? duelState.opponent.userId : user.id;
  const myWinnerNum = duelState.matchWinner === 'me' ? 1 : 2;
  const winner = iAmPlayer1 ? myWinnerNum : (myWinnerNum === 1 ? 2 : 1);
  const rounds = duelState.history.map((h) => ({
    mode: h.mode,
    round_winner: h.winner === 'tie' ? null : (iAmPlayer1 ? (h.winner === 'me' ? 1 : 2) : (h.winner === 'me' ? 2 : 1)),
  }));

  // client_match_id dedupe - same idiom as submit_ffa_result()/games'
  // client_match_id unique index: both clients call this with the same id
  // (the signaling server's own room code), whichever lands first wins and
  // the other is a harmless no-op.
  const { error } = await supabaseClient.rpc('submit_duel_result', {
    p_client_match_id: Net3.matchId,
    p_player1_id: player1Id,
    p_player2_id: player2Id,
    p_winner: winner,
    p_rounds: rounds,
  });
  if (error) {
    setBanner((duelState.matchWinner === 'me' ? 'You won the duel! ' : 'You lost the duel. ') + '(Could not save: ' + error.message + ')');
  }
  Net3.leaveRoom();
}

// ---------- Disconnect / forfeit-round handling ----------
// Per the user's decision: a disconnect forfeits only the CURRENT round
// (auto-loss for the disconnector), not the whole match - the match
// continues to the next round. Only the signaling-server-driven grace
// period actually expiring (onOpponentTimeout, a real ~60s wait with no
// reconnect) is trusted to mean "opponent is genuinely gone" - see
// handlePeerLeft() below for why the WebRTC-layer onPeerLeft signal must
// NOT trigger this.
function forfeitCurrentRoundForOpponent() {
  if (!duelState.active || duelState.matchOutcomeSubmitted) return;
  if (duelState.currentRound && !duelState.roundResolved) {
    duelState.roundResolved = true;
    recordRoundOutcome(duelState.currentRound.mode, 'me', duelState.currentRound.suddenDeath);
    duelState.isHost = true;
    advanceSeriesOrFinish();
  }
}

function handleOpponentDisconnected(graceMs) {
  if (!duelState.active) return;
  setBanner(`Opponent disconnected - waiting up to ${Math.round(graceMs / 1000)}s for them to reconnect...`);
}

function handleOpponentTimeout() {
  forfeitCurrentRoundForOpponent();
}

// pc.onconnectionstatechange firing 'disconnected'/'failed' (what drives
// onPeerLeft, see net.js) is NOT a reliable "opponent is really gone"
// signal - it commonly fires transiently during ICE renegotiation blips
// that self-recover moments later. game.js's own handleNetPeerLeft() treats
// this identically for casual/ranked, explicitly for this exact reason
// (only the signaling-server-driven grace period is authoritative there).
// Treating it as equivalent to a genuine timeout was a real bug here: it
// force-set duelState.isHost = true on whichever side merely SAW a blip,
// so a transient hiccup on either connection could make BOTH sides
// simultaneously believe they were host - each independently broadcasting
// its own (differently-picked) next round, which is exactly what produced
// two players' rounds diverging into different sequences with different
// round counts in practice. Mid-match, this is now a no-op; if the
// connection is genuinely dead, onOpponentTimeout() will fire once the
// real ~60s grace period actually expires.
function handlePeerLeft() {
  if (!duelState.active) {
    if (queueing) {
      queueing = false;
      setQueueStatus('Connection lost. Try queueing again.');
    }
  }
}

// ---------- UI ----------
function updateMatchHeaderUI() {
  document.getElementById('duelMyScore').textContent = duelState.myWins;
  document.getElementById('duelOppScore').textContent = duelState.oppWins;
  const r = duelState.currentRound;
  document.getElementById('duelRoundInfo').textContent = r
    ? `${r.suddenDeath ? 'Sudden Death' : `Round ${r.roundIndex} of 3`} - ${MODE_LABEL[r.mode]}`
    : '';
}

// The "scoreboard on the side" - every round played so far, with both
// players' actual final score/time clearly displayed, not just a
// win/loss/tie label.
function renderHistoryUI() {
  const container = document.getElementById('duelHistory');
  container.innerHTML = duelState.history.map((h) => {
    const cls = h.winner === 'me' ? 'duel-round-win' : h.winner === 'opp' ? 'duel-round-loss' : '';
    const label = h.winner === 'me' ? 'Won' : h.winner === 'opp' ? 'Lost' : 'Tied';
    const myVal = formatResultValue(h.mode, h.myResult);
    const oppVal = formatResultValue(h.mode, h.oppResult);
    return `
      <div class="duel-history-round ${cls}">
        <span class="duel-history-mode">${MODE_LABEL[h.mode]}${h.suddenDeath ? ' (SD)' : ''}</span>
        <span class="duel-history-score">You ${myVal} &ndash; Opp ${oppVal}</span>
        <span class="duel-history-result">${label}</span>
      </div>
    `;
  }).join('');
}
