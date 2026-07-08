// Signaling relay: pairs two sockets into a "room" and forwards whatever
// WebRTC handshake messages (offer/answer/ICE candidates) they send each
// other. It never looks at game moves - once the two browsers establish
// their direct WebRTC connection, this server is out of the loop.
//
// Also runs the casual/ranked matchmaking queues: once two sockets are
// paired (by the manual room-code flow OR by the queue), they're handled
// identically from here on - queue matching just decides who gets grouped
// into the same room.

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = 'https://kokygjmttluthboxckct.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_aH7g-hhPpt-1or4nBP6UvA_bZkS13Td';

const wss = new WebSocket.Server({ port: PORT });

const rooms = new Map();       // roomCode -> array of up to 2 sockets
const socketRoom = new Map();  // socket -> roomCode

const casualQueue = [];        // { socket, userId, eloRating }
const rankedQueue = [];

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function pairSockets(socketA, socketB, mode) {
  const code = generateRoomCode();
  rooms.set(code, [socketA, socketB]);
  socketRoom.set(socketA, code);
  socketRoom.set(socketB, code);

  socketA.send(JSON.stringify({ type: 'joined', isHost: true }));
  socketB.send(JSON.stringify({ type: 'joined', isHost: false }));
  socketA.send(JSON.stringify({ type: 'ready', mode }));
  socketB.send(JSON.stringify({ type: 'ready', mode }));
}

function removeFromQueues(socket) {
  for (const q of [casualQueue, rankedQueue]) {
    const idx = q.findIndex((e) => e.socket === socket);
    if (idx !== -1) q.splice(idx, 1);
  }
}

function tryMatchCasual() {
  while (casualQueue.length >= 2) {
    const a = casualQueue.shift();
    const b = casualQueue.shift();
    if (a.socket.readyState !== WebSocket.OPEN) continue;
    if (b.socket.readyState !== WebSocket.OPEN) { casualQueue.unshift(a); continue; }
    pairSockets(a.socket, b.socket, 'casual');
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
    pairSockets(a.socket, b.socket, 'ranked');
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

function removeFromRoom(socket, room) {
  const peers = rooms.get(room);
  if (!peers) return;
  const idx = peers.indexOf(socket);
  if (idx !== -1) peers.splice(idx, 1);
  for (const p of peers) {
    if (p.readyState === WebSocket.OPEN) {
      p.send(JSON.stringify({ type: 'peer-left' }));
    }
  }
  if (peers.length === 0) rooms.delete(room);
}

wss.on('connection', (socket) => {
  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const room = String(msg.room || '').trim().toUpperCase();
      if (!room) return;

      let peers = rooms.get(room);
      if (!peers) {
        peers = [];
        rooms.set(room, peers);
      }
      if (peers.length >= 2) {
        socket.send(JSON.stringify({ type: 'full' }));
        return;
      }

      peers.push(socket);
      socketRoom.set(socket, room);
      const isHost = peers.length === 1;
      socket.send(JSON.stringify({ type: 'joined', isHost }));

      if (peers.length === 2) {
        for (const p of peers) {
          p.send(JSON.stringify({ type: 'ready', mode: 'private' }));
        }
      }
      return;
    }

    if (msg.type === 'queue') {
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
      return;
    }

    if (msg.type === 'unqueue') {
      removeFromQueues(socket);
      return;
    }

    // Anything else (offer / answer / ice) just gets relayed verbatim
    // to whichever other socket is in the same room.
    const joinedRoom = socketRoom.get(socket);
    if (joinedRoom) {
      const peers = rooms.get(joinedRoom) || [];
      for (const p of peers) {
        if (p !== socket && p.readyState === WebSocket.OPEN) {
          p.send(raw.toString());
        }
      }
    }
  });

  socket.on('close', () => {
    removeFromQueues(socket);
    const joinedRoom = socketRoom.get(socket);
    if (joinedRoom) {
      removeFromRoom(socket, joinedRoom);
      socketRoom.delete(socket);
    }
  });
});

console.log(`Minogoe signaling server listening on port ${PORT}`);
