/* Service worker v4: icon cá mập */
const SW_VERSION = 'muctieu-sw-v4';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
  })());
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  // Không tự đóng — người dùng tự xóa trên thanh thông báo
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
      await clients.openWindow('/');
    }
  })());
});
