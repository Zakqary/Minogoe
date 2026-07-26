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

function setQueueStatus(msg) { document.getElementById('duelQueueStatus').textContent = msg || ''; }
function setBanner(msg) { document.getElementById('spBanner').textContent = msg; }

// ---------- Queueing ----------
const queueBtn = document.getElementById('duelQueueBtn');
queueBtn.addEventListener('click', () => {
  if (queueing) cancelDuelQueue();
  else startDuelQueue();
});

function startDuelQueue() {
  const user = Auth.getUser();
  if (!user) { setQueueStatus('Sign in (top right) first to queue for duels.'); return; }
  const profile = Auth.getProfile();
  const duelEloRating = profile ? (profile.duel_elo_rating ?? 1200) : 1200;
  queueing = true;
  queueBtn.textContent = 'Cancel';
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

function cancelDuelQueue() {
  Net3.cancelQueue();
  queueing = false;
  queueBtn.textContent = 'Find Match';
  setQueueStatus('');
}

// ---------- Match start ----------
function handleReady() {
  queueing = false;
  queueBtn.textContent = 'Find Match';
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
  document.getElementById('duelQueuePanel').style.display = 'none';
  document.getElementById('duelMatchPanel').style.display = '';
  document.getElementById('duelMatchHeader').style.display = '';
  document.querySelector('.sp-mode-tabs').style.display = 'none';
  document.getElementById('spStartBtn').style.display = 'none';
  document.getElementById('spModeTitle').style.display = 'none';

  Engine.setOnRoundFinished(onMyRoundFinished);

  const profile = Auth.getProfile();
  const myElo = profile ? (profile.duel_elo_rating ?? 1200) : 1200;
  document.getElementById('duelMyName').textContent = profile?.username || 'You';
  document.getElementById('duelMyElo').textContent = `ELO ${myElo}`;
  Net3.send({ type: 'duel-identify', userId: Auth.getUser()?.id ?? null, username: profile?.username || 'Player', eloRating: myElo });

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
    document.getElementById('duelOppName').textContent = msg.username;
    document.getElementById('duelOppElo').textContent = `ELO ${msg.eloRating}`;
    return;
  }
  if (msg.type === 'duel-round-start') {
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
  clearTimeout(countdownTimer);
  clearTimeout(roundTimeLimitTimer);
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

function onMyRoundFinished() {
  if (!duelState.currentRound || duelState.myResult) return;
  clearTimeout(roundTimeLimitTimer);
  const result = normalizeResult(duelState.currentRound.mode);
  duelState.myResult = result;
  Net3.send({ type: 'duel-round-result', roundIndex: duelState.currentRound.roundIndex, result });
  setBanner('Round over on your side. Waiting for your opponent to finish...');
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
  const winner = compareDuelRound(duelState.currentRound.mode, duelState.myResult, duelState.oppResult);
  recordRoundOutcome(duelState.currentRound.mode, winner, duelState.currentRound.suddenDeath);
  advanceSeriesOrFinish();
}

function recordRoundOutcome(mode, winner, suddenDeath) {
  if (winner === 'me') duelState.myWins++;
  else if (winner === 'opp') duelState.oppWins++;
  else duelState.ties++;
  duelState.history.push({ roundIndex: duelState.currentRound.roundIndex, mode, winner, suddenDeath: !!suddenDeath });
  renderHistoryUI();
  updateMatchHeaderUI();
}

// First to 2 round-wins ends the series outright. Otherwise, once 3 regular
// rounds are done, whoever has more wins takes it (a tie round doesn't cost
// either side a win, so e.g. 1-0 with one tied round still resolves here).
// Only a genuine tie after all 3 regular rounds (including 0-0 with 3 ties)
// goes to sudden death - and a sudden-death round that itself ties just
// gets replayed with a fresh mode, per the user's own decision.
function advanceSeriesOrFinish() {
  if (duelState.myWins >= 2 || duelState.oppWins >= 2) {
    finishMatch(duelState.myWins > duelState.oppWins ? 'me' : 'opp');
    return;
  }
  const last = duelState.history[duelState.history.length - 1];
  if (last.suddenDeath) {
    if (last.winner === 'tie') {
      if (duelState.isHost) setTimeout(() => startNextRound(true), 1500);
      else setBanner('Still tied - one more sudden-death round coming up...');
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
      setTimeout(() => startNextRound(true), 1500);
    } else {
      setBanner('Series tied after 3 rounds - sudden death incoming...');
    }
    return;
  }
  if (duelState.isHost) setTimeout(() => startNextRound(false), 1500);
  else setBanner('Round over - waiting for the next round...');
}

function finishMatch(winnerSide) {
  duelState.matchWinner = winnerSide;
  clearTimeout(countdownTimer);
  clearTimeout(roundTimeLimitTimer);
  document.getElementById('duelMatchHeader').style.display = 'none';
  setBanner(winnerSide === 'me' ? 'You won the duel!' : 'You lost the duel.');
  submitDuelResult();
}

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
// continues to the next round. Both the WebRTC peer connection dying
// outright (onPeerLeft) and the signaling-server-driven grace period fully
// expiring (onOpponentTimeout) are treated the same way here: whichever
// side is still connected wins whatever round was in progress and then
// keeps the series going, taking over as the authoritative round-scheduler
// if the original host was the one who disconnected.
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

function handlePeerLeft() {
  if (!duelState.active) {
    if (queueing) {
      queueing = false;
      queueBtn.textContent = 'Find Match';
      setQueueStatus('Connection lost. Try queueing again.');
    }
    return;
  }
  forfeitCurrentRoundForOpponent();
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

function renderHistoryUI() {
  const container = document.getElementById('duelHistory');
  container.innerHTML = duelState.history.map((h) => {
    const cls = h.winner === 'me' ? 'duel-round-win' : h.winner === 'opp' ? 'duel-round-loss' : '';
    const label = h.winner === 'me' ? 'Won' : h.winner === 'opp' ? 'Lost' : 'Tied';
    return `<span class="duel-history-round ${cls}">${MODE_LABEL[h.mode]}: ${label}${h.suddenDeath ? ' (SD)' : ''}</span>`;
  }).join('');
}
