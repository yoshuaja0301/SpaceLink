/**
 * Runs every end-to-end suite against a freshly built app.
 *
 * Starts `vite preview` itself, waits for it, runs the suites in order, and
 * exits non-zero if any step failed or the page logged an error.
 *
 *   npm run build && npm run e2e
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
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
