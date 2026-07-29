/**
 * WebSocket + bộ nhớ invite HTTP fallback cho cuộc gọi WebRTC
 * Path WS: /ws/call — auth cookie hoặc ?ticket=
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
  /** username(to) → invite object */
  const pendingInvites = new Map();
  const INVITE_TTL_MS = 55 * 1000;

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

  function pruneInvites() {
    const now = Date.now();
    pendingInvites.forEach((inv, key) => {
      if (!inv || !inv.at || now - new Date(inv.at).getTime() > INVITE_TTL_MS) {
        pendingInvites.delete(key);
      }
    });
  }

  function storeInvite({ from, to, callId, mode }) {
    pruneInvites();
    if (!to || !callId) return null;
    const invite = {
      type: 'call-invite',
      from: String(from),
      to: String(to),
      callId: String(callId),
      mode: mode === 'video' ? 'video' : 'audio',
      at: new Date().toISOString(),
    };
    pendingInvites.set(String(to), invite);
    return invite;
  }

  function clearInvite(to, callId) {
    const key = String(to || '');
    const inv = pendingInvites.get(key);
    if (!inv) return;
    if (callId && inv.callId !== callId) return;
    pendingInvites.delete(key);
  }

  function getPendingInvite(username) {
    pruneInvites();
    return pendingInvites.get(String(username || '')) || null;
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

  function handleRelay(user, msg) {
    const type = String(msg.type || '');
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
    if (!relayTypes.has(type)) return { ok: false, error: 'Loại tín hiệu không hỗ trợ' };
    if (!peer || peer === user.username) return { ok: false, error: 'Đối phương không hợp lệ' };

    const payload = Object.assign({}, msg, {
      type,
      from: user.username,
      to: peer,
      at: new Date().toISOString(),
    });

    if (type === 'call-invite') {
      storeInvite({
        from: user.username,
        to: peer,
        callId: payload.callId,
        mode: payload.mode,
      });
    }
    if (type === 'call-accept' || type === 'call-reject' || type === 'call-busy' || type === 'call-end') {
      clearInvite(user.username, payload.callId);
      clearInvite(peer, payload.callId);
    }

    const delivered = sendToUser(peer, payload);
    let inviteMeta = null;
    if (type === 'call-invite') {
      inviteMeta = {
        callId: payload.callId,
        to: peer,
        mode: payload.mode || 'audio',
        peerOnline: delivered > 0,
      };
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
    }
    return {
      ok: true,
      delivered,
      peerOffline: delivered === 0 && (type === 'call-invite' || type === 'webrtc-offer'),
      inviteMeta,
      payload,
    };
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

    // Đẩy invite đang chờ (nếu có) ngay khi online lại
    const pending = getPendingInvite(user.username);
    if (pending) send(ws, pending);

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
      if (String(msg.type || '') === 'ping') {
        send(ws, { type: 'pong', t: Date.now() });
        return;
      }

      const result = handleRelay(user, msg);
      if (!result.ok) {
        send(ws, { type: 'error', error: result.error || 'Lỗi tín hiệu' });
        return;
      }
      if (result.inviteMeta) {
        send(ws, Object.assign({ type: 'call-invite-sent' }, result.inviteMeta));
      }
      if (result.peerOffline) {
        send(ws, {
          type: 'peer-offline',
          to: result.payload.to,
          callId: result.payload.callId || null,
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
    pruneInvites();
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
    storeInvite,
    clearInvite,
    getPendingInvite,
    handleRelay,
  };
}

module.exports = { attachCallSignaling };
