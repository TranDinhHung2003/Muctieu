/**
 * Quản lý tài khoản đa người dùng.
 *
 * Mỗi tài khoản = 1 "không gian" (workspace) dữ liệu riêng, không ai thấy của ai.
 * Mỗi tài khoản có 1 shareToken → đường link theo dõi riêng.
 * Người mở link phải đăng ký/đăng nhập rồi mới được thêm vào danh sách theo dõi.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const durable = require('./lib/durable');

const ACCOUNTS_PATH = 'accounts.json';
const LEGACY_USERS_PATH = 'users.json';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
const RESERVED_USERNAMES = new Set([
  'api', 'sw', 'manifest', 'icons', 'data', 'static', 'assets',
  'theo-doi', 'follow', 'login', 'logout', 'register', 'null', 'undefined',
]);

const MAX_DISPLAY_NAME = 24;
const MIN_PASSWORD = 6;

let store = null;

function nowIso() {
  return durable.nowIso();
}

function emptyStore() {
  return { users: [], follows: [], updatedAt: nowIso() };
}

function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value, maxLen) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function defaultDisplayName(username) {
  const clean = cleanText(username, MAX_DISPLAY_NAME);
  if (!clean) return 'Bạn';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Lỗi có thông điệp hiển thị được cho người dùng cuối. */
class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function validateUsername(raw) {
  const username = normalizeUsername(raw);
  if (!username) throw new AccountError('Vui lòng nhập tên đăng nhập');
  if (username.length < 3) throw new AccountError('Tên đăng nhập phải có ít nhất 3 ký tự');
  if (username.length > 24) throw new AccountError('Tên đăng nhập tối đa 24 ký tự');
  if (!USERNAME_RE.test(username)) {
    throw new AccountError('Tên đăng nhập chỉ gồm chữ thường, số và . _ - (bắt đầu bằng chữ hoặc số)');
  }
  if (RESERVED_USERNAMES.has(username)) throw new AccountError('Tên đăng nhập này không được phép dùng');
  return username;
}

function validatePassword(raw) {
  const password = String(raw == null ? '' : raw);
  if (!password) throw new AccountError('Vui lòng nhập mật khẩu');
  if (password.length < MIN_PASSWORD) {
    throw new AccountError('Mật khẩu phải có ít nhất ' + MIN_PASSWORD + ' ký tự');
  }
  if (password.length > 128) throw new AccountError('Mật khẩu quá dài');
  return password;
}

function normalizeUser(raw) {
  if (!raw) return null;
  const username = normalizeUsername(raw.username);
  if (!username) return null;
  const passwordHash = String(raw.passwordHash || raw.password_hash || '');
  if (!passwordHash) return null;
  return {
    username,
    displayName: cleanText(raw.displayName || raw.nickname, MAX_DISPLAY_NAME) || defaultDisplayName(username),
    passwordHash,
    shareToken: String(raw.shareToken || '') || randomToken(),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || raw.updated_at || nowIso(),
  };
}

function normalizeFollow(raw) {
  if (!raw) return null;
  const owner = normalizeUsername(raw.owner);
  const follower = normalizeUsername(raw.follower);
  if (!owner || !follower || owner === follower) return null;
  return { owner, follower, createdAt: raw.createdAt || nowIso() };
}

function normalizeStore(raw) {
  const users = [];
  const seenUsers = new Set();
  const seenTokens = new Set();
  (Array.isArray(raw && raw.users) ? raw.users : []).forEach((item) => {
    const user = normalizeUser(item);
    if (!user || seenUsers.has(user.username)) return;
    while (seenTokens.has(user.shareToken)) user.shareToken = randomToken();
    seenUsers.add(user.username);
    seenTokens.add(user.shareToken);
    users.push(user);
  });

  const follows = [];
  const seenFollows = new Set();
  (Array.isArray(raw && raw.follows) ? raw.follows : []).forEach((item) => {
    const follow = normalizeFollow(item);
    if (!follow) return;
    const key = follow.owner + '\u0000' + follow.follower;
    if (seenFollows.has(key)) return;
    if (!seenUsers.has(follow.owner) || !seenUsers.has(follow.follower)) return;
    seenFollows.add(key);
    follows.push(follow);
  });

  return { users, follows, updatedAt: (raw && raw.updatedAt) || nowIso() };
}

function getStore() {
  if (!store) {
    store = normalizeStore(durable.readLocalJson(ACCOUNTS_PATH, emptyStore()));
  }
  return store;
}

function persist() {
  const current = getStore();
  current.updatedAt = nowIso();
  return durable.persistJson(ACCOUNTS_PATH, current, 'chore: cập nhật tài khoản');
}

/** Gộp tài khoản từ users.json cũ (admin/theodoi) sang định dạng mới. */
function migrateLegacyUsers(target) {
  const legacy = durable.readLocalJson(LEGACY_USERS_PATH, null);
  const legacyUsers = Array.isArray(legacy && legacy.users) ? legacy.users : [];
  let changed = false;
  legacyUsers.forEach((item) => {
    const username = normalizeUsername(item && item.username);
    if (!username || !(item && item.password_hash)) return;
    if (target.users.some((u) => u.username === username)) return;
    target.users.push(normalizeUser({
      username,
      displayName: item.nickname,
      passwordHash: item.password_hash,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    }));
    changed = true;
  });
  return changed;
}

async function init({ seedOwner, seedFollower } = {}) {
  const local = durable.readLocalJson(ACCOUNTS_PATH, null);
  const remote = await durable.readRemoteJson(ACCOUNTS_PATH);

  let picked = local;
  if (remote) {
    const localCount = Array.isArray(local && local.users) ? local.users.length : -1;
    const remoteCount = Array.isArray(remote.users) ? remote.users.length : -1;
    const localTime = local && local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    if (remoteCount > localCount || (remoteCount === localCount && remoteTime >= localTime)) {
      picked = remote;
      console.log('Đã tải danh sách tài khoản từ GitHub');
    }
  }

  store = normalizeStore(picked || emptyStore());
  let changed = !picked;

  if (migrateLegacyUsers(store)) {
    console.log('Đã chuyển tài khoản cũ từ users.json sang accounts.json');
    changed = true;
  }

  // Tài khoản khởi tạo từ biến môi trường (chỉ tạo khi chưa có)
  if (seedOwner && seedOwner.username && !findByUsername(seedOwner.username)) {
    createUserInternal(seedOwner);
    console.log('Đã tạo tài khoản chủ:', normalizeUsername(seedOwner.username));
    changed = true;
  }
  if (seedFollower && seedFollower.username && !findByUsername(seedFollower.username)) {
    createUserInternal(seedFollower);
    console.log('Đã tạo tài khoản theo dõi:', normalizeUsername(seedFollower.username));
    changed = true;
  }
  // Người theo dõi cũ vẫn phải nhìn thấy dữ liệu của chủ cũ sau khi lên đa tài khoản
  if (seedOwner && seedFollower) {
    const owner = normalizeUsername(seedOwner.username);
    const follower = normalizeUsername(seedFollower.username);
    if (owner && follower && owner !== follower
      && findByUsername(owner) && findByUsername(follower)
      && !isFollowing(owner, follower)) {
      store.follows.push({ owner, follower, createdAt: nowIso() });
      console.log('Đã gắn', follower, 'theo dõi', owner);
      changed = true;
    }
  }

  if (changed) await persist();
  return store;
}

function createUserInternal({ username, password, passwordHash, displayName }) {
  const user = normalizeUser({
    username: normalizeUsername(username),
    displayName,
    passwordHash: passwordHash || bcrypt.hashSync(String(password), 10),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  if (!user) throw new AccountError('Không tạo được tài khoản');
  const current = getStore();
  while (current.users.some((u) => u.shareToken === user.shareToken)) {
    user.shareToken = randomToken();
  }
  current.users.push(user);
  return user;
}

function findByUsername(username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  return getStore().users.find((u) => u.username === key) || null;
}

function findByShareToken(token) {
  const key = String(token || '').trim();
  if (!key) return null;
  return getStore().users.find((u) => u.shareToken === key) || null;
}

function listUsernames() {
  return getStore().users.map((u) => u.username);
}

async function register({ username, password, displayName }) {
  const cleanUsername = validateUsername(username);
  const cleanPassword = validatePassword(password);
  if (findByUsername(cleanUsername)) {
    throw new AccountError('Tên đăng nhập đã có người dùng, hãy chọn tên khác', 409);
  }
  const user = createUserInternal({
    username: cleanUsername,
    password: cleanPassword,
    displayName: cleanText(displayName, MAX_DISPLAY_NAME) || defaultDisplayName(cleanUsername),
  });
  await persist();
  return user;
}

function verifyPassword(user, password) {
  if (!user || !user.passwordHash) return false;
  try {
    return bcrypt.compareSync(String(password || ''), user.passwordHash);
  } catch {
    return false;
  }
}

async function changePassword(username, currentPassword, newPassword) {
  const user = findByUsername(username);
  if (!user) throw new AccountError('Không tìm thấy tài khoản', 404);
  if (!verifyPassword(user, currentPassword)) {
    throw new AccountError('Mật khẩu hiện tại không đúng', 401);
  }
  const cleanPassword = validatePassword(newPassword);
  user.passwordHash = bcrypt.hashSync(cleanPassword, 10);
  user.updatedAt = nowIso();
  await persist();
  return user;
}

async function setDisplayName(username, displayName) {
  const user = findByUsername(username);
  if (!user) throw new AccountError('Không tìm thấy tài khoản', 404);
  const clean = cleanText(displayName, MAX_DISPLAY_NAME);
  if (!clean) throw new AccountError('Tên hiển thị không được để trống');
  user.displayName = clean;
  user.updatedAt = nowIso();
  await persist();
  return user;
}

async function rotateShareToken(username) {
  const user = findByUsername(username);
  if (!user) throw new AccountError('Không tìm thấy tài khoản', 404);
  const current = getStore();
  let token = randomToken();
  while (current.users.some((u) => u.shareToken === token)) token = randomToken();
  user.shareToken = token;
  user.updatedAt = nowIso();
  await persist();
  return user;
}

function isFollowing(owner, follower) {
  const o = normalizeUsername(owner);
  const f = normalizeUsername(follower);
  return getStore().follows.some((item) => item.owner === o && item.follower === f);
}

async function addFollow(owner, follower) {
  const o = normalizeUsername(owner);
  const f = normalizeUsername(follower);
  if (!o || !f) throw new AccountError('Thiếu thông tin theo dõi');
  if (o === f) throw new AccountError('Bạn không cần theo dõi chính mình');
  if (!findByUsername(o)) throw new AccountError('Không tìm thấy tài khoản cần theo dõi', 404);
  if (!findByUsername(f)) throw new AccountError('Không tìm thấy tài khoản của bạn', 404);
  if (isFollowing(o, f)) return false;
  getStore().follows.push({ owner: o, follower: f, createdAt: nowIso() });
  await persist();
  return true;
}

async function removeFollow(owner, follower) {
  const o = normalizeUsername(owner);
  const f = normalizeUsername(follower);
  const current = getStore();
  const before = current.follows.length;
  current.follows = current.follows.filter((item) => !(item.owner === o && item.follower === f));
  if (current.follows.length === before) return false;
  await persist();
  return true;
}

/** Những người đang theo dõi workspace của `owner`. */
function listFollowers(owner) {
  const o = normalizeUsername(owner);
  return getStore().follows
    .filter((item) => item.owner === o)
    .map((item) => {
      const user = findByUsername(item.follower);
      return {
        username: item.follower,
        displayName: user ? user.displayName : item.follower,
        since: item.createdAt,
      };
    });
}

/** Những workspace mà `follower` đang theo dõi. */
function listFollowing(follower) {
  const f = normalizeUsername(follower);
  return getStore().follows
    .filter((item) => item.follower === f)
    .map((item) => {
      const user = findByUsername(item.owner);
      return {
        username: item.owner,
        displayName: user ? user.displayName : item.owner,
        since: item.createdAt,
      };
    });
}

/** Tất cả tài khoản có quyền vào workspace của `owner` (chủ + người theo dõi). */
function listWorkspaceMembers(owner) {
  const o = normalizeUsername(owner);
  return [o, ...listFollowers(o).map((item) => item.username)];
}

function accessRole(owner, username) {
  const o = normalizeUsername(owner);
  const u = normalizeUsername(username);
  if (!o || !u) return null;
  if (o === u) return 'owner';
  if (isFollowing(o, u)) return 'follower';
  return null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    displayName: user.displayName,
  };
}

module.exports = {
  AccountError,
  MIN_PASSWORD,
  init,
  getStore,
  normalizeUsername,
  validateUsername,
  validatePassword,
  cleanText,
  defaultDisplayName,
  findByUsername,
  findByShareToken,
  listUsernames,
  register,
  verifyPassword,
  changePassword,
  setDisplayName,
  rotateShareToken,
  isFollowing,
  addFollow,
  removeFollow,
  listFollowers,
  listFollowing,
  listWorkspaceMembers,
  accessRole,
  publicUser,
};
