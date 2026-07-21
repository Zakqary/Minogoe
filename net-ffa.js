// Networking for the 4-player free-for-all queue - a host-relay star, NOT a
// generalization of net.js's singleton pc/dc. Deliberately a separate
// module: net.js's tested 1:1 behavior (every other mode - private/casual/
// ranked) must never be put at risk by FFA's genuinely different
// connection shape. Structure mirrors net.js closely so it's easy to
// review side by side.
//
// Topology: seat 0 is always the host. Each of seats 1-3 opens exactly one
// WebRTC connection, to the host (never to each other). The host holds up
// to 3 simultaneous connections, one per non-host seat, and relays every
// message it receives on one connection to the other two before handing it
// to game.js - so game.js never has to know relaying is even happening; it
// just sees every message exactly once, tagged with which seat it actually
// originated from (via the `_fromSeat` field this module stamps on
// everything sent through send(), which survives the relay unmodified).
const NetFfa = (() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  const CONNECT_TIMEOUT_MS = 15000;
  const HEARTBEAT_SEND_INTERVAL_MS = 5000;
  const STALE_THRESHOLD_MS = 13000;

  let ws = null;
  let callbacks = {};
  let mySeat = null;      // 0-3, assigned by the server on ffa-joined
  let hostSeat = 0;
  let matchId = null;
  let isRejoinFlag = false;
  let connectTimeoutId = null;
  let hostReadyFired = false;

  function amHost() { return mySeat === 0; }

  // Host: keyed by seat (1|2|3), one entry per non-host connection.
  // Non-host: a single entry keyed by the string 'host'.
  // Each record: { pc, dc, remoteDescSet, pendingCandidates, lastActivityAt,
  //                heartbeatTimer, staleTimer, ready }
  const connections = new Map();

  function makeConnectionRecord() {
    return {
      pc: null, dc: null, remoteDescSet: false, pendingCandidates: [],
      lastActivityAt: null, heartbeatTimer: null, staleTimer: null, ready: false,
    };
  }

  function stopConnHeartbeat(rec) {
    clearInterval(rec.heartbeatTimer);
    clearInterval(rec.staleTimer);
    rec.heartbeatTimer = null;
    rec.staleTimer = null;
  }

  // Per-connection, not global - the host has up to 3 independent channels
  // that can each go stale on their own (one flaky joiner shouldn't be
  // confused with the whole match dying).
  function startConnHeartbeat(rec, seat) {
    stopConnHeartbeat(rec);
    rec.lastActivityAt = Date.now();
    rec.heartbeatTimer = setInterval(() => {
      if (rec.dc && rec.dc.readyState === 'open') {
        try { rec.dc.send(JSON.stringify({ type: '__ping' })); } catch { /* caught by the staleness check below */ }
      }
    }, HEARTBEAT_SEND_INTERVAL_MS);
    rec.staleTimer = setInterval(() => {
      if (rec.lastActivityAt !== null && Date.now() - rec.lastActivityAt > STALE_THRESHOLD_MS) {
        stopConnHeartbeat(rec);
        callbacks.onConnectionStale && callbacks.onConnectionStale(seat);
      }
    }, 3000);
  }

  async function flushPending(rec) {
    const queued = rec.pendingCandidates;
    rec.pendingCandidates = [];
    for (const candidate of queued) {
      try { await rec.pc.addIceCandidate(candidate); } catch (err) { console.error('NetFfa: failed to add queued ICE candidate', err); }
    }
  }

  // Forwards the ORIGINAL, unmodified message string - it already carries
  // whichever _fromSeat the true sender stamped via send(), so a relayed
  // message looks identical to the recipient whether it originated at the
  // host or was forwarded through it.
  function relayToOthers(exceptSeat, rawData) {
    for (const [seat, rec] of connections) {
      if (seat !== exceptSeat && rec.dc && rec.dc.readyState === 'open') {
        rec.dc.send(rawData);
      }
    }
  }

  function maybeFireHostReady() {
    if (hostReadyFired) return;
    for (const seat of [1, 2, 3]) {
      const rec = connections.get(seat);
      if (!rec || !rec.ready) return;
    }
    hostReadyFired = true;
    clearTimeout(connectTimeoutId);
    callbacks.onStatus && callbacks.onStatus('Connected!');
    callbacks.onReady && callbacks.onReady();
  }

  function wireDataChannel(rec, seat, isHostSide) {
    rec.dc.onopen = () => {
      rec.ready = true;
      startConnHeartbeat(rec, seat);
      if (isHostSide) {
        maybeFireHostReady();
      } else {
        clearTimeout(connectTimeoutId);
        callbacks.onStatus && callbacks.onStatus('Connected!');
        callbacks.onReady && callbacks.onReady();
      }
    };
    rec.dc.onclose = () => {
      stopConnHeartbeat(rec);
      if (rec.ready) {
        rec.ready = false;
        callbacks.onPeerLeft && callbacks.onPeerLeft(seat);
      }
    };
    rec.dc.onmessage = (e) => {
      rec.lastActivityAt = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === '__ping') return;
      if (isHostSide) relayToOthers(seat, e.data);
      const fromSeat = typeof msg._fromSeat === 'number' ? msg._fromSeat : seat;
      callbacks.onData && callbacks.onData(msg, fromSeat);
    };
  }

  function setupHostConnectionToSeat(seat) {
    const rec = makeConnectionRecord();
    connections.set(seat, rec);
    rec.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    rec.pc.onicecandidate = (e) => {
      if (e.candidate) ws.send(JSON.stringify({ type: 'ffa-ice', to: seat, candidate: e.candidate }));
    };
    rec.pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(rec.pc.connectionState) && rec.ready) {
        rec.ready = false;
        callbacks.onPeerLeft && callbacks.onPeerLeft(seat);
      }
    };
    rec.dc = rec.pc.createDataChannel('game');
    wireDataChannel(rec, seat, true);
    return rec;
  }

  // Called on every ffa-ready (a fresh match starting, OR a rejoin by
  // anyone) - always tears down and rebuilds all 3 connections rather than
  // trying to figure out which one specifically needed it, mirroring
  // net.js's own "both sides always rebuild on every ready" precedent for
  // the 2-player path.
  async function setupHostConnections() {
    hostReadyFired = false;
    for (const seat of [1, 2, 3]) {
      const existing = connections.get(seat);
      if (existing && existing.pc) { stopConnHeartbeat(existing); try { existing.pc.close(); } catch { /* already dead */ } }
      const rec = setupHostConnectionToSeat(seat);
      const offer = await rec.pc.createOffer();
      await rec.pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'ffa-offer', to: seat, sdp: rec.pc.localDescription }));
    }
  }

  function setupJoinerConnection() {
    const existing = connections.get('host');
    if (existing && existing.pc) { stopConnHeartbeat(existing); try { existing.pc.close(); } catch { /* already dead */ } }
    const rec = makeConnectionRecord();
    connections.set('host', rec);
    rec.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    rec.pc.onicecandidate = (e) => {
      if (e.candidate) ws.send(JSON.stringify({ type: 'ffa-ice', to: hostSeat, candidate: e.candidate }));
    };
    rec.pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(rec.pc.connectionState) && rec.ready) {
        rec.ready = false;
        callbacks.onPeerLeft && callbacks.onPeerLeft(hostSeat);
      }
    };
    rec.pc.ondatachannel = (e) => {
      rec.dc = e.channel;
      wireDataChannel(rec, hostSeat, false);
    };
    return rec;
  }

  async function handleSignal(msg) {
    if (msg.type === 'ffa-joined') {
      mySeat = msg.seat;
      hostSeat = typeof msg.hostSeat === 'number' ? msg.hostSeat : 0;
      matchId = msg.matchId || matchId;
      callbacks.onStatus && callbacks.onStatus(
        amHost() ? 'Waiting for 3 other players to connect...' : 'Seat found. Waiting on the host to connect...'
      );
      return;
    }

    if (msg.type === 'ffa-queue-error') {
      callbacks.onStatus && callbacks.onStatus(msg.message || 'Could not join the FFA queue.');
      return;
    }

    if (msg.type === 'ffa-rejoin-failed') {
      callbacks.onRejoinFailed && callbacks.onRejoinFailed(msg.reason);
      return;
    }

    if (msg.type === 'ffa-ready') {
      isRejoinFlag = !!msg.isRejoin;
      callbacks.onStatus && callbacks.onStatus('All 4 players found - establishing connections...');
      if (amHost()) {
        await setupHostConnections();
      } else {
        setupJoinerConnection();
      }
      clearTimeout(connectTimeoutId);
      connectTimeoutId = setTimeout(() => {
        callbacks.onStatus && callbacks.onStatus('Still trying to connect... this can take a while on restrictive networks/firewalls.');
      }, CONNECT_TIMEOUT_MS);
      return;
    }

    if (msg.type === 'ffa-offer') {
      // Only a non-host ever receives an offer, always from the host.
      let rec = connections.get('host');
      if (!rec || !rec.pc) rec = setupJoinerConnection();
      await rec.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      rec.remoteDescSet = true;
      await flushPending(rec);
      const answer = await rec.pc.createAnswer();
      await rec.pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'ffa-answer', to: hostSeat, sdp: rec.pc.localDescription }));
      return;
    }

    if (msg.type === 'ffa-answer') {
      // Only the host ever receives an answer, from whichever seat msg.from names.
      const rec = connections.get(msg.from);
      if (!rec || !rec.pc) return;
      await rec.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      rec.remoteDescSet = true;
      await flushPending(rec);
      return;
    }

    if (msg.type === 'ffa-ice') {
      const rec = amHost() ? connections.get(msg.from) : connections.get('host');
      if (!rec || !rec.pc || !msg.candidate) return;
      const candidate = new RTCIceCandidate(msg.candidate);
      if (rec.remoteDescSet) {
        try { await rec.pc.addIceCandidate(candidate); } catch (err) { console.error('NetFfa: failed to add ICE candidate', err); }
      } else {
        rec.pendingCandidates.push(candidate);
      }
      return;
    }

    if (msg.type === 'ffa-seat-disconnected') {
      callbacks.onSeatDisconnected && callbacks.onSeatDisconnected(msg.seat, !!msg.isHost, msg.graceMs);
      return;
    }

    if (msg.type === 'ffa-seat-forfeited') {
      callbacks.onSeatForfeited && callbacks.onSeatForfeited(msg.seat);
      return;
    }

    if (msg.type === 'ffa-match-abandoned') {
      callbacks.onMatchAbandoned && callbacks.onMatchAbandoned();
      return;
    }
  }

  function isFullyConnected() {
    if (mySeat === null) return false;
    if (amHost()) return hostReadyFired;
    const rec = connections.get('host');
    return !!(rec && rec.ready);
  }

  function openSocket(serverUrl, onOpen) {
    try {
      ws = new WebSocket(serverUrl);
    } catch {
      callbacks.onStatus && callbacks.onStatus('Invalid signaling server URL.');
      return;
    }
    ws.onopen = onOpen;
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleSignal(msg);
    };
    ws.onerror = () => {
      callbacks.onStatus && callbacks.onStatus('Could not reach the signaling server.');
    };
    ws.onclose = () => {
      if (!isFullyConnected()) {
        callbacks.onStatus && callbacks.onStatus('Signaling connection closed before all 4 players connected.');
      }
    };
  }

  function resetState() {
    mySeat = null;
    hostSeat = 0;
    matchId = null;
    isRejoinFlag = false;
    hostReadyFired = false;
    for (const [, rec] of connections) {
      stopConnHeartbeat(rec);
      if (rec.pc) { try { rec.pc.close(); } catch { /* already dead */ } }
    }
    connections.clear();
  }

  function connect({ serverUrl, userId, accessToken, tabId, onStatus, onReady, onData, onPeerLeft, onSeatDisconnected, onSeatForfeited, onMatchAbandoned, onConnectionStale }) {
    resetState();
    callbacks = { onStatus, onReady, onData, onPeerLeft, onSeatDisconnected, onSeatForfeited, onMatchAbandoned, onConnectionStale };
    openSocket(serverUrl, () => {
      callbacks.onStatus && callbacks.onStatus('Connected to signaling server...');
      ws.send(JSON.stringify({ type: 'ffa-queue', userId, accessToken, tabId }));
    });
  }

  // Re-establishes a fresh WebSocket + WebRTC connection(s) into an FFA
  // match you were previously seated in, within the grace window the
  // server holds it open for after a disconnect - mirrors Net.rejoin()'s
  // 2-player equivalent.
  function rejoin({ serverUrl, matchId: targetMatchId, userId, accessToken, tabId, onStatus, onReady, onData, onPeerLeft, onSeatDisconnected, onSeatForfeited, onMatchAbandoned, onRejoinFailed, onConnectionStale }) {
    resetState();
    callbacks = { onStatus, onReady, onData, onPeerLeft, onSeatDisconnected, onSeatForfeited, onMatchAbandoned, onRejoinFailed, onConnectionStale };
    openSocket(serverUrl, () => {
      callbacks.onStatus && callbacks.onStatus('Reconnecting to your match...');
      ws.send(JSON.stringify({ type: 'ffa-rejoin', matchId: targetMatchId, userId, accessToken, tabId }));
    });
  }

  function cancelQueue() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unqueue' }));
      ws.close();
    }
  }

  // No rematch flow exists for FFA (a finished match always just returns
  // everyone to the lobby to re-queue - see this project's decision), so
  // unlike Net.leaveRoom() there's no "give a rematch a grace window to
  // reuse this room" reason to defer this - safe to tell the server right
  // away that the match is over.
  function leaveRoom() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave-room' }));
    }
  }

  // Host: broadcasts to every currently-open connection. Non-host: sends to
  // its one connection (the host), which will relay it onward to the other
  // two. Either way, every message is stamped with the true sender's own
  // seat so a relayed message is indistinguishable from a direct one to the
  // recipient - see relayToOthers()'s own comment.
  function send(obj) {
    const payload = JSON.stringify({ ...obj, _fromSeat: mySeat });
    if (amHost()) {
      for (const [, rec] of connections) {
        if (rec.dc && rec.dc.readyState === 'open') rec.dc.send(payload);
      }
    } else {
      const rec = connections.get('host');
      if (rec && rec.dc && rec.dc.readyState === 'open') rec.dc.send(payload);
    }
  }

  // Same purpose as Net.sendToServer() - the live-game spectator feed, over
  // the signaling socket rather than a data channel. Never affects the
  // real P2P game if it fails.
  function sendToServer(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function checkConnectionNow() {
    const now = Date.now();
    for (const [seat, rec] of connections) {
      if (rec.lastActivityAt !== null && now - rec.lastActivityAt > STALE_THRESHOLD_MS) {
        callbacks.onConnectionStale && callbacks.onConnectionStale(seat);
      }
    }
  }

  return {
    connect,
    rejoin,
    send,
    sendToServer,
    cancelQueue,
    leaveRoom,
    checkConnectionNow,
    get mySeat() { return mySeat; },
    get hostSeat() { return hostSeat; },
    get isHost() { return amHost(); },
    get matchId() { return matchId; },
    get isRejoin() { return isRejoinFlag; },
    get connected() { return isFullyConnected(); },
    // Reuses net.js's own stable per-tab id rather than generating a
    // second, independent one - net.js is always loaded on the same page.
    get tabId() { return Net.tabId; },
  };
})();
