import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { withMockServer } from '../test-support/helpers.js'
import { downloadResult, inferResultFilename } from '../src/download.js'

test('inferResultFilename extracts a filename from the URL path', () => {
  assert.equal(inferResultFilename('https://storage.googleapis.com/bucket/jobs/abc.zip?sig=xyz'), 'abc.zip')
  assert.equal(inferResultFilename('not a url'), 'flude-result.zip')
})

test('downloadResult writes the response body to disk', async () => {
  await withMockServer({ resultBody: 'hello archive' }, async (baseUrl) => {
    const dest = 'test-download-tmp.zip'
    try {
      await downloadResult(`${baseUrl}/fake-results/anything.zip`, dest)
      const contents = await readFile(dest, 'utf8')
      assert.equal(contents, 'hello archive')
    } finally {
      await rm(dest, { force: true })
    }
  })
})
