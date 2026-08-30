/**
 * Service worker for SpaceFore.
 *
 * Deliberately small, because a service worker that guesses wrong is worse than
 * none: it can serve a stale app forever, or hand back yesterday's note as if
 * it were today's. Two rules only:
 *
 *   1. `/api/` is never touched. Notes always come from the server, so a device
 *      can never show content the vault no longer has.
 *   2. Built assets are content-hashed, so they are safe to keep forever.
 *      Everything else — the app shell above all — is fetched fresh, with the
 *      cached copy used only when the network genuinely fails.
 *
 * The version below is what retires an old cache. Bump it if the caching rules
 * change; the hashed asset names take care of the rest.
 */
const CACHE = 'spacefore-v1'

self.addEventListener('install', (event) => {
  // Take over as soon as this worker is ready rather than waiting for every tab
  // to close, so a fix is never one reload away from arriving.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // The vault, and anything that could carry a token, stays off the cache.
  if (url.pathname.startsWith('/api/')) return

  const isHashedAsset = url.pathname.startsWith('/assets/')

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)

      if (isHashedAsset) {
        const hit = await cache.match(request)
        if (hit) return hit
        const response = await fetch(request)
        if (response.ok) void cache.put(request, response.clone())
        return response
      }

      // Everything else: the network is the truth, the cache is the safety net.
      try {
        const response = await fetch(request)
        if (response.ok) void cache.put(request, response.clone())
        return response
      } catch (error) {
        const hit = await cache.match(request)
        if (hit) return hit
        if (request.mode === 'navigate') {
          const shell = await cache.match('./')
          if (shell) return shell
        }
        throw error
      }
    })(),
  )
})
