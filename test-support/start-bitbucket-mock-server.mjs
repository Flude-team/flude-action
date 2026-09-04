// Standalone launcher for the mock Bitbucket Code Insights API, mirroring
// start-mock-server.mjs's reason for living outside test/ (it calls
// server.listen() and never resolves, which would hang `node --test` if
// Node's test runner ever saw this file under a directory literally named
// test/tests).
import { createMockBitbucketApi } from './bitbucket-mock-server.js'

const port = Number(process.env.MOCK_BITBUCKET_PORT || 8789)
const { server, requests } = createMockBitbucketApi()

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock Bitbucket Code Insights API listening on http://127.0.0.1:${port}`)
})

// Dump every received request to stdout on SIGTERM/SIGINT so a local
// rehearsal (run by hand, killed by hand) can see exactly what was sent
// without needing its own separate inspection script.
function dumpAndExit() {
  console.log(JSON.stringify(requests, null, 2))
  process.exit(0)
}
process.on('SIGTERM', dumpAndExit)
process.on('SIGINT', dumpAndExit)
