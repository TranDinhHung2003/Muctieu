/**
 * Kho dữ liệu theo từng workspace.
 *
 * Mỗi tài khoản sở hữu đúng 1 workspace mang tên tài khoản đó:
 *   workspaces/<owner>/app-data.json   → doanh thu, mục tiêu... (chỉ chủ được sửa)
 *   workspaces/<owner>/messages.json   → hội thoại chủ ↔ từng người theo dõi
 *
 * Ảnh chat dùng chung thư mục `chat-images/` vì id ảnh đã là chuỗi ngẫu nhiên.
 */

const durable = require('./lib/durable');

const MAX_MESSAGES = 200;
const MESSAGE_TTL_MS = 30 * 60 * 1000;
const MAX_IMAGE_BYTES = 700 * 1024;

const LEGACY_DATA_PATH = 'app-data.json';
const LEGACY_BACKUP_PATH = 'backup-latest.json';
const LEGACY_MESSAGES_PATH = 'messages.json';

/** owner → { data, updatedAt } */
const dataStores = new Map();
/** owner → { conversations, nicknames, updatedAt } */
const messageStores = new Map();
/** owner → Promise, tránh tải trùng khi nhiều request cùng vào 1 workspace */
const dataLoading = new Map();
const messagesLoading = new Map();

function nowIso() {
  return durable.nowIso();
}

function safeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function dataPath(owner) {
  return 'workspaces/' + safeName(owner) + '/app-data.json';
}

function messagesPath(owner) {
  return 'workspaces/' + safeName(owner) + '/messages.json';
}

function chatImagePath(imageId) {
  const safe = String(imageId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  return 'chat-images/' + safe + '.img';
}

/* ------------------------------------------------------------------ */
/* Dữ liệu doanh thu                                                    */
/* ------------------------------------------------------------------ */

function emptyData() {
  return { data: { days: {} }, updatedAt: nowIso() };
}

function normalizeDataStore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.data && raw.data.days && typeof raw.data.days === 'object') {
    return { data: raw.data, updatedAt: raw.updatedAt || nowIso() };
  }
  if (raw.days && typeof raw.days === 'object') {
    return { data: raw, updatedAt: raw.updatedAt || nowIso() };
  }
  return null;
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

async function loadDataStore(owner) {
  const key = safeName(owner);
  const logical = dataPath(key);
  const local = normalizeDataStore(durable.readLocalJson(logical, null));
  const remote = normalizeDataStore(await durable.readRemoteJson(logical));

  let store = local || emptyData();
  if (remote) {
    const localTime = local && local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const preferRemote = !hasMoneyData(store)
      || (hasMoneyData(remote) && remoteTime >= localTime);
    if (preferRemote) {
      store = remote;
      durable.writeLocalJson(logical, store);
      console.log('Đã tải dữ liệu workspace', key, 'từ GitHub');
    }
  }
  return store;
}

async function initWorkspaceData(owner) {
  const key = safeName(owner);
  if (dataStores.has(key)) return dataStores.get(key);
  if (dataLoading.has(key)) return dataLoading.get(key);

  const job = loadDataStore(key).then((store) => {
    dataStores.set(key, store);
    dataLoading.delete(key);
    return store;
  }).catch((err) => {
    dataLoading.delete(key);
    console.warn('Không tải được workspace', key, err && err.message);
    const store = normalizeDataStore(durable.readLocalJson(dataPath(key), null)) || emptyData();
    dataStores.set(key, store);
    return store;
  });
  dataLoading.set(key, job);
  return job;
}

function getAppStore(owner) {
  const key = safeName(owner);
  if (!dataStores.has(key)) {
    dataStores.set(key, normalizeDataStore(durable.readLocalJson(dataPath(key), null)) || emptyData());
  }
  return dataStores.get(key);
}

async function setAppStore(owner, data) {
  const key = safeName(owner);
  const store = { data, updatedAt: nowIso() };
  dataStores.set(key, store);
  await durable.persistJson(dataPath(key), store, 'chore: cập nhật dữ liệu ' + key);
  return store.updatedAt;
}

/* ------------------------------------------------------------------ */
/* Tin nhắn                                                             */
/* ------------------------------------------------------------------ */

function emptyMessagesStore() {
  return { conversations: {}, nicknames: {}, updatedAt: nowIso() };
}

function emptyConversation() {
  return { messages: [], receipts: {} };
}

function cleanNickname(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function normalizeNicknamesMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach((key) => {
    const username = String(key || '').trim().toLowerCase().slice(0, 32);
    const value = cleanNickname(raw[key]);
    if (username && value) out[username] = value;
  });
  return out;
}

function normalizeReceiptsMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.keys(raw).forEach((key) => {
    const username = String(key || '').trim().toLowerCase().slice(0, 32);
    if (!username) return;
    const row = raw[key] || {};
    const entry = {};
    ['lastDeliveredAt', 'lastReadAt'].forEach((field) => {
      const time = row[field] ? new Date(row[field]).getTime() : NaN;
      if (Number.isFinite(time)) entry[field] = new Date(time).toISOString();
    });
    if (Object.keys(entry).length) out[username] = entry;
  });
  return out;
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

function buildCallMessageText(callEvent, callMode, durationSec) {
  const kind = callMode === 'video' ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
  if (callEvent === 'ended') return kind + ' · ' + formatDurationVi(durationSec);
  if (callEvent === 'cancelled') return kind + ' · Đã hủy';
  if (callEvent === 'rejected') return kind + ' · Đã từ chối';
  if (callEvent === 'missed') return 'Cuộc gọi nhỡ · ' + kind;
  return kind;
}

function isFreshMessage(m, now = Date.now()) {
  if (!m || !m.at) return false;
  const t = new Date(m.at).getTime();
  return Number.isFinite(t) && now - t <= MESSAGE_TTL_MS;
}

function normalizeMessageStatus(status) {
  return status === 'delivered' || status === 'read' || status === 'sent' ? status : 'sent';
}

function deleteChatImage(imageId) {
  const logical = chatImagePath(imageId);
  if (!logical) return;
  durable.removeLocal(logical);
  durable.deleteRemote(logical, 'chore: xoá ảnh chat hết hạn ' + imageId).catch(() => {});
}

function parseChatImagePayload(raw) {
  if (!raw || !raw.length) return null;
  const idx = raw.indexOf(0x0a);
  if (idx < 0) return null;
  let meta = {};
  try { meta = JSON.parse(raw.slice(0, idx).toString('utf8')); } catch { meta = {}; }
  const buffer = raw.slice(idx + 1);
  if (!buffer.length) return null;
  return { mime: meta.mime || 'image/jpeg', buffer };
}

function buildChatImagePayload(mime, buffer, at) {
  const meta = JSON.stringify({ mime: mime || 'image/jpeg', at: at || nowIso() });
  return Buffer.concat([
    Buffer.from(meta, 'utf8'),
    Buffer.from('\n', 'utf8'),
    Buffer.from(buffer),
  ]);
}

function normalizeMessage(m, now) {
  if (!m || !m.id || !m.from) return null;
  if (!isFreshMessage(m, now)) {
    deleteChatImage(m.imageId);
    return null;
  }
  const text = typeof m.text === 'string' ? m.text.trim().slice(0, 1000) : '';
  const imageId = m.imageId ? String(m.imageId).replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const callFields = normalizeCallFields(m);
  if (!text && !imageId && callFields.kind !== 'call') return null;

  const imageMime = m.imageMime ? String(m.imageMime).slice(0, 64) : '';
  const imageBin = typeof m.imageBin === 'string' && m.imageBin.length
    ? String(m.imageBin).replace(/\s+/g, '')
    : '';

  // Đĩa của Render là tạm — dựng lại file ảnh từ bản base64 bền nếu đã mất
  if (imageId && imageBin) {
    const logical = chatImagePath(imageId);
    if (logical && !durable.localExists(logical)) {
      try {
        const buf = Buffer.from(imageBin, 'base64');
        if (buf.length) {
          durable.writeLocalBuffer(logical, buildChatImagePayload(imageMime, buf, m.at));
        }
      } catch { /* ignore */ }
    }
  }

  const entry = {
    id: String(m.id),
    from: String(m.from).toLowerCase(),
    role: m.role === 'viewer' ? 'viewer' : 'admin',
    text: callFields.kind === 'call'
      ? (text || buildCallMessageText(callFields.callEvent, callFields.callMode, callFields.durationSec))
      : text,
    imageId: imageId || undefined,
    at: m.at || nowIso(),
    status: normalizeMessageStatus(m.status),
    ...callFields,
  };
  if (imageId && imageBin) {
    entry.imageBin = imageBin;
    entry.imageMime = imageMime || 'image/jpeg';
  }
  return entry;
}

function sortMessages(list) {
  return list.sort((a, b) => {
    const ta = new Date(a.at).getTime() || 0;
    const tb = new Date(b.at).getTime() || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function normalizeConversation(raw) {
  const now = Date.now();
  const list = Array.isArray(raw && raw.messages) ? raw.messages : [];
  const kept = [];
  list.forEach((m) => {
    const entry = normalizeMessage(m, now);
    if (entry) kept.push(entry);
  });
  return {
    messages: sortMessages(kept).slice(-MAX_MESSAGES),
    receipts: normalizeReceiptsMap(raw && raw.receipts),
  };
}

function normalizeMessagesStore(raw) {
  const conversations = {};
  const rawConversations = (raw && raw.conversations && typeof raw.conversations === 'object')
    ? raw.conversations
    : {};
  Object.keys(rawConversations).forEach((key) => {
    const peer = String(key || '').trim().toLowerCase().slice(0, 32);
    if (!peer) return;
    conversations[peer] = normalizeConversation(rawConversations[key]);
  });
  return {
    conversations,
    nicknames: normalizeNicknamesMap(raw && raw.nicknames),
    updatedAt: (raw && raw.updatedAt) || nowIso(),
  };
}

function countMessages(store) {
  return Object.values((store && store.conversations) || {})
    .reduce((n, conv) => n + ((conv && conv.messages) || []).length, 0);
}

async function loadMessagesStore(owner) {
  const key = safeName(owner);
  const logical = messagesPath(key);
  const local = normalizeMessagesStore(durable.readLocalJson(logical, null));
  const remoteRaw = await durable.readRemoteJson(logical);

  let store = local;
  if (remoteRaw) {
    const remote = normalizeMessagesStore(remoteRaw);
    const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const remoteCount = countMessages(remote);
    if (remoteCount > countMessages(local) || (remoteCount > 0 && remoteTime >= localTime)
      || Object.keys(remote.nicknames).length > Object.keys(local.nicknames).length) {
      store = remote;
      durable.writeLocalJson(logical, store);
      console.log('Đã tải tin nhắn workspace', key, 'từ GitHub');
    }
  }
  return store;
}

async function initWorkspaceMessages(owner) {
  const key = safeName(owner);
  if (messageStores.has(key)) return messageStores.get(key);
  if (messagesLoading.has(key)) return messagesLoading.get(key);

  const job = loadMessagesStore(key).then((store) => {
    messageStores.set(key, store);
    messagesLoading.delete(key);
    return store;
  }).catch((err) => {
    messagesLoading.delete(key);
    console.warn('Không tải được tin nhắn workspace', key, err && err.message);
    const store = normalizeMessagesStore(durable.readLocalJson(messagesPath(key), null));
    messageStores.set(key, store);
    return store;
  });
  messagesLoading.set(key, job);
  return job;
}

function rawMessagesStore(owner) {
  const key = safeName(owner);
  if (!messageStores.has(key)) {
    messageStores.set(key, normalizeMessagesStore(durable.readLocalJson(messagesPath(key), null)));
  }
  return messageStores.get(key);
}

function persistMessages(owner, { remote = true } = {}) {
  const key = safeName(owner);
  const store = rawMessagesStore(key);
  durable.writeLocalJson(messagesPath(key), store);
  if (remote) {
    durable.writeRemoteJson(messagesPath(key), store, 'chore: cập nhật tin nhắn ' + key).catch(() => {});
  }
  return store.updatedAt;
}

/** Dọn tin quá hạn (30 phút); trả về store đã dọn. */
function pruneExpiredMessages(owner, persist = true) {
  const key = safeName(owner);
  const store = rawMessagesStore(key);
  const before = countMessages(store);
  const next = normalizeMessagesStore(store);
  if (countMessages(next) !== before) {
    next.updatedAt = nowIso();
    messageStores.set(key, next);
    if (persist) persistMessages(key);
    return next;
  }
  return store;
}

function getMessagesStore(owner) {
  return pruneExpiredMessages(owner, true);
}

function getConversation(owner, peer) {
  const store = getMessagesStore(owner);
  const key = safeName(peer);
  if (!key) return emptyConversation();
  if (!store.conversations[key]) store.conversations[key] = emptyConversation();
  return store.conversations[key];
}

function getStoredNicknames(owner) {
  return normalizeNicknamesMap(getMessagesStore(owner).nicknames);
}

async function setNickname(owner, username, nickname) {
  const key = safeName(owner);
  const target = safeName(username);
  const nick = cleanNickname(nickname);
  if (!target || !nick) throw new Error('Biệt danh không hợp lệ');
  const store = getMessagesStore(key);
  store.nicknames = normalizeNicknamesMap(store.nicknames);
  store.nicknames[target] = nick;
  store.updatedAt = nowIso();
  messageStores.set(key, store);
  durable.writeLocalJson(messagesPath(key), store);
  await durable.writeRemoteJson(messagesPath(key), store, 'chore: cập nhật biệt danh ' + key);
  return { nicknames: store.nicknames, updatedAt: store.updatedAt };
}

function bumpReceipt(conversation, username, field, atIso) {
  const user = safeName(username);
  if (!user || (field !== 'lastDeliveredAt' && field !== 'lastReadAt')) return false;
  const atMs = new Date(atIso || nowIso()).getTime();
  if (!Number.isFinite(atMs)) return false;

  const current = Object.assign({}, conversation.receipts[user] || {});
  let changed = false;
  const previous = current[field] ? new Date(current[field]).getTime() : 0;
  if (!previous || atMs > previous) {
    current[field] = new Date(atMs).toISOString();
    changed = true;
  }
  // Đã đọc thì hiển nhiên đã nhận
  if (field === 'lastReadAt' && current.lastReadAt) {
    const readMs = new Date(current.lastReadAt).getTime();
    const deliveredMs = current.lastDeliveredAt ? new Date(current.lastDeliveredAt).getTime() : 0;
    if (Number.isFinite(readMs) && readMs > deliveredMs) {
      current.lastDeliveredAt = current.lastReadAt;
      changed = true;
    }
  }
  if (!changed) return false;
  conversation.receipts[user] = current;
  return true;
}

function statusForOutgoing(messageAt, peerReceipt) {
  const at = new Date(messageAt).getTime();
  if (!Number.isFinite(at)) return 'sent';
  const readAt = peerReceipt && peerReceipt.lastReadAt ? new Date(peerReceipt.lastReadAt).getTime() : 0;
  const deliveredAt = peerReceipt && peerReceipt.lastDeliveredAt
    ? new Date(peerReceipt.lastDeliveredAt).getTime()
    : 0;
  if (Number.isFinite(readAt) && readAt >= at) return 'read';
  if (Number.isFinite(deliveredAt) && deliveredAt >= at) return 'delivered';
  return 'sent';
}

function publicMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = Object.assign({}, m);
  delete out.imageBin;
  delete out.imageMime;
  return out;
}

/**
 * Danh sách tin của 1 hội thoại, kèm trạng thái gửi tính theo receipts của đối phương.
 * `viewer` là tài khoản đang xem, `other` là tài khoản còn lại trong hội thoại.
 */
function publicConversation(owner, peer, viewer, other) {
  const store = getMessagesStore(owner);
  const conversation = getConversation(owner, peer);
  const peerReceipt = conversation.receipts[safeName(other)] || {};
  const me = safeName(viewer);
  const messages = (conversation.messages || []).map((m) => {
    const pub = publicMessage(m);
    if (pub.from === me) {
      return Object.assign({}, pub, { status: statusForOutgoing(pub.at, peerReceipt) });
    }
    return Object.assign({}, pub, { status: 'sent' });
  });
  return { messages, nicknames: store.nicknames || {}, updatedAt: store.updatedAt };
}

function saveChatImageFromDataUrl(messageId, dataUrl) {
  const match = String(dataUrl || '')
    .match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('Ảnh không hợp lệ');
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const base64 = match[2].replace(/\s+/g, '');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new Error('Ảnh trống');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('Ảnh quá lớn (tối đa ~700KB sau khi nén)');
  const imageId = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!imageId) throw new Error('Không tạo được ảnh');
  const payload = buildChatImagePayload(mime, buf);
  durable.writeLocalBuffer(chatImagePath(imageId), payload);
  return { imageId, mime, base64, payload };
}

/** Đọc ảnh local; nếu đĩa Render đã mất thì dựng lại từ store bền / GitHub. */
async function resolveChatImage(owner, imageId) {
  const logical = chatImagePath(imageId);
  if (!logical) return null;

  const local = parseChatImagePayload(durable.readLocalBuffer(logical));
  if (local) return local;

  const safeId = String(imageId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const store = rawMessagesStore(owner);
  for (const conversation of Object.values(store.conversations || {})) {
    const msg = (conversation.messages || []).find((m) => m && m.imageId === safeId && m.imageBin);
    if (!msg) continue;
    try {
      const buf = Buffer.from(String(msg.imageBin).replace(/\s+/g, ''), 'base64');
      if (!buf.length) continue;
      const payload = buildChatImagePayload(msg.imageMime, buf, msg.at);
      durable.writeLocalBuffer(logical, payload);
      return parseChatImagePayload(payload);
    } catch { /* ignore */ }
  }

  const remote = await durable.readRemoteBuffer(logical);
  if (!remote) return null;
  const parsed = parseChatImagePayload(remote);
  if (parsed) durable.writeLocalBuffer(logical, remote);
  return parsed;
}

async function addMessage(owner, peer, {
  from, role, text, imageDataUrl, kind, callEvent, callMode, durationSec, callId,
}) {
  const callFields = kind === 'call'
    ? normalizeCallFields({ kind, callEvent, callMode, durationSec, callId })
    : {};
  const clean = String(text || '').trim().slice(0, 1000);
  const hasImage = !!(imageDataUrl && String(imageDataUrl).startsWith('data:image/'));
  if (callFields.kind !== 'call' && !clean && !hasImage) {
    throw new Error('Nội dung trống');
  }

  const key = safeName(owner);
  const conversation = getConversation(key, peer);

  if (callFields.kind === 'call' && callFields.callId) {
    const duplicate = (conversation.messages || []).some((m) => (
      m && m.kind === 'call' && m.callId === callFields.callId && m.callEvent === callFields.callEvent
    ));
    if (duplicate) {
      return { message: null, updatedAt: rawMessagesStore(key).updatedAt, duplicate: true };
    }
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let imageId;
  let imagePayload = null;
  let imageMime = null;
  let imageBin = null;
  if (hasImage) {
    const saved = saveChatImageFromDataUrl(id, imageDataUrl);
    imageId = saved.imageId;
    imagePayload = saved.payload;
    imageMime = saved.mime;
    imageBin = saved.base64;
  }

  const message = {
    id,
    from: safeName(from),
    role: role === 'viewer' ? 'viewer' : 'admin',
    text: callFields.kind === 'call'
      ? buildCallMessageText(callFields.callEvent, callFields.callMode, callFields.durationSec)
      : clean,
    imageId,
    imageMime: imageMime || undefined,
    imageBin: imageBin || undefined,
    at: nowIso(),
    status: 'sent',
    ...callFields,
  };

  conversation.messages = sortMessages([...conversation.messages, message]).slice(-MAX_MESSAGES);
  const store = rawMessagesStore(key);
  store.updatedAt = nowIso();
  durable.writeLocalJson(messagesPath(key), store);

  if (imageId && imagePayload) {
    await durable.writeRemoteBuffer(chatImagePath(imageId), imagePayload, 'chore: lưu ảnh chat ' + imageId);
  }
  await durable.writeRemoteJson(messagesPath(key), store, 'chore: cập nhật tin nhắn ' + key);

  return { message: publicMessage(message), updatedAt: store.updatedAt };
}

function touchReceipt(owner, peer, username, fields) {
  const key = safeName(owner);
  const conversation = getConversation(key, peer);
  const at = nowIso();
  let changed = false;
  fields.forEach((field) => {
    if (bumpReceipt(conversation, username, field, at)) changed = true;
  });
  if (!changed) return false;
  const store = rawMessagesStore(key);
  store.updatedAt = at;
  persistMessages(key);
  return true;
}

function markMessagesDelivered(owner, peer, username) {
  return touchReceipt(owner, peer, username, ['lastDeliveredAt']);
}

function markMessagesRead(owner, peer, username) {
  return touchReceipt(owner, peer, username, ['lastDeliveredAt', 'lastReadAt']);
}

function markMessageDeliveredById(owner, peer, messageId, recipient) {
  const conversation = getConversation(owner, peer);
  const id = String(messageId || '').trim();
  if (!id || !(conversation.messages || []).some((m) => m && m.id === id)) return false;
  return markMessagesDelivered(owner, peer, recipient);
}

/* ------------------------------------------------------------------ */
/* Chuyển dữ liệu 1 người dùng cũ sang workspace của chủ cũ             */
/* ------------------------------------------------------------------ */

async function migrateLegacyWorkspace(owner, follower) {
  const key = safeName(owner);
  const peer = safeName(follower);
  if (!key) return false;
  let migrated = false;

  if (!durable.localExists(dataPath(key))) {
    const legacy = normalizeDataStore(durable.readLocalJson(LEGACY_DATA_PATH, null))
      || normalizeDataStore(durable.readLocalJson(LEGACY_BACKUP_PATH, null))
      || normalizeDataStore(await durable.readRemoteJson(LEGACY_DATA_PATH));
    if (legacy && hasMoneyData(legacy)) {
      dataStores.set(key, legacy);
      await durable.persistJson(dataPath(key), legacy, 'chore: chuyển dữ liệu cũ sang workspace ' + key);
      console.log('Đã chuyển dữ liệu doanh thu cũ sang workspace', key);
      migrated = true;
    }
  }

  if (peer && !durable.localExists(messagesPath(key))) {
    const legacy = durable.readLocalJson(LEGACY_MESSAGES_PATH, null)
      || await durable.readRemoteJson(LEGACY_MESSAGES_PATH);
    const hasLegacy = legacy && (Array.isArray(legacy.messages) || legacy.nicknames);
    if (hasLegacy && !legacy.conversations) {
      const store = normalizeMessagesStore({
        conversations: { [peer]: { messages: legacy.messages, receipts: legacy.receipts } },
        nicknames: legacy.nicknames,
        updatedAt: legacy.updatedAt,
      });
      messageStores.set(key, store);
      await durable.persistJson(messagesPath(key), store, 'chore: chuyển tin nhắn cũ sang workspace ' + key);
      console.log('Đã chuyển tin nhắn cũ sang workspace', key);
      migrated = true;
    }
  }

  return migrated;
}

module.exports = {
  DATA_DIR: durable.DATA_DIR,
  GITHUB_TOKEN: durable.GITHUB_TOKEN,
  GITHUB_REPO: durable.GITHUB_REPO,
  GITHUB_BRANCH: durable.GITHUB_BRANCH,
  MESSAGE_TTL_MS,
  nowIso,
  hasMoneyData,
  initWorkspaceData,
  getAppStore,
  setAppStore,
  initWorkspaceMessages,
  getMessagesStore,
  getConversation,
  publicConversation,
  publicMessage,
  getStoredNicknames,
  setNickname,
  addMessage,
  markMessagesDelivered,
  markMessagesRead,
  markMessageDeliveredById,
  pruneExpiredMessages,
  resolveChatImage,
  migrateLegacyWorkspace,
};
