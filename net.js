// Thin peer-to-peer layer: a WebSocket to a signaling server is used only
// to exchange the WebRTC handshake (offer/answer/ICE candidates). Once the
// RTCPeerConnection's data channel opens, all game moves flow directly
// between the two browsers - the signaling server never sees them.
const Net = (() => {
  // STUN alone only works when at least one side has an easily-traversable NAT.
  // Behind stricter firewalls (corporate networks, some mobile carriers) a TURN
  // relay is required as a fallback. These are the Open Relay Project's public
  // test TURN credentials (https://www.metered.ca/tools/openrelay/) - fine for
  // casual play; swap in your own TURN credentials if you need higher reliability.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  const CONNECT_TIMEOUT_MS = 15000;

  let ws = null;
  let pc = null;
  let dc = null;
  let isHost = false;
  let connected = false;
  let callbacks = {};
  let connectTimeoutId = null;
  let remoteDescSet = false;
  let pendingCandidates = [];
  let matchedMode = 'private';
  let matchId = null;
  let isRejoin = false;

  // Application-level liveness check on the data channel itself, separate
  // from (and faster/more reliable than) both the signaling server's own
  // heartbeat - which only watches the signaling socket, not the actual P2P
  // game channel - and WebRTC's native connection-state transitions, which
  // can be slow or simply never fire cleanly across a mobile tab being
  // backgrounded and resumed. If nothing (including our own periodic pings)
  // has arrived within STALE_THRESHOLD_MS, the channel is treated as dead.
  const HEARTBEAT_SEND_INTERVAL_MS = 5000;
  const STALE_THRESHOLD_MS = 13000;
  let lastActivityAt = null;
  let heartbeatSendTimer = null;
  let staleCheckTimer = null;
  let staleReported = false;

  function startHeartbeat() {
    stopHeartbeat();
    staleReported = false;
    lastActivityAt = Date.now();
    heartbeatSendTimer = setInterval(() => {
      if (dc && dc.readyState === 'open') {
        try { dc.send(JSON.stringify({ type: '__ping' })); } catch { /* a truly dead channel is caught by the staleness check below */ }
      }
    }, HEARTBEAT_SEND_INTERVAL_MS);
    staleCheckTimer = setInterval(checkStaleness, 3000);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatSendTimer);
    clearInterval(staleCheckTimer);
    heartbeatSendTimer = null;
    staleCheckTimer = null;
  }

  function checkStaleness() {
    if (!connected || lastActivityAt === null || staleReported) return;
    if (Date.now() - lastActivityAt > STALE_THRESHOLD_MS) {
      staleReported = true;
      callbacks.onConnectionStale && callbacks.onConnectionStale();
    }
  }

  // Lets a caller force an immediate check instead of waiting up to 3s for
  // the next periodic tick - used when a tab regains visibility, so a
  // phone coming back from the background gets checked right away.
  function checkConnectionNow() {
    checkStaleness();
  }

  async function flushPendingCandidates() {
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('Pentomino Net: failed to add queued ICE candidate', err);
      }
    }
  }

  function setupPeerConnection() {
    stopHeartbeat(); // any timers from a previous pc/dc no longer apply
    remoteDescSet = false;
    pendingCandidates = [];
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    window.__pentominoPC = pc;
    window.__pentominoDebug = () => ({
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
    });
    console.log('Pentomino Net: peer connection created. isHost =', isHost,
      '- run __pentominoDebug() anytime to see live state.');

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        console.log('Pentomino Net: local ICE candidate gathered - type:', e.candidate.type, 'protocol:', e.candidate.protocol, 'address:', e.candidate.address);
        ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
      } else {
        console.log('Pentomino Net: ICE candidate gathering finished.');
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('Pentomino Net: connection state:', pc.connectionState);
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        if (connected) {
          connected = false;
          callbacks.onPeerLeft && callbacks.onPeerLeft();
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('Pentomino Net: ICE connection state:', pc.iceConnectionState);
    };

    pc.onicegatheringstatechange = () => {
      console.log('Pentomino Net: ICE gathering state:', pc.iceGatheringState);
    };

    pc.onicecandidateerror = (e) => {
      console.error('Pentomino Net: ICE candidate error - url:', e.url, 'errorCode:', e.errorCode, 'errorText:', e.errorText);
    };

    if (isHost) {
      dc = pc.createDataChannel('game');
      wireDataChannel();
    } else {
      pc.ondatachannel = (e) => {
        dc = e.channel;
        wireDataChannel();
      };
    }

    clearTimeout(connectTimeoutId);
    connectTimeoutId = setTimeout(() => {
      if (!connected) {
        callbacks.onStatus && callbacks.onStatus(
          'Still trying to connect... this can take a while on restrictive networks/firewalls.'
        );
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function wireDataChannel() {
    dc.onopen = () => {
      connected = true;
      clearTimeout(connectTimeoutId);
      startHeartbeat();
      callbacks.onStatus && callbacks.onStatus('Connected!');
      callbacks.onReady && callbacks.onReady();
    };
    dc.onclose = () => {
      stopHeartbeat();
      if (connected) {
        connected = false;
        callbacks.onPeerLeft && callbacks.onPeerLeft();
      }
    };
    dc.onmessage = (e) => {
      lastActivityAt = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === '__ping') return; // liveness probe only, not app data
      callbacks.onData && callbacks.onData(msg);
    };
  }

  async function handleSignal(msg) {
    if (msg.type === 'joined') {
      isHost = msg.isHost;
      matchId = msg.matchId || matchId;
      callbacks.onStatus && callbacks.onStatus(
        isHost ? 'Waiting for your friend to join the room...' : 'Room found. Waiting on host to connect...'
      );
      return;
    }

    if (msg.type === 'full') {
      callbacks.onStatus && callbacks.onStatus('That room already has two players. Try a different room code.');
      callbacks.onRoomFull && callbacks.onRoomFull();
      return;
    }

    if (msg.type === 'queue-error') {
      callbacks.onStatus && callbacks.onStatus(msg.message || 'Could not join the queue.');
      return;
    }

    if (msg.type === 'rejoin-failed') {
      callbacks.onRejoinFailed && callbacks.onRejoinFailed(msg.reason);
      return;
    }

    if (msg.type === 'ready') {
      matchedMode = msg.mode || 'private';
      isRejoin = !!msg.isRejoin;
      callbacks.onStatus && callbacks.onStatus('Opponent found - establishing direct connection...');
      setupPeerConnection();
      if (isHost) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
      }
      return;
    }

    if (msg.type === 'offer') {
      if (!pc) setupPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      remoteDescSet = true;
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
      return;
    }

    if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      remoteDescSet = true;
      await flushPendingCandidates();
      return;
    }

    if (msg.type === 'ice') {
      if (!pc || !msg.candidate) return;
      const candidate = new RTCIceCandidate(msg.candidate);
      if (remoteDescSet) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.error('Pentomino Net: failed to add ICE candidate', err);
        }
      } else {
        pendingCandidates.push(candidate);
      }
      return;
    }

    if (msg.type === 'peer-left') {
      if (connected) {
        connected = false;
        callbacks.onStatus && callbacks.onStatus('Your opponent disconnected.');
        callbacks.onPeerLeft && callbacks.onPeerLeft();
      }
      return;
    }

    if (msg.type === 'opponent-disconnected') {
      callbacks.onOpponentDisconnected && callbacks.onOpponentDisconnected(msg.graceMs);
      return;
    }

    if (msg.type === 'opponent-timeout') {
      callbacks.onOpponentTimeout && callbacks.onOpponentTimeout();
      return;
    }
  }

  function openSocket(serverUrl, onOpen, cbs) {
    callbacks = cbs;

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
      if (!connected) {
        callbacks.onStatus && callbacks.onStatus('Signaling connection closed before pairing completed.');
      }
    };
  }

  function connect({ serverUrl, joinMessage, onStatus, onReady, onData, onPeerLeft, onOpponentDisconnected, onOpponentTimeout, onRoomFull, onConnectionStale }) {
    isHost = false;
    connected = false;
    matchedMode = 'private';
    matchId = null;
    isRejoin = false;

    openSocket(serverUrl, () => {
      callbacks.onStatus && callbacks.onStatus('Connected to signaling server...');
      ws.send(JSON.stringify(joinMessage));
    }, { onStatus, onReady, onData, onPeerLeft, onOpponentDisconnected, onOpponentTimeout, onRoomFull, onConnectionStale });
  }

  // Re-establishes a fresh WebSocket + RTCPeerConnection into a match you
  // were previously paired into (identified by matchId), within the grace
  // window the signaling server holds the room open for after a disconnect.
  function rejoin({ serverUrl, matchId: targetMatchId, userId, accessToken, onStatus, onReady, onData, onPeerLeft, onOpponentDisconnected, onOpponentTimeout, onRejoinFailed, onConnectionStale }) {
    isHost = false;
    connected = false;
    matchedMode = 'private';
    isRejoin = false;

    openSocket(serverUrl, () => {
      callbacks.onStatus && callbacks.onStatus('Reconnecting to your match...');
      ws.send(JSON.stringify({ type: 'rejoin', matchId: targetMatchId, userId, accessToken }));
    }, { onStatus, onReady, onData, onPeerLeft, onOpponentDisconnected, onOpponentTimeout, onRejoinFailed, onConnectionStale });
  }

  function cancelQueue() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unqueue' }));
      ws.close();
    }
  }

  // Tells the signaling server this match is over, so it doesn't hold a
  // casual/ranked room (and its reconnect bookkeeping) open indefinitely.
  function leaveRoom() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave-room' }));
    }
  }

  function send(obj) {
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(obj));
    }
  }

  return {
    connect,
    rejoin,
    send,
    cancelQueue,
    leaveRoom,
    checkConnectionNow,
    get isHost() { return isHost; },
    get connected() { return connected; },
    get matchedMode() { return matchedMode; },
    get matchId() { return matchId; },
    get isRejoin() { return isRejoin; },
  };
})();
