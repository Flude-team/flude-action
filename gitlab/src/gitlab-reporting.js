import { readFile, writeFile } from 'node:fs/promises'
import { extractZipEntry } from '../../src/zip-extract.js'

// Best-effort GitLab-specific reporting on top of an already-downloaded
// result archive (DEL-B26). Never throws - a missing/unreadable/malformed
// codequality.json degrades to a console warning, not a failed job, since
// the underlying documentation job already succeeded regardless of whether
// this repo's archive-layout assumption turns out to be right. Mirrors
// ../../src/github-reporting.js's degrade-gracefully philosophy exactly.
//
// ASSUMPTION (not yet confirmed - DEL-B23 doesn't exist): the downloaded
// result archive contains a top-level "codequality.json" entry holding the
// real GitLab Code Quality (CodeClimate-flavored) JSON produced by
// engine/ude/reporting.py::to_codeclimate(). That function and to_sarif()
// (the archive-layout assumption ../../src/sarif-report.js already made for
// report.sarif) both serialize the same underlying Finding list, but this is
// a second, independent naming assumption - a control-plane that ships one
// entry is not guaranteed to ship the other.
export const CODEQUALITY_ENTRY_NAME = 'codequality.json'

export async function reportGitLabFindings(
  archivePath,
  { codequalityOutputPath = 'gl-code-quality-report.json' } = {}
) {
  let archiveBuffer
  try {
    archiveBuffer = await readFile(archivePath)
  } catch (error) {
    console.warn(`Could not read the downloaded result archive for GitLab reporting: ${error.message}`)
    return { codequalityPath: null, findings: [] }
  }

  let entryBuffer
  try {
    entryBuffer = extractZipEntry(archiveBuffer, CODEQUALITY_ENTRY_NAME)
  } catch (error) {
    console.warn(
      `Could not find/extract "${CODEQUALITY_ENTRY_NAME}" from the result archive - skipping the GitLab Code ` +
        'Quality report. The archive layout is a best-effort assumption (DEL-B26) pending the real ' +
        `control-plane (DEL-B23): ${error.message}`
    )
    return { codequalityPath: null, findings: [] }
  }

  let findings
  try {
    findings = JSON.parse(entryBuffer.toString('utf8'))
    if (!Array.isArray(findings)) {
      throw new Error('expected a top-level JSON array, per the GitLab Code Quality report format')
    }
  } catch (error) {
    console.warn(
      `"${CODEQUALITY_ENTRY_NAME}" was found but could not be parsed as a Code Quality report: ${error.message}`
    )
    return { codequalityPath: null, findings: [] }
  }

  // Re-serialize rather than writing entryBuffer verbatim: validates the
  // parse round-trips (a truncated/corrupt entry that still parses as valid
  // but partial JSON would otherwise be written through unexamined) and
  // guarantees the file GitLab reads has no surrounding whitespace quirks.
  await writeFile(codequalityOutputPath, JSON.stringify(findings))
  console.log(`${findings.length} finding(s) written to ${codequalityOutputPath}.`)

  return { codequalityPath: codequalityOutputPath, findings }
}
