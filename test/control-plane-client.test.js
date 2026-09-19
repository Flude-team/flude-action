import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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

test('submitJob maps vcxprojPath, vcxprojConfiguration, vcxprojPlatform to config payload', async () => {
  let capturedBody = null
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      capturedBody = JSON.parse(raw)
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ job_id: 'test-id' }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await submitJob(baseUrl, 'test-token', {
      ...basePayload,
      vcxprojPath: 'project.vcxproj',
      vcxprojConfiguration: 'Debug',
      vcxprojPlatform: 'ARM64'
    })
    
    assert.ok(capturedBody)
    assert.equal(capturedBody.config.vcxproj_path, 'project.vcxproj')
    assert.equal(capturedBody.config.vcxproj_configuration, 'Debug')
    assert.equal(capturedBody.config.vcxproj_platform, 'ARM64')
  } finally {
    server.close()
  }
})

test('submitJob maps bazelBuildPath, bazelTargetName to config payload', async () => {
  let capturedBody = null
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      capturedBody = JSON.parse(raw)
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ job_id: 'test-id' }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await submitJob(baseUrl, 'test-token', {
      ...basePayload,
      bazelBuildPath: 'src/lib',
      bazelTargetName: 'my_lib'
    })
    
    assert.ok(capturedBody)
    assert.equal(capturedBody.config.bazel_build_path, 'src/lib')
    assert.equal(capturedBody.config.bazel_target_name, 'my_lib')
  } finally {
    server.close()
  }
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
test('submitJob throws free-tier gate ControlPlaneError on HTTP 403 with rejected_organization', async () => {
  await withMockServer({}, async (baseUrl) => {
    try {
      await submitJob(baseUrl, 'test-token', {
        ...basePayload,
        repositoryUrl: 'https://github.com/acme/scenario-403-organization.git',
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof ControlPlaneError)
      assert.match(err.message, /rejected by the free-tier gate/)
      assert.match(err.message, /organization account/)
      assert.doesNotMatch(err.message, /renew it at app.flude.guide/)
      assert.equal(err.status, 403)
      assert.equal(err.body.error, 'rejected_organization')
    }
  })
})

test('submitJob throws free-tier gate ControlPlaneError on HTTP 403 with rejected_private', async () => {
  await withMockServer({}, async (baseUrl) => {
    try {
      await submitJob(baseUrl, 'test-token', {
        ...basePayload,
        repositoryUrl: 'https://github.com/acme/scenario-403-private.git',
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof ControlPlaneError)
      assert.match(err.message, /rejected by the free-tier gate/)
      assert.match(err.message, /not public/)
      assert.doesNotMatch(err.message, /renew it at app.flude.guide/)
    }
  })
})

test('submitJob throws free-tier gate ControlPlaneError on HTTP 403 with rejected_repo_organization', async () => {
  await withMockServer({}, async (baseUrl) => {
    try {
      await submitJob(baseUrl, 'test-token', {
        ...basePayload,
        repositoryUrl: 'https://github.com/acme/scenario-403-repo_organization.git',
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof ControlPlaneError)
      assert.match(err.message, /rejected by the free-tier gate/)
      assert.match(err.message, /owned by an organization/)
      assert.doesNotMatch(err.message, /renew it at app.flude.guide/)
    }
  })
})

test('submitJob throws free-tier gate ControlPlaneError on HTTP 403 with rejected_too_large including message', async () => {
  await withMockServer({}, async (baseUrl) => {
    try {
      await submitJob(baseUrl, 'test-token', {
        ...basePayload,
        repositoryUrl: 'https://github.com/acme/scenario-403-too_large.git',
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof ControlPlaneError)
      assert.match(err.message, /rejected by the free-tier gate/)
      assert.match(err.message, /repository too large/)
      assert.match(err.message, /Size is 500MB/)
      assert.doesNotMatch(err.message, /renew it at app.flude.guide/)
    }
  })
})

test('submitJob shows a generic free-tier gate message (not the token-renewal one) for an unrecognized rejected_* error', async () => {
  await withMockServer({}, async (baseUrl) => {
    try {
      await submitJob(baseUrl, 'test-token', {
        ...basePayload,
        repositoryUrl: 'https://github.com/acme/scenario-403-unknown_reject.git',
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof ControlPlaneError)
      assert.match(err.message, /rejected by the free-tier gate/)
      assert.match(err.message, /rejected_future_reason/)
      assert.doesNotMatch(err.message, /renew it at app.flude.guide/)
    }
  })
})

test('submitJob falls back to token-renewal message on HTTP 403 without rejected_* error', async () => {
  await withMockServer({}, async (baseUrl) => {
    try {
      await submitJob(baseUrl, 'test-token', {
        ...basePayload,
        repositoryUrl: 'https://github.com/acme/scenario-403-not-rejected.git',
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof ControlPlaneError)
      assert.match(err.message, /renew it at app.flude.guide/)
      assert.doesNotMatch(err.message, /free-tier gate/)
    }
  })
})

test('submitJob falls back to token-renewal message on HTTP 403 with no error field', async () => {
  await withMockServer({}, async (baseUrl) => {
    try {
      await submitJob(baseUrl, 'test-token', {
        ...basePayload,
        repositoryUrl: 'https://github.com/acme/scenario-403-no-error.git',
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err instanceof ControlPlaneError)
      assert.match(err.message, /renew it at app.flude.guide/)
      assert.doesNotMatch(err.message, /free-tier gate/)
    }
  })
})

