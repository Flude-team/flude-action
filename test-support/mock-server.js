import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

// A minimal stand-in for the not-yet-built DEL-B23 control-plane API, used only
// for this repo's own tests and the e2e workflow. The real contract (exact
// endpoint shapes and status strings) is NOT finalized - this mock encodes
// this repo's best-effort assumption (see src/control-plane-client.js) and
// must be reconciled with the real control-plane once DEL-B23 ships.
//
// Test-only convention: the scenario is picked by looking for a
// "scenario-<name>" marker inside the submitted repository_url. Real job
// submissions never need this - it exists purely so tests can steer the mock
// without a bespoke request field that the real API wouldn't have.

const SCENARIOS = {
  'reject-too-large': () => ({ status: 'rejected_too_large' }),
  'reject-organization': () => ({ status: 'rejected_organization' }),
  'reject-private': () => ({ status: 'rejected_private' }),
  fail: () => ({ status: 'failed', error: 'simulated engine failure' }),
}

function scenarioFromRepositoryUrl(repositoryUrl) {
  for (const name of Object.keys(SCENARIOS)) {
    if (repositoryUrl.includes(`scenario-${name}`)) return name
  }
  return 'succeed'
}

export function createMockControlPlane({ token = 'test-token', resultBody = 'fake archive contents' } = {}) {
  const jobs = new Map()

  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }

    if (req.method === 'GET' && req.url.startsWith('/fake-results/')) {
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      res.end(resultBody)
      return
    }

    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${token}`) {
      send(401, { error: 'invalid token' })
      return
    }

    if (req.method === 'POST' && req.url === '/v1/jobs') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const payload = rawBody ? JSON.parse(rawBody) : {}

      if ((payload.repository_url || '').includes('scenario-rate-limited')) {
        send(429, { error: 'rate limit exceeded' })
        return
      }

      const jobId = randomUUID()
      jobs.set(jobId, { scenario: scenarioFromRepositoryUrl(payload.repository_url || ''), pollCount: 0 })
      send(202, { job_id: jobId })
      return
    }

    const match = req.method === 'GET' && req.url.match(/^\/v1\/jobs\/([^/]+)$/)
    if (match) {
      const job = jobs.get(match[1])
      if (!job) {
        send(404, { error: 'unknown job' })
        return
      }
      job.pollCount += 1

      // Simulate one 'running' tick before resolving successful jobs, so
      // pollUntilTerminal's polling loop is actually exercised.
      if (job.pollCount < 2 && job.scenario === 'succeed') {
        send(200, { status: 'running' })
        return
      }

      if (job.scenario === 'succeed') {
        send(200, {
          status: 'succeeded',
          result_url: `http://127.0.0.1:${server.address().port}/fake-results/${match[1]}.zip`,
        })
        return
      }

      send(200, SCENARIOS[job.scenario]())
      return
    }

    send(404, { error: 'not found' })
  })

  return server
}
