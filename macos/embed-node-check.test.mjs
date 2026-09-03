// @vitest-environment node
/**
 * The check that keeps --embed-node from shipping a Node that cannot run.
 *
 * Homebrew builds node with --shared-libuv, --shared-openssl, --shared-brotli
 * and the rest (Formula/n/node.rb), so the binary depends on Homebrew's own
 * dylibs. Copied into a bundle and opened on a Mac without them, dyld aborts it
 * before Node runs a line, and the app reports "The notes server did not
 * start." — on exactly the Mac --embed-node was for. `otool -L` tells a
 * self-contained binary from one of those, and otool is a Mac tool, so here it
 * is a shim that answers from canned listings.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'embed-node-check.sh')
const bin = mkdtempSync(join(tmpdir(), 'spacefore-otool-'))

writeFileSync(
  join(bin, 'otool'),
  `#!/bin/bash
case "$2" in
  *homebrew-node) printf '%s:\\n\\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 2.0.0)\\n\\t/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0)\\n\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\\n' "$2" ;;
  *nodejs-org)    printf '%s:\\n\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\\n\\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0)\\n' "$2" ;;
esac
`,
)
chmodSync(join(bin, 'otool'), 0o755)

const run = (node, path = `${bin}:${process.env.PATH}`) => spawnSync('bash', [CHECK, node], { env: { ...process.env, PATH: path }, encoding: 'utf8' })

afterAll(() => rmSync(bin, { recursive: true, force: true }))

describe('embed-node-check.sh', () => {
  it("refuses Homebrew's node, and names what it depends on", () => {
    const result = run('/tmp/homebrew-node')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('/opt/homebrew/opt/libuv/lib/libuv.1.dylib')
    expect(result.stderr).toContain('/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib')
    expect(result.stderr).toContain('nodejs.org')
  })

  it('accepts the self-contained nodejs.org build', () => {
    expect(run('/tmp/nodejs-org').status).toBe(0)
  })

  it('says so rather than guessing when otool itself is missing', () => {
    const result = run('/tmp/nodejs-org', '/usr/bin:/bin')
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/otool is missing/)
  })

  it('is what build.sh runs before copying a node in', () => {
    const build = execFileSync('cat', [join(dirname(CHECK), 'build.sh')], { encoding: 'utf8' })
    expect(build).toMatch(/embed-node-check\.sh" "\$NODE_PATH"/)
  })
})
