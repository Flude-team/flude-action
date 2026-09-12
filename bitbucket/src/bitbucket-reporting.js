import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extractZipEntry } from '../../src/zip-extract.js'
import { parseSarifFindings, SARIF_ENTRY_NAME } from '../../src/sarif-report.js'
import { putReport, postAnnotations } from './bitbucket-insights-client.js'

// Best-effort Bitbucket-specific reporting on top of an already-downloaded
// result archive (DEL-B39). Never throws - a missing/unreadable/malformed
// report.sarif degrades to a console warning, not a failed step, matching
// the same philosophy as gitlab/src/gitlab-reporting.js and
// src/github-reporting.js.
//
// UNLIKE DEL-B26 (GitLab), this does NOT assume a second, Bitbucket-specific
// archive entry (e.g. a hypothetical "bitbucket-insights.json"). There is no
// engine/ude/reporting.py::to_bitbucket() - only to_sarif() and
// to_codeclimate() exist - so inventing a third independent, wholly
// unconfirmed archive-layout guess would add risk for no benefit. Instead
// this reuses report.sarif (the one archive-layout assumption GitHub's
// DEL-B25 already made and that this repo already parses via
// ../../src/sarif-report.js::parseSarifFindings, itself already
// platform-neutral) and converts SARIF's findings into Bitbucket's Code
// Insights shape in JS. If DEL-B23 ever ships a native Bitbucket format,
// switch this file to read it directly - don't keep converting from SARIF
// out of inertia.
export const REPORT_ID = 'flude-docs-quality'

// SARIF's level vocabulary (error/warning/note) mapped to Bitbucket's
// annotation severity enum (HIGH/MEDIUM/LOW/CRITICAL - CRITICAL unused here,
// same three-way mapping shape as GitLab's severity_mapping in
// engine/ude/reporting.py::to_codeclimate()).
const SEVERITY_MAPPING = { error: 'HIGH', warning: 'MEDIUM', note: 'LOW' }

// Bitbucket's annotation_type enum is only {VULNERABILITY, CODE_SMELL, BUG} -
// none of which is "documentation issue". CODE_SMELL is the closest fit for
// a general quality/style finding (as opposed to a security VULNERABILITY or
// a confirmed functional BUG) - a reasoned choice within a fixed enum, not a
// fabricated value.
const ANNOTATION_TYPE = 'CODE_SMELL'

// report_type has the same problem - the enum is only
// {BUG, SECURITY, COVERAGE, TEST} (confirmed against Atlassian's docs, no
// "DOCUMENTATION"/"LINT" option exists). BUG is the closest generic fit,
// same reasoning as ANNOTATION_TYPE above.
const REPORT_TYPE = 'BUG'

function toAnnotation(finding) {
  // external_id must be unique per annotation and is recommended to be
  // stable/deterministic (Atlassian's own example prefixes it with the
  // reporting system's name) - hashing the finding's own identity fields
  // means re-posting the same finding on a later run produces the same id,
  // updating it in place rather than duplicating it.
  const externalId = createHash('md5')
    .update(`${REPORT_ID}:${finding.ruleId}:${finding.file}:${finding.line}:${finding.message}`)
    .digest('hex')
  return {
    external_id: `flude-${externalId}`,
    annotation_type: ANNOTATION_TYPE,
    summary: finding.ruleId ? `[${finding.ruleId}] ${finding.message}` : finding.message,
    severity: SEVERITY_MAPPING[finding.level] || 'LOW',
    path: finding.file.replace(/^\/+/, ''),
    line: finding.line,
  }
}

export async function reportBitbucketFindings(archivePath, { baseUrl, workspace, repoSlug, commit }) {
  let archiveBuffer
  try {
    archiveBuffer = await readFile(archivePath)
  } catch (error) {
    console.warn(`Could not read the downloaded result archive for Bitbucket reporting: ${error.message}`)
    return { reported: false, findings: [] }
  }

  let sarifBuffer
  try {
    sarifBuffer = extractZipEntry(archiveBuffer, SARIF_ENTRY_NAME)
  } catch (error) {
    console.warn(
      `Could not find/extract "${SARIF_ENTRY_NAME}" from the result archive - skipping Bitbucket Code Insights ` +
        `reporting. The archive layout is a best-effort assumption (DEL-B25) pending the real control-plane ` +
        `(DEL-B23): ${error.message}`
    )
    return { reported: false, findings: [] }
  }

  let findings
  try {
    findings = parseSarifFindings(sarifBuffer.toString('utf8'))
  } catch (error) {
    console.warn(`"${SARIF_ENTRY_NAME}" was found but could not be parsed as SARIF: ${error.message}`)
    return { reported: false, findings: [] }
  }

  const errorCount = findings.filter((finding) => finding.level === 'error').length
  const report = {
    title: 'Flude documentation quality',
    details: `${findings.length} finding(s), ${errorCount} at level "error".`,
    report_type: REPORT_TYPE,
    reporter: 'Flude',
    // A quality gate independent of the underlying job's own exit code -
    // the documentation job can succeed (docs were generated) while this
    // report still reports FAILED, same non-fatal-reporting philosophy as
    // the GitHub/GitLab sides.
    result: errorCount > 0 ? 'FAILED' : 'PASSED',
    data: [
      { title: 'Findings', type: 'NUMBER', value: findings.length },
      { title: 'Errors', type: 'NUMBER', value: errorCount },
    ],
  }

  await putReport(baseUrl, workspace, repoSlug, commit, REPORT_ID, report)

  // Only findings with both a file and a line can be attached to a diff
  // position - same location-completeness rule GitLab's to_codeclimate()
  // applies, kept here for consistency even though Bitbucket's own schema
  // doesn't document what happens with a partial location.
  const annotatable = findings.filter((finding) => finding.file != null && finding.line != null)
  if (annotatable.length > 0) {
    await postAnnotations(baseUrl, workspace, repoSlug, commit, REPORT_ID, annotatable.map(toAnnotation))
  }

  console.log(
    `${findings.length} finding(s) reported to Bitbucket Code Insights (${annotatable.length} with an ` +
      `attached annotation; report "${REPORT_ID}").`
  )
  return { reported: true, findings }
}
