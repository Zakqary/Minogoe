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
const RECONNECT_GRACE_MS = 30000;

// roomCode -> { mode, slots: [slot, slot] }
// slot: { socket (null while disconnected), userId (null for private rooms),
//         isHost, disconnectTimer (null unless mid-grace-period) }
const rooms = new Map();
const socketRoom = new Map();  // socket -> roomCode

const casualQueue = [];        // { socket, userId, eloRating }
const rankedQueue = [];

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

function tryMatchCasual() {
  while (casualQueue.length >= 2) {
    const a = casualQueue.shift();
    const b = casualQueue.shift();
    if (a.socket.readyState !== WebSocket.OPEN && b.socket.readyState !== WebSocket.OPEN) continue;
    if (a.socket.readyState !== WebSocket.OPEN) { casualQueue.unshift(b); continue; }
    if (b.socket.readyState !== WebSocket.OPEN) { casualQueue.unshift(a); continue; }
    pairSockets(a, b, 'casual');
  }
}

function tryMatchRanked() {
  while (rankedQueue.length >= 2) {
    let bestI = 0, bestJ = 1, bestDiff = Infinity;
    for (let i = 0; i < rankedQueue.length; i++) {
      for (let j = i + 1; j < rankedQueue.length; j++) {
        const diff = Math.abs(rankedQueue[i].eloRating - rankedQueue[j].eloRating);
        if (diff < bestDiff) { bestDiff = diff; bestI = i; bestJ = j; }
      }
    }
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
  if (room.slots.length === 0) rooms.delete(roomCode);
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
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const roomCode = String(msg.room || '').trim().toUpperCase();
      if (!roomCode) return;

      let room = rooms.get(roomCode);
      if (!room) {
        room = { mode: 'private', slots: [] };
        rooms.set(roomCode, room);
      }
      if (room.slots.length >= 2) {
        socket.send(JSON.stringify({ type: 'full' }));
        return;
      }

      const isHost = room.slots.length === 0;
      room.slots.push({ socket, userId: null, isHost, disconnectTimer: null });
      socketRoom.set(socket, roomCode);
      socket.send(JSON.stringify({ type: 'joined', isHost }));

      if (room.slots.length === 2) {
        for (const s of room.slots) {
          s.socket.send(JSON.stringify({ type: 'ready', mode: 'private' }));
        }
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
      }
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
