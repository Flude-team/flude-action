import { getJobStatus } from './control-plane-client.js'
import { logNotice, logWarning } from './github-output.js'

// Free-gate rejections are terminal job statuses, not a separate client-side
// check - the action never queries the platform's tree-listing API itself.
// The control-plane owns the allowlist/quota/free-gate decision (DEL-B23);
// this action only needs to explain a rejection in human terms.
const REJECTION_MESSAGES = {
  rejected_too_large:
    'Filtered source volume exceeds the Stage 1 free-tier threshold (5 MB). ' +
    'This is a paid scenario, not yet available in Stage 1.',
  rejected_organization:
    'The repository belongs to an organization, not a personal account. ' +
    'Stage 1 free access is limited to personal accounts.',
  rejected_private:
    'The repository is private. Stage 1 free access only covers public repositories.',
}

export function describeTerminalStatus(status) {
  return REJECTION_MESSAGES[status] || null
}

export async function pollUntilTerminal(
  baseUrl,
  token,
  jobId,
  { intervalMs, maxWaitMs, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
) {
  const startedAt = Date.now()
  let consecutiveTransientFailures = 0

  for (;;) {
    let jobStatus
    try {
      jobStatus = await getJobStatus(baseUrl, token, jobId)
      consecutiveTransientFailures = 0
    } catch (error) {
      consecutiveTransientFailures += 1
      if (consecutiveTransientFailures > 5) {
        throw error
      }
      logWarning(`Transient error polling job status (attempt ${consecutiveTransientFailures}/5): ${error.message}`)
      await sleep(intervalMs)
      continue
    }

    if (jobStatus.status === 'queued' || jobStatus.status === 'running') {
      logNotice(`Job ${jobId}: ${jobStatus.status}...`)
    } else {
      return jobStatus
    }

    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(
        `Timed out after ${Math.round(maxWaitMs / 1000)}s waiting for job ${jobId} to reach a terminal status. ` +
          'This is only a client-side safety net, not the authoritative server-side timeout (currently 10 ' +
          'minutes) - check the control-plane directly if this keeps happening.'
      )
    }

    await sleep(intervalMs)
  }
}
