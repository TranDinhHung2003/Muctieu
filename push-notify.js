const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');
const SUBS_PATH = path.join(DATA_DIR, 'push-subscriptions.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'TranDinhHung2003/Muctieu';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'cursor/muc-tieu-chay-xe-becf';
const GITHUB_VAPID_PATH = process.env.GITHUB_VAPID_PATH || 'data/vapid.json';
const GITHUB_PUSH_PATH = process.env.GITHUB_PUSH_PATH || 'data/push-subscriptions.json';

let vapid = null;
let memorySubs = null;
const vapidShaRef = { sha: null };
const subsShaRef = { sha: null };
let saveSubsTimer = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
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
  ensureDataDir();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
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

async function loadGithubJson(filePath, shaRef) {
  if (!GITHUB_TOKEN) return null;
  try {
    const encPath = filePath.split('/').map(encodeURIComponent).join('/');
    const info = await githubRequest(
      '/repos/' + GITHUB_REPO + '/contents/' + encPath + '?ref=' + encodeURIComponent(GITHUB_BRANCH)
    );
    if (!info || info.notFound || !info.content) return null;
    if (shaRef) shaRef.sha = info.sha || null;
    const decoded = Buffer.from(info.content, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (err) {
    console.warn('Không tải được', filePath, 'từ GitHub:', err.message);
    return null;
  }
}

async function saveGithubJson(filePath, data, shaRef, message) {
  if (!GITHUB_TOKEN) return false;
  try {
    const encPath = filePath.split('/').map(encodeURIComponent).join('/');
    if (!shaRef.sha) {
      const info = await githubRequest(
        '/repos/' + GITHUB_REPO + '/contents/' + encPath + '?ref=' + encodeURIComponent(GITHUB_BRANCH)
      );
      if (info && !info.notFound && info.sha) shaRef.sha = info.sha;
    }
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
    const body = {
      message: message || ('chore: cập nhật ' + filePath),
      content,
      branch: GITHUB_BRANCH,
    };
    if (shaRef.sha) body.sha = shaRef.sha;
    const result = await githubRequest(
      '/repos/' + GITHUB_REPO + '/contents/' + encPath,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    if (result && result.content && result.content.sha) {
      shaRef.sha = result.content.sha;
    }
    return true;
  } catch (err) {
    console.warn('Không lưu được', filePath, 'lên GitHub:', err.message);
    return false;
  }
}

function emptySubs() {
  return { users: {}, updatedAt: nowIso() };
}

function normalizeVapidSubject(subject) {
  const fallback = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const s = String(subject || '').trim();
  if (!s) return fallback;
  // Apple từ chối @localhost / *.local → BadJwtToken
  if (/@localhost\b/i.test(s) || /\.local\b/i.test(s) || !/^(mailto:|https:\/\/)/i.test(s)) {
    return fallback;
  }
  return s;
}

function normalizeVapid(raw) {
  if (!raw || !raw.publicKey || !raw.privateKey) return null;
  return {
    publicKey: String(raw.publicKey),
    privateKey: String(raw.privateKey),
    subject: normalizeVapidSubject(raw.subject),
  };
}

async function resolveVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: normalizeVapidSubject(process.env.VAPID_SUBJECT || 'mailto:admin@example.com'),
    };
  }

  const rawGithub = await loadGithubJson(GITHUB_VAPID_PATH, vapidShaRef);
  const fromGithub = normalizeVapid(rawGithub);
  if (fromGithub) {
    writeJson(VAPID_PATH, fromGithub);
    const rawSubject = rawGithub && rawGithub.subject != null ? String(rawGithub.subject) : '';
    if (rawSubject !== fromGithub.subject) {
      await saveGithubJson(GITHUB_VAPID_PATH, fromGithub, vapidShaRef, 'fix: VAPID subject hợp lệ cho Apple/iOS');
      console.log('Đã sửa VAPID subject →', fromGithub.subject);
    }
    return fromGithub;
  }

  const fromDisk = normalizeVapid(readJson(VAPID_PATH, null));
  if (fromDisk) {
    await saveGithubJson(GITHUB_VAPID_PATH, fromDisk, vapidShaRef, 'chore: lưu khóa Web Push bền');
    return fromDisk;
  }

  const generated = webpush.generateVAPIDKeys();
  const created = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: normalizeVapidSubject('mailto:admin@example.com'),
  };
  writeJson(VAPID_PATH, created);
  await saveGithubJson(GITHUB_VAPID_PATH, created, vapidShaRef, 'chore: tạo khóa Web Push bền');
  console.log('Đã tạo VAPID mới (lưu bền GitHub/disk). Các máy cần mở app lại để đăng ký push.');
  return created;
}

async function resolveSubs() {
  const fromGithub = await loadGithubJson(GITHUB_PUSH_PATH, subsShaRef);
  if (fromGithub && fromGithub.users && typeof fromGithub.users === 'object') {
    writeJson(SUBS_PATH, fromGithub);
    return fromGithub;
  }
  const fromDisk = readJson(SUBS_PATH, null);
  if (fromDisk && fromDisk.users) {
    await saveGithubJson(GITHUB_PUSH_PATH, fromDisk, subsShaRef, 'chore: lưu đăng ký Web Push bền');
    return fromDisk;
  }
  return emptySubs();
}

async function init() {
  ensureDataDir();
  vapid = await resolveVapid();
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  memorySubs = await resolveSubs();
  const userCount = Object.keys(memorySubs.users || {}).length;
  const subCount = Object.values(memorySubs.users || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  console.log('Web Push sẵn sàng · users=', userCount, '· subscriptions=', subCount);
  return vapid;
}

function getSubsStore() {
  if (!memorySubs) memorySubs = readJson(SUBS_PATH, emptySubs());
  return memorySubs;
}

function persistSubsSoon() {
  const store = getSubsStore();
  store.updatedAt = nowIso();
  writeJson(SUBS_PATH, store);
  if (saveSubsTimer) clearTimeout(saveSubsTimer);
  saveSubsTimer = setTimeout(() => {
    saveGithubJson(
      GITHUB_PUSH_PATH,
      store,
      subsShaRef,
      'chore: cập nhật đăng ký Web Push'
    ).then((ok) => {
      if (ok) console.log('Đã lưu đăng ký Web Push lên GitHub');
    }).catch(() => {});
  }, 400);
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
  const store = getSubsStore();
  if (!store.users || typeof store.users !== 'object') store.users = {};
  const list = Array.isArray(store.users[user]) ? store.users[user] : [];
  const next = list.filter((item) => item && item.endpoint !== sub.endpoint);
  next.push(Object.assign({}, sub, { updatedAt: nowIso() }));
  store.users[user] = next.slice(-8);
  memorySubs = store;
  persistSubsSoon();
  return true;
}

function removeSubscription(username, endpoint) {
  const user = String(username || '').trim();
  const ep = String(endpoint || '').trim();
  if (!user || !ep) return false;
  const store = getSubsStore();
  const list = Array.isArray(store.users[user]) ? store.users[user] : [];
  const next = list.filter((item) => item && item.endpoint !== ep);
  if (next.length === list.length) return false;
  store.users[user] = next;
  memorySubs = store;
  persistSubsSoon();
  return true;
}

function listOtherUsernames(allUsernames, exceptUsername) {
  const except = String(exceptUsername || '').toLowerCase();
  return (allUsernames || []).filter((u) => String(u || '').toLowerCase() !== except);
}

async function sendToSubscription(sub, payload) {
  try {
    if (!vapid) await init();
    // Luôn gắn lại subject hợp lệ trước khi gửi (tránh BadJwtToken trên Apple)
    webpush.setVapidDetails(
      normalizeVapidSubject(vapid.subject),
      vapid.publicKey,
      vapid.privateKey
    );
    const isApple = sub && String(sub.endpoint || '').includes('web.push.apple.com');
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
      },
      JSON.stringify(payload),
      {
        TTL: isApple ? 60 * 60 * 24 : 60 * 60 * 12,
        urgency: 'high',
      }
    );
    return { ok: true };
  } catch (err) {
    const status = err && (err.statusCode || err.status);
    const body = err && err.body ? String(err.body).slice(0, 180) : '';
    console.warn('Push lỗi', status || '', body || (err && err.message) || '');
    return { ok: false, status, endpoint: sub && sub.endpoint, error: body || (err && err.message) || '' };
  }
}

function reloadSubsFromDisk() {
  const fromDisk = readJson(SUBS_PATH, null);
  if (fromDisk && fromDisk.users && typeof fromDisk.users === 'object') {
    memorySubs = fromDisk;
  }
  return getSubsStore();
}

let lastPushTest = null;

function getLastPushTest() {
  return lastPushTest;
}

function setLastPushTest(info) {
  lastPushTest = Object.assign({ at: nowIso() }, info || {});
  try {
    writeJson(path.join(DATA_DIR, 'push-last-test.json'), lastPushTest);
  } catch { /* ignore */ }
  return lastPushTest;
}

async function sendPushToUsernames(usernames, payload) {
  if (!vapid) await init();
  reloadSubsFromDisk();
  const store = getSubsStore();
  const targets = Array.from(new Set((usernames || []).map((u) => String(u || '').trim()).filter(Boolean)));
  const dead = [];
  const errors = [];
  const jobs = [];
  let attempted = 0;

  targets.forEach((username) => {
    const list = Array.isArray(store.users[username]) ? store.users[username] : [];
    list.forEach((sub) => {
      if (!sub || !sub.endpoint) return;
      attempted += 1;
      jobs.push(
        sendToSubscription(sub, payload).then((result) => {
          if (!result.ok) {
            errors.push({ username, status: result.status, error: result.error || '' });
            if (result.status === 404 || result.status === 410) {
              dead.push({ username, endpoint: result.endpoint });
            }
          }
          return result.ok;
        })
      );
    });
  });

  if (!attempted) {
    console.warn('Push: không có subscription cho', targets.join(', ') || '(trống)');
    return { attempted: 0, sent: 0, errors: [{ error: 'no-subscription' }] };
  }

  const results = await Promise.all(jobs);
  const sent = results.filter(Boolean).length;

  if (dead.length) {
    dead.forEach(({ username, endpoint }) => {
      const list = Array.isArray(store.users[username]) ? store.users[username] : [];
      store.users[username] = list.filter((item) => item && item.endpoint !== endpoint);
    });
    memorySubs = store;
    persistSubsSoon();
  }

  console.log('Push gửi', sent + '/' + attempted, '·', payload && payload.type ? payload.type : 'notify');
  return { attempted, sent, errors };
}

function getPublicKey() {
  if (!vapid) {
    const disk = normalizeVapid(readJson(VAPID_PATH, null));
    if (disk) {
      vapid = disk;
      try { webpush.setVapidDetails(disk.subject, disk.publicKey, disk.privateKey); } catch { /* ignore */ }
    }
  }
  return vapid ? vapid.publicKey : '';
}

function getStats() {
  const store = getSubsStore();
  const users = Object.keys(store.users || {});
  const count = users.reduce((n, u) => n + (Array.isArray(store.users[u]) ? store.users[u].length : 0), 0);
  return { users: users.length, subscriptions: count };
}

module.exports = {
  init,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushToUsernames,
  listOtherUsernames,
  getStats,
  getLastPushTest,
  setLastPushTest,
  reloadSubsFromDisk,
};
