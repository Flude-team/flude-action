import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withMockServer } from '../test-support/helpers.js'
import { submitJob, getJobStatus, ControlPlaneError, RateLimitError } from '../src/control-plane-client.js'

const basePayload = {
  repositoryUrl: 'https://github.com/acme/widget.git',
  commitSha: 'abc123',
  platform: 'github',
  format: 'hugo_markdown',
  strict: false,
}

test('submitJob returns a job id on success', async () => {
  await withMockServer({}, async (baseUrl) => {
    const jobId = await submitJob(baseUrl, 'test-token', basePayload)
    assert.equal(typeof jobId, 'string')
    assert.ok(jobId.length > 0)
  })
})

test('submitJob throws ControlPlaneError on an invalid token', async () => {
  await withMockServer({ token: 'real-token' }, async (baseUrl) => {
    await assert.rejects(() => submitJob(baseUrl, 'wrong-token', basePayload), ControlPlaneError)
  })
})

test('submitJob throws RateLimitError on HTTP 429', async () => {
  await withMockServer({}, async (baseUrl) => {
    await assert.rejects(
      () =>
        submitJob(baseUrl, 'test-token', {
          ...basePayload,
          repositoryUrl: 'https://github.com/acme/scenario-rate-limited.git',
        }),
      RateLimitError
    )
  })
})

test('getJobStatus reports running then a terminal status', async () => {
  await withMockServer({}, async (baseUrl) => {
    const jobId = await submitJob(baseUrl, 'test-token', basePayload)
    const first = await getJobStatus(baseUrl, 'test-token', jobId)
    assert.equal(first.status, 'running')
    const second = await getJobStatus(baseUrl, 'test-token', jobId)
    assert.equal(second.status, 'succeeded')
    assert.ok(second.result_url)
  })
})
