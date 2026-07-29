const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const APP_DATA_PATH = path.join(DATA_DIR, 'app-data.json');
const BACKUP_PATH = path.join(DATA_DIR, 'backup-latest.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'messages.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'TranDinhHung2003/Muctieu';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'cursor/muc-tieu-chay-xe-becf';
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || 'data/app-data.json';
const GITHUB_MESSAGES_PATH = process.env.GITHUB_MESSAGES_PATH || 'data/messages.json';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let memoryStore = null;
let githubSha = null;
let memoryMessages = null;
let githubMessagesSha = null;
const MAX_MESSAGES = 500;

function nowIso() {
  return new Date().toISOString();
}

function emptyStore() {
  return { data: { days: {} }, updatedAt: nowIso() };
}

function hasMoneyData(store) {
  const days = (store && store.data && store.data.days) || {};
  return Object.values(days).some((day) => {
    if (!day) return false;
    return (day.app || 0) > 0
      || (day.outside || 0) > 0
      || (day.zoomPoints || 0) > 0
      || (day.highway || 0) > 0
      || (day.tip || 0) > 0;
  });
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

function loadFromDisk() {
  const store = readJson(APP_DATA_PATH, null);
  if (store && store.data) return store;

  const backup = readJson(BACKUP_PATH, null);
  if (backup && backup.days) {
    return { data: backup, updatedAt: nowIso() };
  }
  if (backup && backup.data && backup.data.days) {
    return { data: backup.data, updatedAt: backup.updatedAt || nowIso() };
  }
  return emptyStore();
}

function saveToDisk(store) {
  writeJson(APP_DATA_PATH, store);
  writeJson(BACKUP_PATH, store.data || { days: {} });
}

async function githubRequest(urlPath, options = {}) {
  if (!GITHUB_TOKEN) return null;
  const res = await fetch('https://api.github.com' + urlPath, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'muctieu-chay-xe',
      ...(options.headers || {}),
    },
  });
  if (res.status === 404) return { notFound: true, status: 404 };
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = (body && body.message) || ('GitHub HTTP ' + res.status);
    throw new Error(msg);
  }
  return body;
}

async function loadFromGitHub() {
  if (!GITHUB_TOKEN) return null;
  try {
    const encPath = GITHUB_DATA_PATH.split('/').map(encodeURIComponent).join('/');
    const info = await githubRequest(
      '/repos/' + GITHUB_REPO + '/contents/' + encPath + '?ref=' + encodeURIComponent(GITHUB_BRANCH)
    );
    if (!info || info.notFound || !info.content) return null;
    githubSha = info.sha || null;
    const decoded = Buffer.from(info.content, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && parsed.data && parsed.data.days) return parsed;
    if (parsed && parsed.days) return { data: parsed, updatedAt: nowIso() };
    return null;
  } catch (err) {
    console.warn('Không tải được dữ liệu từ GitHub:', err.message);
    return null;
  }
}

async function saveToGitHub(store) {
  if (!GITHUB_TOKEN) return false;
  try {
    const encPath = GITHUB_DATA_PATH.split('/').map(encodeURIComponent).join('/');
    if (!githubSha) {
      const info = await githubRequest(
        '/repos/' + GITHUB_REPO + '/contents/' + encPath + '?ref=' + encodeURIComponent(GITHUB_BRANCH)
      );
      if (info && !info.notFound && info.sha) githubSha = info.sha;
    }

    const content = Buffer.from(JSON.stringify(store, null, 2), 'utf8').toString('base64');
    const body = {
      message: 'chore: cập nhật dữ liệu mục tiêu chạy xe',
      content,
      branch: GITHUB_BRANCH,
    };
    if (githubSha) body.sha = githubSha;

    const result = await githubRequest(
      '/repos/' + GITHUB_REPO + '/contents/' + encPath,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    if (result && result.content && result.content.sha) {
      githubSha = result.content.sha;
    }
    return true;
  } catch (err) {
    console.warn('Không lưu được dữ liệu lên GitHub:', err.message);
    return false;
  }
}

async function initAppStore() {
  let store = loadFromDisk();
  const remote = await loadFromGitHub();

  if (remote) {
    const diskTime = store && store.updatedAt ? new Date(store.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const preferRemote = !hasMoneyData(store)
      || (hasMoneyData(remote) && remoteTime >= diskTime);

    if (preferRemote) {
      store = remote;
      saveToDisk(store);
      console.log('Đã tải dữ liệu bền từ GitHub');
    }
  }

  memoryStore = store;
  return store;
}

function getAppStore() {
  if (!memoryStore) {
    memoryStore = loadFromDisk();
  }
  return memoryStore;
}

async function setAppStore(data) {
  const store = {
    data,
    updatedAt: nowIso(),
  };
  memoryStore = store;
  saveToDisk(store);
  // Lưu bền lên GitHub để theodoi vẫn xem được khi admin offline / Render sleep
  await saveToGitHub(store);
  return store.updatedAt;
}

function emptyMessagesStore() {
  return { messages: [], updatedAt: nowIso() };
}

function normalizeMessagesStore(raw) {
  if (!raw || typeof raw !== 'object') return emptyMessagesStore();
  const list = Array.isArray(raw.messages) ? raw.messages : [];
  return {
    messages: list
      .filter((m) => m && typeof m.text === 'string' && m.text.trim())
      .map((m) => ({
        id: String(m.id || ''),
        from: String(m.from || ''),
        role: m.role === 'viewer' ? 'viewer' : 'admin',
        text: String(m.text).trim().slice(0, 1000),
        at: m.at || nowIso(),
      }))
      .filter((m) => m.id && m.from)
      .slice(-MAX_MESSAGES),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

function loadMessagesFromDisk() {
  return normalizeMessagesStore(readJson(MESSAGES_PATH, emptyMessagesStore()));
}

function saveMessagesToDisk(store) {
  writeJson(MESSAGES_PATH, store);
}

async function loadMessagesFromGitHub() {
  if (!GITHUB_TOKEN) return null;
  try {
    const encPath = GITHUB_MESSAGES_PATH.split('/').map(encodeURIComponent).join('/');
    const info = await githubRequest(
      '/repos/' + GITHUB_REPO + '/contents/' + encPath + '?ref=' + encodeURIComponent(GITHUB_BRANCH)
    );
    if (!info || info.notFound || !info.content) return null;
    githubMessagesSha = info.sha || null;
    const decoded = Buffer.from(info.content, 'base64').toString('utf8');
    return normalizeMessagesStore(JSON.parse(decoded));
  } catch (err) {
    console.warn('Không tải được tin nhắn từ GitHub:', err.message);
    return null;
  }
}

async function saveMessagesToGitHub(store) {
  if (!GITHUB_TOKEN) return false;
  try {
    const encPath = GITHUB_MESSAGES_PATH.split('/').map(encodeURIComponent).join('/');
    if (!githubMessagesSha) {
      const info = await githubRequest(
        '/repos/' + GITHUB_REPO + '/contents/' + encPath + '?ref=' + encodeURIComponent(GITHUB_BRANCH)
      );
      if (info && !info.notFound && info.sha) githubMessagesSha = info.sha;
    }
    const content = Buffer.from(JSON.stringify(store, null, 2), 'utf8').toString('base64');
    const body = {
      message: 'chore: cập nhật tin nhắn admin ↔ theo dõi',
      content,
      branch: GITHUB_BRANCH,
    };
    if (githubMessagesSha) body.sha = githubMessagesSha;
    const result = await githubRequest(
      '/repos/' + GITHUB_REPO + '/contents/' + encPath,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    if (result && result.content && result.content.sha) {
      githubMessagesSha = result.content.sha;
    }
    return true;
  } catch (err) {
    console.warn('Không lưu được tin nhắn lên GitHub:', err.message);
    return false;
  }
}

async function initMessagesStore() {
  let store = loadMessagesFromDisk();
  const remote = await loadMessagesFromGitHub();
  if (remote) {
    const diskTime = store.updatedAt ? new Date(store.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const preferRemote = (remote.messages.length > store.messages.length)
      || (remote.messages.length > 0 && remoteTime >= diskTime);
    if (preferRemote) {
      store = remote;
      saveMessagesToDisk(store);
      console.log('Đã tải tin nhắn từ GitHub');
    }
  }
  memoryMessages = store;
  return store;
}

function getMessagesStore() {
  if (!memoryMessages) memoryMessages = loadMessagesFromDisk();
  return memoryMessages;
}

async function addMessage({ from, role, text }) {
  const clean = String(text || '').trim().slice(0, 1000);
  if (!clean) throw new Error('Nội dung trống');
  const store = getMessagesStore();
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    from: String(from || ''),
    role: role === 'viewer' ? 'viewer' : 'admin',
    text: clean,
    at: nowIso(),
  };
  store.messages = [...store.messages, msg].slice(-MAX_MESSAGES);
  store.updatedAt = nowIso();
  memoryMessages = store;
  saveMessagesToDisk(store);
  await saveMessagesToGitHub(store);
  return { message: msg, updatedAt: store.updatedAt };
}

module.exports = {
  DATA_DIR,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH,
  initAppStore,
  getAppStore,
  setAppStore,
  hasMoneyData,
  nowIso,
  initMessagesStore,
  getMessagesStore,
  addMessage,
};
