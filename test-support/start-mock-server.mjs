// Standalone launcher for the mock control-plane, used by the e2e workflow
// (.github/workflows/e2e-mock.yml) which runs this action for real via `uses: ./`.
// Lives outside test/ deliberately - Node's test runner treats every file
// under a directory named test/tests as a test file, and this one calls
// server.listen() and never resolves, which would hang `node --test`.
import { createMockControlPlane } from './mock-server.js'

const port = Number(process.env.MOCK_PORT || 8787)
const server = createMockControlPlane({ token: process.env.MOCK_TOKEN || 'test-token' })
server.listen(port, '127.0.0.1', () => {
  console.log(`Mock control-plane listening on http://127.0.0.1:${port}`)
})
