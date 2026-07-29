require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const storage = require('./storage');
const pushNotify = require('./push-notify');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const VIEWER_USERNAME = process.env.VIEWER_USERNAME || 'theodoi';
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || 'xem123';
const COOKIE_NAME = 'muctieu_token';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const DATA_DIR = storage.DATA_DIR;
const USERS_PATH = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadUsersStore() {
  return readJson(USERS_PATH, { users: [] });
}

function saveUsersStore(store) {
  writeJson(USERS_PATH, store);
}

function defaultNickname(username, role) {
  if (role === 'viewer') return 'Theo dõi';
  if (role === 'admin') return 'Admin';
  return String(username || 'Bạn').slice(0, 24);
}

function normalizeNickname(value, fallback) {
  const clean = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return clean || fallback;
}

function ensureUser(store, username, password, role) {
  const exists = store.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return false;
  store.users.push({
    id: store.users.length ? Math.max(...store.users.map((u) => u.id)) + 1 : 1,
    username,
    password_hash: bcrypt.hashSync(password, 10),
    role,
    nickname: defaultNickname(username, role),
    updated_at: nowIso(),
  });
  return true;
}

function initUsers() {
  const usersStore = loadUsersStore();
  let changed = false;
  if (ensureUser(usersStore, ADMIN_USERNAME, ADMIN_PASSWORD, 'admin')) {
    console.log('Đã tạo tài khoản admin:', ADMIN_USERNAME);
    changed = true;
  }
  if (ensureUser(usersStore, VIEWER_USERNAME, VIEWER_PASSWORD, 'viewer')) {
    console.log('Đã tạo tài khoản theo dõi:', VIEWER_USERNAME);
    changed = true;
  }
  // Bổ sung biệt danh cho user cũ
  usersStore.users.forEach((u) => {
    if (!u.nickname || !String(u.nickname).trim()) {
      u.nickname = defaultNickname(u.username, u.role);
      changed = true;
    }
  });
  if (changed) saveUsersStore(usersStore);
}

/** Biệt danh dùng chung — lưu bền trong messages store (GitHub), cả hai cùng thấy */
function getNicknamesMap() {
  const stored = storage.getStoredNicknames ? storage.getStoredNicknames() : {};
  const store = loadUsersStore();
  const map = {};
  (store.users || []).forEach((u) => {
    if (!u || !u.username) return;
    map[u.username] = normalizeNickname(
      stored[u.username] || u.nickname,
      defaultNickname(u.username, u.role)
    );
  });
  Object.keys(stored).forEach((username) => {
    if (!map[username]) {
      map[username] = normalizeNickname(stored[username], username);
    }
  });
  return map;
}

/** Tên hiển thị trong chat: bản thân = "Bạn", người khác = biệt danh chung */
function getDisplayNamesForViewer(viewerUsername) {
  const map = getNicknamesMap();
  if (viewerUsername && Object.prototype.hasOwnProperty.call(map, viewerUsername)) {
    map[viewerUsername] = 'Bạn';
  } else if (viewerUsername) {
    map[viewerUsername] = 'Bạn';
  }
  return map;
}

function publicUserPayload(user) {
  const stored = storage.getStoredNicknames ? storage.getStoredNicknames() : {};
  return {
    username: user.username,
    role: user.role,
    nickname: normalizeNickname(
      stored[user.username] || user.nickname,
      defaultNickname(user.username, user.role)
    ),
  };
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '3mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  const pushStats = pushNotify.getStats ? pushNotify.getStats() : null;
  res.json({
    ok: true,
    time: nowIso(),
    durable: !!storage.GITHUB_TOKEN,
    push: pushStats,
  });
});

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function authMiddleware(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Tài khoản theo dõi chỉ được xem, không được chỉnh sửa' });
  }
  next();
}

function findUserByUsername(username) {
  const store = loadUsersStore();
  return store.users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase()) || null;
}

function cookieOptions(extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: IS_PROD,
    ...extra,
  };
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions({
    maxAge: 30 * 24 * 60 * 60 * 1000,
  }));
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

app.post('/api/login', (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
  }

  const user = findUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({
      error: '( sai tên đăng nhập và mật khẩu )',
    });
  }

  const token = createToken(user);
  setAuthCookie(res, token);
  res.json({ ok: true, ...publicUserPayload(user) });
});

app.post('/api/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.json({ loggedIn: false });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserByUsername(payload.username);
    if (!user) {
      clearAuthCookie(res);
      return res.json({ loggedIn: false });
    }
    res.json({ loggedIn: true, ...publicUserPayload(user) });
  } catch {
    clearAuthCookie(res);
    res.json({ loggedIn: false });
  }
});

app.post('/api/nickname', authMiddleware, async (req, res) => {
  // Đặt biệt danh CHO ĐỐI PHƯƠNG — lưu bền (GitHub), cả hai cùng thấy
  const body = req.body || {};
  const rawNick = String(body.nickname || '');
  const nickname = normalizeNickname(rawNick, '');
  if (!nickname) {
    return res.status(400).json({ error: 'Biệt danh không được để trống' });
  }
  if (nickname.length > 24) {
    return res.status(400).json({ error: 'Biệt danh tối đa 24 ký tự' });
  }

  const store = loadUsersStore();
  let targetUsername = String(body.username || body.forUsername || '').trim();
  if (!targetUsername) {
    const other = (store.users || []).find((u) => u && u.username && u.username !== req.user.username);
    targetUsername = other ? other.username : '';
  }
  if (!targetUsername) {
    return res.status(400).json({ error: 'Không tìm thấy đối phương' });
  }
  if (targetUsername === req.user.username) {
    return res.status(400).json({ error: 'Hãy đặt biệt danh cho người khác' });
  }
  const target = store.users.find((u) => u && u.username === targetUsername);
  if (!target) {
    return res.status(404).json({ error: 'Không tìm thấy đối phương' });
  }

  // Đồng bộ local users.json (best-effort) + lưu bền qua messages store / GitHub
  target.nickname = nickname;
  target.updated_at = nowIso();
  saveUsersStore(store);

  try {
    const saved = await storage.setPeerNickname(targetUsername, nickname);
    res.json({
      ok: true,
      peerUsername: targetUsername,
      peerNickname: nickname,
      nicknames: getDisplayNamesForViewer(req.user.username),
      updatedAt: saved && saved.updatedAt,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Không lưu được biệt danh' });
  }
});

function getAllUsernames() {
  const store = loadUsersStore();
  return (store.users || []).map((u) => u && u.username).filter(Boolean);
}

function pushToOthers(exceptUsername, payload) {
  const others = pushNotify.listOtherUsernames(getAllUsernames(), exceptUsername);
  return pushNotify.sendPushToUsernames(others, payload).catch((err) => {
    console.warn('Push thất bại:', err && err.message ? err.message : err);
  });
}

function startKeepAlive() {
  const ms = Math.max(60 * 1000, Number(process.env.KEEP_ALIVE_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
  const base = String(
    process.env.KEEP_ALIVE_URL
    || process.env.RENDER_EXTERNAL_URL
    || ''
  ).replace(/\/$/, '');
  if (!base) {
    console.log('Keep-alive: chưa có RENDER_EXTERNAL_URL / KEEP_ALIVE_URL (GitHub Action vẫn ping được).');
    return;
  }
  const ping = () => {
    fetch(base + '/api/health')
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
      })
      .catch((err) => {
        console.warn('Keep-alive lỗi:', err && err.message ? err.message : err);
      });
  };
  setTimeout(ping, 20 * 1000);
  setInterval(ping, ms);
  console.log('Keep-alive bật mỗi', Math.round(ms / 1000), 's →', base + '/api/health');
}

app.get('/api/push/vapid-public-key', authMiddleware, (_req, res) => {
  res.json({ publicKey: pushNotify.getPublicKey() });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const ok = pushNotify.saveSubscription(req.user.username, (req.body || {}).subscription);
  if (!ok) {
    return res.status(400).json({ error: 'Subscription không hợp lệ' });
  }
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  pushNotify.removeSubscription(req.user.username, (req.body || {}).endpoint);
  res.json({ ok: true });
});

app.post('/api/push/test', authMiddleware, async (req, res) => {
  const username = String(req.user.username || '');
  const title = String((req.body || {}).title || 'Mục tiêu chạy xe').trim() || 'Mục tiêu chạy xe';
  const body = String((req.body || {}).body || 'Thông báo thử').trim();
  const delaySec = Math.max(0, Math.min(60, Number((req.body || {}).delaySec) || 0));

  const sendOne = async (payload) => {
    pushNotify.reloadSubsFromDisk();
    return pushNotify.sendPushToUsernames([username], payload);
  };

  // Tin 1: gửi ngay (xác nhận đăng ký còn sống)
  const immediate = await sendOne({
    title,
    body: 'Tin 1/2: Đăng ký OK. Hãy VUỐT TẮT app ngay — tin 2 sẽ tới sau ' + (delaySec || 12) + 's',
    tag: 'muctieu-test-1',
    page: 'home',
    type: 'test',
  });

  pushNotify.setLastPushTest({
    username,
    phase: 'immediate',
    attempted: immediate.attempted || 0,
    sent: immediate.sent || 0,
    errors: immediate.errors || [],
  });

  const wait = delaySec > 0 ? delaySec : 0;
  if (wait > 0) {
    res.json({
      ok: true,
      delayed: true,
      delaySec: wait,
      immediate,
      message: 'Đã gửi tin 1. Vuốt tắt app — tin 2 sau ' + wait + 's',
      stats: pushNotify.getStats(),
    });

    const payload2 = {
      title,
      body: body || ('Tin 2/2: Máy nhận được khi app đã vuốt tắt (' + username + ')'),
      tag: 'muctieu-test-2',
      page: 'home',
      type: 'test',
    };

    // Gửi 2 lần (wait và wait+5s) để tăng tỉ lệ khi iOS vừa kill app
    const delays = [wait, wait + 5];
    delays.forEach((sec, idx) => {
      setTimeout(() => {
        sendOne(Object.assign({}, payload2, {
          body: payload2.body + (idx ? ' · nhắc lại' : ''),
          tag: 'muctieu-test-2' + (idx ? '-b' : ''),
        })).then((result) => {
          pushNotify.setLastPushTest({
            username,
            phase: 'delayed-' + (idx + 1),
            delaySec: sec,
            attempted: result.attempted || 0,
            sent: result.sent || 0,
            errors: result.errors || [],
          });
          console.log('Push test delayed', sec + 's', username, result.sent + '/' + result.attempted);
        }).catch((err) => {
          pushNotify.setLastPushTest({
            username,
            phase: 'delayed-error',
            error: err && err.message ? err.message : String(err),
          });
          console.warn('Push test delay lỗi:', err && err.message ? err.message : err);
        });
      }, sec * 1000);
    });
    return;
  }

  res.json({
    ok: true,
    attempted: immediate.attempted || 0,
    sent: immediate.sent || 0,
    errors: immediate.errors || [],
    stats: pushNotify.getStats(),
  });
});

app.get('/api/push/status', authMiddleware, (req, res) => {
  const storeUsers = pushNotify.getStats();
  res.json({
    ok: true,
    publicKey: pushNotify.getPublicKey(),
    stats: storeUsers,
    username: req.user.username,
    lastTest: pushNotify.getLastPushTest(),
  });
});

app.get('/api/data', authMiddleware, (_req, res) => {
  const store = storage.getAppStore();
  res.json({ data: store.data || { days: {} }, updatedAt: store.updatedAt });
});

app.get('/api/data/sync', authMiddleware, (_req, res) => {
  const store = storage.getAppStore();
  res.json({ updatedAt: store.updatedAt });
});

app.put('/api/data', authMiddleware, adminOnly, async (req, res) => {
  const { data, pushNotify: pushPayload } = req.body || {};
  if (!data || typeof data !== 'object' || !data.days || typeof data.days !== 'object') {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  try {
    const updatedAt = await storage.setAppStore(data);
    if (pushPayload && typeof pushPayload === 'object') {
      const title = String(pushPayload.title || 'Cập nhật doanh thu').trim() || 'Cập nhật doanh thu';
      const body = String(pushPayload.body || 'Có cập nhật số tiền mới').trim() || 'Có cập nhật số tiền mới';
      await pushToOthers(req.user.username, {
        title,
        body,
        tag: 'muctieu-money',
        page: 'home',
        type: 'money',
      });
    }
    res.json({ ok: true, updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi lưu dữ liệu: ' + err.message });
  }
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Vui lòng nhập đủ mật khẩu' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
  }

  const store = loadUsersStore();
  const user = store.users.find((u) => u.username === req.user.username);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
  }

  user.password_hash = bcrypt.hashSync(newPassword, 10);
  user.updated_at = nowIso();
  saveUsersStore(store);
  res.json({ ok: true });
});

app.get('/api/backup', authMiddleware, adminOnly, (_req, res) => {
  const store = storage.getAppStore();
  const filename = 'muctieu-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.json({
    exportedAt: nowIso(),
    updatedAt: store.updatedAt,
    data: store.data || { days: {} },
  });
});

app.post('/api/restore', authMiddleware, adminOnly, async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || !data.days) {
    return res.status(400).json({ error: 'File sao lưu không hợp lệ' });
  }
  const updatedAt = await storage.setAppStore(data);
  res.json({ ok: true, updatedAt });
});

app.get('/api/messages', authMiddleware, (req, res) => {
  // Không đánh dấu đã nhận/đã đọc ở đây — chỉ trả danh sách + trạng thái theo receipts chung.
  const pub = storage.publicMessagesStore(null, req.user.username);
  res.json({
    messages: pub.messages || [],
    nicknames: getDisplayNamesForViewer(req.user.username),
    updatedAt: pub.updatedAt,
    ttlMinutes: 30,
  });
});

app.get('/api/messages/sync', authMiddleware, (_req, res) => {
  const store = storage.getMessagesStore();
  res.json({ updatedAt: store.updatedAt });
});

/** Máy đã nhận thông báo / đồng bộ tin → đối phương thấy "Đã nhận" */
app.post('/api/messages/delivered', authMiddleware, (req, res) => {
  const messageId = String((req.body || {}).messageId || '').trim();
  if (messageId) {
    storage.markMessageDeliveredById(messageId, req.user.username);
  } else {
    storage.markMessagesDelivered(req.user.username);
  }
  const pub = storage.publicMessagesStore(null, req.user.username);
  res.json({
    ok: true,
    messages: pub.messages || [],
    nicknames: getDisplayNamesForViewer(req.user.username),
    updatedAt: pub.updatedAt,
  });
});

app.post('/api/messages/read', authMiddleware, (req, res) => {
  storage.markMessagesRead(req.user.username);
  const pub = storage.publicMessagesStore(null, req.user.username);
  res.json({
    ok: true,
    messages: pub.messages || [],
    nicknames: getDisplayNamesForViewer(req.user.username),
    updatedAt: pub.updatedAt,
  });
});

app.get('/api/messages/media/:id', authMiddleware, async (req, res) => {
  try {
    const image = await storage.resolveChatImage(req.params.id);
    if (!image || !image.buffer || !image.buffer.length) {
      return res.status(404).json({ error: 'Không tìm thấy ảnh' });
    }
    res.setHeader('Content-Type', image.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(image.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Không đọc được ảnh' });
  }
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  const imageDataUrl = (req.body || {}).image || null;
  if (!text && !imageDataUrl) {
    return res.status(400).json({ error: 'Vui lòng nhập nội dung hoặc chọn ảnh' });
  }
  if (text.length > 1000) {
    return res.status(400).json({ error: 'Tin nhắn tối đa 1000 ký tự' });
  }
  try {
    const result = await storage.addMessage({
      from: req.user.username,
      role: req.user.role,
      text,
      imageDataUrl,
    });
    const preview = text
      ? String(text).slice(0, 120)
      : (imageDataUrl ? '[Ảnh]' : 'Tin nhắn mới');
    const others = pushNotify.listOtherUsernames(getAllUsernames(), req.user.username);
    const messageId = result.message && result.message.id;
    await Promise.all(others.map(async (recipient) => {
      const names = getDisplayNamesForViewer(recipient);
      const fromName = names[req.user.username]
        || defaultNickname(req.user.username, req.user.role);
      try {
        const pushResult = await pushNotify.sendPushToUsernames([recipient], {
          title: '💬 Tin nhắn mới',
          body: fromName + ': ' + preview,
          tag: 'muctieu-chat',
          page: 'chat',
          type: 'chat',
          messageId,
          from: req.user.username,
          fromName,
          text: text || (imageDataUrl ? '[Ảnh]' : ''),
          imageId: (result.message && result.message.imageId) || null,
          at: (result.message && result.message.at) || new Date().toISOString(),
        });
        // Thông báo đã gửi lên máy đối phương → "Đã nhận"
        if (pushResult && pushResult.sent > 0) {
          if (messageId) storage.markMessageDeliveredById(messageId, recipient);
          else storage.markMessagesDelivered(recipient);
        }
      } catch (err) {
        console.warn('Push chat lỗi', recipient, err && err.message);
      }
    }));
    const pub = storage.publicMessagesStore(null, req.user.username);
    const fresh = messageId
      ? (pub.messages || []).find((m) => m && m.id === messageId)
      : null;
    res.json({
      ok: true,
      message: fresh || storage.publicMessage(result.message),
      nicknames: getDisplayNamesForViewer(req.user.username),
      updatedAt: pub.updatedAt || result.updatedAt,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Không gửi được tin nhắn' });
  }
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/manifest.webmanifest', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'manifest.webmanifest'));
});

app.get('/apple-touch-icon.png', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'icons', 'icon-180.png'));
});

app.get('/apple-touch-icon-precomposed.png', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'icons', 'icon-180.png'));
});

app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  initUsers();
  await storage.initAppStore();
  await storage.initMessagesStore();
  // Migrate biệt danh từ users.json (local) → messages store bền nếu chưa có
  try {
    const stored = storage.getStoredNicknames() || {};
    const users = loadUsersStore().users || [];
    for (const u of users) {
      if (!u || !u.username || !u.nickname) continue;
      const def = defaultNickname(u.username, u.role);
      const nick = normalizeNickname(u.nickname, '');
      if (nick && nick !== def && !stored[u.username]) {
        await storage.setPeerNickname(u.username, nick);
      }
    }
  } catch (err) {
    console.warn('Migrate biệt danh:', err && err.message ? err.message : err);
  }
  await pushNotify.init();
  startKeepAlive();

  setInterval(() => {
    try { storage.pruneExpiredMessages(true); } catch { /* ignore */ }
  }, 60 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log('Server chạy tại http://0.0.0.0:' + PORT);
    console.log('Data dir:', DATA_DIR);
    console.log('Admin:', ADMIN_USERNAME, '| Theo dõi:', VIEWER_USERNAME);
    console.log('Tin nhắn tự xóa sau', Math.round(storage.MESSAGE_TTL_MS / 60000), 'phút');
    console.log('Web Push public key:', (pushNotify.getPublicKey() || '').slice(0, 16) + '...');
    if (storage.GITHUB_TOKEN) {
      console.log('Lưu bền GitHub: bật · repo', storage.GITHUB_REPO, '· branch', storage.GITHUB_BRANCH);
    } else {
      console.warn('Chưa có GITHUB_TOKEN — dữ liệu/push có thể mất khi Render restart. Thêm GITHUB_TOKEN trên Render.');
    }
  });
}

start().catch((err) => {
  console.error('Không khởi động được server:', err);
  process.exit(1);
});
