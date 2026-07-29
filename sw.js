/* Service worker v9: Web Push — app đang mở không hiện OS notify trùng */
const SW_VERSION = 'muctieu-sw-v9';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
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

async function showPushNotification(data) {
  const title = String((data && data.title) || 'Mục tiêu chạy xe').trim() || 'Mục tiêu chạy xe';
  const body = String((data && data.body) || 'Có cập nhật mới').trim() || 'Có cập nhật mới';
  const tag = String((data && data.tag) || 'muctieu-push');
  const page = (data && data.page) || ((data && data.type) === 'chat' ? 'chat' : 'home');
  const payload = {
    title,
    body,
    tag,
    page,
    type: (data && data.type) || 'general',
  };

  // App đang mở (tab visible) → chỉ gửi banner trong app, không hiện OS lần nữa
  try {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibleClients = allClients.filter((c) => c && c.visibilityState === 'visible');
    if (visibleClients.length) {
      visibleClients.forEach((client) => {
        try {
          client.postMessage({ type: 'PUSH_NOTIFY', payload });
        } catch { /* ignore */ }
      });
      return;
    }
  } catch { /* fall through → hiện OS */ }

  // App đã vuốt tắt / ở nền → hiện thông báo hệ thống (1 lần)
  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    requireInteraction: false,
    silent: false,
    icon: absUrl('/icons/icon-192.png'),
    badge: absUrl('/icons/icon-96.png'),
    data: {
      page,
      type: payload.type,
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
      // Fallback tối giản — vẫn phải show để tránh iOS cắt subscription
      try {
        await self.registration.showNotification('Mục tiêu chạy xe', {
          body: 'Có cập nhật mới',
          tag: 'muctieu-push-fallback',
          renotify: true,
          silent: false,
        });
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
