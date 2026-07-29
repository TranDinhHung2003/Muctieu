/* Service worker v15: Cuộc gọi luôn hiện thông báo khi app nền/tắt màn */
const SW_VERSION = 'muctieu-sw-v15';
const FOREGROUND_CACHE = 'muctieu-runtime-v1';
const FOREGROUND_URL = '/__muctieu_foreground';
const FOREGROUND_TTL_MS = 25000;

/** clientId → last ping (bổ sung cho Cache) */
const foregroundClients = new Map();

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

  if (data.type === 'APP_FOREGROUND' || data.type === 'APP_HEARTBEAT') {
    if (clientId) foregroundClients.set(clientId, Date.now());
    event.waitUntil(writeForegroundFlag(true));
    return;
  }

  if (data.type === 'APP_BACKGROUND') {
    if (clientId) foregroundClients.delete(clientId);
    event.waitUntil((async () => {
      // Chỉ xóa flag nếu không còn client nào đang foreground
      pruneForegroundMap();
      const still = await hasLiveForegroundClient();
      if (!still) await writeForegroundFlag(false);
    })());
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
    callId: (data && data.callId) || null,
    mode: (data && data.mode) || null,
  };
}

function pruneForegroundMap() {
  const now = Date.now();
  foregroundClients.forEach((ts, id) => {
    if (now - ts > FOREGROUND_TTL_MS) foregroundClients.delete(id);
  });
}

async function writeForegroundFlag(active) {
  try {
    const cache = await caches.open(FOREGROUND_CACHE);
    if (active) {
      await cache.put(
        FOREGROUND_URL,
        new Response(String(Date.now()), {
          headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
        })
      );
    } else {
      await cache.delete(FOREGROUND_URL);
    }
  } catch { /* ignore */ }
}

async function readForegroundFlag() {
  try {
    const cache = await caches.open(FOREGROUND_CACHE);
    const res = await cache.match(FOREGROUND_URL);
    if (!res) return false;
    const ts = Number(await res.text());
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts <= FOREGROUND_TTL_MS;
  } catch {
    return false;
  }
}

async function hasLiveForegroundClient() {
  pruneForegroundMap();
  try {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if (!client) continue;
      if (client.visibilityState === 'visible' || client.focused) return true;
      const ping = foregroundClients.get(client.id);
      if (ping && Date.now() - ping <= FOREGROUND_TTL_MS) return true;
    }
  } catch { /* ignore */ }
  return foregroundClients.size > 0;
}

async function isAppInForeground() {
  if (await readForegroundFlag()) return true;
  return hasLiveForegroundClient();
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

async function clearNotificationsWithTag(tag) {
  try {
    const list = await self.registration.getNotifications(tag ? { tag } : {});
    list.forEach((n) => {
      try { n.close(); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

async function showPushNotification(data) {
  const payload = buildPushPayload(data);

  // Đồng bộ khung chat / cuộc gọi nếu app còn sống
  await notifyClients(payload);

  const isCall = payload.type === 'call';

  // Chat thường: đang trong app → không hiện OS notify
  // Cuộc gọi: LUÔN hiện OS notify khi không chắc app đang mở (iOS tắt màn vẫn coi foreground)
  if (!isCall && (await isAppInForeground())) {
    await clearNotificationsWithTag(payload.tag);
    return;
  }

  // Nếu cuộc gọi mà app đang thật sự visible trên 1 client → vẫn postMessage (đã làm),
  // và vẫn hiện notify ngắn để chắc chắn user thấy khi màn hình khóa.
  const notifData = {
    page: isCall ? 'chat' : payload.page,
    type: payload.type,
    messageId: payload.messageId,
    callId: payload.callId,
    mode: payload.mode,
    from: payload.from,
    fromName: payload.fromName,
    sw: SW_VERSION,
  };

  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag || (isCall ? 'muctieu-call' : 'muctieu-push'),
    renotify: true,
    requireInteraction: isCall,
    silent: false,
    vibrate: isCall ? [250, 120, 250, 120, 400] : undefined,
    icon: absUrl('/icons/icon-192.png'),
    badge: absUrl('/icons/icon-96.png'),
    data: notifData,
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
    } catch {
      try {
        if (!(await isAppInForeground())) {
          await self.registration.showNotification('Mục tiêu chạy xe', {
            body: 'Có cập nhật mới',
            tag: 'muctieu-push-fallback',
            renotify: true,
            silent: false,
          });
        }
      } catch { /* ignore */ }
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
    } catch { /* ignore */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const openPayload = {
      type: 'muctieu-notify-open',
      page: data.page || (data.type === 'call' ? 'chat' : 'home'),
      call: data.type === 'call' ? {
        type: 'call',
        callId: data.callId,
        mode: data.mode,
        from: data.from,
        fromName: data.fromName,
      } : null,
    };
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        try {
          client.postMessage(openPayload);
        } catch { /* ignore */ }
        return;
      }
    }
    if (clients.openWindow) {
      const url = (data.type === 'call' || data.page === 'chat')
        ? '/?open=chat&call=1'
        : '/';
      await clients.openWindow(url);
    }
  })());
});
