/**
 * Kiểm thử API đa tài khoản: đăng ký, dữ liệu riêng, link theo dõi, chat theo workspace.
 * Chạy: npm test
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'muctieu-test-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;
delete process.env.KEEP_ALIVE_URL;

const { app, bootstrap } = require('../server');

let baseUrl = '';
let server = null;

/** Client giữ cookie riêng cho từng tài khoản, giống một trình duyệt độc lập. */
function createClient(name) {
  let cookie = '';
  return {
    name,
    async request(method, url, { body, workspace, headers } = {}) {
      const res = await fetch(baseUrl + url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(workspace ? { 'X-Workspace': workspace } : {}),
          ...(headers || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      setCookie.forEach((raw) => {
        const pair = raw.split(';')[0];
        if (pair.startsWith('muctieu_token=')) {
          cookie = pair.endsWith('=') ? '' : pair;
        }
      });
      const text = await res.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
      return { status: res.status, body: payload, contentType: res.headers.get('content-type') || '' };
    },
    get(url, options) { return this.request('GET', url, options); },
    post(url, body, options) { return this.request('POST', url, { ...options, body }); },
    put(url, body, options) { return this.request('PUT', url, { ...options, body }); },
    del(url, options) { return this.request('DELETE', url, options); },
  };
}

function dayPayload(amount) {
  return {
    days: {
      '2026-09-01': {
        app: amount, outside: 0, zoomPoints: 0, highway: 0, tip: 0, entries: [],
      },
    },
    dailyGoal: 1200000,
  };
}

test.before(async () => {
  await bootstrap();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

test('đăng ký tài khoản mới và tự đăng nhập', async () => {
  const hung = createClient('hung');
  const res = await hung.post('/api/register', {
    username: 'hung', password: 'matkhau123', displayName: 'Hùng Tài Xế',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'hung');
  assert.equal(res.body.displayName, 'Hùng Tài Xế');
  assert.ok(res.body.shareToken, 'tài khoản mới phải có mã theo dõi riêng');
  assert.match(res.body.shareUrl, /\/t\/[A-Za-z0-9_-]+$/);

  const me = await hung.get('/api/me');
  assert.equal(me.body.loggedIn, true);
  assert.equal(me.body.username, 'hung');
});

test('từ chối tên đăng nhập trùng, tên sai định dạng và mật khẩu ngắn', async () => {
  const guest = createClient('guest');
  const duplicate = await guest.post('/api/register', { username: 'hung', password: 'matkhau123' });
  assert.equal(duplicate.status, 409);

  const badName = await guest.post('/api/register', { username: 'A b!', password: 'matkhau123' });
  assert.equal(badName.status, 400);

  const shortPassword = await guest.post('/api/register', { username: 'ngan', password: '123' });
  assert.equal(shortPassword.status, 400);

  const mismatch = await guest.post('/api/register', {
    username: 'lechpha', password: 'matkhau123', confirmPassword: 'khac123456',
  });
  assert.equal(mismatch.status, 400);
});

test('mỗi tài khoản có dữ liệu riêng, không thấy của nhau', async () => {
  const hung = createClient('hung');
  await hung.post('/api/login', { username: 'hung', password: 'matkhau123' });
  const mai = createClient('mai');
  await mai.post('/api/register', { username: 'mai', password: 'matkhau123', displayName: 'Mai' });

  await hung.put('/api/data', { data: dayPayload(500000) });
  await mai.put('/api/data', { data: dayPayload(120000) });

  const hungData = await hung.get('/api/data');
  const maiData = await mai.get('/api/data');
  assert.equal(hungData.body.data.days['2026-09-01'].app, 500000);
  assert.equal(maiData.body.data.days['2026-09-01'].app, 120000);
  assert.equal(hungData.body.role, 'owner');
});

test('không theo dõi thì không đọc được workspace của người khác', async () => {
  const mai = createClient('mai');
  await mai.post('/api/login', { username: 'mai', password: 'matkhau123' });
  const denied = await mai.get('/api/data', { workspace: 'hung' });
  assert.equal(denied.status, 403);
});

test('link theo dõi: xem trước chủ tài khoản mà không cần đăng nhập', async () => {
  const hung = createClient('hung');
  const me = (await hung.post('/api/login', { username: 'hung', password: 'matkhau123' })).body;

  const anonymous = createClient('anonymous');
  const info = await anonymous.get('/api/follow/info?token=' + encodeURIComponent(me.shareToken));
  assert.equal(info.status, 200);
  assert.equal(info.body.owner.username, 'hung');
  assert.equal(info.body.loggedIn, false);

  const bad = await anonymous.get('/api/follow/info?token=khong-ton-tai');
  assert.equal(bad.status, 404);
});

test('người theo dõi qua link chỉ được xem, không được sửa', async () => {
  const hung = createClient('hung');
  const token = (await hung.post('/api/login', { username: 'hung', password: 'matkhau123' })).body.shareToken;

  const mai = createClient('mai');
  await mai.post('/api/login', { username: 'mai', password: 'matkhau123' });
  const follow = await mai.post('/api/follow', { token });
  assert.equal(follow.status, 200);
  assert.equal(follow.body.owner.username, 'hung');

  const view = await mai.get('/api/data', { workspace: 'hung' });
  assert.equal(view.status, 200);
  assert.equal(view.body.role, 'follower');
  assert.equal(view.body.data.days['2026-09-01'].app, 500000);

  const write = await mai.put('/api/data', { data: dayPayload(999) }, { workspace: 'hung' });
  assert.equal(write.status, 403);

  // Dữ liệu riêng của Mai không bị đụng tới
  const own = await mai.get('/api/data');
  assert.equal(own.body.data.days['2026-09-01'].app, 120000);

  const workspaces = (await mai.get('/api/me')).body.workspaces;
  assert.deepEqual(workspaces.map((w) => w.owner + ':' + w.role), ['mai:owner', 'hung:follower']);
});

test('đăng ký thẳng từ link theo dõi thì tự thành người theo dõi', async () => {
  const hung = createClient('hung');
  const token = (await hung.post('/api/login', { username: 'hung', password: 'matkhau123' })).body.shareToken;

  const nam = createClient('nam');
  const res = await nam.post('/api/register', {
    username: 'nam', password: 'matkhau123', displayName: 'Nam', followToken: token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.followed.username, 'hung');

  const view = await nam.get('/api/data', { workspace: 'hung' });
  assert.equal(view.status, 200);
  assert.equal(view.body.data.days['2026-09-01'].app, 500000);

  const followers = (await hung.get('/api/me')).body.followers.map((f) => f.username);
  assert.deepEqual(followers.sort(), ['mai', 'nam']);
});

test('chat tách riêng theo từng cặp chủ ↔ người theo dõi', async () => {
  const hung = createClient('hung');
  await hung.post('/api/login', { username: 'hung', password: 'matkhau123' });
  const mai = createClient('mai');
  await mai.post('/api/login', { username: 'mai', password: 'matkhau123' });
  const nam = createClient('nam');
  await nam.post('/api/login', { username: 'nam', password: 'matkhau123' });

  const sent = await hung.post('/api/messages', { text: 'Chào Mai nhé', peer: 'mai' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.text, 'Chào Mai nhé');

  const maiInbox = await mai.get('/api/messages', { workspace: 'hung' });
  assert.deepEqual(maiInbox.body.messages.map((m) => m.text), ['Chào Mai nhé']);

  // Nam cũng theo dõi Hùng nhưng không được đọc hội thoại của Mai
  const namInbox = await nam.get('/api/messages', { workspace: 'hung' });
  assert.deepEqual(namInbox.body.messages, []);

  const reply = await mai.post('/api/messages', { text: 'Ok anh' }, { workspace: 'hung' });
  assert.equal(reply.status, 200);
  const hungInbox = await hung.get('/api/messages?peer=mai');
  assert.deepEqual(hungInbox.body.messages.map((m) => m.text), ['Chào Mai nhé', 'Ok anh']);

  // Đọc tin → phía gửi thấy trạng thái "đã đọc"
  await mai.post('/api/messages/read', {}, { workspace: 'hung' });
  const afterRead = await hung.get('/api/messages?peer=mai');
  assert.equal(afterRead.body.messages[0].status, 'read');
});

test('biệt danh đặt trong workspace nào chỉ áp dụng cho workspace đó', async () => {
  const hung = createClient('hung');
  await hung.post('/api/login', { username: 'hung', password: 'matkhau123' });
  const res = await hung.post('/api/nickname', { username: 'mai', nickname: 'Mẹ Cá' });
  assert.equal(res.status, 200);
  assert.equal(res.body.nicknames.mai, 'Mẹ Cá');
  assert.equal(res.body.nicknames.hung, 'Bạn');

  const mai = createClient('mai');
  await mai.post('/api/login', { username: 'mai', password: 'matkhau123' });
  const maiOwn = await mai.get('/api/messages');
  assert.notEqual(maiOwn.body.nicknames.mai, 'Mẹ Cá', 'workspace riêng của Mai không dính biệt danh');
});

test('đổi link theo dõi làm mã cũ hết hiệu lực', async () => {
  const hung = createClient('hung');
  const before = (await hung.post('/api/login', { username: 'hung', password: 'matkhau123' })).body.shareToken;
  const rotated = await hung.post('/api/share/rotate', {});
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.shareToken, before);

  const anonymous = createClient('anonymous');
  assert.equal((await anonymous.get('/api/follow/info?token=' + before)).status, 404);
  assert.equal((await anonymous.get('/api/follow/info?token=' + rotated.body.shareToken)).status, 200);
});

test('chủ tài khoản gỡ được người theo dõi', async () => {
  const hung = createClient('hung');
  await hung.post('/api/login', { username: 'hung', password: 'matkhau123' });
  const res = await hung.del('/api/followers/nam');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.followers.map((f) => f.username), ['mai']);

  const nam = createClient('nam');
  await nam.post('/api/login', { username: 'nam', password: 'matkhau123' });
  assert.equal((await nam.get('/api/data', { workspace: 'hung' })).status, 403);
});

test('người theo dõi tự bỏ theo dõi được', async () => {
  const mai = createClient('mai');
  await mai.post('/api/login', { username: 'mai', password: 'matkhau123' });
  assert.equal((await mai.del('/api/follow/hung')).status, 200);
  assert.equal((await mai.get('/api/data', { workspace: 'hung' })).status, 403);
});

test('đổi mật khẩu rồi đăng nhập bằng mật khẩu mới', async () => {
  const nam = createClient('nam');
  await nam.post('/api/login', { username: 'nam', password: 'matkhau123' });
  const wrong = await nam.post('/api/change-password', {
    currentPassword: 'sai-roi', newPassword: 'matkhaumoi1',
  });
  assert.equal(wrong.status, 401);

  const ok = await nam.post('/api/change-password', {
    currentPassword: 'matkhau123', newPassword: 'matkhaumoi1',
  });
  assert.equal(ok.status, 200);

  const fresh = createClient('nam2');
  assert.equal((await fresh.post('/api/login', { username: 'nam', password: 'matkhau123' })).status, 401);
  assert.equal((await fresh.post('/api/login', { username: 'nam', password: 'matkhaumoi1' })).status, 200);
});

test('API cần đăng nhập thì chặn khách vãng lai', async () => {
  const anonymous = createClient('anonymous');
  assert.equal((await anonymous.get('/api/data')).status, 401);
  assert.equal((await anonymous.get('/api/messages')).status, 401);
  assert.equal((await anonymous.post('/api/follow', { token: 'x' })).status, 401);
});

test('không lộ file dữ liệu nhạy cảm qua HTTP tĩnh', async () => {
  const anonymous = createClient('anonymous');
  for (const url of ['/data/accounts.json', '/accounts.json', '/server.js', '/package.json', '/.env']) {
    const res = await anonymous.get(url);
    assert.ok(
      !String(res.contentType).includes('json') || res.body === null || !res.body.users,
      'không được trả nội dung tài khoản tại ' + url
    );
    assert.ok(
      !(res.body && res.body.raw && String(res.body.raw).includes('passwordHash')),
      'không được lộ hash mật khẩu tại ' + url
    );
  }
});

test('đường link theo dõi trả về trang ứng dụng để client xử lý', async () => {
  const anonymous = createClient('anonymous');
  const res = await anonymous.get('/t/bat-ky-ma-nao');
  assert.equal(res.status, 200);
  assert.ok(String(res.contentType).includes('text/html'));
});
