import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSarifDocument } from '../test-support/sarif-fixture.js'
import { parseSarifFindings, formatErrorAnnotation, renderStepSummary } from '../src/sarif-report.js'

test('parseSarifFindings handles all three location edge cases', () => {
  const sarif = buildSarifDocument([
    { ruleId: 'has-both', level: 'error', message: 'file and line', file: 'src/a.py', line: 42 },
    { ruleId: 'file-only', level: 'warning', message: 'file, no line', file: 'src/b.py', line: null },
    { ruleId: 'no-location', level: 'note', message: 'no location at all', file: null, line: null },
  ])

  const findings = parseSarifFindings(sarif)
  assert.equal(findings.length, 3)
  assert.deepEqual(findings[0], { ruleId: 'has-both', level: 'error', message: 'file and line', file: 'src/a.py', line: 42 })
  assert.deepEqual(findings[1], { ruleId: 'file-only', level: 'warning', message: 'file, no line', file: 'src/b.py', line: null })
  assert.deepEqual(findings[2], { ruleId: 'no-location', level: 'note', message: 'no location at all', file: null, line: null })
})

test('formatErrorAnnotation includes file and line when both are present', () => {
  const annotation = formatErrorAnnotation({ ruleId: 'RULE1', level: 'error', message: 'boom', file: 'src/a.py', line: 42 })
  assert.equal(annotation, '::error file=src/a.py,line=42::[RULE1] boom')
})

test('formatErrorAnnotation omits line when only file is present', () => {
  const annotation = formatErrorAnnotation({ ruleId: 'RULE1', level: 'error', message: 'boom', file: 'src/a.py', line: null })
  assert.equal(annotation, '::error file=src/a.py::[RULE1] boom')
})

test('formatErrorAnnotation omits location entirely when neither is present', () => {
  const annotation = formatErrorAnnotation({ ruleId: null, level: 'error', message: 'boom', file: null, line: null })
  assert.equal(annotation, '::error::boom')
})

test('renderStepSummary lists every finding, uncapped', () => {
  const findings = Array.from({ length: 15 }, (_, i) => ({
    ruleId: `RULE-${i}`,
    level: 'warning',
    message: `finding number ${i}`,
    file: `src/file${i}.py`,
    line: i + 1,
  }))

  const summary = renderStepSummary(findings)
  assert.match(summary, /15 finding\(s\)/)
  for (const finding of findings) {
    assert.ok(summary.includes(finding.message), `expected summary to include "${finding.message}"`)
  }
  // The old application-level cap was 10 - explicitly prove finding #14 (past it) is present.
  assert.ok(summary.includes('finding number 14'))
})

test('renderStepSummary handles the empty case', () => {
  assert.match(renderStepSummary([]), /No findings\./)
})
