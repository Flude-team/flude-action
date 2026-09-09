import { submitJob, RateLimitError, ControlPlaneError } from '../../src/control-plane-client.js'
import { pollUntilTerminal, describeTerminalStatus } from '../../src/poll.js'
import { downloadResult, inferResultFilename } from '../../src/download.js'
import { reportBitbucketFindings } from './bitbucket-reporting.js'
import { getEnv, getBooleanEnv } from '../../src/env-input.js'

const VALID_FORMATS = new Set(['hugo_markdown', 'html'])

function readRepositoryContext() {
  // BITBUCKET_REPO_FULL_NAME ("workspace/repo_slug") and BITBUCKET_COMMIT
  // are Bitbucket Pipelines' own default variables (confirmed against
  // Atlassian's docs) - splitting the former avoids depending on a separate
  // BITBUCKET_WORKSPACE variable that isn't documented as reliably present.
  const fullName = process.env.BITBUCKET_REPO_FULL_NAME
  const commitSha = process.env.BITBUCKET_COMMIT
  if (!fullName || !commitSha) {
    throw new Error(
      'BITBUCKET_REPO_FULL_NAME/BITBUCKET_COMMIT are not set - this must run inside a Bitbucket Pipelines step.'
    )
  }
  const [workspace, repoSlug] = fullName.split('/')
  if (!workspace || !repoSlug) {
    throw new Error(`Unexpected BITBUCKET_REPO_FULL_NAME shape: "${fullName}" (expected "workspace/repo_slug").`)
  }
  // Same construction pattern as the GitHub/GitLab clients' own
  // repositoryUrl (https://<host>/<owner>/<repo>.git) - the control-plane
  // clones the repository itself, there is no separate "path to sources"
  // input.
  return { repositoryUrl: `https://bitbucket.org/${fullName}.git`, commitSha, workspace, repoSlug }
}

export async function run() {
  const apiToken = getEnv('FLUDE_API_TOKEN', { required: true })
  const apiBaseUrl = getEnv('FLUDE_API_BASE_URL', { required: true })
  const format = getEnv('FLUDE_FORMAT', { defaultValue: 'markdown' })
  const strict = getBooleanEnv('FLUDE_STRICT', { defaultValue: 'false' })
  const language = getEnv('FLUDE_LANGUAGE') || 'python'
  const pollIntervalSeconds = Number(getEnv('FLUDE_POLL_INTERVAL_SECONDS', { defaultValue: '10' }))
  const maxWaitSeconds = Number(getEnv('FLUDE_MAX_WAIT_SECONDS', { defaultValue: '900' }))
  // Real Bitbucket Pipelines routes Bitbucket API calls through a fixed
  // local proxy (see bitbucket-insights-client.js) - overridable only so
  // this repo's own tests can point it at a mock instead.
  const bitbucketApiBaseUrl = getEnv('BITBUCKET_API_BASE_URL', { defaultValue: 'http://localhost:29418' })

  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Invalid FLUDE_FORMAT: "${format}" (expected 'hugo_markdown' or 'html').`)
  }

  const { repositoryUrl, commitSha, workspace, repoSlug } = readRepositoryContext()

  console.log(
    `Submitting ${repositoryUrl}@${commitSha} to the Flude control-plane (format=${format}, strict=${strict}).`
  )

  const jobId = await submitJob(apiBaseUrl, apiToken, {
    repositoryUrl,
    commitSha,
    platform: 'bitbucket',
    format,
    strict,
      language,
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

  await reportBitbucketFindings(destPath, { baseUrl: bitbucketApiBaseUrl, workspace, repoSlug, commit: commitSha })
}

// Mirrors ../../src/index.js's GITHUB_ACTIONS guard and gitlab/src/run.js's
// GITLAB_CI guard - lets this module be imported by tests without
// triggering a real run. Bitbucket Pipelines sets BITBUCKET_BUILD_NUMBER for
// every step; there is no simple boolean equivalent to GITHUB_ACTIONS/
// GITLAB_CI documented, but a build number is always present and non-empty
// in a real step.
if (process.env.BITBUCKET_BUILD_NUMBER) {
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

