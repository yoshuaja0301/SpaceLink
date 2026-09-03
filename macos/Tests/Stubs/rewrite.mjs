/**
 * Rewrite only what Objective-C interop provides, which does not exist off
 * Apple's platforms: `#selector(…)` becomes `Selector("…")`, and `@objc` is
 * dropped. Nothing else is touched — the point is to typecheck the real code.
 */
import { readFileSync, writeFileSync } from 'node:fs'
let text = readFileSync(process.argv[2], 'utf8')

let out = ''
let at = 0
for (;;) {
  const start = text.indexOf('#selector(', at)
  if (start === -1) { out += text.slice(at); break }
  out += text.slice(at, start)
  // Walk to the matching close paren, so `#selector(NSApplication.hide(_:))`
  // is taken whole rather than cut at the first `)`.
  let depth = 0
  let i = start + '#selector'.length
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') { depth -= 1; if (depth === 0) break }
  }
  const inner = text.slice(start + '#selector('.length, i)
  out += `Selector(${JSON.stringify(inner)})`
  at = i + 1
}
writeFileSync(process.argv[3], out.replace(/@objc /g, ''))
