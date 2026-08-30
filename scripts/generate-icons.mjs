#!/usr/bin/env node
// @ts-check
/**
 * Draws the app icons.
 *
 * They are generated rather than committed as opaque binaries so the mark can
 * be changed in one place and stay consistent across every size. No image
 * library is involved: the shapes are simple enough to rasterise directly, and
 * a PNG is a zlib stream with a few length-prefixed chunks around it.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/** The mark: a small graph, matching favicon.svg. Coordinates are 0..1. */
const BACKGROUND = [0x1e, 0x1e, 0x22]
const ACCENT = [0x7c, 0x5c, 0xff]
const EDGE = [0x7c, 0x5c, 0xff, 0x66]

const NODES = [
  { x: 0.32, y: 0.32, r: 0.1 },
  { x: 0.7, y: 0.44, r: 0.075 },
  { x: 0.42, y: 0.72, r: 0.075 },
]
const EDGES = [
  [0, 1],
  [0, 2],
  [1, 2],
]

/**
 * One pixel's colour, blended over what is already there.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} x
 * @param {number} y
 * @param {number[]} colour  [r, g, b] or [r, g, b, a]
 * @param {number} coverage  0..1, how much of the pixel the shape covers
 */
function blend(pixels, width, x, y, colour, coverage) {
  if (coverage <= 0) return
  const alpha = (colour[3] ?? 255) / 255
  const amount = Math.min(1, coverage) * alpha
  const offset = (y * width + x) * 4
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.round(pixels[offset + channel] * (1 - amount) + colour[channel] * amount)
  }
  pixels[offset + 3] = 255
}

/**
 * Coverage of a pixel by a circle, sampled 3x3 so edges are not jagged.
 * @param {number} px @param {number} py @param {number} cx @param {number} cy @param {number} radius
 */
function circleCoverage(px, py, cx, cy, radius) {
  let hits = 0
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const dx = px + (sx + 0.5) / 3 - cx
      const dy = py + (sy + 0.5) / 3 - cy
      if (dx * dx + dy * dy <= radius * radius) hits += 1
    }
  }
  return hits / 9
}

/** Distance from a point to a line segment, for stroking the edges. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  const nx = ax + t * dx - px
  const ny = ay + t * dy - py
  return Math.sqrt(nx * nx + ny * ny)
}

/**
 * @param {number} size
 * @param {{ rounded?: boolean }} [options]
 * @returns {Uint8Array} RGBA pixels
 */
function draw(size, { rounded = true } = {}) {
  const pixels = new Uint8Array(size * size * 4)
  const radius = size * 0.22 // corner radius, iOS-ish

  // Background, with rounded corners when the platform does not mask for us.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 1
      if (rounded) {
        const cx = Math.min(Math.max(x + 0.5, radius), size - radius)
        const cy = Math.min(Math.max(y + 0.5, radius), size - radius)
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        const distance = Math.sqrt(dx * dx + dy * dy)
        inside = distance <= radius ? 1 : Math.max(0, 1 - (distance - radius))
      }
      blend(pixels, size, x, y, BACKGROUND, inside)
    }
  }

  const stroke = size * 0.018
  for (const [from, to] of EDGES) {
    const a = NODES[from]
    const b = NODES[to]
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const distance = distanceToSegment(
          x + 0.5,
          y + 0.5,
          a.x * size,
          a.y * size,
          b.x * size,
          b.y * size,
        )
        if (distance <= stroke) blend(pixels, size, x, y, EDGE, 1)
        else if (distance <= stroke + 1) blend(pixels, size, x, y, EDGE, stroke + 1 - distance)
      }
    }
  }

  for (const node of NODES) {
    const cx = node.x * size
    const cy = node.y * size
    const r = node.r * size
    for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y += 1) {
      for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x += 1) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        blend(pixels, size, x, y, ACCENT, circleCoverage(x, y, cx, cy, r))
      }
    }
  }

  return pixels
}

/** CRC-32, as PNG defines it. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * @param {Uint8Array} pixels
 * @param {number} size
 */
function encodePng(pixels, size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple
  // and the icons compress well regardless.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

await mkdir(PUBLIC_DIR, { recursive: true })

const icons = [
  { name: 'icon-192.png', size: 192, rounded: true },
  { name: 'icon-512.png', size: 512, rounded: true },
  // Maskable icons are cropped to a circle by the launcher, so this one fills
  // the square and keeps the mark inside the safe area.
  { name: 'icon-maskable-512.png', size: 512, rounded: false },
  { name: 'apple-touch-icon.png', size: 180, rounded: false },
]

for (const icon of icons) {
  const png = encodePng(draw(icon.size, { rounded: icon.rounded }), icon.size)
  await writeFile(join(PUBLIC_DIR, icon.name), png)
  process.stdout.write(`${icon.name.padEnd(24)} ${icon.size}×${icon.size}  ${(png.length / 1024).toFixed(1)} kB\n`)
}
