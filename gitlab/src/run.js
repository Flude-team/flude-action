import { submitJob, RateLimitError, ControlPlaneError } from '../../src/control-plane-client.js'
import { pollUntilTerminal, describeTerminalStatus } from '../../src/poll.js'
import { downloadResult, inferResultFilename } from '../../src/download.js'
import { reportGitLabFindings } from './gitlab-reporting.js'
import { getEnv, getBooleanEnv } from '../../src/env-input.js'

const VALID_FORMATS = new Set(['markdown', 'html'])

function readRepositoryContext() {
  const projectUrl = process.env.CI_PROJECT_URL
  const sha = process.env.CI_COMMIT_SHA
  if (!projectUrl || !sha) {
    throw new Error('CI_PROJECT_URL/CI_COMMIT_SHA are not set - this must run inside a GitLab CI job.')
  }
  // CI_PROJECT_URL never carries embedded credentials (unlike
  // CI_REPOSITORY_URL, which the runner uses to clone the job's own repo
  // and which is not meant to be handed to a third-party API) - appending
  // ".git" gives a plain, public clone URL, the same construction
  // ../../src/index.js uses for GITHUB_REPOSITORY.
  return { repositoryUrl: `${projectUrl}.git`, commitSha: sha }
}

export async function run() {
  const apiToken = getEnv('FLUDE_API_TOKEN', { required: true })
  const apiBaseUrl = getEnv('FLUDE_API_BASE_URL', { required: true })
  const format = getEnv('FLUDE_FORMAT', { defaultValue: 'markdown' })
  const strict = getBooleanEnv('FLUDE_STRICT', { defaultValue: 'false' })
  const pollIntervalSeconds = Number(getEnv('FLUDE_POLL_INTERVAL_SECONDS', { defaultValue: '10' }))
  const maxWaitSeconds = Number(getEnv('FLUDE_MAX_WAIT_SECONDS', { defaultValue: '900' }))
  const codequalityPath = getEnv('FLUDE_CODEQUALITY_PATH', { defaultValue: 'gl-code-quality-report.json' })

  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Invalid FLUDE_FORMAT: "${format}" (expected 'markdown' or 'html').`)
  }

  const { repositoryUrl, commitSha } = readRepositoryContext()

  console.log(
    `Submitting ${repositoryUrl}@${commitSha} to the Flude control-plane (format=${format}, strict=${strict}).`
  )

  const jobId = await submitJob(apiBaseUrl, apiToken, {
    repositoryUrl,
    commitSha,
    platform: 'gitlab',
    format,
    strict,
  })
  console.log(`Job submitted: ${jobId}`)

  const finalStatus = await pollUntilTerminal(apiBaseUrl, apiToken, jobId, {
    intervalMs: pollIntervalSeconds * 1000,
    maxWaitMs: maxWaitSeconds * 1000,
  })

  const rejectionMessage = describeTerminalStatus(finalStatus.status)
  if (rejectionMessage) {
    throw new Error(`Job ${jobId} was not fulfilled (${finalStatus.status}): ${rejectionMessage}`)
  }
  if (finalStatus.status !== 'succeeded') {
    throw new Error(
      `Job ${jobId} ended with status '${finalStatus.status}'${finalStatus.reason ? `: ${finalStatus.reason}` : ''}.`
    )
  }
  if (!finalStatus.result_url) {
    throw new Error(`Job ${jobId} succeeded but the control-plane did not return a result_url.`)
  }

  console.log('Downloading the result archive (the signed URL has a short TTL - do not delay).')
  const destPath = inferResultFilename(finalStatus.result_url)
  await downloadResult(finalStatus.result_url, destPath)
  console.log(`Result downloaded to ${destPath}`)

  await reportGitLabFindings(destPath, { codequalityOutputPath: codequalityPath })
}

// Mirrors ../../src/index.js's GITHUB_ACTIONS guard - lets this module be
// imported by tests without triggering a real run. GitLab Runner sets
// GITLAB_CI=true for every job.
if (process.env.GITLAB_CI === 'true') {
  run().catch((error) => {
    if (error instanceof RateLimitError) {
      console.error(error.message)
    } else if (error instanceof ControlPlaneError) {
      console.error(`${error.message}${error.body ? ` (response: ${JSON.stringify(error.body)})` : ''}`)
    } else {
      console.error(error.stack || error.message)
    }
    process.exitCode = 1
  })
}

