/**
 * Runs every end-to-end suite against a freshly built app.
 *
 * Starts `vite preview` itself, waits for it, runs the suites in order, and
 * exits non-zero if any step failed or the page logged an error.
 *
 *   npm run build && npm run e2e
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.SPACEFORE_E2E_PORT ?? 4173)
const URL = `http://localhost:${PORT}/`

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The preview server never came up on ${URL}. Did you run \`npm run build\` first?`)
}

/**
 * Refuse to test a build older than the source it came from.
 *
 * These suites run against `dist/`, and `npm run build` typechecks first — so a
 * type error means no new bundle and the *previous* one is still sitting there.
 * Every check then runs against code that no longer exists, which is worse than
 * a failure: a fix appears not to work, or a deliberately broken thing appears
 * to pass. That third one is how a mutation test quietly lies to you.
 */
function newestChange(directory, newest = 0) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    newest = entry.isDirectory() ? newestChange(path, newest) : Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

const root = join(here, '..')
let built
try {
  built = statSync(join(root, 'dist', 'index.html')).mtimeMs
} catch {
  console.error('There is no dist/ to test. Run `npm run build` first.')
  process.exit(1)
}

const changed = Math.max(
  ...['src', 'public', 'index.html', 'vite.config.ts', 'build'].map((entry) => {
    try {
      const path = join(root, entry)
      return statSync(path).isDirectory() ? newestChange(path) : statSync(path).mtimeMs
    } catch {
      return 0
    }
  }),
)

if (changed > built) {
  const age = Math.round((changed - built) / 1000)
  console.error(
    `dist/ is ${age}s older than the source. Run \`npm run build\` — and read its output: ` +
      'a typecheck error leaves the previous bundle in place, and these suites would test that instead.',
  )
  process.exit(1)
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: join(here, '..'),
  stdio: 'ignore',
  detached: false,
})

let failed = 0
try {
  await waitForServer()

  const suites = readdirSync(here)
    .filter((name) => /^\d\d-.*\.mjs$/.test(name))
    .sort()

  for (const suite of suites) {
    const code = await new Promise((resolve) => {
      const run = spawn(process.execPath, [join(here, suite)], {
        stdio: 'inherit',
        env: { ...process.env, SPACEFORE_E2E_URL: URL },
      })
      run.on('exit', (value) => resolve(value ?? 1))
    })
    if (code !== 0) failed += 1
  }

  console.log(failed === 0 ? '\nAll end-to-end suites passed.' : `\n${failed} suite(s) reported problems.`)
} finally {
  server.kill('SIGTERM')
}

process.exit(failed === 0 ? 0 : 1)
