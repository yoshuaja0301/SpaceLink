// @vitest-environment node
/**
 * What copy-resources.sh actually hands to iconutil.
 *
 * `iconutil` and `sips` exist only on a Mac, so the script skips the icon
 * where they are absent — which meant the one part of it that could not be
 * run here was also the one part nobody had checked. It was wrong: the loop
 * produced `icon_64x64.png`, a name Apple's iconset format does not have, and
 * iconutil treats a file it does not recognise as a reason to refuse the set.
 *
 * This puts two small shims on PATH that record what they were asked for, runs
 * the real script, and compares the set against the ten names Apple lists.
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The exact file names iconutil accepts, from Apple's "Optimizing for High
 * Resolution" guide (HighResolutionOSX/Optimizing): five sizes, each with a
 * @2x twin, and nothing else.
 */
const APPLE_ICONSET = [
  'icon_16x16.png', 'icon_16x16@2x.png',
  'icon_32x32.png', 'icon_32x32@2x.png',
  'icon_128x128.png', 'icon_128x128@2x.png',
  'icon_256x256.png', 'icon_256x256@2x.png',
  'icon_512x512.png', 'icon_512x512@2x.png',
].sort()

/** Run the script with sips/iconutil replaced by recorders; return what they saw. */
function runWithShims() {
  const scratch = mkdtempSync(join(tmpdir(), 'spacefore-icon-'))
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  const log = join(scratch, 'calls.log')

  // sips -z H W <in> --out <path>: record the size and create the file.
  writeFileSync(join(bin, 'sips'), `#!/bin/bash
out=""; h=""; w=""
while [ $# -gt 0 ]; do
  case "$1" in
    -z) h="$2"; w="$3"; shift 3 ;;
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "sips $h $w $(basename "$out")" >> "${log}"
: > "$out"
`)
  // iconutil -c icns <iconset> -o <icns>: record the listing, produce the icns.
  writeFileSync(join(bin, 'iconutil'), `#!/bin/bash
set=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -c) shift 2 ;;
    -o) out="$2"; shift 2 ;;
    *) set="$1"; shift ;;
  esac
done
for f in "$set"/*; do echo "iconutil $(basename "$f")" >> "${log}"; done
: > "$out"
`)
  chmodSync(join(bin, 'sips'), 0o755)
  chmodSync(join(bin, 'iconutil'), 0o755)

  const resources = join(scratch, 'Resources')
  execFileSync('bash', [join(HERE, 'copy-resources.sh'), resources], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: 'pipe',
  })
  const calls = readFileSync(log, 'utf8').trim().split('\n')
  return { scratch, resources, calls }
}

describe('the iconset copy-resources.sh builds', () => {
  const { scratch, resources, calls } = runWithShims()

  it('is exactly the ten names Apple documents', () => {
    const given = calls.filter((line) => line.startsWith('iconutil ')).map((line) => line.slice('iconutil '.length)).sort()
    expect(given).toEqual(APPLE_ICONSET)
  })

  it('renders each @2x at double the pixels its name claims', () => {
    for (const line of calls.filter((line) => line.startsWith('sips '))) {
      const [, height, width, name] = line.split(' ')
      const [, size, scale] = /icon_(\d+)x\d+(@2x)?\.png/.exec(name)
      const expected = Number(size) * (scale ? 2 : 1)
      expect({ name, height: Number(height), width: Number(width) }).toEqual({ name, height: expected, width: expected })
    }
  })

  it('writes the .icns the Info.plist names', () => {
    // CFBundleIconFile is "SpaceFore"; macOS appends .icns.
    expect(existsSync(join(resources, 'SpaceFore.icns'))).toBe(true)
    rmSync(scratch, { recursive: true, force: true })
  })
})
