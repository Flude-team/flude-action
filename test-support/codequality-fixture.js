import { createHash } from 'node:crypto'

// Builds a GitLab Code Quality (CodeClimate-flavored) JSON array matching the
// real shape produced by engine/ude/reporting.py::to_codeclimate() (per the
// task's own quoted source): fingerprint = md5(`${ruleId}:${entityName}`),
// severity mapped from SARIF's error/warning/note vocabulary, and
// location.lines.begin as an integer. That function silently drops any
// finding missing file or line, so callers of this fixture must supply both
// - there is no way to represent the "no location" case here, on purpose.

const SEVERITY_MAPPING = { error: 'major', warning: 'minor', note: 'info' }

export function buildCodequalityDocument(findings) {
  return JSON.stringify(
    findings.map((finding) => ({
      description: finding.message,
      check_name: finding.ruleId,
      fingerprint: createHash('md5').update(`${finding.ruleId}:${finding.entityName}`).digest('hex'),
      severity: SEVERITY_MAPPING[finding.level] || 'minor',
      location: { path: finding.file, lines: { begin: finding.line } },
    }))
  )
}
