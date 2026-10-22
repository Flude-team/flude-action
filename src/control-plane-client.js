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
    // An explicit parser_backend the account is not allowed to use: NOT a token problem, so it must not fall through
    // to the "renew your API token" message below.
    if (response.status === 403 && parsed && parsed.error === 'parser_backend_not_allowed') {
      throw new ControlPlaneError(
        `The control-plane refused the job: ${parsed.message || 'this parser_backend is not available for this account'}.`,
        { status: response.status, body: parsed }
      )
    }
    if (response.status === 403 && parsed && typeof parsed.error === 'string' && parsed.error.startsWith('rejected_')) {
      const REASONS = {
        rejected_organization: 'job submitted from an organization account, not a personal one',
        rejected_private: 'repository is not public',
        rejected_repo_organization: 'repository itself is owned by an organization',
        rejected_too_large: 'repository too large'
      }
      const plainReason = REASONS[parsed.error] || parsed.error
      const extraMessage = parsed.message ? ` (${parsed.message})` : ''
      throw new ControlPlaneError(
        `The job was rejected by the free-tier gate: ${plainReason}${extraMessage}.`,
        { status: response.status, body: parsed }
      )
    }
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

export async function submitJob(baseUrl, token, { repositoryUrl, commitSha, platform, format, strict, language, compileCommandsPath, compileCommandsContent, vcxprojPath, vcxprojConfiguration, vcxprojPlatform, bazelBuildPath, bazelTargetName, cmakeListsPath, parserBackend }) {
  const config = {
    language,
    // DEL-B75: compile_commands_path is kept too (harmless, and now actually wired through
    // to job_runner.py) as a fallback for the rare client who committed the file for real --
    // compile_commands_content is the one that actually works for the common .gitignore'd
    // case (see index.js's readCompileCommandsContent()).
    compile_commands_path: compileCommandsPath,
    compile_commands_content: compileCommandsContent,
    vcxproj_path: vcxprojPath,
    vcxproj_configuration: vcxprojConfiguration,
    vcxproj_platform: vcxprojPlatform,
    bazel_build_path: bazelBuildPath,
    bazel_target_name: bazelTargetName,
    cmake_lists_path: cmakeListsPath,
  }
  if (parserBackend) {
    config.parser_backend = parserBackend
  }

  const body = await request(baseUrl, '/v1/jobs', {
    method: 'POST',
    token,
    body: {
      repository_url: repositoryUrl,
      commit_sha: commitSha,
      platform,
      format,
      strict,
      config,
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


