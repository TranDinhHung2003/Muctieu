/**
 * Lớp lưu trữ bền dùng chung: ghi ra đĩa (nhanh) + mirror lên GitHub (không mất khi Render restart).
 *
 * Mọi store đều dùng "đường dẫn logic" tương đối, ví dụ `workspaces/hung/app-data.json`:
 *   - trên đĩa  → <DATA_DIR>/workspaces/hung/app-data.json
 *   - trên GitHub → <GITHUB_DATA_ROOT>/workspaces/hung/app-data.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'TranDinhHung2003/Muctieu';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'cursor/muc-tieu-chay-xe-becf';
const GITHUB_DATA_ROOT = String(process.env.GITHUB_DATA_ROOT || 'data').replace(/^\/+|\/+$/g, '');

/** sha của từng file trên GitHub — bắt buộc phải gửi kèm khi PUT/DELETE */
const shaCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function localPath(logicalPath) {
  return path.join(DATA_DIR, logicalPath);
}

function remotePath(logicalPath) {
  return (GITHUB_DATA_ROOT ? GITHUB_DATA_ROOT + '/' : '') + String(logicalPath).replace(/^\/+/, '');
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLocalJson(logicalPath, fallback = null) {
  try {
    const file = localPath(logicalPath);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeLocalJson(logicalPath, data) {
  const file = localPath(logicalPath);
  ensureDirFor(file);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readLocalBuffer(logicalPath) {
  try {
    const file = localPath(logicalPath);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function writeLocalBuffer(logicalPath, buffer) {
  const file = localPath(logicalPath);
  ensureDirFor(file);
  fs.writeFileSync(file, buffer);
}

function removeLocal(logicalPath) {
  try {
    const file = localPath(logicalPath);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* ignore */ }
}

function localExists(logicalPath) {
  try {
    return fs.existsSync(localPath(logicalPath));
  } catch {
    return false;
  }
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
    throw new Error((body && body.message) || ('GitHub HTTP ' + res.status));
  }
  return body;
}

function contentsUrl(logicalPath, withRef) {
  const encoded = remotePath(logicalPath).split('/').map(encodeURIComponent).join('/');
  return '/repos/' + GITHUB_REPO + '/contents/' + encoded
    + (withRef ? '?ref=' + encodeURIComponent(GITHUB_BRANCH) : '');
}

async function readRemoteRaw(logicalPath) {
  if (!GITHUB_TOKEN) return null;
  const info = await githubRequest(contentsUrl(logicalPath, true));
  if (!info || info.notFound || !info.content) return null;
  shaCache.set(logicalPath, info.sha || null);
  return Buffer.from(info.content, 'base64');
}

async function readRemoteJson(logicalPath) {
  if (!GITHUB_TOKEN) return null;
  try {
    const raw = await readRemoteRaw(logicalPath);
    if (!raw) return null;
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    console.warn('Không tải được', logicalPath, 'từ GitHub:', err.message);
    return null;
  }
}

async function readRemoteBuffer(logicalPath) {
  if (!GITHUB_TOKEN) return null;
  try {
    return await readRemoteRaw(logicalPath);
  } catch (err) {
    console.warn('Không tải được', logicalPath, 'từ GitHub:', err.message);
    return null;
  }
}

async function writeRemoteBuffer(logicalPath, buffer, message) {
  if (!GITHUB_TOKEN) return false;
  try {
    if (!shaCache.has(logicalPath) || !shaCache.get(logicalPath)) {
      const info = await githubRequest(contentsUrl(logicalPath, true));
      shaCache.set(logicalPath, info && !info.notFound && info.sha ? info.sha : null);
    }
    const body = {
      message: message || ('chore: cập nhật ' + logicalPath),
      content: Buffer.from(buffer).toString('base64'),
      branch: GITHUB_BRANCH,
    };
    const sha = shaCache.get(logicalPath);
    if (sha) body.sha = sha;
    const result = await githubRequest(contentsUrl(logicalPath, false), {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (result && result.content && result.content.sha) {
      shaCache.set(logicalPath, result.content.sha);
    }
    return true;
  } catch (err) {
    // sha cũ có thể đã lỗi thời (409) — xoá cache để lần sau lấy lại
    shaCache.delete(logicalPath);
    console.warn('Không lưu được', logicalPath, 'lên GitHub:', err.message);
    return false;
  }
}

async function writeRemoteJson(logicalPath, data, message) {
  return writeRemoteBuffer(
    logicalPath,
    Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
    message
  );
}

async function deleteRemote(logicalPath, message) {
  if (!GITHUB_TOKEN) return false;
  try {
    const info = await githubRequest(contentsUrl(logicalPath, true));
    if (!info || info.notFound || !info.sha) return false;
    await githubRequest(contentsUrl(logicalPath, false), {
      method: 'DELETE',
      body: JSON.stringify({
        message: message || ('chore: xoá ' + logicalPath),
        sha: info.sha,
        branch: GITHUB_BRANCH,
      }),
    });
    shaCache.delete(logicalPath);
    return true;
  } catch {
    return false;
  }
}

/** Ghi đĩa ngay + đẩy GitHub nền; trả về promise của lần đẩy GitHub. */
function persistJson(logicalPath, data, message) {
  writeLocalJson(logicalPath, data);
  return writeRemoteJson(logicalPath, data, message).catch(() => false);
}

module.exports = {
  DATA_DIR,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GITHUB_DATA_ROOT,
  nowIso,
  localPath,
  remotePath,
  localExists,
  readLocalJson,
  writeLocalJson,
  readLocalBuffer,
  writeLocalBuffer,
  removeLocal,
  readRemoteJson,
  writeRemoteJson,
  readRemoteBuffer,
  writeRemoteBuffer,
  deleteRemote,
  persistJson,
};
