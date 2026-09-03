import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildZip } from '../test-support/zip-builder.js'
import { buildSarifDocument } from '../test-support/sarif-fixture.js'
import { reportGitHubFindings } from '../src/github-reporting.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'flude-action-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function captureConsole() {
  const logs = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args) => logs.push(args.join(' '))
  console.warn = (...args) => logs.push(args.join(' '))
  return {
    logs,
    restore: () => {
      console.log = originalLog
      console.warn = originalWarn
    },
  }
}

test('reportGitHubFindings extracts SARIF, annotates errors, and writes the step summary', async () => {
  await withTempDir(async (dir) => {
    const sarif = buildSarifDocument([
      { ruleId: 'ERR1', level: 'error', message: 'first error', file: 'src/a.py', line: 10 },
      { ruleId: 'WARN1', level: 'warning', message: 'a warning', file: 'src/b.py', line: null },
      { ruleId: 'ERR2', level: 'error', message: 'second error', file: null, line: null },
    ])
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'report.sarif', content: sarif, method: 'deflate' }]))

    const summaryPath = join(dir, 'step-summary.md')
    await writeFile(summaryPath, '')
    process.env.GITHUB_STEP_SUMMARY = summaryPath

    const capture = captureConsole()
    let result
    try {
      result = await reportGitHubFindings(archivePath, { sarifOutputPath: join(dir, 'flude-report.sarif') })
    } finally {
      capture.restore()
      delete process.env.GITHUB_STEP_SUMMARY
    }

    assert.equal(result.findings.length, 3)
    assert.ok(result.sarifPath)

    const extractedSarif = await readFile(result.sarifPath, 'utf8')
    assert.deepEqual(JSON.parse(extractedSarif), JSON.parse(sarif))

    assert.ok(capture.logs.some((line) => line === '::error file=src/a.py,line=10::[ERR1] first error'))
    assert.ok(capture.logs.some((line) => line === '::error::[ERR2] second error'))
    assert.ok(!capture.logs.some((line) => line.includes('WARN1')), 'warning-level findings should not get an ::error:: annotation')

    const summary = await readFile(summaryPath, 'utf8')
    assert.match(summary, /3 finding\(s\)/)
    assert.ok(summary.includes('first error'))
    assert.ok(summary.includes('a warning'))
    assert.ok(summary.includes('second error'))
  })
})

test('reportGitHubFindings degrades gracefully when the archive has no report.sarif', async () => {
  await withTempDir(async (dir) => {
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'docs.md', content: '# hello' }]))

    const capture = captureConsole()
    let result
    try {
      result = await reportGitHubFindings(archivePath, { sarifOutputPath: join(dir, 'flude-report.sarif') })
    } finally {
      capture.restore()
    }

    assert.equal(result.sarifPath, null)
    assert.deepEqual(result.findings, [])
    assert.ok(capture.logs.some((line) => line.includes('::warning::') && line.includes('report.sarif')))
  })
})

test('reportGitHubFindings degrades gracefully when the archive is not a ZIP at all', async () => {
  await withTempDir(async (dir) => {
    const archivePath = join(dir, 'result.bin')
    await writeFile(archivePath, 'not a zip file')

    const capture = captureConsole()
    let result
    try {
      result = await reportGitHubFindings(archivePath, { sarifOutputPath: join(dir, 'flude-report.sarif') })
    } finally {
      capture.restore()
    }

    assert.equal(result.sarifPath, null)
    assert.deepEqual(result.findings, [])
  })
})
