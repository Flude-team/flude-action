import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withMockServer } from '../test-support/helpers.js'
import { submitJob } from '../src/control-plane-client.js'
import { pollUntilTerminal, describeTerminalStatus } from '../src/poll.js'

const noSleep = () => Promise.resolve()

const basePayload = {
  repositoryUrl: 'https://github.com/acme/widget.git',
  commitSha: 'abc123',
  platform: 'github',
  format: 'markdown',
  strict: false,
}

test('pollUntilTerminal resolves with a succeeded status', async () => {
  await withMockServer({}, async (baseUrl) => {
    const jobId = await submitJob(baseUrl, 'test-token', basePayload)
    const result = await pollUntilTerminal(baseUrl, 'test-token', jobId, {
      intervalMs: 1,
      maxWaitMs: 5000,
      sleep: noSleep,
    })
    assert.equal(result.status, 'succeeded')
    assert.ok(result.result_url)
  })
})

test('pollUntilTerminal surfaces a free-gate rejection as a terminal status', async () => {
  await withMockServer({}, async (baseUrl) => {
    const jobId = await submitJob(baseUrl, 'test-token', {
      ...basePayload,
      repositoryUrl: 'https://github.com/acme/scenario-reject-too-large.git',
    })
    const result = await pollUntilTerminal(baseUrl, 'test-token', jobId, {
      intervalMs: 1,
      maxWaitMs: 5000,
      sleep: noSleep,
    })
    assert.equal(result.status, 'rejected_too_large')
    assert.match(describeTerminalStatus(result.status), /5 MB/)
  })
})

test('pollUntilTerminal surfaces an engine failure', async () => {
  await withMockServer({}, async (baseUrl) => {
    const jobId = await submitJob(baseUrl, 'test-token', {
      ...basePayload,
      repositoryUrl: 'https://github.com/acme/scenario-fail.git',
    })
    const result = await pollUntilTerminal(baseUrl, 'test-token', jobId, {
      intervalMs: 1,
      maxWaitMs: 5000,
      sleep: noSleep,
    })
    assert.equal(result.status, 'failed')
    assert.equal(describeTerminalStatus(result.status), null)
  })
})

test('pollUntilTerminal times out via the client-side safety net', async () => {
  await withMockServer({}, async (baseUrl) => {
    const jobId = await submitJob(baseUrl, 'test-token', basePayload)
    await assert.rejects(
      () => pollUntilTerminal(baseUrl, 'test-token', jobId, { intervalMs: 1, maxWaitMs: 0, sleep: noSleep }),
      /safety net/
    )
  })
})
