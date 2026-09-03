// @vitest-environment node
/**
 * The Xcode project file, checked without Xcode.
 *
 * `project.pbxproj` is a property list in the old NeXT format, full of
 * twenty-four character ids that refer to each other. Nothing in a normal build
 * reads it, so a typo in one of those ids — or a reference to a file that was
 * renamed — is invisible until somebody opens Xcode and is told the project is
 * damaged, with no indication of where.
 *
 * So it is parsed here, and every reference is followed. This cannot tell you
 * that Xcode likes the project; it can tell you the file is well formed, that
 * the graph hangs together, and that the paths in it exist.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, 'SpaceLink.xcodeproj')
const source = readFileSync(join(PROJECT, 'project.pbxproj'), 'utf8')

/* ------------------------------------------------------------------ *
 * A parser for the format
 * ------------------------------------------------------------------ */

/**
 * Parse an OpenStep property list: `{ key = value; }`, `( a, b )`, bare or
 * quoted strings, `/* comments *\/`. That is the whole grammar Xcode uses.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parsePlist(text) {
  let at = 0

  const skip = () => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at])) at += 1
      if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end === -1 ? text.length : end
        continue
      }
      if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        if (end === -1) throw new Error(`unterminated comment at ${at}`)
        at = end + 2
        continue
      }
      return
    }
  }

  const readString = () => {
    if (text[at] === '"') {
      at += 1
      let out = ''
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\') {
          const escaped = text[at + 1]
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
          at += 2
          continue
        }
        out += text[at]
        at += 1
      }
      if (text[at] !== '"') throw new Error(`unterminated string at ${at}`)
      at += 1
      return out
    }
    const start = at
    while (at < text.length && /[A-Za-z0-9_./$<>:@+-]/.test(text[at])) at += 1
    if (at === start) throw new Error(`expected a value at ${at}: ${JSON.stringify(text.slice(at, at + 40))}`)
    return text.slice(start, at)
  }

  const readValue = () => {
    skip()
    if (text[at] === '{') {
      at += 1
      /** @type {Record<string, unknown>} */
      const out = {}
      for (;;) {
        skip()
        if (text[at] === '}') {
          at += 1
          return out
        }
        const key = readString()
        skip()
        if (text[at] !== '=') throw new Error(`expected = after ${key} at ${at}`)
        at += 1
        out[key] = readValue()
        skip()
        if (text[at] === ';') at += 1
      }
    }
    if (text[at] === '(') {
      at += 1
      /** @type {unknown[]} */
      const out = []
      for (;;) {
        skip()
        if (text[at] === ')') {
          at += 1
          return out
        }
        out.push(readValue())
        skip()
        if (text[at] === ',') at += 1
      }
    }
    return readString()
  }

  skip()
  // The `// !$*UTF8*$!` header is a comment as far as the grammar goes.
  const value = readValue()
  skip()
  if (at !== text.length) throw new Error(`trailing content at ${at}`)
  return value
}

const project = /** @type {Record<string, any>} */ (parsePlist(source))
const objects = /** @type {Record<string, any>} */ (project.objects)

/** Every 24-hex-character token that appears as a value anywhere. */
function referencesIn(value, found = []) {
  if (typeof value === 'string') {
    if (/^[0-9A-F]{24}$/.test(value)) found.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, found)
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      // Build settings are free text and may legitimately contain anything.
      if (key === 'buildSettings' || key === 'shellScript') continue
      referencesIn(inner, found)
    }
  }
  return found
}

const withIsa = (isa) => Object.entries(objects).filter(([, object]) => object.isa === isa)

/* ------------------------------------------------------------------ *
 * The file itself
 * ------------------------------------------------------------------ */

describe('project.pbxproj', () => {
  it('parses, and says which format it is', () => {
    expect(source.startsWith('// !$*UTF8*$!')).toBe(true)
    expect(project.archiveVersion).toBe('1')
    expect(project.objectVersion).toBe('56')
    expect(typeof objects).toBe('object')
  })

  it('every object has an id of the right shape and an isa', () => {
    for (const [id, object] of Object.entries(objects)) {
      expect(id, `object id ${id}`).toMatch(/^[0-9A-F]{24}$/)
      expect(typeof object.isa, `object ${id} has no isa`).toBe('string')
    }
    expect(Object.keys(objects).length).toBeGreaterThan(10)
  })

  it('every reference resolves to an object that exists', () => {
    const dangling = []
    for (const [id, object] of Object.entries(objects)) {
      for (const reference of referencesIn(object)) {
        if (!(reference in objects)) dangling.push(`${object.isa} ${id} -> ${reference}`)
      }
    }
    expect(dangling).toEqual([])
    expect(project.rootObject in objects).toBe(true)
  })

  it('has no object nothing points at', () => {
    const reachable = new Set([project.rootObject])
    const queue = [project.rootObject]
    while (queue.length > 0) {
      const id = queue.pop()
      for (const reference of referencesIn(objects[id])) {
        if (reachable.has(reference)) continue
        reachable.add(reference)
        queue.push(reference)
      }
    }
    const orphans = Object.keys(objects).filter((id) => !reachable.has(id))
    expect(orphans.map((id) => `${objects[id].isa} ${id}`)).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * What the project describes
 * ------------------------------------------------------------------ */

describe('the app it builds', () => {
  const [, root] = withIsa('PBXProject')[0]
  const [targetId, target] = withIsa('PBXNativeTarget')[0]

  it('is one macOS application target', () => {
    expect(withIsa('PBXNativeTarget')).toHaveLength(1)
    expect(target.name).toBe('SpaceLink')
    expect(target.productType).toBe('com.apple.product-type.application')
    expect(root.targets).toEqual([targetId])
    expect(objects[target.productReference].path).toBe('SpaceLink.app')
  })

  it('compiles the Swift that is actually there', () => {
    const sources = target.buildPhases.map((id) => objects[id]).find((phase) => phase.isa === 'PBXSourcesBuildPhase')
    expect(sources).toBeDefined()
    const compiled = sources.files.map((id) => objects[objects[id].fileRef].path)
    // Both of them: a target missing SyncServer.swift compiles the app against
    // a type that is not there, and fails with "cannot find SyncServer in scope".
    expect(compiled.slice().sort()).toEqual(['SpaceLinkApp.swift', 'SyncServer.swift'])
    for (const name of compiled) expect(existsSync(join(HERE, 'Sources', name)), name).toBe(true)
  })

  it('points at files that exist', () => {
    for (const [id, file] of withIsa('PBXFileReference')) {
      if (file.sourceTree === 'BUILT_PRODUCTS_DIR') continue // produced by the build
      // Every group in this project sits at the root, so the path is relative
      // to `macos/` or to the group's own `path`.
      const group = withIsa('PBXGroup').find(([, candidate]) => (candidate.children ?? []).includes(id))
      const prefix = group && group[1].path ? group[1].path : ''
      expect(existsSync(join(HERE, prefix, file.path)), `${file.path} is referenced but missing`).toBe(true)
    }
  })

  it('is configured the way this app needs', () => {
    const configs = objects[target.buildConfigurationList].buildConfigurations.map((id) => objects[id])
    expect(configs.map((config) => config.name).sort()).toEqual(['Debug', 'Release'])

    for (const config of configs) {
      const settings = config.buildSettings
      expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('md.spacelink.app')
      expect(settings.INFOPLIST_FILE).toBe('Info.plist')
      // Ad-hoc signing, so it builds with no Apple account attached.
      expect(settings.CODE_SIGN_IDENTITY).toBe('-')
      expect(settings.CODE_SIGN_STYLE).toBe('Manual')
      // No entitlements file is what leaves the App Sandbox off. A sandboxed
      // app may not run Node, and this one has to — so if this ever appears,
      // the app will launch and then fail to open any vault at all.
      expect(settings.CODE_SIGN_ENTITLEMENTS).toBeUndefined()
      expect(settings.ENABLE_HARDENED_RUNTIME).toBe('NO')
      // The script phase reads the whole repository and writes into the
      // bundle. Xcode 14+ can sandbox script phases to their declared inputs
      // and outputs, and new-project templates turn that on; left unset it
      // is off today, but "off today" is not a setting. Said explicitly, so a
      // future default cannot turn the first build into a sandbox violation.
      expect(settings.ENABLE_USER_SCRIPT_SANDBOXING).toBe('NO')
    }

    const projectConfigs = objects[root.buildConfigurationList].buildConfigurations.map((id) => objects[id])
    for (const config of projectConfigs) {
      expect(config.buildSettings.MACOSX_DEPLOYMENT_TARGET).toBe('12.0')
      expect(config.buildSettings.SDKROOT).toBe('macosx')
      expect(config.buildSettings.SWIFT_VERSION).toBe('5.0')
    }
  })

  it('builds the web app into the bundle, in the layout the Swift expects', () => {
    const script = target.buildPhases
      .map((id) => objects[id])
      .find((phase) => phase.isa === 'PBXShellScriptBuildPhase')
    expect(script, 'no script phase, so the bundle would ship with no web app').toBeDefined()

    const shell = script.shellScript
    // It delegates rather than describing the bundle a second time: build.sh
    // calls the same script, so the two ways of building cannot diverge.
    expect(shell).toMatch(/copy-resources\.sh/)
    expect(shell).toMatch(/\$BUILT_PRODUCTS_DIR\/\$CONTENTS_FOLDER_PATH\/Resources/)
    expect(existsSync(join(HERE, 'copy-resources.sh'))).toBe(true)
    // It has no declared outputs, so it must say it always needs to run or
    // Xcode both warns and, worse, may skip it.
    expect(script.alwaysOutOfDate).toBe('1')
    expect(script.shellPath).toBe('/bin/bash')
  })

  it('agrees with build.sh about what goes into the bundle', () => {
    const shared = readFileSync(join(HERE, 'copy-resources.sh'), 'utf8')
    const standalone = readFileSync(join(HERE, 'build.sh'), 'utf8')

    // `SpaceLinkApp.swift` looks for `server/index.mjs` and expects `dist/`
    // beside it, because the server resolves `dist/` relative to its own file.
    expect(shared).toMatch(/npm run build/)
    expect(shared).toMatch(/RESOURCES\/dist/)
    expect(shared).toMatch(/RESOURCES\/server/)
    // Tests must not travel inside a shipped app.
    expect(shared).toMatch(/rm -f "\$RESOURCES\/server\/"\*\.test\.mjs/)
    // Xcode hands a script phase almost no PATH, so Node has to be found —
    // by node-path.sh, which the script must source and which must know the
    // usual places.
    expect(shared).toMatch(/\. "\$HERE\/node-path\.sh"/)
    expect(shared).toMatch(/spacelink_add_node_paths/)
    expect(readFileSync(join(HERE, 'node-path.sh'), 'utf8')).toMatch(/opt\/homebrew\/bin/)

    // `set -o pipefail` is not in POSIX sh, and a shell that does not know it
    // exits on the first line under `set -e` — leaving the bundle empty, with
    // an error that says nothing about why.
    expect(shared).toMatch(/^#!\/usr\/bin\/env bash$/m)
    expect(shared).toMatch(/set -euo pipefail/)
    // Xcode's script phase runs it as a command, so the bit has to survive the
    // clone. Without it the build fails with "permission denied" and nothing
    // pointing at why.
    expect(statSync(join(HERE, 'copy-resources.sh')).mode & 0o111, 'copy-resources.sh is not executable').toBeGreaterThan(0)

    // build.sh must delegate too, rather than growing its own copy.
    expect(standalone).toMatch(/copy-resources\.sh/)
    expect(standalone).not.toMatch(/npm run build/)
  })

  it('compiles the app the same way Xcode does', () => {
    const standalone = readFileSync(join(HERE, 'build.sh'), 'utf8')
    const app = readFileSync(join(HERE, 'Sources', 'SpaceLinkApp.swift'), 'utf8')

    // Xcode builds an application target with `-parse-as-library`, and under
    // that flag a statement at the top of a file is an error rather than a
    // program — so the entry point has to be `@main`, and build.sh has to pass
    // the same flag or the two paths disagree about what compiles. Both halves
    // of this were confirmed against a real Swift compiler.
    expect(app).toMatch(/^@main$/m)
    expect(standalone).toMatch(/-parse-as-library/)
    // Every source in the target, in the order the project lists them.
    for (const name of ['SyncServer.swift', 'SpaceLinkApp.swift']) {
      expect(standalone).toMatch(new RegExp(`Sources/${name.replace('.', '\\.')}`))
    }
  })

  it('runs the script after the app bundle exists to copy into', () => {
    const phases = target.buildPhases.map((id) => objects[id].isa)
    expect(phases.indexOf('PBXShellScriptBuildPhase')).toBeGreaterThan(phases.indexOf('PBXSourcesBuildPhase'))
    expect(phases.indexOf('PBXShellScriptBuildPhase')).toBeGreaterThan(phases.indexOf('PBXResourcesBuildPhase'))
  })
})

/* ------------------------------------------------------------------ *
 * The rest of the bundle Xcode expects
 * ------------------------------------------------------------------ */

describe('the project directory', () => {
  it('has a shared scheme, so the project is usable the moment it opens', () => {
    const scheme = join(PROJECT, 'xcshareddata', 'xcschemes', 'SpaceLink.xcscheme')
    expect(existsSync(scheme)).toBe(true)
    const xml = readFileSync(scheme, 'utf8')

    // A scheme pointing at a target that is not there gives "the scheme is not
    // configured for this action", which reads like a broken project.
    const [targetId] = withIsa('PBXNativeTarget')[0]
    expect(xml).toMatch(new RegExp(`BlueprintIdentifier = "${targetId}"`))
    expect(xml).toMatch(/BuildableName = "SpaceLink\.app"/)
    expect(xml).toMatch(/ReferencedContainer = "container:SpaceLink\.xcodeproj"/)
  })

  it('has the workspace file Xcode looks for', () => {
    expect(existsSync(join(PROJECT, 'project.xcworkspace', 'contents.xcworkspacedata'))).toBe(true)
  })

  it('keeps the per-user files Xcode writes out of the repository', () => {
    // Opening the project writes `xcuserdata/` immediately — window positions,
    // the last scheme, breakpoints — and anyone who keeps DerivedData beside
    // the project gets that too. None of it is anybody else's business, and
    // all of it turns `git status` into noise the moment Xcode starts.
    const ignore = readFileSync(join(HERE, '..', '.gitignore'), 'utf8')
    for (const pattern of ['xcuserdata/', 'macos/DerivedData/', 'macos/build/']) {
      expect(ignore, `.gitignore does not cover ${pattern}`).toMatch(
        new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      )
    }
    // …while everything that makes the project open correctly stays tracked.
    for (const kept of ['SpaceLink.xcodeproj/project.pbxproj', 'SpaceLink.xcodeproj/xcshareddata/xcschemes/SpaceLink.xcscheme']) {
      expect(existsSync(join(HERE, kept)), kept).toBe(true)
    }
  })

  it('agrees with Info.plist about what is being built', () => {
    const plist = readFileSync(join(HERE, 'Info.plist'), 'utf8')
    const [, target] = withIsa('PBXNativeTarget')[0]
    const settings = objects[target.buildConfigurationList].buildConfigurations.map((id) => objects[id].buildSettings)

    expect(plist).toMatch(/<string>md\.spacelink\.app<\/string>/)
    expect(plist).toMatch(/<key>CFBundleExecutable<\/key>\s*<string>SpaceLink<\/string>/)
    for (const setting of settings) {
      expect(setting.PRODUCT_NAME).toBe('$(TARGET_NAME)')
      expect(setting.MARKETING_VERSION).toBe('0.1.0')
    }
    // The deployment target in the project must not promise more than the
    // Info.plist does, or the app will launch on a system it cannot run on.
    expect(plist).toMatch(/<key>LSMinimumSystemVersion<\/key>\s*<string>12\.0<\/string>/)
  })
})
