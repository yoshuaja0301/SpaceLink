// @vitest-environment node
/**
 * Every macOS API the app uses, checked against the version the app promises
 * to run on — without a Mac.
 *
 * `Tests/run.sh` typechecks `SpaceLinkApp.swift` against stubs, which catches a
 * wrong label or a wrong type. What it cannot catch is *when* an API arrived:
 * Swift only applies `@available(macOS …)` when it is compiling for macOS, and
 * on Linux it is inert. That was confirmed, not assumed — a stub property
 * marked `@available(macOS 13.3, *)` compiles here with no guard at all.
 *
 * So the versions are checked here instead. Each stub declaration carries the
 * path of Apple's documentation page it was copied from, and one newer than the
 * deployment target also carries `— macOS X.Y+` taken from that page. This
 * reads those, finds where the app uses them, and insists every use of
 * something newer than the target sits inside an `#available` guard for at
 * least that version.
 *
 * Getting this wrong does not fail quietly: the first ⌘R stops with "is only
 * available in macOS 13.3 or newer", which is a poor way to meet a project.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const STUBS = ['Tests/Stubs/WebKitStub.swift', 'Tests/Stubs/AppKitStub.swift']
/** The app's own sources — what actually ships, and what Xcode will compile. */
const SOURCES = ['Sources/SpaceLinkApp.swift', 'Sources/SyncServer.swift']

const read = (path) => readFileSync(join(HERE, path), 'utf8')

/* ------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------ */

/** `12.0` -> [12, 0]; compares as numbers, so 13.3 sorts above 13.10 correctly. */
function parseVersion(text) {
  return text.split('.').map((part) => Number(part))
}

/** Negative when `a` is older than `b`, 0 when equal. */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** What the project promises to run on. Both configurations must agree. */
function deploymentTarget() {
  const pbxproj = read('SpaceLink.xcodeproj/project.pbxproj')
  const found = [...pbxproj.matchAll(/MACOSX_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((match) => match[1])
  if (found.length === 0) throw new Error('the project sets no MACOSX_DEPLOYMENT_TARGET')
  const distinct = [...new Set(found)]
  if (distinct.length !== 1) throw new Error(`configurations disagree about the deployment target: ${distinct.join(', ')}`)
  return distinct[0]
}

/* ------------------------------------------------------------------ *
 * What the stubs say each symbol needs
 * ------------------------------------------------------------------ */

/** `/// webkit/wkwebview/isinspectable — macOS 13.3+, default false` */
const ANNOTATION = /^\s*\/\/\/\s*(\S+)\s+—\s*macOS\s+(\d+(?:\.\d+)*)\+/
/** The declaration an annotation is attached to, by kind. */
const DECLARATIONS = [
  { kind: 'type', pattern: /\b(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/ },
  { kind: 'function', pattern: /\bfunc\s+([A-Za-z_]\w*)/ },
  { kind: 'member', pattern: /\b(?:var|let)\s+([A-Za-z_]\w*)/ },
  { kind: 'member', pattern: /\bcase\s+([A-Za-z_]\w*)/ },
]

/**
 * Every `— macOS X+` annotation in the stubs, paired with the thing it
 * describes. An annotation attached to nothing is an error rather than a
 * shrug: it would silently check nothing.
 */
function annotatedSymbols() {
  const found = []
  for (const stub of STUBS) {
    const lines = read(stub).split('\n')
    lines.forEach((line, index) => {
      const annotation = ANNOTATION.exec(line)
      if (!annotation) return
      const [, docPath, version] = annotation
      // Skip further comments and attributes to reach the declaration itself.
      let at = index + 1
      while (at < lines.length && /^\s*(\/\/|@|$)/.test(lines[at])) at += 1
      const declaration = lines[at] ?? ''
      const matched = DECLARATIONS.map(({ kind, pattern }) => {
        const match = pattern.exec(declaration)
        return match ? { kind, name: match[1] } : null
      }).find(Boolean)
      if (!matched) {
        throw new Error(`${stub}:${index + 1}: "${docPath}" is annotated but declares nothing recognisable`)
      }
      found.push({ ...matched, version, docPath, where: `${stub}:${index + 1}` })
    })
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Where the app is guarded
 * ------------------------------------------------------------------ */

/**
 * The character ranges of every `if #available(macOS X, *) { … }` body, with
 * the version each one establishes.
 *
 * Anything else that reads as an availability check — `guard #available`,
 * whose scope runs to the end of the enclosing block, or an `@available` on a
 * declaration — is refused rather than misunderstood. A checker that quietly
 * fails to see a guard would report a bug that is not there; one that quietly
 * invents a guard would miss one that is.
 */
function guardedRanges(source, where) {
  const ranges = []
  for (const match of source.matchAll(/#available\s*\(([^)]*)\)/g)) {
    const preceding = source.slice(0, match.index).trimEnd()
    if (/\bguard$/.test(preceding)) {
      throw new Error(`${where}: \`guard #available\` is not understood by this check; use \`if #available\``)
    }
    if (!/\bif$/.test(preceding)) {
      throw new Error(`${where}: an \`#available\` that is not part of an \`if\` — this check cannot place its scope`)
    }
    const version = /macOS\s+(\d+(?:\.\d+)*)/.exec(match[1])
    if (!version) throw new Error(`${where}: \`#available(${match[1]})\` names no macOS version`)

    const open = source.indexOf('{', match.index + match[0].length)
    if (open === -1) throw new Error(`${where}: no block after \`#available\``)
    ranges.push({ from: open, to: endOfBlock(source, open, where), version: version[1] })
  }
  return ranges
}

/** The offset of the `}` closing the block that opens at `open`. */
function endOfBlock(source, open, where) {
  let depth = 0
  for (let at = open; at < source.length; at += 1) {
    const character = source[at]
    if (character === '/' && source[at + 1] === '/') {
      const newline = source.indexOf('\n', at)
      at = newline === -1 ? source.length : newline
      continue
    }
    if (character === '/' && source[at + 1] === '*') {
      const end = source.indexOf('*/', at + 2)
      at = end === -1 ? source.length : end + 1
      continue
    }
    if (character === '"') {
      at += 1
      while (at < source.length && source[at] !== '"') at += source[at] === '\\' ? 2 : 1
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  throw new Error(`${where}: a block opened at ${open} is never closed`)
}

/** Every offset in `source` where `symbol` is used. */
function usesOf(source, symbol) {
  const escaped = symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A type is named outright; a member, an enum case or a call arrives after a
  // dot. A function may also be *implemented*, which needs the same guard.
  const patterns =
    symbol.kind === 'type'
      ? [new RegExp(`\\b${escaped}\\b`, 'g')]
      : symbol.kind === 'function'
        ? [new RegExp(`\\.${escaped}\\s*\\(`, 'g'), new RegExp(`\\bfunc\\s+${escaped}\\b`, 'g')]
        : [new RegExp(`\\.${escaped}\\b`, 'g')]
  const offsets = []
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) offsets.push(match.index)
  }
  return offsets
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

const TARGET = deploymentTarget()
const SYMBOLS = annotatedSymbols()
/** Only what the deployment target does not already guarantee. */
const NEWER = SYMBOLS.filter((symbol) => compareVersions(symbol.version, TARGET) > 0)

/** Every unguarded use of something newer than the target, with its line. */
function unguardedUses() {
  const problems = []
  for (const path of SOURCES) {
    const source = read(path)
    const guards = guardedRanges(source, path)
    for (const symbol of NEWER) {
      for (const offset of usesOf(source, symbol)) {
        const covered = guards.some(
          (guard) => offset > guard.from && offset < guard.to && compareVersions(guard.version, symbol.version) >= 0,
        )
        if (covered) continue
        const line = source.slice(0, offset).split('\n').length
        problems.push(`${path}:${line}: ${symbol.name} needs macOS ${symbol.version}, the app targets ${TARGET}`)
      }
    }
  }
  return problems
}

describe('the macOS versions the app asks for', () => {
  it('reads a single deployment target out of the project', () => {
    expect(TARGET).toMatch(/^\d+(\.\d+)*$/)
    expect(compareVersions(TARGET, '10.15')).toBeGreaterThan(0)
  })

  it('knows when each annotated API arrived, from the page it was copied from', () => {
    expect(SYMBOLS.length).toBeGreaterThan(5)
    for (const symbol of SYMBOLS) {
      expect(symbol.version, symbol.where).toMatch(/^\d+(\.\d+)*$/)
      // The citation is what makes the version checkable by a reader.
      expect(symbol.docPath, symbol.where).toMatch(/^(webkit|appkit|foundation)\//)
    }
    // Verified against developer.apple.com: these are the versions Apple lists.
    const byName = Object.fromEntries(SYMBOLS.map((symbol) => [symbol.name, symbol.version]))
    expect(byName.isInspectable).toBe('13.3')
    expect(byName.WKDownload).toBe('11.3')
    expect(byName.shouldPerformDownload).toBe('11.3')
  })

  it('is checking something: at least one API is newer than the target', () => {
    // If this ever empties, the deployment target rose past everything the app
    // uses — at which point this file is checking nothing and should say so.
    expect(NEWER.map((symbol) => symbol.name)).toEqual(['isInspectable'])
  })

  it('guards every use of an API newer than the deployment target', () => {
    expect(unguardedUses()).toEqual([])
  })

  it('would notice an unguarded use', () => {
    // The check is only worth having if it fails when it should. Same source,
    // same rules, with the guard taken away.
    const source = read('Sources/SpaceLinkApp.swift').replace(/if #available\(macOS 13\.3, \*\) \{/, 'if true {')
    expect(source).not.toMatch(/#available/)
    const symbol = NEWER.find((candidate) => candidate.name === 'isInspectable')
    const offsets = usesOf(source, symbol)
    expect(offsets.length).toBeGreaterThan(0)
    for (const offset of offsets) {
      expect(guardedRanges(source, 'mutated').some((guard) => offset > guard.from && offset < guard.to)).toBe(false)
    }
  })

  it('refuses a guard shape it cannot place, rather than passing it', () => {
    expect(() => guardedRanges('guard #available(macOS 13.3, *) else { return }', 'x')).toThrow(/guard #available/)
    expect(() => guardedRanges('if #available(iOS 16.0, *) { }', 'x')).toThrow(/no macOS version/)
    expect(() => guardedRanges('let ok = #available(macOS 13.3, *)', 'x')).toThrow(/not part of an `if`/)
  })

  it('pairs every annotation with a declaration', () => {
    // `annotatedSymbols` throws on an annotation attached to nothing; this is
    // the check that it is actually reached for the files as they stand.
    expect(() => annotatedSymbols()).not.toThrow()
    for (const symbol of SYMBOLS) expect(['type', 'member', 'function']).toContain(symbol.kind)
  })
})
