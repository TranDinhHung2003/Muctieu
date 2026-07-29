/* Service worker v7: PWA + Web Push bền khi app đóng */
const SW_VERSION = 'muctieu-sw-v7';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }

  const title = String(data.title || 'Mục tiêu chạy xe').trim() || 'Mục tiêu chạy xe';
  const body = String(data.body || 'Có cập nhật mới').trim() || 'Có cập nhật mới';
  const tag = String(data.tag || 'muctieu-push');
  const page = data.page || (data.type === 'chat' ? 'chat' : 'home');

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction: true,
      silent: false,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      data: {
        page,
        type: data.type || 'general',
      },
      vibrate: data.type === 'chat' ? [40, 30, 40] : [50, 30, 50],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
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
