import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { buildZip } from '../test-support/zip-builder.js'
import { buildSarifDocument } from '../test-support/sarif-fixture.js'
import { createMockBitbucketApi } from '../test-support/bitbucket-mock-server.js'
import { reportBitbucketFindings, REPORT_ID } from '../bitbucket/src/bitbucket-reporting.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'flude-action-bitbucket-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function withMockBitbucket(fn) {
  const { server, requests } = createMockBitbucketApi()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`, requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
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

test('reportBitbucketFindings converts SARIF findings into a report + annotations', async () => {
  await withTempDir(async (dir) => {
    const sarif = buildSarifDocument([
      { ruleId: 'undocumented-entity', level: 'error', message: 'first error', file: 'src/a.py', line: 10 },
      { ruleId: 'low-quality-docstring', level: 'warning', message: 'a warning', file: 'src/b.py', line: 5 },
      { ruleId: 'api-added', level: 'note', message: 'no location note', file: null, line: null },
    ])
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'report.sarif', content: sarif, method: 'deflate' }]))

    await withMockBitbucket(async (baseUrl, requests) => {
      const capture = captureConsole()
      let result
      try {
        result = await reportBitbucketFindings(archivePath, {
          baseUrl,
          workspace: 'acme',
          repoSlug: 'widget',
          commit: 'deadbeef',
        })
      } finally {
        capture.restore()
      }

      assert.equal(result.reported, true)
      assert.equal(result.findings.length, 3)

      const reportRequest = requests.find((r) => r.method === 'PUT')
      assert.ok(reportRequest)
      assert.equal(reportRequest.url, `/2.0/repositories/acme/widget/commit/deadbeef/reports/${REPORT_ID}`)
      assert.equal(reportRequest.body.report_type, 'BUG')
      assert.equal(reportRequest.body.result, 'FAILED')
      assert.deepEqual(
        reportRequest.body.data.find((d) => d.title === 'Findings'),
        { title: 'Findings', type: 'NUMBER', value: 3 }
      )

      const annotationsRequest = requests.find((r) => r.method === 'POST')
      assert.ok(annotationsRequest)
      assert.equal(
        annotationsRequest.url,
        `/2.0/repositories/acme/widget/commit/deadbeef/reports/${REPORT_ID}/annotations`
      )
      // The note without a file/line is excluded - only 2 of the 3 findings
      // carry a complete location.
      assert.equal(annotationsRequest.body.length, 2)
      const errorAnnotation = annotationsRequest.body.find((a) => a.path === 'src/a.py')
      assert.equal(errorAnnotation.severity, 'HIGH')
      assert.equal(errorAnnotation.annotation_type, 'CODE_SMELL')
      assert.equal(errorAnnotation.line, 10)
      assert.match(errorAnnotation.summary, /first error/)
      assert.match(errorAnnotation.external_id, /^flude-[0-9a-f]{32}$/)

      const warningAnnotation = annotationsRequest.body.find((a) => a.path === 'src/b.py')
      assert.equal(warningAnnotation.severity, 'MEDIUM')
    })
  })
})

test('reportBitbucketFindings chunks more than 100 annotations into multiple POSTs', async () => {
  await withTempDir(async (dir) => {
    const findings = Array.from({ length: 150 }, (_, i) => ({
      ruleId: `RULE-${i}`,
      level: 'warning',
      message: `finding ${i}`,
      file: `src/file${i}.py`,
      line: i + 1,
    }))
    const sarif = buildSarifDocument(findings)
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'report.sarif', content: sarif, method: 'deflate' }]))

    await withMockBitbucket(async (baseUrl, requests) => {
      const capture = captureConsole()
      try {
        await reportBitbucketFindings(archivePath, { baseUrl, workspace: 'acme', repoSlug: 'widget', commit: 'abc' })
      } finally {
        capture.restore()
      }

      const postRequests = requests.filter((r) => r.method === 'POST')
      assert.equal(postRequests.length, 2)
      assert.equal(postRequests[0].body.length, 100)
      assert.equal(postRequests[1].body.length, 50)
    })
  })
})

test('reportBitbucketFindings degrades gracefully when the archive has no report.sarif', async () => {
  await withTempDir(async (dir) => {
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'docs.md', content: '# hello' }]))

    await withMockBitbucket(async (baseUrl, requests) => {
      const capture = captureConsole()
      let result
      try {
        result = await reportBitbucketFindings(archivePath, {
          baseUrl,
          workspace: 'acme',
          repoSlug: 'widget',
          commit: 'abc',
        })
      } finally {
        capture.restore()
      }

      assert.equal(result.reported, false)
      assert.deepEqual(result.findings, [])
      assert.equal(requests.length, 0)
    })
  })
})

test('reportBitbucketFindings skips the annotations call entirely when nothing is annotatable', async () => {
  await withTempDir(async (dir) => {
    const sarif = buildSarifDocument([{ ruleId: 'api-added', level: 'note', message: 'no location', file: null, line: null }])
    const archivePath = join(dir, 'result.zip')
    await writeFile(archivePath, buildZip([{ name: 'report.sarif', content: sarif, method: 'deflate' }]))

    await withMockBitbucket(async (baseUrl, requests) => {
      const capture = captureConsole()
      try {
        await reportBitbucketFindings(archivePath, { baseUrl, workspace: 'acme', repoSlug: 'widget', commit: 'abc' })
      } finally {
        capture.restore()
      }

      assert.equal(requests.length, 1)
      assert.equal(requests[0].method, 'PUT')
    })
  })
})
