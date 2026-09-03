/**
 * Carrying a reader's settings across the rename from SpaceFore to SpaceLink.
 *
 * Everything this app remembers in the browser is filed under a `spacelink.`
 * key: the settings, which vault was open last, starred notes and their order,
 * the pane sizes, the explorer's open folders, recent searches, and the sync
 * server this device is paired with. All of those used to be filed under
 * `spacefore.`.
 *
 * A rename that ignored them would not lose a single *note* — notes live in a
 * folder, a database or on a server, none of which move — but it would greet
 * the reader with a stranger's app: default theme, no starred notes, the panes
 * back to their starting widths, and a sync server they have to pair with
 * again. So the old keys are copied across, once, before anything reads them.
 *
 * Copied, not moved. The old keys are left where they are, which costs a few
 * hundred bytes and means opening an older build of the app still finds what it
 * expects instead of an empty profile.
 */

/** The prefix everything was filed under before the app was renamed. */
export const PREVIOUS_PREFIX = 'spacefore.'
/** The prefix everything is filed under now. */
export const CURRENT_PREFIX = 'spacelink.'

/**
 * Copy every `spacefore.` entry to its `spacelink.` name, skipping any that
 * already exists.
 *
 * Skipping is what makes this safe to run on every boot: once the reader has
 * changed a setting under the new name, the old value must never come back and
 * overwrite it.
 *
 * Returns the keys it wrote, which is what the tests read. Storage that throws
 * — a private window, a browser set to block site data — is not an error worth
 * interrupting a reader over: they simply start fresh, which is what they would
 * have got anyway.
 *
 * @param storage defaults to `localStorage`; injectable for testing.
 */
export function adoptRenamedStorage(storage: Storage | undefined = safeLocalStorage()): string[] {
  if (!storage) return []
  const written: string[] = []
  try {
    // Read the names first, then write. The order `Storage.key(index)` returns
    // is implementation-defined, so writing while walking those indices means
    // walking a list that is moving underneath. Nothing here has been shown to
    // lose an entry that way — this is a shape that cannot, rather than a fix
    // for a bug that was seen.
    const previous: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null && key.startsWith(PREVIOUS_PREFIX)) previous.push(key)
    }

    for (const key of previous) {
      const renamed = `${CURRENT_PREFIX}${key.slice(PREVIOUS_PREFIX.length)}`
      if (storage.getItem(renamed) !== null) continue
      const value = storage.getItem(key)
      if (value === null) continue
      storage.setItem(renamed, value)
      written.push(renamed)
    }
  } catch {
    // Out of quota part-way through, or storage that refuses to be read at all.
    // Whatever was copied stands; the rest is a fresh start, not a crash.
  }
  return written
}

/** `localStorage` where it exists and can be touched, otherwise undefined. */
function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}
