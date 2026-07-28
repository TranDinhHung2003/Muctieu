require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const VIEWER_USERNAME = process.env.VIEWER_USERNAME || 'theodoi';
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || 'xem123';
const COOKIE_NAME = 'muctieu_token';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const USERS_PATH = path.join(DATA_DIR, 'users.json');
const APP_DATA_PATH = path.join(DATA_DIR, 'app-data.json');
const BACKUP_PATH = path.join(DATA_DIR, 'backup-latest.json');

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

function loadAppStore() {
  const store = readJson(APP_DATA_PATH, null);
  if (store && store.data) return store;

  // Migrate from older backup file if present
  const backup = readJson(BACKUP_PATH, null);
  if (backup && backup.days) {
    return { data: backup, updatedAt: nowIso() };
  }
  if (backup && backup.data && backup.data.days) {
    return { data: backup.data, updatedAt: backup.updatedAt || nowIso() };
  }

  return { data: { days: {} }, updatedAt: nowIso() };
}

function saveAppStore(store) {
  writeJson(APP_DATA_PATH, store);
  writeJson(BACKUP_PATH, store.data);
}

function ensureUser(store, username, password, role) {
  const exists = store.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return false;
  store.users.push({
    id: store.users.length ? Math.max(...store.users.map((u) => u.id)) + 1 : 1,
    username,
    password_hash: bcrypt.hashSync(password, 10),
    role,
    updated_at: nowIso(),
  });
  return true;
}

function initStore() {
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
  if (changed) saveUsersStore(usersStore);

  if (!fs.existsSync(APP_DATA_PATH)) {
    saveAppStore(loadAppStore());
  }
}

initStore();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: nowIso() });
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

function getStoredData() {
  return loadAppStore().data || { days: {} };
}

function saveStoredData(data) {
  const updatedAt = nowIso();
  saveAppStore({ data, updatedAt });
  return updatedAt;
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
  res.json({ ok: true, username: user.username, role: user.role });
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
    res.json({ loggedIn: true, username: user.username, role: user.role });
  } catch {
    clearAuthCookie(res);
    res.json({ loggedIn: false });
  }
});

app.get('/api/data', authMiddleware, (_req, res) => {
  const store = loadAppStore();
  res.json({ data: store.data || { days: {} }, updatedAt: store.updatedAt });
});

app.get('/api/data/sync', authMiddleware, (_req, res) => {
  const store = loadAppStore();
  res.json({ updatedAt: store.updatedAt });
});

app.put('/api/data', authMiddleware, adminOnly, (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || !data.days || typeof data.days !== 'object') {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  const updatedAt = saveStoredData(data);
  res.json({ ok: true, updatedAt });
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
  const store = loadAppStore();
  const filename = 'muctieu-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.json({
    exportedAt: nowIso(),
    updatedAt: store.updatedAt,
    data: store.data || { days: {} },
  });
});

app.post('/api/restore', authMiddleware, adminOnly, (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || !data.days) {
    return res.status(400).json({ error: 'File sao lưu không hợp lệ' });
  }
  saveStoredData(data);
  res.json({ ok: true });
});

app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server chạy tại http://0.0.0.0:' + PORT);
  console.log('Data dir:', DATA_DIR);
  console.log('Admin:', ADMIN_USERNAME, '| Theo dõi:', VIEWER_USERNAME);
});
