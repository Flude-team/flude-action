// Reads the real SARIF 2.1.0 shape produced by engine/ude/reporting.py::to_sarif()
// (verified directly against that code, not guessed): one or more `runs`, each
// with `results[]` carrying `ruleId`, `level`, `message.text`, and an optional
// `locations[0].physicalLocation` (present only if the finding has a
// file/line - both fields are independently optional per that source).
//
// ASSUMPTION (not yet confirmed - DEL-B23 doesn't exist): the downloaded
// result archive contains this SARIF document as a top-level "report.sarif"
// entry. See README.md and extractSarifFromArchive() below.

export const SARIF_ENTRY_NAME = 'report.sarif'

export function parseSarifFindings(sarifText) {
  const document = JSON.parse(sarifText)
  const findings = []
  for (const run of document.runs || []) {
    for (const result of run.results || []) {
      const physicalLocation = result.locations?.[0]?.physicalLocation
      findings.push({
        ruleId: result.ruleId ?? null,
        level: result.level ?? 'warning',
        message: result.message?.text ?? '',
        file: physicalLocation?.artifactLocation?.uri ?? null,
        line: physicalLocation?.region?.startLine ?? null,
      })
    }
  }
  return findings
}

// GitHub workflow command syntax: `::error file=<path>,line=<n>::<message>`.
// Per the task scope, only `level: error` findings get an inline annotation -
// `warning`/`note` findings are still fully visible via the SARIF upload
// (Code Scanning) and the step summary table below, so nothing is lost.
export function formatErrorAnnotation(finding) {
  const properties = []
  if (finding.file) properties.push(`file=${finding.file}`)
  if (finding.line != null) properties.push(`line=${finding.line}`)
  const propertyString = properties.length > 0 ? ` ${properties.join(',')}` : ''
  const rulePrefix = finding.ruleId ? `[${finding.ruleId}] ` : ''
  return `::error${propertyString}::${rulePrefix}${finding.message}`
}

function escapeTableCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

// Renders every finding, deliberately uncapped - an earlier design that
// truncated this to 10 was removed on purpose (see DEL-B25's acceptance
// criterion), specifically so the step summary is the one channel guaranteed
// to show the complete list regardless of how GitHub's own UI renders
// annotations.
export function renderStepSummary(findings) {
  const lines = ['## Flude findings', '']
  if (findings.length === 0) {
    lines.push('No findings.')
    return lines.join('\n')
  }

  lines.push(`${findings.length} finding(s):`, '')
  lines.push('| Level | Rule | Location | Message |', '| --- | --- | --- | --- |')
  for (const finding of findings) {
    const location = finding.file ? `${finding.file}${finding.line != null ? `:${finding.line}` : ''}` : '—'
    lines.push(
      `| ${escapeTableCell(finding.level)} | ${escapeTableCell(finding.ruleId ?? '—')} | ` +
        `${escapeTableCell(location)} | ${escapeTableCell(finding.message)} |`
    )
  }
  return lines.join('\n')
}
