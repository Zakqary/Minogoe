// Minimal signaling relay: pairs two sockets into a "room" and forwards
// whatever WebRTC handshake messages (offer/answer/ICE candidates) they
// send each other. It never looks at game moves - once the two browsers
// establish their direct WebRTC connection, this server is out of the loop.

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// roomCode -> array of up to 2 sockets
const rooms = new Map();

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
  let joinedRoom = null;

  socket.on('message', (raw) => {
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
      joinedRoom = room;
      const isHost = peers.length === 1;
      socket.send(JSON.stringify({ type: 'joined', isHost }));

      if (peers.length === 2) {
        for (const p of peers) {
          p.send(JSON.stringify({ type: 'ready' }));
        }
      }
      return;
    }

    // Anything else (offer / answer / ice) just gets relayed verbatim
    // to whichever other socket is in the same room.
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
    if (joinedRoom) removeFromRoom(socket, joinedRoom);
  });
});

console.log(`Pentomino signaling server listening on port ${PORT}`);
