import { getInput, getBooleanInput } from './github-input.js'
import { setOutput, logNotice, logError, logWarning } from './github-output.js'
import { submitJob, RateLimitError, ControlPlaneError } from './control-plane-client.js'
import { pollUntilTerminal, describeTerminalStatus } from './poll.js'
import { downloadResult, inferResultFilename } from './download.js'
import { reportGitHubFindings } from './github-reporting.js'

const VALID_FORMATS = new Set(['markdown', 'html'])

function readRepositoryContext() {
  const repository = process.env.GITHUB_REPOSITORY
  const sha = process.env.GITHUB_SHA
  if (!repository || !sha) {
    throw new Error('GITHUB_REPOSITORY/GITHUB_SHA are not set - this action must run inside a GitHub Actions job.')
  }
  return {
    repositoryUrl: `https://github.com/${repository}.git`,
    commitSha: sha,
  }
}

export async function run() {
  const apiToken = getInput('api-token', { required: true })
  const apiBaseUrl = getInput('api-base-url', { required: true })
  const format = getInput('format') || 'markdown'
  const strict = getBooleanInput('strict')
  const pollIntervalSeconds = Number(getInput('poll-interval-seconds') || '10')
  const maxWaitSeconds = Number(getInput('max-wait-seconds') || '900')

  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Invalid 'format' input: "${format}" (expected 'markdown' or 'html').`)
  }

  const { repositoryUrl, commitSha } = readRepositoryContext()

  logNotice(`Submitting ${repositoryUrl}@${commitSha} to the Flude control-plane (format=${format}, strict=${strict}).`)

  const jobId = await submitJob(apiBaseUrl, apiToken, {
    repositoryUrl,
    commitSha,
    platform: 'github',
    format,
    strict,
  })
  setOutput('job-id', jobId)
  logNotice(`Job submitted: ${jobId}`)

  const finalStatus = await pollUntilTerminal(apiBaseUrl, apiToken, jobId, {
    intervalMs: pollIntervalSeconds * 1000,
    maxWaitMs: maxWaitSeconds * 1000,
  })

  setOutput('status', finalStatus.status)

  const rejectionMessage = describeTerminalStatus(finalStatus.status)
  if (rejectionMessage) {
    throw new Error(`Job ${jobId} was not fulfilled (${finalStatus.status}): ${rejectionMessage}`)
  }

  if (finalStatus.status !== 'succeeded') {
    throw new Error(
      `Job ${jobId} ended with status '${finalStatus.status}'${finalStatus.error ? `: ${finalStatus.error}` : ''}.`
    )
  }

  if (!finalStatus.result_url) {
    throw new Error(`Job ${jobId} succeeded but the control-plane did not return a result_url.`)
  }

  if (finalStatus.warnings && finalStatus.warnings.length > 0) {
    const warningsText = Array.isArray(finalStatus.warnings) ? finalStatus.warnings.join('\n') : finalStatus.warnings;
    logWarning(`Doxygen warnings:\n${warningsText}`)
  }

  setOutput('result-url', finalStatus.result_url)
  logNotice('Downloading the result archive (the signed URL has a short TTL - do not delay).')

  const destPath = inferResultFilename(finalStatus.result_url)
  await downloadResult(finalStatus.result_url, destPath)
  setOutput('result-path', destPath)
  logNotice(`Result downloaded to ${destPath}`)

  const { sarifPath, summaryPath } = await reportGitHubFindings(destPath)
  if (sarifPath) {
    setOutput('sarif-path', sarifPath)
  }
  if (summaryPath) {
    setOutput('summary-path', summaryPath)
  }
}

// Allow src/index.js to be imported by tests without triggering a real run.
if (process.env.GITHUB_ACTIONS === 'true') {
  run().catch((error) => {
    if (error instanceof RateLimitError) {
      logError(error.message)
    } else if (error instanceof ControlPlaneError) {
      logError(`${error.message}${error.body ? ` (response: ${JSON.stringify(error.body)})` : ''}`)
    } else {
      logError(error.stack || error.message)
    }
    process.exitCode = 1
  })
}
