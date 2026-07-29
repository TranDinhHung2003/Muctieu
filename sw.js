/* Service worker: giữ thông báo trên thanh hệ thống đến khi người dùng xóa */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification && event.notification.data) || {};
  // Không tự đóng — chỉ mở/focus app; người dùng tự xóa trên thanh thông báo
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
