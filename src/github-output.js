import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// Writes to $GITHUB_OUTPUT using the heredoc form so values containing
// special characters (e.g. "=" in signed URLs) can't corrupt the file.
export function setOutput(name, value) {
  const filePath = process.env.GITHUB_OUTPUT
  const delimiter = `flude_${randomUUID()}`
  const line = `${name}<<${delimiter}\n${value}\n${delimiter}\n`
  if (filePath) {
    appendFileSync(filePath, line)
  } else {
    // Not running inside a real GitHub Actions job (e.g. a local script run).
    console.log(`[output] ${name}=${value}`)
  }
}

export function logNotice(message) {
  console.log(`::notice::${message}`)
}

export function logWarning(message) {
  console.warn(`::warning::${message}`)
}

export function logError(message) {
  console.error(`::error::${message}`)
}
