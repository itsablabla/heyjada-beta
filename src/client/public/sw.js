self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : undefined;
  const title = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title
    : 'Superjoy needs approval';
  const body = typeof payload.body === 'string' && payload.body.trim()
    ? payload.body
    : 'Approval is needed to continue.';

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/superjoy_128.png',
    badge: '/icons/superjoy_64.png',
    tag: conversationId ? `confirmation-${conversationId}` : 'confirmation-needed',
    requireInteraction: true,
    data: { conversationId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const conversationId = event.notification.data?.conversationId;
  const targetUrl = new URL('/', self.location.origin);
  if (conversationId) targetUrl.searchParams.set('conversationId', conversationId);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('navigate' in client) {
        try {
          await client.navigate(targetUrl.href);
        } catch {
          // Fall through to focusing the existing window.
        }
      }
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(targetUrl.href);
  })());
});
