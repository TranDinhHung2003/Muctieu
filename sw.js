/* Service worker v11: Push hệ thống chỉ khi app ở nền / đã tắt */
const SW_VERSION = 'muctieu-sw-v11';

/** clientId → last foreground ping (ms) */
const foregroundClients = new Map();
const FOREGROUND_TTL_MS = 20000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const source = event.source;
  const clientId = source && source.id;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'APP_FOREGROUND' && clientId) {
    foregroundClients.set(clientId, Date.now());
    return;
  }

  if (data.type === 'APP_BACKGROUND' && clientId) {
    foregroundClients.delete(clientId);
    return;
  }

  if (data.type === 'APP_HEARTBEAT' && clientId) {
    foregroundClients.set(clientId, Date.now());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
  })());
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function absUrl(path) {
  try {
    return new URL(path, self.location.origin).href;
  } catch {
    return path;
  }
}

function buildPushPayload(data) {
  const title = String((data && data.title) || 'Mục tiêu chạy xe').trim() || 'Mục tiêu chạy xe';
  const body = String((data && data.body) || 'Có cập nhật mới').trim() || 'Có cập nhật mới';
  const tag = String((data && data.tag) || 'muctieu-push');
  const page = (data && data.page) || ((data && data.type) === 'chat' ? 'chat' : 'home');
  return {
    title,
    body,
    tag,
    page,
    type: (data && data.type) || 'general',
    messageId: (data && data.messageId) || null,
    from: (data && data.from) || null,
    fromName: (data && data.fromName) || null,
    text: (data && data.text) || null,
    imageId: (data && data.imageId) || null,
    at: (data && data.at) || null,
  };
}

function pruneForegroundMap() {
  const now = Date.now();
  foregroundClients.forEach((ts, id) => {
    if (now - ts > FOREGROUND_TTL_MS) foregroundClients.delete(id);
  });
}

async function isAppInForeground() {
  pruneForegroundMap();
  try {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Không còn cửa sổ nào → app đã tắt
    if (!allClients.length) return false;

    for (const client of allClients) {
      if (!client) continue;
      // Tab/app đang hiện hoặc đang focus
      if (client.visibilityState === 'visible' || client.focused) return true;
      // Client vừa báo đang dùng app (heartbeat) — tin cậy hơn trên iOS
      const ping = foregroundClients.get(client.id);
      if (ping && Date.now() - ping <= FOREGROUND_TTL_MS) return true;
    }
  } catch { /* ignore */ }

  // Heartbeat còn sống dù matchAll lỗi
  return foregroundClients.size > 0;
}

async function notifyClients(payload) {
  try {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    allClients.forEach((client) => {
      try {
        client.postMessage({ type: 'PUSH_NOTIFY', payload });
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

async function showPushNotification(data) {
  const payload = buildPushPayload(data);

  // Luôn đồng bộ khung chat trong app (nếu còn sống)
  await notifyClients(payload);

  // Đang trong app → KHÔNG hiện thông báo đẩy lên máy
  if (await isAppInForeground()) return;

  // Ngoài màn hình chính / đã vuốt tắt → hiện 1 thông báo hệ thống
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    renotify: true,
    requireInteraction: false,
    silent: false,
    icon: absUrl('/icons/icon-192.png'),
    badge: absUrl('/icons/icon-96.png'),
    data: {
      page: payload.page,
      type: payload.type,
      messageId: payload.messageId,
      sw: SW_VERSION,
    },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      if (event.data) {
        try {
          data = event.data.json();
        } catch {
          data = { body: event.data.text() };
        }
      }
    } catch {
      data = {};
    }

    try {
      await showPushNotification(data);
    } catch (err) {
      // Chỉ fallback OS khi chắc chắn không đang trong app
      try {
        if (!(await isAppInForeground())) {
          await self.registration.showNotification('Mục tiêu chạy xe', {
            body: 'Có cập nhật mới',
            tag: 'muctieu-push-fallback',
            renotify: true,
            silent: false,
          });
        }
      } catch {
        /* ignore */
      }
    }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const keyRes = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
      if (!keyRes.ok) return;
      const keyJson = await keyRes.json();
      const publicKey = keyJson && keyJson.publicKey;
      if (!publicKey) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch {
      /* ignore */
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        if (data.page) {
          try {
            client.postMessage({ type: 'muctieu-notify-open', page: data.page });
          } catch { /* ignore */ }
        }
        return;
      }
    }
    if (clients.openWindow) {
      const url = data.page === 'chat' ? '/?open=chat' : '/';
      await clients.openWindow(url);
    }
  })());
});
