/**
 * WebSocket signaling cho cuộc gọi WebRTC (thoại / video)
 * Path: /ws/call — auth bằng cookie JWT (cùng origin)
 */
const { WebSocketServer } = require('ws');
const cookie = require('cookie');

function attachCallSignaling(httpServer, options = {}) {
  const {
    jwt,
    jwtSecret,
    cookieName = 'muctieu_token',
    onCallInvite = null,
  } = options;

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/call',
  });

  /** username → Set<WebSocket> */
  const clients = new Map();

  function addClient(username, ws) {
    if (!clients.has(username)) clients.set(username, new Set());
    clients.get(username).add(ws);
  }

  function removeClient(username, ws) {
    const set = clients.get(username);
    if (!set) return;
    set.delete(ws);
    if (!set.size) clients.delete(username);
  }

  function send(ws, payload) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch { /* ignore */ }
  }

  function sendToUser(username, payload, exceptWs = null) {
    const set = clients.get(username);
    if (!set || !set.size) return 0;
    let n = 0;
    set.forEach((ws) => {
      if (ws === exceptWs) return;
      send(ws, payload);
      n += 1;
    });
    return n;
  }

  function isOnline(username) {
    const set = clients.get(username);
    return !!(set && set.size);
  }

  function listOnline() {
    return Array.from(clients.keys());
  }

  function parseUserFromRequest(req) {
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const ticket = url.searchParams.get('ticket') || url.searchParams.get('token');
      if (ticket) {
        const payload = jwt.verify(ticket, jwtSecret);
        if (!payload || payload.purpose !== 'call-ws' || !payload.username) return null;
        return {
          username: String(payload.username),
          role: payload.role || 'admin',
        };
      }
      const raw = req.headers.cookie || '';
      const parsed = cookie.parse(raw || '');
      const token = parsed[cookieName];
      if (!token) return null;
      const payload = jwt.verify(token, jwtSecret);
      if (!payload || !payload.username) return null;
      return {
        username: String(payload.username),
        role: payload.role || 'admin',
      };
    } catch {
      return null;
    }
  }

  wss.on('connection', (ws, req) => {
    const user = parseUserFromRequest(req);
    if (!user) {
      send(ws, { type: 'error', error: 'Chưa đăng nhập' });
      ws.close(4401, 'unauthorized');
      return;
    }

    ws.user = user;
    ws.isAlive = true;
    addClient(user.username, ws);
    send(ws, {
      type: 'ready',
      username: user.username,
      online: listOnline(),
    });

    // Báo online cho người khác
    clients.forEach((_set, other) => {
      if (other === user.username) return;
      sendToUser(other, {
        type: 'presence',
        username: user.username,
        online: true,
      });
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw || ''));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const type = String(msg.type || '');

      if (type === 'ping') {
        send(ws, { type: 'pong', t: Date.now() });
        return;
      }

      const peer = String(msg.to || msg.peer || '').trim();
      const relayTypes = new Set([
        'call-invite',
        'call-ringing',
        'call-accept',
        'call-reject',
        'call-busy',
        'call-end',
        'webrtc-offer',
        'webrtc-answer',
        'webrtc-ice',
        'call-renegotiate',
      ]);

      if (!relayTypes.has(type)) return;
      if (!peer || peer === user.username) {
        send(ws, { type: 'error', error: 'Đối phương không hợp lệ' });
        return;
      }

      const payload = Object.assign({}, msg, {
        type,
        from: user.username,
        to: peer,
        at: new Date().toISOString(),
      });

      const delivered = sendToUser(peer, payload);
      if (type === 'call-invite') {
        send(ws, {
          type: 'call-invite-sent',
          callId: payload.callId,
          to: peer,
          mode: payload.mode || 'audio',
          peerOnline: delivered > 0,
        });
        if (typeof onCallInvite === 'function') {
          try {
            onCallInvite({
              from: user.username,
              to: peer,
              mode: payload.mode === 'video' ? 'video' : 'audio',
              callId: payload.callId,
              peerOnline: delivered > 0,
            });
          } catch (err) {
            console.warn('onCallInvite:', err && err.message ? err.message : err);
          }
        }
      } else if (!delivered && (type === 'call-invite' || type === 'webrtc-offer')) {
        send(ws, {
          type: 'peer-offline',
          to: peer,
          callId: payload.callId || null,
        });
      }
    });

    ws.on('close', () => {
      removeClient(user.username, ws);
      clients.forEach((_set, other) => {
        if (other === user.username) return;
        sendToUser(other, {
          type: 'presence',
          username: user.username,
          online: isOnline(user.username),
        });
      });
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
  }, 25000);

  wss.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    isOnline,
    listOnline,
    sendToUser,
  };
}

module.exports = { attachCallSignaling };
