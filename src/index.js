import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getInput, getBooleanInput } from './github-input.js'
import { setOutput, logNotice, logError, logWarning } from './github-output.js'
import { submitJob, RateLimitError, ControlPlaneError } from './control-plane-client.js'
import { pollUntilTerminal, describeTerminalStatus } from './poll.js'
import { downloadResult, inferResultFilename } from './download.js'
import { reportGitHubFindings } from './github-reporting.js'

const VALID_FORMATS = new Set(['hugo_markdown', 'html'])
const VALID_PARSER_BACKENDS = new Set(['doxygen', 'syntactic'])

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

// DEL-B75: compile_commands.json is conventionally .gitignore'd, so passing only its path
// through to the control-plane never worked -- flude-worker's own independent clone of the
// repository never has the file, and the mismatch previously failed silently server-side (one
// log line the client never sees). This step runs on the client's own runner, right after their
// build step generated the file, so it can just read it here and send the content instead.
// Matches control-plane's own MAX_COMPILE_COMMANDS_CONTENT_BYTES cap (900 KiB) -- checked
// client-side too so an oversized file fails fast with a clear message here, not a vague 400
// from the API.
const MAX_COMPILE_COMMANDS_CONTENT_BYTES = 900 * 1024

export function readCompileCommandsContent(compileCommandsPath) {
  if (!compileCommandsPath) {
    return undefined
  }
  let content
  try {
    content = readFileSync(compileCommandsPath, 'utf8')
  } catch (err) {
    logWarning(`compile-commands-path was set to "${compileCommandsPath}" but the file could not be read (${err.message}) -- proceeding without build context.`)
    return undefined
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_COMPILE_COMMANDS_CONTENT_BYTES) {
    logWarning(`compile-commands-path "${compileCommandsPath}" is larger than ${MAX_COMPILE_COMMANDS_CONTENT_BYTES} bytes -- proceeding without build context.`)
    return undefined
  }
  return content
}

export async function run() {
  const apiToken = getInput('api-token', { required: true })
  const apiBaseUrl = getInput('api-base-url', { required: true })
  const format = getInput('format') || 'hugo_markdown'
  const strict = getBooleanInput('strict')
  const language = getInput('language') || 'python'
  const parserBackend = getInput('parser-backend')
  const compileCommandsPath = getInput('compile-commands-path')
  const compileCommandsContent = readCompileCommandsContent(compileCommandsPath)
  const vcxprojPath = getInput('vcxproj-path')
  const vcxprojConfiguration = getInput('vcxproj-configuration')
  const vcxprojPlatform = getInput('vcxproj-platform')
  const bazelBuildPath = getInput('bazel-build-path')
  const bazelTargetName = getInput('bazel-target-name')
  const cmakeListsPath = getInput('cmake-lists-path')
  const pollIntervalSeconds = Number(getInput('poll-interval-seconds') || '10')
  const maxWaitSeconds = Number(getInput('max-wait-seconds') || '900')

  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Invalid 'format' input: "${format}" (expected 'hugo_markdown' or 'html').`)
  }

  if (parserBackend) {
    if (!VALID_PARSER_BACKENDS.has(parserBackend)) {
      throw new Error(`Invalid 'parser-backend' input: "${parserBackend}" (expected 'doxygen' or 'syntactic').`)
    }
    if (parserBackend === 'syntactic') {
      if (language !== 'cpp') {
        throw new Error(`The 'syntactic' parser backend is only supported for C++ (language: cpp), got "${language}".`)
      }
      if (vcxprojPath || vcxprojConfiguration || vcxprojPlatform || bazelBuildPath || bazelTargetName || cmakeListsPath) {
        throw new Error(`The 'syntactic' parser backend cannot be combined with vcxproj, bazel, or cmake build-context inputs.`)
      }
    }
  }

  const { repositoryUrl, commitSha } = readRepositoryContext()

  logNotice(`Submitting ${repositoryUrl}@${commitSha} to the Flude control-plane (format=${format}, strict=${strict}).`)

  const jobId = await submitJob(apiBaseUrl, apiToken, {
    repositoryUrl,
    commitSha,
    platform: 'github',
    language,
    compileCommandsPath,
    compileCommandsContent,
    vcxprojPath,
    vcxprojConfiguration,
    vcxprojPlatform,
    bazelBuildPath,
    bazelTargetName,
    cmakeListsPath,
    parserBackend,
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
  if (finalStatus.parser_backend) {
    setOutput('parser-backend', finalStatus.parser_backend)
  }

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

// Run only when this file is the process entry point, so tests can import it
// without triggering a real run even when they themselves execute inside GitHub Actions.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (process.env.GITHUB_ACTIONS === 'true' && isEntryPoint()) {
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

