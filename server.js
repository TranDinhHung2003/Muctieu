require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const VIEWER_USERNAME = process.env.VIEWER_USERNAME || 'theodoi';
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || 'xem123';
const COOKIE_NAME = 'muctieu_token';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'muctieu.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_data (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data_json TEXT NOT NULL DEFAULT '{"days":{}}',
    updated_at TEXT NOT NULL
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function ensureUser(username, password, role) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return false;
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (username, password_hash, role, updated_at) VALUES (?, ?, ?, ?)'
  ).run(username, hash, role, nowIso());
  return true;
}

function migrateLegacyAdmin() {
  const hasAdminTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='admin'"
  ).get();
  if (!hasAdminTable) return;

  const legacy = db.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get();
  if (legacy) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(legacy.username);
    if (!exists) {
      db.prepare(
        'INSERT INTO users (username, password_hash, role, updated_at) VALUES (?, ?, ?, ?)'
      ).run(legacy.username, legacy.password_hash, 'admin', nowIso());
      console.log('Đã chuyển tài khoản admin cũ sang bảng users:', legacy.username);
    }
  }
}

function initUsers() {
  migrateLegacyAdmin();

  if (ensureUser(ADMIN_USERNAME, ADMIN_PASSWORD, 'admin')) {
    console.log('Đã tạo tài khoản admin:', ADMIN_USERNAME);
  }
  if (ensureUser(VIEWER_USERNAME, VIEWER_PASSWORD, 'viewer')) {
    console.log('Đã tạo tài khoản theo dõi:', VIEWER_USERNAME);
  }

  // Avoid username collision if someone set same names
  if (ADMIN_USERNAME === VIEWER_USERNAME) {
    console.warn('Cảnh báo: ADMIN_USERNAME và VIEWER_USERNAME trùng nhau.');
  }
}

function initData() {
  const existing = db.prepare('SELECT id FROM app_data WHERE id = 1').get();
  if (!existing) {
    db.prepare(
      'INSERT INTO app_data (id, data_json, updated_at) VALUES (1, ?, ?)'
    ).run('{"days":{}}', nowIso());
  }
}

initUsers();
initData();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

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

function getStoredData() {
  const row = db.prepare('SELECT data_json FROM app_data WHERE id = 1').get();
  try {
    return JSON.parse(row.data_json);
  } catch {
    return { days: {} };
  }
}

function saveStoredData(data) {
  const json = JSON.stringify(data);
  db.prepare('UPDATE app_data SET data_json = ?, updated_at = ? WHERE id = 1').run(json, nowIso());

  const backupPath = path.join(DATA_DIR, 'backup-latest.json');
  fs.writeFileSync(backupPath, json, 'utf8');
}

function cookieOptions(extra = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
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

  const user = db.prepare(
    'SELECT id, username, password_hash, role FROM users WHERE lower(username) = lower(?)'
  ).get(username);

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
    // Always refresh role from DB in case JWT is old
    const user = db.prepare('SELECT username, role FROM users WHERE username = ?').get(payload.username);
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
  const data = getStoredData();
  const row = db.prepare('SELECT updated_at FROM app_data WHERE id = 1').get();
  res.json({ data, updatedAt: row.updated_at });
});

app.get('/api/data/sync', authMiddleware, (_req, res) => {
  const row = db.prepare('SELECT updated_at FROM app_data WHERE id = 1').get();
  res.json({ updatedAt: row.updated_at });
});

app.put('/api/data', authMiddleware, adminOnly, (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || !data.days || typeof data.days !== 'object') {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  saveStoredData(data);
  res.json({ ok: true, updatedAt: nowIso() });
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Vui lòng nhập đủ mật khẩu' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
  }

  const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(req.user.username);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowIso(), user.id);
  res.json({ ok: true });
});

app.get('/api/backup', authMiddleware, adminOnly, (_req, res) => {
  const data = getStoredData();
  const row = db.prepare('SELECT updated_at FROM app_data WHERE id = 1').get();
  const filename = 'muctieu-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.json({
    exportedAt: nowIso(),
    updatedAt: row.updated_at,
    data,
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

app.listen(PORT, () => {
  console.log('Server chạy tại http://localhost:' + PORT);
  console.log('Admin:', ADMIN_USERNAME, '| Theo dõi:', VIEWER_USERNAME);
});
