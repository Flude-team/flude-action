// Standalone launcher for the mock control-plane, used by the e2e workflow
// (.github/workflows/e2e-mock.yml) which runs this action for real via `uses: ./`.
// Lives outside test/ deliberately - Node's test runner treats every file
// under a directory named test/tests as a test file, and this one calls
// server.listen() and never resolves, which would hang `node --test`.
import { createMockControlPlane } from './mock-server.js'
import { buildZip } from './zip-builder.js'
import { buildSarifDocument } from './sarif-fixture.js'
import { buildCodequalityDocument } from './codequality-fixture.js'

const port = Number(process.env.MOCK_PORT || 8787)
const scenario = process.env.MOCK_SCENARIO || 'default'

let resultBody
if (scenario === 'with-sarif') {
  // 15 findings, deliberately more than the old (removed) 10-item display
  // cap, mixing levels and the three location edge cases (file+line, file
  // only, neither) - see DEL-B25.
  const findings = Array.from({ length: 15 }, (_, i) => ({
    ruleId: `RULE-${i}`,
    level: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'note',
    message: `finding number ${i}`,
    file: i % 4 === 0 ? null : `src/file${i}.py`,
    line: i % 4 === 0 || i % 4 === 1 ? null : i + 1,
  }))
  resultBody = buildZip([{ name: 'report.sarif', content: buildSarifDocument(findings), method: 'deflate' }])
} else if (scenario === 'with-codequality') {
  // All findings carry a file+line (to_codeclimate() drops anything without
  // both - see DEL-B26 / gitlab/src/gitlab-reporting.js). Count is
  // configurable (default 5) so a GitLab MR-widget test can give the head
  // branch a different finding count than the base branch's own baseline
  // pipeline - the widget diffs base vs head reports, so identical counts
  // with identical fingerprints always render as "hasn't changed".
  const count = Number(process.env.MOCK_FINDINGS_COUNT || 5)
  const findings = Array.from({ length: count }, (_, i) => ({
    ruleId: `RULE-${i}`,
    entityName: `Widget::method${i}`,
    level: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'note',
    message: `finding number ${i}`,
    file: `src/file${i}.py`,
    line: i + 1,
  }))
  resultBody = buildZip([
    { name: 'codequality.json', content: buildCodequalityDocument(findings), method: 'deflate' },
  ])
}

const server = createMockControlPlane({ token: process.env.MOCK_TOKEN || 'test-token', ...(resultBody ? { resultBody } : {}) })
server.listen(port, '127.0.0.1', () => {
  console.log(`Mock control-plane (scenario: ${scenario}) listening on http://127.0.0.1:${port}`)
})
