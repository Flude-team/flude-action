// HTTP client for the Flude SaaS control-plane.
//
// IMPORTANT: the control-plane (DEL-B23) does not exist yet as of this writing.
// The endpoint shapes and status vocabulary below are this repo's best-effort
// assumption of the contract described in monetization.md / Delivery_ToDo.md
// (DEL-B22/DEL-B23), encoded here and in test/mock-server.js so this action is
// independently testable. Once DEL-B23 ships a real API, reconcile this file
// (and the mock) against it - do not assume this guess is exact.

export class ControlPlaneError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
    this.body = body
  }
}

export class RateLimitError extends ControlPlaneError {
  constructor(message, options) {
    super(message, options)
    this.name = 'RateLimitError'
  }
}

async function request(baseUrl, path, { method = 'GET', token, body } = {}) {
  const url = new URL(path, baseUrl).toString()
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const rawText = await response.text()
  let parsed = null
  if (rawText) {
    try {
      parsed = JSON.parse(rawText)
    } catch {
      // Non-JSON body (e.g. an upstream proxy error page) - surface it raw.
      parsed = { raw: rawText }
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new ControlPlaneError(
      'The control-plane rejected the API token. Create or renew it at app.flude.guide ' +
        'and update the repository/organization secret.',
      { status: response.status, body: parsed }
    )
  }
  if (response.status === 429) {
    throw new RateLimitError(
      'Rate limit exceeded (Stage 1: 5 jobs/day during the first week of an account, then 1/day).',
      { status: response.status, body: parsed }
    )
  }
  if (!response.ok) {
    throw new ControlPlaneError(
      `Control-plane request failed: ${method} ${path} -> HTTP ${response.status}`,
      { status: response.status, body: parsed }
    )
  }
  return parsed
}

export async function submitJob(baseUrl, token, { repositoryUrl, commitSha, platform, format, strict, language }) {
  const body = await request(baseUrl, '/v1/jobs', {
    method: 'POST',
    token,
    body: {
      repository_url: repositoryUrl,
      commit_sha: commitSha,
      platform,
      format,
      strict,
    },
  })
  if (!body || !body.job_id) {
    throw new ControlPlaneError('Control-plane accepted the job but did not return a job_id.', { body })
  }
  return body.job_id
}

export async function getJobStatus(baseUrl, token, jobId) {
  const body = await request(baseUrl, `/v1/jobs/${encodeURIComponent(jobId)}`, { token })
  if (!body || !body.status) {
    throw new ControlPlaneError('Control-plane returned a job status response without a status field.', { body })
  }
  return body
}

