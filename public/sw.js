/**
 * Service worker for SpaceLink.
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
 * Caching only what it intercepts is not enough to be usable offline, though.
 * A worker is not in charge of the page that installs it — that page has
 * already fetched everything by the time `clients.claim()` lands — so on a
 * first visit this cached precisely nothing, and the app needed three visits
 * before it survived losing the network. It now fills the cache during
 * `install` instead, from a list the build writes below.
 */

/** Written by `build/precache.mjs` at build time; see the note above. */
const PRECACHE = self.__SPACELINK_PRECACHE__ ?? ['./']

/*
 * Named after the bytes it holds, so `activate` retires the previous build
 * exactly and there is no version anybody has to remember to bump. A build
 * without the plugin gets 'dev' and behaves as it always did.
 */
const CACHE = `spacelink-${self.__SPACELINK_BUILD__ ?? 'dev'}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // One at a time and best-effort: `cache.addAll` is all-or-nothing, and a
      // single missing font would otherwise cost the whole offline app. Also
      // `reload`, so installing cannot bless a stale copy out of the HTTP
      // cache. What is really being promised here is checked in e2e/12.
      const results = await Promise.allSettled(
        PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      if (failed) console.warn(`SpaceLink: ${failed} of ${PRECACHE.length} files did not precache`)

      // Take over as soon as this worker is ready rather than waiting for every
      // tab to close, so a fix is never one reload away from arriving.
      await self.skipWaiting()
    })(),
  )
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

/*
 * Every lookup ignores `Vary`, and it has to.
 *
 * Vite tags its entry script and stylesheet `crossorigin`, so the page asks for
 * them with an `Origin` header — while a precache request, built here from a
 * bare URL, has none. Any server that answers `Vary: Origin` (Vite's own
 * preview does, and so do most CDNs) therefore makes the browser treat those as
 * different entries, and every precached asset misses. The app then serves its
 * shell from cache offline and cannot load a line of itself.
 *
 * This cache is keyed by URL on purpose — hashed assets are immutable and the
 * shell has one form — so `Vary` has nothing to tell us.
 */
const BY_URL = { ignoreVary: true }

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
        const hit = await cache.match(request, BY_URL)
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
        const hit = await cache.match(request, BY_URL)
        if (hit) return hit
        if (request.mode === 'navigate') {
          const shell = await cache.match('./', BY_URL)
          if (shell) return shell
        }
        throw error
      }
    })(),
  )
})
