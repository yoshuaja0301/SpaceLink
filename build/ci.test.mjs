// @vitest-environment node
/**
 * The CI workflow, checked against the project it is meant to check.
 *
 * A workflow file is the one thing in a repository that nothing else runs
 * locally, so it rots quietly: rename a script in `package.json`, and CI keeps
 * reporting green for a fortnight until someone notices the job it used to run
 * has been failing at `npm ERR! Missing script` — or worse, was never reached.
 *
 * There is no YAML parser in this project and this is not the place to add a
 * dependency, so the file is read as text. That is enough for the questions
 * worth asking: does every `npm run` name a script that exists, is every job
 * pinned to a runner, and is the expensive one still gated.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(ROOT, '.github/workflows/ci.yml')

const workflow = readFileSync(WORKFLOW, 'utf8')
const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts

/** Every `- run:` line, with its leading dash and indent stripped. */
const commands = [...workflow.matchAll(/^\s*- run: (.+)$/gm)].map((match) => match[1].trim())

describe('the CI workflow', () => {
  it('runs something at all', () => {
    expect(commands.length).toBeGreaterThan(4)
  })

  it('only runs npm scripts that exist', () => {
    // The failure this exists for: a script renamed in package.json, with CI
    // still asking for the old name.
    const asked = commands.filter((command) => command.startsWith('npm run ')).map((command) => command.slice(8))
    expect(asked.length).toBeGreaterThan(0)
    for (const script of asked) expect(Object.keys(scripts), script).toContain(script)
  })

  it('runs the test suite and the build, which is the point of it', () => {
    expect(commands).toContain('npm test')
    expect(commands).toContain('npm run build')
    expect(commands).toContain('npm run e2e')
  })

  it('installs from the lockfile rather than resolving afresh', () => {
    // `npm install` on CI would quietly accept a newer dependency than the one
    // anybody has tested against, which makes a red run impossible to reproduce.
    expect(commands.filter((command) => command === 'npm ci').length).toBeGreaterThan(0)
    expect(commands).not.toContain('npm install')
  })

  it('builds before the end-to-end suites, which refuse a stale dist', () => {
    // e2e/run.mjs exits rather than testing a bundle older than the source. A
    // workflow that ran them the other way round would fail every time.
    const e2eJob = workflow.slice(workflow.indexOf('  e2e:'), workflow.indexOf('  macos:'))
    expect(e2eJob.indexOf('npm run build')).toBeGreaterThan(-1)
    expect(e2eJob.indexOf('npm run build')).toBeLessThan(e2eJob.indexOf('npm run e2e'))
  })

  it('names a runner for every job', () => {
    // Scoped to the `jobs:` block: at two spaces of indent, a trigger and a
    // job look exactly alike, and counting `on:`'s keys as jobs would make
    // this pass for the wrong reason.
    const block = workflow.slice(workflow.indexOf('\njobs:'))
    const jobs = [...block.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1])
    expect(jobs).toEqual(['unit', 'e2e', 'macos'])
    expect([...block.matchAll(/^ {4}runs-on: /gm)]).toHaveLength(jobs.length)
  })

  it('keeps the macOS job off every automatic trigger', () => {
    // This repository is private, where GitHub bills macOS minutes at ten times
    // the Linux rate. The job is worth having; running it on every push is not.
    const macosJob = workflow.slice(workflow.indexOf('  macos:'))
    expect(macosJob).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(macosJob).toContain('macos-latest')
    // And it is the only job that costs that: nothing else asks for a Mac.
    expect([...workflow.matchAll(/macos-latest/g)]).toHaveLength(1)
  })

  it('runs on pull requests, which is what it was asked for', () => {
    const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('concurrency:'))
    expect(triggers).toContain('pull_request:')
    expect(triggers).toContain('workflow_dispatch:')
  })

  it('asks for no more permission than reading the code', () => {
    // A workflow with write access is a workflow that can be turned into one,
    // by anything it runs. Nothing here needs to write.
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toMatch(/contents: write/)
  })

  it('cancels a run whose commit has already been replaced', () => {
    expect(workflow).toContain('cancel-in-progress: true')
  })

  it('pins the Node it runs on, so a runner upgrade is not a surprise', () => {
    const versions = [...workflow.matchAll(/node-version: (\S+)/g)].map((match) => match[1])
    expect(versions.length).toBeGreaterThan(0)
    for (const version of versions) expect(version).toMatch(/^\d+$/)
    expect(new Set(versions).size, 'the jobs disagree about Node').toBe(1)
  })
})
