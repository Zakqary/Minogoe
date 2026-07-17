// Signaling relay: pairs two sockets into a "room" and forwards whatever
// WebRTC handshake messages (offer/answer/ICE candidates) they send each
// other. It never looks at game moves - once the two browsers establish
// their direct WebRTC connection, this server is out of the loop.
//
// Also runs the casual/ranked matchmaking queues: once two sockets are
// paired (by the manual room-code flow OR by the queue), they're handled
// identically from here on - queue matching just decides who gets grouped
// into the same room.

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = 'https://kokygjmttluthboxckct.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_aH7g-hhPpt-1or4nBP6UvA_bZkS13Td';
// Was 30s - too short for a realistic mobile recovery (reload the page,
// re-establish the Supabase session, reopen the signaling socket, THEN
// attempt the rejoin), especially right after coming back from being
// backgrounded, where connectivity is often momentarily poor. A too-short
// grace period means the room gets deleted (and the rejoin permanently
// rejected as "no longer available") before the client even gets a chance
// to try.
const RECONNECT_GRACE_MS = 60000;

// roomCode -> { mode, slots: [slot, slot] }
// slot: { socket (null while disconnected), userId (null for private rooms),
//         isHost, disconnectTimer (null unless mid-grace-period) }
const rooms = new Map();
const socketRoom = new Map();  // socket -> roomCode

const casualQueue = [];        // { socket, userId, eloRating }
const rankedQueue = [];

// Read-only spectator support. Deliberately built entirely on TOP of the
// existing room/relay machinery above, never modifying it - a spectator
// socket never enters `rooms`/`socketRoom` (it isn't a player, doesn't get
// relayed offer/answer/ice, and can't be paired) and a playing client's
// normal P2P game flow never depends on any of this existing or working.
// Every hook added to net.js/game.js for this is a fire-and-forget extra
// send alongside the real one, over the signaling socket the client already
// keeps open for the whole match (not the WebRTC data channel) - if a
// spectator message is lost or this whole system fell over, the actual
// P2P game is completely unaffected.
//
// roomCode -> { mode, boardSize, initialHand, moveLog: [], startedAt,
//               hostPlayerNum (1|2|null - which board-color the HOST is
//               playing as THIS game; can flip between rematches, see
//               game.js's computeMyPlayerForCurrentGame()),
//               players: { host: {username,avatarId,titleId} | null,
//                          joiner: same | null },
//               spectators: Set<socket> }
const liveGames = new Map();
const socketSpectating = new Map(); // spectator socket -> roomCode

const MAX_SPECTATORS_PER_GAME = 100;
const MAX_LIVE_GAMES_LISTED = 8;

function getOrCreateLiveGame(roomCode) {
  let game = liveGames.get(roomCode);
  if (!game) {
    game = {
      mode: null,
      boardSize: null,
      initialHand: null,
      moveLog: [],
      startedAt: Date.now(),
      hostPlayerNum: null,
      players: { host: null, joiner: null },
      spectators: new Set(),
    };
    liveGames.set(roomCode, game);
  }
  return game;
}

// Maps the internal {host, joiner} identity slots onto the {1, 2} board
// colors the moveLog/spectator client actually use - hostPlayerNum can be
// null very briefly (identify can arrive before the host's own newGame()
// broadcast) or after a rematch flips it; defaults to "host is player 1"
// in that narrow window rather than showing no names at all.
function resolvedLivePlayers(game) {
  const hostNum = game.hostPlayerNum || 1;
  const joinerNum = hostNum === 1 ? 2 : 1;
  return { [hostNum]: game.players.host, [joinerNum]: game.players.joiner };
}

function broadcastToSpectators(game, msg) {
  const raw = JSON.stringify(msg);
  for (const s of game.spectators) {
    if (s.readyState === WebSocket.OPEN) s.send(raw);
  }
}

// Called from every path that tears down a real match room (normal end,
// forfeit/timeout, private room departure) - tells any spectators the game
// is over and forgets it. Safe to call even if no one was ever spectating,
// or if live-game-start never actually arrived (e.g. a vs-bot/hotseat game
// never registers one in the first place).
function endLiveGame(roomCode) {
  const game = liveGames.get(roomCode);
  if (!game) return;
  broadcastToSpectators(game, { type: 'spectate-ended' });
  for (const s of game.spectators) socketSpectating.delete(s);
  liveGames.delete(roomCode);
}

// This server only ever relays small handshake messages (SDP offers/
// answers, ICE candidates, room codes, chat text) - actual game moves flow
// peer-to-peer once WebRTC connects (see net.js). Nothing legitimate is
// anywhere close to these limits, so they cost real clients nothing; they
// exist purely to cap the blast radius of a malicious or buggy client
// spamming this endpoint, which is now a bigger concern with a larger
// public user base.
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_ROOM_CODE_LENGTH = 32;
const MAX_CONNECTIONS = 5000;

// Simple fixed-window per-socket rate limit on the 'message' event - resets
// every RATE_LIMIT_WINDOW_MS. A real client sends at most a handful of
// messages per second even during connection setup (one offer/answer plus a
// few trickled ICE candidates); this window is generous enough to never
// affect normal play while still cutting off a flooding client quickly.
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 40;
const socketMessageCounts = new WeakMap(); // socket -> { count, windowStart }

// A socket's 'queue'/'rejoin' handler awaits an async Supabase verification
// before mutating any queue/room state. If the same socket's request gets
// processed twice in close succession (double-click, client retry, a stray
// duplicate send), both in-flight handlers can each add their own queue
// entry / claim before either sees the other's - letting one socket end up
// matched into two rooms at once, silently stealing its own signaling
// routing out from under itself. Track in-flight requests per socket and
// drop duplicates instead of racing.
const pendingSocketRequests = new Set();

// Plain HTTP endpoint (same port as the WebSocket server) so the client can
// poll queue sizes before committing to actually joining one.
const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/queue-counts') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ casual: casualQueue.length, ranked: rankedQueue.length }));
    return;
  }
  if (req.method === 'GET' && req.url === '/live-games') {
    const list = [...liveGames.entries()]
      .filter(([, game]) => game.moveLog.length > 0) // skip games that haven't had a real move yet
      .sort((a, b) => b[1].startedAt - a[1].startedAt)
      .slice(0, MAX_LIVE_GAMES_LISTED)
      .map(([matchId, game]) => {
        const players = resolvedLivePlayers(game);
        return {
          matchId,
          mode: game.mode,
          player1: players[1],
          player2: players[2],
          moveCount: game.moveLog.length,
          startedAt: game.startedAt,
        };
      });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(list));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server: httpServer });

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function pairSockets(entryA, entryB, mode) {
  const code = generateRoomCode();
  const slots = [
    { socket: entryA.socket, userId: entryA.userId ?? null, isHost: true, disconnectTimer: null },
    { socket: entryB.socket, userId: entryB.userId ?? null, isHost: false, disconnectTimer: null },
  ];
  rooms.set(code, { mode, slots });
  socketRoom.set(entryA.socket, code);
  socketRoom.set(entryB.socket, code);

  entryA.socket.send(JSON.stringify({ type: 'joined', isHost: true, matchId: code }));
  entryB.socket.send(JSON.stringify({ type: 'joined', isHost: false, matchId: code }));
  entryA.socket.send(JSON.stringify({ type: 'ready', mode }));
  entryB.socket.send(JSON.stringify({ type: 'ready', mode }));
}

function removeFromQueues(socket) {
  for (const q of [casualQueue, rankedQueue]) {
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].socket === socket) q.splice(i, 1);
    }
  }
}

// Finds the first pair of DIFFERENT users in the queue (queue order, not
// necessarily indices 0/1) and pairs them - skips over same-user pairs so
// a player can never end up matched against their own second tab/device.
// If everyone currently waiting happens to be the same user (multi-
// tabbing with no one else in queue), this just stops - they stay queued
// until a genuine opponent shows up, exactly like normal "still waiting."
function tryMatchCasual() {
  while (true) {
    let pair = null;
    outer:
    for (let i = 0; i < casualQueue.length; i++) {
      for (let j = i + 1; j < casualQueue.length; j++) {
        if (casualQueue[i].userId !== casualQueue[j].userId) { pair = [i, j]; break outer; }
      }
    }
    if (!pair) return;
    const [i, j] = pair;
    const b = casualQueue.splice(j, 1)[0];
    const a = casualQueue.splice(i, 1)[0];
    if (a.socket.readyState !== WebSocket.OPEN && b.socket.readyState !== WebSocket.OPEN) continue;
    if (a.socket.readyState !== WebSocket.OPEN) { casualQueue.push(b); continue; }
    if (b.socket.readyState !== WebSocket.OPEN) { casualQueue.push(a); continue; }
    pairSockets(a, b, 'casual');
  }
}

// Same closest-ELO search as before, but the same-user skip above also
// applies here - the inner scan just ignores any pair sharing a userId
// while still finding the closest-rated valid pair among the rest.
function tryMatchRanked() {
  while (true) {
    let bestI = -1, bestJ = -1, bestDiff = Infinity;
    for (let i = 0; i < rankedQueue.length; i++) {
      for (let j = i + 1; j < rankedQueue.length; j++) {
        if (rankedQueue[i].userId === rankedQueue[j].userId) continue;
        const diff = Math.abs(rankedQueue[i].eloRating - rankedQueue[j].eloRating);
        if (diff < bestDiff) { bestDiff = diff; bestI = i; bestJ = j; }
      }
    }
    if (bestI === -1) return;
    const b = rankedQueue.splice(bestJ, 1)[0];
    const a = rankedQueue.splice(bestI, 1)[0];
    if (a.socket.readyState !== WebSocket.OPEN && b.socket.readyState !== WebSocket.OPEN) continue;
    if (a.socket.readyState !== WebSocket.OPEN) { rankedQueue.push(b); continue; }
    if (b.socket.readyState !== WebSocket.OPEN) { rankedQueue.push(a); continue; }
    pairSockets(a, b, 'ranked');
  }
}

async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Private rooms (friend room-code games): a departure is final, exactly like
// before - notify whoever's left immediately and free up the vacated slot.
function removePrivateRoomSlot(socket, roomCode, room) {
  const idx = room.slots.findIndex((s) => s.socket === socket);
  if (idx !== -1) room.slots.splice(idx, 1);
  for (const s of room.slots) {
    if (s.socket && s.socket.readyState === WebSocket.OPEN) {
      s.socket.send(JSON.stringify({ type: 'peer-left' }));
    }
  }
  if (room.slots.length === 0) {
    rooms.delete(roomCode);
    endLiveGame(roomCode);
  }
}

// Casual/ranked: don't tear the match down immediately - hold the slot open
// for RECONNECT_GRACE_MS in case the disconnected player reloads/rejoins.
function startDisconnectGrace(socket, roomCode, room, slot) {
  slot.socket = null;
  const other = room.slots.find((s) => s !== slot);
  if (other && other.socket && other.socket.readyState === WebSocket.OPEN) {
    other.socket.send(JSON.stringify({ type: 'opponent-disconnected', graceMs: RECONNECT_GRACE_MS }));
  }
  clearTimeout(slot.disconnectTimer);
  slot.disconnectTimer = setTimeout(() => {
    const stillHere = room.slots.find((s) => s !== slot);
    if (stillHere && stillHere.socket && stillHere.socket.readyState === WebSocket.OPEN) {
      stillHere.socket.send(JSON.stringify({ type: 'opponent-timeout' }));
      socketRoom.delete(stillHere.socket);
    }
    rooms.delete(roomCode);
    endLiveGame(roomCode);
  }, RECONNECT_GRACE_MS);
}

function removeFromRoom(socket, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.mode === 'private') {
    removePrivateRoomSlot(socket, roomCode, room);
    return;
  }

  const slot = room.slots.find((s) => s.socket === socket);
  if (!slot) return;
  startDisconnectGrace(socket, roomCode, room, slot);
}

// Hosting platforms (Render included) commonly drop WebSocket connections
// that sit idle through their proxy layer, with no clean close frame - the
// socket just silently stops working. This matters most for private rooms,
// where a host can sit waiting for a friend to type in a code for a while
// (unlike the queues, which usually match quickly once anyone's in them).
// A periodic ping/pong both keeps the connection active from the proxy's
// perspective and lets us proactively clean up truly-dead sockets instead
// of waiting on a TCP timeout that may never come.
const HEARTBEAT_INTERVAL_MS = 25000;

wss.on('connection', (socket) => {
  if (wss.clients.size > MAX_CONNECTIONS) {
    socket.close();
    return;
  }

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async (raw) => {
    if (raw.length > MAX_MESSAGE_BYTES) {
      socket.close();
      return;
    }

    const rateInfo = socketMessageCounts.get(socket);
    const now = Date.now();
    if (!rateInfo || now - rateInfo.windowStart > RATE_LIMIT_WINDOW_MS) {
      socketMessageCounts.set(socket, { count: 1, windowStart: now });
    } else {
      rateInfo.count++;
      if (rateInfo.count > RATE_LIMIT_MAX_MESSAGES) {
        socket.close();
        return;
      }
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      if (pendingSocketRequests.has(socket)) return; // already processing a request for this socket
      pendingSocketRequests.add(socket);
      try {
        const roomCode = String(msg.room || '').trim().toUpperCase().slice(0, MAX_ROOM_CODE_LENGTH);
        if (!roomCode) return;

        // Verified only if the client is logged in and supplied
        // credentials - a guest (or an older client from before this
        // existed) joins exactly as before, with userId left null. Never
        // trust msg.userId on its own without verifying it against the
        // access token, same discipline as the queue/rejoin handlers.
        let userId = null;
        if (msg.userId && msg.accessToken) {
          const user = await verifySupabaseUser(msg.accessToken);
          if (user && user.id === msg.userId) userId = user.id;
        }

        let room = rooms.get(roomCode);
        if (!room) {
          room = { mode: 'private', slots: [] };
          rooms.set(roomCode, room);
        }
        if (room.slots.length >= 2) {
          socket.send(JSON.stringify({ type: 'full' }));
          return;
        }

        // A logged-in player can't join their own private room from a
        // second tab/device - would otherwise let someone "play
        // themselves" and submit a fabricated result. This is on top of,
        // not instead of, the database's own games_distinct_players_check
        // constraint, which only ever catches it once a result is
        // actually submitted at the END of a game - this stops it at
        // matchmaking time instead. Guests (userId still null here) can't
        // be checked this way and are unaffected, same as before.
        if (userId && room.slots.some((s) => s.userId === userId)) {
          socket.send(JSON.stringify({ type: 'self-join-blocked' }));
          return;
        }

        const isHost = room.slots.length === 0;
        room.slots.push({ socket, userId, isHost, disconnectTimer: null });
        socketRoom.set(socket, roomCode);
        // matchId was missing here (unlike pairSockets()'s 'joined' for
        // queue matches, which always included it) - net.js's matchId
        // getter stayed null for every Direct Connect game as a result,
        // which is also very likely why game.js's client_match_id
        // (Net.matchId ? `${Net.matchId}-${gameSequence}` : null) fell
        // back to null for every Direct Connect game specifically, losing
        // the dedup protection Phase 51 tightened up.
        socket.send(JSON.stringify({ type: 'joined', isHost, matchId: roomCode }));

        if (room.slots.length === 2) {
          for (const s of room.slots) {
            s.socket.send(JSON.stringify({ type: 'ready', mode: 'private' }));
          }
        }
      } finally {
        pendingSocketRequests.delete(socket);
      }
      return;
    }

    if (msg.type === 'rejoin') {
      if (pendingSocketRequests.has(socket)) return; // already processing a request for this socket
      pendingSocketRequests.add(socket);
      try {
        const room = rooms.get(msg.matchId);
        if (!room) {
          socket.send(JSON.stringify({ type: 'rejoin-failed', reason: 'That match is no longer available.' }));
          return;
        }

        const user = await verifySupabaseUser(msg.accessToken);
        if (!user || user.id !== msg.userId) {
          socket.send(JSON.stringify({ type: 'rejoin-failed', reason: 'Could not verify your account. Please sign in again.' }));
          return;
        }

        const slot = room.slots.find((s) => s.userId === user.id);
        if (!slot) {
          socket.send(JSON.stringify({ type: 'rejoin-failed', reason: 'You are not part of that match.' }));
          return;
        }
        // A verified rejoin from the same user always supersedes whatever
        // socket was previously in this slot - a real page reload's old
        // connection may not have finished closing on our end yet (its
        // 'close' event can lag slightly behind the browser tearing it down),
        // and we don't want that race to block the one thing this feature
        // exists for. Just close the stale one out from under it.
        if (slot.socket && slot.socket !== socket && slot.socket.readyState === WebSocket.OPEN) {
          slot.socket.close();
        }

        clearTimeout(slot.disconnectTimer);
        slot.disconnectTimer = null;
        slot.socket = socket;
        socketRoom.set(socket, msg.matchId);

        socket.send(JSON.stringify({ type: 'joined', isHost: slot.isHost, matchId: msg.matchId }));

        // Both sides need a brand new RTCPeerConnection - the still-connected
        // peer's old one died along with the departed browser tab/page.
        for (const s of room.slots) {
          if (s.socket && s.socket.readyState === WebSocket.OPEN) {
            s.socket.send(JSON.stringify({ type: 'ready', mode: room.mode, isRejoin: true }));
          }
        }
      } finally {
        pendingSocketRequests.delete(socket);
      }
      return;
    }

    if (msg.type === 'queue') {
      if (pendingSocketRequests.has(socket)) return; // already processing a request for this socket
      pendingSocketRequests.add(socket);
      try {
        const queueType = msg.queueType === 'ranked' ? 'ranked' : 'casual';
        const user = await verifySupabaseUser(msg.accessToken);
        if (!user || user.id !== msg.userId) {
          socket.send(JSON.stringify({ type: 'queue-error', message: 'Could not verify your account. Please sign in again.' }));
          return;
        }

        removeFromQueues(socket);
        const entry = { socket, userId: user.id, eloRating: Number(msg.eloRating) || 1200 };
        if (queueType === 'ranked') {
          rankedQueue.push(entry);
          tryMatchRanked();
        } else {
          casualQueue.push(entry);
          tryMatchCasual();
        }
      } finally {
        pendingSocketRequests.delete(socket);
      }
      return;
    }

    if (msg.type === 'unqueue') {
      removeFromQueues(socket);
      return;
    }

    // Sent once a game legitimately ends, so casual/ranked rooms (which now
    // survive a disconnect for the reconnect grace period) don't linger
    // forever if both players just keep browsing instead of closing the tab.
    if (msg.type === 'leave-room') {
      const roomCode = socketRoom.get(socket);
      if (roomCode) {
        rooms.delete(roomCode);
        socketRoom.delete(socket);
        endLiveGame(roomCode);
      }
      return;
    }

    // ---- Spectator support (see the liveGames comment above) ----
    // Every handler below is sent by a PLAYING client, fire-and-forget,
    // alongside (never instead of) that client's real P2P message - a
    // missing/malformed room here just means this one update never reaches
    // spectators, nothing more.

    if (msg.type === 'live-game-start') {
      const roomCode = socketRoom.get(socket);
      const room = roomCode && rooms.get(roomCode);
      if (!room) return;
      const game = getOrCreateLiveGame(roomCode);
      game.mode = room.mode;
      game.boardSize = Number(msg.boardSize) || null;
      game.initialHand = Array.isArray(msg.initialHand) ? msg.initialHand : [];
      game.moveLog = [];
      game.hostPlayerNum = msg.hostPlayerNum === 2 ? 2 : 1;
      const players = resolvedLivePlayers(game);
      broadcastToSpectators(game, {
        type: 'spectate-reset',
        mode: game.mode,
        boardSize: game.boardSize,
        initialHand: game.initialHand,
        player1: players[1],
        player2: players[2],
      });
      return;
    }

    if (msg.type === 'live-player-info') {
      const roomCode = socketRoom.get(socket);
      const room = roomCode && rooms.get(roomCode);
      if (!room) return;
      const slot = room.slots.find((s) => s.socket === socket);
      if (!slot) return;
      const game = getOrCreateLiveGame(roomCode);
      const info = {
        username: typeof msg.username === 'string' ? msg.username.slice(0, 40) : null,
        avatarId: typeof msg.avatarId === 'string' ? msg.avatarId.slice(0, 40) : null,
        titleId: typeof msg.titleId === 'string' ? msg.titleId.slice(0, 40) : null,
      };
      if (slot.isHost) game.players.host = info; else game.players.joiner = info;
      return;
    }

    if (msg.type === 'live-game-move') {
      const roomCode = socketRoom.get(socket);
      const game = roomCode && liveGames.get(roomCode);
      if (!game) return;
      const move = {
        player: msg.player === 2 ? 2 : 1,
        shapeName: String(msg.shapeName || ''),
        orientationIndex: Number(msg.orientationIndex) || 0,
        r0: Number(msg.r0) || 0,
        c0: Number(msg.c0) || 0,
        t: Number(msg.t) || Date.now(),
      };
      game.moveLog.push(move);
      broadcastToSpectators(game, { type: 'spectate-move', ...move });
      return;
    }

    if (msg.type === 'spectate-join') {
      const matchId = String(msg.matchId || '').trim().toUpperCase().slice(0, MAX_ROOM_CODE_LENGTH);
      const game = liveGames.get(matchId);
      if (!game) {
        socket.send(JSON.stringify({ type: 'spectate-not-found' }));
        return;
      }
      if (game.spectators.size >= MAX_SPECTATORS_PER_GAME) {
        socket.send(JSON.stringify({ type: 'spectate-full' }));
        return;
      }
      game.spectators.add(socket);
      socketSpectating.set(socket, matchId);
      const players = resolvedLivePlayers(game);
      socket.send(JSON.stringify({
        type: 'spectate-snapshot',
        mode: game.mode,
        boardSize: game.boardSize,
        initialHand: game.initialHand,
        moveLog: game.moveLog,
        player1: players[1],
        player2: players[2],
        startedAt: game.startedAt,
      }));
      return;
    }

    // Anything else (offer / answer / ice) just gets relayed verbatim
    // to whichever other socket is in the same room.
    const joinedRoom = socketRoom.get(socket);
    if (joinedRoom) {
      const room = rooms.get(joinedRoom);
      if (room) {
        for (const s of room.slots) {
          if (s.socket && s.socket !== socket && s.socket.readyState === WebSocket.OPEN) {
            s.socket.send(raw.toString());
          }
        }
      }
    }
  });

  socket.on('close', () => {
    pendingSocketRequests.delete(socket);
    removeFromQueues(socket);
    const joinedRoom = socketRoom.get(socket);
    if (joinedRoom) {
      removeFromRoom(socket, joinedRoom);
      socketRoom.delete(socket);
    }
    const spectatingMatch = socketSpectating.get(socket);
    if (spectatingMatch) {
      const game = liveGames.get(spectatingMatch);
      if (game) game.spectators.delete(socket);
      socketSpectating.delete(socket);
    }
  });
});

const heartbeatInterval = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate(); // no pong since the last ping - treat as dead, this fires 'close' and runs normal cleanup
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

httpServer.listen(PORT);
console.log(`Minogoe signaling server listening on port ${PORT}`);
