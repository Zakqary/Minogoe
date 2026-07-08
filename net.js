// Thin peer-to-peer layer: a WebSocket to a signaling server is used only
// to exchange the WebRTC handshake (offer/answer/ICE candidates). Once the
// RTCPeerConnection's data channel opens, all game moves flow directly
// between the two browsers - the signaling server never sees them.
const Net = (() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  let ws = null;
  let pc = null;
  let dc = null;
  let isHost = false;
  let connected = false;
  let callbacks = {};

  function setupPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        if (connected) {
          connected = false;
          callbacks.onPeerLeft && callbacks.onPeerLeft();
        }
      }
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
  }

  function wireDataChannel() {
    dc.onopen = () => {
      connected = true;
      callbacks.onStatus && callbacks.onStatus('Connected!');
      callbacks.onReady && callbacks.onReady();
    };
    dc.onclose = () => {
      if (connected) {
        connected = false;
        callbacks.onPeerLeft && callbacks.onPeerLeft();
      }
    };
    dc.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      callbacks.onData && callbacks.onData(msg);
    };
  }

  async function handleSignal(msg) {
    if (msg.type === 'joined') {
      isHost = msg.isHost;
      callbacks.onStatus && callbacks.onStatus(
        isHost ? 'Waiting for your friend to join the room...' : 'Room found. Waiting on host to connect...'
      );
      return;
    }

    if (msg.type === 'full') {
      callbacks.onStatus && callbacks.onStatus('That room already has two players. Try a different room code.');
      return;
    }

    if (msg.type === 'ready') {
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
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
      return;
    }

    if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      return;
    }

    if (msg.type === 'ice') {
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { /* ignore */ }
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
  }

  function connect({ serverUrl, room, onStatus, onReady, onData, onPeerLeft }) {
    callbacks = { onStatus, onReady, onData, onPeerLeft };
    isHost = false;
    connected = false;

    try {
      ws = new WebSocket(serverUrl);
    } catch {
      callbacks.onStatus && callbacks.onStatus('Invalid signaling server URL.');
      return;
    }

    ws.onopen = () => {
      callbacks.onStatus && callbacks.onStatus('Connected to signaling server, joining room...');
      ws.send(JSON.stringify({ type: 'join', room }));
    };
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

  function send(obj) {
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(obj));
    }
  }

  return {
    connect,
    send,
    get isHost() { return isHost; },
    get connected() { return connected; },
  };
})();
