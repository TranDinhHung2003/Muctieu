const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');
const SUBS_PATH = path.join(DATA_DIR, 'push-subscriptions.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
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
  ensureDataDir();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadVapid() {
  ensureDataDir();
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT || 'mailto:admin@muctieu.local',
    };
  }
  const existing = readJson(VAPID_PATH, null);
  if (existing && existing.publicKey && existing.privateKey) {
    return {
      publicKey: existing.publicKey,
      privateKey: existing.privateKey,
      subject: existing.subject || 'mailto:admin@muctieu.local',
    };
  }
  const generated = webpush.generateVAPIDKeys();
  const vapid = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: 'mailto:admin@muctieu.local',
  };
  writeJson(VAPID_PATH, vapid);
  return vapid;
}

const vapid = loadVapid();
webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

function emptySubs() {
  return { users: {} };
}

function loadSubs() {
  const raw = readJson(SUBS_PATH, emptySubs());
  if (!raw || typeof raw !== 'object') return emptySubs();
  if (!raw.users || typeof raw.users !== 'object') return { users: {} };
  return raw;
}

function saveSubs(store) {
  writeJson(SUBS_PATH, store);
}

function normalizeSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = String(sub.endpoint || '').trim();
  const p256dh = sub.keys && sub.keys.p256dh ? String(sub.keys.p256dh) : '';
  const auth = sub.keys && sub.keys.auth ? String(sub.keys.auth) : '';
  if (!endpoint || !p256dh || !auth) return null;
  return {
    endpoint,
    keys: { p256dh, auth },
  };
}

function saveSubscription(username, subscription) {
  const user = String(username || '').trim();
  const sub = normalizeSubscription(subscription);
  if (!user || !sub) return false;
  const store = loadSubs();
  const list = Array.isArray(store.users[user]) ? store.users[user] : [];
  const next = list.filter((item) => item && item.endpoint !== sub.endpoint);
  next.push(Object.assign({}, sub, { updatedAt: new Date().toISOString() }));
  store.users[user] = next.slice(-8);
  saveSubs(store);
  return true;
}

function removeSubscription(username, endpoint) {
  const user = String(username || '').trim();
  const ep = String(endpoint || '').trim();
  if (!user || !ep) return false;
  const store = loadSubs();
  const list = Array.isArray(store.users[user]) ? store.users[user] : [];
  const next = list.filter((item) => item && item.endpoint !== ep);
  if (next.length === list.length) return false;
  store.users[user] = next;
  saveSubs(store);
  return true;
}

function listOtherUsernames(allUsernames, exceptUsername) {
  const except = String(exceptUsername || '').toLowerCase();
  return (allUsernames || []).filter((u) => String(u || '').toLowerCase() !== except);
}

async function sendToSubscription(sub, payload) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 60 * 60,
      urgency: 'high',
    });
    return { ok: true };
  } catch (err) {
    const status = err && (err.statusCode || err.status);
    return { ok: false, status, endpoint: sub && sub.endpoint };
  }
}

async function sendPushToUsernames(usernames, payload) {
  const store = loadSubs();
  const targets = Array.from(new Set((usernames || []).map((u) => String(u || '').trim()).filter(Boolean)));
  const dead = [];
  const jobs = [];

  targets.forEach((username) => {
    const list = Array.isArray(store.users[username]) ? store.users[username] : [];
    list.forEach((sub) => {
      if (!sub || !sub.endpoint) return;
      jobs.push(
        sendToSubscription(sub, payload).then((result) => {
          if (!result.ok && (result.status === 404 || result.status === 410)) {
            dead.push({ username, endpoint: result.endpoint });
          }
        })
      );
    });
  });

  await Promise.all(jobs);

  if (dead.length) {
    dead.forEach(({ username, endpoint }) => {
      const list = Array.isArray(store.users[username]) ? store.users[username] : [];
      store.users[username] = list.filter((item) => item && item.endpoint !== endpoint);
    });
    saveSubs(store);
  }
}

function getPublicKey() {
  return vapid.publicKey;
}

module.exports = {
  getPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushToUsernames,
  listOtherUsernames,
};
