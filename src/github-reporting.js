import { readFile, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { extractZipEntry } from './zip-extract.js'
import { parseSarifFindings, formatErrorAnnotation, renderStepSummary, SARIF_ENTRY_NAME } from './sarif-report.js'
import { logWarning, logNotice } from './github-output.js'

// Best-effort GitHub-specific reporting on top of an already-downloaded
// result archive (DEL-B25). Never throws - a missing/unreadable/malformed
// report.sarif degrades to a warning, not a failed step, since the
// underlying documentation job already succeeded regardless of whether this
// repo's archive-layout assumption turns out to be right.
export async function reportGitHubFindings(archivePath, { sarifOutputPath = 'flude-report.sarif' } = {}) {
  let archiveBuffer
  try {
    archiveBuffer = await readFile(archivePath)
  } catch (error) {
    logWarning(`Could not read the downloaded result archive for GitHub reporting: ${error.message}`)
    return { sarifPath: null, findings: [] }
  }

  let sarifBuffer
  try {
    sarifBuffer = extractZipEntry(archiveBuffer, SARIF_ENTRY_NAME)
  } catch (error) {
    logWarning(
      `Could not find/extract "${SARIF_ENTRY_NAME}" from the result archive - skipping GitHub-specific ` +
        'reporting (annotations, Code Scanning upload, step summary). The archive layout is a best-effort ' +
        `assumption (DEL-B25) pending the real control-plane (DEL-B23): ${error.message}`
    )
    return { sarifPath: null, findings: [] }
  }

  await writeFile(sarifOutputPath, sarifBuffer)

  let findings
  try {
    findings = parseSarifFindings(sarifBuffer.toString('utf8'))
  } catch (error) {
    logWarning(`"${SARIF_ENTRY_NAME}" was found but could not be parsed as SARIF: ${error.message}`)
    return { sarifPath: sarifOutputPath, findings: [] }
  }

  const errorFindings = findings.filter((finding) => finding.level === 'error')
  for (const finding of errorFindings) {
    console.log(formatErrorAnnotation(finding))
  }
  logNotice(`${findings.length} finding(s) in ${SARIF_ENTRY_NAME} (${errorFindings.length} at level "error").`)

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  const summary = renderStepSummary(findings)
  if (summaryPath) {
    appendFileSync(summaryPath, `${summary}\n`)
  } else {
    console.log(summary)
  }

  return { sarifPath: sarifOutputPath, findings }
}
