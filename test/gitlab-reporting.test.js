import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildZip } from '../test-support/zip-builder.js'
import { buildCodequalityDocument } from '../test-support/codequality-fixture.js'
import { reportGitLabFindings } from '../gitlab/src/gitlab-reporting.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'flude-action-gitlab-test-'))
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

test('reportGitLabFindings extracts codequality.json and writes the report', async () => {
  await withTempDir(async (dir) => {
    const findings = [
      { ruleId: 'undocumented-entity', entityName: 'Foo::bar', message: "Method 'bar' is undocumented.", level: 'warning', file: 'src/foo.cpp', line: 42 },
      { ruleId: 'api-removed', entityName: 'Foo::baz', message: "Entity 'baz' removed.", level: 'error', file: 'src/foo.cpp', line: 7 },
    ]
    const codequality = buildCodequalityDocument(findings)
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'codequality.json', content: codequality, method: 'deflate' }]))

    const outputPath = join(dir, 'gl-code-quality-report.json')
    const capture = captureConsole()
    let result
    try {
      result = await reportGitLabFindings(archivePath, { codequalityOutputPath: outputPath })
    } finally {
      capture.restore()
    }

    assert.equal(result.findings.length, 2)
    assert.equal(result.codequalityPath, outputPath)

    const written = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(written.length, 2)
    assert.equal(written[0].check_name, 'undocumented-entity')
    assert.equal(written[0].severity, 'minor')
    assert.equal(written[0].location.path, 'src/foo.cpp')
    assert.equal(written[0].location.lines.begin, 42)
    assert.equal(written[1].severity, 'major')
    assert.match(written[0].fingerprint, /^[0-9a-f]{32}$/)

    assert.ok(capture.logs.some((line) => line.includes('2 finding(s) written to')))
  })
})

test('reportGitLabFindings degrades gracefully when the archive has no codequality.json', async () => {
  await withTempDir(async (dir) => {
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'docs.md', content: '# hello' }]))

    const capture = captureConsole()
    let result
    try {
      result = await reportGitLabFindings(archivePath, { codequalityOutputPath: join(dir, 'out.json') })
    } finally {
      capture.restore()
    }

    assert.equal(result.codequalityPath, null)
    assert.deepEqual(result.findings, [])
    assert.ok(capture.logs.some((line) => line.includes('codequality.json')))
  })
})

test('reportGitLabFindings degrades gracefully when the archive is not a ZIP at all', async () => {
  await withTempDir(async (dir) => {
    const archivePath = join(dir, 'result.bin')
    await writeFile(archivePath, 'not a zip file')

    const capture = captureConsole()
    let result
    try {
      result = await reportGitLabFindings(archivePath, { codequalityOutputPath: join(dir, 'out.json') })
    } finally {
      capture.restore()
    }

    assert.equal(result.codequalityPath, null)
    assert.deepEqual(result.findings, [])
  })
})

test('reportGitLabFindings degrades gracefully when the entry is present but not valid JSON', async () => {
  await withTempDir(async (dir) => {
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'codequality.json', content: 'not json' }]))

    const capture = captureConsole()
    let result
    try {
      result = await reportGitLabFindings(archivePath, { codequalityOutputPath: join(dir, 'out.json') })
    } finally {
      capture.restore()
    }

    assert.equal(result.codequalityPath, null)
    assert.deepEqual(result.findings, [])
    assert.ok(capture.logs.some((line) => line.includes('could not be parsed')))
  })
})
