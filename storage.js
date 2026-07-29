const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const APP_DATA_PATH = path.join(DATA_DIR, 'app-data.json');
const BACKUP_PATH = path.join(DATA_DIR, 'backup-latest.json');
const MESSAGES_PATH = path.join(DATA_DIR, 'messages.json');
const CHAT_IMAGES_DIR = path.join(DATA_DIR, 'chat-images');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'TranDinhHung2003/Muctieu';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'cursor/muc-tieu-chay-xe-becf';
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || 'data/app-data.json';
const GITHUB_MESSAGES_PATH = process.env.GITHUB_MESSAGES_PATH || 'data/messages.json';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(CHAT_IMAGES_DIR)) {
  fs.mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
}

let memoryStore = null;
let githubSha = null;
let memoryMessages = null;
let githubMessagesSha = null;
const MAX_MESSAGES = 200;
const MESSAGE_TTL_MS = 30 * 60 * 1000;
const MAX_IMAGE_BYTES = 700 * 1024;

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

function normalizeCallFields(m) {
  if (!m || m.kind !== 'call') return {};
  const callEvent = ['ended', 'cancelled', 'rejected', 'missed'].includes(m.callEvent)
    ? m.callEvent
    : 'ended';
  const callMode = m.callMode === 'video' ? 'video' : 'audio';
  const durationSec = Math.max(0, Math.min(86400, Number(m.durationSec) || 0));
  const callId = m.callId ? String(m.callId).slice(0, 64) : undefined;
  return { kind: 'call', callEvent, callMode, durationSec, callId };
}

function emptyMessagesStore() {
  return { messages: [], nicknames: {}, updatedAt: nowIso() };
}

function normalizeNicknamesMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach((key) => {
    const username = String(key || '').trim().slice(0, 32);
    if (!username) return;
    const val = String(raw[key] || '')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (val) out[username] = val;
  });
  return out;
}

function isFreshMessage(m, now = Date.now()) {
  if (!m || !m.at) return false;
  const t = new Date(m.at).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= MESSAGE_TTL_MS;
}

function deleteChatImageFile(imageId) {
  if (!imageId) return;
  const safe = String(imageId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return;
  const filePath = path.join(CHAT_IMAGES_DIR, safe + '.img');
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

function normalizeMessagesStore(raw) {
  if (!raw || typeof raw !== 'object') return emptyMessagesStore();
  const now = Date.now();
  const list = Array.isArray(raw.messages) ? raw.messages : [];
  const kept = [];
  for (const m of list) {
    if (!m || !m.id || !m.from) continue;
    if (!isFreshMessage(m, now)) {
      deleteChatImageFile(m.imageId);
      continue;
    }
    const text = typeof m.text === 'string' ? m.text.trim().slice(0, 1000) : '';
    const imageId = m.imageId ? String(m.imageId).replace(/[^a-zA-Z0-9_-]/g, '') : '';
    const callFields = normalizeCallFields(m);
    if (!text && !imageId && callFields.kind !== 'call') continue;
    kept.push({
      id: String(m.id),
      from: String(m.from),
      role: m.role === 'viewer' ? 'viewer' : 'admin',
      text: callFields.kind === 'call'
        ? (text || buildCallMessageText(callFields.callEvent, callFields.callMode, callFields.durationSec))
        : text,
      imageId: imageId || undefined,
      at: m.at || nowIso(),
      status: normalizeMessageStatus(m.status),
      deliveredAt: m.deliveredAt || undefined,
      readAt: m.readAt || undefined,
      ...callFields,
    });
  }
  return {
    messages: kept.slice(-MAX_MESSAGES),
    nicknames: normalizeNicknamesMap(raw.nicknames),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

function normalizeMessageStatus(status) {
  if (status === 'delivered' || status === 'read' || status === 'sent') return status;
  return 'sent';
}

function pruneExpiredMessages(persist = true) {
  if (!memoryMessages) memoryMessages = loadMessagesFromDisk();
  const store = memoryMessages;
  const before = store.messages.length;
  const next = normalizeMessagesStore(store);
  const changed = next.messages.length !== before
    || next.messages.some((m, i) => !store.messages[i] || m.id !== store.messages[i].id);
  if (changed) {
    next.updatedAt = nowIso();
    memoryMessages = next;
    if (persist) {
      saveMessagesToDisk(next);
      saveMessagesToGitHub(next).catch(() => {});
    }
  } else if (!store.nicknames) {
    // Đảm bảo luôn có field nicknames trên memory store
    store.nicknames = next.nicknames || {};
  }
  return memoryMessages;
}

function getStoredNicknames() {
  const store = getMessagesStore();
  return normalizeNicknamesMap(store && store.nicknames);
}

async function setPeerNickname(username, nickname) {
  const user = String(username || '').trim().slice(0, 32);
  const nick = String(nickname || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  if (!user || !nick) throw new Error('Biệt danh không hợp lệ');

  const store = getMessagesStore();
  const nicknames = normalizeNicknamesMap(store.nicknames);
  nicknames[user] = nick;
  store.nicknames = nicknames;
  store.updatedAt = nowIso();
  memoryMessages = store;
  saveMessagesToDisk(store);
  await saveMessagesToGitHub(store);
  return { nicknames: store.nicknames, updatedAt: store.updatedAt };
}

function getMessagesStore() {
  return pruneExpiredMessages(true);
}

function loadMessagesFromDisk() {
  return normalizeMessagesStore(readJson(MESSAGES_PATH, emptyMessagesStore()));
}

function saveMessagesToDisk(store) {
  writeJson(MESSAGES_PATH, store);
}

function saveChatImageFromDataUrl(messageId, dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('Ảnh không hợp lệ');
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const buf = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw new Error('Ảnh trống');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('Ảnh quá lớn (tối đa ~700KB sau khi nén)');
  const imageId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!imageId) throw new Error('Không tạo được ảnh');
  const meta = JSON.stringify({ mime, at: nowIso() });
  const payload = Buffer.concat([
    Buffer.from(meta, 'utf8'),
    Buffer.from('\n', 'utf8'),
    buf,
  ]);
  fs.writeFileSync(path.join(CHAT_IMAGES_DIR, imageId + '.img'), payload);
  return { imageId, mime, size: buf.length };
}

function readChatImage(imageId) {
  const safe = String(imageId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  const filePath = path.join(CHAT_IMAGES_DIR, safe + '.img');
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath);
  const idx = raw.indexOf(0x0a); // \n
  if (idx < 0) return null;
  let meta = {};
  try { meta = JSON.parse(raw.slice(0, idx).toString('utf8')); } catch { meta = {}; }
  return {
    mime: meta.mime || 'image/jpeg',
    buffer: raw.slice(idx + 1),
  };
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
    // Không đẩy binary ảnh lên GitHub — chỉ metadata tin nhắn
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
  pruneExpiredMessages(true);
  return memoryMessages;
}

function buildCallMessageText(callEvent, callMode, durationSec) {
  const kind = callMode === 'video' ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
  const sec = Math.max(0, Math.floor(Number(durationSec) || 0));
  if (callEvent === 'ended') {
    return kind + ' · ' + formatDurationVi(sec);
  }
  if (callEvent === 'cancelled') return kind + ' · Đã hủy';
  if (callEvent === 'rejected') return kind + ' · Đã từ chối';
  if (callEvent === 'missed') return 'Cuộc gọi nhỡ · ' + kind;
  return kind;
}

function formatDurationVi(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

async function addMessage({ from, role, text, imageDataUrl, kind, callEvent, callMode, durationSec, callId }) {
  const callFields = kind === 'call'
    ? normalizeCallFields({ kind, callEvent, callMode, durationSec, callId })
    : {};
  const clean = String(text || '').trim().slice(0, 1000);
  const hasImage = !!(imageDataUrl && String(imageDataUrl).startsWith('data:image/'));
  if (callFields.kind === 'call') {
    // ok
  } else if (!clean && !hasImage) {
    throw new Error('Nội dung trống');
  }

  const store = getMessagesStore();
  if (callFields.kind === 'call' && callFields.callId) {
    const dup = (store.messages || []).some((m) => (
      m && m.kind === 'call' && m.callId === callFields.callId && m.callEvent === callFields.callEvent
    ));
    if (dup) {
      return { message: null, updatedAt: store.updatedAt, duplicate: true };
    }
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let imageId;
  if (hasImage) {
    const saved = saveChatImageFromDataUrl(id, imageDataUrl);
    imageId = saved.imageId;
  }
  const msg = {
    id,
    from: String(from || ''),
    role: role === 'viewer' ? 'viewer' : 'admin',
    text: callFields.kind === 'call'
      ? buildCallMessageText(callFields.callEvent, callFields.callMode, callFields.durationSec)
      : clean,
    imageId,
    at: nowIso(),
    status: 'sent',
    ...callFields,
  };
  store.messages = [...store.messages, msg].slice(-MAX_MESSAGES);
  store.updatedAt = nowIso();
  memoryMessages = store;
  saveMessagesToDisk(store);
  await saveMessagesToGitHub(store);
  return { message: msg, updatedAt: store.updatedAt };
}

function markMessagesDelivered(viewerUsername) {
  const store = getMessagesStore();
  const user = String(viewerUsername || '');
  let changed = false;
  const now = nowIso();
  store.messages = (store.messages || []).map((m) => {
    if (!m || m.from === user) return m;
    if (m.status === 'delivered' || m.status === 'read') return m;
    changed = true;
    return Object.assign({}, m, {
      status: 'delivered',
      deliveredAt: m.deliveredAt || now,
    });
  });
  if (changed) {
    store.updatedAt = now;
    memoryMessages = store;
    saveMessagesToDisk(store);
    saveMessagesToGitHub(store).catch(() => {});
  }
  return store;
}

function markMessagesRead(viewerUsername) {
  const store = getMessagesStore();
  const user = String(viewerUsername || '');
  let changed = false;
  const now = nowIso();
  store.messages = (store.messages || []).map((m) => {
    if (!m || m.from === user) return m;
    if (m.status === 'read') return m;
    changed = true;
    return Object.assign({}, m, {
      status: 'read',
      deliveredAt: m.deliveredAt || now,
      readAt: now,
    });
  });
  if (changed) {
    store.updatedAt = now;
    memoryMessages = store;
    saveMessagesToDisk(store);
    saveMessagesToGitHub(store).catch(() => {});
  }
  return store;
}

module.exports = {
  DATA_DIR,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH,
  MESSAGE_TTL_MS,
  initAppStore,
  getAppStore,
  setAppStore,
  hasMoneyData,
  nowIso,
  initMessagesStore,
  getMessagesStore,
  getStoredNicknames,
  setPeerNickname,
  addMessage,
  markMessagesDelivered,
  markMessagesRead,
  pruneExpiredMessages,
  readChatImage,
};
