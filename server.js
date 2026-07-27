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
const COOKIE_NAME = 'muctieu_token';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'muctieu.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
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

function initAdmin() {
  const existing = db.prepare('SELECT id FROM admin WHERE id = 1').get();
  if (!existing) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare(
      'INSERT INTO admin (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)'
    ).run(ADMIN_USERNAME, hash, nowIso());
    console.log('Đã tạo tài khoản admin mặc định:', ADMIN_USERNAME);
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

initAdmin();
initData();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

function createToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
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

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
  }

  const admin = db.prepare('SELECT username, password_hash FROM admin WHERE id = 1').get();
  if (!admin || admin.username !== username || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
  }

  const token = createToken(username);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
  });

  res.json({ ok: true, username });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.json({ loggedIn: false });
  }
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ loggedIn: true, username: user.username });
  } catch {
    res.clearCookie(COOKIE_NAME);
    res.json({ loggedIn: false });
  }
});

app.get('/api/data', authMiddleware, (_req, res) => {
  const data = getStoredData();
  const row = db.prepare('SELECT updated_at FROM app_data WHERE id = 1').get();
  res.json({ data, updatedAt: row.updated_at });
});

app.put('/api/data', authMiddleware, (req, res) => {
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

  const admin = db.prepare('SELECT password_hash FROM admin WHERE id = 1').get();
  if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = 1').run(hash, nowIso());
  res.json({ ok: true });
});

app.get('/api/backup', authMiddleware, (_req, res) => {
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

app.post('/api/restore', authMiddleware, (req, res) => {
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
  console.log('Tài khoản admin:', ADMIN_USERNAME);
});
