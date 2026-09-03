// @vitest-environment node
/**
 * Where node-path.sh looks for Node, checked against fake homes.
 *
 * The first ⌘R on a Mac whose Node came from nvm stopped at "npm was not
 * found": Xcode's script phases start with a PATH of /usr/bin:/bin and the
 * like, and copy-resources.sh only added Homebrew and MacPorts back. The app
 * itself found nvm's node at run time; the build that made it could not.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'node-path.sh')
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** A fake home with `npm` shims that each announce where they live. */
function home(shims) {
  const root = mkdtempSync(join(tmpdir(), 'spacelink-home-'))
  for (const relative of shims) {
    const file = join(root, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `#!/bin/bash\necho ${JSON.stringify(relative)}\n`)
    chmodSync(file, 0o755)
  }
  return root
}

/** Which `npm` a bare-PATH shell finds once the helper has run. */
function npmSeenFrom(root) {
  return execFileSync('bash', ['-c', `. "${HELPER}"; spacelink_add_node_paths; command -v npm >/dev/null && npm || echo none`], {
    env: { HOME: root, PATH: BARE_PATH },
    encoding: 'utf8',
  }).trim()
}

describe('node-path.sh', () => {
  it('finds nvm, and takes the newest version by number rather than by string', () => {
    // "v9" sorts after "v22" as text; as a version it is older.
    const root = home(['.nvm/versions/node/v9.0.0/bin/npm', '.nvm/versions/node/v22.1.0/bin/npm', '.nvm/versions/node/v10.3.0/bin/npm'])
    expect(npmSeenFrom(root)).toBe('.nvm/versions/node/v22.1.0/bin/npm')
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['Volta', '.volta/bin/npm'],
    ['fnm', '.local/share/fnm/aliases/default/bin/npm'],
    ['asdf', '.asdf/shims/npm'],
    ['nodenv', '.nodenv/shims/npm'],
    ['n', 'n/bin/npm'],
  ])('finds a %s install', (_, shim) => {
    const root = home([shim])
    expect(npmSeenFrom(root)).toBe(shim)
    rmSync(root, { recursive: true, force: true })
  })

  it('survives `set -euo pipefail` in a home with no version manager at all', () => {
    // copy-resources.sh runs that way. The first version of this helper listed
    // ~/.nvm/versions/node unguarded; on a Mac without nvm the failing `ls`
    // took the whole build down — the exact Mac most people have.
    const root = home([])
    const result = execFileSync(
      'bash',
      ['-c', `set -euo pipefail; . "${HELPER}"; spacelink_add_node_paths; echo survived`],
      { env: { HOME: root, PATH: BARE_PATH }, encoding: 'utf8' },
    ).trim()
    expect(result).toBe('survived')
    rmSync(root, { recursive: true, force: true })
  })

  it('is bash 3.2 material: no arrays, mapfile, or ${var,,}', () => {
    // macOS ships bash 3.2 at /bin/bash and Xcode's script phase uses it.
    // Only the code: the comments are allowed to name what they avoid.
    const code = execFileSync('cat', [HELPER], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/mapfile|readarray|declare -A|\$\{[a-z_]+,,\}|\$\{[a-z_]+\^\^\}|local -n/)
  })
})
