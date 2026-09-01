require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const accounts = require('./accounts');
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
const FOLLOW_PATH_PREFIX = '/t/';

function nowIso() {
  return new Date().toISOString();
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '3mb' }));
app.use(cookieParser());

/* ------------------------------------------------------------------ */
/* Xác thực                                                            */
/* ------------------------------------------------------------------ */

function createToken(user) {
  return jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
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
  res.cookie(COOKIE_NAME, token, cookieOptions({ maxAge: 30 * 24 * 60 * 60 * 1000 }));
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

function readTokenUser(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return accounts.findByUsername(payload.username);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const user = readTokenUser(req);
  if (!user) {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }
  req.user = user;
  next();
}

/** Xác định workspace đang xem: header X-Workspace hoặc ?ws=, mặc định là của chính mình. */
function workspaceMiddleware(req, res, next) {
  const requested = accounts.normalizeUsername(req.get('X-Workspace') || req.query.ws || '');
  const owner = requested || req.user.username;
  const role = accounts.accessRole(owner, req.user.username);
  if (!role) {
    return res.status(403).json({
      error: 'Bạn chưa được theo dõi tài khoản này. Hãy mở đường link theo dõi mà chủ tài khoản gửi cho bạn.',
    });
  }
  req.workspace = { owner, role };
  next();
}

function ownerOnly(req, res, next) {
  if (!req.workspace || req.workspace.role !== 'owner') {
    return res.status(403).json({ error: 'Bạn đang xem dữ liệu của người khác — chỉ được xem, không được chỉnh sửa' });
  }
  next();
}

function sendAccountError(res, err, fallback = 'Có lỗi xảy ra') {
  const status = err instanceof accounts.AccountError ? err.status : 500;
  res.status(status).json({ error: (err && err.message) || fallback });
}

/* ------------------------------------------------------------------ */
/* Ngữ cảnh tài khoản trả về cho client                                 */
/* ------------------------------------------------------------------ */

function shareUrlFor(req, token) {
  const host = req.get('host');
  if (!host) return FOLLOW_PATH_PREFIX + token;
  return req.protocol + '://' + host + FOLLOW_PATH_PREFIX + token;
}

/** Biệt danh hiển thị trong 1 workspace: ưu tiên biệt danh đã đặt, sau đó tên hiển thị. */
function displayNamesFor(owner, viewerUsername) {
  const stored = storage.getStoredNicknames(owner);
  const map = {};
  accounts.listWorkspaceMembers(owner).forEach((username) => {
    const user = accounts.findByUsername(username);
    map[username] = stored[username]
      || (user ? user.displayName : accounts.defaultDisplayName(username));
  });
  Object.keys(stored).forEach((username) => {
    if (!map[username]) map[username] = stored[username];
  });
  if (viewerUsername) map[viewerUsername] = 'Bạn';
  return map;
}

function workspaceSummary(owner, viewerUsername) {
  const user = accounts.findByUsername(owner);
  const role = accounts.accessRole(owner, viewerUsername);
  const stored = storage.getStoredNicknames(owner);
  return {
    owner,
    ownerName: user ? user.displayName : accounts.defaultDisplayName(owner),
    nickname: stored[owner] || null,
    role: role === 'owner' ? 'owner' : 'follower',
  };
}

function accountContext(req, user) {
  const followers = accounts.listFollowers(user.username).map((item) => {
    const stored = storage.getStoredNicknames(user.username);
    return Object.assign({}, item, { nickname: stored[item.username] || null });
  });
  const workspaces = [
    workspaceSummary(user.username, user.username),
    ...accounts.listFollowing(user.username).map((item) => workspaceSummary(item.username, user.username)),
  ];
  return {
    username: user.username,
    displayName: user.displayName,
    shareToken: user.shareToken,
    shareUrl: shareUrlFor(req, user.shareToken),
    followers,
    following: accounts.listFollowing(user.username),
    workspaces,
  };
}

/* ------------------------------------------------------------------ */
/* Route công khai                                                      */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    durable: !!storage.GITHUB_TOKEN,
    accounts: accounts.listUsernames().length,
    push: pushNotify.getStats ? pushNotify.getStats() : null,
  });
});

/** Xem trước chủ tài khoản đứng sau 1 đường link theo dõi (không cần đăng nhập). */
app.get('/api/follow/info', (req, res) => {
  const owner = accounts.findByShareToken(req.query.token);
  if (!owner) {
    return res.status(404).json({ error: 'Đường link theo dõi không đúng hoặc đã bị huỷ' });
  }
  const viewer = readTokenUser(req);
  res.json({
    ok: true,
    owner: accounts.publicUser(owner),
    loggedIn: !!viewer,
    alreadyFollowing: !!viewer && (
      viewer.username === owner.username || accounts.isFollowing(owner.username, viewer.username)
    ),
    isSelf: !!viewer && viewer.username === owner.username,
  });
});

/** Gắn quan hệ theo dõi ngay sau khi đăng ký/đăng nhập bằng link. */
async function applyFollowToken(token, follower) {
  if (!token) return null;
  const owner = accounts.findByShareToken(token);
  if (!owner) return { error: 'Đường link theo dõi không đúng hoặc đã bị huỷ' };
  if (owner.username === follower.username) return { self: true, owner: accounts.publicUser(owner) };
  await accounts.addFollow(owner.username, follower.username);
  await storage.initWorkspaceData(owner.username);
  await storage.initWorkspaceMessages(owner.username);
  return { owner: accounts.publicUser(owner) };
}

app.post('/api/register', async (req, res) => {
  const body = req.body || {};
  try {
    if (body.confirmPassword != null && String(body.confirmPassword) !== String(body.password || '')) {
      throw new accounts.AccountError('Mật khẩu nhập lại không khớp');
    }
    const user = await accounts.register({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
    });
    await storage.initWorkspaceData(user.username);
    await storage.initWorkspaceMessages(user.username);

    const followed = await applyFollowToken(body.followToken, user);
    setAuthCookie(res, createToken(user));
    res.json({
      ok: true,
      ...accountContext(req, user),
      followed: followed && followed.owner ? followed.owner : null,
      followError: followed && followed.error ? followed.error : null,
    });
  } catch (err) {
    sendAccountError(res, err, 'Không tạo được tài khoản');
  }
});

app.post('/api/login', async (req, res) => {
  const body = req.body || {};
  const username = accounts.normalizeUsername(body.username);
  const password = String(body.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
  }

  const user = accounts.findByUsername(username);
  if (!user || !accounts.verifyPassword(user, password)) {
    return res.status(401).json({ error: '( sai tên đăng nhập và mật khẩu )' });
  }

  let followed = null;
  try {
    followed = await applyFollowToken(body.followToken, user);
  } catch (err) {
    followed = { error: (err && err.message) || 'Không theo dõi được tài khoản này' };
  }

  await storage.initWorkspaceData(user.username);
  await storage.initWorkspaceMessages(user.username);
  setAuthCookie(res, createToken(user));
  res.json({
    ok: true,
    ...accountContext(req, user),
    followed: followed && followed.owner ? followed.owner : null,
    followError: followed && followed.error ? followed.error : null,
  });
});

app.post('/api/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = readTokenUser(req);
  if (!user) {
    clearAuthCookie(res);
    return res.json({ loggedIn: false });
  }
  res.json({ loggedIn: true, ...accountContext(req, user) });
});

/* ------------------------------------------------------------------ */
/* Theo dõi & chia sẻ                                                   */
/* ------------------------------------------------------------------ */

app.post('/api/follow', authMiddleware, async (req, res) => {
  try {
    const result = await applyFollowToken(String((req.body || {}).token || ''), req.user);
    if (!result) return res.status(400).json({ error: 'Thiếu mã theo dõi' });
    if (result.error) return res.status(404).json({ error: result.error });
    if (result.self) return res.status(400).json({ error: 'Đây là link của chính bạn' });
    res.json({ ok: true, owner: result.owner, ...accountContext(req, req.user) });
  } catch (err) {
    sendAccountError(res, err, 'Không theo dõi được tài khoản này');
  }
});

/** Người theo dõi tự bỏ theo dõi 1 workspace. */
app.delete('/api/follow/:owner', authMiddleware, async (req, res) => {
  try {
    await accounts.removeFollow(req.params.owner, req.user.username);
    res.json({ ok: true, ...accountContext(req, req.user) });
  } catch (err) {
    sendAccountError(res, err, 'Không bỏ theo dõi được');
  }
});

/** Chủ tài khoản gỡ 1 người khỏi danh sách theo dõi mình. */
app.delete('/api/followers/:username', authMiddleware, async (req, res) => {
  try {
    await accounts.removeFollow(req.user.username, req.params.username);
    res.json({ ok: true, ...accountContext(req, req.user) });
  } catch (err) {
    sendAccountError(res, err, 'Không gỡ được người theo dõi');
  }
});

app.post('/api/share/rotate', authMiddleware, async (req, res) => {
  try {
    const user = await accounts.rotateShareToken(req.user.username);
    res.json({ ok: true, ...accountContext(req, user) });
  } catch (err) {
    sendAccountError(res, err, 'Không đổi được link theo dõi');
  }
});

app.post('/api/display-name', authMiddleware, async (req, res) => {
  try {
    const user = await accounts.setDisplayName(req.user.username, (req.body || {}).displayName);
    res.json({ ok: true, ...accountContext(req, user) });
  } catch (err) {
    sendAccountError(res, err, 'Không đổi được tên hiển thị');
  }
});

app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    await accounts.changePassword(req.user.username, currentPassword, newPassword);
    res.json({ ok: true });
  } catch (err) {
    sendAccountError(res, err, 'Không đổi được mật khẩu');
  }
});

/** Đặt biệt danh cho 1 thành viên trong workspace đang xem. */
app.post('/api/nickname', authMiddleware, workspaceMiddleware, async (req, res) => {
  const body = req.body || {};
  const nickname = accounts.cleanText(body.nickname, 24);
  if (!nickname) return res.status(400).json({ error: 'Biệt danh không được để trống' });

  const { owner } = req.workspace;
  const members = accounts.listWorkspaceMembers(owner);
  let target = accounts.normalizeUsername(body.username || body.forUsername);
  if (!target) target = members.find((u) => u !== req.user.username) || '';
  if (!target) return res.status(400).json({ error: 'Không tìm thấy đối phương' });
  if (target === req.user.username) return res.status(400).json({ error: 'Hãy đặt biệt danh cho người khác' });
  if (!members.includes(target)) return res.status(404).json({ error: 'Người này không ở trong nhóm theo dõi' });

  try {
    const saved = await storage.setNickname(owner, target, nickname);
    res.json({
      ok: true,
      peerUsername: target,
      peerNickname: nickname,
      nicknames: displayNamesFor(owner, req.user.username),
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Không lưu được biệt danh' });
  }
});

/* ------------------------------------------------------------------ */
/* Web Push                                                             */
/* ------------------------------------------------------------------ */

app.get('/api/push/vapid-public-key', authMiddleware, (_req, res) => {
  res.json({ publicKey: pushNotify.getPublicKey() });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const ok = pushNotify.saveSubscription(req.user.username, (req.body || {}).subscription);
  if (!ok) return res.status(400).json({ error: 'Subscription không hợp lệ' });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  pushNotify.removeSubscription(req.user.username, (req.body || {}).endpoint);
  res.json({ ok: true });
});

app.get('/api/push/status', authMiddleware, (req, res) => {
  res.json({
    ok: true,
    publicKey: pushNotify.getPublicKey(),
    stats: pushNotify.getStats(),
    username: req.user.username,
    lastTest: pushNotify.getLastPushTest(),
  });
});

app.post('/api/push/test', authMiddleware, async (req, res) => {
  const username = req.user.username;
  const title = String((req.body || {}).title || 'Mục tiêu chạy xe').trim() || 'Mục tiêu chạy xe';
  const body = String((req.body || {}).body || 'Thông báo thử').trim();
  const delaySec = Math.max(0, Math.min(60, Number((req.body || {}).delaySec) || 0));

  const sendOne = async (payload) => {
    pushNotify.reloadSubsFromDisk();
    return pushNotify.sendPushToUsernames([username], payload);
  };

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

  if (delaySec > 0) {
    res.json({
      ok: true,
      delayed: true,
      delaySec,
      immediate,
      message: 'Đã gửi tin 1. Vuốt tắt app — tin 2 sau ' + delaySec + 's',
      stats: pushNotify.getStats(),
    });

    const payload2 = {
      title,
      body: body || ('Tin 2/2: Máy nhận được khi app đã vuốt tắt (' + username + ')'),
      tag: 'muctieu-test-2',
      page: 'home',
      type: 'test',
    };
    [delaySec, delaySec + 5].forEach((sec, idx) => {
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
        }).catch((err) => {
          pushNotify.setLastPushTest({
            username,
            phase: 'delayed-error',
            error: err && err.message ? err.message : String(err),
          });
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

function pushToWorkspaceFollowers(owner, exceptUsername, payload) {
  const targets = accounts.listWorkspaceMembers(owner)
    .filter((username) => username !== exceptUsername);
  if (!targets.length) return Promise.resolve({ attempted: 0, sent: 0 });
  return pushNotify.sendPushToUsernames(targets, payload).catch((err) => {
    console.warn('Push thất bại:', err && err.message ? err.message : err);
    return { attempted: 0, sent: 0 };
  });
}

/* ------------------------------------------------------------------ */
/* Dữ liệu doanh thu (theo workspace)                                   */
/* ------------------------------------------------------------------ */

app.get('/api/data', authMiddleware, workspaceMiddleware, async (req, res) => {
  const { owner, role } = req.workspace;
  await storage.initWorkspaceData(owner);
  const store = storage.getAppStore(owner);
  res.json({
    data: store.data || { days: {} },
    updatedAt: store.updatedAt,
    workspace: workspaceSummary(owner, req.user.username),
    role,
  });
});

app.get('/api/data/sync', authMiddleware, workspaceMiddleware, (req, res) => {
  const store = storage.getAppStore(req.workspace.owner);
  res.json({ updatedAt: store.updatedAt });
});

app.put('/api/data', authMiddleware, workspaceMiddleware, ownerOnly, async (req, res) => {
  const { data, pushNotify: pushPayload } = req.body || {};
  if (!data || typeof data !== 'object' || !data.days || typeof data.days !== 'object') {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  try {
    const owner = req.workspace.owner;
    const updatedAt = await storage.setAppStore(owner, data);
    if (pushPayload && typeof pushPayload === 'object') {
      await pushToWorkspaceFollowers(owner, req.user.username, {
        title: String(pushPayload.title || 'Cập nhật doanh thu').trim() || 'Cập nhật doanh thu',
        body: String(pushPayload.body || 'Có cập nhật số tiền mới').trim() || 'Có cập nhật số tiền mới',
        tag: 'muctieu-money-' + owner,
        page: 'home',
        type: 'money',
        workspace: owner,
      });
    }
    res.json({ ok: true, updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi lưu dữ liệu: ' + err.message });
  }
});

app.get('/api/backup', authMiddleware, workspaceMiddleware, ownerOnly, (req, res) => {
  const store = storage.getAppStore(req.workspace.owner);
  const filename = 'muctieu-' + req.workspace.owner + '-' + new Date().toISOString().slice(0, 10) + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.json({
    exportedAt: nowIso(),
    owner: req.workspace.owner,
    updatedAt: store.updatedAt,
    data: store.data || { days: {} },
  });
});

app.post('/api/restore', authMiddleware, workspaceMiddleware, ownerOnly, async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || !data.days) {
    return res.status(400).json({ error: 'File sao lưu không hợp lệ' });
  }
  const updatedAt = await storage.setAppStore(req.workspace.owner, data);
  res.json({ ok: true, updatedAt });
});

/* ------------------------------------------------------------------ */
/* Tin nhắn (theo workspace + đối phương)                               */
/* ------------------------------------------------------------------ */

/**
 * Hội thoại luôn là "chủ workspace ↔ 1 người theo dõi", lấy tên người theo dõi làm khoá.
 * Người theo dõi chỉ có 1 hội thoại; chủ workspace chọn hội thoại qua ?peer=.
 */
function resolveConversation(req) {
  const { owner, role } = req.workspace;
  if (role === 'follower') {
    return { peerKey: req.user.username, other: owner };
  }
  const followers = accounts.listFollowers(owner).map((item) => item.username);
  const requested = accounts.normalizeUsername(
    req.query.peer || (req.body && req.body.peer) || ''
  );
  const peerKey = followers.includes(requested) ? requested : (followers[0] || '');
  return { peerKey, other: peerKey };
}

function conversationPayload(req, peerKey, other) {
  const { owner } = req.workspace;
  if (!peerKey) {
    return {
      messages: [],
      nicknames: displayNamesFor(owner, req.user.username),
      updatedAt: null,
      peer: null,
      peers: [],
    };
  }
  const pub = storage.publicConversation(owner, peerKey, req.user.username, other);
  return {
    messages: pub.messages,
    nicknames: displayNamesFor(owner, req.user.username),
    updatedAt: pub.updatedAt,
    peer: other,
    peers: req.workspace.role === 'owner'
      ? accounts.listFollowers(owner).map((item) => item.username)
      : [owner],
  };
}

app.get('/api/messages', authMiddleware, workspaceMiddleware, async (req, res) => {
  await storage.initWorkspaceMessages(req.workspace.owner);
  const { peerKey, other } = resolveConversation(req);
  res.json(Object.assign(conversationPayload(req, peerKey, other), { ttlMinutes: 30 }));
});

app.get('/api/messages/sync', authMiddleware, workspaceMiddleware, (req, res) => {
  const store = storage.getMessagesStore(req.workspace.owner);
  res.json({ updatedAt: store.updatedAt });
});

app.post('/api/messages/delivered', authMiddleware, workspaceMiddleware, (req, res) => {
  const { peerKey, other } = resolveConversation(req);
  if (peerKey) {
    const messageId = String((req.body || {}).messageId || '').trim();
    if (messageId) {
      storage.markMessageDeliveredById(req.workspace.owner, peerKey, messageId, req.user.username);
    } else {
      storage.markMessagesDelivered(req.workspace.owner, peerKey, req.user.username);
    }
  }
  res.json(Object.assign({ ok: true }, conversationPayload(req, peerKey, other)));
});

app.post('/api/messages/read', authMiddleware, workspaceMiddleware, (req, res) => {
  const { peerKey, other } = resolveConversation(req);
  if (peerKey) storage.markMessagesRead(req.workspace.owner, peerKey, req.user.username);
  res.json(Object.assign({ ok: true }, conversationPayload(req, peerKey, other)));
});

app.get('/api/messages/media/:id', authMiddleware, workspaceMiddleware, async (req, res) => {
  try {
    const image = await storage.resolveChatImage(req.workspace.owner, req.params.id);
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

app.post('/api/messages', authMiddleware, workspaceMiddleware, async (req, res) => {
  const body = req.body || {};
  const text = String(body.text || '').trim();
  const imageDataUrl = body.image || null;
  if (!text && !imageDataUrl) {
    return res.status(400).json({ error: 'Vui lòng nhập nội dung hoặc chọn ảnh' });
  }
  if (text.length > 1000) {
    return res.status(400).json({ error: 'Tin nhắn tối đa 1000 ký tự' });
  }

  const { owner, role } = req.workspace;
  const { peerKey, other } = resolveConversation(req);
  if (!peerKey || !other) {
    return res.status(400).json({
      error: 'Chưa có ai theo dõi bạn. Hãy gửi đường link theo dõi cho người muốn nhắn tin.',
    });
  }

  try {
    await storage.initWorkspaceMessages(owner);
    const result = await storage.addMessage(owner, peerKey, {
      from: req.user.username,
      role: role === 'owner' ? 'admin' : 'viewer',
      text,
      imageDataUrl,
    });

    const messageId = result.message && result.message.id;
    const names = displayNamesFor(owner, other);
    const fromName = names[req.user.username] || req.user.displayName;
    const preview = text ? text.slice(0, 120) : '[Ảnh]';
    try {
      const pushResult = await pushNotify.sendPushToUsernames([other], {
        title: '💬 Tin nhắn mới',
        body: fromName + ': ' + preview,
        tag: 'muctieu-chat-' + owner,
        page: 'chat',
        type: 'chat',
        workspace: owner,
        messageId,
        from: req.user.username,
        fromName,
        text: text || '[Ảnh]',
        imageId: (result.message && result.message.imageId) || null,
        at: (result.message && result.message.at) || nowIso(),
      });
      if (pushResult && pushResult.sent > 0 && messageId) {
        storage.markMessageDeliveredById(owner, peerKey, messageId, other);
      }
    } catch (err) {
      console.warn('Push chat lỗi', other, err && err.message);
    }

    const payload = conversationPayload(req, peerKey, other);
    const fresh = messageId ? payload.messages.find((m) => m && m.id === messageId) : null;
    res.json(Object.assign({ ok: true, message: fresh || result.message }, payload));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Không gửi được tin nhắn' });
  }
});

/* ------------------------------------------------------------------ */
/* Tệp tĩnh — chỉ mở đúng những gì client cần                           */
/* ------------------------------------------------------------------ */

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

app.get(['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'icons', 'icon-180.png'));
});

// Không phục vụ cả thư mục gốc: data/ chứa hash mật khẩu và khoá VAPID
app.use('/icons', express.static(path.join(__dirname, 'icons'), { maxAge: '1d' }));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Không tìm thấy API' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ------------------------------------------------------------------ */
/* Khởi động                                                            */
/* ------------------------------------------------------------------ */

function startKeepAlive() {
  const ms = Math.max(60 * 1000, Number(process.env.KEEP_ALIVE_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
  const base = String(process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '')
    .replace(/\/$/, '');
  if (!base) {
    console.log('Keep-alive: chưa có RENDER_EXTERNAL_URL / KEEP_ALIVE_URL (GitHub Action vẫn ping được).');
    return;
  }
  const ping = () => {
    fetch(base + '/api/health')
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); })
      .catch((err) => console.warn('Keep-alive lỗi:', err && err.message ? err.message : err));
  };
  setTimeout(ping, 20 * 1000);
  setInterval(ping, ms);
  console.log('Keep-alive bật mỗi', Math.round(ms / 1000), 's →', base + '/api/health');
}

/** Nạp tài khoản + dữ liệu; tách khỏi listen() để test gọi lại được. */
async function bootstrap() {
  await accounts.init({
    seedOwner: ADMIN_USERNAME && ADMIN_PASSWORD
      ? { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, displayName: 'Admin' }
      : null,
    seedFollower: VIEWER_USERNAME && VIEWER_PASSWORD
      ? { username: VIEWER_USERNAME, password: VIEWER_PASSWORD, displayName: 'Theo dõi' }
      : null,
  });

  // Dữ liệu 1 người dùng của bản cũ thuộc về workspace của tài khoản chủ cũ
  await storage.migrateLegacyWorkspace(
    accounts.normalizeUsername(ADMIN_USERNAME),
    accounts.normalizeUsername(VIEWER_USERNAME)
  );

  await Promise.all(accounts.listUsernames().map(async (username) => {
    await storage.initWorkspaceData(username);
    await storage.initWorkspaceMessages(username);
  }));

  await pushNotify.init();
}

async function start() {
  await bootstrap();
  startKeepAlive();

  setInterval(() => {
    accounts.listUsernames().forEach((username) => {
      try { storage.pruneExpiredMessages(username, true); } catch { /* ignore */ }
    });
  }, 60 * 1000);

  return app.listen(PORT, '0.0.0.0', () => {
    console.log('Server chạy tại http://0.0.0.0:' + PORT);
    console.log('Data dir:', storage.DATA_DIR);
    console.log('Số tài khoản:', accounts.listUsernames().length);
    console.log('Tin nhắn tự xóa sau', Math.round(storage.MESSAGE_TTL_MS / 60000), 'phút');
    console.log('Web Push public key:', (pushNotify.getPublicKey() || '').slice(0, 16) + '...');
    if (storage.GITHUB_TOKEN) {
      console.log('Lưu bền GitHub: bật · repo', storage.GITHUB_REPO, '· branch', storage.GITHUB_BRANCH);
    } else {
      console.warn('Chưa có GITHUB_TOKEN — tài khoản/dữ liệu có thể mất khi Render restart.');
    }
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Không khởi động được server:', err);
    process.exit(1);
  });
}

module.exports = { app, start, bootstrap };
