// Builds a SARIF 2.1.0 document matching the real shape produced by
// engine/ude/reporting.py::to_sarif() (per the task's own quoted source),
// including its two independently-optional fields: `file` and `line`.

export function buildSarifDocument(results) {
  return JSON.stringify({
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            rules: results.map((result) => ({ id: result.ruleId, shortDescription: { text: result.ruleId } })),
          },
        },
        results: results.map((result) => {
          const sarifResult = {
            ruleId: result.ruleId,
            level: result.level,
            message: { text: result.message },
          }
          if (result.file) {
            sarifResult.locations = [
              {
                physicalLocation: {
                  artifactLocation: { uri: result.file },
                  ...(result.line != null ? { region: { startLine: result.line } } : {}),
                },
              },
            ]
          }
          return sarifResult
        }),
      },
    ],
  })
}
